// ⭐ Featured extras: categories from shared boards added to a Featured theme (runs with TEST_DATABASE_URL).
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');
const db = require('../db');
const community = require('../community');
const featured = require('../featured');
const { adminRouter } = require('../admin');
const { BOARD_VALUES, defaultCategories, chosenCategories } = require('../pack');

const URL = process.env.TEST_DATABASE_URL || '';
const PIN = 'featured-pin-42';

// A shared board with 2 boards; category names start with `prefix`.
const board = (prefix, n = 5) => ({
  format: 'buzz-pack-v2', name: `${prefix} board`,
  boards: [0, 1].map((bi) => ({
    name: `${prefix} round ${bi + 1}`,
    categories: Array.from({ length: n }, (_, ci) => ({
      name: `${prefix} ${bi + 1}.${ci + 1}`, note: 'Name it.',
      questions: BOARD_VALUES[bi].map((v, qi) => ({ value: v, question: `${prefix} b${bi} c${ci} q${qi}?`, answer: `A${qi}`, bonus: 'Clap', bonusPoints: 50 })),
    })),
  })),
});

test('without a database, a Featured theme is just its file', () => {
  assert.deepStrictEqual(featured.loadBuiltinPack('sports'), featured.loadFilePack('sports'));
});

test('⭐ add categories to Featured, play them, the 8 limit, and Remove', { skip: !URL && 'set TEST_DATABASE_URL to run' }, async (t) => {
  const schema = `t_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: URL, ssl: db.sslFor(URL) });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await db.init({ url: URL, schema, log: { error: () => {} } });
  t.after(async () => { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

  const app = express();
  app.use(express.json());
  app.use('/admin', adminRouter({ pin: PIN }));
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  let cookie = '';
  const call = async (path, body) => {
    const headers = { 'Content-Type': 'application/json', Origin: base };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(`${base}/admin/api/${path}`, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  assert.strictEqual((await call('featured')).status, 401, 'admin only');
  assert.strictEqual((await call('login', { pin: PIN })).status, 200);

  // A pending shared board, and its category ids (as the review queue shows them).
  assert.ok((await community.submitPack({ pack: board('Space'), tags: ['Movies'] }, { ip: 'f1' })).ok);
  const pending = (await call('pending')).body.boards[0];
  const [b1, b2] = pending.boards.map((bd) => bd.categories.map((c) => c.id));
  assert.ok(b1.every(Number.isInteger) && b2.every(Number.isInteger), 'the review queue includes category ids');

  const fileSports = featured.loadFilePack('sports');
  const room = async (themeId, bi) => (await call('featured')).body.themes.find((x) => x.id === themeId).boards[bi];
  const fileCount = fileSports.boards[1].categories.length; // 6
  assert.deepStrictEqual(await room('sports', 1), { index: 1, name: fileSports.boards[1].name, categories: fileCount, free: 8 - fileCount, extras: [] });
  assert.strictEqual((await room('desi', 1)).free, 0, 'Desi Life is already full');

  // Add 2 Board 1 categories (100–500) to Sports board 2 (200–1000), in the order given.
  const add = (themeId, boardIndex, categoryIds) => call('featured', { themeId, boardIndex, categoryIds });
  const ok = await add('sports', 1, [b1[3], b1[0]]);
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.match(ok.body.message, /Added 2 categories to Sports › .+\. They're optional in Customise\./);

  // Customise: the theme now lists them at the end, off by default, with the target board's points.
  const sports = featured.loadBuiltinPack('sports');
  const cats = sports.boards[1].categories;
  assert.strictEqual(cats.length, 8);
  assert.deepStrictEqual(cats.slice(-2).map((c) => c.name), ['Space 1.4', 'Space 1.1']);
  for (const c of cats.slice(-2)) {
    assert.deepStrictEqual(c.questions.map((q) => q.value), BOARD_VALUES[1], 'points re-mapped by question order');
    assert.strictEqual(c.note, 'Name it.');
    assert.strictEqual(c.questions[0].bonus, 'Clap');
  }
  assert.deepStrictEqual(cats.slice(-2)[0].questions.map((q) => q.question), BOARD_VALUES[0].map((_, qi) => `Space b0 c3 q${qi}?`));
  assert.deepStrictEqual(defaultCategories(sports.boards[1]).map((c) => c.name), defaultCategories(fileSports.boards[1]).map((c) => c.name), 'defaults unchanged: extras are optional');
  assert.deepStrictEqual(sports.boards[0].categories.length, fileSports.boards[0].categories.length, 'the other board is untouched');

  // Playing: the host ticks an extra in Customise and it's on the game board with those points.
  const played = chosenCategories(sports.boards[1], [0, 1, 2, 3, 6]);
  assert.strictEqual(played[4].category, 'Space 1.4');
  assert.deepStrictEqual(played[4].questions.map((q) => q.value), [200, 400, 600, 800, 1000]);

  // The other direction: a Board 2 category (200–1000) onto a Board 1 (100–500).
  assert.strictEqual((await add('world', 0, [b2[0]])).status, 200);
  const world = featured.loadBuiltinPack('world').boards[0].categories.at(-1);
  assert.deepStrictEqual([world.name, world.questions.map((q) => q.value)], ['Space 2.1', [100, 200, 300, 400, 500]]);

  // The 8 limit: a 9th is blocked, so is ticking more than the room left. Nothing is added.
  let res = await add('sports', 1, [b1[1]]);
  assert.deepStrictEqual([res.status, res.body.error], [409, `Sports › ${fileSports.boards[1].name} is full (8 categories). Remove one of its extras first.`]);
  res = await add('desi', 1, [b1[1]]);
  assert.match(res.body.error, /is full \(8 categories\)/);
  res = await add('tv', 0, [b1[0], b1[1], b1[2], b1[4]]);
  assert.deepStrictEqual([res.status, res.body.error], [409, 'TV & Movies › Shows has room for 3 more categories (it has 5 of 8). Tick fewer.']);
  assert.strictEqual(featured.loadBuiltinPack('tv').boards[0].categories.length, 5);

  // Repeats: the same category twice, or a name the board already has.
  res = await add('world', 0, [b2[0]]);
  assert.match(res.body.error, /"Space 2.1" is already on World Trivia/);
  assert.ok((await community.submitPack({ pack: { ...board('Space'), name: 'Copycat', boards: board('Space').boards.map((bd) => ({ ...bd, categories: bd.categories.map((c) => ({ ...c, questions: c.questions.map((q) => ({ ...q, question: 'Other ' + q.question })) })) })) }, tags: ['TV'] }, { ip: 'f2' })).ok);
  const copycat = (await call('pending')).body.boards.find((b) => b.name === 'Copycat');
  res = await add('world', 0, [copycat.boards[1].categories[0].id]);
  assert.match(res.body.error, /already has a category called "Space 2.1"/);
  const fileWorldName = featured.loadFilePack('world').boards[0].categories[0].name;
  await db.query('UPDATE categories SET name = $1 WHERE id = $2', [fileWorldName, copycat.boards[0].categories[0].id]);
  res = await add('world', 0, [copycat.boards[0].categories[0].id]);
  assert.match(res.body.error, /already has a category called/, 'a file category name counts too');

  // Bad input.
  assert.strictEqual((await add('nope', 0, [b1[1]])).status, 400);
  assert.strictEqual((await add('sports', 2, [b1[1]])).status, 400);
  assert.strictEqual((await add('sports', 0, [])).status, 400);
  assert.strictEqual((await add('sports', 0, [999999])).status, 404);
  assert.strictEqual((await add('sports', 0, [b1[1], b1[1]])).status, 400);

  // The shared board's status is unchanged, and it can still be approved (or rejected) afterwards.
  assert.strictEqual((await db.query('SELECT status FROM packs WHERE id = $1', [pending.id])).rows[0].status, 'pending');
  const tagId = (await call('tags')).body.tags.find((x) => x.name === 'Movies').id;
  assert.strictEqual((await call(`packs/${pending.id}`, { tags: [tagId] })).status, 200);
  assert.strictEqual((await call(`packs/${pending.id}/approve`, {})).status, 200);

  // Each extra is its own copy: deleting the shared board doesn't take it out of Featured.
  await db.query('DELETE FROM packs WHERE id = $1', [pending.id]);
  await db.refreshExtras();
  assert.strictEqual(featured.loadBuiltinPack('sports').boards[1].categories.length, 8);
  const listed = (await room('sports', 1)).extras;
  assert.deepStrictEqual(listed.map((x) => [x.name, x.fromBoard]), [['Space 1.4', null], ['Space 1.1', null]]);

  // Remove: gone from the theme (and Customise), the slot is free again.
  assert.strictEqual((await call(`featured/${listed[0].id}/remove`, {})).status, 200);
  assert.deepStrictEqual(featured.loadBuiltinPack('sports').boards[1].categories.slice(-1).map((c) => c.name), ['Space 1.1']);
  assert.strictEqual((await room('sports', 1)).free, 1);
  assert.strictEqual((await call(`featured/${listed[0].id}/remove`, {})).status, 404, 'already gone');
  assert.strictEqual((await call('featured/abc/remove', {})).status, 404);
  assert.strictEqual((await call(`featured/${listed[1].id}/remove`, {})).status, 200);
  assert.deepStrictEqual(featured.loadBuiltinPack('sports'), featured.loadFilePack('sports'), 'back to just the file');
});
