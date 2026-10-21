'use strict';
const assert = require('node:assert/strict');
const WaterGameCore = require('./gameplay.js');
const STEP = 1 / 60;
const NONE = { moveX: 0, moveY: 0, aimX: 1, aimY: 0, shoot: false };
const checks = [];
function close(actual, expected, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}
function test(name, fn) { fn(); checks.push(name); console.log('PASS ' + name); }
function fixture(params = {}, difficulty = 'standard') {
  const game = new WaterGameCore({ seed: 1, difficulty, params: { countdownDuration: 0, ...params } });
  game._aiCommand = () => ({ ...NONE, aimX: 0 });
  game.start(); game.update(STEP, NONE);
  const positions = [[0, 0], [-3, 0], [0, 3], [0, -3]];
  game.actors.forEach((a, i) => {
    a.x = positions[i][0]; a.y = positions[i][1]; a.angle = 0;
    a.kx = a.ky = a.mx = a.my = 0;
  });
  return game;
}
function advance(game, seconds, input = NONE, rate = 60) {
  for (let i = 0; i < Math.round(seconds * rate); i++) game.update(1 / rate, input);
}

test('Three-second countdown freezes actors, water and match time', () => {
  const g = new WaterGameCore({ seed: 3, difficulty: 'standard' });
  g.start(); const x = g.actors[0].x;
  advance(g, 2.9, { ...NONE, moveX: 1, shoot: true });
  assert.equal(g.phase, 'countdown'); close(g.actors[0].x, x);
  close(g.actors[0].water, 100); close(g.timeElapsed, 0);
  advance(g, 0.1); assert.equal(g.phase, 'playing'); close(g.timeElapsed, 0);
});
test('Equal fixed-step behavior at 30, 60 and 120 rendering FPS', () => {
  const games = [30, 60, 120].map(rate => {
    const g = fixture({ arenaRadius: 100 });
    advance(g, 2, { ...NONE, moveX: 0.8, moveY: 0.6, shoot: true }, rate);
    return g;
  });
  for (const g of games.slice(1)) {
    close(g.actors[0].x, games[0].actors[0].x);
    close(g.actors[0].y, games[0].actors[0].y);
    close(g.actors[0].water, 50); close(g.timeElapsed, 2);
  }
});
test('Diagonal movement is normalized', () => {
  const one = fixture({ arenaRadius: 100 }), diagonal = fixture({ arenaRadius: 100 });
  advance(one, 1, { ...NONE, moveX: 1 });
  advance(diagonal, 1, { ...NONE, moveX: 1, moveY: 1 });
  close(Math.hypot(diagonal.actors[0].x, diagonal.actors[0].y), one.actors[0].x);
});
test('100 water drains in four seconds; holding empty never refills', () => {
  const g = fixture(); advance(g, 4, { ...NONE, shoot: true });
  close(g.actors[0].water, 0); assert.equal(g.actors[0].shooting, false);
  assert.equal(g.beams.length, 0);
  g.actors[0].x = 2.8; g.actors[0].y = 0;
  advance(g, 0.5, { ...NONE, shoot: true }); close(g.actors[0].water, 0);
  advance(g, 0.5, NONE); close(g.actors[0].water, 25);
});
test('Refill reaches 100 after two uninterrupted seconds; groups alternate', () => {
  const g = fixture(); g.actors[0].water = 0;
  advance(g, 2); close(g.actors[0].water, 100);
  advance(g, 2);
  assert.equal(g.getState().fountainGroup, 1);
  assert.equal(g.fountains[0].active, false);
  assert.equal(g.fountains.filter(f => f.active).length, 4);
  advance(g, 4); assert.equal(g.fountains[0].active, true);
});
test('Preview is visible only in the last half-second; shooting overrides refill', () => {
  const g = fixture(); advance(g, 3.5);
  assert.equal(g.fountains.filter(f => f.preview).length, 4);
  g.actors[0].water = 50; advance(g, 0.2, { ...NONE, shoot: true });
  close(g.actors[0].water, 45); assert.equal(g.actors[0].refilling, false);
});
test('Nearest single target blocks the rear target; actors beyond range are ignored', () => {
  const g = fixture();
  g.actors[1].x = 2; g.actors[1].y = 0;
  g.actors[2].x = 4; g.actors[2].y = 0;
  g.update(STEP, { ...NONE, shoot: true });
  assert.equal(g.beams[0].targetId, 'ai1'); assert.ok(g.actors[1].kx > 0);
  close(g.actors[2].kx, 0);
  const h = fixture(); h.actors[1].x = 6.0; h.actors[1].y = 0;
  h.update(STEP, { ...NONE, shoot: true }); close(h.actors[1].kx, 0);
});
test('Final partial water step produces only the affordable impulse', () => {
  const g = fixture(); g.actors[0].water = 0.125;
  g.actors[1].x = 2; g.actors[1].y = 0;
  g.update(STEP, { ...NONE, shoot: true });
  const expected = 24 * (1 - Math.exp(-5 * 0.005)) / 5 * Math.exp(-5 * (STEP - 0.005));
  close(g.actors[1].kx, expected); close(g.actors[0].water, 0);
  assert.equal(g.actors[0].shooting, false); assert.equal(g.beams.length, 0);
});
test('Opposing simultaneous water forces cancel as vectors', () => {
  const g = fixture();
  Object.assign(g.actors[0], { x: -2, y: 0, angle: 0 });
  Object.assign(g.actors[1], { x: 2, y: 0, angle: Math.PI });
  Object.assign(g.actors[2], { x: 0, y: 0 });
  Object.assign(g.actors[3], { x: 0, y: -5 });
  g._aiCommand = a => a.id === 'ai1' ? { ...NONE, aimX: -1, shoot: true } : { ...NONE, aimX: 0 };
  g.update(STEP, { ...NONE, shoot: true });
  close(g.actors[2].kx, 0); close(g.actors[2].ky, 0);
  assert.equal(g.beams.filter(b => b.targetId === 'ai2').length, 2);
});
test('Stationary edge target can be pushed out; reverse walking cannot cancel continuous hits', () => {
  const g = fixture();
  Object.assign(g.actors[0], { x: 3, y: 0 });
  Object.assign(g.actors[1], { x: 6, y: 0 });
  advance(g, 1, { ...NONE, shoot: true });
  assert.equal(g.actors[1].alive, false);
  const h = fixture(); Object.assign(h.actors[1], { x: 3, y: 0 });
  h._aiCommand = a => ({ ...NONE, aimX: 0, moveX: a.id === 'ai1' ? -1 : 0 });
  advance(h, 1, { ...NONE, shoot: true });
  assert.ok(h.actors[1].x > 3); assert.ok(h.actors[1].kx > 3.2);
});
test('Lateral movement escapes a continuous stream and kick decays', () => {
  const g = fixture(); Object.assign(g.actors[1], { x: 3, y: 0 });
  g._aiCommand = a => ({ ...NONE, aimX: 0, moveY: a.id === 'ai1' ? 1 : 0 });
  advance(g, 1, { ...NONE, shoot: true });
  assert.ok(g.actors[1].y > 2.5); assert.equal(g.actors[1].hit, 0);
  assert.ok(g.actors[1].kx < 0.3);
  assert.equal(g.beams.some(b => b.targetId === 'ai1'), false);
});
test('Boundary grace is continuous, resets on return, and eliminates exactly once', () => {
  const g = fixture(); const a = g.actors[0]; a.x = 7.1;
  advance(g, 5 / 60); assert.equal(a.alive, true);
  a.x = 6.9; g.update(STEP, NONE); close(a.outsideTime, 0);
  a.x = 7.1; advance(g, 6 / 60); assert.equal(a.alive, false); assert.equal(a.rank, 4);
  advance(g, 0.2);
  assert.equal(g.events.filter(e => e.type === 'elimination' && e.actorId === 'p1').length, 1);
});
test('Final same-step all-out is a locked draw with shared first place', () => {
  const g = fixture();
  Object.assign(g.actors[2], { alive: false, rank: 4 });
  Object.assign(g.actors[3], { alive: false, rank: 3 });
  g.actors[0].x = 7.2; g.actors[1].x = -7.2;
  advance(g, 0.1); assert.equal(g.phase, 'result'); assert.equal(g.result.type, 'draw');
  assert.deepEqual(g.result.winners, []); assert.equal(g.actors[0].rank, 1); assert.equal(g.actors[1].rank, 1);
  const snapshot = JSON.stringify(g.getState());
  advance(g, 2, { ...NONE, shoot: true, moveX: 1 });
  assert.equal(JSON.stringify(g.getState()), snapshot);
});
test('Three simultaneous eliminations share second place and player wins', () => {
  const g = fixture();
  g.actors.slice(1).forEach((a, i) => { a.x = Math.cos(i * 2) * 7.2; a.y = Math.sin(i * 2) * 7.2; });
  advance(g, 0.1); assert.equal(g.result.type, 'win'); assert.equal(g.result.playerWon, true);
  assert.deepEqual(g.actors.slice(1).map(a => a.rank), [2, 2, 2]);
});
test('Timeout first processes this-step elimination then awards all survivors', () => {
  const g = fixture(); g.timeElapsed = 30 - STEP; g.timeLeft = STEP;
  Object.assign(g.actors[1], { x: 7.2, y: 0, outsideTime: 5 * STEP });
  g.update(STEP, NONE);
  assert.equal(g.result.reason, 'timeout'); assert.equal(g.result.type, 'shared');
  assert.equal(g.actors[1].rank, 4); assert.equal(g.result.winners.length, 3);
  assert.equal(g.actors.filter(a => a.alive).every(a => a.rank === 1), true);
});
test('Pause freezes simulation and accumulated time is bounded after long frames', () => {
  const g = fixture(); advance(g, 0.5, { ...NONE, moveX: 1 });
  g.togglePause(); const snapshot = JSON.stringify(g.getState());
  g.update(20, { ...NONE, shoot: true }); assert.equal(JSON.stringify(g.getState()), snapshot);
  g.togglePause(); const before = g.timeElapsed; g.update(20, NONE);
  close(g.timeElapsed - before, 0.25); assert.ok(g._accumulator < STEP);
});
test('Deterministic seeds and rotating player spawns; reset clears result', () => {
  const a = new WaterGameCore({ seed: 99, difficulty: 'standard' }), b = new WaterGameCore({ seed: 99, difficulty: 'standard' });
  assert.deepEqual(a.actors.map(x => [x.x, x.y]), b.actors.map(x => [x.x, x.y]));
  const spawns = new Set(); for (let seed = 1; seed <= 4; seed++) {
    a.reset(seed); spawns.add(a.actors[0].x.toFixed(4) + ',' + a.actors[0].y.toFixed(4));
  }
  assert.equal(spawns.size, 4); assert.equal(a.phase, 'ready'); assert.equal(a.result, null);
});
test('Ten autonomous rounds finish, all values finite, events stay bounded and AI refill', () => {
  const games = [], counters = { win: 0, shared: 0, draw: 0, refills: 0, aiStates: new Set() };
  for (let seed = 1; seed <= 10; seed++) {
    const g = new WaterGameCore({ seed, difficulty: 'standard' }); g.start();
    for (let frame = 0; frame < 2100 && g.phase !== 'result'; frame++) {
      // Passive player is useful to exercise ordinary AI, without inventing player input.
      g.update(STEP, NONE);
      for (const a of g.actors) {
        for (const key of ['x', 'y', 'water', 'kx', 'ky', 'vx', 'vy']) assert.ok(Number.isFinite(a[key]), key);
        assert.ok(a.water >= 0 && a.water <= 100);
        assert.ok(Math.hypot(a.kx, a.ky) <= 4.5 + 1e-8);
        assert.ok(Math.hypot(a.vx, a.vy) <= 6.5 + 1e-8);
        if (!a.isPlayer) counters.aiStates.add(a.aiState);
      }
      assert.ok(g.events.length <= g.params.maxEvents);
    }
    assert.equal(g.phase, 'result'); counters[g.result.type]++;
    counters.refills += g.actors.slice(1).reduce((sum, a) => sum + a.stats.refillVisits, 0);
    games.push({ seed, result: g.result.type, duration: +g.result.duration.toFixed(2), playerRank: g.result.playerRank });
  }
  assert.ok(counters.refills > 0);
  assert.ok(counters.aiStates.has('edge-recovery'));
  assert.ok(counters.aiStates.has('dodging'));
  assert.ok(counters.aiStates.has('refilling'));
  console.log('AUTONOMOUS ' + JSON.stringify({ ...counters, aiStates: [...counters.aiStates], games }));
});

