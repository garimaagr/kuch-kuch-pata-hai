const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parsePackText, validatePack, defaultCategories } = require('../pack');

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
