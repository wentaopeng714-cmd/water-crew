'use strict';
const assert = require('node:assert/strict');
const Core = require('./gameplay.js');
const STEP = 1 / 60;
const NONE = { moveX: 0, moveY: 0, aimX: 1, aimY: 0, shoot: false };
let checks = 0;
function test(name, fn) { fn(); checks++; console.log('PASS ' + name); }
function near(a, b, tolerance = 1e-8) { assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`); }
function advance(game, seconds, input = NONE) {
  for (let i = 0; i < Math.round(seconds / STEP); i++) game.update(STEP, input);
}
function fixture(resistance, { push = 24, jets = 1 } = {}) {
  const game = new Core({ seed: 31 });
  game.configureRound({ params: { countdownDuration: 0, roundDuration: 10, aiOpeningGrace: 0 },
    playerWeapon: { pushAcceleration: push, range: 8, jetCount: jets, spreadAngle: .025,
      waterCapacity: 200, waterUse: 20, passiveWaterRate: 0 },
    enemyProfiles: [{ id: 'ai1', pushResistance: resistance,
      weapon: { waterCapacity: 100, passiveWaterRate: 0 } },
      { id: 'ai2', weapon: { pushAcceleration: 24, range: 8, waterCapacity: 200, waterUse: 20 } }],
    stage: { levelId: 2, objective: { type: 'eliminate', count: 3 } } }, 31);
  game._aiCommand = () => ({ ...NONE });
  game.start(); game.update(STEP, NONE);
  Object.assign(game.actors[0], { x: 0, y: 0, angle: 0, vx: 0, vy: 0, kx: 0, ky: 0, mx: 0, my: 0 });
  Object.assign(game.actors[1], { x: 2, y: 0, angle: Math.PI, vx: 0, vy: 0, kx: 0, ky: 0, mx: 0, my: 0 });
  game.actors.slice(2).forEach(a => { a.alive = false; });
  return game;
}
const resistances = [1, 1.2, 1.5, 1.8];

test('Real applied water impulses decrease for 1.0 / 1.2 / 1.5 / 1.8 resistance', () => {
  const forces = [];
  for (const resistance of resistances) {
    const game = fixture(resistance); game.update(STEP, { ...NONE, shoot: true });
    const beam = game.beams.find(b => b.actorId === 'p1');
    assert.equal(beam.targetId, 'ai1'); assert.equal(beam.applied, true);
    near(beam.force, 24 / resistance); assert.ok(game.actors[1].kx > 0); forces.push(beam.force);
  }
  assert.ok(forces.every((f, i) => i === 0 || f < forces[i - 1]));
});

test('One second of equal continuous shooting gives progressively less physical displacement and kick', () => {
  const measurements = resistances.map(resistance => {
    const game = fixture(resistance); advance(game, 1, { ...NONE, shoot: true });
    const enemy = game.actors[1];
    assert.equal(game.phase, 'playing'); assert.equal(enemy.alive, true); near(game.timeElapsed, 1);
    near(game.actors[0].water, 180); assert.ok(enemy.hit > 0);
    return { resistance, displacement: enemy.x - 2, kick: enemy.kx, water: enemy.water };
  });
  for (let i = 1; i < measurements.length; i++) {
    assert.ok(measurements[i].displacement < measurements[i - 1].displacement);
    assert.ok(measurements[i].kick < measurements[i - 1].kick);
  }
  assert.ok(measurements[3].displacement < measurements[0].displacement * .7);
  console.log('RESISTANCE_PHYSICS_1_SECOND ' + JSON.stringify(measurements));
});

test('Higher pressure still moves a resistant opponent farther rather than making upgrades cosmetic', () => {
  const games = [24, 35].map(push => {
    const game = fixture(1.8, { push }); advance(game, 1, { ...NONE, shoot: true }); return game;
  });
  assert.ok(games[1].actors[1].x - 2 > (games[0].actors[1].x - 2) * 1.4);
  assert.ok(games[1].actors[1].kx > games[0].actors[1].kx * 1.4);
  near(games[0].actors[0].water, games[1].actors[0].water);
});

test('Three overlapping jets retain one resisted impulse per victim and one trigger water cost', () => {
  const games = [1, 3].map(jets => {
    const game = fixture(1.8, { push: 35, jets }); advance(game, .6, { ...NONE, shoot: true }); return game;
  });
  assert.equal(games[1].beams.filter(b => b.targetId === 'ai1').length, 3);
  assert.equal(games[1].beams.filter(b => b.targetId === 'ai1' && b.applied).length, 1);
  near(games[0].actors[1].x, games[1].actors[1].x); near(games[0].actors[1].kx, games[1].actors[1].kx);
  near(games[0].actors[0].water, games[1].actors[0].water);
});

test('Resistance preserves real hit feedback, hit credit, AI resources, collision size and player attributes', () => {
  const games = [1, 1.8].map(resistance => fixture(resistance));
  assert.deepEqual(games[0].actors[0].weapon, games[1].actors[0].weapon);
  near(games[0].actors[0].kickCap, games[1].actors[0].kickCap);
  near(games[0].actors[1].actorRadius, games[1].actors[1].actorRadius);
  near(games[0].actors[1].enemyProfile.scale, games[1].actors[1].enemyProfile.scale);
  for (const game of games) {
    advance(game, .4, { ...NONE, shoot: true });
    assert.equal(game.actors[1].lastHitBy, 'p1'); assert.ok(game.actors[1].hit > 0);
    assert.ok(game.events.some(e => e.type === 'hit' && e.sourceId === 'p1' && e.actorId === 'ai1'));
    near(game.actors[1].water, 100); near(game.actors[1].stats.shootingTime, 0);
    near(game.actors[0].stats.hitTime, .4); near(game.actors[0].water, 192);
  }
  near(games[0].actors[1].hit, games[1].actors[1].hit);
});

test('Opponent-on-opponent streams obey the same resistance, water use and hit-source rules', () => {
  const games = [1, 1.8].map(resistance => {
    const game = fixture(resistance), shooter = game.actors[2];
    Object.assign(game.actors[0], { x: -4, y: -4 });
    Object.assign(shooter, { alive: true, x: 0, y: 0, angle: 0, kx: 0, ky: 0, mx: 0, my: 0 });
    game._aiCommand = a => ({ ...NONE, shoot: a.id === 'ai2' });
    advance(game, 1); return game;
  });
  for (let i = 0; i < games.length; i++) {
    const game = games[i], beam = game.beams.find(b => b.actorId === 'ai2');
    near(beam.force, 24 / (i ? 1.8 : 1)); assert.equal(beam.applied, true);
    assert.equal(game.actors[1].lastHitBy, 'ai2'); near(game.actors[2].water, 180);
    near(game.actors[0].stats.hitTime, 0); near(game.actors[0].water, 200);
  }
  assert.ok(games[1].actors[1].x < games[0].actors[1].x);
});

test('Increasing AI resistance does not reduce the force applied to the player', () => {
  const games = [1, 1.8].map(resistance => {
    const game = fixture(resistance), shooter = game.actors[2];
    Object.assign(game.actors[0], { x: 2, y: 0 }); Object.assign(game.actors[1], { x: -3, y: 3 });
    Object.assign(shooter, { alive: true, x: 0, y: 0, angle: 0, kx: 0, ky: 0, mx: 0, my: 0 });
    game._aiCommand = a => ({ ...NONE, shoot: a.id === 'ai2' }); advance(game, .5); return game;
  });
  for (const game of games) {
    const beam = game.beams.find(b => b.actorId === 'ai2'); assert.equal(beam.targetId, 'p1');
    near(beam.force, 24 * game.params.playerPushFactor);
  }
  near(games[0].actors[0].x, games[1].actors[0].x); near(games[0].actors[0].kx, games[1].actors[0].kx);
});

test('A resistant opponent at the edge can still be physically knocked off and automatically settle once', () => {
  const game = fixture(1.8, { push: 35 });
  Object.assign(game.actors[0], { x: 3 }); Object.assign(game.actors[1], { x: 6.5 });
  for (let i = 0; i < 180 && game.phase === 'playing'; i++) game.update(STEP, { ...NONE, shoot: true });
  assert.equal(game.actors[1].alive, false); assert.equal(game.phase, 'result');
  assert.equal(game.result.reason, 'all-opponents-out'); assert.equal(game.result.cleared, true);
  assert.equal(game.result.playerEliminations, 1); assert.equal(game.result.aiEliminated, 3);
  const eliminated = game.events.filter(e => e.type === 'elimination' && e.actorId === 'ai1');
  assert.equal(eliminated.length, 1); assert.equal(eliminated[0].sourceId, 'p1');
  assert.equal(game.events.filter(e => e.type === 'result').length, 1);
  const frozen = JSON.stringify(game.getState()); advance(game, 2, { ...NONE, shoot: true });
  assert.equal(JSON.stringify(game.getState()), frozen); assert.equal(game.endCompletedStage(), false);
});

test('Quick play retains normal resistance and finite resource consumption', () => {
  for (const difficulty of ['easy', 'standard']) {
    const game = new Core({ difficulty, seed: 31, params: { countdownDuration: 0 } });
    game._aiCommand = () => ({ ...NONE }); game.start(); game.update(STEP, NONE);
    Object.assign(game.actors[0], { x: 0, y: 0, angle: 0 }); Object.assign(game.actors[1], { x: 2, y: 0 });
    Object.assign(game.actors[2], { x: -3, y: 3 }); Object.assign(game.actors[3], { x: -3, y: -3 });
    const water = game.actors[0].water; game.update(STEP, { ...NONE, shoot: true });
    const beam = game.beams.find(b => b.actorId === 'p1'); near(beam.force, 24);
    assert.equal(beam.targetId, 'ai1'); near(game.actors[1].enemyProfile.pushResistance, 1);
    near(water - game.actors[0].water, game.actors[0].weapon.waterUse * STEP);
  }
});

console.log(`RESULT ${checks} physical-resistance checks passed.`);
