// /admin API tests: login, origin checks and (with TEST_DATABASE_URL) the review flow.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');
const db = require('../db');
const community = require('../community');
const { adminRouter, samePin } = require('../admin');

const URL = process.env.TEST_DATABASE_URL || '';
const PIN = 'correct-horse-42';

// A tiny app with just the admin routes. Each call returns { status, body, cookie }.
async function server(t, opts = {}) {
  const app = express();
  app.use('/admin', adminRouter({ pin: PIN, ...opts }));
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  let cookie = '';
  const call = async (path, body, { origin = base, keepCookie = true, https = false } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (https) headers['X-Forwarded-Proto'] = 'https';
    if (cookie && keepCookie) headers.Cookie = cookie;
    if (origin) headers.Origin = origin;
    const res = await fetch(base + '/admin/api/' + path, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json(), setCookie: set };
  };
  return { call, base };
}

test('PIN comparison', () => {
  assert.ok(samePin(PIN, PIN));
  assert.ok(!samePin('wrong', PIN));
  assert.ok(!samePin('', PIN));
  assert.ok(!samePin(PIN, ''), 'no PIN set means no login');
  assert.ok(!samePin(undefined, PIN));
});

test('login: the session cookie is httpOnly, Secure (over HTTPS) and SameSite=Strict', async (t) => {
  const { call } = await server(t);
  const res = await call('login', { pin: PIN }, { https: true });
  assert.strictEqual(res.status, 200);
  assert.match(res.setCookie, /^buzzin_admin=[A-Za-z0-9_-]{43}; Path=\/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=43200$/);
  assert.strictEqual((await call('session')).body.loggedIn, true);
  await call('logout', {});
  assert.strictEqual((await call('session')).body.loggedIn, false);
});

test('login over plain http (local testing): no Secure flag, so Safari and wifi IPs keep the cookie', async (t) => {
  const { call } = await server(t);
  const res = await call('login', { pin: PIN });
  assert.strictEqual(res.status, 200);
  assert.match(res.setCookie, /^buzzin_admin=[A-Za-z0-9_-]{43}; Path=\/admin; HttpOnly; SameSite=Strict; Max-Age=43200$/);
  assert.strictEqual((await call('session')).body.loggedIn, true);
});

test('login: 6 wrong PINs in a row are rate limited (even the right one after)', async (t) => {
  const { call } = await server(t);
  for (let i = 0; i < 5; i++) assert.strictEqual((await call('login', { pin: 'nope' + i })).status, 401);
  const sixth = await call('login', { pin: 'nope' });
  assert.strictEqual(sixth.status, 429);
  assert.strictEqual((await call('login', { pin: PIN })).status, 429);
});

