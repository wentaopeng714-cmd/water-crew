/** Verify real Three.js equipment/stream objects from campaign-to-core weapons. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.basename(here) === 'work' ? here : path.resolve(here, '..');
const assetRoot = path.basename(here) === 'work' ? path.resolve(here, '../outputs/water-game-design') : sourceRoot;
const vendorUrl = pathToFileURL(path.join(assetRoot, 'vendor/')).href;
const THREE = await import(vendorUrl + 'three.module.js');
const asModule = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const waterSource = (await readFile(path.join(sourceRoot, 'water-flow.js'), 'utf8')).replaceAll('./vendor/', vendorUrl);
const rendererSource = (await readFile(path.join(sourceRoot, 'renderer_v3.js'), 'utf8'))
  .replaceAll('./vendor/', vendorUrl).replace('./water-flow.js', asModule(waterSource));
const campaignSource = await readFile(path.join(sourceRoot, 'campaign.js'), 'utf8');
globalThis.window ||= {};
const { WaterRenderer, weaponAppearance } = await import(asModule(rendererSource));
const { Campaign, UPGRADE_DEFINITIONS } = await import(asModule(campaignSource));
// Build copies the UMD core beside the tests, under source/package.json's
// CommonJS scope even when the public game's package is type:module.
const Core = createRequire(import.meta.url)('./gameplay.js');
const STEP = 1 / 60;
const NONE = { moveX: 0, moveY: 0, aimX: 1, aimY: 0, shoot: false };
const campaign = new Campaign({ storage: { getItem() { return null; }, setItem() {} } });
let checks = 0;
function test(name, run) { run(); checks++; console.log('PASS ' + name); }
function near(a, b, tolerance = 1e-7) { assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`); }
function advance(game, seconds, input = NONE) {
  for (let i = 0; i < Math.round(seconds / STEP); i++) game.update(STEP, input);
}
function rendererStub() {
  const renderer = Object.create(WaterRenderer.prototype);
  Object.assign(renderer, { scene: new THREE.Scene(), _actors: new Map(), _views: [], fountains: [],
    _time: 0, gunHeight: .98, _receivingWaterHeight: () => .045,
    particles: { clear() {}, emit() {} }, _random: () => .5 });
  renderer._buildBeamPool(); return renderer;
}
function equipment(renderer, index = 1) {
  const root = new THREE.Group(), pose = new THREE.Group(), model = new THREE.Object3D();
  root.add(pose); pose.add(model);
  const color = new THREE.Color(0xf16762), gun = renderer._makeWaterGun(color);
  root.add(gun);
  const tank = renderer._makeTank(color), crown = renderer._makeBossCrown();
  root.add(tank.root); root.add(crown);
  const muzzleObject = new THREE.Object3D(); muzzleObject.position.set(0, 0, .35); gun.add(muzzleObject);
  return { index, root, pose, gun, tank, crown, muzzleObject, muzzle: new THREE.Vector3(),
    ring: { visible: true, material: new THREE.MeshBasicMaterial() }, shadow: { visible: true },
    mixer: new THREE.AnimationMixer(model), actions: {}, lean: new THREE.Vector3(), spawnVersion: 0 };
}
function gameFor(levelId, config = campaign.getLevelConfig(levelId)) {
  const game = new Core({ seed: 29 });
  game.configureRound({ ...config, params: { ...config.params, countdownDuration: 0 } }, 29);
  game._aiCommand = () => ({ ...NONE }); game.start(); game.update(STEP, NONE);
  return game;
}
function dispose(renderer) {
  for (const flow of renderer.beams) flow.dispose();
  for (const view of renderer._views) view.root.traverse(node => {
    if (node.geometry) node.geometry.dispose();
    if (node.material?.dispose) node.material.dispose();
  });
}

test('Chapter AI upgrades enlarge actual muzzle and backpack meshes and add pump tier lights', () => {
  const renderer = rendererStub(), view = equipment(renderer), readings = [];
  renderer._views.push(view);
  const socketPosition = view.muzzleObject.position.clone(), gunScale = view.gun.scale.clone();
  for (const id of [1, 4, 7, 10]) {
    const ai = gameFor(id).actors[2];
    renderer._updateEquipment(view, ai);
    const parts = view.gun.userData.upgradeParts;
    readings.push({ level: id, tier: ai.weapon.tier, barrel: parts.barrel.scale.x,
      lip: parts.lip.scale.x, tank: view.tank.root.scale.x,
      lights: parts.indicators.filter(dot => dot.visible).length,
      ringGlow: parts.rim.emissiveIntensity, metal: parts.cream.metalness });
    assert.ok(view.muzzleObject.position.equals(socketPosition));
    assert.ok(view.gun.scale.equals(gunScale)); assert.equal(view.crown.visible, false);
  }
  assert.deepEqual(readings.map(r => r.lights), [0, 1, 2, 3]);
  for (let i = 1; i < readings.length; i++) {
    assert.ok(readings[i].barrel > readings[i - 1].barrel);
    assert.ok(readings[i].lip > readings[i - 1].lip);
    assert.ok(readings[i].tank > readings[i - 1].tank);
  }
  assert.ok(readings[3].ringGlow > readings[0].ringGlow); assert.ok(readings[3].metal > readings[0].metal);
  console.log('AI_RENDERED_EQUIPMENT ' + JSON.stringify(readings)); dispose(renderer);
});

test('Boss models receive the next gun tier early and keep their independent crown and body silhouette', () => {
  const renderer = rendererStub(), bossView = equipment(renderer), rivalView = equipment(renderer, 2);
  renderer._views.push(bossView, rivalView);
  for (const id of [3, 6, 9, 12]) {
    const game = gameFor(id), boss = game.actors[1], rival = game.actors[2];
    renderer._updateEquipment(bossView, boss); renderer._updateEquipment(rivalView, rival);
    assert.ok(bossView.tank.root.scale.x > rivalView.tank.root.scale.x);
    assert.ok(bossView.gun.userData.upgradeParts.lip.scale.x > rivalView.gun.userData.upgradeParts.lip.scale.x);
    assert.equal(bossView.crown.visible, true); assert.equal(rivalView.crown.visible, false);
    assert.ok(bossView.root.scale.x > 1); near(rivalView.root.scale.x, 1);
  }
  dispose(renderer);
});

test('Real late Boss rays produce three independent upgraded water emitters from the equipment muzzle', () => {
  const renderer = rendererStub(), view = equipment(renderer), game = gameFor(12), boss = game.actors[1];
  renderer._views.push(view); renderer._actors.set(boss.id, view); renderer._updateEquipment(view, boss);
  view.root.updateMatrixWorld(true); view.muzzleObject.getWorldPosition(view.muzzle);
  Object.assign(boss, { x: 0, y: 0, angle: 0 });
  Object.assign(game.actors[0], { x: -3, y: -3 }); Object.assign(game.actors[2], { x: -3, y: 3 });
  Object.assign(game.actors[3], { x: -4, y: 0 });
  game._aiCommand = a => ({ ...NONE, shoot: a.id === boss.id }); game.update(STEP, NONE);
  const rays = game.beams.filter(beam => beam.actorId === boss.id);
  assert.equal(rays.length, 3); renderer._updateBeams(game.getState(), STEP);
  const entries = [...renderer._beamEmitters.values()].filter(entry => entry.actorId === boss.id);
  assert.equal(entries.length, 3); assert.deepEqual(entries.map(entry => entry.jetIndex), [0, 1, 2]);
  const look = weaponAppearance(boss.weapon, boss), firstLook = weaponAppearance(gameFor(1).actors[1].weapon);
  assert.ok(look.radius > firstLook.radius * 1.5); assert.ok(look.splashScale > firstLook.splashScale);
  for (const entry of entries) {
    assert.equal(entry.flow.active, true); near(entry.flow.radius, look.radius);
    near(entry.flow.splashScale, look.splashScale); near(entry.flow.mesh.material.uniforms.uPower.value, look.highlight);
    assert.ok(entry.flow.origin.equals(view.muzzle)); assert.ok(entry.flow.packets.some(packet => packet.alive));
  }
  dispose(renderer);
});

test('Upgraded Boss equipment and stream size survive real round defeat and respawn without downgrade', () => {
  const renderer = rendererStub(), view = equipment(renderer), game = gameFor(12), boss = game.actors[1];
  renderer._views.push(view); renderer._actors.set(boss.id, view);
  renderer._updateEquipment(view, boss);
  const weapon = boss.weapon, snapshot = JSON.stringify(weapon), barrelScale = view.gun.userData.upgradeParts.barrel.scale.x;
  const tankScale = view.tank.root.scale.x, look = weaponAppearance(weapon, boss);
  const entry = renderer._getBeamEmitter(boss.id, 2);
  entry.flow.setEmission(true, new THREE.Vector3(0, 1, 0), new THREE.Vector3(5, 1, 0)); entry.flow.update(STEP);
  Object.assign(game.actors[0], { x: 0, y: 0 }); Object.assign(boss, { x: 7.2, y: 0 });
  Object.assign(game.actors[2], { x: -3, y: 3 }); Object.assign(game.actors[3], { x: -3, y: -3 });
  advance(game, .1); assert.equal(boss.alive, false); assert.equal(game.phase, 'playing');
  advance(game, 1.3); assert.equal(boss.alive, true); assert.equal(boss.spawnVersion, 1);
  assert.equal(boss.weapon, weapon); assert.equal(JSON.stringify(boss.weapon), snapshot);
  const event = game.events.find(e => e.type === 'respawn' && e.actorId === boss.id);
  assert.ok(event); renderer._event(game.getState(), event); renderer._updateEquipment(view, boss);
  near(view.gun.userData.upgradeParts.barrel.scale.x, barrelScale); near(view.tank.root.scale.x, tankScale);
  assert.equal(view.crown.visible, true); assert.equal(view.gun.visible, true); assert.equal(view.tank.root.visible, true);
  assert.ok(entry.flow.packets.every(packet => !packet.alive));
  near(weaponAppearance(boss.weapon, boss).radius, look.radius); near(boss.water, weapon.waterCapacity);
  dispose(renderer);
});

test('Player purchases do not secretly enlarge an AI gun or its rendered water', () => {
  const values = new Map(), shop = new Campaign({ storage: {
    getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value)
  } });
  // This is a unit-test save fixture, never browser state or the user's save.
  const rich = new Campaign({ storage: { getItem() { return JSON.stringify({ version: 1, coins: 5000 }); }, setItem() {} } });
  for (const definition of UPGRADE_DEFINITIONS) for (let rank = 0; rank < definition.maxRank; rank++) {
    assert.equal(rich.purchaseUpgrade(definition.id).success, true);
  }
  const renderer = rendererStub(), a = equipment(renderer), b = equipment(renderer);
  renderer._views.push(a, b);
  const ordinary = gameFor(10, shop.getLevelConfig(10)).actors[2], purchased = gameFor(10, rich.getLevelConfig(10)).actors[2];
  renderer._updateEquipment(a, ordinary); renderer._updateEquipment(b, purchased);
  assert.deepEqual(ordinary.weapon, purchased.weapon);
  near(a.gun.userData.upgradeParts.barrel.scale.x, b.gun.userData.upgradeParts.barrel.scale.x);
  near(a.tank.root.scale.x, b.tank.root.scale.x);
  near(weaponAppearance(ordinary.weapon).radius, weaponAppearance(purchased.weapon).radius);
  dispose(renderer);
});

test('All four triple-jet guns retain distinct emitter ownership when the beam order changes', () => {
  const renderer = rendererStub(), config = campaign.getLevelConfig(10);
  config.playerWeapon = { ...campaign.getMaxWeapon() };
  const game = gameFor(10, config);
  const positions = [[0, -3], [-3, 0], [0, 3], [3, 0]];
  game.actors.forEach((actor, i) => {
    Object.assign(actor, { x: positions[i][0], y: positions[i][1], angle: i * Math.PI / 2 });
    renderer._actors.set(actor.id, { muzzle: new THREE.Vector3(actor.x, 1, actor.y) });
  });
  game._aiCommand = a => ({ ...NONE, aimX: Math.cos(a.angle), aimY: Math.sin(a.angle), shoot: true });
  game.update(STEP, { ...NONE, shoot: true }); assert.equal(game.beams.length, 12);
  renderer._updateBeams(game.getState(), STEP); assert.equal(renderer._beamEmitters.size, 12);
  const emitters = new Map(renderer._beamEmitters);
  renderer._updateBeams({ ...game.getState(), actors: [...game.actors].reverse(), beams: [...game.beams].reverse() }, STEP);
  for (const [key, entry] of emitters) {
    assert.equal(renderer._beamEmitters.get(key), entry); assert.equal(entry.flow.active, true);
    near(entry.flow.radius, weaponAppearance(game.actors.find(a => a.id === entry.actorId).weapon).radius);
  }
  dispose(renderer);
});

console.log(`RESULT ${checks} real AI-equipment / water-rendering checks passed (no WebGL context created).`);
