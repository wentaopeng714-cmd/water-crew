'use strict';
const assert = require('node:assert/strict');
const WaterGameCore = require('./gameplay.js');
const STEP = 1 / 60;
const NONE = { moveX: 0, moveY: 0, aimX: 1, aimY: 0, shoot: false };
let checks = 0;
function test(name, fn) { fn(); checks++; console.log('PASS ' + name); }
function close(actual, expected, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}
function advance(game, seconds, input = NONE) {
  for (let frame = 0; frame < Math.round(seconds / STEP); frame++) game.update(STEP, input);
}
function fixture(config = {}) {
  const game = new WaterGameCore({ seed: 7 });
  const params = { countdownDuration: 0, aiOpeningGrace: 0, ...(config.params || {}) };
  const stage = { id: 'test', levelId: 2, attemptId: 'attempt-42', sessionToken: 'session-84',
    fountainPattern: 'alternating', objective: { type: 'survive' }, ...(config.stage || {}) };
  assert.ok(game.configureRound({ ...config, params, stage }, 7));
  game._aiCommand = () => ({ ...NONE, aimX: 0 });
  game.start(); game.update(STEP, NONE);
  const positions = [[0, 0], [-3, 0], [0, 3], [0, -3]];
  game.actors.forEach((a, i) => Object.assign(a, { x: positions[i][0], y: positions[i][1],
    angle: 0, kx: 0, ky: 0, mx: 0, my: 0, _restTime: 0 }));
  return game;
}
const bossConfig = (bossRounds, extra = {}) => ({
  ...extra, enemyProfiles: [{ id: 'ai1', role: 'boss', scale: 1.3 }],
  stage: { objective: { type: 'boss', bossId: 'ai1', bossRounds } }
});
function sendOutside(game, actorIndex) {
  Object.assign(game.actors[actorIndex], { x: actorIndex % 2 ? 7.2 : -7.2, y: 0, kx: 0, ky: 0, mx: 0, my: 0 });
  advance(game, .1);
}

test('Round configs snapshot metadata and upgrades; reset reuses them; null restores standard quick mode', () => {
  const game = new WaterGameCore({ difficulty: 'standard', seed: 11, params: { maxEvents: 40 } });
  const config = { params: { roundDuration: 25 }, playerWeapon: { range: 8, waterCapacity: 175, tier: 3 },
    enemyProfiles: [{ id: 'ai2', scale: 1.2, role: 'boss' }],
    stage: { id: 'c4', attemptId: 'a1', sessionToken: 's1', theme: 'lagoon', objective: { type: 'boss', bossId: 'ai2' } } };
  const state = game.configureRound(config, 17);
  assert.equal(state.difficulty, 'easy'); close(state.timeLeft, 25);
  assert.equal(state.stage.attemptId, 'a1'); assert.equal(state.stage.sessionToken, 's1');
  close(state.actors[0].water, 175); close(state.actors[0].weapon.range, 8);
  assert.equal(state.actors[2].role, 'boss'); close(state.actors[2].actorRadius, .42);
  config.playerWeapon.range = 1; config.stage.attemptId = 'mutated'; config.enemyProfiles[0].scale = 2;
  game.reset(18);
  close(game.actors[0].weapon.range, 8); assert.equal(game.stage.attemptId, 'a1'); close(game.actors[2].actorRadius, .42);
  assert.equal(game.setDifficulty('standard'), false);
  const quick = game.configureRound(null, 19);
  assert.equal(quick.stage, null); assert.equal(quick.difficulty, 'standard'); close(quick.timeLeft, 30);
  close(quick.actors[0].weapon.range, 5); close(quick.actors[0].water, 100);
  close(quick.actors[1].enemyProfile.scale, 1); close(quick.actors[1].kickCap, 4.5);
  assert.equal(quick.params.maxEvents, 40);
});

test('Configure is rejected during countdown, play and pause without resetting the attempt', () => {
  const game = new WaterGameCore({ seed: 9 }); game.start();
  const countdown = JSON.stringify(game.getState());
  assert.equal(game.configureRound({ stage: { id: 'bad' } }, 100), false);
  assert.equal(JSON.stringify(game.getState()), countdown);
  advance(game, 3); assert.equal(game.phase, 'playing'); assert.equal(game.configureRound(null, 100), false);
  game.togglePause(); const paused = JSON.stringify(game.getState());
  assert.equal(game.configureRound({ params: { range: 10 } }, 100), false);
  assert.equal(JSON.stringify(game.getState()), paused);
});

