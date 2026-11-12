// Reads and checks question packs. Every pack goes through validatePack, built-in or uploaded.
// It only ever uses JSON.parse, rejects anything unexpected, and returns a clean copy.
const { cleanText } = require('./limits');

const FORMAT = 'buzz-pack-v2';
const MAX_PACK_BYTES = 300 * 1024;
const BOARD_VALUES = [
  [100, 200, 300, 400, 500], // Board 1
  [200, 400, 600, 800, 1000], // Board 2 (double)
];
const DRAW_LEVELS = ['easy', 'medium', 'tricky'];

// Uploaded packs get the strict limits. Built-in packs (written by us) may be a little longer,
// e.g. the wordy Professor Pyarelal questions, and may have up to 8 categories per board.
const LIMITS = {
  upload: { name: 40, note: 100, question: 300, answer: 100, bonus: 150, funFact: 200, trapAnswer: 100, sparkleItem: 80, sparkleList: 30, emoji: 8, minCategories: 5, maxCategories: 5 },
  builtin: { name: 40, note: 100, question: 600, answer: 100, bonus: 150, funFact: 200, trapAnswer: 100, sparkleItem: 150, sparkleList: 30, emoji: 8, minCategories: 5, maxCategories: 8 },
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
    return { ok: false, errors: ["That isn't valid JSON. Ask Claude to send the pack again as one JSON code block."] };
  }
}

// Returns { ok: true, pack } with a cleaned copy, or { ok: false, errors: [...] }.
// options: { kind: 'upload' | 'builtin', allowNoBoards: false }
function validatePack(input, { kind = 'upload', allowNoBoards = false } = {}) {
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
  onlyKeys(input, ['format', 'name', 'emoji', 'boards', 'sparkle'], 'The pack');
  if (input.format !== FORMAT) err(`"format" must be "${FORMAT}".`);
  const pack = { format: FORMAT, name: str(input.name, L.name, 'The pack name'), emoji: undefined, boards: [] };
  if (input.emoji != null) {
    const e = str(input.emoji, 40, 'The emoji');
    if (e && [...e].length > L.emoji) err(`The emoji is too long (max ${L.emoji} characters).`);
    else pack.emoji = e;
  }

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
          trapAnswer: str(q.trapAnswer, L.trapAnswer, `${qw} trap answer`, false),
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
// (questions marked verify, and every trap answer). Takes a pack that already passed validatePack.
function packPreview(pack) {
  const checks = [];
  pack.boards.forEach((b, bi) => b.categories.forEach((c) => c.questions.forEach((q) => {
    const where = `Board ${bi + 1} · ${c.name} · ${q.value}`;
    if (q.verify) checks.push({ where, kind: 'verify', question: q.question, answer: q.answer });
    if (q.trapAnswer) checks.push({ where, kind: 'trap', question: q.question, answer: q.answer, trapAnswer: q.trapAnswer });
  })));
  return {
    name: pack.name, emoji: pack.emoji || '',
    boards: pack.boards.map((b) => ({ name: b.name, categories: b.categories.map((c) => c.name) })),
    questions: pack.boards.reduce((n, b) => n + b.categories.length * 5, 0),
    hasSparkle: !!pack.sparkle,
    checks,
  };
}

// Pasted text or file contents -> { ok, pack, preview } or { ok: false, errors }. Always the strict upload rules.
function checkUploadedText(text) {
  const parsed = parsePackText(text);
  if (!parsed.ok) return parsed;
  const res = validatePack(parsed.value, { kind: 'upload' });
  if (!res.ok) return res;
  return { ok: true, pack: res.pack, preview: packPreview(res.pack) };
}

module.exports = { FORMAT, BOARD_VALUES, LIMITS, MAX_PACK_BYTES, parsePackText, validatePack, defaultCategories, packPreview, checkUploadedText };
