'use strict';
const assert = require('node:assert/strict');
const Core = require('./gameplay.js');
const STEP = 1 / 60;
const NONE = { moveX: 0, moveY: 0, aimX: 1, aimY: 0, shoot: false };
let checks = 0;
function test(name, fn) { fn(); checks++; console.log('PASS ' + name); }
function advance(game, seconds, input = NONE) {
  for (let i = 0; i < Math.round(seconds / STEP); i++) game.update(STEP, input);
}
function near(a, b, tolerance = 1e-8) { assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`); }
function fixture({ profile = {}, params = {}, stage = {}, playerWeapon = {} } = {}) {
  const game = new Core({ seed: 17 });
  game.configureRound({ params: { countdownDuration: 0, roundDuration: 8, aiOpeningGrace: 0,
    aiPlayerTargetLimit: 0, aiPlayerTargetPenalty: 0, aiMoveFactor: 1, ...params }, playerWeapon,
    enemyProfiles: [{ id: 'ai1', reaction: .2, aimError: 0, burstDuration: 0, burstRest: 0,
      tacticalLevel: 1, aimLead: .15, edgeMargin: 1.4, prediction: .5, preferredRange: 2.5, ...profile }],
    stage: { levelId: 0, objective: { type: 'survive' }, ...stage } }, 17);
  game.start(); game.update(STEP, NONE);
  Object.assign(game.actors[0], { x: 0, y: 0, vx: 0, vy: 0, kx: 0, ky: 0, mx: 0, my: 0, angle: 0 });
  Object.assign(game.actors[1], { x: 3, y: 0, vx: 0, vy: 0, kx: 0, ky: 0, mx: 0, my: 0,
    angle: Math.PI, targetId: 'p1', _targetTimer: 99, _targetHold: 99, _reaction: 0, hit: 0 });
  game.actors.slice(2).forEach(a => { a.alive = false; });
  return game;
}
function visibleStream(game, { x1 = 0, y1 = 0, dx = 1, dy = 0, length = 5 } = {}) {
  game.beams = [{ actorId: 'p1', x1, y1, dx, dy, length, radius: .18 }];
}

test('Tactical profile values clamp safely and quick play keeps legacy behavior', () => {
  const game = fixture({ profile: { tacticalLevel: 9, aimLead: 3, edgeMargin: -9, prediction: 9, preferredRange: NaN } });
  const p = game.actors[1].enemyProfile;
  near(p.tacticalLevel, 1); near(p.aimLead, .5); near(p.edgeMargin, .25); near(p.prediction, 1); near(p.preferredRange, 2.2);
  const quick = new Core(); near(quick.actors[1].enemyProfile.tacticalLevel, 0); near(quick.actors[1].enemyProfile.aimLead, 0);
});

test('A new visible stream cannot bypass the finite AI reaction interval', () => {
  const game = fixture(), ai = game.actors[1];
  const saved = { moveX: -.2, moveY: 0, aimX: -1, aimY: 0, shoot: false };
  ai._command = saved; ai._reaction = .2; visibleStream(game);
  near(game._aiCommand(ai, STEP).moveY, 0); assert.ok(ai._reaction > 0);
  for (let i = 0; i < 12; i++) game._aiCommand(ai, STEP);
  assert.equal(ai.aiState, 'dodging'); assert.ok(Math.abs(ai._command.moveY) > .8);
});

test('Advanced AI leaves a visible jet sideways and releases the trigger to regain running speed', () => {
  const game = fixture(), ai = game.actors[1]; visibleStream(game);
  const water = ai.water, c = game._aiCommand(ai, STEP);
  assert.equal(ai.aiState, 'dodging'); assert.ok(Math.abs(c.moveY) > .8); assert.ok(c.moveX < 0);
  assert.equal(c.shoot, false); near(ai.water, water);
});

test('Early AI still attacks during evasion, making tactical growth gradual', () => {
  const game = fixture({ profile: { tacticalLevel: .3, aimLead: 0 } }), ai = game.actors[1]; visibleStream(game);
  const c = game._aiCommand(ai, STEP);
  assert.equal(ai.aiState, 'dodging'); assert.ok(Math.abs(c.moveY) > .8); assert.equal(c.shoot, true);
});

test('A distant, blocked or off-axis visible stream causes no invented threat', () => {
  for (const beam of [{ length: 1 }, { y1: 2 }, { x1: 5 }]) {
    const game = fixture(), ai = game.actors[1]; visibleStream(game, beam); game._aiCommand(ai, STEP);
    assert.notEqual(ai.aiState, 'dodging');
  }
});

test('Edge prediction retreats before crossing the boundary and stops shooting', () => {
  const game = fixture(), ai = game.actors[1]; Object.assign(ai, { x: 4.8, vx: 5 });
  const c = game._aiCommand(ai, STEP);
  assert.equal(ai.aiState, 'edge-recovery'); assert.ok(c.moveX < -.9); assert.equal(c.shoot, false);
});

test('Sidestep chooses the free side instead of running into a nearby actor', () => {
  const game = fixture(), ai = game.actors[1];
  Object.assign(game.actors[2], { alive: true, x: 3, y: 1.6 }); visibleStream(game);
  const c = game._aiCommand(ai, STEP); assert.ok(c.moveY < -.7);
});

test('AI aims at a short velocity lead sampled at its reaction tick', () => {
  const game = fixture({ profile: { aimLead: .2 } }), ai = game.actors[1]; game.actors[0].vy = 2;
  const c = game._aiCommand(ai, STEP); near(Math.atan2(c.aimY, -c.aimX), Math.atan2(.4, 3));
  game.actors[0].vy = -2; const held = game._aiCommand(ai, STEP);
  assert.ok(held.aimY > 0); // New movement is not known until the next reaction.
});

test('AI seeks the target inner side rather than pushing a rival toward the center', () => {
  const game = fixture(), ai = game.actors[1]; Object.assign(game.actors[0], { x: 5.1 });
  Object.assign(ai, { x: 4, angle: 0 }); const c = game._aiCommand(ai, STEP);
  assert.ok(c.moveX < -.8); assert.ok(c.aimX > .95);
});

test('AI attacks only when its own finite rays reach the selected opponent', () => {
  const game = fixture({ profile: { weapon: { range: 2 } } }), ai = game.actors[1];
  Object.assign(ai, { x: 3.8, angle: Math.PI }); assert.equal(game._aiCommand(ai, STEP).shoot, false);
  Object.assign(ai, { x: 1.8, _reaction: 0 }); assert.equal(game._aiCommand(ai, STEP).shoot, true);
  Object.assign(game.actors[2], { alive: true, x: .85, y: 0 }); ai._reaction = 0;
  assert.equal(game._aiCommand(ai, STEP).shoot, false);
});

test('AI prefers a slightly farther fountain clear of an observed jet', () => {
  const game = fixture({ stage: { fountainPattern: 'ring' } }), ai = game.actors[1];
  Object.assign(ai, { x: 1.3, water: 0 });
  visibleStream(game, { x1: 5, y1: -.95, dx: -1, dy: 0, length: 3 });
  const c = game._aiCommand(ai, STEP);
  assert.equal(ai.aiState, 'refilling'); assert.ok(c.moveX < 0); assert.equal(c.shoot, false);
});

test('Empty tactical AI uses the real fountain rate and never receives instant full water', () => {
  const game = fixture({ stage: { fountainPattern: 'ring' }, profile: { weapon: { refillRate: 20, passiveWaterRate: 0 } } });
  const ai = game.actors[1]; Object.assign(ai, { x: 2.8, water: 0 }); advance(game, .3);
  near(ai.water, 6); near(ai.stats.refillTime, .3); assert.equal(ai.refillSource, 'fountain');
});

test('Two pressure upgrades increase initial force without doubling the victim velocity cap', () => {
  const games = [24, 28.4].map(pushAcceleration => {
    const g = fixture({ params: { arenaRadius: 100 }, playerWeapon: { range: 30, pushAcceleration } });
    g._aiCommand = () => ({ ...NONE }); advance(g, .1, { ...NONE, shoot: true }); return g;
  });
  assert.ok(games[1].actors[1].kx > games[0].actors[1].kx * 1.17);
  assert.ok(games[1].actors[1].kickCap < games[0].actors[1].kickCap * 1.03);
});

test('Level-zero workshop trials remain playable after clearing their targets', () => {
  const game = fixture({ stage: { objective: { type: 'eliminate', count: 1 } } });
  game._aiCommand = () => ({ ...NONE }); Object.assign(game.actors[1], { x: 7.2 }); advance(game, .1);
  assert.equal(game.phase, 'playing'); assert.equal(game.stageGoalCompleted, true); assert.equal(game.result, null);
});

test('Pending Boss waves block automatic clear, then the final real wave settles exactly once', () => {
  const game = fixture({ profile: { role: 'boss' }, stage: { levelId: 4,
    objective: { type: 'boss', bossId: 'ai1', bossRounds: 2 } } });
  game._aiCommand = () => ({ ...NONE }); Object.assign(game.actors[1], { x: 7.2 }); advance(game, .1);
  assert.equal(game.phase, 'playing'); assert.equal(game.getState().aliveCount, 1); assert.ok(game.getState().bossRespawnIn > 1);
  advance(game, 1.3); assert.equal(game.actors[1].alive, true); assert.equal(game.actors[1].spawnVersion, 1);
  Object.assign(game.actors[1], { x: 7.2 }); advance(game, .1);
  assert.equal(game.phase, 'result'); assert.equal(game.result.reason, 'all-opponents-out'); assert.equal(game.result.cleared, true);
  assert.equal(game.getState().bossDefeats, 2); assert.equal(game.getState().bossRespawnIn, null);
  const frozen = JSON.stringify(game.getState()); advance(game, 3); assert.equal(JSON.stringify(game.getState()), frozen);
  assert.equal(game.events.filter(e => e.type === 'result').length, 1);
});

test('Same-step player and opponent clearance remains failure without prior goal completion', () => {
  const game = fixture({ stage: { levelId: 2, objective: { type: 'eliminate', count: 1 } } });
  game._aiCommand = () => ({ ...NONE }); Object.assign(game.actors[0], { x: -7.2 }); Object.assign(game.actors[1], { x: 7.2 });
  game.actors.slice(2).forEach((a, i) => Object.assign(a, { alive: true, x: 0, y: i ? -7.2 : 7.2 }));
  advance(game, .1); assert.equal(game.result.reason, 'player-out'); assert.equal(game.result.cleared, false);
  assert.equal(game.stageGoalCompleted, false); assert.equal(game.events.filter(e => e.type === 'result').length, 1);
});

test('Advanced tactics stay deterministic, finite and within water and kick limits through real combat', () => {
  const games = [new Core(), new Core()];
  const config = { params: { countdownDuration: 0, roundDuration: 12, aiOpeningGrace: .5,
    aiMoveFactor: 1.05, aiPlayerTargetLimit: 2 }, playerWeapon: { pushAcceleration: 35, jetCount: 3, range: 6.5 },
    enemyProfiles: [1, 2, 3].map(i => ({ id: 'ai' + i, tacticalLevel: .9, reaction: .18,
      aimError: .08, aimLead: .18, prediction: .55, edgeMargin: 1.7, weapon: { passiveWaterRate: 2 } })),
    stage: { levelId: 8, fountainPattern: 'ring', objective: { type: 'eliminate', count: 3 } } };
  for (const g of games) { g.configureRound(config, 29); g.start(); }
  for (let f = 0; f < 740; f++) for (const g of games) {
    g.update(STEP, { moveX: Math.sin(f * .021) * .6, moveY: Math.cos(f * .021) * .6,
      aimX: Math.cos(f * .025), aimY: Math.sin(f * .025), shoot: f % 140 < 80 });
    for (const a of g.actors) {
      assert.ok([a.x, a.y, a.vx, a.vy, a.water].every(Number.isFinite));
      assert.ok(a.water >= 0 && a.water <= a.weapon.waterCapacity); assert.ok(Math.hypot(a.kx, a.ky) <= a.kickCap + 1e-8);
    }
  }
  assert.equal(JSON.stringify(games[0].getState()), JSON.stringify(games[1].getState()));
  assert.equal(games[0].phase, 'result');
});

console.log(`RESULT ${checks} tactical AI / automatic-clear checks passed.`);