test('Three real rays hit three different actors with a single trigger cost', () => {
  const game = fixture({ playerWeapon: { jetCount: 3, spreadAngle: .22, beamRadius: .10,
    pushAcceleration: 48, waterCapacity: 150, waterUse: 30 } });
  for (let i = 0; i < 3; i++) {
    const angle = (i - 1) * .22;
    Object.assign(game.actors[i + 1], { x: .35 + Math.cos(angle) * 3.3, y: Math.sin(angle) * 3.3 });
  }
  game.update(STEP, { ...NONE, shoot: true });
  assert.equal(game.beams.length, 3);
  assert.deepEqual(new Set(game.beams.map(b => b.targetId)), new Set(['ai1', 'ai2', 'ai3']));
  assert.deepEqual(game.beams.map(b => b.jetIndex), [0, 1, 2]);
  for (const beam of game.beams) {
    close(beam.x1, .35); close(beam.y1, 0); close(beam.radius, .10); close(beam.force, 48);
    assert.equal(beam.applied, true);
  }
  assert.ok(game.actors.slice(1).every(a => a.kx > 0)); close(game.actors[0].water, 149.5);
  close(game.actors[0].stats.hitTime, STEP);
});

test('Three overlapping rays apply exactly one impulse to the same large target', () => {
  const games = [1, 3].map(jetCount => {
    const game = fixture({ playerWeapon: { jetCount, spreadAngle: .18, pushAcceleration: 48, beamRadius: .20 },
      enemyProfiles: [{ id: 'ai1', scale: 2.5 }] });
    Object.assign(game.actors[1], { x: 2.5, y: 0 });
    Object.assign(game.actors[2], { x: -4, y: 4 }); Object.assign(game.actors[3], { x: -4, y: -4 });
    game.update(STEP, { ...NONE, shoot: true }); return game;
  });
  assert.equal(games[1].beams.filter(b => b.targetId === 'ai1').length, 3);
  assert.equal(games[1].beams.filter(b => b.applied).length, 1);
  close(games[1].actors[1].kx, games[0].actors[1].kx); close(games[1].actors[1].ky, 0);
  close(games[1].actors[0].stats.hitTime, STEP); close(games[1].actors[0].water, games[0].actors[0].water);
});

test('Each actor has independent capacity and consumption; upgraded player pressure does not upgrade AI', () => {
  const game = fixture({ playerWeapon: { waterCapacity: 150, waterUse: 12, pushAcceleration: 60 },
    enemyProfiles: [{ id: 'ai1', weapon: { waterCapacity: 60, waterUse: 30 } }] });
  game._aiCommand = a => a.id === 'ai1' ? { ...NONE, aimX: -1, shoot: true } : { ...NONE, aimX: 0 };
  advance(game, 1, { ...NONE, shoot: true });
  close(game.actors[0].water, 138); close(game.actors[1].water, 30);
  close(game.actors[0].weapon.pushAcceleration, 60); close(game.actors[1].weapon.pushAcceleration, 24);
  close(game.actors[2].weapon.waterCapacity, 100); close(game.params.waterCapacity, 100);
});

test('Fountain and passive refill use each weapon rate and capacity', () => {
  const game = fixture({ playerWeapon: { waterCapacity: 150, refillRate: 80, passiveWaterRate: 20 },
    enemyProfiles: [{ id: 'ai1', weapon: { waterCapacity: 60, refillRate: 10, passiveWaterRate: 2 } }] });
  const player = game.actors[0], enemy = game.actors[1];
  Object.assign(player, { x: -.5, y: 0, water: 0 }); Object.assign(enemy, { x: .5, y: 0, water: 0 });
  advance(game, 1); close(player.water, 80); close(enemy.water, 10);
  advance(game, 1); close(player.water, 150); close(enemy.water, 20);
  Object.assign(player, { x: 4.7, water: 0, _restTime: 0 }); Object.assign(enemy, { x: -4.7, water: 0, _restTime: 0 });
  game.timeElapsed = 0; game.timeLeft = game.params.roundDuration; game._updateFountains();
  advance(game, 1.9); close(player.water, 20); close(enemy.water, 2);
});

test('Range and width upgrades change real geometry while AI aims using its own range', () => {
  const game = fixture({ playerWeapon: { range: 8 }, enemyProfiles: [{ id: 'ai1', weapon: { range: 2 } }] });
  Object.assign(game.actors[1], { x: 6.8, y: 0, angle: Math.PI, targetId: 'p1', _targetHold: 99, _reaction: 0 });
  game.update(STEP, { ...NONE, shoot: true }); assert.equal(game.beams[0].targetId, 'ai1');
  assert.equal(game._traceShot(game.actors[1], Math.PI).target, null);
  assert.equal(WaterGameCore.prototype._aiCommand.call(game, game.actors[1], STEP).shoot, false);
  const widths = [.01, .3].map(beamRadius => {
    const g = fixture({ playerWeapon: { beamRadius } }); Object.assign(g.actors[1], { x: 3, y: .5 });
    g.update(STEP, { ...NONE, shoot: true }); return g;
  });
  assert.equal(widths[0].beams[0].targetId, null); assert.equal(widths[1].beams[0].targetId, 'ai1');
});

