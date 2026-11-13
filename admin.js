// The /admin review page's server side: PIN login, sessions, and the review / tags / ⭐ Featured extras API.
// Parameterised SQL only. Never log the PIN or session tokens.

const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const community = require('./community');
const { makeLimiter, cleanText, TAG_PATTERN } = require('./limits');
const { MAX_TAGS, validatePack } = require('./pack');
const featured = require('./featured');

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

  // Secure cookies only over HTTPS (Render sets x-forwarded-proto). Safari, and any browser on
  // http://<wifi IP>, drops a Secure cookie sent over plain http, which made local logins bounce.
  const secure = (req) => (req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '');

  router.post('/api/login', route(async (req, res) => {
    if (!pin) throw new Oops(503, 'Set ADMIN_PIN on the server first.');
    if (!logins.allow(ipOf(req), now())) throw new Oops(429, 'Too many tries. Please wait 15 minutes.');
    if (!samePin(req.body?.pin, pin)) throw new Oops(401, 'Wrong PIN.');
    prune();
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, now() + SESSION_MS);
    res.set('Set-Cookie', `${COOKIE}=${token}; Path=/admin; HttpOnly${secure(req)}; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`);
    return { ok: true };
  }));

  router.post('/api/logout', route(async (req, res) => {
    const token = cookieToken(req);
    if (token) sessions.delete(token);
    res.set('Set-Cookie', `${COOKIE}=; Path=/admin; HttpOnly${secure(req)}; SameSite=Strict; Max-Age=0`);
    return { ok: true };
  }));

  // ---- Boards ----
  // A board with everything the review needs. Status filter: 'pending' (oldest first) or 'listed'.
  async function boards(where, order) {
    const { rows: packs } = await db.query(
      `SELECT p.id, p.name, p.emoji, p.made_by, p.kid_friendly, p.suggested_tag, p.board_names, p.teams, p.sparkle,
              p.status, p.reject_reason, p.play_count, p.created_at, p.reviewed_at,
              -- ⚠️ HTML flag: tags were removed when it was shared, or an older board still holds some
              -- (those are removed whenever the board is played).
              (p.html_stripped OR concat_ws(' ', p.name, p.made_by, p.board_names::text, p.teams::text, p.sparkle::text) ~ $1
                OR EXISTS (SELECT 1 FROM categories c WHERE c.pack_id = p.id
                             AND concat_ws(' ', c.name, c.description, c.questions::text) ~ $1)) AS html_flag,
              COALESCE((SELECT json_agg(pt.tag_id ORDER BY pt.tag_id) FROM pack_tags pt WHERE pt.pack_id = p.id), '[]') AS tag_ids
         FROM packs p
        WHERE ${where} ORDER BY ${order} LIMIT 200`,
      [TAG_PATTERN],
    ); // `where` / `order` are fixed strings below, never user input
    return packs;
  }

  router.get('/api/pending', authed(async () => {
    const packs = await boards("p.status = 'pending'", 'p.created_at ASC');
    const ids = packs.map((p) => p.id);
    const { rows: cats } = ids.length
      ? await db.query('SELECT id, pack_id, board_index, position, name, description, questions FROM categories WHERE pack_id = ANY($1::uuid[]) ORDER BY board_index, position', [ids])
      : { rows: [] };
    for (const p of packs) {
      p.boards = (p.board_names || []).map((name, bi) => ({
        name,
        categories: cats.filter((c) => c.pack_id === p.id && c.board_index === bi).map((c) => ({ id: c.id, name: c.name, note: c.description, questions: c.questions })),
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

  // ---- ⭐ Featured extras: categories from shared boards added to a Featured theme ----
  // Every theme's boards, how many categories each has (of 8) and the extras on it.
  router.get('/api/featured', authed(async () => ({ max: featured.MAX_CATEGORIES, themes: featured.themeBoards() })));

  // Adds categories (by id) to one board of a Featured theme. Each becomes its own copy, with the
  // board's point values in question order. The shared board itself isn't changed (its status stays).
  router.post('/api/featured', authed(async (req) => {
    const b = req.body || {};
    const themeId = typeof b.themeId === 'string' ? b.themeId : '';
    if (!featured.isTheme(themeId)) throw new Oops(400, 'Pick a Featured theme.');
    let file;
    try { file = featured.loadFilePack(themeId); } catch { throw new Oops(409, 'That theme isn\'t available.'); }
    const bi = b.boardIndex;
    if (!Number.isInteger(bi) || bi < 0 || bi >= file.boards.length) throw new Oops(400, 'Pick a board.');
    const ids = Array.isArray(b.categoryIds) ? b.categoryIds.map(intId) : [];
    if (!ids.length) throw new Oops(400, 'Tick at least 1 category.');
    if (ids.some((id) => id == null) || new Set(ids).size !== ids.length || ids.length > featured.MAX_CATEGORIES) throw new Oops(400, 'Those categories don\'t look right. Reload the page.');
    const where = `${file.name} › ${file.boards[bi].name}`;

    await db.transaction(async (c) => {
      // One add at a time, so two at once can't both squeeze into the last free slot.
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['featured_extras']);
      const { rows: cats } = await c.query('SELECT id, name, description, questions FROM categories WHERE id = ANY($1::int[])', [ids]);
      if (cats.length !== ids.length) throw new Oops(404, 'One of those categories no longer exists. Reload the page.');
      const { rows: have } = await c.query('SELECT name, source_category_id FROM featured_extras WHERE theme_id = $1 AND board_index = $2', [themeId, bi]);

      const used = file.boards[bi].categories.length + have.length;
      const free = featured.MAX_CATEGORIES - used;
      if (free <= 0) throw new Oops(409, `${where} is full (${featured.MAX_CATEGORIES} categories). Remove one of its extras first.`);
      if (ids.length > free) throw new Oops(409, `${where} has room for ${free} more categor${free === 1 ? 'y' : 'ies'} (it has ${used} of ${featured.MAX_CATEGORIES}). Tick fewer.`);
      const taken = new Set([...file.boards[bi].categories.map((x) => x.name), ...have.map((x) => x.name)].map((n) => n.toLowerCase()));
      const added = new Set(have.map((x) => x.source_category_id));
      for (const cat of cats) {
        if (added.has(cat.id)) throw new Oops(409, `"${cat.name}" is already on ${where}.`);
        if (taken.has(cat.name.toLowerCase())) throw new Oops(409, `${where} already has a category called "${cat.name}".`);
        taken.add(cat.name.toLowerCase());
      }

      // Check the theme with these added, using the same rules as the game.
      const extras = cats.map((cat) => featured.extraCategory({ name: cat.name, note: cat.description, questions: cat.questions, board_index: bi }));
      const trial = { ...file, boards: file.boards.map((bd, i) => (i === bi ? { ...bd, categories: [...bd.categories, ...extras] } : bd)) };
      const checked = validatePack(trial, { kind: 'builtin' });
      if (!checked.ok) throw new Oops(400, `Can't add those: ${checked.errors[0]}`);
      const clean = checked.pack.boards[bi].categories.slice(-extras.length);

      // Stored in the order ticked (the same order they show in Customise).
      for (const id of ids) {
        const src = clean[cats.findIndex((cat) => cat.id === id)];
        await c.query(
          'INSERT INTO featured_extras (theme_id, board_index, name, note, questions, source_category_id) VALUES ($1, $2, $3, $4, $5, $6)',
          [themeId, bi, src.name, src.note || null, JSON.stringify(src.questions), id],
        );
      }
    });
    await db.refreshExtras();
    return { ok: true, message: `Added ${ids.length} categor${ids.length === 1 ? 'y' : 'ies'} to ${where}. They're optional in Customise.` };
  }));

  router.post('/api/featured/:id/remove', authed(async (req) => {
    const id = intId(req.params.id);
    const res = id == null ? { rowCount: 0 } : await db.query('DELETE FROM featured_extras WHERE id = $1', [id]);
    if (!res.rowCount) throw new Oops(404, 'That extra is already gone.');
    await db.refreshExtras();
    return { ok: true };
  }));

  router.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
  return router;
}

module.exports = { adminRouter, samePin };
