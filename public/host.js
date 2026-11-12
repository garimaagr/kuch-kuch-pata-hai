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
const fill = (id, ...kids) => $(id).replaceChildren(...kids.flat());
const emit = (ev, data) => () => socket.emit(ev, data);

function load(k) { try { return localStorage.getItem(k); } catch { return null; } }
function save(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }

let code = load('fbHostCode');
let secret = load('fbHostSecret'); // proves to the server that this laptop is the host
let qr = null;
let state = null;
let sparkleEndsAt = null; // local clock time when the timer runs out (only while running)
let prev = null; // what the last render showed, so effects only fire on changes
let lastSecs = null;
const seen = new Set(); // players already shown, so only new ones pop in

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
const SETUP_DEFAULTS = { packId: 'desi', boards: 'both', sparkleEvery: 6, modes: { draw: true, charades: true, mimic: true }, bonuses: true, double: true, cats: {} };
let setup = (() => {
  try { return { ...SETUP_DEFAULTS, ...JSON.parse(load('fbSetup') || '{}') }; } catch { return { ...SETUP_DEFAULTS }; }
})();
const saveSetup = () => save('fbSetup', JSON.stringify(setup));
const packOf = (id) => packs.find((p) => p.id === id && !p.missing);

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
  if (state && !confirm('Start a new game? The current game will be left behind.')) return;
  setupOpen = true;
  show('pinBox', false);
  socket.emit('host:packs', (list) => {
    packs = Array.isArray(list) ? list : [];
    if (!packOf(setup.packId)) setup.packId = packs.find((p) => !p.missing)?.id || 'desi';
    render();
  });
  render();
}

