/** Test actual renderer projection and pointer mapping with real Three.js math. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
globalThis.window ||= {};
const { WaterRenderer } = await import(asModule(rendererSource));

const ELLIPSE_RATIO = .41;
const REFERENCE_ASPECT = 1264 / 650;
const REFERENCE_HALF_WIDTH = 7.4;
const REFERENCE_HALF_HEIGHT = REFERENCE_HALF_WIDTH / REFERENCE_ASPECT;
const VIEWPORTS = [[390, 200], [844, 430], [1264, 650], [1920, 1080], [390, 700], [1024, 768]];
let checks = 0;
function test(name, run) { run(); checks++; console.log('PASS ' + name); }
function near(actual, expected, tolerance = 1e-7) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}
function stub(width = 1264, height = 650) {
  const rect = { width, height, left: 173.5, top: 87.25 };
  const calls = [], renderer = Object.create(WaterRenderer.prototype);
  Object.assign(renderer, { canvas: { getBoundingClientRect: () => ({ ...rect }) },
    camera: new THREE.OrthographicCamera(-9, 9, 5, -5, .1, 100),
    _raycaster: new THREE.Raycaster(), _floorPlane: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
    _pointer: new THREE.Vector2(), _projected: new THREE.Vector3(),
    renderer: { setSize: (...args) => calls.push(args), getPixelRatio: () => 1 },
    particles: { material: { uniforms: { uScale: { value: 60 } } } }
  });
  return { renderer, rect, calls };
}
function circleBounds(renderer, radius = 7) {
  const points = Array.from({ length: 360 }, (_, index) => {
    const angle = index / 360 * Math.PI * 2;
    return renderer.worldToScreen(Math.cos(angle) * radius, Math.sin(angle) * radius, .045);
  });
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys),
    width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}
function project3D(renderer, point) {
  const rect = renderer.canvas.getBoundingClientRect(), p = point.clone().project(renderer.camera);
  return new THREE.Vector2(rect.left + (p.x + 1) * rect.width / 2, rect.top + (1 - p.y) * rect.height / 2);
}
function cameraSnapshot(renderer) {
  return JSON.stringify({ position: renderer.camera.position.toArray(), quaternion: renderer.camera.quaternion.toArray(),
    frustum: [renderer.camera.left, renderer.camera.right, renderer.camera.top, renderer.camera.bottom],
    projection: renderer.camera.projectionMatrix.elements, matrixWorld: renderer.camera.matrixWorld.elements,
    width: renderer._width, height: renderer._height, particleScale: renderer.particles.material.uniforms.uScale.value });
}

test('The world circle projects to the same 0.41-height ellipse across phone and desktop viewports', () => {
  const { renderer, rect } = stub(), readings = [];
  for (const [width, height] of VIEWPORTS) {
    Object.assign(rect, { width, height }); renderer.resize();
    const bounds = circleBounds(renderer); near(bounds.height / bounds.width, ELLIPSE_RATIO);
    assert.ok(bounds.left >= rect.left && bounds.right <= rect.left + width);
    assert.ok(bounds.top >= rect.top && bounds.bottom <= rect.top + height);
    readings.push({ viewport: `${width}x${height}`, projectedWidth: +bounds.width.toFixed(3),
      projectedHeight: +bounds.height.toFixed(3), ratio: +(bounds.height / bounds.width).toFixed(6) });
  }
  console.log('ARENA_FIXED_PROJECTION ' + JSON.stringify(readings));
});

test('Resize keeps camera orientation and distance fixed, including portrait and ultrawide layouts', () => {
  const { renderer, rect } = stub(); renderer.resize();
  const position = renderer.camera.position.clone(), quaternion = renderer.camera.quaternion.clone();
  for (const [width, height] of [...VIEWPORTS, [2400, 400]]) {
    Object.assign(rect, { width, height }); renderer.resize();
    assert.ok(renderer.camera.position.equals(position)); assert.ok(renderer.camera.quaternion.equals(quaternion));
    const direction = renderer.camera.getWorldDirection(new THREE.Vector3());
    near(direction.x, 0); near(direction.y, -ELLIPSE_RATIO);
    near(direction.z, -Math.sqrt(1 - ELLIPSE_RATIO ** 2));
  }
});

test('Contain framing preserves the reference camera area rather than cropping it', () => {
  const { renderer, rect } = stub();
  for (const [width, height] of VIEWPORTS) {
    Object.assign(rect, { width, height }); renderer.resize();
    const halfWidth = (renderer.camera.right - renderer.camera.left) / 2;
    const halfHeight = (renderer.camera.top - renderer.camera.bottom) / 2;
    assert.ok(halfWidth + 1e-8 >= REFERENCE_HALF_WIDTH);
    assert.ok(halfHeight + 1e-8 >= REFERENCE_HALF_HEIGHT);
    near(halfWidth / halfHeight, width / height);
    // One dimension retains the reference extent; the other only gains space.
    assert.ok(Math.abs(halfWidth - REFERENCE_HALF_WIDTH) < 1e-7 || Math.abs(halfHeight - REFERENCE_HALF_HEIGHT) < 1e-7);
  }
});

test('Camera-space horizontal and vertical units have equal pixel scale without stretching content', () => {
  const { renderer, rect } = stub();
  for (const [width, height] of VIEWPORTS) {
    Object.assign(rect, { width, height }); renderer.resize();
    const center = new THREE.Vector3(0, .65, 0);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(renderer.camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(renderer.camera.quaternion);
    const p = project3D(renderer, center);
    const horizontal = project3D(renderer, center.clone().add(right)).distanceTo(p);
    const vertical = project3D(renderer, center.clone().add(up)).distanceTo(p);
    near(horizontal, vertical); assert.ok(horizontal > 0);
  }
});

test('Actual worldToScreen and screenToWorld round-trip arena points with viewport offsets', () => {
  const { renderer, rect } = stub();
  const points = [[0, 0], [6.8, 0], [-6.8, 0], [0, 6.8], [0, -6.8], [3.1, -4.8], [-3.7, 2.2]];
  for (const [width, height] of VIEWPORTS) {
    Object.assign(rect, { width, height }); renderer.resize();
    for (const [x, y] of points) {
      const screen = renderer.worldToScreen(x, y), world = renderer.screenToWorld(screen.x, screen.y);
      near(world.x, x); near(world.y, y);
    }
  }
});

test('Hidden zero-size canvases leave the last valid camera, draw size and particle scale intact', () => {
  const { renderer, rect, calls } = stub(); renderer.resize();
  const before = cameraSnapshot(renderer), drawCalls = calls.length;
  for (const [width, height] of [[0, 0], [0, 650], [1264, 0]]) {
    Object.assign(rect, { width, height }); renderer.resize();
    assert.equal(cameraSnapshot(renderer), before); assert.equal(calls.length, drawCalls);
  }
  Object.assign(rect, { width: 390, height: 200 }); renderer.resize();
  const fresh = stub(390, 200); fresh.renderer.resize();
  assert.equal(cameraSnapshot(renderer), cameraSnapshot(fresh.renderer));
  const point = renderer.worldToScreen(2.5, -3.5), restored = renderer.screenToWorld(point.x, point.y);
  near(restored.x, 2.5); near(restored.y, -3.5);
});

test('An initially hidden canvas does not poison its first valid phone projection', () => {
  const hidden = stub(0, 0), before = cameraSnapshot(hidden.renderer); hidden.renderer.resize();
  assert.equal(cameraSnapshot(hidden.renderer), before); assert.equal(hidden.calls.length, 0);
  Object.assign(hidden.rect, { width: 844, height: 430 }); hidden.renderer.resize();
  const fresh = stub(844, 430); fresh.renderer.resize();
  assert.equal(cameraSnapshot(hidden.renderer), cameraSnapshot(fresh.renderer));
  near(circleBounds(hidden.renderer).height / circleBounds(hidden.renderer).width, ELLIPSE_RATIO);
});

test('The real render loop recovers an uninitialized hidden canvas when it becomes visible', () => {
  const { renderer, rect, calls } = stub(0, 0); renderer.resize();
  // Camera and pointer methods are real. Unrelated asset/effect updates are
  // excluded so this test isolates render's decision to call resize.
  Object.assign(renderer, { supported: true, _destroyed: false, modelLoaded: false, _time: 0,
    _applyStage() {}, _updateFountains() {}, _updateDecorativeSpouts() {}, _updateBeams() {} });
  for (const name of ['surfaceMaterial', 'poolMaterial', 'waterfallMaterial', 'foamMaterial']) {
    renderer[name] = { uniforms: { uTime: { value: 0 } } };
  }
  renderer.particles.update = () => {};
  Object.assign(renderer.renderer, { render() {}, info: { render: { calls: 0, triangles: 0 } } });
  Object.assign(rect, { width: 390, height: 200 });
  renderer.render({ phase: 'ready', actors: [] }, 0);
  assert.equal(renderer._width, 390); assert.equal(renderer._height, 200); assert.equal(calls.length, 1);
  near(circleBounds(renderer).height / circleBounds(renderer).width, ELLIPSE_RATIO);
  const point = renderer.worldToScreen(-2, 4), world = renderer.screenToWorld(point.x, point.y);
  near(world.x, -2); near(world.y, 4);
});

console.log(`RESULT ${checks} fixed-arena projection / pointer-mapping checks passed (no WebGL context created).`);