test('Pressure improves kick speed modestly with a bounded cap; explicit per-enemy caps remain respected', () => {
  const games = [undefined, 5].map(kickCap => {
    const game = fixture({ params: { arenaRadius: 100 }, playerWeapon: { range: 30, pushAcceleration: 60 },
      enemyProfiles: [{ id: 'ai1', ...(kickCap == null ? {} : { kickCap }) }] });
    Object.assign(game.actors[1], { x: 3, y: 0 });
    Object.assign(game.actors[2], { x: -20, y: 10 }); Object.assign(game.actors[3], { x: -20, y: -10 });
    advance(game, .8, { ...NONE, shoot: true }); return game;
  });
  close(games[0].actors[1].kx, 5.4); close(games[0].actors[1].kickCap, 5.4); close(games[1].actors[1].kx, 5);
  close(games[0].actors[0].kickCap, 4.5); close(games[0].actors[1].weapon.pushAcceleration, 24);
});

test('Boss resistance scales actual force and body scale matches collision and ray radius', () => {
  const games = [1, 2].map(pushResistance => {
    const game = fixture({ playerWeapon: { pushAcceleration: 48 },
      enemyProfiles: [{ id: 'ai1', scale: 2, role: 'boss', pushResistance }] });
    Object.assign(game.actors[1], { x: 3, y: 0 }); game.update(STEP, { ...NONE, shoot: true }); return game;
  });
  close(games[1].actors[1].kx / games[0].actors[1].kx, .5); close(games[1].beams[0].force, 24);
  close(games[1].actors[1].actorRadius, .7); assert.equal(games[1].actors[1].role, 'boss');
  const game = games[1]; Object.assign(game.actors[1], { x: .5, y: 0 }); game._separateActors();
  close(Math.hypot(game.actors[1].x - game.actors[0].x, game.actors[1].y - game.actors[0].y), 1.05);
  const small = fixture(); Object.assign(small.actors[1], { x: 3, y: .75 });
  Object.assign(game.actors[0], { x: 0, y: 0 }); Object.assign(game.actors[1], { x: 3, y: .75 });
  assert.equal(small._traceShot(small.actors[0], 0).target, null); assert.equal(game._traceShot(game.actors[0], 0).target.id, 'ai1');
});

test('Final partial water remains exact with three rays and greater pressure', () => {
  const game = fixture({ playerWeapon: { jetCount: 3, pushAcceleration: 60, waterUse: 25 },
    enemyProfiles: [{ id: 'ai1', scale: 2 }] });
  Object.assign(game.actors[1], { x: 2.5, y: 0 }); game.actors[0].water = .125;
  game.update(STEP, { ...NONE, shoot: true });
  const expected = 60 * (1 - Math.exp(-5 * .005)) / 5 * Math.exp(-5 * (STEP - .005));
  close(game.actors[1].kx, expected); close(game.actors[0].stats.shootingTime, .005);
  close(game.actors[0].water, 0); assert.equal(game.actors[0].shooting, false); assert.equal(game.beams.length, 0);
});

test('Real player knock-off awards one elimination; hits older than three seconds award none', () => {
  const game = fixture({ playerWeapon: { pushAcceleration: 48, range: 8 }, stage: { objective: { type: 'eliminate', count: 3 } } });
  Object.assign(game.actors[0], { x: 3, y: 0 }); Object.assign(game.actors[1], { x: 6.5, y: 0 });
  advance(game, .8, { ...NONE, shoot: true });
  assert.equal(game.actors[1].alive, false); assert.equal(game.actors[0].stats.eliminations, 1);
  assert.equal(game.events.find(e => e.type === 'elimination' && e.actorId === 'ai1').sourceId, 'p1');
  advance(game, .2); assert.equal(game.actors[0].stats.eliminations, 1);
  const expired = fixture(); Object.assign(expired.actors[1], { x: 2, y: 0 });
  expired.update(STEP, { ...NONE, shoot: true }); advance(expired, 3.1); sendOutside(expired, 1);
  assert.equal(expired.actors[1].alive, false); assert.equal(expired.actors[0].stats.eliminations, 0);
  assert.equal(expired.events.find(e => e.type === 'elimination' && e.actorId === 'ai1').sourceId, null);
});

