// Community boards: submitting a board for review, and the public (approved-only) reads.
// Anyone with the site link can submit; every board is reviewed in /admin before it's public.
// Everything here uses parameterised SQL through db.js.

const crypto = require('crypto');
const db = require('./db');
const { cleanText, stripTags } = require('./limits');
const { validatePack, MAX_TAGS } = require('./pack');

const MADE_BY_MAX = 30;
const PER_IP_PER_DAY = 5;
const MAX_PENDING = 100;
const DAY = 24 * 60 * 60 * 1000;

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
  const untagged = stripTags(value ?? '');
  const clean = cleanText(untagged, Infinity);
  if (clean.length > MADE_BY_MAX) return { error: `"Made by" is too long (max ${MADE_BY_MAX} characters).` };
  if (LINKISH.test(clean)) return { error: '"Made by" can\'t include a link. Use a first name or nickname.' };
  return { value: clean || null, stripped: untagged !== (value ?? '') };
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

// Saves a validated pack for review (status pending), one row per category. Returns its id.
// No checks here: submitPack (and the seed script) do those first.
async function savePending(pack, { hash = contentHash(pack), madeBy = null, kidFriendly = !!pack.kidFriendly, tagIds = [], htmlStripped = false } = {}) {
  return db.transaction(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO packs (name, emoji, made_by, kid_friendly, suggested_tag, board_names, teams, sparkle, content_hash, html_stripped)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [pack.name, pack.emoji || '', madeBy, kidFriendly, pack.suggestedTag || null,
        JSON.stringify(pack.boards.map((b) => b.name)), pack.teams ? JSON.stringify(pack.teams) : null,
        pack.sparkle ? JSON.stringify(pack.sparkle) : null, hash, !!htmlStripped],
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
    return id;
  });
}

// Submits a checked pack for review. Pending boards are never shown to the public.
// input: { pack, madeBy, tags: [tag names], kidFriendly }
async function submitPack(input, { ip = 'unknown', now = Date.now() } = {}) {
  if (!db.enabled()) return fail('Sharing isn\'t available right now.');
  const { pack: raw, madeBy, tags, kidFriendly } = input || {};

  const dayKey = 'day:' + ip;
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
    // 2. Room in the review queue.
    const pending = await db.query("SELECT count(*)::int AS n FROM packs WHERE status = 'pending'");
    if (pending.rows[0].n >= MAX_PENDING) return fail('The review queue is full, try again later.');

    // 3. Duplicates.
    const hash = contentHash(pack);
    const dup = await db.query('SELECT 1 FROM packs WHERE content_hash = $1', [hash]);
    if (dup.rowCount) return fail('This board has already been shared.');

    // 4. Save as pending: one row per category.
    await savePending(pack, { hash, madeBy: who.value, kidFriendly: kidFriendly ?? !!pack.kidFriendly, tagIds, htmlStripped: checked.stripped.length > 0 || who.stripped });
    hit(dayKey, now);
    return { ok: true, message: 'Thanks! It\'ll appear in Community once it\'s approved.' };
  } catch (err) {
    if (err.code === '23505') return fail('This board has already been shared.'); // two submits at once
    console.error(`Sharing a board failed (${err.code || err.message}).`);
    return fail('Couldn\'t save it right now. Please try again in a few minutes.');
  }
}

// ---- Public: only approved boards, ever ----
const PAGE_SIZE = 20;
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s ?? ''));
const tagSlug = (s) => (typeof s === 'string' && /^[a-z0-9-]{1,40}$/.test(s) ? s : null);

// Filters shared by the list and 🎲 Surprise me: $1 tag slug, $2 search pattern, $3 kid-friendly only.
// Search matches the board name, its tag names, "Made by" and its category names.
const FILTER = `p.status = 'approved'
  AND ($1::text IS NULL OR EXISTS (SELECT 1 FROM pack_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.pack_id = p.id AND t.slug = $1))
  AND ($2::text IS NULL OR p.name ILIKE $2 ESCAPE '\\' OR p.made_by ILIKE $2 ESCAPE '\\'
       OR EXISTS (SELECT 1 FROM pack_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.pack_id = p.id AND t.name ILIKE $2 ESCAPE '\\')
       OR EXISTS (SELECT 1 FROM categories c WHERE c.pack_id = p.id AND c.name ILIKE $2 ESCAPE '\\'))
  AND (NOT $3::boolean OR p.kid_friendly)`;
// The search text as an ILIKE "contains" pattern. % _ and \ typed by people are matched literally.
function searchPattern(q) {
  const text = cleanText(q ?? '', 40);
  return text ? '%' + text.replace(/[\\%_]/g, '\\$&') + '%' : null;
}
const isKid = (kid) => kid === true || kid === '1' || kid === 'true';
const filterValues = ({ tag, q, kid } = {}) => [tagSlug(tag), searchPattern(q), isKid(kid)];
const TAGS_OF = `COALESCE((SELECT json_agg(json_build_object('slug', t.slug, 'name', t.name, 'emoji', t.emoji) ORDER BY lower(t.name))
  FROM pack_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.pack_id = p.id), '[]')`;
