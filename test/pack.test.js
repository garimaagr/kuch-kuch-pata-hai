const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parsePackText, validatePack, defaultCategories, checkUploadedText } = require('../pack');

// A small valid pack with `boardCount` boards.
function goodPack(boardCount = 2) {
  const values = [[100, 200, 300, 400, 500], [200, 400, 600, 800, 1000]];
  return {
    format: 'buzz-pack-v2',
    name: 'Test Pack',
    emoji: '🧪',
    boards: values.slice(0, boardCount).map((vals, b) => ({
      name: `Board ${b + 1}`,
      categories: [1, 2, 3, 4, 5].map((c) => ({
        name: `Category ${c}`,
        questions: vals.map((value) => ({ value, question: `Q ${value}?`, answer: 'A', bonus: 'Do a dance', bonusPoints: 50 })),
      })),
    })),
    sparkle: { draw: { easy: ['Cat'], medium: ['Kite'], tricky: ['Parallel parking'] }, charades: ['Swimming'], mimic: ['Talk like a pirate'] },
  };
}
const firstError = (res) => (res.ok ? '' : res.errors[0]);

test('a good pack passes and comes back cleaned', () => {
  const p = goodPack();
  p.boards[0].categories[0].questions[0].question = '  Two   spaces\u0000 ';
  const res = validatePack(p);
  assert.ok(res.ok, res.errors?.join('\n'));
  assert.strictEqual(res.pack.boards[0].categories[0].questions[0].question, 'Two spaces');
});

test('one board is fine; zero or three boards are not', () => {
  assert.ok(validatePack(goodPack(1)).ok);
  const none = goodPack(); none.boards = [];
  assert.match(firstError(validatePack(none)), /1–2 boards/);
  const three = goodPack(); three.boards.push(three.boards[0]);
  assert.match(firstError(validatePack(three)), /1–2 boards/);
});

test('wrong counts are rejected with a clear message', () => {
  const p = goodPack();
  p.boards[1].categories[2].questions.pop();
  assert.strictEqual(firstError(validatePack(p)), 'Board 2, category 3 has 4 questions, needs 5.');
  const q = goodPack();
  q.boards[0].categories.pop();
  assert.strictEqual(firstError(validatePack(q)), 'Board 1 has 4 categories, needs 5.');
});

test('wrong values are rejected', () => {
  const p = goodPack();
  p.boards[1].categories[0].questions[0].value = 100;
  assert.match(firstError(validatePack(p)), /should be worth 200/);
});

test('unknown keys are rejected, including sneaky ones', () => {
  const p = goodPack();
  p.boards[0].categories[0].questions[0].onClick = 'alert(1)';
  assert.match(firstError(validatePack(p)), /unknown field "onClick"/);
  const proto = JSON.parse(JSON.stringify(goodPack()).replace('"name":"Test Pack"', '"name":"Test Pack","__proto__":{"x":1}'));
  assert.match(firstError(validatePack(proto)), /unknown field "__proto__"/);
});

test('a 5,000-character answer is rejected', () => {
  const p = goodPack();
  p.boards[0].categories[0].questions[0].answer = 'x'.repeat(5000);
  assert.match(firstError(validatePack(p)), /answer is too long \(5000 characters, max 100\)/);
});

test('wrong types and bad bonusPoints are rejected', () => {
  const p = goodPack();
  p.boards[0].categories[0].questions[1].question = 42;
  p.boards[0].categories[0].questions[2].bonusPoints = 9999;
  const res = validatePack(p);
  assert.ok(!res.ok);
  assert.ok(res.errors.some((e) => /text must be text/.test(e)));
  assert.ok(res.errors.some((e) => /bonusPoints/.test(e)));
});

test('the wrong format is rejected', () => {
  const p = goodPack();
  p.format = 'something-else';
  assert.match(firstError(validatePack(p)), /buzz-pack-v2/);
});

