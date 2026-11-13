// "No host" mode: everyone plays, and the server runs the clock and the rules.
// Plain functions over the room, with `now` passed in, so tests can drive time by hand.
// Every timed step is one deadline (room.nh.deadline); tick(room, now) moves past any that are due.
//
// A question:  reading (buzzers shut, 3-2-1) → open → saying ("Say your answer!") → judging (the
// buzzer's phone alone sees the answer and taps ✅/❌) → challenge (others can 🚩; any challenge flips
// it) → right: reveal, bonus vote, board · wrong: team locked out, buzzers reopen for the rest.
// Nobody left, or no buzz in 15s: the answer is revealed and it's back to the board.
// After a reopen, a team can 🙅 Pass; once every team still in has passed, the answer is revealed.
// The team that answered right picks the next tile (from their phones, or on the shared screen).
const buzz = require('./buzz');

const T = {
  READ_BASE: 2000, READ_PER_WORD: 250, READ_MAX: 8000, // reading delay before buzzers open
  NO_BUZZ: 15000, // buzzers open with nobody buzzing → reveal
  SAY: 5000, // "Say your answer!"
  JUDGE: 20000, // the buzzer didn't tap ✅ or ❌ → counts as missed
  CHALLENGE: 5000, // others can 🚩 after the buzzer's choice
  REVEAL: 7000, // the answer + fun fact stay on screen
  BONUS_VOTE: 10000, // 👍 / 👎 on the bonus challenge
  SPARKLE_READY: 4000, // the performer reads their card before the timer starts
  MIMIC_VOTE: 10000, // 😂 / 🙂 / 😐 after a Mimic
};
const MIMIC_POINTS = { lol: 100, smile: 50, meh: 25 };
const CHARADES_POINTS = 100; // Draw cards carry their own tier points
const FUNNY_POINTS = 5;

const words = (text) => String(text || '').trim().split(/\s+/).filter(Boolean).length;
const readingDelay = (text) => Math.min(T.READ_MAX, T.READ_BASE + T.READ_PER_WORD * words(text));

const newNoHost = () => ({
  phase: null, deadline: null, buzzer: null, buzzTeam: null, claim: null, challengedBy: null,
  votes: {}, funnyBy: [], sparkleTurn: 0, performed: {},
  picker: null, // team that picks the next tile (null: anyone, e.g. at the start)
  passed: [], // teams that passed on this question
});

