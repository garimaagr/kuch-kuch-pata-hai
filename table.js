// The "table" pack format: one row per question, so Claude's reply can be opened in Excel or
// Google Sheets, reviewed, and pasted back (as CSV, or as tab-separated cells copied from a sheet).
// It only turns text into a plain pack object; validatePack still checks everything afterwards.
//
//   Board,Category,Points,Question,Answer,Bonus,Fun fact,Verify,How to play
//   Pack,90s Cartoons,📼                          <- optional: pack name and emoji
//   Team,Team Saturday Morning                    <- optional: a team name (up to 4 rows)
//   Tags,Cartoons & Kids,TV                       <- optional: community tags (1–3)
//   Suggested tag,Saturday Mornings               <- optional: a new tag idea
//   Kid friendly,yes                              <- optional: yes or no
//   Theme Tunes,Explained Badly,100,…,…,…,,,      <- a question (Board = the board's name)
//   Sparkle,Draw easy,,Skateboard                 <- a Sparkle card (item in the Question column)

const COLUMNS = {
  board: 'board', category: 'category', points: 'points', value: 'points', question: 'question', answer: 'answer',
  bonus: 'bonus', funfact: 'funFact', verify: 'verify', howtoplay: 'note', note: 'note', // other columns are ignored
};
const REQUIRED = ['board', 'category', 'points', 'question', 'answer'];
const SPARKLE_LISTS = { draweasy: ['draw', 'easy'], drawmedium: ['draw', 'medium'], drawtricky: ['draw', 'tricky'], charades: ['charades'], mimic: ['mimic'] };
const MAX_ROWS = 600;

const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');

// Splits CSV or TSV text into rows of cells. Handles "quoted, cells" with "" for a quote and line breaks inside.
function splitRows(text, delim) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell.trim() === '') { cell = ''; quoted = true; }
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; if (rows.length > MAX_ROWS) break; }
    else if (ch !== '\r') cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

