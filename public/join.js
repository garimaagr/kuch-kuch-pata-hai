const socket = io();
const $ = (id) => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle('hidden', !on);

function load(k) { try { return localStorage.getItem(k); } catch { return null; } }
function save(k, v) { try { localStorage.setItem(k, v); } catch {} }

const code = (location.pathname.split('/')[2] || '').toUpperCase();
let playerId = load('fbPlayerId');
if (!playerId) {
  playerId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  save('fbPlayerId', playerId);
}
let name = load('fbName');
let joined = false;
let error = null;
let state = null;
let secret = null; // the movie title, sent only to the performer's phone
let sparkleEndsAt = null;
const SECRET_MODES = ['draw', 'charades'];
let lastMsg = null;
let nhEndsAt = null; // No host: when the server's next step happens (local clock)
let nhAnswer = null; // No host: the answer, sent only to this phone while it's judging its own buzz
let nhSent = null; // what this phone already sent for the current step (so buttons show it)
let ended = null; // set when the host ends this game

function join() {
  socket.emit('player:join', { code, playerId, name }, (res) => {
    joined = res.ok;
    error = res.ok ? null : res.error;
    render();
  });
}

// Which game is this link for? Shown above the name box.
let game = null; // { packName, packEmoji } or { missing: true }
const setTop = (main, sub = '') => { $('topName').textContent = main; $('topTeam').textContent = sub; };

// Runs on first connect and after every reconnect, so a dropped phone rejoins as the same person.
socket.on('connect', () => {
  socket.emit('player:peek', code, (res) => { game = res?.ok ? res : { missing: true }; render(); });
  if (name) join(); else render();
});
// Socket.IO keeps retrying on its own. Show it, and retry right away when a sleeping phone wakes up.
socket.on('disconnect', () => {
  if (ended) return;
  setTop('📶 Reconnecting…');
  $('buzz').disabled = true;
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !socket.connected && !ended) socket.connect();
});
socket.on('secret', (title) => { secret = title; });
socket.on('nhAnswer', (answer) => { nhAnswer = String(answer || ''); render(); });
// The host started a new game: this one is gone. Show why, and don't keep trying to rejoin it.
socket.on('ended', (message) => {
  ended = String(message || 'This game has ended.');
  socket.io.reconnection(false);
  render();
});
socket.on('state', (s) => {
  state = s;
  sparkleEndsAt = s.sparkle?.running ? Date.now() + s.sparkle.remaining : null;
  nhEndsAt = s.nh?.endsIn != null ? Date.now() + s.nh.endsIn : null;
  const step = s.nh ? `${s.nh.phase}|${s.nh.buzzer}|${s.question}` : null;
  if (step !== nhStep) { nhStep = step; nhSent = null; }
  if (s.nh?.phase !== 'judging') nhAnswer = null;
  render();
});
let nhStep = null;
const nhSecs = () => (nhEndsAt == null ? '' : Math.max(0, Math.ceil((nhEndsAt - Date.now()) / 1000)));
setInterval(() => { if (state?.nh) nhCountText(); }, 250);

function tickTimer() {
  const sp = state?.sparkle;
  if (!sp?.hasCard) return;
  const ms = sparkleEndsAt != null ? sparkleEndsAt - Date.now() : sp.remaining;
  const secs = Math.max(0, Math.ceil(ms / 1000));
  $('spTimer').textContent = secs > 0 ? `⏱ ${secs}` : "⏱ Time's up!";
}
setInterval(tickTimer, 250);

$('nameForm').onsubmit = (e) => {
  e.preventDefault();
  name = $('nameInput').value.trim();
  if (!name) return;
  save('fbName', name);
  join();
};

// No host buttons. The server decides whether each one counts.
const nhSend = (event, data, sent) => { nhSent = sent; socket.emit(event, data); try { navigator.vibrate?.(60); } catch {} render(); };
$('nhGot').onclick = () => nhSend('player:claim', true, 'got');
$('nhMissed').onclick = () => nhSend('player:claim', false, 'missed');
$('nhChallenge').onclick = () => nhSend('player:challenge', null, 'challenge');
$('nhPass').onclick = () => nhSend('player:pass', null, 'pass');
$('nhBoard').onclick = (e) => {
  const b = e.target.closest('[data-cat]');
  if (b && !b.disabled) nhSend('player:pickTile', { cat: Number(b.dataset.cat), idx: Number(b.dataset.idx) }, 'pick');
};
$('nhBonus').onclick = (e) => { const b = e.target.closest('[data-bonus]'); if (b) nhSend('player:bonusVote', b.dataset.bonus === 'up', b.dataset.bonus); };
$('nhGuessed').onclick = () => nhSend('player:guessed', null, 'guessed');
$('nhMimicDone').onclick = () => nhSend('player:mimicDone', null, 'done');
$('nhMimicVote').onclick = (e) => { const b = e.target.closest('[data-mimic]'); if (b) nhSend('player:mimicVote', b.dataset.mimic, b.dataset.mimic); };
$('nhFunny').onclick = (e) => {
  const b = e.target.closest('[data-funny]');
  if (!b) return;
  socket.emit('player:funny', Number(b.dataset.funny));
  try { navigator.vibrate?.(60); } catch {}
};