test('oversize and non-JSON text are rejected; text around the JSON is ignored', () => {
  assert.match(parsePackText('x'.repeat(301 * 1024)).errors[0], /too big/);
  assert.match(parsePackText('hello there').errors[0], /Couldn't find a pack/);
  assert.match(parsePackText('{ not json }').errors[0], /isn't valid JSON/);
  const wrapped = parsePackText('Here you go!\n```json\n' + JSON.stringify(goodPack()) + '\n```\nEnjoy');
  assert.ok(wrapped.ok);
  assert.ok(validatePack(wrapped.value).ok);
});

test('HTML in a question is kept as plain text (the pages show it with textContent)', () => {
  const p = goodPack();
  p.boards[0].categories[0].questions[0].question = '<img src=x onerror=alert(1)>';
  const res = validatePack(p);
  assert.ok(res.ok);
  assert.strictEqual(res.pack.boards[0].categories[0].questions[0].question, '<img src=x onerror=alert(1)>');
});

test('uploads need exactly 5 categories; built-ins may have up to 8 with 5 defaults', () => {
  const p = goodPack();
  const extra = JSON.parse(JSON.stringify(p.boards[0].categories[0]));
  p.boards[0].categories.push({ ...extra, name: 'Extra 1' }, { ...extra, name: 'Extra 2' });
  assert.match(firstError(validatePack(p)), /has 7 categories, needs 5/);
  assert.ok(validatePack(p, { kind: 'builtin' }).ok);

  [1, 2, 3, 5, 6].forEach((i) => (p.boards[0].categories[i].default = true));
  const res = validatePack(p, { kind: 'builtin' });
  assert.deepStrictEqual(defaultCategories(res.pack.boards[0]).map((c) => c.name), ['Category 2', 'Category 3', 'Category 4', 'Extra 1', 'Extra 2']);
  p.boards[0].categories[0].default = true; // now 6 flagged
  assert.match(firstError(validatePack(p, { kind: 'builtin' })), /marks 6 categories as default/);
});

test('every built-in pack passes the validator', () => {
  const dir = path.join(__dirname, '..', 'packs');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const res = validatePack(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), { kind: 'builtin', allowNoBoards: f === 'party.json' });
    assert.ok(res.ok, `${f}: ${res.errors?.join('\n')}`);
  }
});

