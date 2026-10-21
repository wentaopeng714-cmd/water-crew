/** Load the delivered skinned GLB and test actual preview methods without WebGL. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const sourceRoot = here.endsWith('/work') ? here : path.resolve(here, '..');
const assetRoot = here.endsWith('/work') ? path.resolve(here, '../outputs/water-game-design') : sourceRoot;
const vendorUrl = pathToFileURL(path.join(assetRoot, 'vendor/')).href;
const THREE = await import(vendorUrl + 'three.module.js');
const { GLTFLoader } = await import(vendorUrl + 'addons/loaders/GLTFLoader.js');
const asModule = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const waterUrl = asModule((await readFile(path.join(sourceRoot, 'water-flow.js'), 'utf8')).replaceAll('./vendor/', vendorUrl));
const rendererUrl = asModule((await readFile(path.join(sourceRoot, 'renderer_v3.js'), 'utf8'))
  .replaceAll('./vendor/', vendorUrl).replace('./water-flow.js', waterUrl));
const viewerUrl = asModule((await readFile(path.join(sourceRoot, 'character-viewer-v3.js'), 'utf8'))
  .replaceAll('./vendor/', vendorUrl).replace('./water-flow.js', waterUrl).replace('./renderer_v3.js', rendererUrl));
globalThis.window ||= {};
const { CharacterViewer } = await import(viewerUrl);
const { weaponAppearance } = await import(rendererUrl);
globalThis.self = globalThis;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
globalThis.ProgressEvent = class { constructor(type, data) { this.type=type; Object.assign(this,data); } };
const buffer = await readFile(path.join(assetRoot, 'assets/pokemon/007.glb'));
const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), '', resolve, reject));
let passed = 0;
function test(name, run) { run(); passed++; console.log('PASS ' + name); }
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
const v = Object.create(CharacterViewer.prototype);
Object.assign(v, {
  scene: new THREE.Scene(), stage: new THREE.Group(), camera: new THREE.PerspectiveCamera(32),
  canvas: { getBoundingClientRect: () => ({ width: 420, height: 520 }) },
  renderer: { setSize() {}, render() {}, dispose() {} }, _motion: 'idle', _lastTime: null,
  _motionAge: 0, _actions: new Map(), _currentAction: null, _rootMotion: [],
  _overlayBone: null, _overlayApplied: false, _overlayBase: new THREE.Quaternion(),
  _overlayRotation: new THREE.Quaternion(), _overlayAxis: new THREE.Vector3(1, 0, 0),
  assetInfo: { hasSkinnedMesh: false, motions: {}, loaded: false }
});
v.scene.add(v.stage);
const maxWeapon = Object.freeze({ visualScale: 1.94, tier: 5, jetCount: 3, spreadAngle: .19, range: 7.7, waterCapacity: 198 });
const originalInput = JSON.stringify(maxWeapon);
const oldLoadAsync = GLTFLoader.prototype.loadAsync;
GLTFLoader.prototype.loadAsync = async () => gltf;
try {
  const loading = v._load();
  v.setWeapon(maxWeapon);
  assert.equal(v.assetInfo.loaded, false);
  await loading;
} finally { GLTFLoader.prototype.loadAsync = oldLoadAsync; }

test('An upgrade chosen before ready appears after the real Squirtle GLB loads', () => {
  assert.equal(v.assetInfo.loaded, true); assert.equal(v.assetInfo.boneNames.length, 32);
  assert.equal(v.clips.length, 6); assert.equal(v._weapon.jetCount, 3);
  assert.equal(v._waterJets.length, 3); assert.equal(v.gun.userData.upgradeParts.cream.color.getHex(), 0xffd168);
  assert.equal(v.gun.userData.upgradeParts.indicators.filter(dot => dot.visible).length, 3);
  assert.ok(v.tank.root.parent.isBone); assert.equal(JSON.stringify(maxWeapon), originalInput);
});
test('Equipment appearance cannot move the original right-hand attachment or muzzle socket', () => {
  v.scene.updateMatrixWorld(true);
  const parent = v.gun.parent, position = v.gun.position.clone(), scale = v.gun.scale.clone();
  const rotation = v.gun.quaternion.clone(), socket = v._waterMuzzle.position.clone();
  const world = v._waterMuzzle.getWorldPosition(new THREE.Vector3());
  const boneRotation = parent.quaternion.clone();
  v.setWeapon({}); v.setWeapon(maxWeapon); v.scene.updateMatrixWorld(true);
  assert.equal(v.gun.parent, parent); assert.ok(parent.isBone);
  assert.ok(v.gun.position.equals(position) && v.gun.scale.equals(scale) && v.gun.quaternion.equals(rotation));
  assert.ok(v._waterMuzzle.position.equals(socket));
  assert.ok(v._waterMuzzle.getWorldPosition(new THREE.Vector3()).distanceTo(world) < 1e-7);
  assert.ok(parent.quaternion.equals(boneRotation));
});
test('Returning to the basic weapon restores all visible gun and tank upgrade changes', () => {
  v.setWeapon({});
  const p = v.gun.userData.upgradeParts;
  assert.ok(p.cream.color.equals(p.baseCream) && p.orange.color.equals(p.baseOrange));
  close(p.barrel.scale.x, 1); close(p.lip.scale.x, 1);
  assert.equal(p.indicators.some(dot => dot.visible), false); close(p.orange.emissive.getHex(), 0);
  assert.ok(v.tank.root.scale.equals(v.tank.baseScale));
  assert.ok(v.tank.cap.color.equals(v.tank.baseColor));
  assert.equal(v.tank.water.material.color.getHex(), 0x42d5d6);
  assert.equal(v.tank.stripe.material.color.getHex(), 0xe0f2d7);
  v.setWeapon(maxWeapon); const size = v.tank.root.scale.clone();
  v.setWeapon(maxWeapon); assert.ok(v.tank.root.scale.equals(size));
});
test('Water radius, highlights and detached droplet scaling use the runtime upgrade values', () => {
  v.setWeapon(maxWeapon); const look = weaponAppearance(maxWeapon);
  for (const flow of v._waterJets) {
    close(flow.radius, .032 * 1.94); close(flow.splashScale, look.splashScale);
    close(flow.mesh.material.uniforms.uPower.value, look.highlight);
  }
  v.setWeapon({});
  for (const flow of v._waterJets) { close(flow.radius, .032); close(flow.splashScale, 1.25); }
});
test('The shooting preview emits the equipped nozzle count, all from the animated muzzle', () => {
  v.setWeapon(maxWeapon); v.setMotion('shoot'); v.scene.updateMatrixWorld(true);
  v._updateWaterSpray(1, .1);
  assert.equal(v._waterJets.filter(flow => flow.active).length, 3);
  const source = v._waterMuzzle.getWorldPosition(new THREE.Vector3());
  for (const flow of v._waterJets) {
    assert.ok(flow.origin.distanceTo(source) < 1e-7); assert.ok(flow.packets.some(packet => packet.alive));
  }
  assert.ok(v._waterJets[0].end.distanceTo(v._waterJets[1].end) > .1);
  assert.ok(v._waterJets[1].end.distanceTo(v._waterJets[2].end) > .1);
  v.setWeapon({}); v._updateWaterSpray(1.1, .1);
  assert.equal(v._waterJets.filter(flow => flow.active).length, 1);
  assert.ok(v._waterJets.slice(1).every(flow => flow.packets.every(packet => !packet.alive)));
  v.setMotion('idle'); v._updateWaterSpray(1.2, .1);
  assert.equal(v._waterJets.some(flow => flow.active), false);
});
test('Upgrades retain the original five animation choices and running bone movement', () => {
  for (const motion of ['idle', 'run', 'shoot', 'hit', 'fall']) {
    v.setMotion(motion); const action = v._currentAction, clip = v.assetInfo.activeClipName;
    v.mixer.update(.1); const time = action.time;
    v.setWeapon(maxWeapon); assert.equal(v._motion, motion); assert.equal(v._currentAction, action);
    assert.equal(v.assetInfo.activeClipName, clip); close(action.time, time);
  }
  v.setMotion('run');
  const leg = v.model.getObjectByName('left_leg_02'); assert.ok(leg?.isBone);
  v.mixer.update(.2); const before = leg.quaternion.clone(); v.mixer.update(.25);
  assert.ok(Math.abs(before.dot(leg.quaternion)) < .9999);
});
test('Repeated menu renders preserve detached water and do not reallocate the same equipment', () => {
  v.setWeapon(maxWeapon); v.setMotion('shoot'); v.scene.updateMatrixWorld(true);
  v._updateWaterSpray(2, .1);
  const flow = v._waterJets[0], packet = flow.packets.find(item => item.alive), age = packet.age;
  v.setWeapon({ ...maxWeapon }); assert.equal(v._waterJets[0], flow);
  assert.ok(packet.alive); close(packet.age, age); assert.equal(flow.active, true);
});
test('A preview is an isolated copy and malformed inputs never allocate extra nozzles', () => {
  const mutable = { ...maxWeapon }; v.setWeapon(mutable); mutable.jetCount = 1; mutable.tier = 0;
  assert.equal(v._weapon.jetCount, 3); assert.equal(v._weapon.tier, 5);
  const invalid = v.setWeapon({ visualScale: Infinity, tier: NaN, jetCount: 1000, spreadAngle: -1 });
  close(invalid.visualScale, 1); close(invalid.tier, 0); close(invalid.spreadAngle, 0);
  assert.equal(v._waterJets.length, 3); assert.equal(JSON.stringify(maxWeapon), originalInput);
  assert.equal('campaign' in v, false); assert.equal('game' in v, false);
});
test('Disposal releases every preview nozzle, including nozzles hidden by a downgrade', () => {
  v.setWeapon({}); const groups = v._waterJets.map(flow => flow.group);
  v.dispose(); assert.ok(groups.every(group => group.parent === null));
});
console.log(`${passed} actual model/equipment preview checks passed (no WebGL context created)`);
