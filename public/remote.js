// BuzzIn host remote: the host runs the game from their phone, privately.
// Pairing: the TV shows a QR with /remote#pair=<code>. This page claims the code, then waits until
// the host clicks Allow on the TV. The server then gives this phone its own remote token.
const socket = io();
const $ = (id) => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle('hidden', !on);

// Builds an element. All text goes in as text nodes, never as HTML.
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'vars') for (const [name, val] of Object.entries(v)) el.style.setProperty(name, val);
    else if (k === 'color') el.style.color = v;
    else if (k === 'disabled') el.disabled = true;
    else if (k === 'onTap') el.addEventListener('click', v);
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat(Infinity).filter((x) => x != null && x !== false).map((x) => (typeof x === 'number' ? String(x) : x)));
  return el;
}
const fill = (id, ...kids) => $(id).replaceChildren(...kids.flat(Infinity).filter((x) => x != null && x !== false));
const btn = (label, onTap, props = {}) => h('button', { type: 'button', ...props, onTap }, label);

function load() { try { return JSON.parse(localStorage.getItem('fbRemote') || 'null'); } catch { return null; } }
function save(v) { try { v ? localStorage.setItem('fbRemote', JSON.stringify(v)) : localStorage.removeItem('fbRemote'); } catch {} }

let saved = load(); // { code, token } once paired
let state = null; // the host view (with answers): only ever sent to a paired remote
let secret = null; // the Sparkle secret word, so the host can judge
let sparkleEndsAt = null;
let lastOrder = 0;
let gone = false; // revoked or ended: stop trying

// The pairing code comes after # so it's never sent to the server in a page request.
const pairCode = new URLSearchParams(location.hash.slice(1)).get('pair');
if (pairCode) history.replaceState(null, '', '/remote'); // out of the address bar (and history) at once

const MODES = { draw: '🎨 Draw', charades: '🤐 Dumb Charades', mimic: '🎭 Mimic' };
const LEVELS = { easy: ['🌶️ Easy', 50], medium: ['🌶️🌶️ Medium', 100], tricky: ['🌶️🌶️🌶️ Tricky', 200] };

// A game action, with the state version (so a double tap from the TV and this phone counts once).
const act = (ev, data) => socket.emit(ev, data, state?.version);

function message(text, big = '') {
  fill('rMessage', big ? h('div', { class: 'r-msg-big' }, big) : null, h('p', {}, text));
  show('rMessage', true);
  show('rGame', false);
  setMenu(false);
  document.querySelector('.menu-wrap').classList.add('hidden'); // nothing to control yet (or any more)
}
function disconnected(text = 'This remote was disconnected. Scan the QR on the TV again.') {
  gone = true;
  save(null);
  state = null;
  socket.io.reconnection(false);
  socket.disconnect();
  message(text, '📱');
}

// ---- Connecting ----
// Scanning a new QR while this page is open only changes the #hash, so start over with the new code.
window.addEventListener('hashchange', () => { if (location.hash.startsWith('#pair=')) location.reload(); });
let claimed = false;
socket.on('connect', () => {
  if (gone) return;
  if (pairCode && !claimed) {
    claimed = true;
    message('Waiting for the host to tap Allow on the TV…', '⏳');
    socket.emit('remote:pair', pairCode, (res) => { if (!res?.ok) disconnected(res?.error || 'That pairing code didn\'t work. Tap 📱 on the TV for a new one.'); });
  } else if (saved) {
    socket.emit('remote:resume', saved, (res) => { if (!res?.ok) disconnected(); });
  } else if (!claimed) {
    message('Open this page by scanning the 📱 remote QR code on the TV.', '📱');
  }
});
socket.on('paired', ({ code, token }) => { saved = { code, token }; save(saved); });
socket.on('pairDenied', () => disconnected('The host didn\'t allow this phone.'));
socket.on('revoked', () => disconnected());
socket.on('disconnect', () => { if (!gone && state) $('rRoom').textContent = '📶 Reconnecting…'; });
socket.on('secret', (word) => { secret = word; render(); });
socket.on('state', (s) => {
  if (gone) return;
  state = s;
  sparkleEndsAt = s.sparkle?.running ? Date.now() + s.sparkle.remaining : null;
  render();
});

// Wake up: reconnect right away, and keep the screen on while the remote is open (HTTPS only).
let wakeLock = null;
async function keepAwake() {
  try { if (document.visibilityState === 'visible' && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || gone) return;
  if (!socket.connected) socket.connect();
  keepAwake();
});
keepAwake();