const NEW_DAYS = 7;
const IS_NEW = `(p.reviewed_at > now() - interval '${NEW_DAYS} days')`;
const CARD_COLS = `p.id, p.name, p.emoji, p.made_by, p.play_count, p.kid_friendly, ${IS_NEW} AS is_new, ${TAGS_OF} AS tags`;

// Older boards may still hold HTML-looking tags (they're removed on sharing now): tidy them for display.
const tidy = (s) => (s == null ? s : cleanText(stripTags(s), Infinity));
const card = (r) => ({ id: r.id, name: tidy(r.name), emoji: r.emoji, madeBy: tidy(r.made_by), playCount: r.play_count, kidFriendly: r.kid_friendly, isNew: !!r.is_new, tags: r.tags });

// Tags with at least 1 approved board (with counts; only kid-friendly boards when kid is on),
// and how many approved boards there are in all (that decides whether the Community tab shows).
async function publicTags({ kid } = {}) {
  const [tags, total] = await Promise.all([
    db.query(`SELECT t.slug, t.name, t.emoji, count(*)::int AS boards
                FROM tags t JOIN pack_tags pt ON pt.tag_id = t.id
                JOIN packs p ON p.id = pt.pack_id AND p.status = 'approved' AND (NOT $1::boolean OR p.kid_friendly)
               GROUP BY t.id ORDER BY boards DESC, lower(t.name)`, [isKid(kid)]),
    db.query("SELECT count(*)::int AS n FROM packs WHERE status = 'approved'"),
  ]);
  return { total: total.rows[0].n, tags: tags.rows };
}

// One page (20) of approved boards: most played first.
async function listBoards(filters = {}) {
  const page = Math.min(Math.max(Number.parseInt(filters.page, 10) || 0, 0), 500);
  const { rows } = await db.query(
    `SELECT ${CARD_COLS}
       FROM packs p WHERE ${FILTER}
      ORDER BY p.play_count DESC, p.reviewed_at DESC NULLS LAST, p.id
      LIMIT ${PAGE_SIZE + 1} OFFSET $4`,
    [...filterValues(filters), page * PAGE_SIZE],
  );
  return { boards: rows.slice(0, PAGE_SIZE).map(card), more: rows.length > PAGE_SIZE, page };
}

// ✨ New this week: up to 6 boards approved in the last 7 days, newest first.
const NEW_MAX = 6;
async function newBoards({ kid } = {}) {
  const { rows } = await db.query(
    `SELECT ${CARD_COLS} FROM packs p
      WHERE p.status = 'approved' AND ${IS_NEW} AND (NOT $1::boolean OR p.kid_friendly)
      ORDER BY p.reviewed_at DESC, p.id LIMIT ${NEW_MAX}`,
    [isKid(kid)],
  );
  return { boards: rows.map(card) };
}

// 🎲 A random approved board that matches the tag and kid-friendly filters. null if none.
async function randomBoard(filters = {}) {
  const { rows } = await db.query(`SELECT p.id FROM packs p WHERE ${FILTER} ORDER BY random() LIMIT 1`, filterValues({ tag: filters.tag, kid: filters.kid }));
  return rows[0]?.id || null;
}

// An approved board rebuilt as a pack (not yet validated: callers run validatePack), or null.
// Pending, rejected and archived boards are "not found".
async function loadPack(id) {
  if (!isUuid(id)) return null;
  const { rows } = await db.query(`SELECT p.*, ${TAGS_OF} AS tags FROM packs p WHERE p.id = $1 AND p.status = 'approved'`, [id]);
  const p = rows[0];
  if (!p) return null;
  const cats = (await db.query('SELECT board_index, name, description, questions FROM categories WHERE pack_id = $1 ORDER BY board_index, position', [id])).rows;
  const pack = {
    format: 'buzz-pack-v2', name: p.name,
    ...(p.emoji ? { emoji: p.emoji } : {}),
    ...(p.teams ? { teams: p.teams } : {}),
    boards: (p.board_names || []).map((name, bi) => ({
      name,
      categories: cats.filter((c) => c.board_index === bi).map((c) => ({ name: c.name, ...(c.description ? { note: c.description } : {}), questions: c.questions })),
    })),
    ...(p.sparkle ? { sparkle: p.sparkle } : {}),
  };
  return { pack, meta: { id: p.id, madeBy: p.made_by, kidFriendly: p.kid_friendly, playCount: p.play_count, tags: p.tags } };
}

// Starting a game with a community board counts one play (the caller does this once per new room).
async function countPlay(id) {
  if (!isUuid(id)) return;
  await db.query("UPDATE packs SET play_count = play_count + 1 WHERE id = $1 AND status = 'approved'", [id]);
}

module.exports = {
  PAGE_SIZE, NEW_MAX, NEW_DAYS, isUuid, publicTags, listBoards, newBoards, randomBoard, searchPattern, loadPack, countPlay,
  PER_IP_PER_DAY, MAX_PENDING, MADE_BY_MAX,
  contentHash, cleanMadeBy, submitPack, savePending, pruneLimits,
};
