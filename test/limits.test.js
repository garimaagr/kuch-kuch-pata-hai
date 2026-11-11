const test = require('node:test');
const assert = require('node:assert');
const { makeLimiter, cleanText } = require('../limits');

test('limiter allows up to max hits per window, per key', () => {
  const lim = makeLimiter(3, 1000);
  assert.ok(lim.allow('a', 0));
  assert.ok(lim.allow('a', 10));
  assert.ok(lim.allow('a', 20));
  assert.ok(!lim.allow('a', 30), '4th hit inside the window is refused');
  assert.ok(lim.allow('b', 30), 'other keys are separate');
  assert.ok(lim.allow('a', 1001), 'allowed again once the first hit is outside the window');
});

test('limiter prune forgets idle keys', () => {
  const lim = makeLimiter(1, 1000);
  lim.allow('a', 0);
  lim.prune(5000);
  assert.ok(lim.allow('a', 5000));
});

test('cleanText trims, strips control characters, collapses spaces and cuts', () => {
  assert.strictEqual(cleanText('  Hi\u0000\n\tthere  ', 50), 'Hi there');
  assert.strictEqual(cleanText('abcdef', 3), 'abc');
  assert.strictEqual(cleanText(null, 5), '');
  assert.strictEqual(cleanText('<b>x</b>', 20), '<b>x</b>', 'HTML is kept as plain text; the pages show it with textContent');
});