test('"Make your own": a pasted Claude reply is checked with the strict rules and previewed', () => {
  const p = goodPack();
  p.boards[0].categories[1].questions[2].verify = true;
  p.boards[1].categories[0].questions[4].verify = true;
  p.boards[1].categories[0].questions[3].trapAnswer = 'Old field'; // from older packs: accepted, then dropped
  const res = checkUploadedText('Here is your pack!\n```json\n' + JSON.stringify(p) + '\n```');
  assert.ok(res.ok, res.errors?.join('\n'));
  assert.strictEqual(res.preview.questions, 50);
  assert.deepStrictEqual(res.preview.boards.map((b) => b.name), ['Board 1', 'Board 2']);
  assert.deepStrictEqual(res.preview.checks.map((c) => [c.kind, c.where]), [
    ['verify', 'Board 1 · Category 2 · 300'],
    ['verify', 'Board 2 · Category 1 · 1000'],
  ]);
  assert.ok(!('trapAnswer' in res.pack.boards[1].categories[0].questions[3]));
  // Uploads never get the built-in allowances (longer questions, extra categories).
  const long = goodPack();
  long.boards[0].categories[0].questions[0].question = 'x'.repeat(400);
  assert.match(checkUploadedText(JSON.stringify(long)).errors[0], /max 300/);
  assert.match(checkUploadedText('no pack here').errors[0], /Couldn't find a pack/);
});

test('table format: CSV round trip, Excel copy-paste (tabs), and "continue" replies pasted together', () => {
  const { packToTable } = require('../table');
  const p = goodPack();
  p.boards[0].categories[0].questions[0].question = '=SUM(A1) "quoted", with a comma';
  p.boards[1].categories[3].note = 'A film described badly. Name the film';
  p.boards[1].categories[2].questions[1].verify = true;
  const pack = validatePack(p).pack;
  const csv = packToTable(pack);
  assert.ok(csv.includes(`"'=SUM(A1) ""quoted"", with a comma"`), 'formula-looking cells are made safe for Excel');
  const back = checkUploadedText('Here you go!\n```csv\n' + csv + '\n```\nHave fun!');
  assert.ok(back.ok, back.errors?.join('\n'));
  assert.deepStrictEqual(back.pack, pack);

  const lines = csv.replace(/^﻿/, '').split('\r\n');
  const tsv = lines.map((l) => l.replace(/,/g, '\t')).slice(2).filter((l) => !l.includes('"')).join('\n');
  const header = lines[0].replace(/,/g, '\t');
  const excel = checkUploadedText(header + '\n' + tsv.split('\n').filter((l) => !/^Board 1\tCategory 1\t100/.test(l)).join('\n') + '\nBoard 1\tCategory 1\t100\tQ?\tA', { fallbackName: 'From Excel' });
  assert.ok(excel.ok, excel.errors?.join('\n'));
  assert.strictEqual(excel.pack.name, 'From Excel');

  const cont = checkUploadedText('```csv\n' + lines.slice(0, 30).join('\n') + '\n```\nSure, continuing:\n```csv\n' + lines[0] + '\n' + lines.slice(29).join('\n') + '\n```');
  assert.ok(cont.ok, cont.errors?.join('\n'));
  assert.deepStrictEqual(cont.pack, pack);
});

test('a cut-off reply says so and suggests what to do', () => {
  const json = JSON.stringify(goodPack());
  assert.match(checkUploadedText('```json\n' + json.slice(0, 3000)).errors[0], /cut off/);
  const { packToTable } = require('../table');
  const lines = packToTable(validatePack(goodPack()).pack).split('\r\n');
  const errs = checkUploadedText(lines.slice(0, 20).join('\n')).errors;
  assert.match(errs[0], /has \d questions?, needs 5/);
  assert.match(errs[errs.length - 1], /continue/);
});

test('team names: optional, up to 4, different, and kept through the table format', () => {
  const { packToTable } = require('../table');
  const p = goodPack();
  p.teams = ['Team Rocket', 'Team Comet', 'Team Orbit', 'Team Nebula'];
  const res = validatePack(p, { kind: 'upload' });
  assert.ok(res.ok, res.errors?.join('\n'));
  assert.deepStrictEqual(res.pack.teams, p.teams);
  const back = checkUploadedText(packToTable(res.pack));
  assert.ok(back.ok, back.errors?.join('\n'));
  assert.deepStrictEqual(back.pack.teams, p.teams);
  assert.deepStrictEqual(back.preview.teams, p.teams);

  assert.match(firstError(validatePack({ ...p, teams: ['A', 'B', 'C', 'D', 'E'] })), /max 4/);
  assert.match(firstError(validatePack({ ...p, teams: ['Team X', 'team x'] })), /different/);
  assert.match(firstError(validatePack({ ...p, teams: ['x'.repeat(25)] })), /too long|max/i);
  assert.match(firstError(validatePack({ ...p, teams: 'Team X' })), /list/);
  assert.strictEqual(validatePack(goodPack()).pack.teams, undefined, 'no teams is fine');

  for (const id of ['desi', 'world', 'tv', 'sports']) {
    const pack = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'packs', id + '.json'), 'utf8'));
    assert.strictEqual(pack.teams?.length, 4, `${id} has 4 team names`);
  }
});

// ---- Community tags ----
const KNOWN = ['Movies', 'TV', 'Cartoons & Kids', 'Desi'];

