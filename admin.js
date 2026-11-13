// The /admin review page's server side: PIN login, sessions, and the review / tags API.
// Parameterised SQL only. Never log the PIN or session tokens.

const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const community = require('./community');
const { makeLimiter, cleanText } = require('./limits');
const { MAX_TAGS } = require('./pack');

const SESSION_MS = 12 * 60 * 60 * 1000;
const COOKIE = 'buzzin_admin';
const TAG_NAME_MAX = 24;
const EMOJI_MAX = 8; // characters (an emoji can be several)
const REASON_MAX = 200;

// Same length + timingSafeEqual, without revealing the PIN's length.
function samePin(given, pin) {
  if (!pin || typeof given !== 'string' || !given) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(pin).digest();
  return crypto.timingSafeEqual(a, b);
}

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s));
const intId = (s) => (/^\d{1,9}$/.test(String(s)) ? Number(s) : null);

class Oops extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// options: { pin, ipOf(req), now() } — passed in so tests can control them.
function adminRouter({ pin = process.env.ADMIN_PIN || '', ipOf = (req) => req.socket.remoteAddress || 'unknown', now = Date.now } = {}) {
  const router = express.Router();
  const sessions = new Map(); // token -> expiresAt
  const logins = makeLimiter(5, 15 * 60 * 1000); // per network

  const cookieToken = (req) => {
    const m = /(?:^|;\s*)buzzin_admin=([A-Za-z0-9_-]{20,64})/.exec(req.headers.cookie || '');
    return m ? m[1] : null;
  };
  const sessionOf = (req) => {
    const token = cookieToken(req);
    const exp = token && sessions.get(token);
    if (!exp) return null;
    if (exp <= now()) { sessions.delete(token); return null; }
    return token;
  };
  const prune = () => { for (const [t, exp] of sessions) if (exp <= now()) sessions.delete(t); };

  // Every POST must come from this site (no other site can make the browser post here).
  const sameOrigin = (req) => {
    const origin = req.headers.origin;
    const host = req.headers.host;
    return !!origin && !!host && (origin === `https://${host}` || origin === `http://${host}`);
  };

  router.use(express.json({ limit: '50kb' }));
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method === 'POST' && !sameOrigin(req)) return res.status(403).json({ error: 'This request didn\'t come from the admin page.' });
    next();
  });

  // Async handler: friendly errors only, never SQL or stack traces.
  const route = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      if (err instanceof Oops) return res.status(err.status).json({ error: err.message });
      console.error(`Admin request failed (${err.code || err.message}).`);
      res.status(500).json({ error: 'Something went wrong with the database. Please try again.' });
    }
  };
  const needDb = () => { if (!db.enabled()) throw new Oops(503, 'Community boards are off: the server has no database.'); };
  const needLogin = (req) => { if (!sessionOf(req)) throw new Oops(401, 'Please log in again.'); };
  const authed = (fn) => route(async (req, res) => { needLogin(req); needDb(); return fn(req, res); });

  // ---- Login ----
  router.get('/api/session', route(async (req) => ({ loggedIn: !!sessionOf(req), hasDb: db.enabled(), hasPin: !!pin })));

  router.post('/api/login', route(async (req, res) => {
    if (!pin) throw new Oops(503, 'Set ADMIN_PIN on the server first.');
    if (!logins.allow(ipOf(req), now())) throw new Oops(429, 'Too many tries. Please wait 15 minutes.');
    if (!samePin(req.body?.pin, pin)) throw new Oops(401, 'Wrong PIN.');
    prune();
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, now() + SESSION_MS);
    res.set('Set-Cookie', `${COOKIE}=${token}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`);
    return { ok: true };
  }));

  router.post('/api/logout', route(async (req, res) => {
    const token = cookieToken(req);
    if (token) sessions.delete(token);
    res.set('Set-Cookie', `${COOKIE}=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    return { ok: true };
  }));

  // ---- Boards ----
  // A board with everything the review needs. Status filter: 'pending' (oldest first) or 'listed'.
  async function boards(where, order) {
    const { rows: packs } = await db.query(
      `SELECT p.id, p.name, p.emoji, p.made_by, p.kid_friendly, p.suggested_tag, p.board_names, p.teams, p.sparkle,
              p.status, p.reject_reason, p.play_count, p.created_at, p.reviewed_at,
              COALESCE((SELECT json_agg(pt.tag_id ORDER BY pt.tag_id) FROM pack_tags pt WHERE pt.pack_id = p.id), '[]') AS tag_ids
         FROM packs p
        WHERE ${where} ORDER BY ${order} LIMIT 200`,
    ); // `where` / `order` are fixed strings below, never user input
    return packs;
  }

  router.get('/api/pending', authed(async () => {
    const packs = await boards("p.status = 'pending'", 'p.created_at ASC');
    const ids = packs.map((p) => p.id);
    const { rows: cats } = ids.length
      ? await db.query('SELECT pack_id, board_index, position, name, description, questions FROM categories WHERE pack_id = ANY($1::uuid[]) ORDER BY board_index, position', [ids])
      : { rows: [] };
    for (const p of packs) {
      p.boards = (p.board_names || []).map((name, bi) => ({
        name,
        categories: cats.filter((c) => c.pack_id === p.id && c.board_index === bi).map((c) => ({ name: c.name, note: c.description, questions: c.questions })),
      }));
    }
    return { boards: packs };
  }));

  router.get('/api/approved', authed(async () => ({ boards: await boards("p.status IN ('approved', 'archived')", 'p.reviewed_at DESC NULLS LAST, p.created_at DESC') })));

  // Edit a board's tags, made by, kid-friendly, or clear its suggested tag.
  router.post('/api/packs/:id', authed(async (req) => {
    const id = req.params.id;
    if (!isUuid(id)) throw new Oops(404, 'No such board.');
    const b = req.body || {};
    const sets = [];
    const vals = [id];
    if ('madeBy' in b) {
      const who = community.cleanMadeBy(b.madeBy);
      if (who.error) throw new Oops(400, who.error);
      vals.push(who.value); sets.push(`made_by = $${vals.length}`);
    }
    if ('kidFriendly' in b) {
      if (typeof b.kidFriendly !== 'boolean') throw new Oops(400, 'Kid-friendly must be on or off.');
      vals.push(b.kidFriendly); sets.push(`kid_friendly = $${vals.length}`);
    }
    if ('suggestedTag' in b) {
      if (b.suggestedTag !== null) throw new Oops(400, 'The suggested tag can only be cleared.');
      sets.push('suggested_tag = NULL');
    }
    let tagIds = null;
    if ('tags' in b) {
      if (!Array.isArray(b.tags) || b.tags.length > MAX_TAGS || b.tags.some((t) => !Number.isInteger(t))) throw new Oops(400, `Pick up to ${MAX_TAGS} tags.`);
      tagIds = [...new Set(b.tags)];
    }
    await db.transaction(async (c) => {
      const found = await c.query('SELECT 1 FROM packs WHERE id = $1 FOR UPDATE', [id]);
      if (!found.rowCount) throw new Oops(404, 'No such board.');
      if (sets.length) await c.query(`UPDATE packs SET ${sets.join(', ')} WHERE id = $1`, vals);
      if (tagIds) {
        const known = await c.query('SELECT count(*)::int AS n FROM tags WHERE id = ANY($1::int[])', [tagIds]);
        if (known.rows[0].n !== tagIds.length) throw new Oops(400, 'One of those tags no longer exists. Reload the page.');
        await c.query('DELETE FROM pack_tags WHERE pack_id = $1', [id]);
        for (const t of tagIds) await c.query('INSERT INTO pack_tags (pack_id, tag_id) VALUES ($1, $2)', [id, t]);
      }
    });
    return { ok: true };
  }));

  // Approve, reject, archive or unarchive.
  const MOVES = { approve: ['pending', 'approved'], reject: ['pending', 'rejected'], archive: ['approved', 'archived'], unarchive: ['archived', 'approved'] };
  router.post('/api/packs/:id/:action', authed(async (req) => {
    const { id, action } = req.params;
    if (!isUuid(id) || !Object.hasOwn(MOVES, action)) throw new Oops(404, 'No such board.');
    const [from, to] = MOVES[action];
    if (to === 'approved') {
      const tags = await db.query('SELECT count(*)::int AS n FROM pack_tags WHERE pack_id = $1', [id]);
      if (!tags.rows[0].n) throw new Oops(400, 'Tick at least 1 tag before approving.');
    }
    const reason = action === 'reject' ? cleanText(req.body?.reason ?? '', REASON_MAX) || null : null;
    const res = await db.query(
      `UPDATE packs SET status = $2, reviewed_at = CASE WHEN $3 THEN now() ELSE reviewed_at END,
              reject_reason = CASE WHEN $2 = 'rejected' THEN $4 ELSE reject_reason END
        WHERE id = $1 AND status = $5`,
      [id, to, from === 'pending', reason, from],
    );
    if (!res.rowCount) throw new Oops(409, 'That board changed in the meantime. Reload the page.');
    return { ok: true };
  }));

  // ---- Tags ----
  const tagFields = (b) => {
    const name = cleanText(b?.name ?? '', Infinity);
    const emoji = cleanText(b?.emoji ?? '', Infinity);
    if (!name) throw new Oops(400, 'Give the tag a name.');
    if (name.length > TAG_NAME_MAX) throw new Oops(400, `Tag names are at most ${TAG_NAME_MAX} characters.`);
    if ([...emoji].length > EMOJI_MAX) throw new Oops(400, 'Use one emoji.');
    const slug = db.slugify(name);
    if (!slug) throw new Oops(400, 'Tag names need some letters or numbers.');
    return { name, emoji, slug };
  };
  const tagSaved = async (fn) => {
    try { await fn(); } catch (err) {
      if (err.code === '23505') throw new Oops(409, 'A tag with that name already exists.');
      throw err;
    }
    await db.refreshTags(); // the Make your own prompt uses the new list straight away
  };

  router.get('/api/tags', authed(async () => ({
    tags: (await db.query(
      `SELECT t.id, t.slug, t.name, t.emoji, count(pt.pack_id)::int AS boards,
              count(pt.pack_id) FILTER (WHERE p.status = 'approved')::int AS approved
         FROM tags t LEFT JOIN pack_tags pt ON pt.tag_id = t.id LEFT JOIN packs p ON p.id = pt.pack_id
        GROUP BY t.id ORDER BY lower(t.name)`,
    )).rows,
  })));

  router.post('/api/tags', authed(async (req) => {
    const t = tagFields(req.body);
    let id;
    await tagSaved(async () => { id = (await db.query('INSERT INTO tags (slug, name, emoji) VALUES ($1, $2, $3) RETURNING id', [t.slug, t.name, t.emoji])).rows[0].id; });
    return { ok: true, id };
  }));

  router.post('/api/tags/:id', authed(async (req) => {
    const id = intId(req.params.id);
    const t = tagFields(req.body);
    await tagSaved(async () => {
      const res = await db.query('UPDATE tags SET slug = $2, name = $3, emoji = $4 WHERE id = $1', [id, t.slug, t.name, t.emoji]);
      if (!res.rowCount) throw new Oops(404, 'No such tag.');
    });
    return { ok: true };
  }));

  // Moves every board from this tag to another, then deletes it.
  router.post('/api/tags/:id/merge', authed(async (req) => {
    const from = intId(req.params.id);
    const into = Number.isInteger(req.body?.into) ? req.body.into : null;
    if (from == null || into == null || from === into) throw new Oops(400, 'Pick a different tag to merge into.');
    await tagSaved(() => db.transaction(async (c) => {
      const both = await c.query('SELECT id FROM tags WHERE id = ANY($1::int[]) FOR UPDATE', [[from, into]]);
      if (both.rowCount !== 2) throw new Oops(404, 'No such tag.');
      await c.query('INSERT INTO pack_tags (pack_id, tag_id) SELECT pack_id, $2 FROM pack_tags WHERE tag_id = $1 ON CONFLICT DO NOTHING', [from, into]);
      await c.query('DELETE FROM tags WHERE id = $1', [from]);
    }));
    return { ok: true };
  }));

  router.post('/api/tags/:id/delete', authed(async (req) => {
    const id = intId(req.params.id);
    await tagSaved(async () => {
      const res = await db.query('DELETE FROM tags WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM pack_tags WHERE tag_id = $1)', [id]);
      if (!res.rowCount) throw new Oops(409, 'Only unused tags can be deleted. Merge it into another tag instead.');
    });
    return { ok: true };
  }));

  router.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
  return router;
}

module.exports = { adminRouter, samePin };
