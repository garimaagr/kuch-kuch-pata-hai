// No host mode: the server runs the clock and the rules (nohost.js). Time is driven by hand here.
const test = require('node:test');
const assert = require('node:assert');
const buzz = require('../buzz');
const { T, readingDelay, newNoHost, makeEngine, MIMIC_POINTS, CHARADES_POINTS } = require('../nohost');

const DRAW_LEVELS = { easy: 50, medium: 100, tricky: 200 };
const SPARKLE_MS = 60000;

// A small room: 3 teams of 2, one question worth 300 with a bonus, a Sparkle deck of one card per mode.
function setup({ teams = 3, bonus = true, double = false, modes = ['draw', 'charades', 'mimic'] } = {}) {
  const players = new Map();
  for (let t = 0; t < teams; t++) for (const n of ['a', 'b']) players.set(`p${t}${n}`, { id: `p${t}${n}`, name: `P${t}${n}`, teamId: t, connected: true });
  const room = {
    teams: Array.from({ length: teams }, (_, id) => ({ id, name: `Team ${id}`, score: 0 })),
    players, buzz: buzz.newBuzz(), settings: { bonuses: true, modes },
    current: { cat: 0, idx: 2, double },
    q: { value: 300, question: 'one two three four five six seven eight', answer: 'Paris', funFact: 'Fact.', bonus: bonus ? 'Clap' : '', bonusPoints: 50 },
    reveal: null, bonus: null, screen: 'board', sparkle: null, sparkleDue: false, finished: 0,
    decks: { 'draw:easy': ['cat'], 'draw:medium': ['dog'], 'draw:tricky': ['yak'], charades: ['Jaws'], mimic: ['A cat'] },
    drawn: { 'draw:easy': [], 'draw:medium': [], 'draw:tricky': [], charades: [], mimic: [] },
    nh: newNoHost(),
  };
  const flashes = [];
  const engine = makeEngine({
    question: (r) => (r.current ? r.q : null),
    finishQuestion: (r) => { r.finished++; r.current = null; buzz.resetBuzz(r.buzz); },
    goToBoard: (r) => { r.screen = r.sparkleDue ? 'sparkle' : 'board'; r.sparkle = r.sparkleDue ? { teamId: null, mode: null, level: null, performerId: null, cardIdx: null, running: false, remaining: SPARKLE_MS } : null; r.sparkleDue = false; },
    drawCard: (r) => {
      const s = r.sparkle; const key = s.mode === 'draw' ? `draw:${s.level}` : s.mode;
      const left = r.decks[key].map((_, i) => i).filter((i) => !r.drawn[key].includes(i));
      s.cardIdx = left.length ? left[0] : null; if (left.length) r.drawn[key].push(left[0]);
    },
    cardsLeft: (r, mode, level) => {
      const left = (k) => r.decks[k].length - r.drawn[k].length;
      return mode !== 'draw' ? left(mode) : level ? left(`draw:${level}`) : Object.keys(DRAW_LEVELS).reduce((n, l) => n + left(`draw:${l}`), 0);
    },
    awardSparkle: (r, pts) => { const t = r.teams.find((x) => x.id === r.sparkle?.teamId); if (t) t.score += pts; r.screen = 'board'; r.sparkle = null; },
    drawLevels: DRAW_LEVELS, sparkleMs: SPARKLE_MS,
    flash: (r, teamId, text) => flashes.push([teamId, text]),
  });
  const score = (id) => room.teams[id].score;
  return { room, engine, score, flashes };
}

test('reading delay: 2s + 0.25s a word, at most 8s', () => {
  assert.strictEqual(readingDelay(''), 2000);
  assert.strictEqual(readingDelay('one'), 2250);
  assert.strictEqual(readingDelay('one two three four five six seven eight'), 4000);
  assert.strictEqual(readingDelay('  lots   of\n spaces  '), 2750, 'words, not spaces');
  assert.strictEqual(readingDelay(Array(23).fill('w').join(' ')), 7750);
  assert.strictEqual(readingDelay(Array(200).fill('w').join(' ')), 8000, 'capped');
});