// A spreadsheet-safe cell: a leading ' was added on download so Excel doesn't treat "=…" as a formula.
const cellText = (s) => String(s ?? '').trim().replace(/^'(?=[=+\-@])/, '');

// Does this text look like a table (a header row with Board and Question columns)?
function looksLikeTable(text) {
  return /^\s*"?board"?\s*[,\t;].*question/im.test(String(text).replace(/^﻿/, ''));
}

// Text -> { ok: true, value: <pack object> } or { ok: false, errors: [...] }.
function parseTable(text, { fallbackName = 'My pack' } = {}) {
  const lines = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
    .filter((l) => !/^\s*```/.test(l)); // drop code-fence lines, including ones between "continue" replies
  const headerAt = lines.findIndex((l) => /^\s*"?board"?\s*[,\t;]/i.test(l) && /question/i.test(l));
  if (headerAt < 0) return { ok: false, errors: ['Couldn\'t find the header row (Board, Category, Points, Question, Answer, …).'] };
  const headerLine = lines[headerAt];
  const delim = (headerLine.match(/\t/g) || []).length > (headerLine.match(/,/g) || []).length ? '\t'
    : (headerLine.match(/;/g) || []).length > (headerLine.match(/,/g) || []).length ? ';' : ',';
  const rows = splitRows(lines.slice(headerAt).join('\n'), delim);
  if (rows.length > MAX_ROWS) return { ok: false, errors: [`That table has too many rows (max ${MAX_ROWS}).`] };

  const cols = {};
  rows[0].forEach((h, i) => { const key = COLUMNS[norm(h)]; if (key && cols[key] == null) cols[key] = i; });
  const missing = REQUIRED.filter((k) => cols[k] == null);
  if (missing.length) return { ok: false, errors: [`The table is missing these columns: ${missing.join(', ')}.`] };

  const errors = [];
  const pack = { format: 'buzz-pack-v2', name: '', emoji: '', boards: [] };
  const boards = new Map(); // board name -> { name, cats: Map(category name -> questions) }
  const notes = new Map(); // 'board\u0001category' -> how-to-play line (from any row of that category)
  const sparkle = {};
  const seen = new Set();
  const get = (r, k) => (cols[k] == null ? '' : cellText(r[cols[k]]));

  rows.slice(1).forEach((r, i) => {
    const rowNo = headerAt + i + 2;
    const filled = r.filter((c) => cellText(c)).length;
    if (!filled) return;
    const key = r.map(cellText).join('\u0001');
    if (seen.has(key)) return; // a repeated row (e.g. Claude repeating the last row after "continue")
    seen.add(key);
    const board = get(r, 'board');
    if (norm(board) === 'board' && /question/i.test(get(r, 'question'))) return; // header repeated after "continue"
    if (norm(board) === 'pack') {
      pack.name = get(r, 'category');
      pack.emoji = cellText(r[cols.points]);
      return;
    }
    if (norm(board) === 'team' || norm(board) === 'teams') { // Team,<name> (or several names on one row)
      r.slice(1).map(cellText).filter(Boolean).forEach((t) => (pack.teams ||= []).push(t));
      return;
    }
    if (norm(board) === 'tags' || norm(board) === 'tag') {
      r.slice(1).map(cellText).filter(Boolean).forEach((t) => (pack.tags ||= []).push(t));
      return;
    }
    if (norm(board) === 'suggestedtag') {
      const t = r.slice(1).map(cellText).find(Boolean);
      if (t) pack.suggestedTag = t;
      return;
    }
    if (norm(board) === 'kidfriendly') {
      const v = r.slice(1).map(cellText).find(Boolean) || '';
      if (/^(y|yes|true|1|✓|✔)$/i.test(v)) pack.kidFriendly = true;
      else if (/^(n|no|false|0)$/i.test(v)) pack.kidFriendly = false;
      return;
    }
    if (norm(board) === 'sparkle') {
      const where = SPARKLE_LISTS[norm(get(r, 'category'))];
      const item = get(r, 'question');
      if (!where || !item) return;
      const [list, level] = where;
      if (level) ((sparkle.draw ||= {})[level] ||= []).push(item);
      else (sparkle[list] ||= []).push(item);
      return;
    }
    if (filled < 3) return; // stray chat text like "Have fun!"
    const category = get(r, 'category');
    const question = get(r, 'question');
    const answer = get(r, 'answer');
    const points = Number(get(r, 'points').replace(/[^\d]/g, ''));
    if (!board || !category) return errors.push(`Row ${rowNo} needs a Board and a Category.`);
    if (!question || !answer) return errors.push(`Row ${rowNo} (${category}, ${points || '?'}) has no ${question ? 'answer' : 'question'}. If Claude stopped early, type "continue" in Claude and paste the rest underneath.`);
    if (!boards.has(board)) boards.set(board, { name: board, cats: new Map() });
    const cats = boards.get(board).cats;
    if (!cats.has(category)) cats.set(category, []);
    if (get(r, 'note') && !notes.has(board + '\u0001' + category)) notes.set(board + '\u0001' + category, get(r, 'note'));
    const v = get(r, 'verify');
    cats.get(category).push({
      value: points, question, answer,
      ...(get(r, 'bonus') ? { bonus: get(r, 'bonus'), bonusPoints: 50 } : {}),
      ...(get(r, 'funFact') ? { funFact: get(r, 'funFact') } : {}),
      ...(/^(y|yes|true|x|1|✓|✔)$/i.test(v) ? { verify: true } : {}),
    });
  });

  // Board 1 uses 100–500 and Board 2 uses 200–1000, so the points tell them apart.
  const list = [...boards.values()];
  const isBoard2 = (b) => [...b.cats.values()].flat().some((q) => q.value > 500);
  list.sort((a, b) => isBoard2(a) - isBoard2(b));
  if (!list.length) errors.push('No questions found in the table.');
  if (list.length > 2) errors.push(`The table has ${list.length} different Board names (${list.map((b) => b.name).join(', ')}); a pack has 1 or 2.`);
  for (const b of list) {
    for (const [name, qs] of b.cats) {
      if (qs.length !== 5) errors.push(`"${b.name}" → "${name}" has ${qs.length} question${qs.length === 1 ? '' : 's'}, needs 5.`);
      qs.sort((x, y) => x.value - y.value);
    }
    if (b.cats.size !== 5) errors.push(`"${b.name}" has ${b.cats.size} categories, needs 5.`);
  }
  const short = list.some((b) => b.cats.size < 5 || [...b.cats.values()].some((qs) => qs.length < 5));
  if (errors.length) {
    const list20 = errors.slice(0, 19);
    if (short) list20.push('If Claude stopped early, type "continue" in Claude and paste the rest underneath (no need to remove the extra header).');
    return { ok: false, errors: list20 };
  }

  pack.name ||= fallbackName;
  if (!pack.emoji) delete pack.emoji;
  pack.boards = list.map((b) => ({ name: b.name, categories: [...b.cats].map(([name, questions]) => {
    const note = notes.get(b.name + '\u0001' + name);
    return note ? { name, note, questions } : { name, questions };
  }) }));
  if (Object.keys(sparkle).length) pack.sparkle = sparkle;
  return { ok: true, value: pack };
}

// A checked pack -> CSV text for Excel / Google Sheets (with a BOM so Excel reads emoji correctly).
// Cells starting with = + - @ get a leading ' so a spreadsheet never runs them as formulas.
function packToTable(pack) {
  const cell = (v) => {
    let t = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const rows = [['Board', 'Category', 'Points', 'Question', 'Answer', 'Bonus', 'Fun fact', 'Verify', 'How to play']];
  rows.push(['Pack', pack.name, pack.emoji || '']);
  for (const t of pack.teams || []) rows.push(['Team', t]);
  if (pack.tags?.length) rows.push(['Tags', ...pack.tags]);
  if (pack.suggestedTag) rows.push(['Suggested tag', pack.suggestedTag]);
  if (pack.kidFriendly != null) rows.push(['Kid friendly', pack.kidFriendly ? 'yes' : 'no']);
  for (const b of pack.boards) for (const c of b.categories) c.questions.forEach((q, i) => {
    rows.push([b.name, c.name, q.value, q.question, q.answer, q.bonus || '', q.funFact || '', q.verify ? 'yes' : '', i === 0 ? c.note || '' : '']);
  });
  const sp = pack.sparkle || {};
  const lists = [['Draw easy', sp.draw?.easy], ['Draw medium', sp.draw?.medium], ['Draw tricky', sp.draw?.tricky], ['Charades', sp.charades], ['Mimic', sp.mimic]];
  for (const [label, items] of lists) for (const item of items || []) rows.push(['Sparkle', label, '', item]);
  return '\uFEFF' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { parseTable, looksLikeTable, splitRows, packToTable };
