const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const buzz = require('./buzz');

const PORT = Number(process.env.PORT) || 3000;
// When hosted (e.g. on Render), join links use the public address instead of the wifi IP.
// Render sets RENDER_EXTERNAL_URL automatically; PUBLIC_URL overrides it.
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

// The Sparkle Round starts by itself after every this many finished board questions.
const SPARKLE_EVERY = 4;
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const pub = path.join(__dirname, 'public');

app.use(express.static(pub));
app.get('/', (req, res) => res.redirect('/host'));
app.get('/host', (req, res) => res.sendFile(path.join(pub, 'host.html')));
app.get('/join/:code', (req, res) => res.sendFile(path.join(pub, 'join.html')));

// The laptop's address on the home wifi, e.g. 192.168.1.20. Phones use it to reach the game.
// Skips VPN, virtual-machine and Docker adapters. Returns null when not on a network.
function wifiIp() {
  const skip = /^(utun|tun|tap|bridge|vmnet|vboxnet|docker|veth|llw|awdl|zt|tailscale|vEthernet)/i;
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 9);
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name)) continue;
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && rank(a.address) < 9) found.push(a.address);
    }
  }
  found.sort((a, b) => rank(a) - rank(b));
  return found[0] || null;
}

const TEAM_DEFS = [
  { name: 'Team Mogambo', color: '#d32f2f' },
  { name: 'Team Basanti', color: '#f9a825' },
  { name: 'Team Gabbar', color: '#2e7d32' },
  { name: 'Team Poo', color: '#ec407a' },
];

// ---- Game state (in memory only) ----
const rooms = new Map(); // code -> room

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function publicState(room) {
  return {
    code: room.code,
    joinUrl: room.joinUrl,
    teams: room.teams,
    players: [...room.players.values()].map(({ id, name, teamId, connected }) => ({ id, name, teamId, connected })),
    buzz: room.buzz,
    sparkle: publicSparkle(room),
  };
}

// The host also gets the board, the open question and its answer. Phones never see answers.
function hostState(room) {
  return {
    ...publicState(room),
    screen: room.screen,
    board: room.board.map((c) => ({ category: c.category, note: c.note, values: c.questions.map((q) => q.value) })),
    used: room.used,
    boardNo: room.boardNo,
    boardCount: room.boards.length,
    current: room.current && { ...room.current, ...room.board[room.current.cat].questions[room.current.idx], category: room.board[room.current.cat].category, note: room.board[room.current.cat].note },
    showAnswer: room.showAnswer,
    bonus: room.bonus,
    deckLeft: Object.fromEntries(DECK_KEYS.map((k) => [k, room.decks[k].length - room.drawn[k].length])),
  };
}

function send(room) {
  // The secret movie title goes only to the performer's phone, never to the TV.
  const card = sparkleCard(room);
  if (card && SECRET_MODES.includes(room.sparkle.mode)) {
    const p = room.players.get(room.sparkle.performerId);
    if (p?.socketId) io.to(p.socketId).emit('secret', card);
  }
  io.to(room.code).emit('state', publicState(room));
  io.to(room.code + ':host').emit('state', hostState(room));
}

// Quick "+5 😂" style flash next to a team's score on the TV.
function flash(room, teamId, text) {
  io.to(room.code + ':host').emit('flash', { teamId, text });
}

// ---- Sparkle Round ----
const SPARKLE_MS = 60 * 1000;
const MODES = ['draw', 'charades', 'mimic'];
const SECRET_MODES = ['draw', 'charades']; // the word shows only on the performer's phone
// Draw has three piles. Guessing a card is worth this many points.
const DRAW_LEVELS = { easy: 50, medium: 100, tricky: 200 };
const DECK_KEYS = [...Object.keys(DRAW_LEVELS).map((l) => `draw:${l}`), 'charades', 'mimic'];
const deckKey = (s) => (s.mode === 'draw' ? `draw:${s.level}` : s.mode);