test('Mixed AI combat meets the total elimination objective without falsely crediting P1', () => {
  const game = fixture({ params: { roundDuration: 2 }, stage: { objective: { type: 'eliminate', count: 1 } },
    enemyProfiles: [{ id: 'ai2', weapon: { pushAcceleration: 40 } }] });
  Object.assign(game.actors[0], { x: 0, y: -3 }); Object.assign(game.actors[1], { x: 6.8, y: 0 });
  Object.assign(game.actors[2], { x: 3, y: 0, angle: 0 }); Object.assign(game.actors[3], { x: -3, y: 0 });
  game._aiCommand = a => a.id === 'ai2' ? { ...NONE, shoot: true } : { ...NONE, aimX: 0 };
  advance(game, 1);
  assert.equal(game.phase, 'playing'); assert.equal(game.result, null); assert.equal(game.getState().stageGoalCompleted, true);
  game._aiCommand = () => ({ ...NONE, aimX: 0 }); advance(game, 1);
  assert.equal(game.result.reason, 'timeout'); assert.equal(game.result.cleared, true);
  assert.equal(game.result.aiEliminated, 1); assert.equal(game.result.playerEliminations, 0); assert.equal(game.actors[2].stats.eliminations, 1);
});

test('Last-hit credit transfers to the later actual shooter', () => {
  const game = fixture({ stage: { objective: { type: 'eliminate', count: 3 } } });
  Object.assign(game.actors[1], { x: 2, y: 0 }); game.update(STEP, { ...NONE, shoot: true });
  assert.equal(game.actors[1].lastHitBy, 'p1');
  Object.assign(game.actors[2], { x: game.actors[1].x, y: -2, angle: Math.PI / 2 });
  game._aiCommand = a => a.id === 'ai2' ? { ...NONE, aimX: 0, aimY: 1, shoot: true } : { ...NONE, aimX: 0 };
  game.update(STEP, NONE); assert.equal(game.actors[1].lastHitBy, 'ai2');
  game._aiCommand = () => ({ ...NONE, aimX: 0 }); sendOutside(game, 1);
  assert.equal(game.actors[0].stats.eliminations, 0); assert.equal(game.actors[2].stats.eliminations, 1);
});

test('Elimination goals record once while controls, water and the round timer keep running', () => {
  const game = fixture({ params: { roundDuration: 1 }, stage: { objective: { type: 'eliminate', count: 2 } } });
  sendOutside(game, 1); assert.equal(game.phase, 'playing'); assert.equal(game.getState().objectiveProgress.current, 1);
  sendOutside(game, 2); assert.equal(game.phase, 'playing'); assert.equal(game.result, null);
  const goalTime = game.timeElapsed; close(goalTime, .2);
  assert.equal(game.getState().stageGoalCompleted, true); close(game.getState().objectiveCompletedAt, goalTime);
  assert.equal(game.getState().objectiveProgress.completed, true); close(game.getState().objectiveProgress.completedAt, goalTime);
  Object.assign(game.actors[0], { x: 4.5, y: 0 }); const water = game.actors[0].water;
  advance(game, .2, { ...NONE, moveX: -1, shoot: true });
  close(game.timeElapsed, goalTime + .2); assert.ok(game.actors[0].x < 4.3); assert.ok(game.actors[0].water < water);
  assert.equal(game.actors[0].shooting, true); assert.equal(game.beams.length, 1);
  const notifications = game.events.filter(e => e.type === 'objective-complete'); assert.equal(notifications.length, 1);
  close(notifications[0].completedAt, goalTime); assert.equal(notifications[0].objectiveProgress.completed, true);
  assert.equal(game.stage.attemptId, 'attempt-42'); assert.equal(game.stage.sessionToken, 'session-84');
  advance(game, .6); assert.equal(game.result.reason, 'timeout'); assert.equal(game.result.cleared, true);
  close(game.result.duration, 1); close(game.result.objectiveCompletedAt, goalTime); close(game.result.completedAt, goalTime);
  assert.equal(game.result.stageGoalCompleted, true); assert.equal(game.events.filter(e => e.type === 'objective-complete').length, 1);
});

test('One-round Boss goals require the designated boss, independent of credit and other AI', () => {
  const game = fixture(bossConfig(1, { params: { roundDuration: 1 } })); sendOutside(game, 2); assert.equal(game.phase, 'playing');
  assert.equal(game.getState().stageGoalCompleted, false);
  sendOutside(game, 1); assert.equal(game.phase, 'playing'); assert.equal(game.result, null);
  assert.equal(game.getState().objectiveProgress.completed, true); assert.equal(game.getState().objectiveProgress.current, 1);
  assert.equal(game.getState().objectiveProgress.bossId, 'ai1'); assert.equal(game.actors[3].alive, true);
  advance(game, .8); assert.equal(game.result.cleared, true); assert.equal(game.result.reason, 'timeout');
  close(game.result.objectiveCompletedAt, .2); assert.equal(game.actors[1].spawnVersion, 0);
});

