const socket = io();
const $ = (id) => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle('hidden', !on);

// Builds an element. All text goes in as text nodes, never as HTML.
//   h('button', { class: 'pick', data: { team: 1 }, vars: { '--c': '#f00' }, disabled: true }, 'Label')
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'data') for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = dv;
    else if (k === 'vars') for (const [name, val] of Object.entries(v)) el.style.setProperty(name, val);
    else if (k === 'color') el.style.color = v;
    else if (k === 'disabled' || k === 'selected') el[k] = true;
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter((x) => x != null && x !== false).map((x) => (typeof x === 'number' ? String(x) : x)));
  return el;
}
const fill = (id, ...kids) => $(id).replaceChildren(...kids.flat(Infinity).filter((x) => x != null && x !== false));
// A game action. It carries the state version, so the same tap from the TV and a remote counts once.
const act = (ev, data) => socket.emit(ev, data, state?.version);
const emit = (ev, data) => () => act(ev, data);

function load(k) { try { return localStorage.getItem(k); } catch { return null; } }
function save(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }

let code = load('fbHostCode');
let secret = load('fbHostSecret'); // proves to the server that this laptop is the host
let qr = null;
let state = null;
let sparkleEndsAt = null; // local clock time when the timer runs out (only while running)
let nhEndsAt = null; // No host: local clock time of the server's next step (for the countdowns)
let prev = null; // what the last render showed, so effects only fire on changes
let lastSecs = null;
let lastScreen = null; // so a new screen scrolls to the top (and not on every update)
const seen = new Set(); // players already shown, so only new ones pop in

// One-line explainers show the first time a Double, a bonus and a Sparkle Round come up in a game.
// Remembered per game: { code, double: <when>, bonus: <when>, sparkle: <when> }.
let explained = (() => { try { return JSON.parse(load('fbExplained') || '{}'); } catch { return {}; } })();
function firstTime(kind, when) {
  if (explained.code !== state.code) explained = { code: state.code };
  if (explained[kind] == null) { explained[kind] = when; save('fbExplained', JSON.stringify(explained)); }
  return explained[kind] === when; // still the first one: keep showing it until it's over
}

const MODES = {
  draw: { label: '🎨 Draw', doing: 'is drawing…' },
  charades: { label: '🤐 Dumb Charades', doing: 'is acting it out…' },
  mimic: { label: '🎭 Mimic', doing: '' },
};

const LEVELS = {
  easy: { label: '🌶️ Easy', points: 50 },
  medium: { label: '🌶️🌶️ Medium', points: 100 },
  tricky: { label: '🌶️🌶️🌶️ Tricky', points: 200 },
};
// Cards left for a mode (Draw adds up its three piles) or for one Draw pile.
const cardsLeft = (mode, level) => mode === 'draw'
  ? (level ? state.deckLeft[`draw:${level}`] : Object.keys(LEVELS).reduce((n, l) => n + state.deckLeft[`draw:${l}`], 0))
  : state.deckLeft[mode];

function gotRoom(res) {
  if (res.needPin) {
    show('pinBox', true);
    $('pinError').textContent = res.error || '';
    $('pin').focus();
    return;
  }
  if (!res.ok) {
    if (res.error) alert(res.error);
    if (state) return; // keep the current game going
    code = secret = null; save('fbHostCode', null); save('fbHostSecret', null); render(); return;
  }
  show('pinBox', false);
  setupOpen = false;
  code = res.code;
  secret = res.secret;
  qr = res.qr;
  save('fbHostCode', code);
  save('fbHostSecret', secret);
}

// ---- Setup screen: theme cards, Start, and the optional Customise options ----
let setupOpen = false;
let packs = []; // theme summaries from the server (names and categories only)
const SETUP_DEFAULTS = { host: 'host', packId: 'world', boards: 'both', sparkleEvery: 6, modes: { draw: true, charades: true, mimic: true }, bonuses: true, double: true, cats: {} };
let setup = (() => {
  try { return { ...SETUP_DEFAULTS, ...JSON.parse(load('fbSetup') || '{}') }; } catch { return { ...SETUP_DEFAULTS }; }
})();
const saveSetup = () => save('fbSetup', JSON.stringify(setup));
const isCommunityId = (id) => typeof id === 'string' && id.startsWith('c:');
const packOf = (id) => (id === 'custom' ? customSummary()
  : isCommunityId(id) ? (communityPick?.id === id ? communityPick : null)
  : packs.find((p) => p.id === id && !p.missing));

// ---- Setup tabs: ⭐ Featured · 🌐 Community (once a board is approved) · ✨ Make your own ----
let setupTab = 'featured';
const tabOf = (id) => (id === 'custom' ? 'make' : isCommunityId(id) ? 'community' : 'featured');
let communityPick = null; // the chosen community board's summary (names and categories only)
// 🌐 Community. Three views: home (🎲, a tile per tag, ✨ New this week), one tag's boards, and search results.
// Kids only filters all of them to kid-friendly boards.
const comm = { total: 0, tags: [], newBoards: [], tag: null, q: '', kid: false, boards: [], more: false, page: 0, loading: false, homeLoading: false, error: null, msg: '' };
const commView = () => (comm.q.trim() ? 'search' : comm.tag ? 'tag' : 'home');
const kidQuery = () => (comm.kid ? 'kid=1' : '');

