// Community boards database (Neon Postgres in production).
// Optional: with no DATABASE_URL, or if the database can't be reached at startup, the app runs exactly
// as before and the community features stay hidden (db.enabled() is false).
//
// Rules: parameterised queries only (never build SQL from strings), and never log the connection
// string, share codes, the admin PIN or session tokens.

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const SCHEMA_FILE = path.join(__dirname, 'schema.sql');
const LOCK_ID = 4242017; // advisory lock: two server copies starting at once won't trip over each other

// Added the first time the tables are created. After that, /admin owns the tag list.
const STARTING_TAGS = [
  ['Movies', '🎬'],
  ['TV', '📺'],
  ['Music', '🎵'],
  ['Sports', '⚽'],
  ['Cartoons & Kids', '🧸'],
  ['Desi', '🪔'],
  ['World & Travel', '🌍'],
  ['History', '🏛️'],
  ['Science', '🔬'],
  ['Food', '🍕'],
  ['Gaming', '🎮'],
  ['Holidays', '🎉'],
];

// "Cartoons & Kids" -> "cartoons-and-kids"
const slugify = (name) => String(name).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Local databases (testing) don't use SSL; anything else (Neon) must, with a checked certificate.
function sslFor(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { /* checked by pg below */ }
  const local = ['localhost', '127.0.0.1', '::1', ''].includes(host) || host.startsWith('/');
  return local ? false : { rejectUnauthorized: true };
}

let pool = null;
let ready = false;
let tagCache = []; // [{ id, slug, name, emoji }], kept in memory: the prompt and pack checks need it often

// Connects, creates the tables if needed and adds the starting tags once.
// Returns true when the community features can be used. Never throws.
// options.schema: tests only, to work in a throwaway Postgres schema.
async function init({ url = process.env.DATABASE_URL || '', schema = '', log = console } = {}) {
  ready = false;
  if (!url) return false;
  try {
    pool = new Pool({
      connectionString: url,
      ssl: sslFor(url),
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ...(schema ? { options: `-c search_path=${schema}` } : {}),
    });
    pool.on('error', (err) => log.error(`Database connection problem: ${err.code || err.message}`));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
      await client.query(fs.readFileSync(SCHEMA_FILE, 'utf8'));
      await seedTags(client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    ready = true;
    await refreshTags();
    return true;
  } catch (err) {
    // Only the error code/message: never the connection string.
    log.error(`Community boards are off: couldn't set up the database (${err.code || err.message}).`);
    await close();
    return false;
  }
}

// The starting tags go in once. If you later rename or delete one in /admin, a restart won't bring it back.
async function seedTags(client) {
  const first = await client.query(
    "INSERT INTO app_meta (key, value) VALUES ('starting_tags', now()::text) ON CONFLICT (key) DO NOTHING RETURNING key",
  );
  if (!first.rowCount) return;
  for (const [name, emoji] of STARTING_TAGS) {
    await client.query('INSERT INTO tags (slug, name, emoji) VALUES ($1, $2, $3) ON CONFLICT (slug) DO NOTHING', [slugify(name), name, emoji]);
  }
}

// A parameterised query. Callers pass values separately: query('... WHERE id = $1', [id]).
function query(text, values = []) {
  if (!ready) throw new Error('The database is not available.');
  return pool.query(text, values);
}

// Runs fn(client) inside one transaction.
async function transaction(fn) {
  if (!ready) throw new Error('The database is not available.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function close() {
  ready = false;
  tagCache = [];
  const p = pool;
  pool = null;
  if (p) await p.end().catch(() => {});
}

const enabled = () => ready;

// Reloads the tag list (after the admin changes tags). On a database error the old list stays.
async function refreshTags() {
  if (!ready) return (tagCache = []);
  try {
    tagCache = (await pool.query('SELECT id, slug, name, emoji FROM tags ORDER BY lower(name)')).rows;
  } catch (err) {
    console.error(`Couldn't load the tags (${err.code || err.message}).`);
  }
  return tagCache;
}
const tags = () => (ready ? tagCache : []);
const tagNames = () => tags().map((t) => t.name);

module.exports = { init, query, transaction, close, enabled, refreshTags, tags, tagNames, slugify, sslFor, STARTING_TAGS };