test('Clearing every AI completes survival immediately without waiting for the timer', () => {
  const game = fixture({ params: { roundDuration: 1 } });
  game.actors.slice(1).forEach((a, i) => Object.assign(a, { x: Math.cos(i * 2.1) * 7.2, y: Math.sin(i * 2.1) * 7.2 }));
  advance(game, .1); assert.equal(game.phase, 'result'); assert.equal(game.getState().aliveCount, 1);
  assert.equal(game.getState().stageGoalCompleted, true); close(game.getState().objectiveCompletedAt, .1);
  assert.equal(game.result.reason, 'all-opponents-out'); assert.equal(game.result.cleared, true); close(game.result.duration, .1);
  close(game.result.objectiveCompletedAt, .1); assert.equal(game.events.some(e => e.type === 'objective-complete'), false);
});

test('Completed goals freeze on pause and retain success if P1 later falls', () => {
  const game = fixture({ params: { roundDuration: 2 }, stage: { objective: { type: 'eliminate', count: 1 } } });
  sendOutside(game, 1); const completedAt = game.timeElapsed; assert.equal(game.phase, 'playing');
  game.togglePause(); const paused = JSON.stringify(game.getState());
  game.update(100, { ...NONE, moveX: 1, shoot: true }); assert.equal(JSON.stringify(game.getState()), paused);
  game.togglePause(); close(game.timeElapsed, completedAt); close(game.getState().objectiveCompletedAt, completedAt);
  sendOutside(game, 0); assert.equal(game.result.reason, 'player-out'); assert.equal(game.actors[0].alive, false);
  assert.equal(game.result.cleared, true); assert.equal(game.result.playerWon, true); assert.equal(game.result.type, 'win');
  assert.equal(game.result.objectiveProgress.completed, true); close(game.result.objectiveCompletedAt, completedAt);
  assert.ok(game.result.duration > completedAt); assert.equal(game.events.filter(e => e.type === 'objective-complete').length, 1);
  assert.equal(game.events.filter(e => e.type === 'result').length, 1);
  const ended = JSON.stringify(game.getState()); advance(game, 5); assert.equal(JSON.stringify(game.getState()), ended);
});

test('Defeating every AI automatically banks a campaign clear exactly once', () => {
  const game = fixture({ params: { roundDuration: 2 }, stage: { objective: { type: 'eliminate', count: 3 } } });
  game.actors.slice(1).forEach((a, i) => Object.assign(a, { x: Math.cos(i * 2.1) * 7.2, y: Math.sin(i * 2.1) * 7.2 }));
  advance(game, .1); assert.equal(game.getState().aliveCount, 1); assert.equal(game.phase, 'result');
  assert.equal(game.getState().objectiveProgress.completed, true); const completedAt = game.timeElapsed;
  assert.equal(game.result.reason, 'all-opponents-out'); assert.equal(game.result.cleared, true); close(game.result.objectiveCompletedAt, completedAt);
  const finished = JSON.stringify(game.getState()); advance(game, .2, { ...NONE, moveY: 1, shoot: true });
  assert.equal(JSON.stringify(game.getState()), finished); assert.equal(game.endCompletedStage(), false);
  assert.equal(game.events.filter(e => e.type === 'result').length, 1);
});

test('Survival still fails if P1 falls on the timer deadline', () => {
  const game = fixture({ params: { roundDuration: .1 } }); sendOutside(game, 0);
  assert.equal(game.result.reason, 'player-out'); assert.equal(game.result.cleared, false);
  assert.equal(game.result.stageGoalCompleted, false); assert.equal(game.result.objectiveCompletedAt, null);
  assert.equal(game.result.objectiveProgress.completed, false); close(game.result.duration, .1);
  assert.equal(game.events.some(e => e.type === 'objective-complete'), false);
});

test('Resetting or removing a stage clears completed goal metadata before a new attempt', () => {
  const game = fixture({ stage: { objective: { type: 'eliminate', count: 1 } } }); sendOutside(game, 1);
  assert.equal(game.getState().stageGoalCompleted, true); game.reset(35);
  assert.equal(game.phase, 'ready'); assert.equal(game.result, null); assert.equal(game.getState().stageGoalCompleted, false);
  assert.equal(game.getState().objectiveCompletedAt, null); assert.equal(game.getState().objectiveProgress.completed, false);
  assert.equal(game.getState().objectiveProgress.completedAt, null); assert.equal(game.events.some(e => e.type === 'objective-complete'), false);
  game.configureRound(null, 36); assert.equal(game.stage, null); assert.equal(game.getState().stageGoalCompleted, false);
  assert.equal(game.getState().objectiveCompletedAt, null); assert.equal(game.getState().objectiveProgress, null);
});

