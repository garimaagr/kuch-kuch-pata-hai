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

function join() {
  socket.emit('player:join', { code, playerId, name }, (res) => {
    joined = res.ok;
    error = res.ok ? null : res.error;
    render();
  });
}

// Runs on first connect and after every reconnect, so a dropped phone rejoins as the same person.
socket.on('connect', () => { if (name) join(); else render(); });
// Socket.IO keeps retrying on its own. Show it, and retry right away when a sleeping phone wakes up.
socket.on('disconnect', () => {
  $('top').textContent = '📶 Reconnecting…';
  $('buzz').disabled = true;
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !socket.connected) socket.connect();
});
socket.on('secret', (title) => { secret = title; });
socket.on('state', (s) => {
  state = s;
  sparkleEndsAt = s.sparkle?.running ? Date.now() + s.sparkle.remaining : null;
  render();
});

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

$('buzz').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if ($('buzz').disabled) return;
  try { navigator.vibrate?.(150); } catch {}
  socket.emit('player:buzz');
});

function render() {
  const me = state?.players.find((p) => p.id === playerId);
  const team = state?.teams.find((t) => t.id === me?.teamId);

  show('nameForm', !name || (error && !joined));
  if (!name) $('nameInput').value = '';

  $('top').textContent = team ? team.name : '🎬 Kuch Kuch Pata Hai';
  $('top').style.setProperty('--c', team ? team.color : '');

  if (error) { show('message', true); $('message').textContent = error; show('game', false); return; }
  if (!joined || !me) { show('message', false); show('game', false); return; }

  if (!team) {
    show('message', true);
    show('game', false);
    $('message').textContent = `Hi ${me.name}! Waiting for the host to make teams…`;
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
    return;
  }

  const b = state.buzz;
  const teamName = (id) => state.teams.find((t) => t.id === id)?.name || '?';
  const playerName = (id) => state.players.find((p) => p.id === id)?.name || '?';
  const myEntry = b.order.find((e) => e.teamId === team.id);
  const locked = b.locked.includes(team.id);
  const turn = b.order.find((e) => !b.locked.includes(e.teamId));

  $('buzz').disabled = !b.open || !!myEntry || locked;

  let msg;
  if (locked) msg = 'Locked out for this question';
  else if (myEntry && turn?.teamId === team.id) msg = myEntry.playerId === playerId ? "You're first!" : `Your team is first! (${playerName(myEntry.playerId)})`;
  else if (myEntry) msg = `Too slow — ${teamName(turn?.teamId)} got it`;
  else if (b.open) msg = 'Buzzers open!';
  else msg = 'Wait for the host…';
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