test('buzzers open by themselves after the reading delay, and not a moment before', () => {
  const { room, engine } = setup();
  engine.pickTile(room, 1000);
  assert.strictEqual(room.nh.phase, 'reading');
  assert.strictEqual(engine.view(room, 1000).endsIn, 4000, 'phones and the screen count down from this');
  assert.strictEqual(engine.buzzIn(room, 'p0a', 2000), false, 'too early: buzzers are shut');
  assert.strictEqual(engine.tick(room, 4999), false);
  assert.strictEqual(room.buzz.open, false);
  assert.strictEqual(engine.tick(room, 5000), true);
  assert.strictEqual(room.buzz.open, true);
  assert.strictEqual(room.nh.phase, 'open');
  assert.strictEqual(room.nh.deadline, 5000 + T.NO_BUZZ);
});

// Opens buzzers, has `player` buzz, runs "Say your answer!" and returns the time judging starts.
function buzzToJudging(room, engine, player, at) {
  if (room.nh.phase === 'reading') engine.tick(room, room.nh.deadline);
  assert.ok(engine.buzzIn(room, player, at), `${player} buzzes`);
  assert.strictEqual(room.nh.phase, 'saying');
  assert.strictEqual(room.buzz.open, false, 'one answer at a time');
  engine.tick(room, at + T.SAY);
  assert.strictEqual(room.nh.phase, 'judging');
  return at + T.SAY;
}

test('right answer, nobody challenges: points after the challenge window, then reveal and bonus', () => {
  const { room, engine, score } = setup();
  engine.pickTile(room, 0);
  const t = buzzToJudging(room, engine, 'p1a', 4100);
  assert.strictEqual(engine.buzzIn(room, 'p2a', t), false, 'buzzers stay shut while a team answers');
  assert.strictEqual(engine.claim(room, 'p1b', true, t), false, 'only the buzzer chooses');
  assert.ok(engine.claim(room, 'p1a', true, t + 1000));
  assert.strictEqual(room.nh.phase, 'challenge');
  assert.strictEqual(score(1), 0, 'nothing is scored until the window closes');
  engine.tick(room, t + 1000 + T.CHALLENGE);
  assert.strictEqual(score(1), 300);
  assert.strictEqual(room.nh.phase, 'reveal');
  assert.deepStrictEqual([room.reveal.answer, room.reveal.funFact, room.reveal.teamId, room.reveal.points], ['Paris', 'Fact.', 1, 300]);
  assert.strictEqual(room.current, null, 'the question is finished');
  engine.tick(room, room.nh.deadline);
  assert.strictEqual(room.nh.phase, 'bonus');
  assert.deepStrictEqual(room.bonus, { teamId: 1, text: 'Clap', points: 50 });
});

test('challenge flips the result: a claimed ✅ becomes wrong, a claimed ❌ becomes right', () => {
  // Claimed right, challenged → wrong: points lost, team locked out.
  let { room, engine, score } = setup();
  engine.pickTile(room, 0);
  let t = buzzToJudging(room, engine, 'p0a', 4000);
  engine.claim(room, 'p0a', true, t);
  assert.strictEqual(engine.challenge(room, 'p0b'), false, 'not your own team');
  assert.ok(engine.challenge(room, 'p2b'));
  assert.strictEqual(engine.challenge(room, 'p1a'), false, 'one challenge is enough; it flips once');
  assert.strictEqual(engine.view(room, t).challengedBy, 'p2b');
  engine.tick(room, t + T.CHALLENGE);
  assert.strictEqual(score(0), -300);
  assert.deepStrictEqual(room.buzz.locked, [0]);

  // Claimed missed, challenged → right.
  ({ room, engine, score } = setup());
  engine.pickTile(room, 0);
  t = buzzToJudging(room, engine, 'p0a', 4000);
  engine.claim(room, 'p0a', false, t);
  engine.challenge(room, 'p1a');
  engine.tick(room, t + T.CHALLENGE);
  assert.strictEqual(score(0), 300);
  assert.strictEqual(room.reveal.teamId, 0);

  // A challenge after the window is too late.
  ({ room, engine, score } = setup());
  engine.pickTile(room, 0);
  t = buzzToJudging(room, engine, 'p0a', 4000);
  engine.claim(room, 'p0a', true, t);
  engine.tick(room, t + T.CHALLENGE);
  assert.strictEqual(engine.challenge(room, 'p1a'), false);
  assert.strictEqual(score(0), 300);
});

