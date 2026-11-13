// Local settings (e.g. DATABASE_URL for testing) can live in a .env file, which git ignores.
// On Render they come from the Environment settings instead.
try { if (typeof process.loadEnvFile === 'function') process.loadEnvFile(require('path').join(__dirname, '.env')); } catch { /* no .env: fine */ }

const crypto = require('crypto');
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const buzz = require('./buzz');
const { makeLimiter, cleanText } = require('./limits');
const { validatePack, defaultCategories, chosenCategories, checkUploadedText } = require('./pack');
const remotes = require('./remote');
const db = require('./db');
const community = require('./community');
const { adminRouter } = require('./admin');
const featured = require('./featured');
const site = require('./site');

const PORT = Number(process.env.PORT) || 3000;
// The site's addresses (see site.js). PUBLIC_URL (e.g. https://www.buzzin-game.com) is used for join links,
// QR codes and the remote pairing link; without it, they use the address the host page was opened on.
const SITE = site.siteConfig();
const PUBLIC_URL = SITE.publicUrl;
// Hosted (on Render): trust Render's X-Forwarded-* headers and turn on the public limits.
const HOSTED = !!(PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || process.env.RENDER);

// Default: the Sparkle Round starts by itself after every this many finished board questions.
// The host can change it per game in Customise (off, 3, 4 or 6).
const SPARKLE_EVERY = 6;
const SPARKLE_CHOICES = [0, 3, 4, 6]; // 0 = off

// ---- Limits (the hosted server is public and small) ----
const MAX_ROOMS = 20;
const MAX_PLAYERS = 30; // per room
const ROOM_IDLE_MS = 3 * 60 * 60 * 1000; // rooms with no activity for 3 hours are deleted
const EVENTS_PER_SECOND = 20; // per socket; extra events are dropped
const MAX_MESSAGE_BYTES = 300 * 1024;
// Optional: set HOST_PIN on the server and /host asks for it before starting a game.
const HOST_PIN = process.env.HOST_PIN || '';
const roomCreation = makeLimiter(5, 10 * 60 * 1000); // 5 new games per IP per 10 minutes
const packChecks = makeLimiter(10, 10 * 60 * 1000); // 10 "Make your own" pack checks per room (or IP) per 10 minutes
const pairAttempts = makeLimiter(5, 60 * 1000); // 5 remote pairing attempts per room (and per network) per minute

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: MAX_MESSAGE_BYTES });
const pub = path.join(__dirname, 'public');

app.disable('x-powered-by');
// Health check for uptime monitors. Registered first, so it skips every other middleware and
// limit, and it never touches the database, rooms or sessions.
app.get('/healthz', (req, res) => {
  res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.status(200).send('ok');
});
// buzzin-game.com and the onrender.com address -> PUBLIC_URL (www, 301). Only when PUBLIC_URL is set;
// PUBLIC_URL's own host is never redirected (Render already sends the bare domain to www).
app.use(site.canonicalRedirect(SITE));
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  next();
});
app.use(express.json({ limit: '300kb' }));
app.use(express.static(pub));
app.get('/', (req, res) => res.redirect('/host'));
app.get('/host', (req, res) => res.sendFile(path.join(pub, 'host.html')));
app.get('/join/:code', (req, res) => res.sendFile(path.join(pub, 'join.html')));
app.get('/remote', (req, res) => res.sendFile(path.join(pub, 'remote.html')));
// The review page for community boards (PIN login; works only with a database).
app.get('/admin', (req, res) => res.sendFile(path.join(pub, 'admin.html')));
// The visitor's network (Render puts it in x-forwarded-for). Used for rate limits only.
const reqIp = (req) => (HOSTED && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
app.use('/admin', adminRouter({ ipOf: reqIp, allowedOrigins: SITE.allowedOrigins }));

// ---- Community boards: public, read-only, approved boards only ----
const communityReads = makeLimiter(120, 60 * 1000); // per network per minute
app.use('/api/community', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!db.enabled()) return res.status(404).json({ error: 'Community boards are off.' });
  if (!communityReads.allow(reqIp(req))) return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
  next();
});
const publicRoute = (fn) => async (req, res) => {
  try {
    const out = await fn(req);
    if (out == null) return res.status(404).json({ error: 'That board isn\'t available.' });
    res.json(out);
  } catch (err) {
    console.error(`Community request failed (${err.code || err.message}).`);
    res.status(500).json({ error: 'Couldn\'t load community boards right now. Please try again.' });
  }
};
app.get('/api/community/tags', publicRoute((req) => community.publicTags(req.query)));
app.get('/api/community/new', publicRoute((req) => community.newBoards(req.query)));
app.get('/api/community/boards', publicRoute((req) => community.listBoards(req.query)));
app.get('/api/community/random', publicRoute(async (req) => {
  const id = await community.randomBoard(req.query);
  return id ? { id } : null;
}));
// What the setup screen shows for a board: names and categories, never questions or answers.
app.get('/api/community/boards/:id', publicRoute(async (req) => {
  const pack = await loadCommunityPack(req.params.id);
  if (!pack) return null;
  return {
    id: 'c:' + pack.meta.id, community: true, name: pack.name, emoji: pack.emoji || '', hasSparkle: !!pack.sparkle, teams: teamNamesFor(pack),
    madeBy: pack.meta.madeBy, kidFriendly: pack.meta.kidFriendly, playCount: pack.meta.playCount, tags: pack.meta.tags,
    boards: pack.boards.map((b) => ({ name: b.name, categories: b.categories.map((c) => ({ name: c.name, note: c.note, default: true })) })),
  };
}));