function loadDecks() {
  const dares = JSON.parse(fs.readFileSync(path.join(__dirname, 'dares.json'), 'utf8'));
  const list = (x) => (Array.isArray(x) ? x : []);
  return {
    ...Object.fromEntries(Object.keys(DRAW_LEVELS).map((l) => [`draw:${l}`, list(dares.draw?.[l])])),
    charades: list(dares.charades),
    mimic: list(dares.mimic),
  };
}

function newSparkle() {
  return { teamId: null, mode: null, level: null, performerId: null, cardIdx: null, empty: false, running: false, remaining: SPARKLE_MS, endsAt: null };
}

function sparkleCard(room) {
  const s = room.sparkle;
  return s?.cardIdx != null ? room.decks[deckKey(s)][s.cardIdx] : null;
}

function timeLeft(s) {
  return s.running ? Math.max(0, s.endsAt - Date.now()) : s.remaining;
}

// Draws a random unused card from the chosen mode. Skipped cards count as used.
function drawCard(room) {
  const s = room.sparkle;
  const key = deckKey(s);
  const left = room.decks[key].map((_, i) => i).filter((i) => !room.drawn[key].includes(i));
  s.running = false;
  s.remaining = SPARKLE_MS;
  if (!left.length) { s.cardIdx = null; s.empty = true; return; }
  s.cardIdx = left[Math.floor(Math.random() * left.length)];
  s.empty = false;
  room.drawn[key].push(s.cardIdx);
}

// What everyone may see. Draw / charades titles are left out.
function publicSparkle(room) {
  const s = room.sparkle;
  if (!s) return null;
  const card = sparkleCard(room);
  return {
    teamId: s.teamId,
    mode: s.mode,
    level: s.level,
    points: s.mode === 'draw' && s.level ? DRAW_LEVELS[s.level] : null, // at stake for a Draw card
    performerId: s.performerId,
    hasCard: !!card,
    empty: s.empty,
    text: card && s.mode === 'mimic' ? card : null,
    running: s.running,
    remaining: timeLeft(s), // ms; clients count down locally while running
  };
}

// Board 1 is questions.json; board 2 (questions-2.json) is optional.
function loadQuestions() {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
  const boards = [read('questions.json')];
  if (fs.existsSync(path.join(__dirname, 'questions-2.json'))) boards.push(read('questions-2.json'));
  return boards;
}

function currentQuestion(room) {
  return room.current && room.board[room.current.cat].questions[room.current.idx];
}

// A question counts as finished when it was answered correctly or its answer was shown.
function finishQuestion(room, counts) {
  if (counts) {
    room.finished++;
    if (room.finished % SPARKLE_EVERY === 0) room.sparkleDue = true;
  }
  closeQuestion(room);
}

// Back to the board, or straight into the Sparkle Round if one is due.
function goToBoard(room) {
  room.screen = room.sparkleDue ? 'sparkle' : 'board';
  room.sparkle = room.sparkleDue ? newSparkle() : null;
  room.sparkleDue = false;
}

function closeQuestion(room) {
  if (room.current) room.used.push(`${room.current.cat}-${room.current.idx}`);
  room.current = null;
  room.showAnswer = false;
  buzz.resetBuzz(room.buzz);
}

function makeTeams(room, count) {
  const n = Math.min(4, Math.max(2, Number(count) || 2));
  const oldScores = new Map(room.teams.map((t) => [t.id, t.score]));
  room.teams = TEAM_DEFS.slice(0, n).map((d, i) => ({ id: i, ...d, score: oldScores.get(i) || 0 }));
  shuffle([...room.players.values()]).forEach((p, i) => (p.teamId = i % n));
  buzz.resetBuzz(room.buzz);
  room.sparkle = null;
}

