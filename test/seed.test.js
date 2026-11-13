// The seed script (runs only with TEST_DATABASE_URL, in a throwaway schema).
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
const { seedDir } = require('../scripts/seed-community');

const URL = process.env.TEST_DATABASE_URL || '';

test('every seed file is a valid shared board', () => {
  const dir = path.join(__dirname, '..', 'seed');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.deepStrictEqual(files.sort(), ['desi.json', 'sports.json', 'tv.json', 'world.json']);
  for (const f of files) {
    const res = validatePack(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), { kind: 'upload' });
    assert.ok(res.ok, `${f}: ${res.errors?.join(' ')}`);
  }
});

test('seeding adds pending boards for review, once', { skip: !URL && 'set TEST_DATABASE_URL to run' }, async (t) => {
  const schema = `t_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: URL, ssl: db.sslFor(URL) });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await db.init({ url: URL, schema, log: { error: () => {} } });
  t.after(async () => { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const quiet = { log: () => {} };

  const first = await seedDir(undefined, quiet);
  assert.deepStrictEqual([first.added.length, first.skipped.length, first.failed.length], [4, 0, 0]);
  const rows = (await db.query(`SELECT p.name, p.status,
      (SELECT string_agg(t.name, ', ' ORDER BY t.name) FROM pack_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.pack_id = p.id) AS tags
      FROM packs p ORDER BY p.name`)).rows;
  assert.ok(rows.every((r) => r.status === 'pending'));
  assert.deepStrictEqual(rows.map((r) => r.tags), ['Desi, Movies', 'Sports', 'Movies, TV', 'World & Travel']);
  assert.deepStrictEqual((await community.listBoards()).boards, [], 'not public until approved');

  const again = await seedDir(undefined, quiet);
  assert.deepStrictEqual([again.added.length, again.skipped.length], [0, 4]);

  // Once approved, each one loads and passes the strict check (as a Community game would).
  await db.query("UPDATE packs SET status = 'approved'");
  for (const b of (await community.listBoards()).boards) {
    const loaded = await community.loadPack(b.id);
    assert.ok(validatePack(loaded.pack, { kind: 'upload' }).ok, b.name);
  }

  // A broken file is reported and skipped; the others still go in.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a-broken.json'), '{ nope');
  fs.writeFileSync(path.join(dir, 'b-short.json'), JSON.stringify({ format: 'buzz-pack-v2', name: 'Short', boards: [] }));
  const lines = [];
  const mixed = await seedDir(dir, { log: (l) => lines.push(l) });
  assert.deepStrictEqual(mixed.failed, ['a-broken.json', 'b-short.json']);
  assert.match(lines.join('\n'), /a-broken\.json: not valid JSON/);
});