$('buzz').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if ($('buzz').disabled) return;
  try { navigator.vibrate?.(150); } catch {}
  socket.emit('player:buzz');
});

function render() {
  const me = state?.players.find((p) => p.id === playerId);
  const team = state?.teams.find((t) => t.id === me?.teamId);

  if (ended) {
    show('nameForm', false); show('sparkle', false); show('game', false); show('message', true);
    $('message').textContent = ended;
    setTop('BuzzIn');
    $('top').style.setProperty('--c', '');
    return;
  }
  show('nameForm', !name || (error && !joined));
  if (!name) $('nameInput').value = '';

  // Top bar: who you are, your team and its score.
  if (me) setTop(me.name, team ? `${team.name} · ${team.score} pts` : 'No team yet');
  else setTop('BuzzIn');
  $('top').style.setProperty('--c', team ? team.color : '');
  $('joining').textContent = game?.missing ? 'Game not found. Check the room code.'
    : game ? `Joining ${game.packEmoji ? game.packEmoji + ' ' : ''}${game.packName} · Room ${code}` : `Room ${code}`;

  if (error) { show('message', true); $('message').textContent = error; show('game', false); return; }
  if (!joined || !me) { show('message', false); show('game', false); return; }

  if (!team) {
    show('message', true);
    show('game', false);
    const where = state.mode === 'nohost' ? 'on the shared screen' : 'by the host';
    $('message').textContent = state.teams.length ? `Hi ${me.name}! You'll be put in a team ${where} in a moment.` : `Hi ${me.name}! Waiting for teams to be made ${where}…`;
    return;
  }

  show('message', false);

  // Sparkle Round: phones show the dare instead of the buzzer.
  const sp = state.sparkle;
  const performing = sp?.performerId === playerId;
  const inSparkle = !!sp?.hasCard || performing;
  show('sparkle', inSparkle);
  show('game', !inSparkle);
  if (inSparkle) {
    const isSecret = SECRET_MODES.includes(sp.mode);
    const verb = sp.mode === 'draw' ? 'Draw it!' : 'Act it out, no talking!';
    let head = '', big = '';
    if (!sp.hasCard) { head = "You're the performer!"; big = 'Get ready…'; }
    else if (performing && isSecret) {
      head = sp.mode === 'draw' ? `Your secret word — ${verb} (${sp.points} points)` : `Your secret movie — ${verb}`;
      big = secret || '…';
    }
    else if (performing) { head = "You're up!"; big = sp.text; }
    else if (isSecret) { big = 'Guess!'; }
    else { big = 'Watch the TV!'; }
    $('spHead').textContent = head;
    $('spBig').textContent = big;
    if (!sp.hasCard) $('spTimer').textContent = '';
    else tickTimer();
    // No host: the performer says when it's guessed (or done); the other teams vote on a Mimic.
    const n = state.nh;
    const otherTeam = me.teamId !== sp.teamId;
    show('nhGuessed', !!n && performing && sp.hasCard && sp.mode !== 'mimic' && ['sparkleReady', 'sparkleRun'].includes(n.phase));
    if (n) $('nhGuessed').textContent = sp.mode === 'draw' ? `🎉 Guessed! +${sp.points}` : '🎉 Guessed! +100';
    show('nhMimicDone', !!n && performing && sp.mode === 'mimic' && n.phase === 'sparkleRun');
    const canVote = !!n && n.phase === 'mimicVote' && otherTeam;
    show('nhMimicVote', canVote);
    if (canVote) [...$('nhMimicVote').children].forEach((x) => x.classList.toggle('picked', nhSent === x.dataset.mimic));
    show('nhSpCount', !!n && ['sparkleReady', 'mimicVote'].includes(n.phase));
    if (n) $('nhSpCount').textContent = n.phase === 'sparkleReady' ? `Starts in ${nhSecs()}` : n.phase === 'mimicVote' ? (otherTeam ? `How good was it? ${nhSecs()}s` : `The others are voting… ${nhSecs()}s`) : '';
    if (n?.phase === 'mimicVote' && !otherTeam) $('spBig').textContent = 'Votes coming in…';
    return;
  }
  ['nhGuessed', 'nhMimicDone', 'nhMimicVote', 'nhSpCount'].forEach((id) => show(id, false));

  if (state.nh) return renderNoHost(me, team);

  const b = state.buzz;
  const teamName = (id) => state.teams.find((t) => t.id === id)?.name || '?';
  const playerName = (id) => state.players.find((p) => p.id === id)?.name || '?';
  const myEntry = b.order.find((e) => e.teamId === team.id);
  const locked = b.locked.includes(team.id);
  const turn = b.order.find((e) => !b.locked.includes(e.teamId));

  $('buzz').disabled = !b.open || !!myEntry || locked;
  show('doubleNote', !!state.double);
  // Between questions there's nothing to buzz: point everyone at the TV.
  show('buzz', state.question);

  let msg;
  if (locked) msg = 'Locked out for this question';
  else if (myEntry && turn?.teamId === team.id) msg = myEntry.playerId === playerId ? "You're first!" : `Your team is first! (${playerName(myEntry.playerId)})`;
  else if (myEntry) msg = `Too slow — ${teamName(turn?.teamId)} got it`;
  else if (b.open) msg = 'Buzzers open!';
  else if (state.question) msg = 'Get ready to buzz…';
  else msg = '👀 Look at the TV';
  if (msg !== lastMsg) {
    const st = $('status');
    const first = msg.includes('first!');
    st.textContent = msg;
    st.classList.remove('big', 'sad');
    void st.offsetWidth; // restart the animation
    if (first) {
      st.classList.add('big');
      const pl = document.querySelector('.player');
      pl.classList.remove('first'); void pl.offsetWidth; pl.classList.add('first');
      pl.style.setProperty('--c', team.color);
      try { navigator.vibrate?.([80, 60, 80]); } catch {}
    } else if (locked || msg.startsWith('Too slow')) st.classList.add('sad');
    lastMsg = msg;
  }
}

