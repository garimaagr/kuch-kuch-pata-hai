// Database tests. They run only when TEST_DATABASE_URL is set, and work in a throwaway schema
// that is deleted afterwards, so they never touch real data.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { Pool } = require('pg');
const db = require('../db');

const URL = process.env.TEST_DATABASE_URL || '';
const quiet = { error: () => {} };

test('no DATABASE_URL: community features are off and nothing breaks', async () => {
  assert.strictEqual(await db.init({ url: '', log: quiet }), false);
  assert.strictEqual(db.enabled(), false);
  assert.throws(() => db.query('SELECT 1'), /not available/);
});

test('an unreachable database: community features are off, no crash, no secrets logged', async () => {
  const logged = [];
  const ok = await db.init({ url: 'postgresql://someone:s3cretpw@127.0.0.1:1/nope', log: { error: (m) => logged.push(m) } });
  assert.strictEqual(ok, false);
  assert.strictEqual(db.enabled(), false);
  assert.ok(logged.length === 1 && !logged[0].includes('s3cretpw') && !logged[0].includes('postgresql://'));
});

test('SSL is on for remote databases and off for local ones', () => {
  assert.deepStrictEqual(db.sslFor('postgresql://u:p@ep-x.eu-central-1.aws.neon.tech/neondb?sslmode=require'), { rejectUnauthorized: true });
  assert.strictEqual(db.sslFor('postgresql://localhost/buzzin_dev'), false);
});

test('slugs', () => {
  assert.strictEqual(db.slugify('Cartoons & Kids'), 'cartoons-and-kids');
  assert.strictEqual(db.slugify('  World & Travel!! '), 'world-and-travel');
});

test('tables are created, starting tags added once, and setup can run again', { skip: !URL && 'set TEST_DATABASE_URL to run' }, async () => {
  const schema = `t_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: URL, ssl: db.sslFor(URL) });
  await admin.query(`CREATE SCHEMA ${schema}`); // random hex name, not user input
  try {
    assert.strictEqual(await db.init({ url: URL, schema, log: quiet }), true);
    assert.ok(db.enabled());
    const tables = (await db.query('SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1', [schema])).rows.map((r) => r.table_name);
    assert.deepStrictEqual(tables, ['app_meta', 'categories', 'featured_extras', 'pack_tags', 'packs', 'tags']);

    const tags = (await db.query('SELECT slug, name, emoji FROM tags ORDER BY id')).rows;
    assert.strictEqual(tags.length, 12);
    assert.deepStrictEqual(tags[4], { slug: 'cartoons-and-kids', name: 'Cartoons & Kids', emoji: '🧸' });

    // The admin deletes a starting tag; restarting the server must not bring it back.
    await db.query('DELETE FROM tags WHERE slug = $1', ['gaming']);
    await db.close();
    assert.strictEqual(await db.init({ url: URL, schema, log: quiet }), true);
    assert.strictEqual((await db.query('SELECT count(*)::int AS n FROM tags')).rows[0].n, 11);

    // One row per category; deleting a pack removes its categories and tag links.
    const pack = await db.query("INSERT INTO packs (name, content_hash) VALUES ($1, $2) RETURNING id", ['<b>Test</b>', 'hash-1']);
    const id = pack.rows[0].id;
    assert.match(id, /^[0-9a-f-]{36}$/);
    await db.query('INSERT INTO categories (pack_id, board_index, position, name, questions) VALUES ($1, 0, 0, $2, $3)', [id, 'Cat', JSON.stringify([{ q: 1 }])]);
    await db.query('INSERT INTO pack_tags (pack_id, tag_id) SELECT $1, id FROM tags WHERE slug = $2', [id, 'movies']);
    await assert.rejects(db.query("INSERT INTO packs (name, content_hash) VALUES ('Dup', 'hash-1')"), /duplicate key/);
    await assert.rejects(db.query("UPDATE packs SET status = 'live' WHERE id = $1", [id]), /check constraint/);
    await db.query('DELETE FROM packs WHERE id = $1', [id]);
    assert.strictEqual((await db.query('SELECT count(*)::int AS n FROM categories')).rows[0].n, 0);
    assert.strictEqual((await db.query('SELECT count(*)::int AS n FROM pack_tags')).rows[0].n, 0);
  } finally {
    await db.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test('the tag list is loaded for the prompt and pack checks', { skip: !URL && 'set TEST_DATABASE_URL to run' }, async () => {
  const schema = `t_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: URL, ssl: db.sslFor(URL) });
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    await db.init({ url: URL, schema, log: quiet });
    assert.strictEqual(db.tagNames().length, 12);
    assert.ok(db.tagNames().includes('Cartoons & Kids'));
    await db.query('INSERT INTO tags (slug, name, emoji) VALUES ($1, $2, $3)', ['anime', 'Anime', '🍥']);
    assert.ok(!db.tagNames().includes('Anime'), 'cached until refreshed');
    await db.refreshTags();
    assert.ok(db.tagNames().includes('Anime'));
  } finally {
    await db.close();
    assert.deepStrictEqual(db.tagNames(), [], 'no database, no tags');
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
