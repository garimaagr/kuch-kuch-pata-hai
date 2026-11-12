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

test('share codes look right, ignore case and dashes, and are stored only as a hash', () => {
  const code = c.newShareCode();
  assert.match(code, /^BUZZ-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.strictEqual(c.hashCode(code), c.hashCode(code.toLowerCase().replace(/-/g, ' ')));
  assert.strictEqual(c.hashCode(code), c.hashCode(code.slice(5)), 'the BUZZ- part is optional');
  assert.notStrictEqual(c.hashCode(code), c.hashCode(c.newShareCode()));
  assert.ok(!c.hashCode(code).includes(code));
});

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

  const jeff = await c.createShareCode('Jeff');
  assert.ok(jeff.ok && /^BUZZ-/.test(jeff.code));
  const stored = await db.query('SELECT code_hash, label, uses FROM share_codes WHERE id = $1', [jeff.id]);
  assert.notStrictEqual(stored.rows[0].code_hash, jeff.code, 'only the hash is stored');
  const submit = (p, more = {}, ip = '10.0.0.1') => c.submitPack({ pack: p, shareCode: jeff.code, madeBy: 'Jeff', tags: ['Movies', 'TV'], kidFriendly: true, ...more }, { ip });

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
    assert.strictEqual((await db.query('SELECT uses FROM share_codes WHERE id = $1', [jeff.id])).rows[0].uses, 1);
  });

  await t.test('a duplicate pack is refused, even renamed', async () => {
    const res = await submit(pack(100, { name: 'Renamed' }), {}, '10.0.0.2');
    assert.strictEqual(res.error, 'This board has already been shared.');
  });

  await t.test('a bad share code, or a revoked one, is refused', async () => {
    assert.match((await submit(pack(), { shareCode: 'BUZZ-AAAA-AAAA' }, '10.0.0.3')).error, /isn't valid/);
    assert.match((await submit(pack(), { shareCode: '' }, '10.0.0.3')).error, /isn't valid/);
    const old = await c.createShareCode('Old');
    await db.query('UPDATE share_codes SET active = false WHERE id = $1', [old.id]);
    assert.match((await submit(pack(), { shareCode: old.code }, '10.0.0.3')).error, /isn't valid/);
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

  await t.test('a 4th submission with the same code in a day is refused', async () => {
    assert.ok((await submit(pack(), {}, '10.0.1.1')).ok); // 2nd today (1st was the good submission)
    assert.ok((await submit(pack(), {}, '10.0.1.2')).ok); // 3rd
    assert.match((await submit(pack(), {}, '10.0.1.3')).error, /used 3 times today/);
  });

  await t.test('6th submission from one network in a day is refused', async () => {
    const codes = await Promise.all([1, 2].map((i) => c.createShareCode(`Net ${i}`)));
    let ok = 0;
    for (let i = 0; i < 5; i++) ok += (await submit(pack(), { shareCode: codes[i % 2].code }, '10.0.2.1')).ok ? 1 : 0;
    assert.strictEqual(ok, 5);
    assert.match((await submit(pack(), { shareCode: codes[0].code }, '10.0.2.1')).error, /shared 5 boards today/);
  });

  await t.test('wrong codes are rate limited per network', async () => {
    for (let i = 0; i < 10; i++) await submit(pack(), { shareCode: `BUZZ-WRNG-${String(i).padStart(4, 'X')}` }, '10.0.3.1');
    assert.match((await submit(pack(), {}, '10.0.3.1')).error, /Too many wrong share codes/);
  });

  await t.test('the review queue holds at most 100 boards', async () => {
    const have = (await db.query("SELECT count(*)::int AS n FROM packs WHERE status = 'pending'")).rows[0].n;
    for (let i = have; i < c.MAX_PENDING; i++) {
      await db.query("INSERT INTO packs (name, content_hash) VALUES ('Filler', $1)", [`filler-${i}`]);
    }
    const fresh = await c.createShareCode('Fresh');
    assert.strictEqual((await submit(pack(), { shareCode: fresh.code }, '10.0.4.1')).error, 'The review queue is full, try again later.');
  });
});