// ---- Menu ----
const setMenu = (open) => { show('rMenu', open); $('rMenuBtn').setAttribute('aria-expanded', String(open)); };
$('rMenuBtn').onclick = (e) => { e.stopPropagation(); setMenu($('rMenu').classList.contains('hidden')); };
document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) setMenu(false); });
$('rSwitch').onclick = () => { setMenu(false); act('host:switchBoard', state.boardNo === 0 ? 1 : 0); };
$('rSparkle').onclick = () => { setMenu(false); act('host:screen', 'sparkle'); };
$('rLobby').onclick = () => { setMenu(false); act('host:screen', 'lobby'); };
$('rEnd').onclick = () => { setMenu(false); if (confirm('End the game and show the winner on the TV?')) act('host:screen', 'winner'); };
$('rLeave').onclick = () => {
  setMenu(false);
  if (!confirm('Disconnect this remote? The TV gets its controls back.')) return;
  socket.emit('remote:leave');
  disconnected('This remote is disconnected. Tap 📱 on the TV to pair again.');
};

// ---- Screens ----
function render() {
  if (!state || gone) return;
  show('rMessage', false);
  show('rGame', true);
  document.querySelector('.menu-wrap').classList.remove('hidden');
  $('rRoom').textContent = `Room ${state.code}`;
  const screen = state.current ? 'question' : state.reveal ? 'reveal' : state.bonus ? 'bonus' : state.screen;
  const free = !state.current && !state.reveal && !state.bonus;
  show('rSwitch', free && state.boardCount > 1 && screen !== 'winner');
  $('rSwitch').textContent = state.boardNo === 0 ? 'Board 2 →' : '← Board 1';
  show('rSparkle', free && screen === 'board' && !!state.settings?.sparkleEvery);
  show('rLobby', free && screen !== 'lobby');
  show('rEnd', free && screen !== 'winner');

  // Scores, always: tap − / + to fix mistakes.
  fill('rScores', state.teams.map((t) => h('div', { class: 'r-score', vars: { '--c': t.color } },
    h('div', { class: 'r-score-name' }, t.name),
    h('div', { class: 'r-score-row' },
      btn('−', () => act('host:adjustScore', { teamId: t.id, delta: -100 }), { class: 'secondary' }),
      h('b', {}, t.score),
      btn('+', () => act('host:adjustScore', { teamId: t.id, delta: 100 }), { class: 'secondary' })))));

  const teamOf = (id) => state.teams.find((t) => t.id === id);
  const playerOf = (id) => state.players.find((p) => p.id === id);
  const stage = { lobby, board, question, reveal, bonus, sparkle, winner }[screen];
  fill('rStage', stage ? stage(teamOf, playerOf) : h('p', { class: 'muted' }, 'Waiting…'));
  if (screen !== 'sparkle') secret = null;
}

function lobby() {
  const hasTeams = state.teams.length > 0;
  const count = h('select', { 'aria-label': 'How many teams' }, [2, 3, 4].map((n) => h('option', { value: n, ...(n === (state.teams.length || 2) ? { selected: 'selected' } : {}) }, `${n} teams`)));
  const waiting = state.players.filter((p) => p.teamId == null);
  return [
    h('h2', {}, 'Lobby'),
    h('p', { class: 'muted' }, `${state.players.length} player${state.players.length === 1 ? '' : 's'} joined`),
    h('div', { class: 'r-row' }, count,
      btn(hasTeams ? 'Reshuffle teams' : 'Make random teams', () => act('host:makeTeams', Number(count.value)), { class: hasTeams ? 'secondary' : '' })),
    hasTeams && waiting.length ? [h('h3', {}, 'Waiting for a team'), waiting.map((p) => h('div', { class: 'r-wait' },
      h('b', {}, p.name), h('div', { class: 'r-row' }, state.teams.map((t) =>
        btn(t.name, () => act('host:movePlayer', { playerId: p.id, teamId: t.id }), { class: 'pick', vars: { '--c': t.color } })))))] : null,
    hasTeams ? state.teams.map((t) => h('div', { class: 'r-team', vars: { '--c': t.color } }, h('b', {}, t.name), ' ',
      h('span', { class: 'muted' }, state.players.filter((p) => p.teamId === t.id).map((p) => p.name).join(', ') || 'nobody yet'))) : null,
    hasTeams ? btn('Go to the board →', () => act('host:screen', 'board'), { class: 'r-big' }) : null,
  ];
}