async function getJson(url) {
  let res;
  try { res = await fetch(url); } catch { throw new Error('Couldn\'t reach the server.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.error || 'Something went wrong.'); err.status = res.status; throw err; }
  return data;
}

// Tag tiles (with counts) and whether the Community tab shows at all (it needs at least 1 approved board).
async function loadCommunityTags() {
  try { const d = await getJson('/api/community/tags?' + kidQuery()); comm.total = d.total; comm.tags = d.tags; }
  catch { comm.total = 0; comm.tags = []; }
  if (!comm.total && setupTab === 'community') switchTab('featured');
}

let homeSeq = 0; // only the latest load is shown
async function loadCommunityHome() {
  const seq = ++homeSeq;
  comm.homeLoading = true; comm.error = null;
  renderCommunity();
  try {
    const [, fresh] = await Promise.all([loadCommunityTags(), getJson('/api/community/new?' + kidQuery())]);
    if (seq === homeSeq) comm.newBoards = fresh.boards;
  } catch (err) { if (seq === homeSeq) { comm.newBoards = []; comm.error = err.message; } }
  if (seq === homeSeq) { comm.homeLoading = false; renderCommunity(); }
}

let commSeq = 0; // only the latest search's results are shown
async function loadCommunity(more = false) {
  const seq = ++commSeq;
  const page = more ? comm.page + 1 : 0;
  const q = new URLSearchParams({ page });
  if (commView() === 'search') q.set('q', comm.q.trim()); // search looks at every tag
  else if (comm.tag) q.set('tag', comm.tag);
  if (comm.kid) q.set('kid', '1');
  comm.loading = true; comm.error = null; comm.msg = '';
  if (!more) comm.boards = [];
  renderCommunity();
  try {
    const d = await getJson('/api/community/boards?' + q);
    if (seq !== commSeq) return;
    comm.boards = more ? [...comm.boards, ...d.boards] : d.boards;
    comm.more = d.more; comm.page = d.page;
  } catch (err) { if (seq === commSeq) comm.error = err.message; }
  if (seq === commSeq) { comm.loading = false; renderCommunity(); }
}
const refreshCommunity = () => (commView() === 'home' ? loadCommunityHome() : loadCommunity());

// Opens a community board's summary + Customise in the side panel.
async function pickCommunity(id) {
  try {
    communityPick = await getJson('/api/community/boards/' + encodeURIComponent(id));
  } catch (err) {
    comm.msg = err.status === 404 ? 'That board isn\'t available any more.' : err.message;
    return renderSetup();
  }
  setup.packId = communityPick.id;
  saveSetup();
  renderSetup();
  $('detailClose').focus();
}
// 🎲 a random approved board: in one tag, or any (null). Respects Kids only.
async function surprise(tag) {
  const q = new URLSearchParams();
  if (tag) q.set('tag', tag);
  if (comm.kid) q.set('kid', '1');
  try { await pickCommunity((await getJson('/api/community/random?' + q)).id); }
  catch (err) { comm.msg = err.status === 404 ? (comm.kid ? 'No kid-friendly boards there yet.' : 'No boards there yet.') : err.message; renderCommunity(); }
}
function closeDetail() {
  if (!setupOpen || setupTab !== 'community' || !isCommunityId(setup.packId)) return;
  const id = setup.packId.slice(2);
  setup.packId = null;
  saveSetup();
  renderSetup();
  document.querySelector(`#community [data-id="${CSS.escape(id)}"]`)?.focus();
}

function switchTab(tab) {
  setupTab = tab;
  if (tab === 'featured') setup.packId = packOf(setup.lastFeatured) ? setup.lastFeatured : packs.find((p) => !p.missing)?.id || 'world';
  else if (tab === 'make') setup.packId = 'custom';
  else { setup.packId = null; refreshCommunity(); } // details open when a board is picked
  saveSetup();
  renderSetup();
}

const pill = (cls, text) => h('span', { class: `pill ${cls}` }, text);
const tagLine = (tags) => tags.map((t) => `${t.emoji} ${t.name}`.trim()).join(' · ');
// A board: a card (✨ New this week) or a compact row (a tag's boards, search results).
function commCard(b, compact = false) {
  const meta = [b.madeBy ? `Made by ${b.madeBy}` : null, b.playCount > 0 ? `Played ${b.playCount} time${b.playCount === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');
  return h('button', { class: `theme comm-card ${compact ? 'compact' : ''} ${setup.packId === 'c:' + b.id ? 'selected' : ''}`, type: 'button', data: { id: b.id } },
    h('div', { class: 'theme-emoji' }, b.emoji || '🎲'),
    h('div', { class: 'comm-info' },
      h('div', { class: 'theme-name' }, b.name, b.isNew || b.kidFriendly ? h('span', { class: 'pills' }, b.isNew ? pill('pill-new', 'New') : null, b.kidFriendly ? pill('pill-kids', 'Kids') : null) : null),
      b.tags.length ? h('div', { class: 'comm-tagline' }, tagLine(b.tags)) : null,
      meta ? h('div', { class: 'comm-meta' }, meta) : null));
}

function renderCommunity() {
  const view = commView();
  show('commHome', view === 'home');
  show('commListWrap', view !== 'home');
  let note = comm.error || comm.msg || null;

  if (view === 'home') {
    fill('commTiles', comm.tags.map((t) => h('div', { class: 'comm-tile' },
      h('div', { class: 'comm-tile-emoji' }, t.emoji || '🏷️'),
      h('div', { class: 'comm-tile-name' }, t.name),
      h('div', { class: 'comm-tile-count' }, `${t.boards} board${t.boards === 1 ? '' : 's'}`),
      h('div', { class: 'comm-tile-actions' },
        h('button', { class: 'secondary', type: 'button', data: { browse: t.slug } }, 'Browse'),
        h('button', { class: 'secondary', type: 'button', data: { random: t.slug }, 'aria-label': `Surprise me: a random ${t.name} board`, title: 'Surprise me' }, '🎲')))));
    fill('commNew', comm.newBoards.map((b) => commCard(b)));
    show('commNewWrap', comm.newBoards.length > 0);
    $('commSurprise').disabled = !comm.tags.length;
    if (!note && !comm.tags.length) note = comm.homeLoading ? 'Loading…' : comm.kid ? 'No kid-friendly boards yet.' : 'No boards yet.';
  } else {
    const t = comm.tags.find((x) => x.slug === comm.tag);
    $('commListTitle').textContent = view === 'search' ? `Boards matching “${comm.q.trim()}”` : `${t?.emoji || ''} ${t?.name || 'Boards'}`.trim();
    show('commBack', view === 'tag');
    fill('commCards', comm.boards.map((b) => commCard(b, true)));
    show('commMore', comm.more && !comm.loading);
    if (!note && !comm.boards.length) note = comm.loading ? 'Loading…' : view === 'search' ? 'No boards match. Try another word.' : 'No boards here yet.';
  }
  $('commNote').textContent = note || '';
  show('commNote', !!note);
}

// The host's category picks for one board of the chosen pack (default flags unless they changed them).
// Picks are saved by category name, so they survive categories being added to a pack later.
function catPicks(pack, bi) {
  const cats = pack.boards[bi].categories;
  const saved = setup.cats[pack.id]?.[bi];
  if (Array.isArray(saved)) {
    const idx = saved.map((name) => cats.findIndex((c) => c.name === name));
    if (idx.every((i) => i >= 0)) return idx.sort((x, y) => x - y);
  }
  return cats.map((c, i) => (c.default ? i : -1)).filter((i) => i >= 0);
}
const boardsInPlay = (pack) => (pack.boards.length < 2 ? [0] : setup.boards === '1' ? [0] : setup.boards === '2' ? [1] : [0, 1]);

function openSetup() {
  if (state && !confirm('Start a new game? This ends the current game.')) return;
  setupOpen = true;
  show('pinBox', false);
  setupTab = tabOf(setup.packId);
  socket.emit('host:packs', (list) => {
    packs = Array.isArray(list) ? list : [];
    if (setupTab === 'featured' && !packOf(setup.packId)) setup.packId = packs.find((p) => !p.missing)?.id || 'world';
    render();
  });
  loadCommunityTags().then(async () => {
    // Coming back to a community board picked last time: load its summary again (it may be gone).
    if (isCommunityId(setup.packId) && !communityPick) {
      try { communityPick = await getJson('/api/community/boards/' + encodeURIComponent(setup.packId.slice(2))); }
      catch { setup.packId = null; }
    }
    if (setupTab === 'community' && comm.total) refreshCommunity();
    render();
  });
  socket.emit('host:tags', (res) => {
    communityTags = Array.isArray(res?.tags) ? res.tags.filter((t) => typeof t === 'string') : [];
    render();
  });
  render();
}

function startNewGame() {
  const pack = packOf(setup.packId);
  if (!pack) return;
  const categories = pack.boards.map((_, bi) => catPicks(pack, bi));
  const which = pack.id === 'custom' ? { pack: custom.pack }
    : pack.community ? { communityId: pack.id.slice(2), categories }
    : { packId: pack.id, categories };
  socket.emit('host:new', {
    pin: $('pin').value, ...which, host: setup.host, boards: setup.boards, sparkleEvery: setup.sparkleEvery,
    modes: setup.modes, bonuses: setup.bonuses, double: setup.double,
    replaces: code && secret ? { code, secret } : undefined, // the server ends the previous game
  }, gotRoom);
}

// A row of toggle buttons; `options` is [[value, label], ...].
function seg(id, options, current, onPick) {
  fill(id, options.map(([value, label]) =>
    h('button', { class: `segbtn ${value === current ? 'on' : ''}`, type: 'button', onclick: null }, label)));
  [...$(id).children].forEach((b, i) => (b.onclick = () => { onPick(options[i][0]); saveSetup(); renderSetup(); }));
}

function renderSetup() {
  // Theme cards
  const cards = packs.map((p) => h('button', {
    class: `theme ${p.id === setup.packId ? 'selected' : ''} ${p.missing ? 'soon' : ''}`, disabled: !!p.missing, data: { pack: p.id },
  }, h('div', { class: 'theme-emoji' }, p.emoji || '🎲'), h('div', { class: 'theme-name' }, p.name), p.missing ? h('small', {}, 'Coming soon') : null));
  fill('themes', cards);
  if (!packs.length) fill('themes', h('p', { class: 'muted' }, 'Loading themes…'));
  const tabs = [['featured', '⭐ Featured'], comm.total ? ['community', '🌐 Community'] : null, ['make', '✨ Make your own']].filter(Boolean);
  fill('setupTabs', tabs.map(([id, label]) => h('button', { class: `setup-tab ${setupTab === id ? 'on' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(setupTab === id), data: { tab: id } }, label)));
  show('themes', setupTab === 'featured');
  show('community', setupTab === 'community');
  if (setupTab === 'community') renderCommunity();
  show('makeOwn', setup.packId === 'custom');
  if (setup.packId === 'custom') renderMakeOwn();

  const pack = packOf(setup.packId);
  show('themeDetail', !!pack);
  // Community board details open in a side panel (a full-screen sheet on phones), not under the list.
  const drawer = !!pack && setupTab === 'community';
  $('themeDetail').classList.toggle('drawer', drawer);
  $('themeDetail').setAttribute('role', drawer ? 'dialog' : 'region');
  if (drawer) $('themeDetail').setAttribute('aria-label', `${pack.name} details`); else $('themeDetail').removeAttribute('aria-label');
  show('detailBackdrop', drawer);
  show('detailClose', drawer);
  document.body.classList.toggle('drawer-open', drawer);
  if (!pack) return;
  const inPlay = boardsInPlay(pack);
  $('themeTitle').textContent = `${pack.emoji || ''} ${pack.name}`;
  fill('themeBoards',
    h('div', {}, inPlay.map((bi) => `Board ${bi + 1}: ${pack.boards[bi].name}`).join(' · ')),
    pack.teams?.length ? [h('div', {}, pack.teams.join(' · '))] : [],
    pack.community ? h('div', { class: 'comm-detail' }, [pack.madeBy ? `🌐 Made by ${pack.madeBy}` : '🌐 Community board',
      (pack.tags || []).map((t) => `${t.emoji} ${t.name}`.trim()).join(', ')].filter(Boolean).join(' · '), pack.kidFriendly ? pill('pill-kids', 'Kids') : null) : null);

  seg('optHost', [['host', 'Someone hosts'], ['nohost', 'No host (everyone plays)']], setup.host === 'nohost' ? 'nohost' : 'host', (v) => (setup.host = v));
  seg('optBoards', pack.boards.length < 2 ? [['both', 'Board 1']] :
    [['both', 'Both'], ['1', 'Board 1 only'], ['2', 'Board 2 only']], pack.boards.length < 2 ? 'both' : setup.boards, (v) => (setup.boards = v));
  seg('optSparkle', [[0, 'Off'], [3, 'Every 3'], [4, 'Every 4'], [6, 'Every 6']], setup.sparkleEvery, (v) => (setup.sparkleEvery = v));
  fill('optModes', Object.entries(MODES).map(([m, info]) => {
    const b = h('button', { class: `segbtn ${setup.modes[m] !== false ? 'on' : ''}`, type: 'button' }, info.label);
    b.onclick = () => { setup.modes = { ...setup.modes, [m]: setup.modes[m] === false }; saveSetup(); renderSetup(); };
    return b;
  }));
  seg('optBonuses', [[true, 'On'], [false, 'Off']], setup.bonuses, (v) => (setup.bonuses = v));
  seg('optDouble', [[true, 'On'], [false, 'Off']], setup.double, (v) => (setup.double = v));

  // Category swapping: each board in play needs exactly 5.
  let allFive = true;
  // Every board in play lists its categories (hover one to see what it asks).
  // Only a board with more than 5 lets the host pick; with exactly 5 they're shown read-only.
  fill('optCats', inPlay.map((bi) => {
    const board = pack.boards[bi];
    const canPick = pack.id !== 'custom' && board.categories.length > 5;
    if (!canPick) {
      return h('div', { class: 'opt' },
        h('span', { class: 'opt-label' }, `Board ${bi + 1} categories`),
        h('div', { class: 'seg' }, board.categories.map((c) =>
          h('span', { class: 'cat-chip', tabindex: c.note ? '0' : null, 'data-tip': c.note || null, 'aria-label': c.note ? `${c.name}: ${c.note}` : null }, c.name))));
    }
    const picks = catPicks(pack, bi);
    if (picks.length !== 5) allFive = false;
    const chips = board.categories.map((c, ci) => {
      // The category's "how to play" line is its tooltip (hover, or focus with the keyboard).
      const b = h('button', { class: `segbtn ${picks.includes(ci) ? 'on' : ''}`, type: 'button', 'data-tip': c.note || null, 'aria-description': c.note || null }, c.name);
      b.onclick = () => {
        const next = picks.includes(ci) ? picks.filter((x) => x !== ci) : [...picks, ci];
        setup.cats = { ...setup.cats, [pack.id]: { ...(setup.cats[pack.id] || {}), [bi]: next.map((i) => board.categories[i].name) } };
        saveSetup(); renderSetup();
      };
      return b;
    });
    return h('div', { class: 'opt' },
      h('span', { class: 'opt-label' }, `Board ${bi + 1} categories `,
        h('button', { type: 'button', class: 'info', 'data-tip': 'Pick the 5 categories to play. Hover a category to see what it asks.', 'aria-label': 'Pick the 5 categories to play. Hover a category to see what it asks.' }, 'ⓘ'),
        h('small', { class: picks.length === 5 ? 'ok' : 'bad' }, `${picks.length} of 5 picked`)),
      h('div', { class: 'seg' }, chips));
  }));
  $('startGame').disabled = !allFive;
  $('setupNote').textContent = allFive ? '' : 'Pick exactly 5 categories for each board (in Customise).';
  show('setupNote', !allFive);
}