test('Easy is the default with UI metadata; standard retains all original parameters', () => {
  const easy = new WaterGameCore({ seed: 4 });
  assert.equal(easy.getDifficulty(), 'easy');
  assert.equal(easy.getDifficultyInfo().label, 'Easy');
  assert.equal(easy.getState().difficulty, 'easy');
  close(easy.timeLeft, 45); close(easy.params.waterUse, 18);
  assert.deepEqual(easy.getDifficultyOptions().map(d => d.id), ['easy', 'standard']);
  assert.ok(easy.getDifficultyInfo().description.includes('0.9'));
  const standard = new WaterGameCore({ difficulty: 'standard' });
  for (const [name, value] of Object.entries(WaterGameCore.DEFAULTS)) assert.equal(standard.params[name], value, name);
  assert.equal(standard.getDifficultyInfo().label, 'Standard');
  close(standard.timeLeft, 30); close(standard.params.passiveWaterRate, 0);
  assert.equal(new WaterGameCore({ difficulty: 'invalid' }).getDifficulty(), 'easy');
});

test('Difficulty changes only when ready, preserves seed and explicit tuning, and persists on reset', () => {
  const g = new WaterGameCore({ seed: 71, params: { maxEvents: 22 } });
  const spawn = [g.actors[0].x, g.actors[0].y];
  assert.equal(g.setDifficulty('invalid'), false);
  assert.equal(g.setDifficulty('standard'), true);
  assert.equal(g.seed, 71); assert.deepEqual([g.actors[0].x, g.actors[0].y], spawn);
  assert.equal(g.params.maxEvents, 22); close(g.timeLeft, 30);
  assert.equal(g.setDifficulty('standard'), true);
  g.start(); assert.equal(g.setDifficulty('easy'), false);
  g.togglePause(); assert.equal(g.setDifficulty('easy'), false);
  g.togglePause(); advance(g, 3); assert.equal(g.setDifficulty('easy'), false);
  g.reset(72); assert.equal(g.getDifficulty(), 'standard');
  assert.equal(g.setDifficulty('easy'), true); close(g.timeLeft, 45);
});

