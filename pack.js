// Reads and checks question packs. Every pack goes through validatePack, built-in or uploaded.
// It only ever uses JSON.parse, rejects anything unexpected, and returns a clean copy.
const { cleanText } = require('./limits');
const { parseTable, looksLikeTable, packToTable } = require('./table');

const FORMAT = 'buzz-pack-v2';
const MAX_PACK_BYTES = 300 * 1024;
const MAX_TEAMS = 4;
const TEAM_NAME_MAX = 24;
const BOARD_VALUES = [
  [100, 200, 300, 400, 500], // Board 1
  [200, 400, 600, 800, 1000], // Board 2 (double)
];
const DRAW_LEVELS = ['easy', 'medium', 'tricky'];
const MAX_TAGS = 3;
const TAG_MAX = 24; // a tag's name
const SUGGESTED_TAG_MAX = 20;

// Uploaded packs get the strict limits. Built-in packs (written by us) may be a little longer,
// e.g. the wordy Professor Pyarelal questions, and may have up to 8 categories per board.
const LIMITS = {
  upload: { name: 40, note: 100, question: 300, answer: 100, bonus: 150, funFact: 200, sparkleItem: 80, sparkleList: 30, emoji: 8, minCategories: 5, maxCategories: 5 },
  builtin: { name: 40, note: 100, question: 600, answer: 100, bonus: 150, funFact: 200, sparkleItem: 150, sparkleList: 30, emoji: 8, minCategories: 5, maxCategories: 8 },
};

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const ordinal = (i) => i + 1;

// Takes pasted text or a file's contents: parses only from the first { to the last }.
function parsePackText(text) {
  const s = String(text ?? '');
  if (Buffer.byteLength(s, 'utf8') > MAX_PACK_BYTES) return { ok: false, errors: ['The pack is too big (over 300 KB).'] };
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, errors: ["Couldn't find a pack in that text. Paste Claude's whole reply."] };
  try {
    return { ok: true, value: JSON.parse(s.slice(start, end + 1)) };
  } catch {
    if (looksCutOff(s.slice(start))) {
      return { ok: false, errors: ["Claude's reply looks cut off: it stops before the end of the pack. Choose Reply format 📊 Table (it's shorter, and you can paste a \"continue\" reply underneath), or ask Claude to send the whole pack again."] };
    }
    return { ok: false, errors: ["That isn't valid JSON. Ask Claude to send the pack again as one JSON code block."] };
  }
}

// True when the JSON opens more { or [ than it closes (outside strings): Claude stopped mid-reply.
function looksCutOff(s) {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (ch === '\\') i++; else if (ch === '"') inStr = false; }
    else if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
  }
  return depth > 0 || inStr;
}