test('Explicitly ending completed bonus play banks a paused clear once and refuses unfinished stages', () => {
  const game = fixture({ stage: { objective: { type: 'eliminate', count: 1 } } });
  game.togglePause(); const unfinished = JSON.stringify(game.getState());
  assert.equal(game.endCompletedStage(), false); assert.equal(JSON.stringify(game.getState()), unfinished);
  game.togglePause(); sendOutside(game, 1); const completedAt = game.timeElapsed;
  advance(game, .2); game.togglePause(); const finalDuration = game.timeElapsed;
  assert.equal(game.endCompletedStage(), true); assert.equal(game.phase, 'result'); assert.equal(game.getState().pausedFrom, null);
  assert.equal(game.result.reason, 'player-finish'); assert.equal(game.result.cleared, true);
  close(game.result.duration, finalDuration); close(game.result.objectiveCompletedAt, completedAt);
  assert.equal(game.events.filter(e => e.type === 'result').length, 1); const finished = JSON.stringify(game.getState());
  assert.equal(game.endCompletedStage(), false); assert.equal(JSON.stringify(game.getState()), finished);
  assert.equal(game.togglePause(), false); advance(game, 2); assert.equal(JSON.stringify(game.getState()), finished);
  game.reset(60); assert.equal(game.endCompletedStage(), false);
  game.configureRound(null, 61); game.start(); advance(game, 3); assert.equal(game.endCompletedStage(), false);
});

test('Campaign player-out ends immediately, freezes failure and permits a clean configured retry', () => {
  const game = fixture(); sendOutside(game, 0);
  assert.equal(game.result.reason, 'player-out'); assert.equal(game.result.cleared, false); assert.equal(game.result.type, 'loss');
  assert.ok(game.result.duration < .2); const frozen = JSON.stringify(game.getState());
  advance(game, 5, { ...NONE, shoot: true, moveX: 1 }); assert.equal(JSON.stringify(game.getState()), frozen);
  const next = game.configureRound({ playerWeapon: { waterCapacity: 200, jetCount: 3 },
    stage: { id: 'new-stage', attemptId: 'next', sessionToken: 'same-session', objective: { type: 'survive' } } }, 18);
  assert.equal(next.phase, 'ready'); assert.equal(next.result, null); assert.ok(next.actors.every(a => a.alive));
  close(next.actors[0].water, 200); assert.equal(next.actors[0].weapon.jetCount, 3); assert.equal(next.stage.attemptId, 'next');
  game.reset(19); close(game.actors[0].water, 200); assert.equal(game.actors[0].stats.eliminations, 0);
});

test('P1 death takes precedence over an objective completed in the same batch', () => {
  const game = fixture({ stage: { objective: { type: 'eliminate', count: 1 } } });
  Object.assign(game.actors[0], { x: -7.2, y: 0 }); Object.assign(game.actors[1], { x: 7.2, y: 0 }); advance(game, .1);
  assert.equal(game.result.aiEliminated, 1); assert.equal(game.result.objectiveProgress.current, 1);
  assert.equal(game.result.objectiveProgress.completed, false); assert.equal(game.result.stageGoalCompleted, false);
  assert.equal(game.result.objectiveCompletedAt, null); assert.equal(game.events.some(e => e.type === 'objective-complete'), false);
  assert.equal(game.result.reason, 'player-out'); assert.equal(game.result.cleared, false);
});

test('Unmet objectives fail at timeout even if the player is alive', () => {
  const game = fixture({ params: { roundDuration: .2 }, stage: { objective: { type: 'eliminate', count: 3 } } });
  advance(game, .2); assert.equal(game.actors[0].alive, true); assert.equal(game.result.reason, 'timeout');
  assert.equal(game.result.cleared, false); assert.equal(game.result.playerWon, false); assert.deepEqual(game.result.winners, []);
  assert.equal(game.result.stageGoalCompleted, false); assert.equal(game.result.objectiveCompletedAt, null);
});

test('Ring turns the center off and alternates opposite outer pairs with correct preview', () => {
  const game = fixture({ params: { outerFountainRadius: 3.6 }, stage: { fountainPattern: 'ring' } });
  const active = () => game.fountains.filter(f => f.active).map(f => f.id);
  assert.deepEqual(active(), ['outer0', 'outer2']); close(game.fountains[1].x, 3.6);
  advance(game, 3.5); assert.deepEqual(game.fountains.filter(f => f.preview).map(f => f.id), ['outer1', 'outer3']);
  advance(game, .5); assert.deepEqual(active(), ['outer1', 'outer3']);
  assert.equal(game.fountains[0].active, false); assert.equal(game.fountains.some(f => f.preview), false); close(game.getState().fountainSwitchIn, 4);
  advance(game, 4); assert.deepEqual(active(), ['outer0', 'outer2']);
});

