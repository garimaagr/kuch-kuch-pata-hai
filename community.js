// Community boards: share codes and submitting a board for review.
// Everything here uses parameterised SQL through db.js. Never log share codes.

const crypto = require('crypto');
const db = require('./db');
const { cleanText } = require('./limits');
const { validatePack, MAX_TAGS } = require('./pack');

const MADE_BY_MAX = 30;
const PER_CODE_PER_DAY = 3;
const PER_IP_PER_DAY = 5;
const MAX_PENDING = 100;
const BAD_CODES_PER_HOUR = 10; // wrong share codes per network, so codes can't be guessed
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// ---- Share codes ----
// Shown once when created (like BUZZ-7KQ2-M9XA); only a hash is stored.
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // no 0/O, 1/I/L, U
const normCode = (code) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^BUZZ(?=.{8}$)/, '');
const hashCode = (code) => crypto.createHash('sha256').update('buzzin-share:' + normCode(code)).digest('hex');

function newShareCode() {
  const bytes = crypto.randomBytes(8);
  const chars = [...bytes].map((b) => CODE_LETTERS[b % CODE_LETTERS.length]).join('');
  return `BUZZ-${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

// Creates a share code for a person (label, e.g. "Jeff"). Returns the code: it can't be shown again.
async function createShareCode(label) {
  const clean = cleanText(label, MADE_BY_MAX);
  if (!clean) return { ok: false, error: 'Give the code a label (who it\'s for).' };
  const code = newShareCode();
  const res = await db.query('INSERT INTO share_codes (code_hash, label) VALUES ($1, $2) RETURNING id', [hashCode(code), clean]);
  return { ok: true, id: res.rows[0].id, code, label: clean };
}

// The active share code matching `code`, or null. Compared in constant time against every active code
// (there are only a handful).
async function findShareCode(code) {
  if (!normCode(code)) return null;
  const want = Buffer.from(hashCode(code), 'hex');
  const { rows } = await db.query('SELECT id, code_hash, label FROM share_codes WHERE active');
  let found = null;
  for (const row of rows) {
    const have = Buffer.from(row.code_hash, 'hex');
    if (have.length === want.length && crypto.timingSafeEqual(have, want)) found = row;
  }
  return found && { id: found.id, label: found.label };
}

// ---- Duplicates ----
// The same questions and answers (ignoring case, spacing, the name, tags and extras) = the same board.
function contentHash(pack) {
  const n = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const core = pack.boards.map((b) => b.categories.map((c) => [n(c.name), c.questions.map((q) => [n(q.question), n(q.answer)])]));
  return crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex');
}

// "Made by": a first name or nickname. Plain text, no links.
const LINKISH = /(https?:|www\.|:\/\/|\b[a-z0-9-]+\.(com|net|org|io|in|co|uk|us|ly|me|app|dev|xyz|gg|tv|info|biz|link|site)\b)/i;
function cleanMadeBy(value) {
  if (value != null && typeof value !== 'string') return { error: '"Made by" must be text.' };
  const clean = cleanText(value ?? '', Infinity);
  if (clean.length > MADE_BY_MAX) return { error: `"Made by" is too long (max ${MADE_BY_MAX} characters).` };
  if (LINKISH.test(clean)) return { error: '"Made by" can\'t include a link. Use a first name or nickname.' };
  return { value: clean || null };
}

// ---- Rate limits kept in memory (per network) ----
const ipHits = new Map(); // key -> timestamps
function recent(key, windowMs, now) {
  const list = (ipHits.get(key) || []).filter((t) => now - t < windowMs);
  ipHits.set(key, list);
  return list;
}
const hit = (key, now) => ipHits.get(key).push(now);
function pruneLimits(now = Date.now()) {
  for (const [key, list] of ipHits) if (!list.some((t) => now - t < DAY)) ipHits.delete(key);
}

const fail = (error) => ({ ok: false, error });

// Submits a checked pack for review. Pending boards are never shown to the public.
// input: { pack, shareCode, madeBy, tags: [tag names], kidFriendly }
async function submitPack(input, { ip = 'unknown', now = Date.now() } = {}) {
  if (!db.enabled()) return fail('Sharing isn\'t available right now.');
  const { pack: raw, shareCode, madeBy, tags, kidFriendly } = input || {};

  const badKey = 'bad:' + ip;
  const dayKey = 'day:' + ip;
  if (recent(badKey, HOUR, now).length >= BAD_CODES_PER_HOUR) return fail('Too many wrong share codes. Please wait an hour and try again.');
  if (recent(dayKey, DAY, now).length >= PER_IP_PER_DAY) return fail(`You've shared ${PER_IP_PER_DAY} boards today. Please try again tomorrow.`);

  // 1. Check the whole pack again, with the same rules as "Check pack".
  const checked = validatePack(raw, { kind: 'upload', knownTags: db.tagNames() });
  if (!checked.ok) return { ok: false, error: 'This pack has problems. Check it again first.', errors: checked.errors };
  const pack = checked.pack;

  const who = cleanMadeBy(madeBy);
  if (who.error) return fail(who.error);
  if (!Array.isArray(tags) || !tags.length) return fail('Tick at least 1 tag.');
  if (tags.length > MAX_TAGS) return fail(`Tick at most ${MAX_TAGS} tags.`);
  const byName = new Map(db.tags().map((t) => [t.name, t.id]));
  const tagIds = [...new Set(tags.map((t) => byName.get(t)))];
  if (tagIds.some((id) => id == null)) return fail('One of those tags no longer exists. Reload the page and try again.');
  if (kidFriendly != null && typeof kidFriendly !== 'boolean') return fail('Kid-friendly must be on or off.');

  try {
    // 2. The share code.
    const code = await findShareCode(shareCode);
    if (!code) {
      hit(badKey, now);
      return fail('That share code isn\'t valid. Check it with the person who gave it to you.');
    }
    const used = await db.query("SELECT count(*)::int AS n FROM packs WHERE share_code_id = $1 AND created_at > now() - interval '1 day'", [code.id]);
    if (used.rows[0].n >= PER_CODE_PER_DAY) return fail(`This share code has been used ${PER_CODE_PER_DAY} times today. Please try again tomorrow.`);
    const pending = await db.query("SELECT count(*)::int AS n FROM packs WHERE status = 'pending'");
    if (pending.rows[0].n >= MAX_PENDING) return fail('The review queue is full, try again later.');

    // 3. Duplicates.
    const hash = contentHash(pack);
    const dup = await db.query('SELECT 1 FROM packs WHERE content_hash = $1', [hash]);
    if (dup.rowCount) return fail('This board has already been shared.');

    // 4. Save as pending: one row per category.
    await db.transaction(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO packs (name, emoji, made_by, kid_friendly, suggested_tag, board_names, teams, sparkle, content_hash, share_code_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [pack.name, pack.emoji || '', who.value, kidFriendly ?? !!pack.kidFriendly, pack.suggestedTag || null,
          JSON.stringify(pack.boards.map((b) => b.name)), pack.teams ? JSON.stringify(pack.teams) : null,
          pack.sparkle ? JSON.stringify(pack.sparkle) : null, hash, code.id],
      );
      const id = rows[0].id;
      for (const [bi, b] of pack.boards.entries()) {
        for (const [ci, cat] of b.categories.entries()) {
          await c.query(
            'INSERT INTO categories (pack_id, board_index, position, name, description, is_default, questions) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [id, bi, ci, cat.name, cat.note || null, cat.default ?? true, JSON.stringify(cat.questions)],
          );
        }
      }
      for (const tagId of tagIds) await c.query('INSERT INTO pack_tags (pack_id, tag_id) VALUES ($1, $2)', [id, tagId]);
      await c.query('UPDATE share_codes SET uses = uses + 1 WHERE id = $1', [code.id]);
    });
    hit(dayKey, now);
    return { ok: true, message: 'Thanks! It\'ll appear in Community once it\'s approved.' };
  } catch (err) {
    if (err.code === '23505') return fail('This board has already been shared.'); // two submits at once
    console.error(`Sharing a board failed (${err.code || err.message}).`);
    return fail('Couldn\'t save it right now. Please try again in a few minutes.');
  }
}

module.exports = {
  PER_CODE_PER_DAY, PER_IP_PER_DAY, MAX_PENDING, MADE_BY_MAX,
  newShareCode, createShareCode, findShareCode, hashCode, normCode, contentHash, cleanMadeBy, submitPack, pruneLimits,
};