function smallestTeam(room) {
  const counts = room.teams.map((t) => [...room.players.values()].filter((p) => p.teamId === t.id).length);
  return room.teams[counts.indexOf(Math.min(...counts))].id;
}

// ---- Sockets ----
io.on('connection', (socket) => {
  const hostRoom = () => (socket.data.role === 'host' ? rooms.get(socket.data.code) : null);

  socket.on('host:new', async (cb) => {
    const code = makeCode();
    let joinUrl;
    if (PUBLIC_URL) joinUrl = `${PUBLIC_URL}/join/${code}`; // hosted: use the public address
    else {
      const ip = wifiIp(); // checked each game, in case the laptop changed networks
      if (!ip) return cb?.({ ok: false, error: "This laptop isn't connected to wifi, so phones can't reach it. Connect to your home wifi and click New game again." });
      joinUrl = `http://${ip}:${PORT}/join/${code}`;
    }
    let boards, decks;
    try {
      // Re-read each game, so hand edits to the JSON files show up.
      boards = loadQuestions();
      decks = loadDecks();
    } catch (err) {
      return cb?.({ ok: false, error: 'Could not read questions.json, questions-2.json or dares.json: ' + err.message });
    }
    const room = {
      code, joinUrl, players: new Map(), teams: [], buzz: buzz.newBuzz(),
      screen: 'lobby', boards, usedBy: boards.map(() => []), boardNo: 0,
      board: boards[0], used: null, current: null, showAnswer: false,
      finished: 0, sparkleDue: false, bonus: null,
      decks, drawn: Object.fromEntries(DECK_KEYS.map((k) => [k, []])), sparkle: null,
    };
    room.used = room.usedBy[0];
    room.qr = await QRCode.toDataURL(joinUrl, { margin: 1, width: 320 });
    rooms.set(code, room);
    socket.data = { role: 'host', code };
    socket.join(code + ':host');
    cb?.({ ok: true, code, qr: room.qr });
    send(room);
  });

  socket.on('host:resume', (code, cb) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return cb?.({ ok: false });
    socket.data = { role: 'host', code: room.code };
    socket.join(room.code + ':host');
    cb?.({ ok: true, code: room.code, qr: room.qr });
    send(room);
  });

  socket.on('host:makeTeams', (count) => {
    const room = hostRoom();
    if (!room) return;
    makeTeams(room, count);
    send(room);
  });

  socket.on('host:movePlayer', ({ playerId, teamId }) => {
    const room = hostRoom();
    const p = room?.players.get(playerId);
    if (!p || !room.teams.some((t) => t.id === teamId)) return;
    p.teamId = teamId;
    send(room);
  });

  socket.on('host:openBuzzers', () => {
    const room = hostRoom();
    if (!room) return;
    buzz.openBuzzers(room.buzz);
    send(room);
  });

  socket.on('host:resetBuzzers', () => {
    const room = hostRoom();
    if (!room) return;
    buzz.resetBuzz(room.buzz);
    send(room);
  });

  // ---- Board and scoring ----
  socket.on('host:screen', (screen) => {
    const room = hostRoom();
    if (!room || !['lobby', 'board', 'sparkle'].includes(screen)) return;
    room.screen = screen;
    room.sparkle = screen === 'sparkle' ? newSparkle() : null;
    send(room);
  });

  // Switch boards; scores and each board's used tiles are kept.
  socket.on('host:switchBoard', (n) => {
    const room = hostRoom();
    if (!room || room.current || room.bonus || !room.boards[n]) return;
    room.boardNo = n;
    room.board = room.boards[n];
    room.used = room.usedBy[n];
    send(room);
  });

  socket.on('host:pickTile', ({ cat, idx } = {}) => {
    const room = hostRoom();
    if (!room || room.current || room.bonus || !room.board[cat]?.questions[idx] || room.used.includes(`${cat}-${idx}`)) return;
    room.current = { cat, idx };
    room.showAnswer = false;
    buzz.resetBuzz(room.buzz);
    send(room);
  });

  socket.on('host:correct', () => {
    const room = hostRoom();
    const turn = room && buzz.currentTurn(room.buzz);
    const team = turn && room.teams.find((t) => t.id === turn.teamId);
    if (!team) return;
    const q = currentQuestion(room);
    team.score += q.value;
    finishQuestion(room, true);
    if (q.bonus) room.bonus = { teamId: team.id, text: q.bonus, points: Number(q.bonusPoints) || 0 };
    else goToBoard(room);
    send(room);
  });

  socket.on('host:wrong', () => {
    const room = hostRoom();
    const turn = room && buzz.currentTurn(room.buzz);
    const team = turn && room.teams.find((t) => t.id === turn.teamId);
    if (!team) return;
    team.score -= currentQuestion(room).value;
    buzz.lockTeam(room.buzz, team.id); // next team in line gets the turn
    send(room);
  });

  socket.on('host:showAnswer', () => {
    const room = hostRoom();
    if (!room?.current) return;
    room.showAnswer = true;
    send(room);
  });

  socket.on('host:backToBoard', () => {
    const room = hostRoom();
    if (!room?.current) return;
    finishQuestion(room, room.showAnswer); // only counts toward the Sparkle Round if the answer was shown
    goToBoard(room);
    send(room);
  });

  // 😂 +5 for a funny wrong answer. Any team, any number of times.
  socket.on('host:funny', (teamId) => {
    const room = hostRoom();
    const team = room?.teams.find((t) => t.id === teamId);
    if (!team || !room.current) return;
    team.score += 5;
    send(room);
    flash(room, team.id, '+5 😂');
  });

  socket.on('host:bonus', (done) => {
    const room = hostRoom();
    const b = room?.bonus;
    if (!b) return;
    if (done) room.teams.find((t) => t.id === b.teamId).score += b.points;
    room.bonus = null;
    goToBoard(room);
    send(room);
    if (done) flash(room, b.teamId, `+${b.points} ⭐`);
  });

  socket.on('host:adjustScore', ({ teamId, delta } = {}) => {
    const room = hostRoom();
    const team = room?.teams.find((t) => t.id === teamId);
    if (!team || !Number.isFinite(delta)) return;
    team.score += delta;
    send(room);
  });

  // ---- Sparkle Round ----
  // 1. Host picks the team. 2. Host picks the mode. 3. The team chooses a performer; host taps their name,
  // which draws a card. 4. Timer, then the host gives points.
  const sparkleRoom = () => {
    const room = hostRoom();
    return room?.screen === 'sparkle' && room.sparkle ? room : null;
  };

  socket.on('host:sparkleTeam', (teamId) => {
    const room = sparkleRoom();
    if (!room || room.sparkle.cardIdx != null || !room.teams.some((t) => t.id === teamId)) return;
    room.sparkle.teamId = teamId;
    room.sparkle.performerId = null;
    send(room);
  });

  socket.on('host:sparkleMode', (mode) => {
    const room = sparkleRoom();
    if (!room || room.sparkle.cardIdx != null || !MODES.includes(mode)) return;
    room.sparkle.mode = mode;
    room.sparkle.level = null;
    room.sparkle.empty = false;
    send(room);
  });

  // Draw only: the team picks a difficulty.
  socket.on('host:sparkleLevel', (level) => {
    const room = sparkleRoom();
    const s = room?.sparkle;
    if (!s || s.cardIdx != null || s.mode !== 'draw' || !(level in DRAW_LEVELS)) return;
    s.level = level;
    s.empty = false;
    send(room);
  });

  socket.on('host:sparklePerformer', (playerId) => {
    const room = sparkleRoom();
    const s = room?.sparkle;
    const p = room?.players.get(playerId);
    if (!s || s.cardIdx != null || !s.mode || (s.mode === 'draw' && !s.level) || p?.teamId !== s.teamId) return;
    s.performerId = playerId;
    drawCard(room);
    send(room);
  });

  socket.on('host:skipCard', () => {
    const room = sparkleRoom();
    if (!room?.sparkle.performerId) return;
    drawCard(room);
    send(room);
  });

  socket.on('host:timer', (action) => {
    const room = sparkleRoom();
    const s = room?.sparkle;
    if (!s || s.cardIdx == null) return;
    if (action === 'start' && !s.running) {
      if (s.remaining <= 0) s.remaining = SPARKLE_MS; // start again after time's up
      s.endsAt = Date.now() + s.remaining;
      s.running = true;
    } else if (action === 'stop' && s.running) {
      s.remaining = timeLeft(s);
      s.running = false;
    } else return;
    send(room);
  });

  function awardSparkle(room, points) {
    const s = room.sparkle;
    room.teams.find((t) => t.id === s.teamId).score += points;
    room.screen = 'board';
    room.sparkle = null;
    send(room);
    if (points) flash(room, s.teamId, `${points > 0 ? '+' : ''}${points} ✨`);
  }

  // The host chooses the points (preset buttons or a custom amount), then it's back to the board.
  socket.on('host:sparklePoints', (points) => {
    const room = sparkleRoom();
    const s = room?.sparkle;
    points = Math.round(Number(points));
    if (!s || s.teamId == null || !Number.isFinite(points) || Math.abs(points) > 1000) return;
    awardSparkle(room, points);
  });

  // Draw: "Guessed" adds the card's difficulty points automatically.
  socket.on('host:sparkleGuessed', () => {
    const room = sparkleRoom();
    const s = room?.sparkle;
    if (!s || s.mode !== 'draw' || s.cardIdx == null) return;
    awardSparkle(room, DRAW_LEVELS[s.level]);
  });

  socket.on('player:join', ({ code, playerId, name } = {}, cb) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: 'Game not found. Ask the host for the new code.' });
    name = String(name || '').trim().slice(0, 20);
    playerId = String(playerId || '').slice(0, 40);
    if (!name || !playerId) return cb?.({ ok: false, error: 'Please enter a name.' });

    let p = room.players.get(playerId);
    if (!p) {
      p = { id: playerId, name, teamId: room.teams.length ? smallestTeam(room) : null };
      room.players.set(playerId, p);
    }
    p.name = name;
    p.socketId = socket.id;
    p.connected = true;
    socket.data = { role: 'player', code: room.code, playerId };
    socket.join(room.code);
    cb?.({ ok: true });
    send(room);
  });

  socket.on('player:buzz', () => {
    const room = rooms.get(socket.data.code);
    const p = room?.players.get(socket.data.playerId);
    if (!p) return;
    if (buzz.tryBuzz(room.buzz, p.teamId, p.id)) send(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.code);
    const p = room?.players.get(socket.data.playerId);
    if (p && p.socketId === socket.id) {
      p.connected = false;
      send(room);
    }
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use by another program. Try a different port:\n\n  PORT=3100 npm start\n`);
    process.exit(1);
  }
  throw err;
});

// 0.0.0.0 = listen on every network interface, so phones on the wifi can connect.
server.listen(PORT, '0.0.0.0', () => {
  console.log('\nKuch Kuch Pata Hai is running!\n');
  if (PUBLIC_URL) return console.log(`  Hosted at ${PUBLIC_URL} (host page: ${PUBLIC_URL}/host)\n`);
  const ip = wifiIp();
  console.log(`  Open the host page on this laptop: http://localhost:${PORT}/host`);
  if (ip) {
    console.log(`  Laptop's wifi IP: ${ip}  (phones join at http://${ip}:${PORT}/join/CODE)\n`);
  } else {
    console.log("  ⚠️  Couldn't find a wifi IP. Connect this laptop to your home wifi before starting a game.\n");
  }
});