test('Pulse runs a true three-second center / three-second perimeter cycle', () => {
  const game = fixture({ stage: { fountainPattern: 'pulse' } });
  assert.deepEqual(game.fountains.filter(f => f.active).map(f => f.id), ['center']);
  advance(game, 2.5); assert.equal(game.fountains.filter(f => f.preview).length, 4);
  advance(game, .5); assert.equal(game.fountains.filter(f => f.active).length, 4); assert.equal(game.fountains[0].active, false);
  assert.equal(game.fountains.some(f => f.preview), false); close(game.getState().fountainSwitchIn, 3);
  advance(game, 3); assert.equal(game.fountains[0].active, true);
});

test('Pause freezes configured weapons, objectives, recovery and fountain schedules', () => {
  const game = fixture({ playerWeapon: { jetCount: 3, waterCapacity: 180 }, stage: { fountainPattern: 'pulse' } });
  advance(game, .5, { ...NONE, shoot: true }); game.togglePause(); const paused = JSON.stringify(game.getState());
  game.update(90, { ...NONE, shoot: true, moveX: 1 }); assert.equal(JSON.stringify(game.getState()), paused);
  game.togglePause(); const before = game.timeElapsed; game.update(90, NONE); close(game.timeElapsed - before, .25);
});

test('Boss stays down for 1.3 seconds, respawns once and resets physical state without reviving other AI', () => {
  const game = fixture(bossConfig(2)); const boss = game.actors[1]; sendOutside(game, 2); sendOutside(game, 1);
  assert.equal(game.phase, 'playing'); assert.equal(game.getState().objectiveProgress.current, 1);
  close(game.getState().bossRespawnIn, 1.3); assert.equal(boss.alive, false);
  Object.assign(boss, { water: 0, _dry: true, _restTime: 4, targetId: 'p1', hit: .1, kx: 4,
    ky: 2, mx: 2, my: 1, lastHitBy: 'p1', lastHitAt: game.timeElapsed });
  advance(game, 77 * STEP); assert.equal(boss.alive, false); advance(game, STEP);
  assert.equal(boss.alive, true); assert.equal(boss.spawnVersion, 1); assert.equal(game.actors[2].alive, false);
  close(boss.water, boss.weapon.waterCapacity); close(boss.kx, 0); close(boss.ky, 0); close(boss.mx, 0); close(boss.my, 0);
  close(boss.hit, 0); close(boss.outsideTime, 0); assert.equal(boss.rank, null); assert.equal(boss.eliminatedAt, null);
  assert.equal(boss.lastHitBy, null); assert.equal(boss.targetId, null); assert.equal(boss._dry, false);
  const radius = Math.hypot(boss.x, boss.y); assert.ok(radius >= 2.7 && radius <= 3.3);
  const events = game.events.filter(e => e.type === 'respawn'); assert.equal(events.length, 1);
  assert.equal(events[0].actorId, 'ai1'); assert.equal(events[0].round, 2); assert.equal(events[0].total, 2);
  advance(game, .4); assert.equal(game.events.filter(e => e.type === 'respawn').length, 1);
  assert.equal(game.getState().bossDefeats, 1);
});

test('Boss respawn countdown freezes during pause and failure cancels pending return', () => {
  const game = fixture(bossConfig(2)); sendOutside(game, 1); advance(game, .3);
  const remaining = game.getState().bossRespawnIn; game.togglePause();
  const paused = JSON.stringify(game.getState()); game.update(100, NONE); assert.equal(JSON.stringify(game.getState()), paused);
  game.togglePause(); advance(game, .2); close(game.getState().bossRespawnIn, remaining - .2);
  sendOutside(game, 0); assert.equal(game.result.reason, 'player-out'); assert.equal(game.getState().bossRespawnIn, null);
  advance(game, 5); assert.equal(game.actors[1].alive, false); assert.equal(game.actors[1].spawnVersion, 0);
});