function startNewGame() {
  const pack = packOf(setup.packId);
  if (!pack) return;
  const categories = pack.boards.map((_, bi) => catPicks(pack, bi));
  socket.emit('host:new', {
    pin: $('pin').value, packId: pack.id, boards: setup.boards, sparkleEvery: setup.sparkleEvery,
    modes: setup.modes, bonuses: setup.bonuses, double: setup.double, categories,
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
  cards.push(h('button', { class: 'theme soon', disabled: true }, h('div', { class: 'theme-emoji' }, '✨'), h('div', { class: 'theme-name' }, 'Make your own'), h('small', {}, 'Coming soon')));
  fill('themes', cards);
  if (!packs.length) fill('themes', h('p', { class: 'muted' }, 'Loading themes…'));

  const pack = packOf(setup.packId);
  show('themeDetail', !!pack);
  if (!pack) return;
  const inPlay = boardsInPlay(pack);
  $('themeTitle').textContent = `${pack.emoji || ''} ${pack.name}`;
  $('themeBoards').textContent = inPlay.map((bi) => `Board ${bi + 1}: ${pack.boards[bi].name}`).join('  ·  ');

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
  fill('optCats', inPlay.map((bi) => {
    const board = pack.boards[bi];
    const picks = catPicks(pack, bi);
    if (picks.length !== 5) allFive = false;
    const chips = board.categories.map((c, ci) => {
      const b = h('button', { class: `segbtn ${picks.includes(ci) ? 'on' : ''}`, type: 'button' }, c.name);
      b.onclick = () => {
        const next = picks.includes(ci) ? picks.filter((x) => x !== ci) : [...picks, ci];
        setup.cats = { ...setup.cats, [pack.id]: { ...(setup.cats[pack.id] || {}), [bi]: next.map((i) => board.categories[i].name) } };
        saveSetup(); renderSetup();
      };
      return b;
    });
    return h('div', { class: 'opt' },
      h('span', { class: 'opt-label' }, `Board ${bi + 1} categories `, h('small', { class: picks.length === 5 ? 'ok' : 'bad' }, `${picks.length} of 5 picked`)),
      h('div', { class: 'seg' }, chips));
  }));
  $('startGame').disabled = !allFive;
  const modesOn = Object.values(setup.modes).some((v) => v !== false);
  $('setupNote').textContent = !allFive ? 'Pick exactly 5 categories for each board (in Customise).'
    : `Sparkle ${setup.sparkleEvery && modesOn ? `every ${setup.sparkleEvery} questions` : 'off'} · bonuses ${setup.bonuses ? 'on' : 'off'} · hidden Double ${setup.double ? 'on' : 'off'}`;
}

// Runs on first connect and after every reconnect.
socket.on('connect', () => {
  if (code && secret) socket.emit('host:resume', { code, secret }, gotRoom);
  else render();
});
socket.on('state', (s) => {
  state = s;
  sparkleEndsAt = s.sparkle?.running ? Date.now() + s.sparkle.remaining : null;
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

$('newGame').onclick = openSetup;
$('startGame').onclick = startNewGame;
$('cancelSetup').onclick = () => { setupOpen = false; render(); };
$('themes').onclick = (e) => {
  const b = e.target.closest('[data-pack]');
  if (!b || b.disabled) return;
  setup.packId = b.dataset.pack;
  saveSetup();
  renderSetup();
};
$('resetSetup').onclick = () => { setup = { ...SETUP_DEFAULTS, packId: setup.packId }; saveSetup(); renderSetup(); };
$('finishGame').onclick = () => { if (confirm('Finish the game and show the winner?')) socket.emit('host:screen', 'winner'); };
$('finishBig').onclick = emit('host:screen', 'winner');
$('winnerBack').onclick = emit('host:screen', 'board');
$('winnerNew').onclick = () => { state = null; openSetup(); };
$('nextBoard').onclick = () => socket.emit('host:switchBoard', 1);
$('trap').onclick = emit('host:trap');
// Hold to peek: shows the answer (and trap answer) only while the button is held down.
const peek = (on) => show('peekBox', on && !!state?.current);
$('peek').onpointerdown = (e) => { e.preventDefault(); peek(true); };
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) $('peek').addEventListener(ev, () => peek(false));
$('pinGo').onclick = startNewGame;
$('pin').onkeydown = (e) => { if (e.key === 'Enter') startNewGame(); };
$('makeTeams').onclick = () => socket.emit('host:makeTeams', Number($('teamCount').value));
$('toBoard').onclick = emit('host:screen', 'board');
$('startBig').onclick = openSetup;
$('toLobby').onclick = emit('host:screen', 'lobby');
$('toSparkle').onclick = emit('host:screen', 'sparkle');
$('switchBoard').onclick = () => {
  const to = state.boardNo === 0 ? 1 : 0;
  if (to === 1 && !state.boardDone && !confirm(`Board 1 isn't finished. Jump to Board 2 anyway? You can come back.`)) return;
  socket.emit('host:switchBoard', to);
};
$('teams').onchange = (e) => {
  if (e.target.dataset.player) socket.emit('host:movePlayer', { playerId: e.target.dataset.player, teamId: Number(e.target.value) });
};
$('grid').onclick = (e) => {
  const t = e.target.closest('[data-cat]');
  if (t && !t.disabled) socket.emit('host:pickTile', { cat: Number(t.dataset.cat), idx: Number(t.dataset.idx) });
};

// Question
$('openBuzzers').onclick = emit('host:openBuzzers');
$('correct').onclick = emit('host:correct');
$('wrong').onclick = emit('host:wrong');
$('showAnswer').onclick = emit('host:showAnswer');
$('backToBoard').onclick = emit('host:backToBoard');
$('funnyRow').onclick = (e) => {
  const b = e.target.closest('[data-funny]');
  if (b) socket.emit('host:funny', Number(b.dataset.funny));
};

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
  if (b) socket.emit('host:sparkleTeam', Number(b.dataset.team));
};
$('spModes').onclick = (e) => {
  const b = e.target.closest('[data-mode]');
  if (b && !b.disabled) socket.emit('host:sparkleMode', b.dataset.mode);
};
$('spLevels').onclick = (e) => {
  const b = e.target.closest('[data-level]');
  if (b && !b.disabled) socket.emit('host:sparkleLevel', b.dataset.level);
};
$('spGuessed').onclick = emit('host:sparkleGuessed');
$('spPlayers').onclick = (e) => {
  const b = e.target.closest('[data-player]');
  if (b) socket.emit('host:sparklePerformer', b.dataset.player);
};
$('spCard').onclick = (e) => {
  const b = e.target.closest('[data-points]');
  if (b) socket.emit('host:sparklePoints', Number(b.dataset.points));
};
$('spCustomGive').onclick = () => {
  const n = Math.round(Number($('spCustom').value));
  if ($('spCustom').value === '' || !Number.isFinite(n)) return $('spCustom').focus();
  socket.emit('host:sparklePoints', n);
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

$('mute').onclick = () => { fx.setMuted(!fx.muted); $('mute').textContent = fx.muted ? '🔇' : '🔊'; };
$('mute').textContent = fx.muted ? '🔇' : '🔊';

$('scores').onclick = (e) => {
  const b = e.target.closest('[data-delta]');
  if (b) socket.emit('host:adjustScore', { teamId: Number(b.dataset.team), delta: Number(b.dataset.delta) });
};

function render() {
  const screen = setupOpen ? 'setup' : !state ? 'start' : state.current ? 'question' : state.bonus ? 'bonus' : state.screen;
  for (const s of ['start', 'setup', 'lobby', 'board', 'question', 'bonus', 'sparkle', 'winner']) show(s, s === screen);
  show('toLobby', screen === 'board');
  show('toSparkle', screen === 'board' && !!state?.settings?.sparkleEvery);
  show('finishGame', screen === 'board');
  show('switchBoard', screen === 'board' && state?.boardCount > 1);
  show('cancelSetup', !!state);
  if (state) $('switchBoard').textContent = state.boardNo === 0 ? 'Board 2 →' : '← Board 1';
  if (screen === 'setup') renderSetup();
  show('scores', ['board', 'question', 'bonus', 'sparkle'].includes(screen));
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
  show('toBoard', hasTeams);
  if (hasTeams) $('teamCount').value = state.teams.length;

  const chip = (p) => h('span', { class: `chip ${p.connected ? '' : 'off'} ${seen.has(p.id) ? '' : 'pop'}` }, p.name);
  const unassigned = state.players.filter((p) => p.teamId == null).map(chip);
  fill('unassigned', unassigned.length ? unassigned : hasTeams ? [] : h('p', { class: 'muted' }, 'Waiting for players to join…'));

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
  const cells = state.board.map((c) => h('div', { class: 'cat' }, c.category));
  for (let i = 0; i < rows; i++) {
    state.board.forEach((c, ci) => {
      if (c.values[i] == null) return cells.push(h('div'));
      const used = state.used.includes(`${ci}-${i}`);
      cells.push(h('button', { class: 'tile', vars: { '--i': i + ci }, data: { cat: ci, idx: i }, disabled: used }, c.values[i]));
    });
  }
  fill('grid', cells);

  // ---- Question ----
  const q = state.current;
  if (q) {
    $('qCategory').textContent = `${q.category} — ${q.value}`;
    $('qNote').textContent = q.note || '';
    $('qText').textContent = q.question;
    $('qText').classList.toggle('long', q.question.length > 160); // wordy questions get smaller text
    $('qText').classList.toggle('xlong', q.question.length > 380); // really wordy ones get smaller still
    $('qAnswer').textContent = q.answer;
    show('qAnswer', state.showAnswer);
    show('qDouble', !!q.double);
    $('qCategory').textContent = `${q.category} — ${q.double ? q.value * 2 : q.value}${q.double ? ' (Double!)' : ''}`;
    // After the reveal: the trap answer with a big ❌, and the fun fact.
    $('qTrap').textContent = q.trapAnswer ? `❌ Not "${q.trapAnswer}"` : '';
    show('qTrap', state.showAnswer && !!q.trapAnswer);
    fill('qFact', q.funFact ? [h('b', {}, '💡 Did you know? '), q.funFact] : []);
    show('qFact', state.showAnswer && !!q.funFact);
    show('trap', !!q.trapAnswer);
    fill('peekBox', h('b', {}, 'Answer: '), q.answer, q.trapAnswer ? h('span', { class: 'muted' }, `   ·   Trap: ${q.trapAnswer}`) : null);

    const b = state.buzz;
    const turn = b.order.find((e) => !b.locked.includes(e.teamId));
    $('buzzBadge').textContent = b.open ? 'Buzzers OPEN' : 'Closed';
    $('buzzBadge').className = 'badge ' + (b.open ? 'open' : 'closed');
    $('openBuzzers').disabled = b.open;
    $('correct').disabled = $('wrong').disabled = $('trap').disabled = !turn;
    fill('funnyRow', state.teams.map((t) =>
      h('button', { class: 'funny', vars: { '--c': t.color }, data: { funny: t.id } }, `😂 +5 ${t.name}`)));
    const order = b.order.map((e) => {
      const t = teamOf(e.teamId);
      const cls = b.locked.includes(e.teamId) ? 'locked' : e === turn ? 'turn' : '';
      return h('li', { class: cls }, h('span', { color: t?.color }, t?.name || '?'), ` — ${playerOf(e.playerId)?.name || '?'}`);
    });
    fill('order', order.length ? order : b.open ? h('p', { class: 'muted' }, 'Waiting for a buzz…') : []);
  }

  // ---- Bonus ----
  if (state.bonus) {
    const t = teamOf(state.bonus.teamId);
    fill('bonusFor', '⭐ BONUS for ', h('span', { color: t?.color }, t?.name || '?'), ':');
    $('bonusText').textContent = state.bonus.text;
    $('bonusDone').textContent = `Bonus done +${state.bonus.points}`;
  }

  // ---- Sparkle Round ----
  const sp = state.sparkle;
  if (screen === 'sparkle' && sp) {
    const team = teamOf(sp.teamId);
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
      h('div', {},
        h('button', { class: 'secondary', data: { team: t.id, delta: -100 } }, '−'), ' ',
        h('button', { class: 'secondary', data: { team: t.id, delta: 100 } }, '+')))));

  effects(screen, oldPts);
}

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
    traps: state?.current?.traps || 0,
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
    if (screen === 'bonus') fx.play('reveal');
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
  // Someone fell into the trap.
  if (screen === 'question' && prev.key === p.key && prev.traps > p.traps) {
    fx.play('trap');
    fx.banner('🚨 TRAP! 🚨', 'trap');
    fx.replay(document.body, 'redflash');
  }
  if (screen === 'winner' && p.screen !== 'winner') { fx.play('winner'); fx.emojiRain(); }

  if (screen === 'question' && prev.key === p.key) {
    if (prev.open && !p.open) fx.play('open');
    if (prev.order > p.order) {
      fx.play('buzz');
      [...$('order').children].slice(p.order).forEach((li) => li.classList.add('pop'));
    }
    if (prev.locked > p.locked && prev.traps === p.traps) { fx.play('wrong'); fx.replay($('qText'), 'shake'); fx.replay(document.body, 'redflash'); }
    if (prev.showAnswer && !p.showAnswer) fx.play('reveal');
  }
  if (screen === 'bonus' && p.screen === 'question') fx.play('correct');
  if (screen !== 'question' && p.screen === 'question' && screen !== 'bonus' && state.teams.some((t) => Number(oldPts.get(String(t.id))) < t.score)) fx.play('correct');
  if (screen === 'sparkle' && prev.card && !p.card) fx.replay($('spCard'), 'enter');

  if (screen === 'lobby' && state.players.some((x) => !p.players.has(x.id))) fx.play('open');
}