test('Easy shooting is more mobile and AI is slower, while player movement keeps full speed', () => {
  const easy = fixture({ arenaRadius: 100 }, 'easy'), standard = fixture({ arenaRadius: 100 });
  for (const g of [easy, standard]) {
    g.actors.slice(1).forEach((a, i) => { a.x = -20 - i * 5; a.y = 10; });
    advance(g, 1, { ...NONE, moveX: 1, shoot: true });
  }
  close(easy.actors[0].mx, 3.2 * .9, 1e-7);
  close(standard.actors[0].mx, 3.2 * .7, 1e-7);
  close(easy.actors[0].water, 82); close(standard.actors[0].water, 75);
  const movingAI = fixture({ arenaRadius: 100 }, 'easy');
  movingAI.actors.slice(1).forEach((a, i) => { a.x = -20 - i * 5; a.y = 10; });
  movingAI._aiCommand = () => ({ ...NONE, moveX: 1 });
  advance(movingAI, 1, { ...NONE, moveX: 1 });
  close(movingAI.actors[0].mx, 3.2, 1e-7);
  close(movingAI.actors[1].mx, 3.2 * .72, 1e-7);
});

test('Easy reduces player knockback but still pushes a stationary player toward the edge', () => {
  const games = ['easy', 'standard'].map(difficulty => {
    const g = fixture({}, difficulty);
    Object.assign(g.actors[0], { x: 6.4, y: 0 });
    Object.assign(g.actors[1], { x: 3, y: 0, angle: 0 });
    g._aiCommand = a => a.id === 'ai1' ? { ...NONE, shoot: true } : { ...NONE, aimX: 0 };
    g.update(STEP, NONE); return g;
  });
  close(games[0].actors[0].kx / games[1].actors[0].kx, .65);
  assert.ok(games[0].actors[0].kx > 0);
  advance(games[0], 1); assert.equal(games[0].actors[0].alive, false);
});