test('tags: known ones are kept (spelt like the list), unknown ones become the suggested tag', () => {
  const p = { ...goodPack(), tags: ['movies', 'Saturday Mornings', 'cartoons and kids', 'Anime', 'MOVIES'], kidFriendly: true };
  const res = validatePack(p, { knownTags: KNOWN });
  assert.ok(res.ok, res.errors?.join('\n'));
  assert.deepStrictEqual(res.pack.tags, ['Movies', 'Cartoons & Kids']);
  assert.strictEqual(res.pack.suggestedTag, 'Saturday Mornings', 'only the first unknown tag is kept');
  assert.strictEqual(res.pack.kidFriendly, true);
});

test('tags: at most 3; Claude\'s own suggestedTag wins; a "suggested" tag that exists is just used', () => {
  let res = validatePack({ ...goodPack(), tags: ['TV', 'Movies', 'Desi', 'Cartoons & Kids'], suggestedTag: 'A very long suggested tag name' }, { knownTags: KNOWN });
  assert.deepStrictEqual(res.pack.tags, ['TV', 'Movies', 'Desi']);
  assert.strictEqual(res.pack.suggestedTag, 'A very long suggeste', 'cut to 20 characters');
  res = validatePack({ ...goodPack(), tags: ['Nope'], suggestedTag: 'tv' }, { knownTags: KNOWN });
  assert.deepStrictEqual(res.pack.tags, ['TV']);
  assert.strictEqual(res.pack.suggestedTag, undefined);
});

test('tags: optional, and wrong types are clear errors', () => {
  const plain = validatePack(goodPack(), { knownTags: KNOWN });
  assert.ok(plain.ok);
  assert.ok(!('tags' in plain.pack) && !('suggestedTag' in plain.pack) && !('kidFriendly' in plain.pack));
  assert.match(firstError(validatePack({ ...goodPack(), tags: 'Movies' })), /"tags" must be a list/);
  assert.match(firstError(validatePack({ ...goodPack(), kidFriendly: 'yes' })), /kidFriendly/);
  assert.match(firstError(validatePack({ ...goodPack(), suggestedTag: 5 })), /suggestedTag/);
  // Empty suggestedTag (as in the prompt's example) is fine.
  assert.ok(validatePack({ ...goodPack(), tags: [], suggestedTag: '', kidFriendly: false }, { knownTags: KNOWN }).ok);
});

test('tags: no tag list (no database) keeps them as given, so playing never fails', () => {
  const res = validatePack({ ...goodPack(), tags: ['<b>Anything</b>', 'TV'] });
  assert.ok(res.ok);
  assert.deepStrictEqual(res.pack.tags, ['<b>Anything</b>', 'TV']);
});

test('tags in the table format: read from Tags / Suggested tag / Kid friendly rows, and written back', () => {
  const header = 'Board,Category,Points,Question,Answer,Bonus,Fun fact,Verify,How to play';
  const rows = [header, 'Pack,Toons,📺', 'Tags,cartoons & kids,Saturday Mornings', 'Suggested tag,', 'Kid friendly,yes'];
  for (let c = 1; c <= 5; c++) for (const v of [100, 200, 300, 400, 500]) rows.push(`Toons,Cat ${c},${v},Q${c}-${v}?,A,,,,`);
  const res = checkUploadedText(rows.join('\n'), { knownTags: KNOWN });
  assert.ok(res.ok, res.errors?.join('\n'));
  assert.deepStrictEqual(res.pack.tags, ['Cartoons & Kids']);
  assert.strictEqual(res.pack.suggestedTag, 'Saturday Mornings');
  assert.strictEqual(res.pack.kidFriendly, true);
  assert.deepStrictEqual([res.preview.tags, res.preview.suggestedTag, res.preview.kidFriendly], [['Cartoons & Kids'], 'Saturday Mornings', true]);
  assert.match(res.csv, /\r\nTags,Cartoons & Kids\r\nSuggested tag,Saturday Mornings\r\nKid friendly,yes\r\n/);
  const again = checkUploadedText(res.csv, { knownTags: KNOWN });
  assert.deepStrictEqual([again.pack.tags, again.pack.suggestedTag, again.pack.kidFriendly], [['Cartoons & Kids'], 'Saturday Mornings', true]);
});
