import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function readNearby(name) {
  for (const prefix of ['./', '../', './source/']) {
    try { return await readFile(new URL(prefix + name, import.meta.url), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw Error(name + ' was not found');
}
const asModule = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const { TouchControls } = await import(asModule(await readNearby('touch-controls.js')));
const { resolveAim } = await import(asModule(await readNearby('player-controls.js')));
const context = { module: { exports: {} } };
vm.runInNewContext(await readNearby('gameplay.js'), context);
const WaterGameCore = context.module.exports;
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
class FakeTarget {
  constructor(rect = {}) {
    this.handlers = new Map(); this.captured = new Set(); this.style = {}; this.attributes = {};
    this.rect = { left: 0, top: 0, width: 120, height: 120, ...rect };
    const names = new Set(); this.classList = { add: name => names.add(name), remove: name => names.delete(name),
      contains: name => names.has(name), toggle: (name, on) => on ? names.add(name) : names.delete(name) };
  }
  addEventListener(type, listener) { if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type).add(listener); }
  removeEventListener(type, listener) { this.handlers.get(type)?.delete(listener); }
  dispatch(type, data = {}) {
    const event = { type, pointerId: 1, pointerType: 'touch', button: 0, clientX: 60, clientY: 60,
      defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...data };
    for (const listener of this.handlers.get(type) || []) listener(event);
    return event;
  }
  getBoundingClientRect() { return this.rect; }
  setPointerCapture(id) { this.captured.add(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
  releasePointerCapture(id) {
    this.captured.delete(id); this.dispatch('lostpointercapture', { pointerId: id });
  }
  setAttribute(name, value) { this.attributes[name] = value; }
}
function fixture({ active = true, coarse = false } = {}) {
  const doc = new FakeTarget(), win = new FakeTarget(), media = new FakeTarget();
  media.matches = coarse; win.matchMedia = () => media; doc.defaultView = win;
  const stick = new FakeTarget(), knob = new FakeTarget({ width: 40, height: 40 }), fire = new FakeTarget();
  stick.ownerDocument = fire.ownerDocument = doc;
  const f = { stick, knob, fire, doc, win, media, active, unlocks: 0, enables: 0 };
  f.controls = new TouchControls({ stick, knob, fire, isActive: () => f.active,
    onInteract: () => f.unlocks++, onEnable: () => f.enables++ });
  return f;
}

test('Fixed joystick has a quiet center, smooth deadzone, and a unit circular limit', () => {
  const f = fixture(); f.stick.dispatch('pointerdown', { pointerId: 11 });
  f.stick.dispatch('pointermove', { pointerId: 11, clientX: 63, clientY: 60 });
  close(f.controls.snapshot().moveX, 0);
  f.stick.dispatch('pointermove', { pointerId: 11, clientX: 80, clientY: 60 });
  const half = f.controls.snapshot(); assert.ok(half.moveX > .3 && half.moveX < .5); close(half.moveY, 0);
  f.stick.dispatch('pointermove', { pointerId: 11, clientX: 600, clientY: -600 });
  const diagonal = f.controls.snapshot(); close(Math.hypot(diagonal.moveX, diagonal.moveY), 1);
  assert.ok(diagonal.moveX > 0 && diagonal.moveY < 0); assert.ok(f.stick.hasPointerCapture(11)); f.controls.destroy();
});
test('Two fingers move and fire together, and releasing movement does not stop fire', () => {
  const f = fixture(); f.stick.dispatch('pointerdown', { pointerId: 11, clientX: 100 });
  f.fire.dispatch('pointerdown', { pointerId: 22 });
  assert.equal(f.controls.snapshot().shoot, true); assert.ok(f.controls.snapshot().moveX > .9);
  const release = f.doc.dispatch('pointerup', { pointerId: 11 });
  close(f.controls.snapshot().moveX, 0); assert.equal(f.controls.snapshot().shoot, true);
  assert.equal(release.defaultPrevented, false); assert.ok(f.fire.hasPointerCapture(22));
  f.doc.dispatch('pointerup', { pointerId: 22 }); assert.equal(f.controls.snapshot().shoot, false); f.controls.destroy();
});
test('Releasing fire preserves movement; unrelated and duplicate fingers cannot steal controls', () => {
  const f = fixture(); f.stick.dispatch('pointerdown', { pointerId: 11, clientX: 100 });
  f.stick.dispatch('pointerdown', { pointerId: 33, clientX: 0 });
  f.fire.dispatch('pointerdown', { pointerId: 11 }); assert.equal(f.controls.snapshot().shoot, false);
  f.fire.dispatch('pointerdown', { pointerId: 22 }); f.fire.dispatch('pointerdown', { pointerId: 44 });
  f.doc.dispatch('pointerup', { pointerId: 44 }); assert.equal(f.controls.snapshot().shoot, true);
  f.fire.dispatch('pointerup', { pointerId: 22 }); assert.equal(f.controls.snapshot().shoot, false);
  assert.ok(f.controls.snapshot().moveX > .9); assert.equal(f.unlocks, 2); f.controls.destroy();
});
test('Cancel and lost capture clear only their owning finger', () => {
  const f = fixture(); f.stick.dispatch('pointerdown', { pointerId: 11, clientX: 100 }); f.fire.dispatch('pointerdown', { pointerId: 22 });
  f.stick.dispatch('lostpointercapture', { pointerId: 11 }); close(f.controls.snapshot().moveX, 0);
  assert.equal(f.controls.snapshot().shoot, true);
  f.fire.dispatch('pointercancel', { pointerId: 22 }); assert.equal(f.controls.snapshot().shoot, false);
  assert.equal(f.fire.classList.contains('active'), false); f.controls.destroy();
});
test('Paused, menu and eliminated-player states reject input and clear an existing hold', () => {
  const f = fixture({ active: false }); f.stick.dispatch('pointerdown', { clientX: 100 }); f.fire.dispatch('pointerdown', { pointerId: 2 });
  assert.deepEqual(f.controls.snapshot(), { moveX: 0, moveY: 0, shoot: false }); assert.equal(f.unlocks, 0);
  f.active = true; f.fire.dispatch('pointerdown', { pointerId: 2 }); assert.equal(f.controls.snapshot().shoot, true);
  f.active = false; assert.deepEqual(f.controls.snapshot(), { moveX: 0, moveY: 0, shoot: false });
  f.active = true; assert.equal(f.controls.snapshot().shoot, false); f.controls.destroy();
});
test('Reset, window blur, resize and background visibility never leave held inputs', () => {
  for (const end of [f => f.controls.reset(), f => f.win.dispatch('blur'), f => f.win.dispatch('resize'), f => f.win.dispatch('pagehide'), f => f.win.dispatch('orientationchange'), f => { f.doc.hidden = true; f.doc.dispatch('visibilitychange'); }]) {
    const f = fixture(); f.stick.dispatch('pointerdown', { clientX: 100 }); f.fire.dispatch('pointerdown', { pointerId: 2 }); end(f);
    assert.deepEqual(f.controls.snapshot(), { moveX: 0, moveY: 0, shoot: false });
    assert.equal(f.stick.captured.size + f.fire.captured.size, 0); f.controls.destroy();
  }
});
test('Touch, pen and coarse-pointer detection reveal controls once without canceling menu taps', () => {
  const f = fixture({ active: false }); const event = f.doc.dispatch('pointerdown', { pointerType: 'pen' });
  f.doc.dispatch('pointerdown', { pointerType: 'touch' }); assert.equal(f.enables, 1); assert.equal(event.defaultPrevented, false);
  f.controls.destroy(); const coarse = fixture({ coarse: true }); assert.equal(coarse.enables, 1); coarse.controls.destroy();
});
test('The fire button supports held Space and Enter without repeat or key-release conflicts', () => {
  const f = fixture(); const down = f.fire.dispatch('keydown', { key: ' ', code: 'Space' });
  f.fire.dispatch('keydown', { key: ' ', code: 'Space', repeat: true }); assert.equal(f.unlocks, 1);
  assert.equal(down.defaultPrevented, true); assert.equal(f.controls.snapshot().shoot, true);
  f.fire.dispatch('keydown', { key: 'Enter' }); f.fire.dispatch('keyup', { key: ' ', code: 'Space' });
  assert.equal(f.controls.snapshot().shoot, true); f.fire.dispatch('keyup', { key: 'Enter' });
  assert.equal(f.controls.snapshot().shoot, false);
  f.fire.dispatch('keydown', { key: 'Enter' }); f.fire.dispatch('blur'); assert.equal(f.controls.snapshot().shoot, false); f.controls.destroy();
});
test('Non-finite movement, right clicks and destroyed controls cannot produce stuck or invalid input', () => {
  const f = fixture(); f.stick.dispatch('pointerdown', { clientX: NaN }); f.fire.dispatch('pointerdown', { button: 2 });
  assert.deepEqual(f.controls.snapshot(), { moveX: 0, moveY: 0, shoot: false });
  f.stick.dispatch('pointerdown', { clientX: 100 }); f.stick.dispatch('pointermove', { clientX: Infinity });
  assert.ok(Number.isFinite(f.controls.snapshot().moveX)); f.controls.destroy();
  f.fire.dispatch('pointerdown', { pointerId: 2 }); assert.deepEqual(f.controls.snapshot(), { moveX: 0, moveY: 0, shoot: false });
  assert.ok([...f.fire.handlers.values(), ...f.stick.handlers.values(), ...f.doc.handlers.values(), ...f.win.handlers.values()].every(set => set.size === 0));
});
test('Real gameplay plus resolveAim receives simultaneous movement and aimed spray, then stops after release', () => {
  const game = new WaterGameCore({ difficulty: 'standard', params: { countdownDuration: 0, arenaRadius: 100 } });
  game._aiCommand = () => ({ moveX: 0, moveY: 0, aimX: 0, aimY: 0, shoot: false });
  game.start(); game.update(1 / 60, {});
  const positions = [[0, 0], [3, 0], [-20, 0], [0, -20]];
  game.actors.forEach((a, index) => { a.x = positions[index][0]; a.y = positions[index][1]; a.angle = 0; a.kx = a.ky = a.vx = a.vy = 0; });
  const f = fixture(); f.controls.isActive = () => game.phase === 'playing' && game.actors[0].alive;
  f.stick.dispatch('pointerdown', { pointerId: 11, clientX: 100 }); f.fire.dispatch('pointerdown', { pointerId: 22 });
  function advance() {
    const input = f.controls.snapshot(), aim = resolveAim(game.getState(), { auto: input.shoot });
    game.update(1 / 60, { ...input, ...aim }); return aim;
  }
  for (let index = 0; index < 12; index++) assert.equal(advance().targetId, 'ai1');
  assert.ok(game.actors[0].x > .2); assert.ok(game.actors[0].water < 100);
  assert.equal(game.actors[0].shooting, true); assert.ok(game.beams.some(b => b.actorId === 'p1' && b.targetId === 'ai1'));
  assert.ok(game.actors[1].kx > 0);
  f.doc.dispatch('pointerup', { pointerId: 22 }); advance();
  assert.equal(game.actors[0].shooting, false); assert.ok(game.beams.every(b => b.actorId !== 'p1'));
  assert.ok(f.controls.snapshot().moveX > .9);
  f.doc.dispatch('pointerup', { pointerId: 11 }); assert.deepEqual(f.controls.snapshot(), { moveX: 0, moveY: 0, shoot: false });
  f.controls.destroy();
});
console.log(`${passed} touch input checks passed, including real gameplay / aim integration`);