// ---- No host: the phone does what a host would ----
function nhCountText() {
  const n = state.nh;
  const secs = nhSecs();
  const text = {
    reading: `Buzzers open in ${secs}`,
    open: `Buzz! (${secs}s)`,
    saying: `Say your answer! ${secs}`,
    judging: `${secs}s`,
    challenge: `${secs}s`,
    bonus: `${secs}s`,
  }[n.phase];
  $('nhCount').textContent = text || '';
  show('nhCount', !!text && !$('game').classList.contains('hidden'));
  if (!$('sparkle').classList.contains('hidden') && n.phase && ['sparkleReady', 'mimicVote'].includes(n.phase)) render();
}

function renderNoHost(me, team) {
  const n = state.nh;
  const b = state.buzz;
  const nameOf = (id) => state.players.find((p) => p.id === id)?.name || '?';
  const teamName = (id) => state.teams.find((t) => t.id === id)?.name || '?';
  const mine = n.buzzer === playerId;
  const myTeamUp = n.buzzTeam === team.id;
  const locked = b.locked.includes(team.id);
  const passed = n.passed.includes(team.id);

  $('buzz').disabled = !(n.phase === 'open' && b.open && !locked && !passed);
  show('buzz', state.question && ['reading', 'open'].includes(n.phase));
  show('doubleNote', !!state.double && state.question);

  // ✅ / ❌: only the buzzer, after "Say your answer!", with the answer on their own screen.
  const judging = n.phase === 'judging' && mine;
  show('nhAnswer', judging && nhAnswer != null);
  if (judging) $('nhAnswer').textContent = `The answer: ${nhAnswer ?? '…'}`;
  show('nhJudge', judging);

  // 🚩 for the other teams after the buzzer chooses. One challenge flips it.
  const canChallenge = n.phase === 'challenge' && !myTeamUp && !n.challengedBy;
  show('nhChallenge', canChallenge);

  // 🙅 Pass: after a wrong answer reopens the buzzers, a team still in can sit this one out.
  show('nhPass', n.canPass && !locked && !passed && !b.order.some((e) => e.teamId === team.id));

  // 🎯 The team that answered right picks the next tile (anyone, before anybody has).
  const picking = !state.question && !state.bonus && !n.phase && state.screen === 'board';
  const myPick = picking && (n.picker == null || n.picker === team.id);
  show('nhBoard', myPick);
  if (myPick) {
    const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = String(text); return x; };
    const cols = state.board.length;
    $('nhBoard').style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    const cells = state.board.map((c) => el('div', 'nh-cat', c.category));
    const rows = Math.max(...state.board.map((c) => c.values.length));
    for (let i = 0; i < rows; i++) {
      state.board.forEach((c, ci) => {
        if (c.values[i] == null) return cells.push(el('div'));
        const btn = el('button', 'nh-tile', c.values[i]);
        btn.dataset.cat = ci;
        btn.dataset.idx = i;
        btn.disabled = state.used.includes(`${ci}-${i}`) || nhSent === 'pick';
        cells.push(btn);
      });
    }
    $('nhBoard').replaceChildren(...cells);
  }

  // 👍 / 👎 on someone else's bonus.
  const bonus = state.bonus;
  const canVoteBonus = n.phase === 'bonus' && bonus && bonus.teamId !== team.id;
  show('nhBonus', !!canVoteBonus);
  if (canVoteBonus) [...$('nhBonus').children].forEach((x) => x.classList.toggle('picked', nhSent === x.dataset.bonus));

  // 😂 +5: once per question, to another team.
  const live = state.question || n.phase === 'reveal';
  const given = n.funnyBy.includes(playerId);
  show('nhFunny', live && state.teams.length > 1);
  if (live) {
    const others = state.teams.filter((t) => t.id !== team.id);
    $('nhFunny').replaceChildren(...(given ? [Object.assign(document.createElement('span'), { className: 'muted', textContent: '😂 +5 given for this question' })]
      : others.map((t) => {
        const btn = document.createElement('button');
        btn.className = 'funny';
        btn.dataset.funny = t.id;
        btn.style.setProperty('--c', t.color);
        btn.textContent = `😂 +5 ${t.name}`;
        return btn;
      })));
  }

  let msg;
  if (picking && state.screen === 'board') msg = myPick ? (n.picker == null ? '🎯 Pick the first tile (or tap it on the screen)' : '🎯 Your team picks the next tile!') : `🎯 ${teamName(n.picker)} picks the next tile`;
  else if (!state.question && !state.bonus && n.phase !== 'reveal') msg = '👀 Look at the screen';
  else if (n.phase === 'reveal') msg = '👀 The answer is on the screen';
  else if (n.phase === 'bonus') msg = bonus.teamId === team.id ? `⭐ Bonus! Do it: "${bonus.text}"` : `Did ${teamName(bonus.teamId)} do it?${nhSent ? ' Thanks for voting!' : ''}`;
  else if (locked && !myTeamUp) msg = 'Locked out for this question';
  else if (passed) msg = '🙅 Your team passed on this one';
  else if (n.phase === 'reading') msg = 'Read the question…';
  else if (n.phase === 'open') msg = 'Buzzers open!';
  else if (n.phase === 'saying') msg = mine ? "You're first! Say your answer out loud!" : myTeamUp ? `Your team is first! (${nameOf(n.buzzer)})` : `${nameOf(n.buzzer)} (${teamName(n.buzzTeam)}) is answering…`;
  else if (n.phase === 'judging') msg = mine ? 'Were you right? Be honest!' : `${nameOf(n.buzzer)} is checking the answer…`;
  else if (n.phase === 'challenge') {
    const said = n.claim ? '✅ got it' : '❌ missed it';
    msg = n.challengedBy ? `🚩 ${nameOf(n.challengedBy)} challenged! (${nameOf(n.buzzer)} said ${said})`
      : myTeamUp ? `${mine ? 'You' : nameOf(n.buzzer)} said ${said}. Waiting for challenges…` : `${nameOf(n.buzzer)} says ${said}. Disagree?`;
  } else msg = '👀 Look at the screen';
  const st = $('status');
  if (msg !== lastMsg) {
    st.textContent = msg;
    st.classList.remove('big', 'sad');
    void st.offsetWidth;
    if (mine && n.phase === 'saying') {
      st.classList.add('big');
      const pl = document.querySelector('.player');
      pl.classList.remove('first'); void pl.offsetWidth; pl.classList.add('first');
      pl.style.setProperty('--c', team.color);
      try { navigator.vibrate?.([80, 60, 80]); } catch {}
    } else if (locked) st.classList.add('sad');
    lastMsg = msg;
  }
  nhCountText();
}
