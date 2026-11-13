// npm run seed-community
// Adds every .json pack in seed/ to the community review queue as a pending board.
// Review and approve them in /admin like any other board.
// Safe to run again: boards already in the database (same questions and answers) are skipped.

const fs = require('fs');
const path = require('path');

try { if (typeof process.loadEnvFile === 'function') process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* no .env */ }

const db = require('../db');
const community = require('../community');
const { validatePack, MAX_TAGS } = require('../pack');

const SEED_DIR = path.join(__dirname, '..', 'seed');
async function seedDir(dir = SEED_DIR, { log = console.log } = {}) {
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json')).sort();
  const result = { added: [], skipped: [], failed: [] };
  if (!files.length) { log(`No .json files in ${dir}.`); return result; }
  const byName = new Map(db.tags().map((t) => [t.name, t.id]));

  for (const file of files) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch (err) {
      result.failed.push(file); log(`✗ ${file}: not valid JSON (${err.message})`); continue;
    }
    // Same rules as a shared board, so it can be played from Community once approved.
    const res = validatePack(raw, { kind: 'upload', knownTags: db.tagNames() });
    if (!res.ok) {
      result.failed.push(file);
      log(`✗ ${file}: ${res.errors.slice(0, 3).join(' ')}${res.errors.length > 3 ? ` (+${res.errors.length - 3} more)` : ''}`);
      continue;
    }
    const pack = res.pack;
    const hash = community.contentHash(pack);
    if ((await db.query('SELECT 1 FROM packs WHERE content_hash = $1', [hash])).rowCount) {
      result.skipped.push(file); log(`– ${file}: already in the database, skipped`); continue;
    }
    const tagIds = (pack.tags || []).slice(0, MAX_TAGS).map((t) => byName.get(t)).filter(Boolean);
    await community.savePending(pack, { hash, kidFriendly: !!pack.kidFriendly, tagIds });
    result.added.push(file);
    log(`✓ ${file}: "${pack.name}" added for review${pack.suggestedTag ? ` (suggested tag: ${pack.suggestedTag})` : ''}`);
  }
  log(`\n${result.added.length} added, ${result.skipped.length} skipped, ${result.failed.length} failed. Review them at /admin.`);
  return result;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Set DATABASE_URL first (in .env, or in the command), e.g. DATABASE_URL=… npm run seed-community');
    process.exit(1);
  }
  if (!(await db.init())) process.exit(1);
  try {
    const r = await seedDir();
    process.exitCode = r.failed.length ? 1 : 0;
  } finally {
    await db.close();
  }
}

if (require.main === module) main();
module.exports = { seedDir };