test('Easy recovers water only after 0.9 seconds off-trigger and does not recover while held empty', () => {
  const g = fixture({}, 'easy'), a = g.actors[0]; a.x = 4.5;
  advance(g, 1, { ...NONE, shoot: true }); close(a.water, 82);
  advance(g, .9); close(a.water, 82); assert.equal(a.regenerating, false);
  advance(g, 1); close(a.water, 90); assert.equal(a.regenerating, true);
  assert.equal(a.refillSource, 'rest'); assert.equal(a.refilling, false);
  advance(g, .1, { ...NONE, shoot: true }); close(a.water, 88.2);
  advance(g, .9); close(a.water, 88.2);
  a.water = 0; advance(g, 2, { ...NONE, shoot: true });
  close(a.water, 0); close(a._restTime, 0); assert.equal(a.regenerating, false);
  advance(g, 1); close(a.water, .8);
});

test('Easy fountain radius is larger and strong refill never stacks with passive recovery', () => {
  const easy = fixture({}, 'easy'), standard = fixture();
  for (const g of [easy, standard]) { g.actors[0].x = 1.4; g.actors[0].water = 0; advance(g, 1); }
  close(easy.actors[0].water, 50); close(standard.actors[0].water, 0);
  assert.equal(easy.actors[0].refillSource, 'fountain'); assert.equal(easy.actors[0].regenerating, false);
  close(easy.fountains[0].radius, 1.5);
  advance(easy, 1); close(easy.actors[0].water, 100);
});

