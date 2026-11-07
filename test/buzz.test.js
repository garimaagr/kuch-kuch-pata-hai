const test = require('node:test');
const assert = require('node:assert');
const buzz = require('../buzz');

test('buzz order follows arrival, with the rules applied', () => {
  const b = buzz.newBuzz();

  // Too early: ignored
  assert.equal(buzz.tryBuzz(b, 0, 'early'), false);

  buzz.openBuzzers(b);
  assert.equal(buzz.tryBuzz(b, 1, 'priya'), true);
  assert.equal(buzz.tryBuzz(b, 1, 'amit'), false); // same team, second buzz ignored
  assert.equal(buzz.tryBuzz(b, 0, 'rohan'), true);
  assert.equal(buzz.tryBuzz(b, null, 'noteam'), false);
  assert.deepEqual(b.order, [{ teamId: 1, playerId: 'priya' }, { teamId: 0, playerId: 'rohan' }]);
  assert.equal(buzz.currentTurn(b).playerId, 'priya');

  // Wrong answer: team 1 locked out, next team in line gets the turn
  buzz.lockTeam(b, 1);
  assert.equal(buzz.currentTurn(b).playerId, 'rohan');
  assert.equal(buzz.tryBuzz(b, 1, 'amit'), false);

  // New question
  buzz.resetBuzz(b);
  assert.equal(b.open, false);
  assert.deepEqual(b.order, []);
  assert.deepEqual(b.locked, []);
});