test('wrong: that team is locked out and buzzers reopen for the rest; all locked out → reveal', () => {
  const { room, engine, score } = setup({ double: true });
  engine.pickTile(room, 0);
  let t = buzzToJudging(room, engine, 'p0a', 4000);
  engine.claim(room, 'p0a', false, t);
  engine.tick(room, t + T.CHALLENGE);
  assert.strictEqual(score(0), -600, 'Double costs 2×');
  assert.strictEqual(room.nh.phase, 'open', 'reopened');
  assert.strictEqual(room.buzz.open, true);
  assert.strictEqual(room.current != null, true, 'same question');
  assert.strictEqual(engine.buzzIn(room, 'p0b', t + T.CHALLENGE + 10), false, 'the locked team can\'t buzz again');

  // Team 1 buzzes, and doesn't choose: counts as missed after the judging time.
  t = buzzToJudging(room, engine, 'p1b', t + T.CHALLENGE + 500);
  engine.tick(room, t + T.JUDGE);
  assert.strictEqual(score(1), -600);
  assert.strictEqual(room.nh.phase, 'open');

  // Team 2 misses too: nobody is left, so the answer is revealed.
  t = buzzToJudging(room, engine, 'p2a', t + T.JUDGE + 100);
  engine.claim(room, 'p2a', false, t);
  engine.tick(room, t + T.CHALLENGE);
  assert.deepStrictEqual(room.buzz.locked, [], 'question closed');
  assert.strictEqual(room.nh.phase, 'reveal');
  assert.deepStrictEqual([room.reveal.teamId, room.reveal.answer, room.reveal.bonus], [null, 'Paris', null]);
  engine.tick(room, room.nh.deadline);
  assert.strictEqual(room.nh.phase, null, 'back to the board, no bonus');
  assert.strictEqual(room.screen, 'board');
});

test('nobody buzzes in 15s: answer revealed, then back to the board', () => {
  const { room, engine, score } = setup();
  engine.pickTile(room, 0);
  engine.tick(room, 4000);
  engine.tick(room, 4000 + T.NO_BUZZ - 1);
  assert.strictEqual(room.nh.phase, 'open');
  engine.tick(room, 4000 + T.NO_BUZZ);
  assert.strictEqual(room.nh.phase, 'reveal');
  assert.strictEqual(room.reveal.teamId, null);
  // One late tick catches up through every due step.
  engine.tick(room, 4000 + T.NO_BUZZ + T.REVEAL + 999);
  assert.strictEqual(room.nh.phase, null);
  assert.deepStrictEqual(room.teams.map((x) => x.score), [0, 0, 0]);
  assert.strictEqual(score(0), 0);
});

test('bonus votes: other teams only, majority 👍 gives the points, ends early when everyone voted', () => {
  const run = (votes, { wait = true } = {}) => {
    const { room, engine, score } = setup();
    engine.pickTile(room, 0);
    const t = buzzToJudging(room, engine, 'p0a', 4000);
    engine.claim(room, 'p0a', true, t);
    engine.tick(room, t + T.CHALLENGE + T.REVEAL);
    assert.strictEqual(room.nh.phase, 'bonus');
    const ok = Object.entries(votes).map(([p, up]) => engine.bonusVote(room, p, up, t + 20000));
    if (wait && room.nh.phase === 'bonus') engine.tick(room, room.nh.deadline);
    return { ok, bonus: score(0) - 300, phase: room.nh.phase, room };
  };
  assert.strictEqual(run({ p1a: true, p1b: true, p2a: false }).bonus, 50, '2 👍 vs 1 👎');
  assert.strictEqual(run({ p1a: true, p2a: false }).bonus, 0, 'a tie is not a majority');
  assert.strictEqual(run({}).bonus, 0, 'no votes: no bonus');
  const own = run({ p0b: true, p1a: true });
  assert.deepStrictEqual(own.ok, [false, true], 'the bonus team can\'t vote for itself');
  assert.strictEqual(own.bonus, 50);
  const early = run({ p1a: true, p1b: true, p2a: true, p2b: false }, { wait: false });
  assert.strictEqual(early.phase, null, 'all 4 other players voted: done without waiting');
  assert.strictEqual(early.bonus, 50);
});

test('😂 +5: once per question per player, never to your own team', () => {
  const { room, engine, score } = setup();
  engine.pickTile(room, 0);
  assert.strictEqual(engine.funny(room, 'p0a', 0), false, 'own team');
  assert.ok(engine.funny(room, 'p0a', 1));
  assert.strictEqual(engine.funny(room, 'p0a', 2), false, 'one per question');
  assert.ok(engine.funny(room, 'p0b', 1), 'teammates have their own');
  assert.strictEqual(score(1), 10);
  engine.pickTile(room, 1000); // next question
  assert.ok(engine.funny(room, 'p0a', 2));
});