// api: what the engine borrows from the server (so the rules stay the same in both modes).
//   question(room) → the open question · finishQuestion(room, counts) · goToBoard(room)
//   drawCard(room) · cardsLeft(room, mode, level) · awardSparkle(room, points)
//   drawLevels { easy: 50, ... } · sparkleMs · flash(room, teamId, text) (optional)
function makeEngine(api) {
  const set = (room, phase, ms, now) => { room.nh.phase = phase; room.nh.deadline = ms == null ? null : now + ms; };
  const teamOf = (room, id) => room.teams.find((t) => t.id === id);
  const flash = (room, teamId, text) => api.flash && api.flash(room, teamId, text);
  const worth = (room) => api.question(room).value * (room.current.double ? 2 : 1);
  const playersOf = (room, teamId) => [...room.players.values()].filter((p) => p.teamId === teamId);
  // Who may vote / challenge: connected players on another team.
  const voters = (room, notTeam) => [...room.players.values()].filter((p) => p.connected !== false && p.teamId != null && p.teamId !== notTeam);

  // ---- Questions ----
  // Who may pick the next tile from a phone: the picker team (anyone while there isn't one yet).
  function canPick(room, playerId) {
    const p = room.players.get(playerId);
    return !room.nh.phase && !room.current && !room.reveal && !room.bonus && room.screen === 'board'
      && !!p && p.teamId != null && (room.nh.picker == null || room.nh.picker === p.teamId);
  }

  // Teams that can still buzz on this question: have players, not locked out, not passed.
  const stillIn = (room) => room.teams.filter((t) => !room.buzz.locked.includes(t.id) && !room.nh.passed.includes(t.id) && playersOf(room, t.id).length);

  function pickTile(room, now) {
    Object.assign(room.nh, { buzzer: null, buzzTeam: null, claim: null, challengedBy: null, votes: {}, funnyBy: [], passed: [] });
    set(room, 'reading', readingDelay(api.question(room).question), now);
  }

  function openBuzzers(room, now) {
    buzz.openBuzzers(room.buzz);
    Object.assign(room.nh, { buzzer: null, buzzTeam: null, claim: null, challengedBy: null });
    set(room, 'open', T.NO_BUZZ, now);
  }

  // The first buzz takes the turn; the buzzers close while that team answers.
  function buzzIn(room, playerId, now) {
    const p = room.players.get(playerId);
    if (room.nh.phase !== 'open' || !p || room.nh.passed.includes(p.teamId) || !buzz.tryBuzz(room.buzz, p.teamId, p.id)) return false;
    room.buzz.open = false;
    Object.assign(room.nh, { buzzer: p.id, buzzTeam: p.teamId, claim: null, challengedBy: null });
    set(room, 'saying', T.SAY, now);
    return true;
  }

  function claim(room, playerId, gotIt, now) {
    if (room.nh.phase !== 'judging' || playerId !== room.nh.buzzer || typeof gotIt !== 'boolean') return false;
    room.nh.claim = gotIt;
    set(room, 'challenge', T.CHALLENGE, now);
    return true;
  }

  // 🙅 Pass: once the buzzers reopen after a wrong answer, a team can sit the question out (no points lost).
  // One player's pass counts for their team. When every team still in has passed, the answer is shown.
  function pass(room, playerId, now) {
    const p = room.players.get(playerId);
    if (room.nh.phase !== 'open' || !room.buzz.locked.length || !p || p.teamId == null) return false;
    if (!stillIn(room).some((t) => t.id === p.teamId) || room.buzz.order.some((e) => e.teamId === p.teamId)) return false;
    room.nh.passed.push(p.teamId);
    if (!stillIn(room).length) reveal(room, null, 0, now);
    return true;
  }

  // Any one challenge from another team flips the buzzer's call.
  function challenge(room, playerId) {
    const p = room.players.get(playerId);
    if (room.nh.phase !== 'challenge' || room.nh.challengedBy || !p || p.teamId == null || p.teamId === room.nh.buzzTeam) return false;
    room.nh.challengedBy = playerId;
    return true;
  }

  // After the challenge window: the score is applied here, on the server.
  function settle(room, now) {
    const nh = room.nh;
    const right = nh.challengedBy ? !nh.claim : nh.claim === true;
    const team = teamOf(room, nh.buzzTeam);
    const pts = worth(room);
    if (!team) return reveal(room, null, 0, now);
    if (right) {
      team.score += pts;
      room.nh.picker = team.id; // they pick the next tile
      flash(room, team.id, `+${pts}`);
      return reveal(room, team.id, pts, now);
    }
    team.score -= pts;
    buzz.lockTeam(room.buzz, team.id);
    if (stillIn(room).length) openBuzzers(room, now);
    else reveal(room, null, 0, now);
  }

  function reveal(room, teamId, points, now) {
    const q = api.question(room);
    const bonus = teamId != null && q.bonus && room.settings.bonuses ? { teamId, text: q.bonus, points: Number(q.bonusPoints) || 0 } : null;
    room.reveal = { answer: q.answer, funFact: q.funFact || null, teamId, points, bonus };
    api.finishQuestion(room, true);
    Object.assign(room.nh, { buzzer: null, claim: null, challengedBy: null });
    set(room, 'reveal', T.REVEAL, now);
  }

  function afterReveal(room, now) {
    const r = room.reveal;
    room.reveal = null;
    if (r?.bonus) {
      room.bonus = r.bonus;
      room.nh.votes = {};
      set(room, 'bonus', T.BONUS_VOTE, now);
    } else toBoard(room, now);
  }

  // ---- Bonus: other teams vote; more 👍 than 👎 gives the points ----
  function bonusVote(room, playerId, up, now) {
    const p = room.players.get(playerId);
    if (room.nh.phase !== 'bonus' || !room.bonus || typeof up !== 'boolean' || !p || p.teamId == null || p.teamId === room.bonus.teamId) return false;
    room.nh.votes[playerId] = up;
    if (voters(room, room.bonus.teamId).every((v) => Object.hasOwn(room.nh.votes, v.id))) endBonus(room, now);
    return true;
  }

  function endBonus(room, now) {
    const b = room.bonus;
    const all = Object.values(room.nh.votes);
    const ups = all.filter(Boolean).length;
    if (b && ups > all.length - ups) {
      teamOf(room, b.teamId).score += b.points;
      flash(room, b.teamId, `+${b.points} ⭐`);
    }
    room.bonus = null;
    room.nh.votes = {};
    toBoard(room, now);
  }

  function toBoard(room, now) {
    api.goToBoard(room);
    if (room.screen === 'sparkle') startSparkle(room, now);
    else set(room, null, null, now);
  }

  // ---- Sparkle: team in turn, a random mode with cards left, each player of the team in turn ----
  function startSparkle(room, now) {
    const teams = room.teams.filter((t) => playersOf(room, t.id).length);
    const s = room.sparkle;
    const modes = room.settings.modes.filter((m) => api.cardsLeft(room, m));
    if (!s || !teams.length || !modes.length) { api.awardSparkle(room, 0); return set(room, null, null, now); }
    const team = teams[room.nh.sparkleTurn++ % teams.length];
    const players = playersOf(room, team.id);
    const performer = players.reduce((a, b) => ((room.nh.performed[b.id] || 0) < (room.nh.performed[a.id] || 0) ? b : a));
    room.nh.performed[performer.id] = (room.nh.performed[performer.id] || 0) + 1;
    s.teamId = team.id;
    s.mode = modes[Math.floor(Math.random() * modes.length)];
    if (s.mode === 'draw') {
      const levels = Object.keys(api.drawLevels).filter((l) => api.cardsLeft(room, 'draw', l));
      s.level = levels[Math.floor(Math.random() * levels.length)];
    }
    s.performerId = performer.id;
    api.drawCard(room);
    if (s.cardIdx == null) { api.awardSparkle(room, 0); return set(room, null, null, now); }
    room.nh.votes = {};
    set(room, 'sparkleReady', T.SPARKLE_READY, now);
  }

  function startTimer(room, now) {
    const s = room.sparkle;
    s.running = true;
    s.remaining = api.sparkleMs;
    s.endsAt = now + api.sparkleMs;
    set(room, 'sparkleRun', api.sparkleMs, now);
  }

  function stopTimer(room, now) {
    const s = room.sparkle;
    s.remaining = Math.max(0, s.endsAt - now);
    s.running = false;
  }

  function endSparkle(room, points, now) {
    api.awardSparkle(room, points);
    set(room, null, null, now);
  }

  // Draw / Charades: the performer's phone says "Guessed!".
  function guessed(room, playerId, now) {
    const s = room.sparkle;
    if (!s || !['sparkleReady', 'sparkleRun'].includes(room.nh.phase) || playerId !== s.performerId || s.mode === 'mimic') return false;
    endSparkle(room, s.mode === 'draw' ? api.drawLevels[s.level] : CHARADES_POINTS, now);
    return true;
  }

  // Mimic: the performer can finish early; then the others vote.
  function mimicDone(room, playerId, now) {
    const s = room.sparkle;
    if (!s || room.nh.phase !== 'sparkleRun' || playerId !== s.performerId || s.mode !== 'mimic') return false;
    stopTimer(room, now);
    room.nh.votes = {};
    set(room, 'mimicVote', T.MIMIC_VOTE, now);
    return true;
  }

  function mimicVote(room, playerId, choice, now) {
    const s = room.sparkle;
    const p = room.players.get(playerId);
    if (room.nh.phase !== 'mimicVote' || !Object.hasOwn(MIMIC_POINTS, choice) || !p || p.teamId == null || p.teamId === s.teamId) return false;
    room.nh.votes[playerId] = choice;
    if (voters(room, s.teamId).every((v) => Object.hasOwn(room.nh.votes, v.id))) endMimic(room, now);
    return true;
  }

  // The most-voted face wins (a tie goes to the higher one). No votes: no points.
  function mimicResult(votes) {
    const counts = { lol: 0, smile: 0, meh: 0 };
    for (const v of Object.values(votes)) counts[v]++;
    const best = Object.keys(MIMIC_POINTS).reduce((a, b) => (counts[b] > counts[a] ? b : a));
    return counts[best] ? MIMIC_POINTS[best] : 0;
  }

  function endMimic(room, now) {
    const pts = mimicResult(room.nh.votes);
    room.nh.votes = {};
    endSparkle(room, pts, now);
  }

  // ---- 😂 +5: any player, once per question, to another team ----
  function funny(room, playerId, teamId) {
    const p = room.players.get(playerId);
    const team = teamOf(room, teamId);
    const live = !!room.current || ['reveal'].includes(room.nh.phase);
    if (!live || !p || p.teamId == null || !team || team.id === p.teamId || room.nh.funnyBy.includes(playerId)) return false;
    room.nh.funnyBy.push(playerId);
    team.score += FUNNY_POINTS;
    flash(room, team.id, `+${FUNNY_POINTS} 😂`);
    return true;
  }

  // Moves past every deadline that's due. Returns true if anything changed.
  function tick(room, now) {
    let changed = false;
    for (let guard = 0; guard < 20 && room.nh.deadline != null && now >= room.nh.deadline; guard++) {
      const at = room.nh.deadline; // the step happened at its deadline, not when the timer fired
      changed = true;
      switch (room.nh.phase) {
        case 'reading': openBuzzers(room, at); break;
        case 'open': reveal(room, null, 0, at); break;
        case 'saying': set(room, 'judging', T.JUDGE, at); break;
        case 'judging': room.nh.claim = false; room.nh.challengedBy = null; settle(room, at); break; // no choice = missed
        case 'challenge': settle(room, at); break;
        case 'reveal': afterReveal(room, at); break;
        case 'bonus': endBonus(room, at); break;
        case 'sparkleReady': startTimer(room, at); break;
        case 'sparkleRun':
          if (room.sparkle?.mode === 'mimic') { stopTimer(room, at); room.nh.votes = {}; set(room, 'mimicVote', T.MIMIC_VOTE, at); }
          else { flash(room, room.sparkle?.teamId, "⏱ Time's up"); endSparkle(room, 0, at); }
          break;
        case 'mimicVote': endMimic(room, at); break;
        default: set(room, null, null, at);
      }
    }
    return changed;
  }

  // What phones and the shared screen see. The answer is never in here (the buzzer's phone gets it apart).
  function view(room, now) {
    const nh = room.nh;
    const all = Object.values(nh.votes);
    return {
      phase: nh.phase,
      endsIn: nh.deadline == null ? null : Math.max(0, nh.deadline - now),
      buzzer: nh.buzzer,
      buzzTeam: nh.buzzTeam,
      claim: nh.phase === 'challenge' ? nh.claim : null,
      challengedBy: nh.challengedBy,
      voted: Object.keys(nh.votes),
      votes: nh.phase === 'mimicVote'
        ? Object.fromEntries(Object.keys(MIMIC_POINTS).map((k) => [k, all.filter((v) => v === k).length]))
        : { up: all.filter((v) => v === true).length, down: all.filter((v) => v === false).length },
      funnyBy: nh.funnyBy,
      picker: nh.picker,
      passed: nh.passed,
      canPass: nh.phase === 'open' && room.buzz.locked.length > 0,
    };
  }

  return { canPick, pass, pickTile, buzzIn, claim, challenge, bonusVote, guessed, mimicDone, mimicVote, funny, tick, view, startSparkle };
}

module.exports = { T, MIMIC_POINTS, CHARADES_POINTS, FUNNY_POINTS, readingDelay, newNoHost, makeEngine };
