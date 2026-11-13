// npm run seed-community
// Adds every .json pack in seed/ to the community review queue as a pending board.
// Review and approve them in /admin like any other board.
// Safe to run again: boards already in the database (same questions and answers) are skipped,
// and so are copies of the Featured themes (packs/*.json): those are already in the game.
//
// npm run seed-community -- --remove-featured-copies            lists community boards that copy a Featured theme
// npm run seed-community -- --remove-featured-copies --confirm  deletes them (any status)

const fs = require('fs');
const path = require('path');

try { if (typeof process.loadEnvFile === 'function') process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* no .env */ }

const db = require('../db');
const community = require('../community');
const { validatePack, MAX_TAGS } = require('../pack');

const SEED_DIR = path.join(__dirname, '..', 'seed');
const FEATURED_DIR = path.join(__dirname, '..', 'packs');

// ---- Copies of Featured themes ----
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const questionsOf = (pack) => (pack.boards || []).flatMap((b) => (b.categories || []).flatMap((c) => (c.questions || []).map((q) => norm(q.question)))).filter(Boolean);

// The Featured themes: name plus every question, normalised.
function featuredPacks(dir = FEATURED_DIR) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    return { name: p.name, key: norm(p.name), questions: new Set(questionsOf(p)) };
  });
}

// The Featured theme this pack copies, or null. A copy has the same name as one,
// or more than half of its questions appear in one.
function featuredCopyOf(pack, featured) {
  const key = norm(pack.name);
  const qs = questionsOf(pack);
  for (const f of featured) {
    if (key && key === f.key) return f.name;
    if (qs.length && qs.filter((q) => f.questions.has(q)).length * 2 > qs.length) return f.name;
  }
  return null;
}

async function seedDir(dir = SEED_DIR, { log = console.log, featured = featuredPacks() } = {}) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json')).sort() : [];
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
    const copies = featuredCopyOf(pack, featured);
    if (copies) { result.skipped.push(file); log(`– ${file}: copies the Featured theme "${copies}", skipped`); continue; }
    const hash = community.contentHash(pack);
    if ((await db.query('SELECT 1 FROM packs WHERE content_hash = $1', [hash])).rowCount) {
      result.skipped.push(file); log(`– ${file}: already in the database, skipped`); continue;
    }
    const tagIds = (pack.tags || []).slice(0, MAX_TAGS).map((t) => byName.get(t)).filter(Boolean);
    await community.savePending(pack, { hash, kidFriendly: !!pack.kidFriendly, tagIds, htmlStripped: res.stripped.length > 0 });
    result.added.push(file);
    log(`✓ ${file}: "${pack.name}" added for review${pack.suggestedTag ? ` (suggested tag: ${pack.suggestedTag})` : ''}`);
  }
  log(`\n${result.added.length} added, ${result.skipped.length} skipped, ${result.failed.length} failed. Review them at /admin.`);
  return result;
}

// Community boards (any status) that copy a Featured theme. Lists them; deletes them only with confirm.
async function removeFeaturedCopies({ confirm = false, log = console.log, featured = featuredPacks() } = {}) {
  const { rows: packs } = await db.query('SELECT id, name, status FROM packs ORDER BY created_at');
  const { rows: cats } = await db.query('SELECT pack_id, questions FROM categories');
  const found = packs.map((p) => {
    const pack = { name: p.name, boards: [{ categories: cats.filter((c) => c.pack_id === p.id).map((c) => ({ questions: c.questions })) }] };
    return { ...p, copies: featuredCopyOf(pack, featured) };
  }).filter((p) => p.copies);

  if (!found.length) { log('No community boards copy a Featured theme.'); return { found: [], deleted: 0 }; }
  for (const p of found) log(`• "${p.name}" (${p.status}) copies the Featured theme "${p.copies}"`);
  if (!confirm) {
    log(`\n${found.length} found. Nothing deleted (dry run). Add --confirm to delete them.`);
    return { found, deleted: 0 };
  }
  const { rowCount } = await db.query('DELETE FROM packs WHERE id = ANY($1::uuid[])', [found.map((p) => p.id)]);
  log(`\nDeleted ${rowCount} board${rowCount === 1 ? '' : 's'}.`);
  return { found, deleted: rowCount };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Set DATABASE_URL first (in .env, or in the command), e.g. DATABASE_URL=… npm run seed-community');
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => !['--remove-featured-copies', '--confirm'].includes(a));
  if (unknown.length) { console.error(`Unknown option: ${unknown.join(' ')}`); process.exit(1); }
  if (args.includes('--confirm') && !args.includes('--remove-featured-copies')) {
    console.error('--confirm only goes with --remove-featured-copies.'); process.exit(1);
  }
  if (!(await db.init())) process.exit(1);
  try {
    if (args.includes('--remove-featured-copies')) await removeFeaturedCopies({ confirm: args.includes('--confirm') });
    else process.exitCode = (await seedDir()).failed.length ? 1 : 0;
  } finally {
    await db.close();
  }
}

if (require.main === module) main();
module.exports = { seedDir, removeFeaturedCopies, featuredPacks, featuredCopyOf };