test('Sparkle: team in turn, performer\'s "Guessed!" gives the tier points; Mimic is voted', () => {
  // Draw only: the team whose turn it is, and the card's tier points.
  let { room, engine, score } = setup({ modes: ['draw'] });
  room.current = null;
  room.sparkleDue = true;
  room.nh.sparkleTurn = 1;
  engine.tick(room, 0);
  room.screen = 'sparkle';
  room.sparkle = { teamId: null, mode: null, level: null, performerId: null, cardIdx: null, running: false, remaining: SPARKLE_MS };
  engine.startSparkle(room, 0);
  assert.strictEqual(room.sparkle.teamId, 1, 'team in turn');
  assert.ok(['p1a', 'p1b'].includes(room.sparkle.performerId));
  assert.strictEqual(room.nh.phase, 'sparkleReady');
  engine.tick(room, T.SPARKLE_READY);
  assert.strictEqual(room.nh.phase, 'sparkleRun');
  assert.strictEqual(room.sparkle.running, true);
  const level = room.sparkle.level;
  assert.strictEqual(engine.guessed(room, 'p2a', 5000), false, 'only the performer');
  assert.ok(engine.guessed(room, room.sparkle.performerId, 5000));
  assert.strictEqual(score(1), DRAW_LEVELS[level]);
  assert.strictEqual(room.screen, 'board');

  // Charades: Guessed! is worth 100; the next Sparkle goes to the next team.
  ({ room, engine, score } = setup({ modes: ['charades'] }));
  room.nh.sparkleTurn = 2;
  room.screen = 'sparkle';
  room.sparkle = { teamId: null, mode: null, level: null, performerId: null, cardIdx: null, running: false, remaining: SPARKLE_MS };
  engine.startSparkle(room, 0);
  assert.strictEqual(room.sparkle.teamId, 2);
  engine.guessed(room, room.sparkle.performerId, 1000);
  assert.strictEqual(score(2), CHARADES_POINTS);

  // Time runs out without a guess: no points.
  ({ room, engine, score } = setup({ modes: ['charades'] }));
  room.screen = 'sparkle';
  room.sparkle = { teamId: null, mode: null, level: null, performerId: null, cardIdx: null, running: false, remaining: SPARKLE_MS };
  engine.startSparkle(room, 0);
  engine.tick(room, T.SPARKLE_READY + SPARKLE_MS);
  assert.deepStrictEqual([room.screen, room.nh.phase, score(0)], ['board', null, 0]);
});

test('Mimic votes: 😂 +100 / 🙂 +50 / 😐 +25, most votes wins, ties go up, performer\'s team can\'t vote', () => {
  const run = (votes) => {
    const { room, engine, score } = setup({ modes: ['mimic'] });
    room.screen = 'sparkle';
    room.sparkle = { teamId: null, mode: null, level: null, performerId: null, cardIdx: null, running: false, remaining: SPARKLE_MS };
    engine.startSparkle(room, 0); // team 0
    engine.tick(room, T.SPARKLE_READY);
    assert.ok(engine.mimicDone(room, room.sparkle.performerId, 10000), 'the performer can finish early');
    assert.strictEqual(room.nh.phase, 'mimicVote');
    const ok = Object.entries(votes).map(([p, v]) => engine.mimicVote(room, p, v, 11000));
    if (room.nh.phase === 'mimicVote') engine.tick(room, room.nh.deadline);
    return { pts: score(0), ok };
  };
  assert.strictEqual(run({ p1a: 'lol', p1b: 'lol', p2a: 'meh' }).pts, MIMIC_POINTS.lol);
  assert.strictEqual(run({ p1a: 'smile', p2a: 'meh', p2b: 'meh' }).pts, 25);
  assert.strictEqual(run({ p1a: 'lol', p2a: 'smile' }).pts, 100, 'tie goes to the higher one');
  assert.strictEqual(run({}).pts, 0, 'no votes, no points');
  const r = run({ p0b: 'lol', p1a: 'meh', bad: 'lol' });
  assert.deepStrictEqual(r.ok, [false, true, false]);
  assert.strictEqual(r.pts, 25);
  assert.strictEqual(run({ p1a: 'huge' }).pts, 0, 'unknown faces are ignored');
});

