const test = require('node:test');
const assert = require('node:assert');
const r = require('../remote');

const newRoom = () => { const room = { code: 'ABCD' }; r.initRemotes(room); return room; };

test('pairing: a phone must claim the code AND the host must click Allow', () => {
  const room = newRoom();
  const { code } = r.startPairing(room, 0);
  assert.ok(r.claimPairing(room, code, 'phone-1', 1000).ok);
  assert.strictEqual(room.remotes.length, 0, 'claiming alone gives no control');
  assert.deepStrictEqual(r.pairingStatus(room, 1000), { waitingForAllow: true, expiresAt: r.PAIR_MS });
  const res = r.decidePairing(room, true);
  assert.ok(res.allowed && res.token && res.socketId === 'phone-1');
  assert.strictEqual(r.remoteByToken(room, res.token).id, res.id);
  assert.strictEqual(r.pairingStatus(room), null, 'the code is finished');
  assert.strictEqual(res.token.length, 22, '128-bit token, base64url');
});

test('pairing: Deny gives no token', () => {
  const room = newRoom();
  const { code } = r.startPairing(room, 0);
  r.claimPairing(room, code, 'phone-1', 0);
  const res = r.decidePairing(room, false);
  assert.strictEqual(res.allowed, false);
  assert.strictEqual(res.token, undefined);
  assert.strictEqual(room.remotes.length, 0);
});

test('pairing: an expired, reused, wrong or replaced code is refused', () => {
  const room = newRoom();
  const { code } = r.startPairing(room, 0);
  assert.strictEqual(r.claimPairing(room, code, 'p', r.PAIR_MS).error, 'expired');

  const second = r.startPairing(room, 0).code;
  assert.ok(r.claimPairing(room, second, 'p1', 10).ok);
  assert.strictEqual(r.claimPairing(room, second, 'p2', 20).error, 'used', 'single use');
  const wrong = (second[0] === 'A' ? 'B' : 'A') + second.slice(1); // same length, one character off
  assert.strictEqual(r.claimPairing(room, wrong, 'p3', 20).error, 'invalid');

  const third = r.startPairing(room, 0).code;
  r.startPairing(room, 0); // a newer QR replaces it
  assert.strictEqual(r.claimPairing(room, third, 'p4', 10).error, 'invalid');
});

test('at most 2 remotes; revoking or leaving makes tokens useless', () => {
  const room = newRoom();
  const pair = (sock) => { const { code } = r.startPairing(room, 0); r.claimPairing(room, code, sock, 0); return r.decidePairing(room, true); };
  const a = pair('a');
  const b = pair('b');
  assert.strictEqual(room.remotes.length, 2);
  assert.strictEqual(r.startPairing(room, 0).ok, false, 'a third remote is refused');

  r.removeRemote(room, a.id);
  assert.strictEqual(r.remoteByToken(room, a.token), null);
  assert.ok(r.remoteByToken(room, b.token));

  r.revokeAll(room);
  assert.strictEqual(r.remoteByToken(room, b.token), null);
  assert.strictEqual(room.remotes.length, 0);
});

test('tokens are compared safely and never match empty or wrong values', () => {
  assert.ok(r.sameToken('abc', 'abc'));
  assert.ok(!r.sameToken('abc', 'abd'));
  assert.ok(!r.sameToken('', ''));
  assert.ok(!r.sameToken(undefined, undefined));
  assert.ok(!r.sameToken('abc', 'abcd'));
});