test('POSTs need the same origin and a session', async (t) => {
  const { call } = await server(t);
  assert.strictEqual((await call('login', { pin: PIN }, { origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await call('login', { pin: PIN }, { origin: null })).status, 403, 'no Origin header');
  assert.strictEqual((await call('tags', { name: 'X' })).status, 401, 'no session');
  assert.strictEqual((await call('login', { pin: PIN })).status, 200);
  assert.strictEqual((await call('tags', { name: 'Jeff' }, { origin: 'https://evil.example' })).status, 403, 'logged in, but from another site');
  assert.strictEqual((await call('tags', { name: 'X' }, { keepCookie: false })).status, 401);
});

test('sessions expire after 12 hours', async (t) => {
  let now = 1_000_000;
  const { call } = await server(t, { now: () => now });
  await call('login', { pin: PIN });
  now += 12 * 60 * 60 * 1000 - 1;
  assert.strictEqual((await call('session')).body.loggedIn, true);
  now += 2;
  assert.strictEqual((await call('session')).body.loggedIn, false);
});

test('no ADMIN_PIN: login is refused', async (t) => {
  const { call } = await server(t, { pin: '' });
  const res = await call('login', { pin: '' });
  assert.strictEqual(res.status, 503);
  assert.deepStrictEqual((await call('session')).body, { loggedIn: false, hasDb: false, hasPin: false });
});

test('review flow', { skip: !URL && 'set TEST_DATABASE_URL to run' }, async (t) => {
  const schema = `t_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: URL, ssl: db.sslFor(URL) });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await db.init({ url: URL, schema, log: { error: () => {} } });
  t.after(async () => { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

  const { call } = await server(t);
  assert.strictEqual((await call('login', { pin: PIN })).status, 200);

  assert.strictEqual((await call('codes')).status, 404, 'share codes are gone');

  const vals = [100, 200, 300, 400, 500];
  const pack = (seed, tags) => ({ format: 'buzz-pack-v2', name: `Board ${seed}`, tags, boards: [{ name: 'B1', categories: [1, 2, 3, 4, 5].map((c) => ({ name: `C${c}`, questions: vals.map((v) => ({ value: v, question: `${seed}-${c}-${v}?`, answer: 'A', verify: v === 500 })) })) }] });
  const sub = (seed, tags, chosen) => community.submitPack({ pack: pack(seed, tags), tags: chosen }, { ip: 'x' + seed });
  assert.ok((await sub(1, ['Anime'], ['Movies'])).ok);
  assert.ok((await sub(2, [], ['TV'])).ok);

  // Pending boards come with a full preview, oldest first.
  let pending = (await call('pending')).body.boards;
  assert.deepStrictEqual(pending.map((b) => b.name), ['Board 1', 'Board 2']);
  assert.strictEqual(pending[0].suggested_tag, 'Anime');
  assert.strictEqual(pending[0].boards[0].categories.length, 5);
  assert.strictEqual(pending[0].boards[0].categories[0].questions[4].verify, true);
  const [one, two] = pending;

  // Unknown suggested tag -> create it as a new tag -> it's in the next prompt's tag list.
  const anime = (await call('tags', { name: 'Anime', emoji: '🍥' })).body;
  assert.ok(db.tagNames().includes('Anime'), 'the prompt list refreshes straight away');
  assert.strictEqual((await call('tags', { name: 'anime' })).status, 409, 'no duplicate tag names');
  const tagsByName = Object.fromEntries((await call('tags')).body.tags.map((x) => [x.name, x.id]));
  assert.strictEqual((await call(`packs/${one.id}`, { tags: [tagsByName.Movies, anime.id], madeBy: 'Jeffrey', kidFriendly: true, suggestedTag: null })).status, 200);
  assert.strictEqual((await call(`packs/${one.id}`, { madeBy: 'jeff.com' })).status, 400);
  assert.strictEqual((await call(`packs/${one.id}`, { tags: [1, 2, 3, 4] })).status, 400);

  // Approve one, reject the other.
  assert.strictEqual((await call(`packs/${one.id}/approve`, {})).status, 200);
  assert.strictEqual((await call(`packs/${one.id}/approve`, {})).status, 409, 'already approved');
  assert.strictEqual((await call(`packs/${two.id}/reject`, { reason: 'Too short' })).status, 200);
  assert.deepStrictEqual((await call('pending')).body.boards, []);
  const row = (await db.query('SELECT status, made_by, kid_friendly, suggested_tag, reject_reason, reviewed_at FROM packs ORDER BY name')).rows;
  assert.deepStrictEqual(row.map((r) => [r.status, r.made_by, r.kid_friendly, r.suggested_tag, r.reject_reason, !!r.reviewed_at]),
    [['approved', 'Jeffrey', true, null, null, true], ['rejected', null, false, null, 'Too short', true]]);

  // Approved list, archive and unarchive.
  let approved = (await call('approved')).body.boards;
  assert.deepStrictEqual(approved.map((b) => [b.name, b.status]), [['Board 1', 'approved']]);
  assert.strictEqual((await call(`packs/${one.id}/archive`, {})).status, 200);
  approved = (await call('approved')).body.boards;
  assert.strictEqual(approved[0].status, 'archived');
  assert.strictEqual((await call(`packs/${one.id}/unarchive`, {})).status, 200);
  assert.strictEqual((await call(`packs/${two.id}/unarchive`, {})).status, 409, 'a rejected board can\'t be unarchived');
  assert.strictEqual((await call('packs/not-a-uuid/approve', {})).status, 404);

  // Tags: rename, merge (boards move over), delete only unused.
  assert.strictEqual((await call(`tags/${anime.id}`, { name: 'Anime & Manga', emoji: '🍥' })).status, 200);
  assert.strictEqual((await call(`tags/${tagsByName.Movies}/delete`, {})).status, 409, 'in use');
  assert.strictEqual((await call(`tags/${anime.id}/merge`, { into: tagsByName.Cartoons ?? tagsByName['Cartoons & Kids'] })).status, 200);
  const after = (await db.query('SELECT t.name FROM pack_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.pack_id = $1 ORDER BY t.name', [one.id])).rows.map((r) => r.name);
  assert.deepStrictEqual(after, ['Cartoons & Kids', 'Movies']);
  assert.ok(!db.tagNames().includes('Anime & Manga'));
  assert.strictEqual((await call(`tags/${tagsByName.Gaming}/delete`, {})).status, 200, 'unused');
});