test('Actual gun knock-offs complete three Boss waves with exactly three credits and two respawns', () => {
  const game = fixture(bossConfig(3, { params: { roundDuration: 10 }, playerWeapon: { range: 8, pushAcceleration: 60, waterCapacity: 200, waterUse: 12 } }));
  const boss = game.actors[1];
  Object.assign(game.actors[0], { x: 3, y: 0 }); Object.assign(game.actors[2], { x: -3, y: 3 }); Object.assign(game.actors[3], { x: -3, y: -3 });
  for (let round = 1; round <= 3; round++) {
    Object.assign(boss, { x: 6.5, y: 0 });
    for (let frame = 0; frame < 120 && boss.alive; frame++) game.update(STEP, { ...NONE, shoot: true });
    assert.equal(boss.alive, false); assert.equal(game.getState().bossDefeats, round);
    assert.equal(game.actors[0].stats.eliminations, round);
    if (round < 3) {
      assert.equal(game.phase, 'playing');
      for (let frame = 0; frame < 90 && !boss.alive; frame++) game.update(STEP, NONE);
      assert.equal(boss.alive, true); assert.equal(boss.spawnVersion, round);
    }
  }
  assert.equal(game.phase, 'playing'); assert.equal(game.result, null); const completedAt = game.timeElapsed;
  assert.equal(game.getState().objectiveProgress.completed, true); assert.equal(game.getState().objectiveProgress.current, 3);
  assert.equal(game.getState().objectiveProgress.count, 3); assert.equal(game.events.filter(e => e.type === 'respawn').length, 2);
  assert.equal(game.events.filter(e => e.type === 'elimination' && e.actorId === 'ai1').length, 3);
  advance(game, 2); assert.equal(boss.alive, false); assert.equal(boss.spawnVersion, 2);
  assert.equal(game.phase, 'playing'); assert.equal(game.getState().bossRespawnIn, null);
  assert.equal(game.events.filter(e => e.type === 'objective-complete').length, 1);
  advance(game, game.timeLeft); assert.equal(game.result.cleared, true); assert.equal(game.result.reason, 'timeout');
  assert.equal(game.result.playerEliminations, 3); close(game.result.duration, 10); close(game.result.objectiveCompletedAt, completedAt);
  assert.equal(game.events.filter(e => e.type === 'respawn').length, 2); assert.equal(boss.alive, false);
});

test('Pending Boss waves reset cleanly and survive-mode boss appearances never respawn', () => {
  const game = fixture(bossConfig(3)); sendOutside(game, 1); game.reset(30);
  assert.equal(game.phase, 'ready'); assert.equal(game.getState().bossDefeats, 0); assert.equal(game.getState().bossRespawnIn, null);
  assert.equal(game.actors[1].spawnVersion, 0); assert.equal(game.actors[1].alive, true); assert.equal(game.getState().objectiveProgress.count, 3);
  game.configureRound(null, 31); assert.equal(game.stage, null); assert.equal(game.getState().bossDefeats, 0);
  const survival = fixture({ enemyProfiles: [{ id: 'ai1', role: 'boss' }], stage: { objective: { type: 'survive', bossRounds: 3 } } });
  sendOutside(survival, 1); advance(survival, 2); assert.equal(survival.actors[1].alive, false);
  assert.equal(survival.actors[1].spawnVersion, 0); assert.equal(survival.getState().bossDefeats, 0);
});

test('Boss timeout does not count an unfinished next wave or resurrect it after result', () => {
  const game = fixture(bossConfig(3, { params: { roundDuration: .5 } })); sendOutside(game, 1); advance(game, .4);
  assert.equal(game.result.reason, 'timeout'); assert.equal(game.result.cleared, false);
  assert.equal(game.result.objectiveProgress.current, 1); assert.equal(game.result.objectiveProgress.count, 3);
  assert.equal(game.getState().bossRespawnIn, null); advance(game, 4); assert.equal(game.actors[1].alive, false);
});

test('Configured multi-jet simulation is deterministic and every live numerical value stays finite', () => {
  const config = { params: { countdownDuration: 0, roundDuration: 12 },
    playerWeapon: { range: 8, jetCount: 3, spreadAngle: .2, pushAcceleration: 48, waterCapacity: 160 },
    enemyProfiles: [{ id: 'ai1', role: 'boss', scale: 1.4, pushResistance: 1.5 }],
    stage: { id: 'stress', fountainPattern: 'ring', objective: { type: 'boss', bossId: 'ai1', bossRounds: 3 } } };
  const games = [new WaterGameCore(), new WaterGameCore()];
  for (const game of games) { game.configureRound(config, 94); game.start(); }
  for (let frame = 0; frame < 800; frame++) {
    const input = { moveX: Math.cos(frame * .03) * .5, moveY: Math.sin(frame * .03) * .5,
      aimX: Math.cos(frame * .01), aimY: Math.sin(frame * .01), shoot: frame % 80 < 55 };
    for (const game of games) {
      const state = game.update(STEP, input);
      for (const a of state.actors) {
        for (const key of ['x', 'y', 'water', 'kx', 'ky', 'vx', 'vy', 'lastHitAt', 'kickCap', 'actorRadius']) assert.ok(Number.isFinite(a[key]), key);
        assert.ok(a.water >= 0 && a.water <= a.weapon.waterCapacity); assert.ok(Math.hypot(a.kx, a.ky) <= a.kickCap + 1e-8);
      }
      for (const beam of state.beams) for (const key of ['x1', 'y1', 'x2', 'y2', 'radius', 'force', 'jetIndex']) assert.ok(Number.isFinite(beam[key]), key);
      assert.ok(state.events.length <= state.params.maxEvents);
    }
  }
  assert.equal(JSON.stringify(games[0].getState()), JSON.stringify(games[1].getState())); assert.equal(games[0].phase, 'result');
});

console.log(`RESULT ${checks} weapon/campaign checks passed.`);
