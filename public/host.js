const socket = io();
const $ = (id) => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle('hidden', !on);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const emit = (ev, data) => () => socket.emit(ev, data);

function load(k) { try { return localStorage.getItem(k); } catch { return null; } }
function save(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }

let code = load('fbHostCode');
let qr = null;
let state = null;
let sparkleEndsAt = null; // local clock time when the timer runs out (only while running)
let prev = null; // what the last render showed, so effects only fire on changes
let lastSecs = null;
const seen = new Set(); // players already shown, so only new ones pop in

const MODES = {
  draw: { label: '🎨 Draw (Diwali)', doing: 'is drawing…' },
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
  if (!res.ok) {
    if (res.error) alert(res.error);
    code = null; save('fbHostCode', null); state = null; render(); return;
  }
  code = res.code;
  qr = res.qr;
  save('fbHostCode', code);
}

// Runs on first connect and after every reconnect.
socket.on('connect', () => {
  if (code) socket.emit('host:resume', code, gotRoom);
  else render();
});
socket.on('state', (s) => {
  state = s;
  sparkleEndsAt = s.sparkle?.running ? Date.now() + s.sparkle.remaining : null;
  render();
});

// Quick "+5 😂" flash next to a team's score.
socket.on('flash', ({ teamId, text }) => {
  const box = document.querySelector(`.score[data-score-team="${teamId}"]`);
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

$('newGame').onclick = () => {
  if (state && !confirm('Start a new game? The current game will be left behind.')) return;
  socket.emit('host:new', gotRoom);
};
$('makeTeams').onclick = () => socket.emit('host:makeTeams', Number($('teamCount').value));
$('toBoard').onclick = emit('host:screen', 'board');
$('startBig').onclick = () => $('newGame').click();
$('toLobby').onclick = emit('host:screen', 'lobby');
$('toSparkle').onclick = emit('host:screen', 'sparkle');
$('switchBoard').onclick = () => socket.emit('host:switchBoard', state.boardNo === 0 ? 1 : 0);
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
  const screen = !state ? 'start' : state.current ? 'question' : state.bonus ? 'bonus' : state.screen;
  for (const s of ['start', 'lobby', 'board', 'question', 'bonus', 'sparkle']) show(s, s === screen);
  show('toLobby', screen === 'board');
  show('toSparkle', screen === 'board');
  show('switchBoard', screen === 'board' && state?.boardCount > 1);
  if (state) $('switchBoard').textContent = state.boardNo === 0 ? 'Board 2 →' : '← Board 1';
  show('scores', ['board', 'question', 'bonus', 'sparkle'].includes(screen));
  if (!state) return;

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

  const chip = (p) => `<span class="chip ${p.connected ? '' : 'off'} ${seen.has(p.id) ? '' : 'pop'}">${esc(p.name)}</span>`;
  $('unassigned').innerHTML = state.players.filter((p) => p.teamId == null).map(chip).join('') ||
    (hasTeams ? '' : '<p class="muted">Waiting for players to join…</p>');

  $('teams').innerHTML = state.teams.map((t) => {
    const items = state.players.filter((p) => p.teamId === t.id).map((p) => `
      <li class="${p.connected ? '' : 'off'} ${seen.has(p.id) ? '' : 'pop'}">${esc(p.name)}
        <select data-player="${esc(p.id)}" title="Move to team">
          ${state.teams.map((o) => `<option value="${o.id}" ${o.id === t.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
        </select>
      </li>`).join('');
    return `<div class="team" style="--c:${t.color}"><h3>${esc(t.name)}</h3><ul>${items || '<li class="muted">nobody yet</li>'}</ul></div>`;
  }).join('');

  // ---- Board ----
  $('grid').style.gridTemplateColumns = `repeat(${state.board.length}, 1fr)`;
  const rows = Math.max(...state.board.map((c) => c.values.length));
  let html = state.board.map((c) => `<div class="cat">${esc(c.category)}</div>`).join('');
  for (let i = 0; i < rows; i++) {
    html += state.board.map((c, ci) => {
      if (c.values[i] == null) return '<div></div>';
      const used = state.used.includes(`${ci}-${i}`);
      return `<button class="tile" style="--i:${i + ci}" data-cat="${ci}" data-idx="${i}" ${used ? 'disabled' : ''}>${c.values[i]}</button>`;
    }).join('');
  }
  $('grid').innerHTML = html;

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

    const b = state.buzz;
    const turn = b.order.find((e) => !b.locked.includes(e.teamId));
    $('buzzBadge').textContent = b.open ? 'Buzzers OPEN' : 'Closed';
    $('buzzBadge').className = 'badge ' + (b.open ? 'open' : 'closed');
    $('openBuzzers').disabled = b.open;
    $('correct').disabled = $('wrong').disabled = !turn;
    $('funnyRow').innerHTML = state.teams.map((t) =>
      `<button class="funny" style="--c:${t.color}" data-funny="${t.id}">😂 +5 ${esc(t.name)}</button>`).join('');
    $('order').innerHTML = b.order.map((e) => {
      const t = teamOf(e.teamId);
      const cls = b.locked.includes(e.teamId) ? 'locked' : e === turn ? 'turn' : '';
      return `<li class="${cls}"><span style="color:${t?.color}">${esc(t?.name || '?')}</span> — ${esc(playerOf(e.playerId)?.name || '?')}</li>`;
    }).join('') || (b.open ? '<p class="muted">Waiting for a buzz…</p>' : '');
  }

  // ---- Bonus ----
  if (state.bonus) {
    const t = teamOf(state.bonus.teamId);
    $('bonusFor').innerHTML = `⭐ BONUS for <span style="color:${t?.color}">${esc(t?.name || '?')}</span>:`;
    $('bonusText').textContent = state.bonus.text;
    $('bonusDone').textContent = `Bonus done +${state.bonus.points}`;
  }

  // ---- Sparkle Round ----
  const sp = state.sparkle;
  if (screen === 'sparkle' && sp) {
    const team = teamOf(sp.teamId);
    show('spSetup', !sp.hasCard);
    show('spCard', sp.hasCard);

    $('spTeams').innerHTML = state.teams.map((t) =>
      `<button class="pick ${sp.teamId === t.id ? 'selected' : ''}" style="--c:${t.color}" data-team="${t.id}">${esc(t.name)}</button>`).join('');
    $('spModes').innerHTML = Object.entries(MODES).map(([m, info]) =>
      `<button class="pick ${sp.mode === m ? 'selected' : ''}" data-mode="${m}" ${cardsLeft(m) ? '' : 'disabled'}>${info.label} <small>(${cardsLeft(m)} left)</small></button>`).join('');

    const isDraw = sp.mode === 'draw';
    show('spLevelStep', isDraw);
    $('spLevels').innerHTML = Object.entries(LEVELS).map(([l, info]) =>
      `<button class="pick ${sp.level === l ? 'selected' : ''}" data-level="${l}" ${cardsLeft('draw', l) ? '' : 'disabled'}>${info.label} (${info.points}) <small>(${cardsLeft('draw', l)} left)</small></button>`).join('');

    show('spPerformerStep', !!team && !!sp.mode && (!isDraw || !!sp.level));
    show('spEmpty', sp.empty);
    if (team) {
      $('spPerformerPrompt').textContent = `${sp.mode === 'draw' ? 4 : 3}. ${team.name}, choose your performer (tap their name):`;
      $('spPlayers').innerHTML = state.players.filter((p) => p.teamId === team.id).map((p) =>
        `<button class="pick" style="--c:${team.color}" data-player="${esc(p.id)}">${esc(p.name)}</button>`).join('') ||
        '<span class="muted">This team has no players.</span>';
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

  // ---- Scores ----
  const oldPts = new Map([...document.querySelectorAll('.score')].map((el) => [el.dataset.scoreTeam, el.dataset.pts]));
  $('scores').innerHTML = state.teams.map((t) => `
    <div class="score" data-score-team="${t.id}" data-pts="${t.score}" style="--c:${t.color}">
      <div class="score-name">${esc(t.name)}</div>
      <div class="score-pts">${t.score}</div>
      <div><button class="secondary" data-team="${t.id}" data-delta="-100">−</button>
           <button class="secondary" data-team="${t.id}" data-delta="100">+</button></div>
    </div>`).join('');

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

  if (screen === 'question' && prev.key === p.key) {
    if (prev.open && !p.open) fx.play('open');
    if (prev.order > p.order) {
      fx.play('buzz');
      [...$('order').children].slice(p.order).forEach((li) => li.classList.add('pop'));
    }
    if (prev.locked > p.locked) { fx.play('wrong'); fx.replay($('qText'), 'shake'); fx.replay(document.body, 'redflash'); }
    if (prev.showAnswer && !p.showAnswer) fx.play('reveal');
  }
  if (screen === 'bonus' && p.screen === 'question') fx.play('correct');
  if (screen !== 'question' && p.screen === 'question' && screen !== 'bonus' && state.teams.some((t) => Number(oldPts.get(String(t.id))) < t.score)) fx.play('correct');
  if (screen === 'sparkle' && prev.card && !p.card) fx.replay($('spCard'), 'enter');

  if (screen === 'lobby' && state.players.some((x) => !p.players.has(x.id))) fx.play('open');
}