// ---- Make your own: build a prompt, paste Claude's reply, check it on the server, then start ----
const MO_DEFAULTS = { topic: '', region: 'mixed', tone: 'silly', boards: 2, sparkle: true, format: 'table' };

// Who's playing: shapes which references the questions use.
const REGIONS = {
  mixed: ['🌍 Mixed (US + India)', 'friends in the US and India',
    '- Should make sense to people in both the US and India. Avoid very local references.'],
  usa: ['🇺🇸 USA', 'friends in the USA',
    '- Made for an American crowd: US pop culture, TV, sports, food and everyday life are great. Use US spellings.'],
  india: ['🇮🇳 India', 'friends in India',
    '- Made for an Indian crowd: Bollywood, cricket, desi food, festivals, ads and everyday Indian life are great. A little Hinglish is fine, but keep questions readable in English.'],
};
let mo = (() => {
  try { return { ...MO_DEFAULTS, ...JSON.parse(load('fbMakeOwn') || '{}') }; } catch { return { ...MO_DEFAULTS }; }
})();
const saveMo = () => save('fbMakeOwn', JSON.stringify(mo));
let share = null; // the "Share with community" form for the checked pack (survives re-renders)
let communityTags = []; // tag names from the server; empty when there's no database (no tags in the prompt)
let custom = null; // { pack, preview, csv } after a pack passes the server's check; lives only in this page
let moErrors = null; // problems from the last check

const TONES = {
  silly: ['😂 Silly', 'funny and guessable; playful, cheeky question wording that gets a laugh'],
  mixed: ['🙂 Mixed', 'fun with some real trivia'],
  nerdy: ['🤓 Nerdy', 'harder, for fans, still playful'],
};

// The setup screen's summary for an uploaded pack: its 5 categories per board are all in play.
function customSummary() {
  if (!custom) return null;
  const p = custom.preview;
  return { id: 'custom', name: p.name, emoji: p.emoji || '✨', hasSparkle: p.hasSparkle, teams: p.teams,
    boards: p.boards.map((b) => ({ name: b.name, categories: b.categories.map((name) => ({ name, default: true })) })) };
}

// Community tags: only when the server has a database (otherwise sharing is off and tags are pointless).
function tagRules() {
  if (!communityTags.length) return [];
  const table = mo.format === 'table';
  return [
    '',
    'Tags:',
    `- Pick 1–3 tags from this list for the pack: ${communityTags.join(', ')}.`,
    `- If none fit well, also suggest one new tag in ${table ? 'the Suggested tag row' : '"suggestedTag"'} (max 20 characters).`,
    `- Set ${table ? 'Kid friendly to yes' : '"kidFriendly": true'} only if every question, bonus and sparkle card suits children.`,
  ];
}

// The Sparkle games this game will use (shared with Customise), and whether Claude writes cards for them.
const modesOn = () => Object.keys(MODES).filter((m) => setup.modes[m] !== false);
const sparkleCards = () => setup.sparkleEvery > 0 && modesOn().length > 0;

function makePrompt() {
  const topic = mo.topic.trim() || '(your topic)';
  const on = modesOn();
  const asks = { draw: ['"draw" with 6 easy, 6 medium, 6 tricky things to draw on this topic', '6 easy, 6 medium, 6 tricky things to draw on this topic'],
    charades: ['"charades" with 10 things to act out', '10 things to act out (Charades)'],
    mimic: ['"mimic" with 8 "do X like Y" prompts', '8 "do X like Y" prompts (Mimic)'] };
  const join = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join('; ')}; and ${xs[xs.length - 1]}` : xs[0]);
  const sparkleRule = sparkleCards()
    ? `- Also include "sparkle": ${join(on.map((m) => asks[m][0]))}. Light, kind, party-safe.${on.length < 3 ? ' Leave out the other Sparkle lists.' : ''}`
    : '- Do not include "sparkle".';
  const shapes = { draw: '"draw":{"easy":[],"medium":[],"tricky":[]}', charades: '"charades":[]', mimic: '"mimic":[]' };
  const sparkleShape = sparkleCards() ? `,"sparkle":{${on.map((m) => shapes[m]).join(',')}}` : '';
  const rowLabels = { draw: 'Draw easy, Draw medium, Draw tricky', charades: 'Charades', mimic: 'Mimic' };
  const reply = mo.format === 'table' ? [
    'Reply with ONLY a CSV table in one code block, with exactly this header row:',
    'Board,Category,Points,Question,Answer,Bonus,Fun fact,Verify,How to play',
    '- First row after the header: Pack,<short pack name>,<one emoji>',
    '- Then 4 team rows: Team,<team name> (one per row).',
    communityTags.length ? '- Then: Tags,<tag>,<tag> (1–3 tags, one per cell); Suggested tag,<new tag> (only if none fit well); Kid friendly,<yes or no>.' : null,
    '- Then one row per question. Board is the board\'s name (the same on every row of that board). Points are that board\'s values.',
    '- Leave Fun fact empty when there isn\'t one. Verify is "yes" or empty. Fill How to play on the first row of each category only.',
    '- Put a cell in double quotes if it contains a comma or a quote, and write any quote inside it as "".',
    sparkleCards() ? `- Sparkle cards go at the end, one per row, with the card in the Question column: Sparkle,${on[0] === 'draw' ? 'Draw easy' : rowLabels[on[0]]},,<thing> (Category is one of: ${on.map((m) => rowLabels[m]).join(', ')}).` : null,
    '- If you run out of space, stop at the end of a row. When I say "continue", carry on from the next row.',
  ] : [
    'Reply with ONLY one JSON object in one code block, in exactly this format:',
    '{"format":"buzz-pack-v2","name":"<short name>","emoji":"<one emoji>","teamNames":["Team ...","Team ...","Team ...","Team ..."],' +
      (communityTags.length ? '"tags":["..."],"suggestedTag":"","kidFriendly":false,' : '') + '"boards":[{"name":"<a real name for this board>","categories":[{"name":"...","note":"<how to play>","questions":[{"value":100,"question":"...","answer":"...","bonus":"...","bonusPoints":50,"funFact":"...","verify":false}]}]}]' + sparkleShape + '}',
  ];
  return [
    `Make a trivia pack for a party buzzer game played by ${(REGIONS[mo.region] || REGIONS.mixed)[1]}.`,
    '',
    `Topic: ${topic}`,
    `Tone: ${TONES[mo.tone][1]}`,
    `Boards: ${mo.boards}`,
    '',
    'Rules:',
    '- Each board has 5 categories × 5 questions. Board 1 values: 100,200,300,400,500. Board 2 (if any) values: 200,400,600,800,1000. Lowest = almost everyone gets it; highest = a real stretch.',
    '',
    'Categories:',
    '- Invent your own categories that fit this topic naturally. Think about what fans of the topic would enjoy and what makes a group of friends laugh or argue.',
    '- Each name must be instantly clear: a guest should know what kind of answer to give within 3 seconds. Max 4 words. No forced puns or awkward wordplay.',
    '- Make the 5 categories on a board feel different from each other (e.g. people, moments, places, quotes, objects, numbers, real-or-fake facts), not five variations of the same thing.',
    '- It\'s fine to use a playful format (emoji clues, badly explained plots, real or made up) when it genuinely suits the content, but don\'t force one.',
    '- The humour should come from how the questions are written, not from the category name.',
    `- Each category's description (${mo.format === 'table' ? 'the How to play column' : '"note"'}, max 100 characters) says exactly what to answer, e.g. "A famous captain described. Name them."`,
    '',
    'Questions and extras:',
    (REGIONS[mo.region] || REGIONS.mixed)[2],
    '- Answers short (a name, title or a few words).',
    `- ${mo.format === 'table' ? 'In the 4 Team rows: 4' : '"teamNames": 4'} fun team names that fit the topic, each starting with "Team" (max 24 characters), e.g. for space: "Team Black Hole". They're used for the teams in the game.`,
    '- Give each board a real name that fits the topic (max 40 characters), e.g. "Rookie Orbit" and "Deep Space". It\'s shown on the game board. Never "Board 1" or "Board 2".',
    '- Every question has "bonus": a quick, silly, safe thing to do in under 15 seconds that fits the answer. bonusPoints is 50.',
    '- Optional "funFact": one short "did you know" line.',
    '- Only use facts you\'re confident about; if unsure set "verify": true.',
    '- Plain text only: no HTML, no links, no images, no song lyrics beyond 2–3 words.',
    '- Max lengths: question 300, answer 100, bonus 150, funFact 200 characters.',
    mo.format === 'table' && sparkleCards() ? `- Also include Sparkle cards: ${join(on.map((m) => asks[m][1]))}. Light, kind, party-safe.` : sparkleRule,
    ...tagRules(),
    '',
    'Before replying, reread every category name and rename any that would confuse a guest or sound unnatural.',
    '',
    ...reply.filter((x) => x != null),
  ].join('\n');
}

