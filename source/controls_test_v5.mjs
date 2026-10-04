import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Also works from the downloadable project's source/ directory.
let source;
for (const relative of ['./player-controls.js', '../player-controls.js']) {
  try { source = await readFile(new URL(relative, import.meta.url), 'utf8'); break; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (!source) throw new Error('player-controls.js was not found beside the test or at the project root');
const { resolveAim } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
let passed = 0;
function test(name, run) { run(); passed++; console.log('PASS ' + name); }
const actor = (id, x, y, options = {}) => ({ id, x, y, alive: true, angle: 0, ...options });
const state = others => ({
  params: { range: 5, muzzleOffset: .35, actorRadius: .35 },
  actors: [actor('p1', 0, 0, { isPlayer: true }), ...others]
});
// A shallow camera raises bodies in screen Y. A floor ray through their torso
// would land behind them; this is the real source of the original aim mismatch.
const project = (x, y, height) => ({ x: 300 + x * 50, y: 300 + y * 30 - height * 35 });
const screenToWorld = (x, y) => ({ x: (x - 300) / 50, y: (y - 300) / 30 });
const pointerAt = (x, y, height = 1.1) => ({ ...project(x, y, height), valid: true });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const finiteUnit = result => {
  assert.ok(Number.isFinite(result.aimX) && Number.isFinite(result.aimY));
  close(Math.hypot(result.aimX, result.aimY), 1);
};

test('Aiming at a body corrects floor-ray parallax toward its actual position', () => {
  const s = state([actor('ai1', 2, 2)]);
  const options = { pointer: pointerAt(2, 2), project, screenToWorld };
  const aim = resolveAim(s, options);
  assert.equal(aim.targetId, 'ai1'); close(aim.aimX, Math.SQRT1_2); close(aim.aimY, Math.SQRT1_2);
  const manual = resolveAim(s, { ...options, assist: false });
  assert.equal(manual.targetId, null);
  assert.ok(Math.abs(manual.aimY - aim.aimY) > .2);
});
test('A cursor clearly outside the body region keeps free aim', () => {
  const s = state([actor('ai1', 2, 2)]);
  const aim = resolveAim(s, { pointer: { x: 500, y: 260, valid: true }, project, screenToWorld });
  assert.equal(aim.targetId, null); assert.ok(aim.aimX > .9); assert.ok(aim.aimY < 0);
});
test('Manual assistance selects the opponent under the cursor, not the nearest opponent', () => {
  const s = state([actor('near', -.6, 0), actor('under-cursor', 3, 1)]);
  const aim = resolveAim(s, { pointer: pointerAt(3, 1), project, screenToWorld });
  assert.equal(aim.targetId, 'under-cursor'); close(aim.aimY / aim.aimX, 1 / 3);
});
test('Auto fire targets the nearest living opponent without a mouse pointer', () => {
  const s = state([actor('far', 4, 0), actor('near', 0, 2), actor('dead', .1, 0, { alive: false })]);
  const aim = resolveAim(s, { auto: true });
  assert.equal(aim.targetId, 'near'); close(aim.aimX, 0); close(aim.aimY, 1);
});
test('Auto fire can reach a collision circle at the existing muzzle-plus-range limit', () => {
  const s = state([actor('edge', 5.69, 0), actor('beyond', 5.71, 0)]);
  const aim = resolveAim(s, { auto: true });
  assert.equal(aim.targetId, 'edge');
});
test('Auto fire does not aim at out-of-range or eliminated actors', () => {
  const s = state([actor('beyond', 6, 0), actor('dead', 0, 1, { alive: false })]);
  s.actors[0].angle = Math.PI / 2;
  const aim = resolveAim(s, { auto: true, pointer: pointerAt(6, 0), project, screenToWorld });
  assert.equal(aim.targetId, null); close(aim.aimX, 0); close(aim.aimY, 1);
});
test('Manual assistance also excludes eliminated and out-of-range bodies', () => {
  for (const opponent of [actor('dead', 2, 0, { alive: false }), actor('far', 6, 0)]) {
    const aim = resolveAim(state([opponent]), { pointer: pointerAt(opponent.x, opponent.y), project, screenToWorld });
    assert.equal(aim.targetId, null); finiteUnit(aim);
  }
});
test('Screen tolerance shrinks with smaller rendered characters', () => {
  const s = state([actor('ai1', 2, 0)]);
  const smallProject = (x, y, height) => ({ x: 300 + x * 20, y: 300 + y * 20 - height * 12 });
  const center = smallProject(2, 0, 1.1);
  const aim = resolveAim(s, { pointer: { x: center.x + 35, y: center.y, valid: true }, project: smallProject, screenToWorld });
  assert.equal(aim.targetId, null);
});
test('Invalid pointers preserve the actor facing instead of turning toward screen origin', () => {
  const s = state([actor('ai1', 0, 1)]); s.actors[0].angle = -.7;
  for (const pointer of [null, { x: 0, y: 0, valid: false }, { x: NaN, y: 0, valid: true }]) {
    const aim = resolveAim(s, { pointer, project, screenToWorld });
    assert.equal(aim.targetId, null); close(aim.aimX, Math.cos(-.7)); close(aim.aimY, Math.sin(-.7));
  }
});
test('An invalid camera projection falls back to the valid free aim', () => {
  const aim = resolveAim(state([actor('ai1', 2, 2)]), {
    pointer: pointerAt(2, 2), project: () => ({ x: NaN, y: 0 }), screenToWorld
  });
  assert.equal(aim.targetId, null); finiteUnit(aim);
});
test('Overlapping targets, zero floor direction and failing cameras never produce NaN', () => {
  const s = state([actor('same-position', 0, 0)]);
  for (const options of [
    { auto: true },
    { pointer: { x: 300, y: 300, valid: true }, project, screenToWorld },
    { pointer: pointerAt(1, 1), project: () => { throw Error('camera unavailable'); }, screenToWorld: () => { throw Error('no plane'); } }
  ]) {
    const aim = resolveAim(s, options); assert.equal(aim.targetId, null); finiteUnit(aim);
  }
});
test('Eliminated players and missing states cannot acquire a target', () => {
  const s = state([actor('ai1', 0, 1)]); s.actors[0].alive = false;
  for (const input of [s, null, {}]) {
    const aim = resolveAim(input, { auto: true }); assert.equal(aim.targetId, null); finiteUnit(aim);
  }
});
test('Resolving aim leaves the gameplay state intact', () => {
  const s = state([actor('ai1', 1, 1)]), before = JSON.stringify(s);
  resolveAim(s, { pointer: pointerAt(1, 1), project, screenToWorld });
  resolveAim(s, { auto: true });
  assert.equal(JSON.stringify(s), before);
});
test('Auto aiming uses the upgraded player range without increasing rival range', () => {
  const game = state([actor('ai1', 7, 0)]);
  assert.equal(resolveAim(game, { auto: true }).targetId, null);
  game.actors[0].weapon = { range: 7.7 };
  assert.equal(resolveAim(game, { auto: true }).targetId, 'ai1');
  assert.equal(game.params.range, 5);
});
console.log(`${passed} controls checks passed`);