test('Opening grace prevents accidental AI crossfire rather than absorbing damage or granting revival', () => {
  const g = fixture({}, 'easy');
  g._aiCommand = WaterGameCore.prototype._aiCommand.bind(g);
  Object.assign(g.actors[0], { x: 1.5, y: 0 });
  Object.assign(g.actors[1], { x: 0, y: 0, angle: 0, targetId: 'ai2', _targetHold: 100, _reaction: 0 });
  Object.assign(g.actors[2], { x: 3, y: 0, angle: Math.PI, targetId: 'ai1', _targetHold: 100, _reaction: 0 });
  Object.assign(g.actors[3], { x: 0, y: -5, angle: 0 });
  const a = g.actors[1]; g.update(STEP, NONE);
  assert.equal(a._command.shoot, true, 'AI wanted to attack the opponent behind P1');
  assert.equal(a.shooting, false, 'AI declined the actual obstructed shot');
  close(a.water, 100); assert.equal(g.actors[0].hit, 0);
  g.actors[0].x = 7.2; advance(g, .1);
  assert.equal(g.actors[0].alive, false, 'opening grace never rescues a player who leaves the arena');
  advance(g, 4); assert.equal(g.actors[0].alive, false, 'grace expiry never revives an eliminated actor');
});

test('Forty easy seeds leave an idle player alive for the first eight seconds while AI moves and fights', () => {
  let aiHits = 0, aiShots = 0, travel = 0;
  const games = [];
  for (let seed = 1; seed <= 40; seed++) {
    const g = new WaterGameCore({ seed, difficulty: 'easy', params: { countdownDuration: 0 } });
    g.start(); g.update(STEP, NONE);
    let moved = 0, shots = 0, hits = 0;
    for (let frame = 0; frame < 480; frame++) {
      const before = g.actors.map(a => [a.x, a.y]);
      g.update(STEP, NONE);
      assert.equal(g.actors[0].alive, true, `seed ${seed} P1 survived at ${g.timeElapsed}`);
      assert.ok(g.actors.filter(a => !a.isPlayer && a.alive && a.targetId === 'p1').length <= 1, 'P1 target cap');
      for (const a of g.actors.slice(1)) {
        moved += Math.hypot(a.x - before[a.index][0], a.y - before[a.index][1]);
        if (a.shooting) {
          shots += STEP;
          const phase = ((g.timeElapsed - STEP) + a._burstPhase) % (g.params.aiBurstDuration + g.params.aiBurstRest);
          assert.ok(phase < g.params.aiBurstDuration + 1e-8, 'shooting never spills into an AI rest interval');
        }
        for (const key of ['x', 'y', 'water', 'kx', 'ky']) assert.ok(Number.isFinite(a[key]), key);
      }
      for (const beam of g.beams) {
        if (beam.actorId !== 'p1' && beam.targetId && beam.targetId !== 'p1') hits++;
        if (g.timeElapsed <= 4 + 1e-8) assert.notEqual(beam.targetId, 'p1', 'opening grace has no hidden hit ray');
      }
    }
    assert.ok(moved > 2, `seed ${seed} AI did not idle`);
    assert.ok(shots > .1, `seed ${seed} AI actually shoots`);
    travel += moved; aiShots += shots; aiHits += hits;
    games.push({ seed, alive: g.actors[0].alive, playerRadius: +Math.hypot(g.actors[0].x, g.actors[0].y).toFixed(2) });
  }
  assert.ok(aiHits > 100, 'AI opposition produces real hit rays');
  console.log('EASY_FIRST_8_SECONDS ' + JSON.stringify({ seeds: 40, survivors: 40,
    aiShootingSeconds: +aiShots.toFixed(2), aiHitSteps: aiHits, aiTravelMeters: +travel.toFixed(2), games }));
});