function moSeg(id, options, current, onPick) {
  seg(id, options, current, (v) => { onPick(v); saveMo(); });
}

function renderMakeOwn() {
  if (document.activeElement !== $('moTopic')) $('moTopic').value = mo.topic;
  moSeg('moTone', Object.entries(TONES).map(([k, [label]]) => [k, label]), mo.tone, (v) => (mo.tone = v));
  moSeg('moBoards', [[1, '1 board'], [2, '2 boards']], mo.boards, (v) => (mo.boards = v));
  moSeg('moRegion', Object.entries(REGIONS).map(([k, [label]]) => [k, label]), REGIONS[mo.region] ? mo.region : 'mixed', (v) => (mo.region = v));
  fill('moModes', Object.entries(MODES).map(([m, info]) => {
    const b = h('button', { class: `segbtn ${setup.modes[m] !== false ? 'on' : ''}`, type: 'button', 'aria-pressed': String(setup.modes[m] !== false) }, info.label);
    b.onclick = () => { setup.modes = { ...setup.modes, [m]: setup.modes[m] === false }; saveSetup(); renderSetup(); };
    return b;
  }));
  // Sparkle Round on/off (the same setting as Customise); when on, pick which games.
  seg('moSparkle', [[true, 'On'], [false, 'Off']], sparkleCards(), (on) => {
    setup.sparkleEvery = on ? setup.sparkleEvery || 6 : 0;
    if (on && !modesOn().length) setup.modes = Object.fromEntries(Object.keys(MODES).map((m) => [m, true]));
  });
  show('moModesRow', sparkleCards());
  moSeg('moFormat', [['table', '📊 Table (Excel / Sheets)'], ['json', '{ } JSON']], mo.format, (v) => (mo.format = v));
  $('moHow').textContent = mo.format === 'table'
    ? 'Paste this into Claude. Copy its whole reply and paste it below. If Claude stops early, type "continue" and paste that reply underneath too. Want to review it first? Paste the table into Excel or Google Sheets, edit, then copy all the cells and paste them here (or save as CSV and upload).'
    : 'Paste this into Claude. Copy its whole reply and paste it below, or download its file and upload it.';
  $('moPrompt').value = makePrompt();

  if (moErrors) {
    fill('moResult', h('div', { class: 'mo-errors' },
      h('b', {}, '⚠️ This pack needs fixing:'),
      h('ul', {}, moErrors.map((e) => h('li', {}, e))),
      h('div', { class: 'muted' }, 'Tip: fix it in the box (or in your spreadsheet), or copy these lines to Claude and ask it to fix them.')));
  } else if (custom) {
    const p = custom.preview;
    const verify = p.checks.filter((c) => c.kind === 'verify').length;
    const startBtn = h('button', { class: 'big' }, '▶ Start game with this pack');
    startBtn.onclick = startNewGame;
    const dl = h('button', { class: 'secondary' }, '⬇ Download pack (.json)');
    dl.onclick = () => downloadPack('json');
    const dlCsv = h('button', { class: 'secondary' }, '⬇ Download for Excel (.csv)');
    dlCsv.onclick = () => downloadPack('csv');
    fill('moResult', h('div', { class: 'mo-preview' },
      h('h3', {}, `✅ ${p.emoji} ${p.name}`),
      h('div', {}, `${p.questions} questions · ${p.boards.length} board${p.boards.length > 1 ? 's' : ''} · Sparkle deck: ${p.hasSparkle ? 'yes' : 'no (uses the party deck)'}`),
      h('div', {}, 'Teams: ' + (p.teams.length ? p.teams.join(', ') : 'Team Red, Team Yellow, Team Green, Team Pink (none in the pack)')),
      p.boards.flatMap((b, bi) => [h('div', { class: 'mo-step' }, h('b', {}, `Board ${bi + 1}: ${b.name}`)), h('div', { class: 'cats' }, b.categories.join('  ·  '))]),
      p.checks.length
        ? [h('b', {}, `⚠️ Check these (${verify} fact${verify === 1 ? '' : 's'} Claude wasn't sure of)`),
          h('ul', { class: 'mo-checks' }, p.checks.map((c) => h('li', {},
            h('div', { class: 'where' }, c.where), c.question, ' → ', h('b', {}, c.answer),
            h('span', {}, '  🔍 verify this fact'))))]
        : h('div', { class: 'muted' }, 'Nothing flagged to check.'),
      // Host is chosen for this game only, not saved in the pack (same setting as Customise).
      h('div', { class: 'opt' }, h('span', { class: 'opt-label' }, 'Host'), h('div', { id: 'moHost', class: 'seg' })),
      h('div', { class: 'row' }, startBtn, dlCsv, dl),
      shareSection()));
    seg('moHost', [['host', 'Someone hosts'], ['nohost', 'No host (everyone plays)']], setup.host === 'nohost' ? 'nohost' : 'host', (v) => (setup.host = v));
  } else {
    fill('moResult');
  }
}

// ---- 🌐 Share with community (only when the server has a database) ----
const MAX_SHARE_TAGS = 3;
function newShare(preview) {
  return {
    open: false, madeBy: load('fbMadeBy') || '',
    tags: new Set((preview.tags || []).filter((t) => communityTags.includes(t)).slice(0, MAX_SHARE_TAGS)),
    kid: !!preview.kidFriendly, busy: false, done: false, error: null,
  };
}

