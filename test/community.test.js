// Sharing boards. The database parts run only when TEST_DATABASE_URL is set (throwaway schema).
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { Pool } = require('pg');
const db = require('../db');
const c = require('../community');

const URL = process.env.TEST_DATABASE_URL || '';
const quiet = { error: () => {} };

let n = 0;
// A valid upload pack; `seed` makes its questions (and so its content hash) unique.
function pack(seed = ++n, extra = {}) {
  const vals = [100, 200, 300, 400, 500];
  return {
    format: 'buzz-pack-v2', name: `Pack ${seed}`, emoji: '🧪', teams: ['Team A', 'Team B'],
    tags: ['Movies'], kidFriendly: true, ...extra,
    boards: [{ name: 'Board one', categories: [1, 2, 3, 4, 5].map((ci) => ({
      name: `Cat ${ci}`, note: 'Name it.',
      questions: vals.map((v) => ({ value: v, question: `Seed ${seed} Q${ci}-${v}?`, answer: 'Ans', bonus: 'Clap', bonusPoints: 50 })),
    })) }],
  };
}

test('the duplicate check ignores the name, tags, case and spacing, but not the questions', () => {
  const a = pack(1);
  const b = pack(1, { name: 'Another name', tags: ['TV'] });
  b.boards[0].categories[0].questions[0].question = '  SEED 1   q1-100? ';
  assert.strictEqual(c.contentHash(a), c.contentHash(b));
  assert.notStrictEqual(c.contentHash(a), c.contentHash(pack(2)));
});

test('"Made by" is cleaned; links are refused; empty means anonymous', () => {
  assert.deepStrictEqual(c.cleanMadeBy('  Asha \n'), { value: 'Asha' });
  assert.deepStrictEqual(c.cleanMadeBy(''), { value: null });
  assert.deepStrictEqual(c.cleanMadeBy(undefined), { value: null });
  assert.deepStrictEqual(c.cleanMadeBy('<b>Jeff</b>'), { value: '<b>Jeff</b>' }, 'kept as text, shown as text');
  for (const bad of ['jeff.com', 'see www.x.org', 'https://evil.example', 'mysite.io/me']) assert.match(c.cleanMadeBy(bad).error, /link/);
  assert.match(c.cleanMadeBy('x'.repeat(31)).error, /too long/);
});

test('without a database, sharing is refused politely', async () => {
  assert.deepStrictEqual(await c.submitPack({ pack: pack() }), { ok: false, error: 'Sharing isn\'t available right now.' });
});