// Returns { ok: true, pack } with a cleaned copy, or { ok: false, errors: [...] }.
// options: { kind: 'upload' | 'builtin', allowNoBoards: false, knownTags: null }
// knownTags: the community tag names (from the database). Tags not on it become the suggested tag.
function validatePack(input, { kind = 'upload', allowNoBoards = false, knownTags = null } = {}) {
  const L = LIMITS[kind];
  const errors = [];
  const err = (msg) => { if (errors.length < 20) errors.push(msg); };

  // Only these keys are allowed on each object.
  const onlyKeys = (obj, allowed, where) => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) err(`${where} has an unknown field "${cleanText(k, 30)}".`);
  };
  // A required or optional string, cleaned and length-checked.
  const str = (value, max, where, required = true) => {
    if (value == null && !required) return undefined;
    if (typeof value !== 'string') { err(`${where} must be text.`); return undefined; }
    const clean = cleanText(value, Infinity);
    if (!clean && required) { err(`${where} is empty.`); return undefined; }
    if (clean.length > max) { err(`${where} is too long (${clean.length} characters, max ${max}).`); return undefined; }
    return clean || undefined;
  };
  const bool = (value, where) => {
    if (value == null) return undefined;
    if (typeof value !== 'boolean') { err(`${where} must be true or false.`); return undefined; }
    return value;
  };

  if (!isObj(input)) return { ok: false, errors: ['A pack must be one JSON object.'] };
  onlyKeys(input, ['format', 'name', 'emoji', 'teams', 'boards', 'sparkle', 'tags', 'suggestedTag', 'kidFriendly'], 'The pack');
  if (input.format !== FORMAT) err(`"format" must be "${FORMAT}".`);
  const pack = { format: FORMAT, name: str(input.name, L.name, 'The pack name'), emoji: undefined, boards: [] };
  if (input.emoji != null) {
    const e = str(input.emoji, 40, 'The emoji');
    if (e && [...e].length > L.emoji) err(`The emoji is too long (max ${L.emoji} characters).`);
    else pack.emoji = e;
  }

  // ---- Team names (optional): up to 4, used in order for Team 1, 2, 3, 4 ----
  if (input.teams != null) {
    if (!Array.isArray(input.teams)) err('"teams" must be a list of team names.');
    else if (input.teams.length > MAX_TEAMS) err(`"teams" has ${input.teams.length} names, max ${MAX_TEAMS}.`);
    else {
      const names = input.teams.map((t, i) => str(t, TEAM_NAME_MAX, `Team name ${ordinal(i)}`)).filter(Boolean);
      if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) err('The team names must all be different.');
      if (names.length) pack.teams = names;
    }
  }

  // ---- Community tags (optional): only used when sharing; playing ignores them ----
  Object.assign(pack, packTags(input, knownTags, err));
  pack.kidFriendly = bool(input.kidFriendly, '"kidFriendly"');

  // ---- Boards ----
  const boards = input.boards ?? [];
  const minBoards = allowNoBoards ? 0 : 1;
  if (!Array.isArray(boards)) err('"boards" must be a list.');
  else if (boards.length < minBoards || boards.length > 2) err(`A pack needs ${minBoards === 0 ? '0' : '1'}–2 boards; this one has ${boards.length}.`);
  else boards.forEach((b, bi) => {
    const bw = `Board ${ordinal(bi)}`;
    if (!isObj(b)) return err(`${bw} must be an object.`);
    onlyKeys(b, ['name', 'categories'], bw);
    const board = { name: str(b.name, L.name, `${bw} name`), categories: [] };
    const cats = b.categories;
    if (!Array.isArray(cats)) return err(`${bw} needs a "categories" list.`);
    if (cats.length < L.minCategories || cats.length > L.maxCategories) {
      const need = L.minCategories === L.maxCategories ? `${L.minCategories}` : `${L.minCategories}–${L.maxCategories}`;
      return err(`${bw} has ${cats.length} categories, needs ${need}.`);
    }
    cats.forEach((c, ci) => {
      const cw = `${bw}, category ${ordinal(ci)}`;
      if (!isObj(c)) return err(`${cw} must be an object.`);
      onlyKeys(c, ['name', 'note', 'default', 'questions'], cw);
      const cat = {
        name: str(c.name, L.name, `${cw} name`),
        note: str(c.note, L.note, `${cw} note`, false),
        default: bool(c.default, `${cw} "default"`),
        questions: [],
      };
      const qs = c.questions;
      if (!Array.isArray(qs)) return err(`${cw} needs a "questions" list.`);
      if (qs.length !== 5) return err(`${cw} has ${qs.length} questions, needs 5.`);
      qs.forEach((q, qi) => {
        const qw = `${cw}, question ${ordinal(qi)}`;
        if (!isObj(q)) return err(`${qw} must be an object.`);
        // "trapAnswer" is from an older version of the game: still allowed (so old packs load) but ignored.
        onlyKeys(q, ['value', 'question', 'answer', 'bonus', 'bonusPoints', 'funFact', 'trapAnswer', 'verify'], qw);
        const want = BOARD_VALUES[bi][qi];
        if (q.value !== want) err(`${qw} should be worth ${want} (Board ${ordinal(bi)} goes ${BOARD_VALUES[bi].join(', ')}).`);
        let bonusPoints;
        if (q.bonusPoints != null) {
          if (!Number.isInteger(q.bonusPoints) || q.bonusPoints < 0 || q.bonusPoints > 500) err(`${qw} "bonusPoints" must be a whole number from 0 to 500.`);
          else bonusPoints = q.bonusPoints;
        }
        const bonus = str(q.bonus, L.bonus, `${qw} bonus`, false);
        cat.questions.push(strip({
          value: want,
          question: str(q.question, L.question, `${qw} text`),
          answer: str(q.answer, L.answer, `${qw} answer`),
          bonus,
          bonusPoints: bonus ? bonusPoints ?? 50 : undefined,
          funFact: str(q.funFact, L.funFact, `${qw} fun fact`, false),
          verify: bool(q.verify, `${qw} "verify"`),
        }));
      });
      board.categories.push(strip(cat));
    });
    // Which 5 categories play by default: the ones marked "default", or else the first 5.
    const flagged = board.categories.filter((c) => c.default).length;
    if (flagged && flagged !== 5) err(`${bw} marks ${flagged} categories as default, needs exactly 5.`);
    pack.boards.push(board);
  });

  // ---- Sparkle decks (optional) ----
  if (input.sparkle != null) {
    const s = input.sparkle;
    const list = (arr, where) => {
      if (arr == null) return [];
      if (!Array.isArray(arr)) { err(`${where} must be a list.`); return []; }
      if (arr.length > L.sparkleList) err(`${where} has ${arr.length} items, max ${L.sparkleList}.`);
      return arr.slice(0, L.sparkleList).map((x, i) => str(x, L.sparkleItem, `${where} item ${ordinal(i)}`)).filter(Boolean);
    };
    if (!isObj(s)) err('"sparkle" must be an object.');
    else {
      onlyKeys(s, ['draw', 'charades', 'mimic'], 'Sparkle');
      const draw = {};
      if (s.draw != null) {
        if (!isObj(s.draw)) err('Sparkle "draw" must be an object.');
        else {
          onlyKeys(s.draw, DRAW_LEVELS, 'Sparkle "draw"');
          for (const lvl of DRAW_LEVELS) draw[lvl] = list(s.draw[lvl], `Sparkle draw ${lvl}`);
        }
      }
      pack.sparkle = { draw, charades: list(s.charades, 'Sparkle charades'), mimic: list(s.mimic, 'Sparkle mimic') };
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, pack: strip(pack) };
}