function board() {
  const cols = state.board.length;
  const grid = h('div', { class: 'r-grid', vars: { '--cols': cols } },
    state.board.map((c) => h('div', { class: 'r-cat' }, c.category)));
  for (let i = 0; i < 5; i++) state.board.forEach((c, ci) => {
    const used = state.used.includes(`${ci}-${i}`);
    grid.append(c.values[i] == null ? h('div') : btn(c.values[i], () => act('host:pickTile', { cat: ci, idx: i }), { class: 'r-tile', disabled: used }));
  });
  return [
    h('div', { class: 'muted r-sub' }, `${state.boardCount > 1 ? `Board ${state.boardNo + 1}: ` : ''}${state.boardNames?.[state.boardNo] || ''}`),
    grid,
    state.boardDone ? h('div', { class: 'r-row' },
      state.boardNo < state.boardCount - 1 ? btn('Play Board 2 →', () => act('host:switchBoard', 1), { class: 'r-big' }) : null,
      btn('🏆 Show the winner', () => act('host:screen', 'winner'), { class: 'r-big secondary' })) : null,
  ];
}

function question(teamOf, playerOf) {
  const q = state.current;
  const b = state.buzz;
  const turn = b.order.find((e) => !b.locked.includes(e.teamId));
  // First buzz: buzz the host's phone too.
  if (b.order.length && !lastOrder) { try { navigator.vibrate?.(120); } catch {} }
  lastOrder = b.order.length;
  const pts = q.double ? q.value * 2 : q.value;
  return [
    h('div', { class: 'r-sub' }, h('b', {}, q.category), ` · ${pts}${q.double ? ' 💥 DOUBLE' : ''}`),
    // Only on the remote: the answer and the fun fact.
    h('div', { class: 'r-answer' }, h('div', { class: 'r-label' }, 'Answer (only you can see this)'), h('div', { class: 'r-answer-text' }, q.answer),
      q.funFact ? h('div', { class: 'r-fact' }, '💡 ', q.funFact) : null),
    h('p', { class: 'r-q' }, q.question),
    b.open ? h('div', { class: 'badge open' }, 'Buzzers OPEN') : btn('Open buzzers', () => act('host:openBuzzers'), { class: 'r-big' }),
    b.order.length ? h('ol', { class: 'r-order' }, b.order.map((e) => {
      const t = teamOf(e.teamId);
      return h('li', { class: b.locked.includes(e.teamId) ? 'locked' : e === turn ? 'turn' : '' }, h('b', { color: t?.color }, t?.name || '?'), ` — ${playerOf(e.playerId)?.name || '?'}`);
    })) : b.open ? h('p', { class: 'muted' }, 'Waiting for a buzz…') : null,
    h('div', { class: 'r-two' },
      btn(turn ? `✅ Correct (${teamOf(turn.teamId)?.name})` : '✅ Correct', () => act('host:correct'), { class: 'good', disabled: !turn }),
      btn('❌ Wrong', () => act('host:wrong'), { class: 'bad', disabled: !turn })),
    h('div', { class: 'r-two' },
      btn('Reveal answer on TV', () => act('host:showAnswer'), { class: 'secondary' }),
      btn('Back to board', () => act('host:backToBoard'), { class: 'secondary' })),
    h('div', { class: 'r-row r-funny' }, state.teams.map((t) =>
      btn(`😂 +5 ${t.name}`, () => act('host:funny', t.id), { class: 'funny', vars: { '--c': t.color } }))),
  ];
}

function reveal(teamOf) {
  lastOrder = 0;
  const r = state.reveal;
  const t = teamOf(r.teamId);
  return [
    h('div', { class: 'r-sub' }, t ? h('span', {}, h('b', { color: t.color }, t.name), ` got it! +${r.points}`) : 'Nobody got this one'),
    h('div', { class: 'r-answer' }, h('div', { class: 'r-answer-text' }, r.answer), r.funFact ? h('div', { class: 'r-fact' }, '💡 ', r.funFact) : null),
    btn(r.bonus ? 'Next: bonus →' : 'Back to board →', () => act('host:revealNext'), { class: 'r-big' }),
  ];
}

function bonus(teamOf) {
  const b = state.bonus;
  const t = teamOf(b.teamId);
  return [
    h('div', { class: 'r-sub' }, '⭐ Bonus for ', h('b', { color: t?.color }, t?.name || '?')),
    h('p', { class: 'r-q' }, b.text),
    btn(`Bonus done +${b.points}`, () => act('host:bonus', true), { class: 'r-big' }),
    btn('Skip bonus', () => act('host:bonus', false), { class: 'r-big secondary' }),
  ];
}

