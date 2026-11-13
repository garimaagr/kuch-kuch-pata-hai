// ⭐ Featured themes: the built-in packs in packs/<id>.json, plus categories the admin has added to
// them from shared boards ("extras", in the featured_extras table). Extras are optional: they show in
// Customise but are off by default. Without a database, a theme is just its file.
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { validatePack, BOARD_VALUES, LIMITS } = require('./pack');

// Built-in packs live in packs/<id>.json. Ids come from this folder, never from a visitor.
const PACK_DIR = path.join(__dirname, 'packs');
const DEFAULT_PACK = 'desi';
const MAX_CATEGORIES = LIMITS.builtin.maxCategories; // per board, file categories + extras

// The theme cards on the setup screen, in order. A theme without a pack file shows as "coming soon".
const THEMES = [
  { id: 'desi', name: 'Desi Night', emoji: '🎬' },
  { id: 'world', name: 'World Trivia', emoji: '🌍' },
  { id: 'tv', name: 'TV & Movies', emoji: '📺' },
  { id: 'sports', name: 'Sports', emoji: '🏆' },
];
const isTheme = (id) => THEMES.some((t) => t.id === id);

function readPackFile(id) {
  const ids = fs.readdirSync(PACK_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  if (!ids.includes(id)) throw new Error(`No pack called "${id}"`);
  return JSON.parse(fs.readFileSync(path.join(PACK_DIR, id + '.json'), 'utf8'));
}

// A built-in pack as written in its file, checked. Throws if the file is broken.
function loadFilePack(id, opts = {}) {
  const res = validatePack(readPackFile(id), { kind: 'builtin', ...opts });
  if (!res.ok) throw new Error(`packs/${id}.json: ${res.errors.join(' ')}`);
  return res.pack;
}

// An extra as a pack category: optional, with the target board's point values in question order.
const extraCategory = (x) => ({
  name: x.name, ...(x.note ? { note: x.note } : {}), default: false,
  questions: x.questions.map((q, i) => ({ ...q, value: BOARD_VALUES[x.board_index][i] })),
});

// The pack a game uses: its file, plus its extras at the end of each board. Re-read each game, so hand
// edits show up on New game. If the extras ever make the pack fail its check, the file alone is used.
function loadBuiltinPack(id, opts = {}) {
  const pack = loadFilePack(id, opts);
  const extras = db.featuredExtras().filter((x) => x.theme_id === id && x.board_index < pack.boards.length);
  if (!extras.length) return pack;
  const raw = readPackFile(id);
  for (const x of extras) {
    const cats = raw.boards[x.board_index].categories;
    const taken = new Set(cats.map((c) => String(c.name).toLowerCase()));
    if (cats.length < MAX_CATEGORIES && !taken.has(x.name.toLowerCase())) cats.push(extraCategory(x));
  }
  const res = validatePack(raw, { kind: 'builtin', ...opts });
  if (!res.ok) {
    console.error(`Featured extras for "${id}" skipped: ${res.errors[0]}`);
    return pack;
  }
  return res.pack;
}

// For /admin: every theme's boards, how full they are, and the extras on each.
function themeBoards() {
  return THEMES.map((t) => {
    let pack;
    try { pack = loadFilePack(t.id); } catch { return { id: t.id, name: t.name, emoji: t.emoji, missing: true, boards: [] }; }
    return {
      id: t.id, name: pack.name, emoji: pack.emoji || t.emoji,
      boards: pack.boards.map((b, bi) => {
        const extras = db.featuredExtras().filter((x) => x.theme_id === t.id && x.board_index === bi)
          .map((x) => ({ id: x.id, name: x.name, addedAt: x.added_at, fromBoard: x.source_pack_name || null }));
        const used = b.categories.length + extras.length;
        return { index: bi, name: b.name, categories: used, free: Math.max(0, MAX_CATEGORIES - used), extras };
      }),
    };
  });
}

module.exports = { THEMES, DEFAULT_PACK, MAX_CATEGORIES, isTheme, loadFilePack, loadBuiltinPack, extraCategory, themeBoards };