test('🎯 the team that answered right picks the next tile; nobody right → the last picker keeps it', () => {
  const { room, engine } = setup();
  const toBoard = () => { while (room.nh.phase) engine.tick(room, room.nh.deadline); };
  room.current = null;
  assert.strictEqual(room.nh.picker, null);
  assert.ok(engine.canPick(room, 'p2a'), 'before anyone scores, anyone can pick');
  assert.strictEqual(engine.canPick(room, 'nobody'), false);

  room.current = { cat: 0, idx: 2 };
  engine.pickTile(room, 0);
  assert.strictEqual(engine.canPick(room, 'p0a'), false, 'not while a question is up');
  const t = buzzToJudging(room, engine, 'p1a', 4100);
  engine.claim(room, 'p1a', true, t);
  engine.tick(room, t + T.CHALLENGE);
  assert.strictEqual(room.nh.picker, 1);
  assert.strictEqual(engine.view(room, t).picker, 1);
  assert.strictEqual(engine.canPick(room, 'p1b'), false, 'not during the reveal');
  toBoard();
  assert.ok(engine.canPick(room, 'p1b'), 'anyone on the team that got it');
  assert.strictEqual(engine.canPick(room, 'p0a'), false, 'other teams wait');
  room.screen = 'sparkle';
  assert.strictEqual(engine.canPick(room, 'p1b'), false, 'not during a Sparkle round');
  room.screen = 'board';

  // Next question: nobody buzzes. Team 1 still picks.
  room.current = { cat: 1, idx: 0 };
  engine.pickTile(room, 100000);
  engine.tick(room, room.nh.deadline);
  engine.tick(room, room.nh.deadline);
  assert.strictEqual(room.reveal.teamId, null);
  toBoard();
  assert.strictEqual(room.nh.picker, 1);
  assert.ok(engine.canPick(room, 'p1a'));
});

test('🙅 pass: only once the buzzers reopen after a wrong answer; a passed team can\'t buzz; all passed → reveal', () => {
  const { room, engine, score } = setup({ teams: 4 });
  engine.pickTile(room, 0);
  engine.tick(room, room.nh.deadline);
  assert.strictEqual(engine.pass(room, 'p1a', 4100), false, 'not on the first open: just don\'t buzz');
  assert.strictEqual(engine.view(room, 4100).canPass, false);

  let t = buzzToJudging(room, engine, 'p0a', 4200);
  assert.strictEqual(engine.pass(room, 'p1a', t), false, 'not while someone answers');
  engine.claim(room, 'p0a', false, t);
  engine.tick(room, t + T.CHALLENGE);
  t += T.CHALLENGE;
  assert.strictEqual(room.nh.phase, 'open');
  assert.strictEqual(engine.view(room, t).canPass, true);
  assert.strictEqual(engine.pass(room, 'p0b', t), false, 'the locked-out team has nothing to pass');
  assert.ok(engine.pass(room, 'p1a', t));
  assert.strictEqual(engine.pass(room, 'p1b', t), false, 'a team passes once');
  assert.deepStrictEqual(engine.view(room, t).passed, [1]);
  assert.strictEqual(engine.buzzIn(room, 'p1b', t + 10), false, 'passed teams can\'t buzz');
  assert.strictEqual(score(1), 0, 'passing costs nothing');

  assert.ok(engine.pass(room, 'p2a', t + 20));
  assert.strictEqual(room.nh.phase, 'open', 'team 3 is still in');
  assert.ok(engine.pass(room, 'p3a', t + 30));
  assert.strictEqual(room.nh.phase, 'reveal', 'everyone left passed: show the answer');
  assert.strictEqual(room.reveal.teamId, null);

  // The next question starts with nobody passed.
  while (room.nh.phase) engine.tick(room, room.nh.deadline);
  room.current = { cat: 1, idx: 1 };
  engine.pickTile(room, 200000);
  assert.deepStrictEqual(room.nh.passed, []);
});

test('🙅 pass, then the last team in misses: reveal (no reopen for teams that passed)', () => {
  const { room, engine } = setup();
  engine.pickTile(room, 0);
  let t = buzzToJudging(room, engine, 'p0a', 4200);
  engine.claim(room, 'p0a', false, t);
  engine.tick(room, t + T.CHALLENGE);
  t += T.CHALLENGE;
  assert.ok(engine.pass(room, 'p1a', t));
  t = buzzToJudging(room, engine, 'p2a', t + 100);
  engine.claim(room, 'p2a', false, t);
  engine.tick(room, t + T.CHALLENGE);
  assert.strictEqual(room.nh.phase, 'reveal');
});
