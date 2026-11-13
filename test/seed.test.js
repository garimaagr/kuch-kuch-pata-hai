// The seed script. Database parts run only with TEST_DATABASE_URL, in a throwaway schema.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');
const db = require('../db');
const community = require('../community');
const { validatePack } = require('../pack');
const { seedDir, removeFeaturedCopies, featuredPacks, featuredCopyOf } = require('../scripts/seed-community');

const URL = process.env.TEST_DATABASE_URL || '';
const vals = [100, 200, 300, 400, 500];
// A valid shared board; `seed` makes its questions unique.
const board = (seed, extra = {}) => ({
  format: 'buzz-pack-v2', name: `Seed ${seed}`, tags: ['Movies'], ...extra,
  boards: [{ name: 'Round one', categories: [1, 2, 3, 4, 5].map((c) => ({ name: `Cat ${c}`, questions: vals.map((v) => ({ value: v, question: `S${seed} ${c}-${v}?`, answer: 'A' })) })) }],
});
const tmpDir = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const write = (dir, file, data) => fs.writeFileSync(path.join(dir, file), typeof data === 'string' ? data : JSON.stringify(data));

test('seed/ has no copies of the Featured themes, and every pack there is a valid shared board', () => {
  const dir = path.join(__dirname, '..', 'seed');
  const featured = featuredPacks();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const res = validatePack(raw, { kind: 'upload' });
    assert.ok(res.ok, `${f}: ${res.errors?.join(' ')}`);
    assert.strictEqual(featuredCopyOf(res.pack, featured), null, `${f} copies a Featured theme`);
  }
});

test('a Featured copy: same name (any case or punctuation), or more than half the same questions', () => {
  const featured = featuredPacks();
  assert.deepStrictEqual(featured.map((f) => f.name).sort(), ['Desi Night', 'Party', 'Sports', 'TV & Movies', 'World Trivia'], 'packs/*.json');
  assert.strictEqual(featuredCopyOf({ name: 'world trivia!', boards: [] }, featured), 'World Trivia');
  assert.strictEqual(featuredCopyOf({ name: 'Original Night', boards: [] }, featured), null);

  const fake = [{ name: 'Fake', key: 'fake', questions: new Set(['s1 1 100', 's1 1 200', 's1 1 300']) }];
  const ofQs = (qs) => ({ name: 'Renamed', boards: [{ categories: [{ questions: qs.map((q) => ({ question: q })) }] }] });
  assert.strictEqual(featuredCopyOf(ofQs(['S1 1-100?', 'S1 1-200?', 'new one?']), fake), 'Fake', '2 of 3 the same');
  assert.strictEqual(featuredCopyOf(ofQs(['S1 1-100?', 'new?', 'newer?', 'newest?']), fake), null, '1 of 4 the same');
  assert.strictEqual(featuredCopyOf(ofQs(['S1 1-100?', 'S1 1-200?', 'x?', 'y?']), fake), null, 'exactly half is not a copy');
});

test('seeding and removing Featured copies', { skip: !URL && 'set TEST_DATABASE_URL to run' }, async (t) => {
  const schema = `t_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: URL, ssl: db.sslFor(URL) });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await db.init({ url: URL, schema, log: { error: () => {} } });
  t.after(async () => { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const lines = [];
  const log = { log: (l) => lines.push(l) };

  // A "Featured theme" for this test, made from board 9's questions.
  const featured = [{ name: 'Fake Featured', key: 'fake featured', questions: new Set(board(9).boards[0].categories.flatMap((c) => c.questions.map((q) => q.question.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()))) }];
  const dir = tmpDir(t);
  write(dir, 'a-original.json', board(1, { tags: ['Movies', 'TV'] }));
  write(dir, 'b-copy-by-name.json', board(2, { name: 'FAKE featured' }));
  write(dir, 'c-copy-renamed.json', board(9, { name: 'Totally New Name' }));
  write(dir, 'd-tagged.json', board(4, { name: '<b>Bold</b> Seed' }));
  write(dir, 'e-broken.json', '{ nope');
  write(dir, 'README.md', 'not a pack');

  const first = await seedDir(dir, { ...log, featured });
  assert.deepStrictEqual(first, { added: ['a-original.json', 'd-tagged.json'], skipped: ['b-copy-by-name.json', 'c-copy-renamed.json'], failed: ['e-broken.json'] });
  assert.match(lines.join('\n'), /copies the Featured theme "Fake Featured", skipped/);
  const rows = (await db.query(`SELECT p.name, p.status, p.made_by, p.html_stripped,
      (SELECT string_agg(t.name, ', ' ORDER BY t.name) FROM pack_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.pack_id = p.id) AS tags
      FROM packs p ORDER BY p.name`)).rows;
  assert.deepStrictEqual(rows.map((r) => [r.name, r.status, r.made_by, r.html_stripped, r.tags]),
    [['Bold Seed', 'pending', null, true, 'Movies'], ['Seed 1', 'pending', null, false, 'Movies, TV']]);
  assert.deepStrictEqual((await community.listBoards()).boards, [], 'not public until approved');

  const again = await seedDir(dir, { log: () => {}, featured });
  assert.deepStrictEqual([again.added.length, again.skipped.length], [0, 4], 'already in the database');

  // Copies already in the database (e.g. seeded before this check): listed by default, deleted only with confirm.
  const sneak = validatePack(board(9, { name: 'Sneaky Copy' })).pack;
  await community.savePending(sneak);
  await db.query("UPDATE packs SET status = 'approved' WHERE name = 'Sneaky Copy'");
  lines.length = 0;
  const dry = await removeFeaturedCopies({ ...log, featured });
  assert.deepStrictEqual([dry.found.map((p) => [p.name, p.status, p.copies]), dry.deleted], [[['Sneaky Copy', 'approved', 'Fake Featured']], 0]);
  assert.match(lines.join('\n'), /Nothing deleted \(dry run\)\. Add --confirm/);
  assert.strictEqual((await db.query('SELECT count(*)::int AS n FROM packs')).rows[0].n, 3, 'dry run deletes nothing');
  const done = await removeFeaturedCopies({ confirm: true, log: () => {}, featured });
  assert.strictEqual(done.deleted, 1);
  assert.deepStrictEqual((await db.query('SELECT name FROM packs ORDER BY name')).rows.map((r) => r.name), ['Bold Seed', 'Seed 1']);
  assert.strictEqual((await db.query('SELECT count(*)::int AS n FROM categories')).rows[0].n, 10, 'its categories went with it');
  assert.deepStrictEqual((await removeFeaturedCopies({ confirm: true, log: () => {}, featured })).found, [], 'nothing left to remove');

  // The real Featured themes: a copy of World Trivia is found by name.
  await community.savePending(validatePack(board(20, { name: 'World Trivia' })).pack);
  assert.deepStrictEqual((await removeFeaturedCopies({ log: () => {} })).found.map((p) => p.copies), ['World Trivia']);
});
