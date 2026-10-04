/**
 * Run the shipped Three.js water module without a WebGL renderer:
 *   node source/water_flow_test_v4.mjs
 * The fountain's GPU birth gate is evaluated with the same ballistic equation.
 * These tests verify motion/lifecycle contracts, not shader appearance or realism.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as THREE from '../vendor/three.module.js';
import { WaterJet, FountainSpray } from '../water-flow.js';

const moduleUrl = new URL('../water-flow.js', import.meta.url);
const source = await readFile(moduleUrl, 'utf8');
console.log(`Actual module: ${moduleUrl.pathname}`);
console.log(`SHA256: ${createHash('sha256').update(source).digest('hex')}`);
console.log(`Three.js r${THREE.REVISION}; no WebGL renderer created.`);

let passed = 0, failed = 0;
const cleanup = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
  finally { while (cleanup.length) cleanup.pop()(); }
}
function jet(options = {}) {
  const scene = new THREE.Scene();
  const effect = new WaterJet(scene, { speed: 20, radius: .018, seed: 41, ...options });
  cleanup.push(() => effect.dispose());
  return { scene, effect };
}
function fountain(options = {}) {
  const scene = new THREE.Scene();
  const effect = new FountainSpray(scene, { height: 3.1, width: .58, seed: 41, count: 3600, ...options });
  cleanup.push(() => effect.dispose());
  return { scene, effect };
}
const vec = (x, y, z) => new THREE.Vector3(x, y, z);
const live = items => items.filter(p => p.alive);
function near(actual, expected, message, epsilon = 1e-8) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${message}: ${actual} != ${expected}`);
}
function step(effect, duration, active) {
  let remaining = duration;
  while (remaining > 1e-9) {
    const dt = Math.min(1 / 60, remaining);
    active === undefined ? effect.update(dt) : effect.update(dt, active);
    remaining -= dt;
  }
}
function arrays(scene) {
  const data = [];
  scene.traverse(object => {
    if (object.geometry) {
      for (const [name, attribute] of Object.entries(object.geometry.attributes)) {
        data.push([`${object.type}.${name}`, Array.from(attribute.array)]);
      }
      if (object.geometry.index) data.push([`${object.type}.index`, Array.from(object.geometry.index.array)]);
      data.push([`${object.type}.drawRange`, { ...object.geometry.drawRange }]);
    }
    if (object.instanceMatrix) data.push([`${object.type}.instanceMatrix`, Array.from(object.instanceMatrix.array)]);
  });
  return data;
}
function checkFinite(scene, label) {
  let values = 0;
  scene.traverse(object => {
    const entries = object.geometry ? Object.entries(object.geometry.attributes) : [];
    if (object.instanceMatrix) entries.push(['instanceMatrix', object.instanceMatrix]);
    for (const [name, attribute] of entries) for (const value of attribute.array) {
      values++;
      assert.ok(Number.isFinite(value), `${label}: ${object.type}.${name} contains ${value}`);
    }
  });
  assert.ok(values > 0, `${label}: no geometry tested`);
}
function jetSnapshot(effect, scene) {
  return digest({
    clock: effect.clock, active: effect.active, carry: effect.emitCarry,
    origin: effect.origin.toArray(), end: effect.end.toArray(),
    previousOrigin: effect.previousOrigin?.toArray(), previousEnd: effect.previousEnd?.toArray(),
    packets: effect.packets, drops: effect.drops.items, ripples: effect.ripples.items,
    visible: effect.mesh.visible, time: effect.mesh.material.uniforms.uTime.value, geometry: arrays(scene)
  });
}
function fountainSnapshot(effect, scene) {
  return digest({ clock: effect.clock, active: effect.active, first: effect.first,
    on: effect.on, off: effect.off, carry: effect.rippleCarry, strength: effect.strength,
    pointVisible: effect.points.visible, coreVisible: effect.core.visible,
    pointUniforms: effect.points.material.uniforms, coreUniforms: effect.core.material.uniforms,
    foamUniforms: effect.foam.material.uniforms, ripples: effect.ripples.items, geometry: arrays(scene) });
}
function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// Fountain particle positions live on the GPU. Evaluate the shipped shader's
// equation against its actual generated seeds, phases and runtime uniforms.
function fountainSamples(effect) {
  const attributes = effect.points.geometry.attributes;
  const uniforms = effect.points.material.uniforms;
  const time = uniforms.uTime.value, on = uniforms.uOn.value, off = uniforms.uOff.value;
  const height = uniforms.uHeight.value, width = uniforms.uWidth.value;
  const samples = [];
  for (let i = 0; i < attributes.aPhase.count; i++) {
    const sx = attributes.aSeed.getX(i), sy = attributes.aSeed.getY(i);
    const sz = attributes.aSeed.getZ(i), sw = attributes.aSeed.getW(i);
    const vy = Math.sqrt(2 * 9.8 * height) * (.82 + sz * .18);
    const life = (vy + Math.sqrt(vy * vy + 2 * 9.8 * .075)) / 9.8;
    const age = (time + attributes.aPhase.getX(i) * life) % life;
    const born = time - age, angle = sx * Math.PI * 2;
    const lateral = (.14 + sw * sw * .68) * width / .58;
    const radius = Math.sqrt(sy) * width * .27 + lateral * age;
    const sample = { i, born, life, age, x: Math.cos(angle) * radius,
      y: .09 + vy * age - .5 * 9.8 * age * age, z: Math.sin(angle) * radius,
      vy: vy - 9.8 * age, valid: born >= on && born <= off };
    assert.ok(Object.values(sample).every(value => typeof value !== 'number' || Number.isFinite(value)), 'finite GPU fountain equation');
    samples.push(sample);
  }
  return samples;
}

test('World-space packets retain launch position and momentum after turn and stop', () => {
  const { effect, scene } = jet();
  const start = vec(0, 2, 0), end = vec(6, 1.8, 0);
  effect.setEmission(true, start, end, { hit: false, floor: -10 });
  effect.update(1 / 30);
  const packet = live(effect.packets)[0];
  assert.ok(packet, 'at least one packet emitted');
  const launch = { x0: packet.x0, y0: packet.y0, z0: packet.z0,
    vx: packet.vx, vy: packet.vy, vz: packet.vz, gravity: packet.gravity };
  const oldSerial = effect.serial;
  effect.setEmission(false, vec(100, 2, 100), vec(100, 2, 106), { hit: false, floor: -10 });
  effect.update(.025);
  assert.ok(packet.alive, 'old packet stays airborne after stop');
  for (const [name, value] of Object.entries(launch)) near(packet[name], value, `launch ${name} remains fixed`);
  near(packet.x, launch.x0 + launch.vx * packet.age, 'independent world x');
  near(packet.z, launch.z0 + launch.vz * packet.age, 'independent world z');
  assert.equal(effect.serial, oldSerial, 'no new emission after stop');
  assert.equal(effect.group.parent, scene, 'jet belongs to the world scene');
  assert.deepEqual(effect.group.position.toArray(), [0, 0, 0], 'no muzzle-local transform');
});

test('Previously emitted packets keep their original trajectory during an active turn', () => {
  const { effect } = jet();
  effect.setEmission(true, vec(0, 2, 0), vec(6, 2, 0), { floor: -10 });
  effect.update(1 / 60);
  const oldPacket = live(effect.packets)[0], oldSerial = effect.serial;
  const originalEnd = [oldPacket.endX, oldPacket.endY, oldPacket.endZ];
  effect.setEmission(true, vec(.5, 2, 0), vec(.5, 2, 6), { floor: -10 });
  effect.update(1 / 30);
  assert.deepEqual([oldPacket.endX, oldPacket.endY, oldPacket.endZ], originalEnd);
  near(oldPacket.z, 0, 'old water does not rotate with the gun');
  assert.ok(effect.serial > oldSerial, 'the turned gun still emits new water');
  const newPackets = live(effect.packets).filter(p => p.serial >= oldSerial);
  assert.ok(newPackets.some(p => p.vz > 0), 'new launch directions follow the new aim');
  assert.ok(new Set(newPackets.map(p => p.x0)).size > 1, 'sub-frame births interpolate muzzle motion');
});

test('Detached droplets preserve inertia and gravity after muzzle relocation', () => {
  const { effect } = jet();
  effect.setEmission(true, vec(0, 2, 0), vec(3, 2, 0), { hit: false, floor: -10 });
  step(effect, .20);
  const drop = live(effect.drops.items).find(p => p.age < .25);
  assert.ok(drop, 'the real jet emits detached droplets');
  const before = { ...drop };
  effect.setEmission(false, vec(80, 80, 80), vec(80, 80, 86), { floor: -10 });
  effect.update(.02);
  assert.ok(drop.alive);
  const drag = Math.exp(-before.drag * .02);
  near(drop.x, before.x + before.vx * drag * .02, 'drop horizontal inertia');
  near(drop.y, before.y + before.vy * .02 - .5 * before.gravity * .02 ** 2, 'drop gravitational displacement');
  near(drop.vy, before.vy - before.gravity * .02, 'drop gravity changes velocity');
});

test('Zero dt pauses packet/drop/ripple simulation and rendered attributes', () => {
  const { effect, scene } = jet();
  effect.setEmission(true, vec(0, 1.1, 0), vec(3, .04, 0), { hit: true, surface: true, floor: .04 });
  step(effect, .4);
  assert.ok(live(effect.packets).length && live(effect.drops.items).length && live(effect.ripples.items).length,
    'pause test includes stream, splash droplets and horizontal ripples');
  const snapshot = jetSnapshot(effect, scene);
  for (let i = 0; i < 4; i++) effect.update(0);
  assert.equal(jetSnapshot(effect, scene), snapshot);
});

test('Hit packets reach their captured target endpoint without changing game input', () => {
  const { effect } = jet();
  const start = vec(-1, 1.2, 2), end = vec(3, .9, 2);
  const target = end.clone();
  effect.setEmission(true, start, end, { hit: true, contactId: 'AI-2', floor: .04 });
  effect.update(1 / 60);
  const packet = live(effect.packets)[0];
  assert.ok(packet.hit);
  end.set(60, 60, 60); // caller objects must not retroactively move emitted water
  effect.setEmission(false, vec(10, 1.2, 10), vec(10, .9, 14), { hit: false, floor: .04 });
  step(effect, packet.travel - packet.age + .002);
  assert.equal(packet.alive, false);
  near(packet.x, target.x, 'hit x'); near(packet.y, target.y, 'hit y'); near(packet.z, target.z, 'hit z');
  assert.deepEqual(start.toArray(), [-1, 1.2, 2], 'visual module does not mutate source start');
  assert.equal(typeof effect.getState, 'undefined', 'VFX does not own or advance gameplay state');
});

test('Continuous jet follows a genuine downward-accelerated ballistic arc', () => {
  const { effect } = jet();
  effect.setEmission(true, vec(0, 2, 0), vec(6, 2, 0), { floor: -10, gravity: 9.8 });
  effect.update(1 / 60);
  const packet = live(effect.packets)[0];
  effect.setEmission(false, null, null, {});
  const dt = .02, y0 = packet.y;
  effect.update(dt); const y1 = packet.y;
  effect.update(dt); const y2 = packet.y;
  near((y2 - 2 * y1 + y0) / dt ** 2, -9.8, 'vertical acceleration', 1e-7);
  assert.ok(y1 > 2, 'gravity-compensated launch makes a curved arc rather than a straight beam');
});

test('WaterJet reset immediately empties history, droplets, ripples and draw range', () => {
  const { effect } = jet();
  effect.setEmission(true, vec(0, 1.1, 0), vec(3, .04, 0), { hit: true, surface: true, floor: .04 });
  step(effect, .4);
  effect.reset();
  assert.equal(live(effect.packets).length, 0);
  assert.equal(live(effect.drops.items).length, 0);
  assert.equal(live(effect.ripples.items).length, 0);
  assert.equal(effect.mesh.visible, false);
  assert.equal(effect.mesh.geometry.drawRange.count, 0);
  assert.ok(effect.drops.opacity.every(value => value === 0));
  assert.ok(effect.ripples.opacity.every(value => value === 0));
});

test('WaterJet reset does not resume stale emission without a new setEmission call', () => {
  const { effect } = jet();
  effect.setEmission(true, vec(0, 1, 0), vec(3, 1, 0), { floor: -10 });
  effect.update(.03); effect.reset();
  step(effect, .08);
  assert.equal(live(effect.packets).length, 0, 'stale pre-reset active input must not recreate the old jet');
});

test('All real dynamic attributes and instance matrices stay finite during varied motion', () => {
  const { effect, scene } = jet();
  const { effect: spray, scene: fountainScene } = fountain();
  for (let frame = 0; frame < 300; frame++) {
    const angle = frame * .17, start = vec(Math.cos(angle), .8 + Math.sin(angle * .37) * .2, Math.sin(angle));
    const end = start.clone().add(vec(Math.cos(angle * 1.8) * 4, -.25, Math.sin(angle * 1.8) * 4));
    const hit = frame % 29 < 7, active = frame % 41 < 30;
    effect.setEmission(active, start, end, { hit, contactId: Math.floor(frame / 29), floor: .04 });
    const dt = frame % 61 === 0 ? .35 : frame % 37 === 0 ? 0 : 1 / 60;
    effect.update(dt); spray.update(dt, frame % 130 < 75);
    if (frame % 10 === 0) { checkFinite(scene, 'jet'); checkFinite(fountainScene, 'fountain'); fountainSamples(spray); }
    for (const packet of live(effect.packets)) for (const key of ['x', 'y', 'z', 'age', 'travel', 'vx', 'vy', 'vz']) {
      assert.ok(Number.isFinite(packet[key]), `packet ${key} finite`);
    }
  }
});

test('Invalid, negative and oversized dt are clamped before simulation', () => {
  const { effect, scene } = jet();
  effect.setEmission(true, vec(0, 1, 0), vec(3, 1, 0), { floor: -10 });
  effect.update(.02);
  const before = jetSnapshot(effect, scene);
  effect.update(NaN); effect.update(-1); effect.update(Infinity);
  assert.equal(jetSnapshot(effect, scene), before);
  const clock = effect.clock;
  effect.update(2); near(effect.clock - clock, .1, 'large dt clamps to .1');
});

test('Fountain starts from emission time, keeps airborne water after stop, then drains', () => {
  const { effect } = fountain();
  assert.ok(source.includes('float valid=step(uOn,born)*step(born,uOff)'), 'oracle birth gate matches shipped shader');
  effect.update(.02, false);
  assert.equal(effect.points.visible, false);
  assert.equal(fountainSamples(effect).filter(p => p.valid).length, 0);
  effect.update(.01, true);
  effect.update(.01, true); // first post-transition birth interval
  const justStarted = fountainSamples(effect).filter(p => p.valid);
  assert.ok(justStarted.length > 0);
  assert.ok(justStarted.every(p => p.age <= .01000001), 'new activation does not instantly fill the whole column');
  step(effect, .65, true);
  const beforeStop = fountainSamples(effect).filter(p => p.valid);
  assert.ok(beforeStop.length > 100, 'a developed fountain is airborne');
  effect.update(.01, false);
  assert.equal(effect.points.visible, true, 'stop does not delete all airborne particles');
  const stopped = fountainSamples(effect).filter(p => p.valid);
  assert.ok(stopped.length > 0);
  assert.ok(stopped.every(p => p.born <= effect.off + 1e-8), 'no post-stop birth is valid');
  const oldParticle = stopped.find(p => p.age + .02 < p.life);
  effect.update(.02, false);
  const after = fountainSamples(effect).find(p => p.i === oldParticle.i);
  assert.ok(after.valid, 'previously emitted water persists');
  near(after.vy - oldParticle.vy, -9.8 * .02, 'GPU fountain gravity', 1e-7);
  step(effect, 3.2, false);
  assert.equal(effect.points.visible, false); assert.equal(effect.core.visible, false);
  assert.equal(fountainSamples(effect).filter(p => p.valid).length, 0, 'all old GPU particles drain');
  assert.equal(live(effect.ripples.items).length, 0, 'return-flow ripples drain');
  assert.ok(effect.foam.material.uniforms.uStrength.value < .002, 'foam decays naturally');
});

test('Fountain zero dt preserves all motion, uniforms and ripple buffers', () => {
  const { effect, scene } = fountain();
  effect.update(.01, true); step(effect, 1.5, true);
  const before = fountainSnapshot(effect, scene);
  for (let i = 0; i < 4; i++) effect.update(0, true);
  assert.equal(fountainSnapshot(effect, scene), before);
});

test('Fountain reset immediately clears visible old GPU water, foam and ripples', () => {
  const { effect } = fountain();
  effect.update(.01, true); step(effect, 1.5, true);
  assert.ok(fountainSamples(effect).some(p => p.valid), 'fountain is active before reset');
  assert.ok(effect.foam.material.uniforms.uStrength.value > 0, 'foam is present before reset');
  effect.reset();
  assert.equal(live(effect.ripples.items).length, 0);
  assert.equal(effect.foam.material.uniforms.uStrength.value, 0, 'reset synchronizes the rendered foam uniform');
  assert.ok(!effect.points.visible || !fountainSamples(effect).some(p => p.valid), 'old shader particles cannot survive reset');
  assert.equal(effect.core.visible, false, 'old aerated core cannot survive reset');
});

test('Repeated fountain on/off periods always finish draining', () => {
  const { effect } = fountain();
  effect.update(.01, false);
  for (let cycle = 0; cycle < 5; cycle++) {
    step(effect, .12 + cycle * .08, true);
    step(effect, .07, false);
  }
  step(effect, 2.5, false);
  assert.equal(effect.points.visible, false);
  assert.equal(fountainSamples(effect).filter(p => p.valid).length, 0);
  assert.equal(live(effect.ripples.items).length, 0);
});

test('Droplets beyond the raised arena land on the lower pool instead of a floating floor', () => {
  const scene = new THREE.Scene(), flow = new WaterJet(scene, {seed:771}); cleanup.push(() => flow.dispose());
  flow.setEmission(true,new THREE.Vector3(6.4,1.1,0),new THREE.Vector3(8.6,.8,0),{
    floor:.045, floorAt:(x,z)=>Math.hypot(x,z)>7.04?-1.122:.045
  });
  for(let i=0;i<20;i++)flow.update(1/60);
  flow.setEmission(false);
  for(let i=0;i<45;i++)flow.update(1/60);
  const rings=flow.ripples.items.filter(p=>p.alive&&Math.hypot(p.x,p.z)>7.04);
  assert.ok(rings.length>0,'expected water to reach the outside pool');
  for(const ring of rings)assert.ok(Math.abs(ring.y-(-1.115))<1e-8,'outside splash should use the pool water height');
});

test('Dispose removes every effect object and disposes all allocated geometry/materials', () => {
  for (const make of [jet, fountain]) {
    const { effect, scene } = make();
    const resources = new Set();
    scene.traverse(object => {
      if (object.geometry) resources.add(object.geometry);
      for (const material of object.material ? [].concat(object.material) : []) resources.add(material);
    });
    assert.ok(resources.size >= 6, 'multiple allocated resources are present');
    const disposed = new Set();
    for (const resource of resources) resource.addEventListener('dispose', () => disposed.add(resource));
    effect.dispose(); cleanup.pop();
    assert.equal(scene.children.length, 0, 'scene no longer contains any effect object');
    assert.equal(disposed.size, resources.size, 'all geometry and material dispose events were raised');
  }
});

console.log(`\n${passed} passed; ${failed} failed. Visual QA and shader compilation require the browser.`);
process.exitCode = failed ? 1 : 0;