test('Easy AI decisions are deterministic for the same seed and input', () => {
  const options = { seed: 177, difficulty: 'easy', params: { countdownDuration: 0 } };
  const a = new WaterGameCore(options), b = new WaterGameCore(options);
  for (const g of [a, b]) { g.start(); g.update(STEP, NONE); advance(g, 8); }
  assert.equal(JSON.stringify(a.getState()), JSON.stringify(b.getState()));
});

test('Easy pause freezes recovery delay, match time and AI cadence without catch-up', () => {
  const g = fixture({}, 'easy'), a = g.actors[0];
  a.x = 4.5; a.water = 50; advance(g, .5);
  g.togglePause(); const paused = JSON.stringify(g.getState());
  g.update(100, { ...NONE, shoot: true }); assert.equal(JSON.stringify(g.getState()), paused);
  g.togglePause(); advance(g, .4); close(a.water, 50);
  advance(g, .1); close(a.water, 50.8);
});

test('Easy timeout still processes eliminations first and locks the 45-second result', () => {
  const g = fixture({}, 'easy'); g.timeElapsed = 45 - STEP; g.timeLeft = STEP;
  Object.assign(g.actors[1], { x: 7.2, y: 0, outsideTime: 5 * STEP });
  g.update(STEP, NONE);
  assert.equal(g.result.reason, 'timeout'); close(g.result.duration, 45);
  assert.equal(g.actors[1].rank, 4); assert.equal(g.result.winners.length, 3);
  assert.equal(g.setDifficulty('standard'), false);
  const result = JSON.stringify(g.getState());
  advance(g, 5, { ...NONE, shoot: true, moveX: 1 });
  assert.equal(JSON.stringify(g.getState()), result);
});

test('Ten full easy rounds complete with bounded events and no invalid state', () => {
  const results = [];
  for (let seed = 1; seed <= 10; seed++) {
    const g = new WaterGameCore({ seed }); g.start();
    advance(g, 49);
    assert.equal(g.phase, 'result');
    assert.ok(g.result.duration <= 45); assert.ok(g.events.length <= g.params.maxEvents);
    assert.ok(g.actors.every(a => Number.isFinite(a.x) && Number.isFinite(a.y) && a.water >= 0 && a.water <= 100));
    results.push({ seed, reason: g.result.reason, playerRank: g.result.playerRank, duration: +g.result.duration.toFixed(2) });
  }
  console.log('EASY_FULL_ROUNDS ' + JSON.stringify(results));
});
console.log('RESULT ' + checks.length + ' gameplay checks passed.');