// An approved community board, checked again with the strict upload rules before it's used. null if not available.
async function loadCommunityPack(id) {
  const loaded = await community.loadPack(id);
  if (!loaded) return null;
  const res = validatePack(loaded.pack, { kind: 'upload' });
  if (!res.ok) {
    console.error(`Community board ${loaded.meta.id} failed its check: ${res.errors[0]}`);
    return null;
  }
  return { ...res.pack, meta: loaded.meta };
}

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

// Team colours are fixed; the names come from the pack's "teams" list (each theme has its own),
// and these plain names fill in for a pack without one.
const TEAM_DEFS = [
  { name: 'Team Red', color: '#d32f2f' },
  { name: 'Team Yellow', color: '#f9a825' },
  { name: 'Team Green', color: '#2e7d32' },
  { name: 'Team Pink', color: '#ec407a' },
];
const teamNamesFor = (pack) => TEAM_DEFS.map((d, i) => pack.teams?.[i] || d.name);

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
    double: !!room.current?.double, // phones show "DOUBLE!" while a Double tile is open
    question: !!room.current, // phones say "Look at the TV" between questions
    packName: room.packName,
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
    boardNames: room.boardNames,
    boardDone: room.used.length >= room.board.length * 5,
    allDone: room.usedBy.every((u, i) => u.length >= room.boards[i].length * 5),
    packName: room.packName,
    packEmoji: room.packEmoji,
    settings: room.settings,
    current: room.current && { ...room.current, ...room.board[room.current.cat].questions[room.current.idx], category: room.board[room.current.cat].category, note: room.board[room.current.cat].note },
    showAnswer: room.showAnswer,
    reveal: room.reveal,
    bonus: room.bonus,
    deckLeft: Object.fromEntries(DECK_KEYS.map((k) => [k, room.decks[k].length - room.drawn[k].length])),
    version: room.version, // host actions must quote this, so a double tap from two devices counts once
    remotes: room.remotes.length,
    pairing: remotes.pairingStatus(room),
  };
}

// Ends a game: tells its phones (and any other host tab) and forgets it, so old links stop working.
function closeRoom(code, message) {
  if (message) io.to(code).emit('ended', message);
  io.in(code).disconnectSockets(true);
  io.in(code + ':host').disconnectSockets(true);
  rooms.delete(code);
}

// Deletes rooms nobody has used for a while, so memory stays small.
function cleanupRooms(now = Date.now()) {
  for (const [code, room] of rooms) {
    if (now - room.lastActive > ROOM_IDLE_MS) closeRoom(code);
  }
  roomCreation.prune(now);
  community.pruneLimits(now);
  packChecks.prune(now);
}
setInterval(cleanupRooms, 10 * 60 * 1000).unref();

// Where phones reach the game (join link, QR code, remote pairing): PUBLIC_URL when set, else the
// address the host page was opened on. On a laptop opened as localhost, that's the wifi IP instead
// (checked each game, in case the laptop changed networks). Null if there's nothing phones can reach.
function linkBase(socket) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const own = site.requestOrigin(socket.handshake.headers, { secure: socket.handshake.secure, trustProxy: HOSTED });
  if (own && !site.isLoopback(own)) return own;
  const ip = wifiIp();
  return ip ? `http://${ip}:${PORT}` : null;
}

