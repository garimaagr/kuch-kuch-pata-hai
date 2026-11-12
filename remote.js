// Host remote: pairing a phone so the host can run the game privately from it.
// Pure room bookkeeping (no sockets), so it can be tested directly.
//
// 1. The TV starts pairing: a random, single-use code that expires in 2 minutes (shown as a QR).
// 2. A phone claims the code. It now waits: nothing is allowed until the host clicks Allow on the TV.
// 3. Allow gives that phone its own random remote token (separate from the host secret).
// Revoking, or the game ending, makes every token useless at once.

const crypto = require('crypto');

const PAIR_MS = 2 * 60 * 1000;
const MAX_REMOTES = 2; // the host plus a co-host

const newToken = () => crypto.randomBytes(16).toString('base64url'); // 128 bits

// Constant-time comparison, so a token can't be guessed one character at a time.
function sameToken(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function initRemotes(room) {
  room.remotes = []; // [{ id, token }]
  room.pairing = null; // { code, expiresAt, claimedBy: socketId | null }
}

// The TV asks for a new pairing code. Any earlier, unused code stops working.
function startPairing(room, now = Date.now()) {
  if (room.remotes.length >= MAX_REMOTES) return { ok: false, error: `Already ${MAX_REMOTES} remotes connected. Disconnect one first.` };
  room.pairing = { code: newToken(), expiresAt: now + PAIR_MS, claimedBy: null };
  return { ok: true, code: room.pairing.code, expiresAt: room.pairing.expiresAt };
}

// Is this the room's live, unused pairing code?
function pairingMatches(room, code, now = Date.now()) {
  const p = room.pairing;
  return !!p && !p.claimedBy && now < p.expiresAt && sameToken(p.code, code);
}

// A phone presents the code. Single use: after this, the same code is refused.
function claimPairing(room, code, socketId, now = Date.now()) {
  const p = room.pairing;
  if (!p || !sameToken(p.code, code)) return { ok: false, error: 'invalid' };
  if (p.claimedBy) return { ok: false, error: 'used' };
  if (now >= p.expiresAt) { room.pairing = null; return { ok: false, error: 'expired' }; }
  if (room.remotes.length >= MAX_REMOTES) return { ok: false, error: 'full' };
  p.claimedBy = socketId;
  return { ok: true };
}

// The host clicked Allow (or Deny) on the TV. Allow returns the new remote's id and token.
function decidePairing(room, allow) {
  const p = room.pairing;
  room.pairing = null; // the code is finished either way
  if (!p?.claimedBy) return { ok: false };
  if (!allow) return { ok: true, allowed: false, socketId: p.claimedBy };
  if (room.remotes.length >= MAX_REMOTES) return { ok: false, socketId: p.claimedBy };
  const remote = { id: newToken().slice(0, 10), token: newToken() };
  room.remotes.push(remote);
  return { ok: true, allowed: true, socketId: p.claimedBy, id: remote.id, token: remote.token };
}

const remoteByToken = (room, token) => room.remotes.find((r) => sameToken(r.token, token)) || null;
const remoteById = (room, id) => room.remotes.find((r) => r.id === id) || null;
const removeRemote = (room, id) => { room.remotes = room.remotes.filter((r) => r.id !== id); };
const revokeAll = (room) => { room.remotes = []; room.pairing = null; };

// What the TV and remotes may know about pairing: never the code itself.
function pairingStatus(room, now = Date.now()) {
  const p = room.pairing;
  if (!p || (!p.claimedBy && now >= p.expiresAt)) return null;
  return { waitingForAllow: !!p.claimedBy, expiresAt: p.expiresAt };
}

module.exports = {
  PAIR_MS, MAX_REMOTES, newToken, sameToken, initRemotes, startPairing, pairingMatches, claimPairing,
  decidePairing, remoteByToken, remoteById, removeRemote, revokeAll, pairingStatus,
};