// "tags", "suggestedTag": Claude picks 1–3 tags from the list it was given. A tag that isn't on the
// list doesn't fail the pack: it becomes the suggested tag (only the first one is kept) for the
// admin to decide on. Known tags are matched ignoring case and spelt like the list.
function packTags(input, knownTags, err) {
  const out = {};
  const clean = (t, max) => (typeof t === 'string' ? cleanText(t, max) : '');
  if (input.tags != null && !Array.isArray(input.tags)) err('"tags" must be a list of tag names.');
  if (input.suggestedTag != null && typeof input.suggestedTag !== 'string') err('"suggestedTag" must be text.');
  const given = Array.isArray(input.tags) ? input.tags.slice(0, 20).map((t) => clean(t, TAG_MAX)).filter(Boolean) : [];
  const key = (t) => t.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
  const byKey = new Map((knownTags || []).map((t) => [key(t), t]));
  const tags = [];
  const unknown = [];
  for (const t of given) {
    const known = knownTags ? byKey.get(key(t)) : t; // no tag list (no database): keep them as given
    if (!known) unknown.push(t);
    else if (!tags.includes(known)) tags.push(known);
  }
  let suggested = clean(input.suggestedTag, Infinity) || unknown[0] || '';
  const suggestedKnown = knownTags && byKey.get(key(suggested));
  if (suggestedKnown) { // Claude "suggested" a tag that already exists: just use it
    if (!tags.includes(suggestedKnown)) tags.push(suggestedKnown);
    suggested = '';
  }
  if (tags.length) out.tags = tags.slice(0, MAX_TAGS);
  if (suggested) out.suggestedTag = cleanText(suggested, SUGGESTED_TAG_MAX);
  return out;
}

// Drops undefined fields so the cleaned pack only has what was given.
function strip(obj) {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}

// The 5 categories a board plays with by default.
function defaultCategories(board) {
  const flagged = board.categories.filter((c) => c.default);
  return flagged.length === 5 ? flagged : board.categories.slice(0, 5);
}

// What the "Make your own" screen shows after a check: names, counts, and a "check these" list
// (questions marked verify). Takes a pack that already passed validatePack.
function packPreview(pack) {
  const checks = [];
  pack.boards.forEach((b, bi) => b.categories.forEach((c) => c.questions.forEach((q) => {
    const where = `Board ${bi + 1} · ${c.name} · ${q.value}`;
    if (q.verify) checks.push({ where, kind: 'verify', question: q.question, answer: q.answer });
  })));
  return {
    name: pack.name, emoji: pack.emoji || '',
    teams: pack.teams || [],
    boards: pack.boards.map((b) => ({ name: b.name, categories: b.categories.map((c) => c.name) })),
    questions: pack.boards.reduce((n, b) => n + b.categories.length * 5, 0),
    hasSparkle: !!pack.sparkle,
    tags: pack.tags || [],
    suggestedTag: pack.suggestedTag || '',
    kidFriendly: !!pack.kidFriendly,
    checks,
  };
}

// Pasted text or file contents (JSON, or a CSV / spreadsheet table) -> { ok, pack, preview } or
// { ok: false, errors }. Always the strict upload rules.
function checkUploadedText(text, { fallbackName, knownTags = null } = {}) {
  const s = String(text ?? '');
  if (Buffer.byteLength(s, 'utf8') > MAX_PACK_BYTES) return { ok: false, errors: ['The pack is too big (over 300 KB).'] };
  const parsed = looksLikeTable(s) ? parseTable(s, { fallbackName: cleanText(fallbackName || '', 40) || 'My pack' }) : parsePackText(s);
  if (!parsed.ok) return parsed;
  const res = validatePack(parsed.value, { kind: 'upload', knownTags });
  if (!res.ok) return res;
  return { ok: true, pack: res.pack, preview: packPreview(res.pack), csv: packToTable(res.pack) };
}

module.exports = { FORMAT, BOARD_VALUES, LIMITS, MAX_TAGS, MAX_PACK_BYTES, parsePackText, validatePack, defaultCategories, packPreview, checkUploadedText };
