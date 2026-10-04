/** Test actual renderer methods and water geometry without creating a WebGL context. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const sourceRoot = here.endsWith('/work') ? here : path.resolve(here, '..');
const assetRoot = here.endsWith('/work') ? path.resolve(here, '../outputs/water-game-design') : sourceRoot;
const vendorUrl = pathToFileURL(path.join(assetRoot, 'vendor/')).href;
const { default: unused, ...THREE } = await import(vendorUrl + 'three.module.js');
const asModule = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const waterSource = (await readFile(path.join(sourceRoot, 'water-flow.js'), 'utf8')).replaceAll('./vendor/', vendorUrl);
const rendererSource = (await readFile(path.join(sourceRoot, 'renderer_v3.js'), 'utf8'))
  .replaceAll('./vendor/', vendorUrl).replace('./water-flow.js', asModule(waterSource));
globalThis.window ||= {};
const { WaterRenderer, weaponAppearance, stageAppearance } = await import(asModule(rendererSource));
let passed = 0;
function test(name, run) { run(); passed++; console.log('PASS ' + name); }
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
const disposeFlows = renderer => { for (const flow of renderer.beams) flow.dispose(); };
function rendererStub() {
  const r = Object.create(WaterRenderer.prototype);
  Object.assign(r, { scene: new THREE.Scene(), _actors: new Map(), _views: [], fountains: [], _time: 0,
    _receivingWaterHeight: () => .045, _environmentPalette: [], _stageTheme: null,
    particles: { clear() {}, emit() {} }, _fallMist: 0, _random: () => .5 });
  r._buildBeamPool(); return r;
}
const actors = () => [
  { id: 'p1', isPlayer: true, alive: true, weapon: { visualScale: 1.94, tier: 4, jetCount: 3, range: 7 } },
  { id: 'ai1', alive: true }
];
const beam = (actorId, jetIndex, x2, y2, targetId = null) => ({ actorId, jetIndex, x2, y2, targetId });

test('The original nozzle stays .060 while upgrades enlarge water, highlights and splash', () => {
  const basic = weaponAppearance(); close(basic.radius, .060); close(basic.splashScale, 1.25);
  const upgraded = weaponAppearance({ visualScale: 1.94, jetCount: 3, tier: 4 });
  close(upgraded.radius / basic.radius, 1.94);
  assert.ok(upgraded.highlight > 1.6 && upgraded.splashScale > 1.8 && upgraded.upgraded);
  const ai = weaponAppearance({ visualScale: 1 }); close(ai.radius, .060); assert.equal(ai.upgraded, false);
});
test('Invalid upgrade and Boss inputs stay finite and bounded', () => {
  const look = weaponAppearance({ visualScale: Infinity, tier: NaN }, { role: 'boss', enemyProfile: { scale: Infinity } });
  close(look.radius, .060); close(look.bossScale, 1.2);
  close(weaponAppearance({ visualScale: 10 }, { role: 'boss', enemyProfile: { scale: 1.3 } }).bossScale, 1.3);
  close(weaponAppearance({ visualScale: 10 }).radius, .120);
});
test('Each nozzle has stable ownership when actor and beam arrays are reordered', () => {
  const r = rendererStub(), a = actors();
  r._actors.set('p1', { muzzle: new THREE.Vector3(.2, 1, .1) });
  r._actors.set('ai1', { muzzle: new THREE.Vector3(-1, 1, 0) });
  const streams = [beam('p1', 0, 5, 0), beam('p1', 1, 5, 1), beam('p1', 2, 5, -1), beam('ai1', 0, 2, 2)];
  r._updateBeams({ actors: a, beams: streams }, 1 / 60);
  assert.equal(r.beams.length, 4);
  const saved = [...r._beamEmitters.values()].map(entry => ({ entry, origin: entry.flow.origin.clone() }));
  r._updateBeams({ actors: [...a].reverse(), beams: [...streams].reverse() }, 1 / 60);
  assert.equal(r.beams.length, 4);
  for (const { entry, origin } of saved) {
    assert.equal(r._getBeamEmitter(entry.actorId, entry.jetIndex), entry);
    assert.ok(entry.flow.origin.equals(origin));
  }
  const p1 = saved.filter(({ entry }) => entry.actorId === 'p1');
  p1.forEach(({ entry }) => { assert.ok(entry.flow.origin.equals(r._actors.get('p1').muzzle)); close(entry.flow.radius, .1164); });
  close(saved.find(({ entry }) => entry.actorId === 'ai1').entry.flow.radius, .060);
  disposeFlows(r);
});
test('Six logical streams create six emitters, and invalid fourth nozzles allocate nothing', () => {
  const r = rendererStub(), list = [...actors(), { id: 'ai2', alive: true }, { id: 'ai3', alive: true }];
  list.forEach((a, i) => r._actors.set(a.id, { muzzle: new THREE.Vector3(i, 1, 0) }));
  r._updateBeams({ actors: list, beams: [beam('p1', 0, 4, 0), beam('p1', 1, 4, 1), beam('p1', 2, 4, -1),
    beam('ai1', 0, 4, 2), beam('ai2', 0, 4, 3), beam('ai3', 0, 4, 4), beam('p1', 3, 4, 3), beam('missing', 0, 1, 1)] }, 1 / 60);
  assert.equal(r.beams.length, 6); disposeFlows(r);
});
test('Stopped nozzles retain detached water history, then all reset on a new round', () => {
  const r = rendererStub(); r._actors.set('p1', { muzzle: new THREE.Vector3(0, 1, 0) });
  const s = { actors: actors(), beams: [beam('p1', 0, 6, 0)] };
  r._updateBeams(s, 1 / 60); r._updateBeams(s, 1 / 60);
  const flow = r.beams[0], launched = flow.packets.filter(p => p.alive).length;
  assert.ok(launched > 0);
  r._updateBeams({ actors: s.actors, beams: [] }, 1 / 60);
  assert.equal(flow.active, false); assert.ok(flow.packets.some(p => p.alive));
  r._resetRound({ roundId: 2 });
  assert.ok(flow.packets.every(p => !p.alive)); assert.ok(flow.drops.items.every(p => !p.alive));
  assert.equal(flow.active, false); disposeFlows(r);
});
test('Changing the animated muzzle does not drag already emitted water with it', () => {
  const r = rendererStub(), socket = new THREE.Vector3(0, 1, 0); r._actors.set('p1', { muzzle: socket });
  const s = { actors: actors(), beams: [beam('p1', 0, 6, 0)] }; r._updateBeams(s, 1 / 60);
  const packet = r.beams[0].packets.find(p => p.alive), x0 = packet.x0;
  socket.x = 2; r._updateBeams(s, 1 / 60);
  close(packet.x0, x0); assert.ok(packet.x < 1); disposeFlows(r);
});
test('Theme changes alter actual lights, water and local materials, then restore spring exactly', () => {
  const r = rendererStub(), m = new THREE.MeshStandardMaterial({ color: 0x429029, emissive: 0x010101 });
  const initial = m.color.clone();
  r._environmentPalette.push({ material: m, label: 'env_foliage', color: m.color.clone(), emissive: m.emissive.clone() });
  r._lights = { hemi: new THREE.HemisphereLight(), ambient: new THREE.AmbientLight(), sun: new THREE.DirectionalLight(), fill: new THREE.DirectionalLight() };
  r.surfaceMaterial = { uniforms: { uColor: { value: new THREE.Color() } } };
  r.poolMaterial = { uniforms: { uColor: { value: new THREE.Color() }, uOpacity: { value: 0 } } };
  r.scene.background = new THREE.Color();
  const colors = [];
  for (const theme of ['spring', 'sunset', 'lagoon', 'moon']) {
    r._applyStage({ theme }); colors.push(r.poolMaterial.uniforms.uColor.value.getHex());
    close(r._lights.sun.intensity, stageAppearance(theme).sunPower);
    assert.equal(r.scene.background.getHex(), stageAppearance(theme).background);
  }
  assert.equal(new Set(colors).size, 4); assert.equal(m.color.equals(initial), false);
  r._applyStage({ theme: 'spring' }); assert.ok(m.color.equals(initial));
  r._applyStage({ theme: 'moon' }); const once = m.color.clone();
  r._applyStage({ theme: 'moon' }, true); assert.ok(m.color.equals(once));
  r._applyStage({ theme: 'invalid' }); assert.ok(m.color.equals(initial)); m.dispose();
});
test('Fountain IDs follow changed stage locations instead of silently deactivating', () => {
  const r = rendererStub(); r._buildFountains();
  const sources = [{ id: 'center', x: .5, y: -.5, radius: 1.65, active: false },
    { id: 'outer0', x: 3.4, y: 0, radius: 1.5, active: true },
    { id: 'outer1', x: 0, y: 2.2, radius: 1, active: false, preview: true }];
  r._updateFountains({ fountains: sources }, 0);
  const outer = r.fountains.find(f => f.id === 'outer0'); close(outer.root.position.x, 3.4); close(outer.root.position.z, 0);
  close(outer.ring.scale.x, 1.25); assert.equal(outer.active, true);
  const second = r.fountains.find(f => f.id === 'outer1'); close(second.root.position.z, 2.2); assert.equal(second.active, false);
  r.fountains.forEach(f => f.flow.dispose());
});
test('Equipment upgrades preserve the muzzle attachment while Boss identity is visible', () => {
  const r = rendererStub(); r.gunHeight = .98;
  const gun = r._makeWaterGun(new THREE.Color(0x278ee0));
  const socket = new THREE.Object3D(); socket.position.set(0, 0, .35); gun.add(socket);
  const v = { index: 1, root: new THREE.Group(), gun, crown: r._makeBossCrown(), tank: r._makeTank(new THREE.Color(0xf16762)), ring: { material: new THREE.MeshBasicMaterial() } };
  const originalSocket = socket.position.clone(), originalGunScale = gun.scale.clone();
  r._updateEquipment(v, { role: 'boss', enemyProfile: { scale: 1.3 }, weapon: { visualScale: 1.94, tier: 4 } });
  assert.ok(v.crown.visible); close(v.root.scale.x, 1.3); assert.equal(v.ring.material.color.getHex(), 0xffd04f);
  assert.ok(socket.position.equals(originalSocket)); assert.ok(gun.scale.equals(originalGunScale));
  assert.ok(v.tank.root.scale.x > 1.15); assert.equal(gun.userData.upgradeParts.cream.color.getHex(), 0xffd168);
  r._updateEquipment(v, { weapon: {} }); close(v.root.scale.x, 1); assert.equal(v.crown.visible, false);
  close(v.tank.root.scale.x, 1); assert.equal(gun.userData.upgradeParts.cream.color.getHex(), 0xffe7a4);
});
test('A respawn event restores real animation actions and resets only the revived actors streams', () => {
  const r = rendererStub(), model = new THREE.Object3D(), root = new THREE.Group(), pose = new THREE.Group();
  root.add(pose); pose.add(model);
  const mixer = new THREE.AnimationMixer(model), actions = {};
  for (const key of ['idle', 'aim', 'run', 'shoot', 'hit', 'death', 'victory']) {
    const clip = new THREE.AnimationClip(key, 1, [new THREE.VectorKeyframeTrack('.position', [0, 1], [0, 0, 0, 0, .1, 0])]);
    actions[key] = mixer.clipAction(clip); actions[key].setEffectiveWeight(key === 'death' ? 1 : 0).play();
  }
  actions.death.setLoop(THREE.LoopOnce, 1); actions.death.clampWhenFinished = true; mixer.update(.5);
  const muzzleObject = new THREE.Object3D(); muzzleObject.position.set(0, 1, .35); root.add(muzzleObject);
  const v = { id: 'ai1', root, pose, model, mixer, actions, muzzleObject, muzzle: new THREE.Vector3(),
    ring: { visible: false }, outerRing: null, shadow: { visible: false }, gun: { visible: false }, tank: { root: { visible: false } },
    alive: false, falling: { start: 0 }, fullState: 'death', spawnVersion: 0, previous: { x: 8, y: 0 },
    lean: new THREE.Vector3(.1, 0, -.1), moveWeight: 1, shotWeight: 1, lastShoot: true, hitAt: 1, lastHit: 1 };
  r._actors.set('ai1', v);
  const a = { id: 'ai1', alive: true, x: 1, y: -2, angle: .4, spawnVersion: 1 };
  const bossStreams = [r._getBeamEmitter('ai1', 0), r._getBeamEmitter('ai1', 1)];
  const otherStream = r._getBeamEmitter('p1', 0);
  const start = new THREE.Vector3(0, 1, 0), end = new THREE.Vector3(6, 1, 0);
  for (const entry of [...bossStreams, otherStream]) { entry.flow.setEmission(true, start, end); entry.flow.update(1 / 60); }
  const otherPacket = otherStream.flow.packets.find(p => p.alive), otherAge = otherPacket.age;
  r._event({ actors: [a] }, { type: 'respawn', actorId: 'ai1' });
  assert.equal(v.falling, null); assert.equal(v.fullState, null); assert.equal(v.previous, null);
  assert.equal(v.alive, true); assert.equal(v.spawnVersion, 1); assert.equal(v.aimState, 'aim');
  close(v.moveWeight, 0); close(v.shotWeight, 0); close(v.lean.length(), 0);
  close(root.position.x, 1); close(root.position.y, .035); close(root.position.z, -2);
  assert.ok(root.visible && v.ring.visible && v.shadow.visible && v.gun.visible && v.tank.root.visible);
  assert.equal(actions.death.isRunning(), false); close(actions.death.getEffectiveWeight(), 0);
  assert.equal(actions.idle.isRunning(), true); assert.equal(actions.aim.isRunning(), true);
  close(actions.idle.getEffectiveWeight(), 1); close(actions.aim.getEffectiveWeight(), 1);
  bossStreams.forEach(({ flow }) => { assert.equal(flow.active, false); assert.ok(flow.packets.every(p => !p.alive)); });
  assert.ok(otherPacket.alive); close(otherPacket.age, otherAge); assert.equal(otherStream.flow.active, true);
  // A notification or a terminal elimination is never a visual resurrection.
  a.alive = false; v.falling = { start: 2 }; v.fullState = 'death';
  r._event({ actors: [a] }, { type: 'respawn', actorId: 'ai1' });
  r._event({ actors: [a] }, { type: 'boss-round', actorId: 'ai1' });
  assert.ok(v.falling); assert.equal(v.fullState, 'death'); disposeFlows(r);
});
console.log(`${passed} visual behavior checks passed (no WebGL context created)`);