function shareSection() {
  if (!communityTags.length || !custom) return null;
  share ||= newShare(custom.preview);
  const box = h('details', { class: 'share' }, h('summary', {}, '🌐 Share with community'));
  box.open = share.open;
  box.ontoggle = () => (share.open = box.open);
  if (share.done) {
    box.append(h('p', { class: 'share-done' }, 'Thanks! It\'ll appear in Community once it\'s approved.'));
    return box;
  }

  const madeIn = h('input', { id: 'shareMadeBy', maxlength: 30, placeholder: 'First name or nickname' });
  madeIn.value = share.madeBy;
  madeIn.oninput = () => (share.madeBy = madeIn.value);

  const boxes = communityTags.map((t) => {
    const cb = h('input', { type: 'checkbox', value: t });
    cb.checked = share.tags.has(t);
    return [t, cb];
  });
  const limitTags = () => boxes.forEach(([t, cb]) => (cb.disabled = !share.tags.has(t) && share.tags.size >= MAX_SHARE_TAGS));
  boxes.forEach(([t, cb]) => (cb.onchange = () => { cb.checked ? share.tags.add(t) : share.tags.delete(t); limitTags(); }));
  limitTags();

  const kid = h('input', { type: 'checkbox', id: 'shareKid' });
  kid.checked = share.kid;
  kid.onchange = () => (share.kid = kid.checked);

  const submit = h('button', { disabled: share.busy }, share.busy ? 'Sending…' : 'Submit for review');
  submit.onclick = submitShare;
  const suggested = custom.preview.suggestedTag;
  box.append(...[
    h('p', { class: 'muted' }, 'Send this board to the admin. Once approved, everyone can play it from the Community tab. Playing now isn\'t affected.'),
    h('label', { for: 'shareMadeBy' }, 'Made by (optional)'), madeIn,
    h('div', { class: 'muted share-hint' }, 'Shown on the board. Leave empty to stay anonymous.'),
    h('div', { class: 'share-label' }, `Tags (1–${MAX_SHARE_TAGS})`),
    h('div', { class: 'share-tags' }, boxes.map(([t, cb]) => h('label', { class: 'share-tag' }, cb, t))),
    suggested ? h('div', { class: 'muted' }, `Suggested new tag: ${suggested} (the admin will decide)`) : null,
    h('label', { class: 'share-kid' }, kid, '👨‍👩‍👧 Kid-friendly (every question, bonus and card suits children)'),
    share.error ? h('div', { class: 'mo-errors' }, h('b', {}, share.error.title), share.error.list?.length ? h('ul', {}, share.error.list.map((e) => h('li', {}, e))) : null) : null,
    h('div', { class: 'row' }, submit),
  ].filter(Boolean));
  return box;
}

function submitShare() {
  if (!custom || !share || share.busy) return;
  const problem = !share.tags.size ? 'Tick at least 1 tag.' : null;
  if (problem) { share.error = { title: problem }; return renderMakeOwn(); }
  share.busy = true;
  share.error = null;
  save('fbMadeBy', share.madeBy.trim() || null);
  renderMakeOwn();
  socket.emit('community:submit', {
    pack: custom.pack, madeBy: share.madeBy, tags: [...share.tags], kidFriendly: share.kid,
  }, (res) => {
    share.busy = false;
    if (res?.ok) share.done = true;
    else share.error = { title: res?.error || 'Something went wrong. Try again.', list: (res?.errors || []).slice(0, 5) };
    renderMakeOwn();
  });
}

function checkPack() {
  const text = $('moPaste').value;
  if (!text.trim()) { custom = null; moErrors = ['Paste Claude\'s reply (or upload its file) first.']; return renderMakeOwn(); }
  $('moCheck').disabled = true;
  socket.emit('host:checkPack', { text, code, secret, name: mo.topic }, (res) => {
    $('moCheck').disabled = false;
    if (res?.ok) { custom = { pack: res.pack, preview: res.preview, csv: res.csv }; moErrors = null; share = null; }
    else { custom = null; moErrors = res?.errors?.length ? res.errors : ['Something went wrong. Try again.']; }
    renderSetup();
  });
}

// Saves the checked pack: JSON (to upload next time) or CSV (to open in Excel / Sheets, edit, and upload).
function downloadPack(kind) {
  if (!custom) return;
  const blob = kind === 'csv'
    ? new Blob([custom.csv], { type: 'text/csv' })
    : new Blob([JSON.stringify(custom.pack, null, 2) + '\n'], { type: 'application/json' });
  const slug = custom.pack.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'my-pack';
  const a = h('a', { href: URL.createObjectURL(blob), download: `${slug}.${kind}` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

$('moTopic').oninput = () => { mo.topic = $('moTopic').value.slice(0, 60); saveMo(); $('moPrompt').value = makePrompt(); };
$('moCopy').onclick = async () => {
  try { await navigator.clipboard.writeText($('moPrompt').value); }
  catch { $('moPrompt').select(); document.execCommand('copy'); }
  $('moCopied').textContent = 'Copied! Now paste it into Claude.';
  setTimeout(() => ($('moCopied').textContent = ''), 4000);
};
$('moPaste').oninput = () => { if (custom || moErrors) { custom = null; moErrors = null; renderSetup(); } };
$('moCheck').onclick = checkPack;
$('moFile').onchange = () => {
  const file = $('moFile').files[0];
  $('moFile').value = '';
  if (!file) return;
  if (/\.(xlsx|xls|numbers|ods)$/i.test(file.name)) {
    custom = null;
    moErrors = ['That\'s a spreadsheet file. Save it as CSV first (Excel: File → Save As → CSV UTF-8; Google Sheets: File → Download → CSV), or select all the cells, copy, and paste them here.'];
    return renderSetup();
  }
  if (file.size > 300 * 1024) { custom = null; moErrors = ['That file is too big (over 300 KB).']; return renderSetup(); }
  file.text().then((text) => { $('moPaste').value = text; checkPack(); });
};

// Runs on first connect and after every reconnect.
socket.on('connect', () => {
  if (code && secret) socket.emit('host:resume', { code, secret }, gotRoom);
  else render();
});
socket.on('state', (s) => {
  state = s;
  sparkleEndsAt = s.sparkle?.running ? Date.now() + s.sparkle.remaining : null;
  nhEndsAt = s.nh?.endsIn != null ? Date.now() + s.nh.endsIn : null;
  render();
});

// Quick "+5 😂" flash next to a team's score.
socket.on('flash', ({ teamId, text }) => {
  const box = [...document.querySelectorAll('.score')].find((el) => el.dataset.scoreTeam === String(teamId));
  if (!box) return;
  const r = box.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'flash';
  el.textContent = text;
  el.style.left = r.left + r.width / 2 + 40 + 'px';
  el.style.top = r.top - 10 + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1300);
});

// ⋯ menu (New game lives here, away from the buttons used during play)
const setMenu = (open) => { show('menu', open); $('menuBtn').setAttribute('aria-expanded', String(open)); };
$('menuBtn').onclick = (e) => { e.stopPropagation(); setMenu($('menu').classList.contains('hidden')); };
document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) setMenu(false); });
$('newGame').onclick = () => { setMenu(false); openSetup(); };

// ---- Host remote: pair a phone (QR → the phone waits → Allow on this screen) ----
let pairing = null; // { qr, expiresAt } while this screen shows a pairing QR
let pairTimer = null;
let forceControls = false; // "Show controls" while a remote is connected
function startPair() {
  setMenu(false);
  $('pairMsg').textContent = '';
  socket.emit('host:pairStart', (res) => {
    if (!res?.ok) { pairing = null; $('pairMsg').textContent = res?.error || 'Could not start pairing.'; show('pair', true); renderPair(); return; }
    pairing = { qr: res.qr, expiresAt: Date.now() + (res.expiresAt - Date.now()) };
    $('pairQr').src = res.qr;
    show('pair', true);
    renderPair();
  });
}
function closePair() {
  if (state?.pairing) act('host:pairCancel');
  pairing = null;
  show('pair', false);
}
// The QR shows only while the code is unused and unexpired; then the TV asks Allow / Deny.
function renderPair() {
  clearTimeout(pairTimer);
  const asking = !!state?.pairing?.waitingForAllow;
  const left = pairing ? Math.ceil((pairing.expiresAt - Date.now()) / 1000) : 0;
  if (pairing && !asking && left <= 0) { pairing = null; $('pairMsg').textContent = 'That code expired. Close this and tap 📱 again.'; }
  if (asking) show('pair', true);
  show('pairAsk', asking);
  show('pairScan', !asking && !!pairing);
  if (!asking && pairing) {
    $('pairLeft').textContent = `Code works for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.`;
    pairTimer = setTimeout(renderPair, 1000);
  }
}
$('pairMenu').onclick = startPair;
$('pairLobby').onclick = startPair;
$('pairClose').onclick = closePair;
$('pairAllow').onclick = () => { socket.emit('host:pairDecision', true); pairing = null; show('pair', false); };
$('pairDeny').onclick = () => { socket.emit('host:pairDecision', false); pairing = null; show('pair', false); };
$('revokeRemotes').onclick = () => {
  setMenu(false);
  if (confirm('Disconnect every phone remote? They will need to scan again.')) socket.emit('host:revokeRemotes');
};
$('showControls').onclick = () => { forceControls = !forceControls; render(); };