function sparkle(teamOf, playerOf) {
  const sp = state.sparkle;
  if (!sp) return h('p', { class: 'muted' }, 'Sparkle Round');
  const team = teamOf(sp.teamId);
  const left = (m, l) => (m === 'draw' ? (l ? state.deckLeft[`draw:${l}`] : Object.keys(LEVELS).reduce((n, x) => n + state.deckLeft[`draw:${x}`], 0)) : state.deckLeft[m]);
  const out = [h('h2', { class: 'sparkle-title' }, '✨ Sparkle Round')];
  if (!sp.hasCard) {
    out.push(h('h3', {}, '1. Which team?'), h('div', { class: 'r-row' }, state.teams.map((t) =>
      btn(t.name, () => act('host:sparkleTeam', t.id), { class: `pick ${sp.teamId === t.id ? 'selected' : ''}`, vars: { '--c': t.color } }))));
    out.push(h('h3', {}, '2. Which game?'), h('div', { class: 'r-row' }, Object.entries(MODES).filter(([m]) => state.settings.modes.includes(m)).map(([m, label]) =>
      btn(`${label} (${left(m)})`, () => act('host:sparkleMode', m), { class: `pick ${sp.mode === m ? 'selected' : ''}`, disabled: !left(m) }))));
    if (sp.mode === 'draw') out.push(h('h3', {}, '3. How hard?'), h('div', { class: 'r-row' }, Object.entries(LEVELS).map(([l, [label, p]]) =>
      btn(`${label} ${p}`, () => act('host:sparkleLevel', l), { class: `pick ${sp.level === l ? 'selected' : ''}`, disabled: !left('draw', l) }))));
    if (team && sp.mode && (sp.mode !== 'draw' || sp.level)) {
      const players = state.players.filter((p) => p.teamId === team.id);
      out.push(h('h3', {}, `${sp.mode === 'draw' ? 4 : 3}. Who performs?`), h('div', { class: 'r-row' }, players.length
        ? players.map((p) => btn(p.name, () => act('host:sparklePerformer', p.id), { class: 'pick', vars: { '--c': team.color } }))
        : h('span', { class: 'muted' }, 'This team has no players.')));
    }
    if (sp.empty) out.push(h('p', { class: 'muted' }, 'No cards left in this game. Pick another.'));
  } else {
    const performer = playerOf(sp.performerId);
    out.push(
      h('div', { class: 'r-sub' }, `${MODES[sp.mode]} · ${performer?.name || '?'} (${team?.name || '?'})`),
      h('div', { class: 'r-answer' }, h('div', { class: 'r-label' }, sp.mode === 'mimic' ? 'The prompt' : 'Secret (only you and the performer see this)'),
        h('div', { class: 'r-answer-text' }, sp.mode === 'mimic' ? sp.text : secret || '…')),
      h('div', { id: 'rTimer', class: 'timer' }),
      h('div', { class: 'r-two' },
        btn('▶ Start timer', () => act('host:timer', 'start'), { disabled: sp.running }),
        btn('⏸ Stop', () => act('host:timer', 'stop'), { class: 'secondary', disabled: !sp.running })));
    if (sp.mode === 'draw') out.push(btn(`🎉 Guessed! +${sp.points}`, () => act('host:sparkleGuessed'), { class: 'r-big good' }));
    else out.push(h('div', { class: 'r-row' }, [25, 50, 100].map((p) => btn(`+${p}`, () => act('host:sparklePoints', p)))));
    const custom = h('input', { type: 'number', step: '5', placeholder: 'other', inputmode: 'numeric', 'aria-label': 'Other points' });
    out.push(h('div', { class: 'r-row' }, custom,
      btn('Give', () => { const n = Math.round(Number(custom.value)); if (custom.value !== '' && Number.isFinite(n)) act('host:sparklePoints', n); }, { class: 'secondary' }),
      btn('No points', () => act('host:sparklePoints', 0), { class: 'secondary' }),
      btn('Skip card', () => act('host:skipCard'), { class: 'secondary', disabled: !left(sp.mode, sp.level) })));
  }
  out.push(btn('Back to board', () => act('host:screen', 'board'), { class: 'secondary r-big' }));
  setTimeout(tickTimer);
  return out;
}

function winner() {
  const ranked = [...state.teams].sort((a, b) => b.score - a.score);
  return [
    h('h2', {}, '🏆 Final scores'),
    h('ol', { class: 'r-order' }, ranked.map((t) => h('li', {}, h('b', { color: t.color }, t.name), ` — ${t.score}`))),
    btn('← Back to the board', () => act('host:screen', 'board'), { class: 'secondary r-big' }),
  ];
}

function tickTimer() {
  const sp = state?.sparkle;
  const el = $('rTimer');
  if (!sp?.hasCard || !el) return;
  const ms = sparkleEndsAt != null ? sparkleEndsAt - Date.now() : sp.remaining;
  const secs = Math.max(0, Math.ceil(ms / 1000));
  el.textContent = secs > 0 ? `⏱ ${secs}${sp.running ? '' : ' (paused)'}` : "⏱ Time's up!";
}
setInterval(tickTimer, 250);