// The visitor's IP. On Render the real one is the first entry of X-Forwarded-For.
function clientIp(socket) {
  const xff = socket.handshake.headers['x-forwarded-for'];
  return (HOSTED && xff ? String(xff).split(',')[0].trim() : socket.handshake.address) || 'unknown';
}

// Constant-time comparison for the host secret.
function sameSecret(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function send(room) {
  room.lastActive = Date.now();
  // The secret movie title goes only to the performer's phone, never to the TV.
  const card = sparkleCard(room);
  if (card && SECRET_MODES.includes(room.sparkle.mode)) {
    const p = room.players.get(room.sparkle.performerId);
    if (p?.socketId) io.to(p.socketId).emit('secret', card);
    io.to(room.code + ':remote').emit('secret', card); // the host judges from the remote
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

// ---- Packs ----
// ⭐ Featured themes (packs/*.json plus the admin's extras) come from featured.js.
const { THEMES, DEFAULT_PACK, loadBuiltinPack } = featured;

// What the setup screen needs: names, boards and categories (no questions or answers).
function packSummaries() {
  return THEMES.map((t) => {
    try {
      const pack = loadBuiltinPack(t.id);
      return {
        id: t.id, name: pack.name, emoji: pack.emoji || t.emoji, hasSparkle: !!pack.sparkle, teams: teamNamesFor(pack),
        boards: pack.boards.map((b) => {
          const defaults = defaultCategories(b);
          return { name: b.name, categories: b.categories.map((c) => ({ name: c.name, note: c.note, default: defaults.includes(c) })) };
        }),
      };
    } catch {
      return { ...t, missing: true };
    }
  });
}

// The host's game options, checked. Anything odd falls back to the default.
function gameSettings(opts, pack) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const which = ['both', '1', '2'].includes(o.boards) ? o.boards : 'both';
  const boardIdx = pack.boards.length < 2 ? [0] : which === '1' ? [0] : which === '2' ? [1] : [0, 1];
  const modes = MODES.filter((m) => (o.modes && typeof o.modes === 'object' ? o.modes[m] !== false : true));
  const every = SPARKLE_CHOICES.includes(o.sparkleEvery) ? o.sparkleEvery : SPARKLE_EVERY;
  return {
    boardIdx,
    sparkleEvery: modes.length ? every : 0, // no modes on = Sparkle off
    modes,
    bonuses: o.bonuses !== false,
    double: o.double !== false,
    categories: boardIdx.map((bi) => (Array.isArray(o.categories) ? o.categories[bi] : null)),
  };
}

// One hidden Double tile per board, never in the lowest-value row.
function pickDoubles(boards) {
  return boards.map((b) => `${Math.floor(Math.random() * b.length)}-${1 + Math.floor(Math.random() * 4)}`);
}

// Sparkle decks: the pack's own cards, or the generic party deck for any mode the pack leaves empty.
function decksFromPack(pack) {
  const party = loadBuiltinPack('party', { allowNoBoards: true }).sparkle;
  const pick = (own, fallback) => (own?.length ? own : fallback || []);
  const s = pack.sparkle || {};
  return {
    ...Object.fromEntries(Object.keys(DRAW_LEVELS).map((l) => [`draw:${l}`, pick(s.draw?.[l], party.draw[l])])),
    charades: pick(s.charades, party.charades),
    mimic: pick(s.mimic, party.mimic),
  };
}

function currentQuestion(room) {
  return room.current && room.board[room.current.cat].questions[room.current.idx];
}

// A question counts as finished when it was answered correctly or its answer was shown.
function finishQuestion(room, counts) {
  const every = room.settings.sparkleEvery;
  if (counts) {
    room.finished++;
    if (every && room.finished % every === 0) room.sparkleDue = true;
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
  room.teams = TEAM_DEFS.slice(0, n).map((d, i) => ({ id: i, ...d, name: room.teamNames[i], score: oldScores.get(i) || 0 }));
  shuffle([...room.players.values()]).forEach((p, i) => (p.teamId = i % n));
  buzz.resetBuzz(room.buzz);
  room.sparkle = null;
}

// A paired phone: gets the host view (answers included) and the Sparkle secret word.
function becomeRemote(sock, room, remoteId) {
  sock.data = { role: 'remote', code: room.code, remoteId };
  sock.join(room.code + ':host');
  sock.join(room.code + ':remote');
}

// A revoked remote: tell it, and stop sending it the host view.
function dropRemote(sock, code) {
  sock.emit('revoked');
  sock.leave(code + ':host');
  sock.leave(code + ':remote');
  sock.data = {};
}

// ---- Sockets ----
io.on('connection', (socket) => {
  // Host controls work on a socket that proved it knows the room's host secret (the TV),
  // or on a paired remote whose token hasn't been revoked. Players can never send them.
  const hostRoom = () => {
    const room = rooms.get(socket.data.code);
    if (!room) return null;
    if (socket.data.role === 'host') return room;
    if (socket.data.role === 'remote') {
      if (remotes.remoteById(room, socket.data.remoteId)) return room;
      dropRemote(socket, room.code); // revoked: this socket can't act any more
    }
    return null;
  };
  const tvRoom = () => (socket.data.role === 'host' ? rooms.get(socket.data.code) : null); // pairing is TV-only

  // Drop events beyond EVENTS_PER_SECOND on this socket.
  let windowStart = 0;
  let count = 0;
  socket.use((packet, next) => {
    const now = Date.now();
    if (now - windowStart > 1000) { windowStart = now; count = 0; }
    if (++count <= EVENTS_PER_SECOND) next();
  });

  // Every handler is wrapped, so a bad message can never crash the server.
  const on = (event, fn) => socket.on(event, (...args) => {
    try {
      Promise.resolve(fn(...args)).catch((err) => console.error(`Error in ${event}:`, err.message));
    } catch (err) {
      console.error(`Error in ${event}:`, err.message);
    }
  });
  const reply = (cb, value) => { if (typeof cb === 'function') cb(value); };

  // A game action from the TV or a remote. It must quote the current state version: if two devices
  // tap Correct at the same moment, the second one carries an old version and is ignored.
  // (+5 and the score − / + buttons are meant to be tapped repeatedly, so they skip the check.)
  const REPEATABLE = new Set(['host:funny', 'host:adjustScore']);
  const act = (event, fn) => on(event, (data, version) => {
    const room = hostRoom();
    if (!room) return;
    if (!REPEATABLE.has(event) && version !== room.version) {
      socket.emit('state', hostState(room)); // catch this device up; the tap is dropped
      return;
    }
    room.version++;
    fn(data);
    send(room);
  });

  // The theme cards for the setup screen.
  on('host:packs', (cb) => reply(cb, packSummaries()));

  // The community tags for the "Make your own" prompt. Empty when there's no database,
  // and then the prompt doesn't mention tags at all.
  on('host:tags', (cb) => reply(cb, { tags: db.tagNames() }));

  // "Share with community": a checked pack goes to the review queue (anyone can submit; you review it in /admin).
  on('community:submit', async (data, cb) => {
    if (typeof cb !== 'function') return;
    reply(cb, await community.submitPack(data, { ip: clientIp(socket) }));
  });

  // "Make your own": checks a pasted pack and sends back the cleaned pack plus a preview.
  // Changes nothing on the server (the PIN is asked at Start). Counted per game (when the host has one)
  // or per network, and only when hosted.
  on('host:checkPack', ({ text, code, secret, name } = {}, cb) => {
    const room = rooms.get(String(code || '').toUpperCase());
    const key = room && sameSecret(secret, room.hostSecret) ? 'room:' + room.code : 'ip:' + clientIp(socket);
    if (HOSTED && !packChecks.allow(key)) {
      return reply(cb, { ok: false, errors: ['Too many pack checks. Please wait 10 minutes and try again.'] });
    }
    if (typeof text !== 'string') return reply(cb, { ok: false, errors: ['Paste the pack first.'] });
    reply(cb, checkUploadedText(text, {
      fallbackName: typeof name === 'string' ? name : '',
      knownTags: db.enabled() ? db.tagNames() : null,
    }));
  });

  on('host:new', async (opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (HOST_PIN && !sameSecret(opts?.pin, HOST_PIN)) {
      return reply(cb, { ok: false, needPin: true, error: opts?.pin ? 'Wrong PIN. Try again.' : null });
    }
    // Only limited when hosted: on home wifi it's just your own laptop.
    if (HOSTED && !roomCreation.allow(clientIp(socket))) {
      return reply(cb, { ok: false, error: 'Too many new games from this network. Please wait 10 minutes and try again.' });
    }
    cleanupRooms();
    if (rooms.size >= MAX_ROOMS) {
      return reply(cb, { ok: false, error: 'Too many games are running right now. Please try again later.' });
    }
    const code = makeCode();
    const base = linkBase(socket);
    if (!base) return reply(cb, { ok: false, error: "This laptop isn't connected to wifi, so phones can't reach it. Connect to your home wifi and click New game again." });
    const joinUrl = `${base}/join/${code}`;
    let pack, settings, boards, decks, communityId = null;
    try {
      if (opts?.communityId != null) {
        // A community board: loaded from the database (approved only) and checked again.
        if (!db.enabled()) return reply(cb, { ok: false, error: 'Community boards aren\'t available right now.' });
        const loaded = await loadCommunityPack(opts.communityId);
        if (!loaded) return reply(cb, { ok: false, error: 'That community board isn\'t available any more. Pick another one.' });
        const { meta, ...clean } = loaded;
        pack = clean;
        communityId = meta.id;
      } else if (opts?.pack != null) {
        // An uploaded pack: never trusted, so checked again here with the strict rules. Kept only in this room.
        const res = validatePack(opts.pack, { kind: 'upload' });
        if (!res.ok) return reply(cb, { ok: false, error: 'That pack has problems: ' + res.errors.slice(0, 3).join(' ') });
        pack = res.pack;
      } else {
        const packId = THEMES.some((t) => t.id === opts?.packId) ? opts.packId : DEFAULT_PACK;
        pack = loadBuiltinPack(packId);
      }
      settings = gameSettings(opts, pack);
      boards = settings.boardIdx.map((bi, i) => chosenCategories(pack.boards[bi], settings.categories[i]));
      decks = decksFromPack(pack);
    } catch (err) {
      return reply(cb, { ok: false, error: 'Could not load the question pack: ' + err.message });
    }
    const boardNames = settings.boardIdx.map((bi) => pack.boards[bi].name);
    const publicSettings = { sparkleEvery: settings.sparkleEvery, modes: settings.modes, bonuses: settings.bonuses, double: settings.double };
    const room = {
      code, joinUrl, hostSecret: crypto.randomBytes(18).toString('base64url'), lastActive: Date.now(), players: new Map(), teams: [], buzz: buzz.newBuzz(),
      screen: 'lobby', packName: pack.name, packEmoji: pack.emoji || '', teamNames: teamNamesFor(pack), settings: publicSettings,
      boards, boardNames, usedBy: boards.map(() => []), boardNo: 0, doubles: pickDoubles(boards),
      board: boards[0], used: null, current: null, showAnswer: false,
      finished: 0, sparkleDue: false, reveal: null, bonus: null,
      decks, drawn: Object.fromEntries(DECK_KEYS.map((k) => [k, []])), sparkle: null,
      version: 0,
    };
    remotes.initRemotes(room);
    room.used = room.usedBy[0];
    room.qr = await QRCode.toDataURL(joinUrl, { margin: 1, width: 320 });
    // The host's previous game (if it proves it ran it) ends now, so its old link can't be rejoined by mistake.
    const old = rooms.get(String(opts?.replaces?.code || '').toUpperCase());
    const closeOld = old && sameSecret(opts.replaces.secret, old.hostSecret);
    if (closeOld) socket.leave(old.code + ':host'); // this socket is starting the new game; don't disconnect it
    if (closeOld) closeRoom(old.code, 'This game has ended. The host started a new one: scan the new QR code to join.');
    rooms.set(code, room);
    if (communityId) community.countPlay(communityId).catch((err) => console.error(`Couldn't count a play (${err.code || err.message}).`)); // once per new game
    socket.data = { role: 'host', code };
    socket.join(code + ':host');
    reply(cb, { ok: true, code, secret: room.hostSecret, qr: room.qr });
    send(room);
  });

  // Reconnecting host: needs the room code and the secret it got from host:new.
  on('host:resume', ({ code, secret } = {}, cb) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room || !sameSecret(secret, room.hostSecret)) return reply(cb, { ok: false });
    socket.data = { role: 'host', code: room.code };
    socket.join(room.code + ':host');
    reply(cb, { ok: true, code: room.code, secret: room.hostSecret, qr: room.qr });
    send(room);
  });

  act('host:makeTeams', (count) => {
    const room = hostRoom();
    if (!room) return;
    makeTeams(room, count);
    send(room);
  });

  act('host:movePlayer', ({ playerId, teamId }) => {
    const room = hostRoom();
    const p = room?.players.get(playerId);
    if (!p || !room.teams.some((t) => t.id === teamId)) return;
    p.teamId = teamId;
    send(room);
  });

  act('host:openBuzzers', () => {
    const room = hostRoom();
    if (!room) return;
    buzz.openBuzzers(room.buzz);
    send(room);
  });

  act('host:resetBuzzers', () => {
    const room = hostRoom();
    if (!room) return;
    buzz.resetBuzz(room.buzz);
    send(room);
  });

  // ---- Board and scoring ----
  act('host:screen', (screen) => {
    const room = hostRoom();
    if (!room || !['lobby', 'board', 'sparkle', 'winner'].includes(screen) || room.current || room.reveal || room.bonus) return;
    if (screen === 'sparkle' && !room.settings.sparkleEvery) return; // Sparkle is off for this game
    room.screen = screen;
    room.sparkle = screen === 'sparkle' ? newSparkle() : null;
    send(room);
  });

  // Switch boards; scores and each board's used tiles are kept.
  act('host:switchBoard', (n) => {
    const room = hostRoom();
    if (!room || room.current || room.reveal || room.bonus || !room.boards[n]) return;
    room.boardNo = n;
    room.board = room.boards[n];
    room.used = room.usedBy[n];
    send(room);
  });

  act('host:pickTile', ({ cat, idx } = {}) => {
    const room = hostRoom();
    if (!room || room.current || room.reveal || room.bonus || !room.board[cat]?.questions[idx] || room.used.includes(`${cat}-${idx}`)) return;
    // The hidden Double: worth 2x if right, costs 2x if wrong.
    room.current = { cat, idx, double: room.settings.double && room.doubles[room.boardNo] === `${cat}-${idx}` };
    room.showAnswer = false;
    buzz.resetBuzz(room.buzz);
    send(room);
  });

  act('host:correct', () => {
    const room = hostRoom();
    const turn = room && buzz.currentTurn(room.buzz);
    const team = turn && room.teams.find((t) => t.id === turn.teamId);
    if (!team) return;
    const q = currentQuestion(room);
    const points = q.value * (room.current.double ? 2 : 1);
    team.score += points;
    // First the answer (and fun fact) on the TV, then the bonus if there is one.
    const bonus = q.bonus && room.settings.bonuses ? { teamId: team.id, text: q.bonus, points: Number(q.bonusPoints) || 0 } : null;
    room.reveal = { answer: q.answer, funFact: q.funFact || null, teamId: team.id, points, bonus };
    finishQuestion(room, true);
    send(room);
  });

  act('host:wrong', () => {
    const room = hostRoom();
    const turn = room && buzz.currentTurn(room.buzz);
    const team = turn && room.teams.find((t) => t.id === turn.teamId);
    if (!team) return;
    team.score -= currentQuestion(room).value * (room.current.double ? 2 : 1);
    buzz.lockTeam(room.buzz, team.id); // next team in line gets the turn
    send(room);
  });

  act('host:showAnswer', () => {
    const room = hostRoom();
    const q = room && currentQuestion(room);
    if (!q) return;
    room.reveal = { answer: q.answer, funFact: q.funFact || null, teamId: null, points: 0, bonus: null };
    finishQuestion(room, true); // a shown answer counts toward the Sparkle Round
    send(room);
  });

  // From the reveal screen: on to the bonus, or back to the board.
  act('host:revealNext', () => {
    const room = hostRoom();
    const r = room?.reveal;
    if (!r) return;
    room.reveal = null;
    if (r.bonus) room.bonus = r.bonus;
    else goToBoard(room);
    send(room);
  });

  act('host:backToBoard', () => {
    const room = hostRoom();
    if (!room?.current) return;
    finishQuestion(room, false); // skipped without showing the answer: doesn't count toward the Sparkle Round
    goToBoard(room);
    send(room);
  });

  // 😂 +5 for a funny wrong answer. Any team, any number of times.
  act('host:funny', (teamId) => {
    const room = hostRoom();
    const team = room?.teams.find((t) => t.id === teamId);
    if (!team || !room.current) return;
    team.score += 5;
    send(room);
    flash(room, team.id, '+5 😂');
  });

  act('host:bonus', (done) => {
    const room = hostRoom();
    const b = room?.bonus;
    if (!b) return;
    if (done) room.teams.find((t) => t.id === b.teamId).score += b.points;
    room.bonus = null;
    goToBoard(room);
    send(room);
    if (done) flash(room, b.teamId, `+${b.points} ⭐`);
  });

  act('host:adjustScore', ({ teamId, delta } = {}) => {
    const room = hostRoom();
    const team = room?.teams.find((t) => t.id === teamId);
    if (!team || !Number.isFinite(delta) || Math.abs(delta) > 1000) return;
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

  act('host:sparkleTeam', (teamId) => {
    const room = sparkleRoom();
    if (!room || room.sparkle.cardIdx != null || !room.teams.some((t) => t.id === teamId)) return;
    room.sparkle.teamId = teamId;
    room.sparkle.performerId = null;
    send(room);
  });

  act('host:sparkleMode', (mode) => {
    const room = sparkleRoom();
    if (!room || room.sparkle.cardIdx != null || !room.settings.modes.includes(mode)) return;
    room.sparkle.mode = mode;
    room.sparkle.level = null;
    room.sparkle.empty = false;
    send(room);
  });

  // Draw only: the team picks a difficulty.
  act('host:sparkleLevel', (level) => {
    const room = sparkleRoom();
    const s = room?.sparkle;
    if (!s || s.cardIdx != null || s.mode !== 'draw' || !Object.hasOwn(DRAW_LEVELS, level)) return;
    s.level = level;
    s.empty = false;
    send(room);
  });

  act('host:sparklePerformer', (playerId) => {
    const room = sparkleRoom();
    const s = room?.sparkle;
    const p = room?.players.get(playerId);
    if (!s || s.cardIdx != null || !s.mode || (s.mode === 'draw' && !s.level) || p?.teamId !== s.teamId) return;
    s.performerId = playerId;
    drawCard(room);
    send(room);
  });

  act('host:skipCard', () => {
    const room = sparkleRoom();
    if (!room?.sparkle.performerId) return;
    drawCard(room);
    send(room);
  });

  act('host:timer', (action) => {
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
  act('host:sparklePoints', (points) => {
    const room = sparkleRoom();
    const s = room?.sparkle;
    points = Math.round(Number(points));
    if (!s || s.teamId == null || !Number.isFinite(points) || Math.abs(points) > 1000) return;
    awardSparkle(room, points);
  });

  // Draw: "Guessed" adds the card's difficulty points automatically.
  act('host:sparkleGuessed', () => {
    const room = sparkleRoom();
    const s = room?.sparkle;
    if (!s || s.mode !== 'draw' || s.cardIdx == null) return;
    awardSparkle(room, DRAW_LEVELS[s.level]);
  });

  // ---- Host remote (pairing) ----
  // The TV asks for a pairing QR. The code is in the URL's #fragment, so it's never sent in a page request.
  on('host:pairStart', async (cb) => {
    const room = tvRoom();
    if (!room) return reply(cb, { ok: false });
    if (!pairAttempts.allow('room:' + room.code)) return reply(cb, { ok: false, error: 'Too many pairing attempts. Wait a minute and try again.' });
    const res = remotes.startPairing(room);
    if (!res.ok) return reply(cb, res);
    const url = `${new URL(room.joinUrl).origin}/remote#pair=${res.code}`;
    reply(cb, { ok: true, qr: await QRCode.toDataURL(url, { margin: 1, width: 320 }), url, expiresAt: res.expiresAt });
    send(room);
  });

  on('host:pairCancel', () => {
    const room = tvRoom();
    if (!room?.pairing) return;
    const res = remotes.decidePairing(room, false);
    if (res.socketId) io.to(res.socketId).emit('pairDenied');
    send(room);
  });

  // The host clicked Allow or Deny on the TV.
  on('host:pairDecision', (allow) => {
    const room = tvRoom();
    if (!room?.pairing?.claimedBy) return;
    const res = remotes.decidePairing(room, allow === true);
    const phone = res.socketId && io.sockets.sockets.get(res.socketId);
    if (res.allowed && phone) {
      becomeRemote(phone, room, res.id);
      phone.emit('paired', { code: room.code, token: res.token });
    } else if (res.allowed) {
      remotes.removeRemote(room, res.id); // the phone left while waiting
    } else if (phone) phone.emit('pairDenied');
    send(room);
  });

  // "Disconnect remote(s)" on the TV: every remote token stops working now.
  on('host:revokeRemotes', () => {
    const room = tvRoom();
    if (!room) return;
    remotes.revokeAll(room);
    io.to(room.code + ':remote').emit('revoked');
    io.in(room.code + ':remote').socketsLeave(room.code + ':host');
    io.in(room.code + ':remote').socketsLeave(room.code + ':remote');
    send(room);
  });

  // A phone scanned the QR. It waits (no control) until the host clicks Allow on the TV.
  on('remote:pair', (code, cb) => {
    if (!pairAttempts.allow('ip:' + clientIp(socket))) return reply(cb, { ok: false, error: 'Too many tries. Wait a minute.' });
    const room = [...rooms.values()].find((r) => r.pairing && remotes.sameToken(r.pairing.code, code));
    if (!room) return reply(cb, { ok: false, error: 'This pairing code is old or wrong. Tap 📱 on the TV for a new one.' });
    if (!pairAttempts.allow('room:' + room.code)) return reply(cb, { ok: false, error: 'Too many tries. Wait a minute.' });
    const res = remotes.claimPairing(room, code, socket.id);
    if (!res.ok) {
      const why = { used: 'This code was already used.', expired: 'This code has expired.', full: 'This game already has 2 remotes.' }[res.error] || 'This pairing code is wrong.';
      return reply(cb, { ok: false, error: `${why} Tap 📱 on the TV for a new one.` });
    }
    reply(cb, { ok: true });
    send(room); // the TV now asks "Allow this phone?"
  });

  // A paired phone coming back (reload, or waking up): its saved token proves it's still allowed.
  on('remote:resume', ({ code, token } = {}, cb) => {
    const room = rooms.get(String(code || '').toUpperCase());
    const r = room && remotes.remoteByToken(room, token);
    if (!r) return reply(cb, { ok: false });
    becomeRemote(socket, room, r.id);
    reply(cb, { ok: true });
    send(room);
  });

  // "Disconnect this remote" on the phone.
  on('remote:leave', () => {
    const room = rooms.get(socket.data.code);
    if (socket.data.role !== 'remote' || !room) return;
    remotes.removeRemote(room, socket.data.remoteId);
    dropRemote(socket, room.code);
    send(room);
  });

  on('player:peek', (code, cb) => {
    const room = rooms.get(String(code || '').toUpperCase());
    reply(cb, room ? { ok: true, packName: room.packName, packEmoji: room.packEmoji } : { ok: false });
  });

  on('player:join', ({ code, playerId, name } = {}, cb) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return reply(cb, { ok: false, error: 'Game not found. Ask the host for the new code.' });
    name = cleanText(name, 20);
    playerId = cleanText(playerId, 40);
    if (!name || !playerId) return reply(cb, { ok: false, error: 'Please enter a name.' });

    let p = room.players.get(playerId);
    if (!p) {
      if (room.players.size >= MAX_PLAYERS) return reply(cb, { ok: false, error: `This game is full (${MAX_PLAYERS} players).` });
      p = { id: playerId, name, teamId: null }; // the host puts them in a team (Lobby / teams)
      room.players.set(playerId, p);
    }
    p.name = name;
    p.socketId = socket.id;
    p.connected = true;
    socket.data = { role: 'player', code: room.code, playerId };
    socket.join(room.code);
    reply(cb, { ok: true });
    send(room);
  });

  on('player:buzz', () => {
    const room = rooms.get(socket.data.code);
    const p = room?.players.get(socket.data.playerId);
    if (!p) return;
    if (buzz.tryBuzz(room.buzz, p.teamId, p.id)) send(room);
  });

  on('disconnect', () => {
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

// Community boards need a database. Without one (or if it can't be reached) everything else still works.
const dbReady = db.init().then((ok) => {
  console.log(ok ? '  Community boards: database connected.\n' : process.env.DATABASE_URL ? '' : '  Community boards: off (no DATABASE_URL).\n');
  return ok;
});

// 0.0.0.0 = listen on every network interface, so phones on the wifi can connect.
server.listen(PORT, '0.0.0.0', () => {
  console.log('\nBuzzIn is running!\n');
  if (PUBLIC_URL) return console.log(`  Hosted at ${PUBLIC_URL} (host page: ${PUBLIC_URL}/host)\n`);
  const ip = wifiIp();
  console.log(`  Open the host page on this laptop: http://localhost:${PORT}/host`);
  if (ip) {
    console.log(`  Laptop's wifi IP: ${ip}  (phones join at http://${ip}:${PORT}/join/CODE)\n`);
  } else {
    console.log("  ⚠️  Couldn't find a wifi IP. Connect this laptop to your home wifi before starting a game.\n");
  }
});
