// Buzzer rules for one question. Plain data so it is easy to test.
// order:  [{ teamId, playerId }] in the order buzzes reached the server
// locked: team ids that answered wrong on this question

function newBuzz() {
  return { open: false, order: [], locked: [] };
}

function openBuzzers(b) {
  b.open = true;
}

function resetBuzz(b) {
  b.open = false;
  b.order = [];
  b.locked = [];
}

// Returns true if the buzz counted.
function tryBuzz(b, teamId, playerId) {
  if (!b.open || teamId == null) return false; // too early, or no team yet
  if (b.locked.includes(teamId)) return false; // answered wrong already
  if (b.order.some((e) => e.teamId === teamId)) return false; // team already buzzed
  b.order.push({ teamId, playerId });
  return true;
}

// Wrong answer: lock the team out. The next team in line gets the turn.
function lockTeam(b, teamId) {
  if (!b.locked.includes(teamId)) b.locked.push(teamId);
}

// Whose turn it is to answer: first team in line that isn't locked out.
function currentTurn(b) {
  return b.order.find((e) => !b.locked.includes(e.teamId)) || null;
}

module.exports = { newBuzz, openBuzzers, resetBuzz, tryBuzz, lockTeam, currentTurn };