// How to play: a one-screen panel; "Show on TV" makes it big
const setHow = (open, tv = false) => { show('howto', open); $('howto').classList.toggle('tv', tv); $('howTv').textContent = tv ? '↙ Smaller' : '📺 Show on TV'; };
$('howBtn').onclick = () => setHow(true);
$('howClose').onclick = () => setHow(false);
$('howTv').onclick = () => setHow(true, !$('howto').classList.contains('tv'));
$('howto').onclick = (e) => { if (e.target === $('howto')) setHow(false); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDetail(); setHow(false); setMenu(false); if (!state?.pairing?.waitingForAllow) closePair(); } });
$('startGame').onclick = startNewGame;
$('cancelSetup').onclick = () => { setupOpen = false; render(); };
$('themes').onclick = (e) => {
  const b = e.target.closest('[data-pack]');
  if (!b || b.disabled) return;
  setup.packId = setup.lastFeatured = b.dataset.pack;
  saveSetup();
  renderSetup();
};
$('setupTabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) switchTab(b.dataset.tab); };
$('commTiles').onclick = (e) => {
  const b = e.target.closest('button');
  if (b?.dataset.browse) { comm.tag = b.dataset.browse; comm.msg = ''; loadCommunity(); }
  else if (b?.dataset.random) surprise(b.dataset.random);
};
$('commBack').onclick = () => { comm.tag = null; comm.msg = ''; loadCommunityHome(); };
const pickFrom = (e) => { const b = e.target.closest('[data-id]'); if (b) pickCommunity(b.dataset.id); };
$('commCards').onclick = pickFrom;
$('commNew').onclick = pickFrom;
$('commMore').onclick = () => loadCommunity(true);
$('commKid').onchange = () => { comm.kid = $('commKid').checked; comm.msg = ''; refreshCommunity(); };
let searchTimer = null;
$('commSearch').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { comm.q = $('commSearch').value; comm.msg = ''; refreshCommunity(); }, 300); };
$('commSurprise').onclick = () => surprise(null);
$('detailClose').onclick = closeDetail;
$('detailBackdrop').onclick = closeDetail;
// Customise starts open; if the host collapses it, that's remembered.
if (load('fbCustomiseOpen') === '0') $('customise').open = false;
$('customise').addEventListener('toggle', () => save('fbCustomiseOpen', $('customise').open ? '1' : '0'));
$('resetSetup').onclick = () => { setup = { ...SETUP_DEFAULTS, packId: setup.packId, lastFeatured: setup.lastFeatured }; saveSetup(); renderSetup(); };
$('finishGame').onclick = () => { if (confirm('Finish the game and show the winner?')) act('host:screen', 'winner'); };
$('finishBig').onclick = emit('host:screen', 'winner');
$('winnerBack').onclick = emit('host:screen', 'board');
$('winnerNew').onclick = () => { state = null; openSetup(); };
$('nextBoard').onclick = () => act('host:switchBoard', 1);
// Hold to peek: shows the answer only while the button is held down.
const peek = (on) => show('peekBox', on && !!state?.current);
$('peek').onpointerdown = (e) => { e.preventDefault(); peek(true); };
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) $('peek').addEventListener(ev, () => peek(false));
$('pinGo').onclick = startNewGame;
$('pin').onkeydown = (e) => { if (e.key === 'Enter') startNewGame(); };
$('makeTeams').onclick = () => act('host:makeTeams', Number($('teamCount').value));
$('toBoard').onclick = emit('host:screen', 'board');
$('startBig').onclick = openSetup;
$('toLobby').onclick = emit('host:screen', 'lobby');
$('toSparkle').onclick = emit('host:screen', 'sparkle');
$('switchBoard').onclick = () => {
  const to = state.boardNo === 0 ? 1 : 0;
  if (to === 1 && !state.boardDone && !confirm(`Board 1 isn't finished. Jump to Board 2 anyway? You can come back.`)) return;
  act('host:switchBoard', to);
};
const movePlayer = (e) => {
  if (e.target.dataset.player && e.target.value !== '') act('host:movePlayer', { playerId: e.target.dataset.player, teamId: Number(e.target.value) });
};
$('teams').onchange = movePlayer;
$('unassigned').onchange = movePlayer;
$('grid').onclick = (e) => {
  const t = e.target.closest('[data-cat]');
  if (t && !t.disabled) act('host:pickTile', { cat: Number(t.dataset.cat), idx: Number(t.dataset.idx) });
};

// Question
$('openBuzzers').onclick = emit('host:openBuzzers');
$('correct').onclick = emit('host:correct');
$('wrong').onclick = emit('host:wrong');
$('showAnswer').onclick = emit('host:showAnswer');
$('backToBoard').onclick = emit('host:backToBoard');
$('funnyRow').onclick = (e) => {
  const b = e.target.closest('[data-funny]');
  if (b) act('host:funny', Number(b.dataset.funny));
};

// Reveal
$('revealNext').onclick = emit('host:revealNext');

// Bonus
$('bonusDone').onclick = emit('host:bonus', true);
$('bonusSkip').onclick = emit('host:bonus', false);

// Sparkle Round
$('skipSparkle').onclick = emit('host:screen', 'board');
$('skipCard').onclick = emit('host:skipCard');
$('timerStart').onclick = emit('host:timer', 'start');
$('timerStop').onclick = emit('host:timer', 'stop');
$('spTeams').onclick = (e) => {
  const b = e.target.closest('[data-team]');
  if (b) act('host:sparkleTeam', Number(b.dataset.team));
};
$('spModes').onclick = (e) => {
  const b = e.target.closest('[data-mode]');
  if (b && !b.disabled) act('host:sparkleMode', b.dataset.mode);
};
$('spLevels').onclick = (e) => {
  const b = e.target.closest('[data-level]');
  if (b && !b.disabled) act('host:sparkleLevel', b.dataset.level);
};
$('spGuessed').onclick = emit('host:sparkleGuessed');
$('spPlayers').onclick = (e) => {
  const b = e.target.closest('[data-player]');
  if (b) act('host:sparklePerformer', b.dataset.player);
};
$('spCard').onclick = (e) => {
  const b = e.target.closest('[data-points]');
  if (b) act('host:sparklePoints', Number(b.dataset.points));
};
$('spCustomGive').onclick = () => {
  const n = Math.round(Number($('spCustom').value));
  if ($('spCustom').value === '' || !Number.isFinite(n)) return $('spCustom').focus();
  act('host:sparklePoints', n);
  $('spCustom').value = '';
};

function tickTimer() {
  const sp = state?.sparkle;
  if (!sp?.hasCard) return;
  const ms = sparkleEndsAt != null ? sparkleEndsAt - Date.now() : sp.remaining;
  const secs = Math.max(0, Math.ceil(ms / 1000));
  $('spTimer').textContent = secs > 0 ? `⏱ ${secs}${sp.running ? '' : ' (paused)'}` : "⏱ Time's up!";
  $('spTimer').classList.toggle('up', secs <= 10);
  // Tick for the last 5 seconds, a horn when time runs out.
  if (sp.running && secs !== lastSecs) {
    if (secs > 0 && secs <= 5) fx.play('tick');
    if (secs === 0) { fx.play('timeUp'); fx.replay($('spTimer'), 'shake'); }
  }
  lastSecs = secs;
}
setInterval(tickTimer, 250);

$('mute').onclick = () => { fx.setMuted(!fx.muted); $('mute').textContent = fx.muted ? '🔇' : '🔊'; soundHint(); };
// The browser blocks sound until this page is tapped. The tap itself turns it on (fx.js); this just asks for one.
const soundHint = () => show('soundOn', fx.soundBlocked);
fx.onSound = soundHint;
$('soundOn').onclick = () => setTimeout(soundHint, 100);
soundHint();
$('mute').textContent = fx.muted ? '🔇' : '🔊';

$('scores').onclick = (e) => {
  const b = e.target.closest('[data-delta]');
  if (b) act('host:adjustScore', { teamId: Number(b.dataset.team), delta: Number(b.dataset.delta) });
};