test('submitting for review', { skip: !URL && 'set TEST_DATABASE_URL to run' }, async (t) => {
  const schema = `t_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: URL, ssl: db.sslFor(URL) });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await db.init({ url: URL, schema, log: quiet });
  t.after(async () => { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

  const submit = (p, more = {}, ip = '10.0.0.1') => c.submitPack({ pack: p, madeBy: 'Jeff', tags: ['Movies', 'TV'], kidFriendly: true, ...more }, { ip });

  await t.test('a good submission is saved as pending, one row per category', async () => {
    const p = pack(100, { tags: ['movies', 'Bollywood Nights'] });
    const res = await submit(p, { madeBy: '<i>Jeff</i>' });
    assert.deepStrictEqual(res, { ok: true, message: 'Thanks! It\'ll appear in Community once it\'s approved.' });
    const row = (await db.query('SELECT * FROM packs')).rows[0];
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(row.made_by, '<i>Jeff</i>');
    assert.strictEqual(row.suggested_tag, 'Bollywood Nights');
    assert.strictEqual(row.kid_friendly, true);
    assert.deepStrictEqual(row.board_names, ['Board one']);
    assert.deepStrictEqual(row.teams, ['Team A', 'Team B']);
    const cats = (await db.query('SELECT board_index, position, name, description, is_default, questions FROM categories WHERE pack_id = $1 ORDER BY position', [row.id])).rows;
    assert.strictEqual(cats.length, 5);
    assert.deepStrictEqual([cats[2].board_index, cats[2].position, cats[2].name, cats[2].description, cats[2].is_default], [0, 2, 'Cat 3', 'Name it.', true]);
    assert.strictEqual(cats[0].questions.length, 5);
    const tags = (await db.query('SELECT t.name FROM pack_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.pack_id = $1 ORDER BY t.name', [row.id])).rows.map((r) => r.name);
    assert.deepStrictEqual(tags, ['Movies', 'TV'], 'the tags the person ticked');
  });

  await t.test('a duplicate pack is refused, even renamed', async () => {
    const res = await submit(pack(100, { name: 'Renamed' }), {}, '10.0.0.2');
    assert.strictEqual(res.error, 'This board has already been shared.');
  });

  await t.test('the form is checked: tags, made by, and the pack itself', async () => {
    assert.match((await submit(pack(), { tags: [] }, '10.0.0.4')).error, /at least 1 tag/);
    assert.match((await submit(pack(), { tags: ['Movies', 'TV', 'Music', 'Food'] }, '10.0.0.4')).error, /at most 3/);
    assert.match((await submit(pack(), { tags: ['Made Up'] }, '10.0.0.4')).error, /no longer exists/);
    assert.match((await submit(pack(), { madeBy: 'jeff.com' }, '10.0.0.4')).error, /link/);
    const broken = pack(); broken.boards[0].categories.pop();
    const res = await submit(broken, {}, '10.0.0.4');
    assert.match(res.error, /problems/);
    assert.match(res.errors[0], /categories/);
  });

  await t.test('anyone can submit: no code needed', async () => {
    assert.ok((await c.submitPack({ pack: pack(), tags: ['TV'] }, { ip: '10.0.1.1' })).ok);
  });

  await t.test('6th submission from one network in a day is refused (failed ones don\'t count)', async () => {
    assert.ok(!(await submit(pack(), { tags: [] }, '10.0.2.1')).ok);
    let ok = 0;
    for (let i = 0; i < 5; i++) ok += (await submit(pack(), {}, '10.0.2.1')).ok ? 1 : 0;
    assert.strictEqual(ok, 5);
    assert.match((await submit(pack(), {}, '10.0.2.1')).error, /shared 5 boards today/);
    assert.ok((await submit(pack(), {}, '10.0.2.2')).ok, 'another network is fine');
  });

  await t.test('the review queue holds at most 100 boards', async () => {
    const have = (await db.query("SELECT count(*)::int AS n FROM packs WHERE status = 'pending'")).rows[0].n;
    for (let i = have; i < c.MAX_PENDING; i++) {
      await db.query("INSERT INTO packs (name, content_hash) VALUES ('Filler', $1)", [`filler-${i}`]);
    }
    assert.strictEqual((await submit(pack(), {}, '10.0.4.1')).error, 'The review queue is full, try again later.');
  });
});

test('public: only approved boards are listed or loadable', { skip: !URL && 'set TEST_DATABASE_URL to run' }, async (t) => {
  const { validatePack } = require('../pack');
  const schema = `t_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: URL, ssl: db.sslFor(URL) });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await db.init({ url: URL, schema, log: quiet });
  t.after(async () => { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

  let ip = 0;
  const share = async (p, tags, extra = {}) => {
    assert.ok((await c.submitPack({ pack: p, tags, madeBy: 'Secret Sam', ...extra }, { ip: `ip${++ip}` })).ok);
    return (await db.query('SELECT id FROM packs WHERE content_hash = $1', [c.contentHash(validatePack(p).pack)])).rows[0].id;
  };
  const shareAny = share;

  const spooky = await shareAny(pack(201, { name: 'Spooky <Night>', sparkle: { charades: ['Ghost'] } }), ['Holidays'], { kidFriendly: false });
  const toons = await shareAny(pack(202, { name: 'Saturday Toons' }), ['Cartoons & Kids', 'TV'], { kidFriendly: true });
  const pending = await shareAny(pack(203, { name: 'Still Pending' }), ['TV']);

  // Nothing is public until approved.
  assert.deepStrictEqual(await c.publicTags(), { total: 0, tags: [] });
  assert.deepStrictEqual((await c.listBoards()).boards, []);
  assert.strictEqual(await c.loadPack(spooky), null);
  assert.strictEqual(await c.randomBoard(), null);

  await db.query("UPDATE packs SET status = 'approved', reviewed_at = now() WHERE id = ANY($1::uuid[])", [[spooky, toons]]);
  const tags = await c.publicTags();
  assert.strictEqual(tags.total, 2);
  assert.deepStrictEqual(tags.tags.map((x) => [x.name, x.boards]), [['Cartoons & Kids', 1], ['Holidays', 1], ['TV', 1]], 'only tags with approved boards (the pending TV board isn\'t counted)');

  const all = (await c.listBoards()).boards;
  assert.deepStrictEqual(all.map((b) => b.name).sort(), ['Saturday Toons', 'Spooky <Night>']);
  assert.ok(!all.some((b) => b.id === pending));
  const toonsCard = all.find((b) => b.id === toons);
  assert.deepStrictEqual(Object.keys(toonsCard).sort(), ['emoji', 'id', 'kidFriendly', 'madeBy', 'name', 'playCount', 'tags']);
  assert.deepStrictEqual(toonsCard.tags.map((x) => x.slug), ['cartoons-and-kids', 'tv']);

  // Filters: tag, search, kid-friendly; Surprise me respects tag + kid-friendly.
  assert.deepStrictEqual((await c.listBoards({ tag: 'holidays' })).boards.map((b) => b.id), [spooky]);
  assert.deepStrictEqual((await c.listBoards({ q: 'toon' })).boards.map((b) => b.id), [toons]);
  assert.deepStrictEqual((await c.listBoards({ q: '%' })).boards, [], '% is plain text, not a wildcard');
  assert.deepStrictEqual((await c.listBoards({ kid: '1' })).boards.map((b) => b.id), [toons]);
  assert.deepStrictEqual((await c.listBoards({ tag: "x' OR 1=1 --" })).boards.length, 2, 'a bad tag is ignored, not run');
  for (let i = 0; i < 5; i++) assert.strictEqual(await c.randomBoard({ kid: '1' }), toons);
  assert.strictEqual(await c.randomBoard({ tag: 'holidays', kid: '1' }), null);

  // A board loads as a pack that passes the strict upload rules, without its review details.
  const loaded = await c.loadPack(spooky);
  const checked = validatePack(loaded.pack, { kind: 'upload' });
  assert.ok(checked.ok, checked.errors?.join('\n'));
  assert.strictEqual(checked.pack.boards[0].categories[0].note, 'Name it.');
  assert.deepStrictEqual(checked.pack.sparkle.charades, ['Ghost']);
  assert.ok(!('status' in loaded.meta));

  // Plays count; archived boards disappear; bad ids are just "not found".
  await c.countPlay(toons);
  await c.countPlay(toons);
  assert.strictEqual((await c.listBoards()).boards[0].id, toons, 'most played first');
  assert.strictEqual((await c.listBoards()).boards[0].playCount, 2);
  await c.countPlay(pending);
  assert.strictEqual((await db.query('SELECT play_count FROM packs WHERE id = $1', [pending])).rows[0].play_count, 0, 'pending boards can\'t be played');
  await db.query("UPDATE packs SET status = 'archived' WHERE id = $1", [spooky]);
  assert.deepStrictEqual((await c.listBoards()).boards.map((b) => b.id), [toons]);
  assert.strictEqual(await c.loadPack(spooky), null);
  assert.strictEqual(await c.loadPack('not-a-uuid'), null);
  assert.strictEqual(await c.loadPack('00000000-0000-0000-0000-000000000000'), null);

  // Paging: 20 at a time.
  await db.query(`INSERT INTO packs (name, content_hash, status) SELECT 'Filler ' || g, 'fill-' || g, 'approved' FROM generate_series(1, 25) g`);
  const p0 = await c.listBoards({ page: 0 });
  const p1 = await c.listBoards({ page: '1' });
  assert.deepStrictEqual([p0.boards.length, p0.more, p1.boards.length, p1.more], [20, true, 6, false]);
});