function render() {
  const screen = setupOpen ? 'setup' : !state ? 'start' : state.current ? 'question' : state.reveal ? 'reveal' : state.bonus ? 'bonus' : state.screen;
  if (screen !== lastScreen) window.scrollTo(0, 0); // a new screen starts at the top
  lastScreen = screen;
  if (screen !== 'setup') document.body.classList.remove('drawer-open'); // no scroll lock outside setup
  for (const s of ['start', 'setup', 'lobby', 'board', 'question', 'reveal', 'bonus', 'sparkle', 'winner']) show(s, s === screen);
  show('howBtn', screen === 'setup' || screen === 'board');
  // A paired phone runs the game: the TV becomes "show mode" (no host buttons) unless the host asks for them.
  const nRemotes = state?.remotes || 0;
  if (!nRemotes) forceControls = false;
  document.body.classList.toggle('show-mode', nRemotes > 0 && !forceControls && screen !== 'setup');
  show('remoteBadge', nRemotes > 0 && screen !== 'setup');
  $('remoteBadge').textContent = nRemotes > 1 ? `📱 ${nRemotes} remotes connected` : '📱 Remote connected';
  show('showControls', nRemotes > 0 && screen !== 'setup' && screen !== 'start');
  $('showControls').textContent = forceControls ? 'Hide controls' : 'Show controls';
  // No host: the shared screen is everyone's. No answers, no host buttons; the server runs the steps.
  const noHost = state?.mode === 'nohost';
  document.body.classList.toggle('nohost', noHost && screen !== 'setup');
  const canPair = !!state && nRemotes < 2 && !noHost; // a remote would show the answers
  show('pairMenu', canPair);
  show('pairLobby', canPair);
  show('revokeRemotes', nRemotes > 0);
  if (state) renderPair();
  show('joinInfo', !!state && (screen === 'board' || screen === 'question'));
  // The address may shorten to fit; the room code never does.
  if (state) fill('joinInfo', 'Join:\u00a0', h('span', { class: 'join-url' }, state.joinUrl.replace(/^https?:\/\//, '')), h('span', { class: 'join-code' }, '\u00a0·\u00a0Room\u00a0', h('b', {}, state.code)));
  show('toLobby', screen === 'board');
  // Late joiners wait in the lobby until the host puts them in a team.
  const waiting = state ? state.players.filter((p) => p.teamId == null).length : 0;
  $('toLobby').textContent = waiting && state.teams.length ? `Lobby / teams (${waiting} waiting)` : 'Lobby / teams';
  $('toLobby').classList.toggle('attention', !!waiting && !!state?.teams.length);
  show('toSparkle', screen === 'board' && !!state?.settings?.sparkleEvery && !noHost);
  show('finishGame', screen === 'board');
  show('switchBoard', screen === 'board' && state?.boardCount > 1);
  show('cancelSetup', !!state);
  if (state) $('switchBoard').textContent = state.boardNo === 0 ? 'Board 2 →' : '← Board 1';
  if (screen === 'setup') renderSetup();
  show('scores', ['board', 'question', 'reveal', 'bonus', 'sparkle'].includes(screen));
  if (!state || screen === 'setup') return;

  const teamOf = (id) => state.teams.find((t) => t.id === id);
  const playerOf = (id) => state.players.find((p) => p.id === id);

  // ---- Lobby ----
  $('qr').src = qr || '';
  $('code').textContent = state.code;
  $('joinUrl').textContent = state.joinUrl;
  $('playerCount').textContent = state.players.length;

  const hasTeams = state.teams.length > 0;
  $('makeTeams').textContent = hasTeams ? 'Reshuffle teams' : 'Make random teams';
  $('makeTeams').classList.toggle('secondary', hasTeams); // once teams exist, "Go to the board" is the main button
  show('toBoard', hasTeams);
  if (hasTeams) $('teamCount').value = state.teams.length;

  const chip = (p) => h('span', { class: `chip ${p.connected ? '' : 'off'} ${seen.has(p.id) ? '' : 'pop'}` }, p.name,
    hasTeams ? [' ', h('select', { data: { player: p.id }, title: 'Put in a team' },
      h('option', { value: '', selected: true }, 'Add to team…'),
      state.teams.map((t) => h('option', { value: t.id }, t.name)))] : []);
  const unassigned = state.players.filter((p) => p.teamId == null).map(chip);
  fill('unassigned', unassigned.length
    ? [hasTeams ? h('span', { class: 'muted' }, 'Waiting for a team: ') : null, ...unassigned].filter(Boolean)
    : hasTeams ? [] : h('p', { class: 'muted' }, 'Waiting for players to join…'));

  fill('teams', state.teams.map((t) => {
    const items = state.players.filter((p) => p.teamId === t.id).map((p) =>
      h('li', { class: `${p.connected ? '' : 'off'} ${seen.has(p.id) ? '' : 'pop'}` }, p.name, ' ',
        h('select', { data: { player: p.id }, title: 'Move to team' },
          state.teams.map((o) => h('option', { value: o.id, selected: o.id === t.id }, o.name)))));
    return h('div', { class: 'team', vars: { '--c': t.color } },
      h('h3', {}, t.name),
      h('ul', {}, items.length ? items : h('li', { class: 'muted' }, 'nobody yet')));
  }));

  // ---- Board ----
  const boardName = state.boardNames?.[state.boardNo] || '';
  $('boardTitle').textContent = `${state.packEmoji || ''} ${state.packName || ''}  ·  ${state.boardCount > 1 ? `Board ${state.boardNo + 1}: ` : ''}${boardName}`;
  const lastBoard = state.boardNo === state.boardCount - 1;
  show('boardDone', state.boardDone);
  show('nextBoard', state.boardDone && !lastBoard);
  show('finishBig', state.boardDone && (lastBoard || state.allDone));
  $('boardDoneText').textContent = state.allDone ? '🎉 All done!' : `🎉 ${boardName || 'This board'} is finished!`;
  $('grid').style.gridTemplateColumns = `repeat(${state.board.length}, 1fr)`;
  const rows = Math.max(...state.board.map((c) => c.values.length));
  const cells = state.board.map((c) => h('div', { class: 'cat', title: c.note || null }, c.category));
  for (let i = 0; i < rows; i++) {
    state.board.forEach((c, ci) => {
      if (c.values[i] == null) return cells.push(h('div'));
      const used = state.used.includes(`${ci}-${i}`);
      cells.push(h('button', { class: 'tile', vars: { '--i': i + ci }, data: { cat: ci, idx: i }, disabled: used }, c.values[i]));
    });
  }
  fill('grid', cells);
  // No host: who picks the next tile (the team that last answered right).
  const picker = noHost && state.nh?.picker != null ? teamOf(state.nh.picker) : null;
  show('nhPicker', noHost && screen === 'board' && !state.boardDone);
  if (noHost) fill('nhPicker', picker ? ['🎯 ', h('span', { color: picker.color }, picker.name), ' picks the next tile, on their phones or here.'] : '🎯 Tap a tile here, or pick it from a phone.');

  // ---- Question ----
  const q = state.current;
  if (q) {
    $('qCategory').textContent = `${q.category} — ${q.value}`;
    fill('qNote', q.note ? [h('b', {}, '💬 How to play: '), q.note] : []);
    show('qNote', !!q.note);
    $('qText').textContent = q.question;
    $('qText').classList.toggle('long', q.question.length > 160); // wordy questions get smaller text
    $('qText').classList.toggle('xlong', q.question.length > 380); // really wordy ones get smaller still
    show('qDouble', !!q.double);
    const firstDouble = !!q.double && firstTime('double', `${state.boardNo}-${q.cat}-${q.idx}`);
    show('qDoubleHelp', firstDouble);
    $('qDoubleHelp').textContent = `Right = +${q.value * 2}, wrong = −${q.value * 2}`;
    $('qCategory').textContent = `${q.category} — ${q.double ? q.value * 2 : q.value}${q.double ? ' (Double!)' : ''}`;
    fill('peekBox', h('b', {}, 'Answer: '), q.answer);

    const b = state.buzz;
    const turn = b.order.find((e) => !b.locked.includes(e.teamId));
    $('buzzBadge').textContent = b.open ? 'Buzzers OPEN' : 'Closed';
    $('buzzBadge').className = 'badge ' + (b.open ? 'open' : 'closed');
    $('openBuzzers').disabled = b.open;
    $('correct').disabled = $('wrong').disabled = !turn;
    fill('funnyRow', state.teams.map((t) =>
      h('button', { class: 'funny', vars: { '--c': t.color }, data: { funny: t.id } }, `😂 +5 ${t.name}`)));
    const order = b.order.map((e) => {
      const t = teamOf(e.teamId);
      const cls = b.locked.includes(e.teamId) ? 'locked' : e === turn ? 'turn' : '';
      return h('li', { class: cls }, h('span', { color: t?.color }, t?.name || '?'), ` — ${playerOf(e.playerId)?.name || '?'}`);
    });
    fill('order', order.length ? order : b.open ? h('p', { class: 'muted' }, 'Waiting for a buzz…') : []);
  }

  // ---- Reveal ----
  const r = state.reveal;
  if (r) {
    const t = teamOf(r.teamId);
    fill('revealHead', t ? [h('span', { color: t.color }, t.name), ` got it! +${r.points}`] : 'Nobody got this one');
    $('revealAnswer').textContent = r.answer;
    fill('revealFact', r.funFact ? [h('b', {}, '💡 Did you know? '), r.funFact] : []);
    show('revealFact', !!r.funFact);
    $('revealNext').textContent = r.bonus ? 'Next: bonus →' : 'Back to board →';
  }

  // ---- Bonus ----
  if (state.bonus) {
    show('bonusHelp', firstTime('bonus', `${state.boardNo}-${state.used.length}`));
    $('bonusHelp').textContent = noHost ? `Bonus: do this, and the other teams vote 👍 or 👎 on their phones. More 👍 = +${state.bonus.points}.`
      : `Bonus: do this and your team gets +${state.bonus.points}. Skipping is fine.`;
    const t = teamOf(state.bonus.teamId);
    fill('bonusFor', '⭐ BONUS for ', h('span', { color: t?.color }, t?.name || '?'), ':');
    $('bonusText').textContent = state.bonus.text;
    $('bonusDone').textContent = `Bonus done +${state.bonus.points}`;
  }

  // ---- Sparkle Round ----
  const sp = state.sparkle;
  if (screen === 'sparkle' && sp) {
    show('sparkleHelp', firstTime('sparkle', `${state.boardNo}-${state.used.length}`));
    const team = teamOf(sp.teamId);
    $('spShow').textContent = sp.hasCard ? '' : noHost ? 'Picking the next team…' : team ? `${team.name} is up! The host is picking the game…` : 'The host is picking a team…';
    show('spSetup', !sp.hasCard);
    show('spCard', sp.hasCard);

    fill('spTeams', state.teams.map((t) =>
      h('button', { class: `pick ${sp.teamId === t.id ? 'selected' : ''}`, vars: { '--c': t.color }, data: { team: t.id } }, t.name)));
    fill('spModes', Object.entries(MODES).filter(([m]) => state.settings.modes.includes(m)).map(([m, info]) =>
      h('button', { class: `pick ${sp.mode === m ? 'selected' : ''}`, data: { mode: m }, disabled: !cardsLeft(m) },
        info.label, ' ', h('small', {}, `(${cardsLeft(m)} left)`))));

    const isDraw = sp.mode === 'draw';
    show('spLevelStep', isDraw);
    fill('spLevels', Object.entries(LEVELS).map(([l, info]) =>
      h('button', { class: `pick ${sp.level === l ? 'selected' : ''}`, data: { level: l }, disabled: !cardsLeft('draw', l) },
        `${info.label} (${info.points}) `, h('small', {}, `(${cardsLeft('draw', l)} left)`))));

    show('spPerformerStep', !!team && !!sp.mode && (!isDraw || !!sp.level));
    show('spEmpty', sp.empty);
    if (team) {
      $('spPerformerPrompt').textContent = `${sp.mode === 'draw' ? 4 : 3}. ${team.name}, choose your performer (tap their name):`;
      const performers = state.players.filter((p) => p.teamId === team.id).map((p) =>
        h('button', { class: 'pick', vars: { '--c': team.color }, data: { player: p.id } }, p.name));
      fill('spPlayers', performers.length ? performers : h('span', { class: 'muted' }, 'This team has no players.'));
    }

    if (sp.hasCard) {
      const performer = playerOf(sp.performerId);
      const info = MODES[sp.mode];
      $('spType').textContent = `${info.label} — ${performer?.name || '?'} (${team.name})`;
      $('spText').textContent = sp.mode === 'mimic' ? sp.text
        : sp.mode === 'draw' ? `🎨 ${team.name} ${info.doing} ${LEVELS[sp.level].label} — ${sp.points} points`
        : `🤐 ${team.name} ${info.doing}`;
      show('spGuessed', sp.mode === 'draw');
      show('spPresets', sp.mode !== 'draw');
      $('spGuessed').textContent = `🎉 Guessed! +${sp.points}`;
      $('spTeamName').textContent = team.name;
      $('timerStart').disabled = sp.running;
      $('timerStop').disabled = !sp.running;
      $('skipCard').disabled = !cardsLeft(sp.mode, sp.level);
      tickTimer();
    }
  }

  // ---- Winner ----
  if (screen === 'winner') {
    const ranked = [...state.teams].sort((a, b) => b.score - a.score);
    const top = ranked.filter((t) => t.score === ranked[0]?.score);
    fill('winnerName', top.length > 1 ? "It's a tie!" : [h('span', { color: top[0]?.color }, top[0]?.name || ''), ' wins!']);
    fill('ranking', ranked.map((t, i) => h('li', { class: i === 0 || t.score === ranked[0].score ? 'first' : '' },
      h('span', { color: t.color }, t.name), h('b', {}, t.score))));
  }

  // ---- Scores ----
  const oldPts = new Map([...document.querySelectorAll('.score')].map((el) => [el.dataset.scoreTeam, el.dataset.pts]));
  fill('scores', state.teams.map((t) =>
    h('div', { class: 'score', data: { scoreTeam: t.id, pts: t.score }, vars: { '--c': t.color } },
      h('div', { class: 'score-name' }, t.name),
      h('div', { class: 'score-pts' }, t.score),
      h('div', { class: 'host-only' },
        h('button', { class: 'secondary', data: { team: t.id, delta: -100 } }, '−'), ' ',
        h('button', { class: 'secondary', data: { team: t.id, delta: 100 } }, '+')))));

  nhTick();
  effects(screen, oldPts);
}

// No host: what the server is doing right now, with its countdown (updated 4× a second).
function nhTick() {
  const n = state?.nh;
  const ids = ['nhQ', 'nhR', 'nhB', 'nhS'];
  if (!n || setupOpen) { ids.forEach((id) => show(id, false)); return; }
  const secs = nhEndsAt == null ? '' : Math.max(0, Math.ceil((nhEndsAt - Date.now()) / 1000));
  const teamOf = (id) => state.teams.find((t) => t.id === id);
  const who = (pid, tid) => { const t = teamOf(tid); return h('span', { color: t?.color }, `${state.players.find((p) => p.id === pid)?.name || '?'} (${t?.name || '?'})`); };
  const count = h('b', { class: 'nh-count' }, secs);
  let el = null;
  let parts = [];
  if (state.current) {
    el = 'nhQ';
    if (n.phase === 'reading') parts = ['Buzzers open in ', count];
    else if (n.phase === 'open') parts = ['🔔 Buzzers OPEN! ', h('span', { class: 'muted' }, `${secs}s`)];
    else if (n.phase === 'saying') parts = [who(n.buzzer, n.buzzTeam), ': say your answer! ', count];
    else if (n.phase === 'judging') parts = [who(n.buzzer, n.buzzTeam), ' is checking the answer on their phone… ', h('span', { class: 'muted' }, `${secs}s`)];
    else if (n.phase === 'challenge') {
      parts = [who(n.buzzer, n.buzzTeam), n.claim ? ' says ✅ got it.' : ' says ❌ missed it.',
        n.challengedBy ? [' 🚩 ', who(n.challengedBy, state.players.find((p) => p.id === n.challengedBy)?.teamId), ' challenged!'] : [' Disagree? 🚩 Challenge on your phone ', count]];
    }
  } else if (state.reveal) {
    el = 'nhR';
    parts = [state.reveal.bonus ? 'Bonus next in ' : 'Back to the board in ', secs];
  } else if (state.bonus) {
    el = 'nhB';
    parts = ['Other teams, vote on your phones: 👍 ', h('b', {}, n.votes.up), '  👎 ', h('b', {}, n.votes.down), ' ', h('span', { class: 'muted' }, `(${secs}s)`)];
  } else if (state.sparkle?.hasCard) {
    el = 'nhS';
    const sp = state.sparkle;
    if (n.phase === 'sparkleReady') parts = [who(sp.performerId, sp.teamId), ' is reading their card… ', count];
    else if (n.phase === 'sparkleRun') parts = [sp.mode === 'mimic' ? 'The performer taps Done on their phone when finished.' : `${teamOf(sp.teamId)?.name || 'Their team'}, guess it! The performer taps "Guessed!" on their phone.`];
    else if (n.phase === 'mimicVote') parts = ['Other teams, vote on your phones: 😂 ', h('b', {}, n.votes.lol), '  🙂 ', h('b', {}, n.votes.smile), '  😐 ', h('b', {}, n.votes.meh), ' ', h('span', { class: 'muted' }, `(${secs}s)`)];
  }
  ids.forEach((id) => show(id, id === el && parts.length > 0));
  if (el && parts.length) fill(el, parts);
}
setInterval(nhTick, 250);

// Animations and sounds, fired only when something changed since the last render.
function effects(screen, oldPts) {
  const p = prev;
  const b = state?.buzz;
  prev = {
    screen,
    key: state?.current ? `${state.current.cat}-${state.current.idx}` : null,
    order: b?.order.length || 0,
    locked: b?.locked.length || 0,
    open: !!b?.open,
    showAnswer: !!state?.showAnswer,
    card: !!state?.sparkle?.hasCard,
    board: state?.boardNo,
    players: new Set(state?.players.map((x) => x.id)),
  };
  for (const x of state?.players || []) seen.add(x.id);
  if (!p) return;

  // A new screen slides in. The board deals its tiles in.
  if (screen !== p.screen || (screen === 'board' && prev.board !== p.board)) {
    const sec = $(screen);
    fx.replay(sec, 'enter');
    clearTimeout(sec._t);
    sec._t = setTimeout(() => sec.classList.remove('enter'), 1500);
    if (screen === 'sparkle') { fx.play('sparkle'); fx.confetti(innerWidth / 2, innerHeight * 0.3, '#c77dff', 120); }
    if (screen === 'bonus' || (screen === 'reveal' && !state.reveal.teamId)) fx.play('reveal');
  }

  // Scores: bump, and confetti from the box when a team gains points.
  if (screen !== 'lobby') for (const t of state.teams) {
    const old = Number(oldPts.get(String(t.id)));
    if (Number.isNaN(old) || old === t.score) continue;
    const box = document.querySelector(`.score[data-score-team="${t.id}"]`);
    fx.replay(box, t.score > old ? 'gain' : 'lose');
    if (t.score - old >= 25) {
      const r = box.getBoundingClientRect();
      fx.confetti(r.left + r.width / 2, r.top, t.color);
    }
  }

  // A hidden Double just opened.
  if (screen === 'question' && prev.key !== p.key && state.current?.double) {
    fx.play('double');
    fx.banner('DOUBLE!');
  }
  if (screen === 'winner' && p.screen !== 'winner') { fx.play('winner'); fx.emojiRain(); }

  if (screen === 'question' && prev.key === p.key) {
    if (prev.open && !p.open) fx.play('open');
    if (prev.order > p.order) {
      fx.play('buzz');
      [...$('order').children].slice(p.order).forEach((li) => li.classList.add('pop'));
    }
    if (prev.locked > p.locked) { fx.play('wrong'); fx.replay($('qText'), 'shake'); fx.replay(document.body, 'redflash'); }
  }
  if (screen !== 'question' && p.screen === 'question' && state.teams.some((t) => Number(oldPts.get(String(t.id))) < t.score)) fx.play('correct');
  if (screen === 'sparkle' && prev.card && !p.card) fx.replay($('spCard'), 'enter');

  if (screen === 'lobby' && state.players.some((x) => !p.players.has(x.id))) fx.play('open');
}
