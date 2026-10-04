/**
 * Water Push — local GLB / skeletal-animation renderer.
 * Original Blender geometry uses the CC0 Quaternius skeleton and animation clips.
 * Scene props and water effects are authored here. No primitive-character fallback.
 * Public coordinates: x -> world X, y -> world Z, height -> world Y; floor Y=0.
 */
import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from './vendor/addons/utils/SkeletonUtils.js';
import { RoomEnvironment } from './vendor/addons/environments/RoomEnvironment.js';
import { Reflector } from './vendor/addons/objects/Reflector.js';
import { WaterJet, FountainSpray } from './water-flow.js';

const TAU = Math.PI * 2;
const COLORS = [0x278ee0, 0xf16762, 0xefc33b, 0x9971d5];
const FLOOR = 0, POOL = -1.15;
const UP = new THREE.Vector3(0, 1, 0);
const clamp = THREE.MathUtils.clamp;
const expTo = (from, to, rate, dt) => THREE.MathUtils.lerp(from, to, 1 - Math.exp(-rate * dt));
const tempV = new THREE.Vector3(), tempV2 = new THREE.Vector3(), tempQ = new THREE.Quaternion();
const tempM = new THREE.Matrix4(), tempO = new THREE.Object3D();
const cleanName = name => String(name).split('|').pop().replace(/[^a-z0-9]/gi, '').toLowerCase();
const boneKey = name => String(name).replace(/_\d+$/, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
function material(color, roughness = .58, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: .02, ...extra });
}
function mesh(geometry, mat, parent, x = 0, y = 0, z = 0) {
  const value = new THREE.Mesh(geometry, mat);
  value.position.set(x, y, z); if (parent) parent.add(value); return value;
}
function horizontal(geometry, mat, parent, y = 0) {
  const value = mesh(geometry, mat, parent, 0, y, 0); value.rotation.x = -Math.PI / 2; return value;
}
function randomGenerator(seed) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296; };
}
function copyTrack(track) { return track.clone(); }
function trackNode(track) {
  // glTFLoader produces direct nodeName.property tracks (bone names can contain dots).
  return track.name.replace(/\.(position|quaternion|scale|morphTargetInfluences)(\[.*\])?$/, '');
}
function maskedClip(clip, name, predicate) {
  return new THREE.AnimationClip(name, clip.duration, clip.tracks.filter(predicate).map(copyTrack));
}

const STAGE_LOOKS = Object.freeze({
  spring: { background: 0x298a24, sky: 0xe8f4ed, ground: 0x355921, sun: 0xfff2d9, sunPower: 2.3, fill: 0xd4ece6, fillPower: .28, ambient: 0xf7eedb, hemiPower: .95, exposure: 1, surface: 0x617f57, pool: 0x62b5a1, poolOpacity: .53, foliage: 0x4f922f, foliageMix: 0, stone: 0xb28a60, stoneMix: 0, flower: 0xffe2d0, flowerMix: 0, flowerGlow: .055 },
  sunset: { background: 0x806b51, sky: 0xffdaca, ground: 0x493448, sun: 0xffab69, sunPower: 2.35, fill: 0xa8b1f4, fillPower: .55, ambient: 0xffd7b6, hemiPower: .9, exposure: 1, surface: 0xa18e70, pool: 0x7395ad, poolOpacity: .60, foliage: 0x7f8f45, foliageMix: .28, stone: 0xcf955e, stoneMix: .23, flower: 0xffb68a, flowerMix: .24, flowerGlow: .08 },
  lagoon: { background: 0x267c67, sky: 0xd4fff8, ground: 0x226153, sun: 0xf4fff7, sunPower: 2.3, fill: 0x63eadb, fillPower: .65, ambient: 0xd2faf0, hemiPower: 1.05, exposure: 1.02, surface: 0x74bcad, pool: 0x26b9bf, poolOpacity: .65, foliage: 0x32a684, foliageMix: .40, stone: 0xc2c0a3, stoneMix: .30, flower: 0xeef4ba, flowerMix: .18, flowerGlow: .09 },
  moon: { background: 0x172c48, sky: 0x91b8ff, ground: 0x15243b, sun: 0xa9bdff, sunPower: 1.35, fill: 0x55d8e5, fillPower: .62, ambient: 0xaccbff, hemiPower: .82, exposure: 1.08, surface: 0x3b7187, pool: 0x235c92, poolOpacity: .64, foliage: 0x276671, foliageMix: .54, stone: 0x6d8fae, stoneMix: .37, flower: 0xc4aeff, flowerMix: .40, flowerGlow: .24 }
});

/** Shared with tests so stage and upgrade previews use the exact runtime values. */
export function stageAppearance(theme = 'spring') {
  const name = Object.hasOwn(STAGE_LOOKS, theme) ? theme : 'spring';
  return { theme: name, ...STAGE_LOOKS[name] };
}
export function weaponAppearance(weapon = {}, actor = {}) {
  const visualScale = clamp(Number.isFinite(weapon.visualScale) ? weapon.visualScale : 1, 1, 2);
  const tier = clamp(Number.isFinite(weapon.tier) ? weapon.tier : 0, 0, 9);
  const upgraded = visualScale > 1.01 || tier > 0 || weapon.jetCount === 3;
  return { visualScale, tier, upgraded, radius: .060 * visualScale,
    splashScale: 1.25 * (1 + (visualScale - 1) * .55), highlight: 1 + (visualScale - 1) * .72,
    muzzleScale: 1 + (visualScale - 1) * .18, tankScale: 1 + (visualScale - 1) * .20,
    bossScale: actor.role === 'boss' ? clamp(Number.isFinite(actor.enemyProfile?.scale ?? actor.profile?.scale) ? (actor.enemyProfile?.scale ?? actor.profile?.scale) : 1.2, 1.05, 1.35) : 1 };
}

/** One pooled draw call for water droplets, foam and ground ripple sprites. */
class WaterParticles {
  constructor(scene, capacity = 4200) {
    this.capacity = capacity; this.cursor = 0;
    this.items = Array.from({ length: capacity }, () => ({ alive: false }));
    this.positions = new Float32Array(capacity * 3); this.colors = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity); this.opacities = new Float32Array(capacity); this.kinds = new Float32Array(capacity);
    const geometry = this.geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aOpacity', new THREE.BufferAttribute(this.opacities, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aKind', new THREE.BufferAttribute(this.kinds, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = this.material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: true,
      uniforms: { uScale: { value: 60 } },
      vertexShader: `
        attribute vec3 aColor; attribute float aSize; attribute float aOpacity; attribute float aKind;
        uniform float uScale; varying vec3 vColor; varying float vOpacity; varying float vKind;
        void main(){vColor=aColor;vOpacity=aOpacity;vKind=aKind;
          gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
          gl_PointSize=max(1.0,aSize*uScale);}
      `,
      fragmentShader: `
        varying vec3 vColor; varying float vOpacity; varying float vKind;
        void main(){
          vec2 p=gl_PointCoord*2.0-1.0;
          float d=length(p); float alpha;
          if(vKind>0.5){d=length(vec2(p.x,p.y*1.6));alpha=(1.0-smoothstep(0.84,1.0,d))*smoothstep(0.56,0.73,d);}
          else{alpha=1.0-smoothstep(0.35,1.0,d);}
          if(alpha*vOpacity<0.01)discard;
          vec3 c=mix(vColor,vec3(1.0),pow(max(0.0,1.0-d),3.0)*0.45);
          gl_FragColor=vec4(c,alpha*vOpacity);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `
    });
    this.points = new THREE.Points(geometry, mat); this.points.frustumCulled = false; this.points.renderOrder = 8; scene.add(this.points);
  }
  emit(x, y, z, vx, vy, vz, options = {}) {
    const i = this.cursor++ % this.capacity, p = this.items[i];
    Object.assign(p, { alive: true, x, y, z, vx, vy, vz, t: 0, life: options.life || .5,
      size: options.size || .10, opacity: options.opacity == null ? .85 : options.opacity,
      gravity: options.gravity == null ? 5.5 : options.gravity, kind: options.ripple ? 1 : 0,
      expand: options.expand || 0, floor: options.floor == null ? -.80 : options.floor });
    const c = new THREE.Color(options.color || 0xd6fffb); c.toArray(this.colors, i * 3); this.kinds[i] = p.kind;
  }
  ripple(x, y, z, size = .4, life = .65, color = 0xcafff6) {
    this.emit(x, y, z, 0, 0, 0, { ripple: true, size, life, expand: .9, gravity: 0, opacity: .48, color, floor: y - .1 });
  }
  update(dt) {
    for (let i = 0; i < this.capacity; i++) {
      const p = this.items[i];
      if (!p.alive) { this.opacities[i] = 0; continue; }
      p.t += dt;
      if (p.t > p.life || p.y < p.floor) { p.alive = false; this.opacities[i] = 0; continue; }
      p.vy -= p.gravity * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const f = p.t / p.life;
      this.positions[i * 3] = p.x; this.positions[i * 3 + 1] = p.y; this.positions[i * 3 + 2] = p.z;
      this.sizes[i] = p.size + p.expand * f; this.opacities[i] = p.opacity * (1 - f) * Math.min(1, f * 10 + .35);
    }
    for (const a of Object.values(this.geometry.attributes)) a.needsUpdate = true;
  }
  clear() { this.items.forEach(p => p.alive = false); this.opacities.fill(0); }
  dispose() { this.geometry.dispose(); this.material.dispose(); this.points.removeFromParent(); }
}

export class WaterRenderer {
  constructor(canvas) {
    this.canvas = canvas; this.supported = false; this.modelLoaded = false; this.environmentLoaded = false; this.error = '';
    this.assetInfo = { displayName: 'Blender 原创水花小队', status: 'loading', url: './assets/character-v3.glb', embedded: !!window.WATER_CHARACTER_URL, format: 'GLB', animations: [], clips: {},
      skinnedMeshes: 0, bones: 0, displayedHeight: 2.12, runtime: `Three.js r${THREE.REVISION}`,
      environment: { status: 'loading', url: './assets/environment-v3.glb', embedded: !!window.WATER_ENVIRONMENT_URL } };
    this._destroyed = false; this._actors = new Map(); this._views = []; this._roundId = null; this._eventSeq = 0;
    this._time = 0; this._lastSeconds = null; this._lastState = null; this._random = randomGenerator(864209);
    this._sourceGltf = null; this._sharedDisposables = new Set(); this.drawCalls = 0; this.triangleCount = 0;
    this._environmentPalette = []; this._stageTheme = null;
    this.modelForwardOffset = 0; // Imported character forward +Z; adjust only if source is replaced.
    this._receivingWaterHeight = (x, z) => Math.hypot(x, z) > 7.04 ? POOL + .028 : .045;
    this.modelHeight = 2.12; this.gunHeight = .98; this.muzzleOffset = .35;
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x298a24);
    this.camera = new THREE.OrthographicCamera(-9, 9, 5, -5, .1, 100);
    this._raycaster = new THREE.Raycaster(); this._floorPlane = new THREE.Plane(UP, 0);
    this._pointer = new THREE.Vector2(); this._projected = new THREE.Vector3();
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.0;
      this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this._buildLighting(); this._buildArena(); this._buildFountains();
      this.particles = new WaterParticles(this.scene); this._buildBeamPool(); this.resize();
      this.supported = true;
      this._contextLost = e => { e.preventDefault(); this.supported = false; this.error = '图形上下文已丢失，请重新载入样机。'; };
      canvas.addEventListener('webglcontextlost', this._contextLost, false);
      this.ready = Promise.all([this._loadCharacter(), this._loadEnvironment()]).then(() => {
        this.assetInfo.status = 'ready'; return this.assetInfo;
      });
    } catch (err) {
      this.error = `3D 渲染器启动失败：${err.message || err}`; this.assetInfo.status = 'error'; this.assetInfo.error = this.error;
      this.ready = Promise.reject(new Error(this.error));
    }
    // Retain a rejecting public promise while preventing an unhandled rejection before the UI attaches its handler.
    this.ready.catch(() => {});
  }

  _buildLighting() {
    const hemi = new THREE.HemisphereLight(0xe8f4ed, 0x355921, .95); this.scene.add(hemi);
    const ambient = new THREE.AmbientLight(0xf7eedb, .07); this.scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xfff2d9, 2.3); sun.position.set(-8, 16, 10);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 45 });
    sun.shadow.bias = -.00045; sun.shadow.normalBias = .025; sun.shadow.radius = 4.5; this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xd4ece6, .28); fill.position.set(9, 7, -10); this.scene.add(fill);
    this._lights = { hemi, ambient, sun, fill };
    const pmrem = new THREE.PMREMGenerator(this.renderer), room = new RoomEnvironment();
    this._environmentTarget = pmrem.fromScene(room, .035);
    this.scene.environment = this._environmentTarget.texture; this.scene.environmentIntensity = .35;
    if (room.dispose) room.dispose(); pmrem.dispose();
  }

  _waterMaterial(color, opacity, isPool = false) {
    return new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity }, uPool: { value: isPool ? 1 : 0 } },
      vertexShader: `varying vec3 vWorld;void main(){vec4 p=modelMatrix*vec4(position,1.0);vWorld=p.xyz;gl_Position=projectionMatrix*viewMatrix*p;}`,
      fragmentShader: `
        varying vec3 vWorld; uniform float uTime; uniform vec3 uColor; uniform float uOpacity; uniform float uPool;
        float hashWater(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
        float noiseWater(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hashWater(i),hashWater(i+vec2(1,0)),f.x),mix(hashWater(i+vec2(0,1)),hashWater(i+vec2(1,1)),f.x),f.y);}
        float waterHeight(vec2 p){return noiseWater(p)*.62+noiseWater(p*2.13+7.0)*.26+noiseWater(p*4.37-11.0)*.12;}
        void main(){
          vec2 p=vWorld.xz; float t=uTime;
          vec2 flow=p*mix(2.25,1.45,uPool)+vec2(t*.115,-t*.08);
          flow+=vec2(sin(flow.y*1.35+t*.62),cos(flow.x*1.42-t*.47))*.34;
          flow+=vec2(waterHeight(flow*.73+t*.08),waterHeight(flow*.71+9.0-t*.06))*1.7;
          float wave1=sin(flow.x*3.10+sin(flow.y*2.25+t*.54)*1.65);
          float wave2=sin(flow.y*3.35+cos(flow.x*2.18-t*.48)*1.35);
          // Uneven sheets of reflection: wide bright stretches alternate with genuinely dark gaps.
          // Separate wavelengths avoid turning the whole floor into uniformly thin contour lines.
          float swell=.5+.5*sin(flow.x*.83-flow.y*1.12+t*.71);
          float width1=.075+.28*swell*swell;
          float width2=.035+.112*(.5+.5*cos(flow.y*1.74+flow.x*.52-t*.91));
          float vein1=1.0-smoothstep(width1*.24,width1,abs(wave1+wave2*.27));
          float vein2=1.0-smoothstep(width2*.18,width2,abs(wave2-wave1*.35));
          float breakup1=smoothstep(.33,.66,waterHeight(flow*1.3+t*.09));
          float breakup2=smoothstep(.36,.70,waterHeight(flow*1.6+6.0-t*.11));
          float sheet=(1.0-smoothstep(.08,.34,abs(wave1-wave2*.58)))*smoothstep(.69,.94,swell);
          float veins=clamp(max(vein1*breakup1,vein2*breakup2*.63)+sheet*.50,0.0,1.0);
          float h=waterHeight(flow);
          vec3 n=normalize(vec3((waterHeight(flow+vec2(.055,0))-h)*5.0,1.0,(waterHeight(flow+vec2(0,.055))-h)*5.0));
          vec3 halfLight=normalize(normalize(vec3(-.45,.85,.40))+normalize(vec3(0.0,.46,.89)));
          float shine=pow(max(0.0,dot(n,halfLight)),95.0)*1.45;
          float reflection=clamp(veins*(.65+.35*swell)+shine*.66,0.0,1.0);
          vec3 c=mix(uColor,vec3(1.62,1.70,1.56),reflection);
          float alpha=uOpacity+veins*mix(.28,.18,uPool)+shine*.34;
          gl_FragColor=vec4(c,clamp(alpha,0.0,.88));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `
    });
  }

  _waterfallMaterial() {
    return new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 } },
      vertexShader: `varying vec2 vUv;varying vec3 vWorld;uniform float uTime;
        void main(){vUv=uv;vec3 p=position;float a=atan(p.z,p.x);p.xz*=1.0+.0018*sin(a*71.0+uTime*2.8+p.y*9.0);
        vec4 w=modelMatrix*vec4(p,1.0);vWorld=w.xyz;gl_Position=projectionMatrix*viewMatrix*w;}`,
      fragmentShader: `varying vec2 vUv;varying vec3 vWorld;uniform float uTime;
        void main(){float u=vUv.x*6.2831853;float v=vUv.y;float t=uTime;
          float strand=pow(.5+.5*sin(u*167.0+sin(u*39.0)*2.0+v*1.7),8.0);
          float fine=pow(.5+.5*sin(u*293.0+v*11.0+t*4.8),17.0);
          float rush=.60+.40*sin(v*42.0+t*9.0+sin(u*29.0)*3.5);
          float bottom=1.0-smoothstep(.01,.25,v);
          float top=smoothstep(.88,1.0,v);
          float sheen=clamp(strand*.68+fine*.30+bottom*.35+top*.13,0.0,1.0);
          vec3 c=mix(vec3(.35,.62,.49),vec3(1.68,1.78,1.76),sheen);
          gl_FragColor=vec4(c,.20+strand*.42*rush+fine*.19+bottom*.19);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`
    });
  }

  _foamMaterial() {
    return new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 } },
      vertexShader: `varying vec3 vWorld;void main(){vec4 w=modelMatrix*vec4(position,1.0);vWorld=w.xyz;gl_Position=projectionMatrix*viewMatrix*w;}`,
      fragmentShader: `varying vec3 vWorld;uniform float uTime;
        void main(){vec2 p=vWorld.xz;float r=length(p);float a=atan(p.y,p.x);
          float band=smoothstep(6.98,7.14,r)*(1.0-smoothstep(7.34,7.72,r));
          float turbulence=.58+.22*sin(a*74.0+r*20.0-uTime*3.0)+.20*sin(a*139.0-r*35.0+uTime*4.8);
          float foam=band*smoothstep(.18,.72,turbulence);
          if(foam<.02)discard;
          gl_FragColor=vec4(vec3(1.50,1.69,1.62),foam*.78);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`
    });
  }

  _buildArena() {
    // Environment architecture, radial stone, plants and flowers are all authored in the Blender GLB.
    // This layer contains only animated water, a transparent waterfall curtain and the foam at its foot.
    this.surfaceMaterial = this._waterMaterial(0x617f57, .018);
    this.poolMaterial = this._waterMaterial(0x62b5a1, .53, true);
    this.waterfallMaterial = this._waterfallMaterial(); this.foamMaterial = this._foamMaterial();
    const surface = horizontal(new THREE.CircleGeometry(7.02, 144), this.surfaceMaterial, this.scene, .043); surface.renderOrder = 3;
    this.surfaceMesh = surface;
    const reflectionShader = {
      uniforms: { ...THREE.UniformsUtils.clone(Reflector.ReflectorShader.uniforms), uTime: { value: 0 } },
      vertexShader: Reflector.ReflectorShader.vertexShader
        .replace('varying vec4 vUv;', 'varying vec4 vUv; varying vec2 waterCoord;')
        .replace('vUv = textureMatrix', 'waterCoord=(modelMatrix*vec4(position,1.0)).xz; vUv = textureMatrix'),
      fragmentShader: Reflector.ReflectorShader.fragmentShader
        .replace('varying vec4 vUv;', 'varying vec4 vUv; varying vec2 waterCoord; uniform float uTime;')
        .replace('vec4 base = texture2DProj( tDiffuse, vUv );',
          'vec4 rippleUv=vUv; rippleUv.xy+=vec2(sin(waterCoord.y*7.0+uTime*1.4),cos(waterCoord.x*6.0-uTime*1.2))*.0015*vUv.w; vec4 base=texture2DProj(tDiffuse,rippleUv);')
        .replace('gl_FragColor = vec4( blendOverlay( base.rgb, color ), 1.0 );',
          'gl_FragColor=vec4(base.rgb*vec3(1.0,.98,.94),.40);')
    };
    this.planarWater = new Reflector(new THREE.CircleGeometry(6.98, 112), {
      textureWidth: 512, textureHeight: 512, clipBias: .003, multisample: 0, shader: reflectionShader
    });
    this.planarWater.rotation.x = -Math.PI / 2; this.planarWater.position.y = .029;
    this.planarWater.material.transparent = true; this.planarWater.material.depthWrite = false;
    this.planarWater.renderOrder = 2; this.scene.add(this.planarWater);
    const reflect = this.planarWater.onBeforeRender;
    this.planarWater.onBeforeRender = (...args) => {
      const visible = surface.visible; surface.visible = false;
      try { reflect.apply(this.planarWater, args); } finally { surface.visible = visible; }
    };
    const pool = horizontal(new THREE.RingGeometry(7.01, 11.79, 144), this.poolMaterial, this.scene, POOL); pool.renderOrder = 2;
    const falls = mesh(new THREE.CylinderGeometry(7.035, 7.07, 1.16, 192, 10, true), this.waterfallMaterial, this.scene, 0, -.555, 0); falls.renderOrder = 4;
    const foam = horizontal(new THREE.RingGeometry(6.99, 7.74, 144), this.foamMaterial, this.scene, POOL + .033); foam.renderOrder = 5;
    this._fallMist = 0;
  }

  async _loadEnvironment() {
    const started = performance.now();
    try {
      const gltf = await new GLTFLoader().loadAsync(window.WATER_ENVIRONMENT_URL || './assets/environment-v3.glb');
      if (this._destroyed) throw new Error('Renderer was destroyed while loading the environment.');
      let count = 0, triangles = 0; const names = [], materials = new Set();
      const category = node => {
        const path = []; for (let p = node; p; p = p.parent) path.push(p.name || '');
        return path.join('/').toLowerCase();
      };
      gltf.scene.traverse(node => {
        if (!node.isMesh) return;
        count++; names.push(node.name); node.castShadow = true; node.receiveShadow = true;
        triangles += node.geometry.index ? node.geometry.index.count / 3 : (node.geometry.attributes.position ? node.geometry.attributes.position.count / 3 : 0);
        const label = category(node);
        const convert = original => {
          const floor = /stonefloor/.test(label), foliage = /foliage/.test(label), flower = /flower/.test(label);
          let m;
          if (floor) {
            m = new THREE.MeshPhysicalMaterial({ color: original.color || 0x986139, map: original.map || null,
              normalMap: original.normalMap || null, vertexColors: original.vertexColors || !!node.geometry.attributes.color,
              roughness: .16, metalness: .025, clearcoat: .88, clearcoatRoughness: .13,
              envMapIntensity: .92, side: original.side });
            m.name = `${original.name || 'WetStone'}_PBR`;
          } else {
            m = original.clone();
            if (foliage) { m.roughness = .49; m.metalness = .01; m.side = THREE.DoubleSide; m.color.offsetHSL(0, .065, .006); }
            else if (flower) { m.roughness = .43; m.metalness = 0; if (m.emissive) m.emissive.copy(m.color).multiplyScalar(.055); }
            else { m.roughness = /pool|pedestal/.test(label) ? .32 : .72; m.metalness = .01; }
            m.envMapIntensity = foliage ? .48 : .72;
          }
          materials.add(m);
          this._environmentPalette.push({ material: m, label, color: m.color?.clone(), emissive: m.emissive?.clone() });
          return m;
        };
        node.material = Array.isArray(node.material) ? node.material.map(convert) : convert(node.material);
        if (/lawn/.test(label)) node.castShadow = false;
      });
      if (!count) throw new Error('环境 GLB 没有可显示的网格。');
      gltf.scene.name = 'BlenderEnvironmentV3'; gltf.scene.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(gltf.scene), size = bounds.getSize(new THREE.Vector3());
      this.scene.add(gltf.scene); this.environmentRoot = gltf.scene; this.environmentLoaded = true;
      this._createDecorativeSpouts(gltf.scene);
      this._applyStage(this._lastState?.stage, true);
      Object.assign(this.assetInfo.environment, { status: 'ready', loaded: true, meshes: count, triangles, names, dimensions: size.toArray(), loadMs: Math.round(performance.now() - started) });
      return this.assetInfo.environment;
    } catch (error) {
      this.environmentLoaded = false; this.error = `Blender 场景加载失败：${error.message || error}`;
      this.assetInfo.status = 'error'; Object.assign(this.assetInfo.environment, { status: 'error', loaded: false, error: this.error });
      throw new Error(this.error);
    }
  }

  _createDecorativeSpouts(environment) {
    this._spouts = [];
    for (let i = 0; i < 4; i++) {
      let nozzle = null;
      environment.traverse(node => { if (!nozzle && node.name.startsWith(`Env_SpoutNozzle_${i}`)) nozzle = node; });
      if (!nozzle) continue;
      const start = nozzle.getWorldPosition(new THREE.Vector3()), r = Math.hypot(start.x, start.z) || 1;
      const end = new THREE.Vector3(start.x / r * 7.28, POOL + .027, start.z / r * 7.28);
      const flow = new WaterJet(this.scene, { radius: .052, speed: 2.5, seed: 340 + i });
      this._spouts.push({ start, end, flow });
    }
    if (this.assetInfo.environment) this.assetInfo.environment.decorativeSpouts = this._spouts.length;
  }

  _updateDecorativeSpouts(dt) {
    for (const s of this._spouts || []) {
      s.flow.setEmission(true, s.start, s.end, { hit: true, surface: true, floor: POOL + .027, flight: .63 });
      s.flow.update(dt);
    }
  }

  _buildFountains() {
    this.fountains = [];
    const positions = [[0, 0], [2.8, 0], [0, 2.8], [-2.8, 0], [0, -2.8]];
    const metal = material(0x6c827d, .22, { metalness: .63 });
    positions.forEach(([x, z], i) => {
      const root = new THREE.Group(); root.position.set(x, 0, z); this.scene.add(root);
      const plate = mesh(new THREE.CylinderGeometry(.37, .38, .042, 32), metal, root, 0, .021, 0); plate.receiveShadow = true;
      const grille = horizontal(new THREE.RingGeometry(.09, .30, 32), material(0x354747, .29, { metalness: .40 }), root, .046);
      const ring = horizontal(new THREE.RingGeometry(1.165, 1.20, 64), new THREE.MeshBasicMaterial({ color: 0xbaffdd, transparent: true, opacity: .15, depthWrite: false }), root, .048); ring.renderOrder = 5;
      const inner = horizontal(new THREE.RingGeometry(.32, .82, 48), new THREE.MeshBasicMaterial({ color: 0xdcfff6, transparent: true, opacity: .04, depthWrite: false }), root, .047); inner.renderOrder = 5;
      const flow = new FountainSpray(root, { height: i === 0 ? 3.15 : 2.15, width: i === 0 ? .56 : .40, count: i === 0 ? 3600 : 1800, seed: 880 + i });
      this.fountains.push({ id: i === 0 ? 'center' : 'outer' + (i - 1), root, ring, inner, flow, x, z, index: i, active: false, grille });
    });
  }

  _buildBeamPool() {
    // Allocate only streams in use: four by default, six with the player's triple nozzle.
    // Ownership includes the nozzle index so compact beam arrays cannot steal old water.
    this.beams = []; this._beamEmitters = new Map();
  }

  _getBeamEmitter(actorId, jetIndex) {
    const key = JSON.stringify([actorId, jetIndex]);
    let entry = this._beamEmitters.get(key);
    if (!entry) {
      const flow = new WaterJet(this.scene, { radius: .060, speed: 23, splashScale: 1.25, seed: 1100 + this.beams.length * 37 });
      entry = { flow, actorId, jetIndex }; this._beamEmitters.set(key, entry); this.beams.push(flow);
    }
    return entry;
  }

  _applyStage(stage = {}, force = false) {
    const look = stageAppearance(stage?.theme);
    if (!force && this._stageTheme === look.theme) return;
    this._stageTheme = look.theme; this.scene.background.set(look.background);
    if (this._lights) {
      const { hemi, ambient, sun, fill } = this._lights;
      hemi.color.set(look.sky); hemi.groundColor.set(look.ground); hemi.intensity = look.hemiPower;
      ambient.color.set(look.ambient); ambient.intensity = look.theme === 'moon' ? .16 : .07;
      sun.color.set(look.sun); sun.intensity = look.sunPower;
      fill.color.set(look.fill); fill.intensity = look.fillPower;
    }
    if (this.renderer) this.renderer.toneMappingExposure = look.exposure;
    this.surfaceMaterial?.uniforms.uColor.value.set(look.surface);
    this.poolMaterial?.uniforms.uColor.value.set(look.pool);
    if (this.poolMaterial) this.poolMaterial.uniforms.uOpacity.value = look.poolOpacity;
    for (const saved of this._environmentPalette) {
      const m = saved.material;
      if (saved.color && m.color) {
        m.color.copy(saved.color);
        if (/foliage|lawn|backgarden/.test(saved.label)) m.color.lerp(new THREE.Color(look.foliage), look.foliageMix);
        else if (/stonefloor|platform|pedestal|poolstructure/.test(saved.label)) m.color.lerp(new THREE.Color(look.stone), look.stoneMix);
        else if (/flower/.test(saved.label)) m.color.lerp(new THREE.Color(look.flower), look.flowerMix);
      }
      if (saved.emissive && m.emissive) {
        m.emissive.copy(saved.emissive);
        if (/flower/.test(saved.label)) m.emissive.copy(m.color).multiplyScalar(look.flowerGlow);
      }
    }
    if (this.assetInfo?.environment) this.assetInfo.environment.theme = look.theme;
  }

  async _loadCharacter() {
    const start = performance.now();
    try {
      const gltf = await new GLTFLoader().loadAsync(window.WATER_CHARACTER_URL || './assets/character-v3.glb');
      if (this._destroyed) throw new Error('Renderer was destroyed while loading the model.');
      this._sourceGltf = gltf;
      let skinCount = 0; const bones = new Set(), materialNames = new Set(), meshNames = [];
      gltf.scene.traverse(node => {
        if (node.isSkinnedMesh) { skinCount++; node.skeleton.bones.forEach(b => bones.add(b.name)); }
        if (node.isMesh) { meshNames.push(node.name); (Array.isArray(node.material) ? node.material : [node.material]).forEach(m => materialNames.add(m.name)); }
      });
      if (!skinCount) throw new Error('角色 GLB 不含蒙皮骨骼，无法播放要求的真实角色动画。');
      if (!gltf.animations.length) throw new Error('角色 GLB 不含动画片段。');
      const byName = new Map(gltf.animations.map(a => [cleanName(a.name), a]));
      const choose = (...names) => names.map(n => byName.get(cleanName(n))).find(Boolean);
      const map = {
        idle: choose('Idle_Shoot', 'Idle'), run: choose('Run_Gun', 'Run'), runShoot: choose('Run_Shoot', 'Run_Gun', 'Run'),
        walk: choose('Walk_Shoot', 'Walk'), aim: choose('Idle_Shoot', 'Idle'), shoot: choose('Idle_Shoot'),
        moveAim: choose('Run_Gun', 'Run'), moveShoot: choose('Run_Shoot', 'Run_Gun', 'Run'),
        hit: choose('HitReact'), death: choose('Death'), victory: choose('Wave', 'Yes', 'Idle')
      };
      for (const required of ['idle', 'run', 'hit', 'death']) if (!map[required]) throw new Error(`角色资产缺少必需动画：${required}`);
      this._clipMap = map;
      this.assetInfo.animations = gltf.animations.map(a => a.name);
      this.assetInfo.clips = Object.fromEntries(Object.entries(map).map(([key, value]) => [key, value ? value.name : null]));
      this.assetInfo.skinnedMeshes = skinCount; this.assetInfo.bones = bones.size; this.assetInfo.materials = Array.from(materialNames); this.assetInfo.meshes = meshNames;
      this.assetInfo.directionalLocomotion = '源包无后退/横移片段；当前使用真实持枪移动动画与有限骨盆转向，不声称具备完整四向动作。';
      // Pose the original at the first idle frame before measuring; imported guns have been removed from the delivery GLB.
      const measureMixer = new THREE.AnimationMixer(gltf.scene); measureMixer.clipAction(map.idle).play(); measureMixer.update(0);
      gltf.scene.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(gltf.scene, true), size = bounds.getSize(new THREE.Vector3());
      if (!(size.y > .1 && Number.isFinite(size.y))) throw new Error('角色模型的包围盒无效。');
      this._modelScale = this.modelHeight / size.y;
      // Preserve the authored root in X/Z. The asymmetric aiming pose must not shift the feet behind the logical actor.
      this._modelOffset = new THREE.Vector3(0, -bounds.min.y, 0);
      // Horizontal root positioning remains the core's responsibility. Strip only Root's X/Z travel, keep vertical animation.
      this._clips = gltf.animations.map(clip => {
        const c = clip.clone();
        c.tracks = c.tracks.map(track => {
          if (/\.position$/.test(track.name) && /^(root|characterarmature)(?:_\d+)?$/i.test(trackNode(track))) {
            const t = track.clone(), firstX = t.values[0], firstZ = t.values[2];
            for (let i = 0; i < t.values.length; i += 3) { t.values[i] = firstX; t.values[i + 2] = firstZ; } return t;
          } return track;
        }); return c;
      });
      this._clipMap = Object.fromEntries(Object.entries(map).map(([key, value]) => [key, value ? this._clips.find(c => c.name === value.name) : null]));
      measureMixer.stopAllAction(); measureMixer.uncacheRoot(gltf.scene);
      this.assetInfo.sourceHeight = size.y; this.assetInfo.normalizationScale = this._modelScale;
      for (let i = 0; i < 4; i++) this._views.push(this._createActor(i));
      this.modelLoaded = true;
      if (this.assetInfo.status !== 'error') this.assetInfo.status = this.environmentLoaded ? 'ready' : 'environment-loading';
      this.assetInfo.loadMs = Math.round(performance.now() - start);
      return this.assetInfo;
    } catch (error) {
      this.modelLoaded = false; this.error = `角色模型加载失败：${error.message || error}`;
      this.assetInfo.status = 'error'; this.assetInfo.error = this.error; throw new Error(this.error);
    }
  }

  _createActor(index) {
    const root = new THREE.Group(); root.name = `ActorVisual_${index}`; this.scene.add(root);
    const pose = new THREE.Group(); root.add(pose);
    const normalization = new THREE.Group(); normalization.scale.setScalar(this._modelScale); pose.add(normalization);
    const model = SkeletonUtils.clone(this._sourceGltf.scene); model.position.copy(this._modelOffset); normalization.add(model);
    model.rotation.y += this.modelForwardOffset;
    const actorColor = new THREE.Color(COLORS[index]), boneMap = new Map();
    model.traverse(node => {
      if (node.isBone) boneMap.set(boneKey(node.name), node);
      if (!node.isMesh) return;
      node.castShadow = true; node.receiveShadow = true; node.frustumCulled = false;
      const cloneMaterial = original => {
        const m = original.clone(); m.roughness = .55; m.metalness = .015;
        if (/^Character_Main(?:_|$)/i.test(m.name)) m.color.copy(actorColor);
        if (/^Pants(?:_|$)/i.test(m.name)) m.color.copy(actorColor).multiplyScalar(.57);
        return m;
      };
      node.material = Array.isArray(node.material) ? node.material.map(cloneMaterial) : cloneMaterial(node.material);
    });
    const mixer = new THREE.AnimationMixer(model);
    const upperNames = new Set();
    const upperRoot = boneMap.get('abdomen') || boneMap.get('torso');
    if (upperRoot) upperRoot.traverse(node => { if (node.isBone) upperNames.add(node.name); });
    const isUpper = track => upperNames.has(trackNode(track));
    const parts = {}, actions = {};
    for (const [key, source] of Object.entries(this._clipMap)) {
      if (!source) continue;
      const full = key === 'death' || key === 'victory';
      const upper = ['aim', 'shoot', 'moveAim', 'moveShoot', 'hit'].includes(key);
      const clip = full ? source.clone() : maskedClip(source, `${key}_${index}`, t => upper ? isUpper(t) : !isUpper(t));
      clip.name = `${key}_${index}`; parts[key] = clip;
      const action = mixer.clipAction(clip); action.enabled = true; action.setEffectiveWeight(0);
      action.setLoop((key === 'hit' || key === 'death') ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = key === 'death' || key === 'hit';
      if (!['hit', 'death', 'victory'].includes(key)) action.play(); actions[key] = action;
    }
    actions.idle.setEffectiveWeight(1); if (actions.aim) actions.aim.setEffectiveWeight(1);
    mixer.update(0);
    const ring = horizontal(new THREE.RingGeometry(index === 0 ? .44 : .38, index === 0 ? .49 : .42, 48), new THREE.MeshBasicMaterial({ color: COLORS[index], transparent: true, opacity: index === 0 ? .96 : .50, depthWrite: false }), root, .040); ring.renderOrder = 5;
    let outerRing = null;
    if (index === 0) { outerRing = horizontal(new THREE.RingGeometry(.50, .54, 48), new THREE.MeshBasicMaterial({ color: 0xf5fff8, transparent: true, opacity: .97, depthWrite: false }), root, .041); outerRing.renderOrder = 5; }
    // Soft contact shadow supplements shadow-map filtering at the wet floor.
    const shadow = horizontal(new THREE.CircleGeometry(.47, 32), new THREE.MeshBasicMaterial({ color: 0x203126, transparent: true, opacity: .16, depthWrite: false }), root, .024); shadow.scale.set(1, .8, 1); shadow.renderOrder = 2;
    const gun = this._makeWaterGun(actorColor); root.add(gun);
    const muzzleObject = new THREE.Object3D(); muzzleObject.name = 'WaterMuzzle'; muzzleObject.position.set(0, 0, .35); gun.add(muzzleObject);
    // Calibrate against the real imported grip pose, then preserve that attachment through all actual arm animation.
    root.updateMatrixWorld(true);
    const gripBone = boneMap.get('index1r') || boneMap.get('lowerarmr');
    if (!gripBone) throw new Error('角色骨架缺少右手武器挂点 Index1R / LowerArmR。');
    gripBone.getWorldPosition(tempV);
    gun.position.copy(tempV).add(new THREE.Vector3(0, .08, .04)); gun.quaternion.identity(); gun.scale.setScalar(1);
    root.updateMatrixWorld(true); gripBone.attach(gun);
    const tank = this._makeTank(actorColor); root.add(tank.root);
    const crown = this._makeBossCrown(); crown.visible = false; root.add(crown);
    const view = { index, root, pose, normalization, model, mixer, actions, parts, boneMap, ring, outerRing, shadow, gun, muzzleObject, tank, crown,
      id: null, alive: true, spawnVersion: null, fullState: null, falling: null, hitAt: -10, lastHit: 0, lastShoot: false, aimState: 'aim',
      moveWeight: 0, walkWeight: 0, shotWeight: 0, lean: new THREE.Vector3(), previous: null, stepPhase: 0,
      muzzle: new THREE.Vector3(), muzzleLocal: new THREE.Vector3(0, this.gunHeight, this.muzzleOffset), refillEmit: 0 };
    return view;
  }

  _makeWaterGun(color) {
    const group = new THREE.Group(); group.name = 'OriginalToyWaterGun';
    const bodyMat = material(color, .31), cream = material(0xffe7a4, .37), dark = material(0x416669, .43), rim = material(0xcaf6e8, .29);
    // Barrel axis +Z; the front face is exactly local Z=0.35, matching core muzzle offset.
    const body = mesh(new THREE.CapsuleGeometry(.11, .20, 4, 10), bodyMat, group, 0, 0, -.01); body.rotation.x = Math.PI / 2;
    const barrel = mesh(new THREE.CylinderGeometry(.19, .105, .19, 14), cream, group, 0, 0, .225); barrel.rotation.x = Math.PI / 2;
    const lip = mesh(new THREE.TorusGeometry(.155, .025, 5, 20), rim, group, 0, 0, .33);
    const bore = mesh(new THREE.CircleGeometry(.128, 20), dark, group, 0, 0, .351);
    mesh(new THREE.BoxGeometry(.105, .18, .12), dark, group, 0, -.12, -.075).rotation.x = -.25;
    mesh(new THREE.SphereGeometry(.08, 8, 6), cream, group, 0, .11, -.10).scale.set(1, .6, 1);
    const indicators = Array.from({ length: 3 }, (_, i) => {
      const dot = mesh(new THREE.SphereGeometry(.025, 8, 6), material(0x68ffee, .15, { emissive: 0x3fffe7, emissiveIntensity: .65 }), group, -.075, .09, -.11 + i * .063);
      dot.visible = false; return dot;
    });
    group.userData.upgradeParts = { bodyMat, cream, dark, rim, barrel, lip, bore, indicators, baseColor: color.clone() };
    group.position.y = this.gunHeight; group.traverse(n => { if (n.isMesh) n.castShadow = true; }); return group;
  }

  _makeTank(color) {
    const root = new THREE.Group(); root.name = 'WaterBackpack';
    const shell = material(0xdaf8e9, .12, { transparent: true, opacity: .29, depthWrite: false, metalness: .05 });
    const cap = material(color, .33);
    mesh(new THREE.CylinderGeometry(.19, .19, .51, 14), shell, root, 0, 0, 0);
    mesh(new THREE.CylinderGeometry(.21, .21, .06, 14), cap, root, 0, .275, 0);
    mesh(new THREE.CylinderGeometry(.21, .21, .06, 14), cap, root, 0, -.275, 0);
    const water = mesh(new THREE.CylinderGeometry(.172, .172, .46, 14), material(0x42d5d6, .18, { transparent: true, opacity: .86 }), root, 0, 0, 0);
    const stripe = mesh(new THREE.BoxGeometry(.048, .45, .04), material(0xe0f2d7, .43), root, .19, 0, .0);
    root.position.set(0, .98, -.31); return { root, water, stripe, cap, shell, baseColor: color.clone() };
  }

  _makeBossCrown() {
    const root = new THREE.Group(); root.name = 'BossGoldCrown';
    const gold = material(0xffd353, .22, { metalness: .72, emissive: 0x5d3500, emissiveIntensity: .18 });
    const band = mesh(new THREE.TorusGeometry(.26, .033, 6, 28), gold, root, 0, 2.14, -.018); band.rotation.x = Math.PI / 2;
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * TAU;
      mesh(new THREE.ConeGeometry(.050, .17, 5), gold, root, Math.sin(a) * .24, 2.235, Math.cos(a) * .24 - .018);
    }
    mesh(new THREE.SphereGeometry(.044, 10, 8), material(0x55e5ec, .16, { emissive: 0x269db8, emissiveIntensity: .5 }), root, 0, 2.16, .254);
    return root;
  }

  _updateEquipment(view, actor) {
    const look = weaponAppearance(actor.weapon, actor), parts = view.gun.userData.upgradeParts;
    view.root.scale.setScalar(look.bossScale); view.crown.visible = actor.role === 'boss';
    view.ring.material.color.set(actor.role === 'boss' ? 0xffd04f : COLORS[view.index]);
    view.ring.material.opacity = actor.role === 'boss' ? .98 : view.index === 0 ? .96 : .50;
    if (parts) {
      parts.bodyMat.color.copy(parts.baseColor); parts.bodyMat.metalness = look.upgraded ? .26 : .02;
      parts.cream.color.set(look.upgraded ? 0xffd168 : 0xffe7a4); parts.cream.metalness = look.upgraded ? .64 : .02;
      parts.rim.color.set(look.upgraded ? 0x8ffff0 : 0xcaf6e8);
      parts.rim.emissive.set(look.upgraded ? 0x249f91 : 0x000000); parts.rim.emissiveIntensity = look.upgraded ? .40 : 0;
      parts.barrel.scale.set(look.muzzleScale, 1, look.muzzleScale);
      parts.lip.scale.set(look.muzzleScale, look.muzzleScale, 1); parts.bore.scale.set(look.muzzleScale, look.muzzleScale, 1);
      parts.indicators.forEach((dot, index) => { dot.visible = look.upgraded && index < Math.max(1, Math.min(3, look.tier)); });
    }
    view.tank.root.scale.set(look.tankScale, 1 + (look.tankScale - 1) * .45, look.tankScale);
    view.tank.cap.color.copy(look.upgraded ? new THREE.Color(0xffd168) : view.tank.baseColor);
    view.tank.cap.metalness = look.upgraded ? .55 : .02;
    view.tank.water.material.color.set(look.upgraded ? 0x62fff0 : 0x42d5d6);
    view.tank.stripe.material.color.set(look.upgraded ? 0xffdb82 : 0xe0f2d7);
    return look;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect(), width = Math.max(1, rect.width || 960), height = Math.max(1, rect.height || 600);
    this._width = width; this._height = height;
    const aspect = width / height;
    // Fit the actual game viewport rather than assuming a 16:9 page. The disk remains about
    // 95% of its width; camera elevation adapts so the floor occupies roughly 75% of its height.
    const halfW = 7.40, halfH = halfW / aspect;
    this.camera.left = -halfW; this.camera.right = halfW; this.camera.top = halfH; this.camera.bottom = -halfH;
    const elevation = Math.asin(clamp(.75 * halfH / 7, .30, .88)), targetY = .65;
    this.camera.position.set(0, 22 * Math.sin(elevation) + targetY, 22 * Math.cos(elevation)); this.camera.lookAt(0, targetY, 0);
    this.camera.updateProjectionMatrix(); this.camera.updateMatrixWorld(true);
    if (this.renderer) this.renderer.setSize(width, height, false);
    if (this.particles) this.particles.material.uniforms.uScale.value = height / (halfH * 2) * (this.renderer ? this.renderer.getPixelRatio() : 1);
  }

  screenToWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect(); this._pointer.set((clientX - rect.left) / rect.width * 2 - 1, 1 - (clientY - rect.top) / rect.height * 2);
    this._raycaster.setFromCamera(this._pointer, this.camera);
    const point = this._raycaster.ray.intersectPlane(this._floorPlane, this._projected);
    return point ? { x: point.x, y: point.z } : { x: NaN, y: NaN };
  }
  worldToScreen(x, y, height = 0) {
    const rect = this.canvas.getBoundingClientRect(); this._projected.set(x, height, y).project(this.camera);
    return { x: rect.left + (this._projected.x + 1) * rect.width / 2, y: rect.top + (1 - this._projected.y) * rect.height / 2 };
  }

  _resetRound(state) {
    this._roundId = state.roundId; this._eventSeq = 0; this._actors.clear(); this.particles.clear();
    for (const flow of this.beams) { flow.setEmission(false); flow.reset(); }
    for (const f of this.fountains) f.flow.reset();
    for (const v of this._views) {
      v.id = null; v.alive = true; v.spawnVersion = null; v.fullState = null; v.falling = null; v.hitAt = -10; v.lastHit = 0; v.previous = null;
      v.moveWeight = 0; v.walkWeight = 0; v.shotWeight = 0; v.lastShoot = false; v.stepPhase = 0; v.root.visible = true; v.pose.rotation.set(0, 0, 0);
      v.mixer.stopAllAction();
      for (const [key, action] of Object.entries(v.actions)) { action.reset(); action.enabled = true; action.setEffectiveWeight(key === 'idle' || key === 'aim' ? 1 : 0); if (!['hit', 'death', 'victory'].includes(key)) action.play(); }
      v.aimState = 'aim';
    }
  }

  _event(state, event) {
    const v = this._actors.get(event.actorId); if (!v) return;
    const actor = (state.actors || []).find(a => a.id === event.actorId);
    if (event.type === 'respawn' && actor?.alive === true) this._respawn(v, actor);
    if (event.type === 'elimination') this._fall(v, actor, event);
    if (event.type === 'hit' && this._time - v.hitAt > .30 && !v.falling) this._hit(v);
  }

  _respawn(v, actor) {
    if (!actor || actor.alive !== true) return;
    v.alive = true; v.spawnVersion = Number.isInteger(actor.spawnVersion) ? actor.spawnVersion : 0;
    v.falling = null; v.fullState = null; v.previous = null; v.hitAt = -10; v.lastHit = 0;
    v.moveWeight = 0; v.walkWeight = 0; v.shotWeight = 0; v.lastShoot = false;
    v.stepPhase = 0; v.refillEmit = 0; v.aimState = 'aim'; v.lean.set(0, 0, 0);
    v.pose.rotation.set(0, 0, 0);
    v.root.visible = true; v.root.position.set(actor.x || 0, .035, actor.y || 0);
    v.root.rotation.set(0, Math.PI / 2 - (actor.angle || 0), 0);
    v.ring.visible = true; if (v.outerRing) v.outerRing.visible = true; v.shadow.visible = true;
    v.gun.visible = true; v.tank.root.visible = true;
    v.mixer.stopAllAction();
    for (const [key, action] of Object.entries(v.actions)) {
      action.stop().reset(); action.enabled = true; action.paused = false;
      action.setEffectiveTimeScale(1); action.setEffectiveWeight(key === 'idle' || key === 'aim' ? 1 : 0);
      if (!['hit', 'death', 'victory'].includes(key)) action.play();
    }
    v.mixer.update(0); v.root.updateMatrixWorld(true);
    v.muzzleObject.getWorldPosition(v.muzzle);
    // A resurrected hand must not interpolate its first packet from the old falling socket.
    for (const entry of this._beamEmitters.values()) if (entry.actorId === actor.id) {
      entry.flow.setEmission(false); entry.flow.reset();
    }
  }
  _hit(v) {
    if (!v.actions.hit) return; v.hitAt = this._time;
    v.actions.hit.reset().setEffectiveWeight(.75).play();
  }
  _fall(v, actor, event = null) {
    if (!actor || v.falling) return;
    const old = v.previous || actor, x = event && Number.isFinite(event.x) ? event.x : actor.x, z = event && Number.isFinite(event.y) ? event.y : actor.y;
    let dx = old.vx || old.kx || x, dz = old.vy || old.ky || z; const len = Math.hypot(dx, dz) || 1; dx /= len; dz /= len;
    v.falling = { start: this._time, x, z, dx, dz, splash: false }; v.alive = false; v.fullState = 'death';
    for (const [key, action] of Object.entries(v.actions)) if (key !== 'death') action.fadeOut(.13);
    v.actions.death.reset().setLoop(THREE.LoopOnce, 1).setEffectiveWeight(1).fadeIn(.12).play(); v.actions.death.clampWhenFinished = true;
  }
  _celebrate(v) {
    if (v.fullState === 'victory' || !v.actions.victory) return; v.fullState = 'victory';
    for (const [key, action] of Object.entries(v.actions)) if (key !== 'victory') action.fadeOut(.25);
    v.actions.victory.reset().setEffectiveWeight(1).fadeIn(.25).play();
  }

  _updateActor(v, actor, state, dt) {
    const version = Number.isInteger(actor.spawnVersion) ? actor.spawnVersion : 0;
    if (v.spawnVersion == null) v.spawnVersion = version;
    else if (version !== v.spawnVersion && actor.alive === true) this._respawn(v, actor);
    const t = this._time; v.root.visible = true; this._updateEquipment(v, actor);
    if (actor.alive === false && !v.falling) this._fall(v, actor);
    const winning = state.phase === 'result' && state.result && Array.isArray(state.result.winners) && state.result.winners.includes(actor.id) && actor.alive !== false;
    if (winning) this._celebrate(v);
    const mx = Number.isFinite(actor.mx) ? actor.mx : (actor.vx || 0), my = Number.isFinite(actor.my) ? actor.my : (actor.vy || 0);
    const speed = Math.hypot(mx, my), kSpeed = Math.hypot(actor.kx || 0, actor.ky || 0);
    const angle = actor.angle || 0, desiredYaw = Math.PI / 2 - angle;
    v.root.position.set(actor.x || 0, .035, actor.y || 0); v.root.rotation.set(0, desiredYaw, 0);
    const canMove = actor.alive !== false && state.phase === 'playing';
    const movement = canMove ? clamp(speed / .65, 0, 1) : 0;
    v.moveWeight = expTo(v.moveWeight, movement, 12, dt);
    v.shotWeight = expTo(v.shotWeight, actor.shooting ? 1 : 0, actor.shooting ? 19 : 14, dt);
    const walkWeight = clamp(1 - speed / 2.1, 0, 1);
    v.walkWeight = expTo(v.walkWeight, walkWeight, 9, dt);
    if (!v.fullState) {
      const idleWeight = 1 - v.moveWeight;
      v.actions.idle.setEffectiveWeight(idleWeight);
      const runWeight = v.moveWeight * (1 - v.walkWeight), walk = v.moveWeight * v.walkWeight;
      v.actions.run.setEffectiveWeight(runWeight * (1 - v.shotWeight));
      if (v.actions.runShoot) v.actions.runShoot.setEffectiveWeight(runWeight * v.shotWeight);
      if (v.actions.walk) v.actions.walk.setEffectiveWeight(walk);
      const rate = clamp(speed / 3.2, .42, 1.45);
      v.actions.run.setEffectiveTimeScale(rate); if (v.actions.runShoot) v.actions.runShoot.setEffectiveTimeScale(rate); if (v.actions.walk) v.actions.walk.setEffectiveTimeScale(clamp(speed / 1.5, .6, 1.7));
      // Keep real imported gait cycles phase-aligned during crossfades.
      v.stepPhase += dt * rate / Math.max(.2, v.parts.run.duration);
      for (const name of ['run', 'runShoot', 'walk']) if (v.actions[name]) v.actions[name].time = (v.stepPhase % 1) * v.parts[name].duration;
      for (const name of ['moveAim', 'moveShoot']) if (v.actions[name]) { v.actions[name].setEffectiveTimeScale(rate); v.actions[name].time = (v.stepPhase % 1) * v.parts[name].duration; }
      const desiredUpper = speed > .35 && canMove ? (actor.shooting ? 'moveShoot' : 'moveAim') : (actor.shooting ? 'shoot' : 'aim');
      if (desiredUpper !== v.aimState && v.actions[desiredUpper]) {
        const previous = v.actions[v.aimState], next = v.actions[desiredUpper]; next.reset().setEffectiveWeight(1).play();
        if (previous) previous.crossFadeTo(next, actor.shooting ? .08 : .11, false); v.aimState = desiredUpper;
      }
      const hitAge = t - v.hitAt, hitDuration = Math.min(.48, v.parts.hit ? v.parts.hit.duration : .4);
      const hitWeight = hitAge < hitDuration ? .64 * Math.sin(clamp(hitAge / hitDuration, 0, 1) * Math.PI) : 0;
      if (v.actions.hit) v.actions.hit.setEffectiveWeight(hitWeight);
      // Keep crossFadeTo's fade envelopes intact. The hit layer blends on top of the active real aim action.
      if (actor.hit > .01 && v.lastHit <= .01 && t - v.hitAt > .28) this._hit(v);
      v.lastHit = actor.hit || 0;
    }
    v.mixer.update(dt);
    // Imported keyframes remain the main motion. Small additive bone offsets provide directional resistance.
    const net = Math.hypot(actor.kx || 0, actor.ky || 0), resistance = clamp(net / 4.5, 0, 1);
    const fwd = (actor.kx || 0) * Math.cos(angle) + (actor.ky || 0) * Math.sin(angle);
    const right = -(actor.kx || 0) * Math.sin(angle) + (actor.ky || 0) * Math.cos(angle);
    v.lean.x = expTo(v.lean.x, canMove ? clamp(-fwd * .022, -.12, .12) : 0, 13, dt);
    v.lean.z = expTo(v.lean.z, canMove ? clamp(right * .018, -.10, .10) : 0, 13, dt);
    v.pose.rotation.x = v.lean.x; v.pose.rotation.z = v.lean.z;
    if (!v.fullState) {
      const hips = v.boneMap.get('body') || v.boneMap.get('hips'), torso = v.boneMap.get('abdomen');
      const forwardSpeed = mx * Math.cos(angle) + my * Math.sin(angle), rightSpeed = -mx * Math.sin(angle) + my * Math.cos(angle);
      const twist = speed > .15 ? clamp(Math.atan2(rightSpeed, Math.abs(forwardSpeed) + .3), -.30, .30) * v.moveWeight : 0;
      if (hips) hips.quaternion.multiply(tempQ.setFromAxisAngle(UP, -twist));
      if (torso) torso.quaternion.multiply(tempQ.setFromAxisAngle(UP, twist));
    }
    if (v.falling) {
      const f = v.falling, age = t - f.start;
      v.root.position.set(f.x + f.dx * Math.min(age * .65, .60), .035 - .6 * age - 3.3 * age * age, f.z + f.dz * Math.min(age * .65, .60));
      v.pose.rotation.x += Math.min(.50, age * .55);
      v.ring.visible = false; if (v.outerRing) v.outerRing.visible = false; v.shadow.visible = false;
      if (age > .53 && !f.splash) { f.splash = true; this._splash(v.root.position.x, POOL + .025, v.root.position.z, 42, 1.4); }
      if (age > 1.05) v.root.visible = false;
    } else {
      v.ring.visible = true; if (v.outerRing) v.outerRing.visible = true; v.shadow.visible = true;
    }
    // The toy gun follows the imported hand bone. Only its visible jet start follows the animated socket;
    // hit determination and the terminal point remain the core's unchanged logical beam.
    v.gun.visible = actor.alive !== false && !winning;
    const capacity = Number.isFinite(actor.weapon?.waterCapacity) && actor.weapon.waterCapacity > 0 ? actor.weapon.waterCapacity : 100;
    const fill = clamp((actor.water == null ? capacity : actor.water) / capacity, .002, 1);
    v.tank.water.scale.y = fill; v.tank.water.position.y = -.23 + fill * .23;
    v.tank.root.visible = !v.falling || t - v.falling.start < .85;
    const lowerBodyBob = v.boneMap.get('body');
    if (lowerBodyBob) {
      v.model.updateMatrixWorld(true); lowerBodyBob.getWorldPosition(tempV); v.root.worldToLocal(tempV);
      v.tank.root.position.y = clamp(tempV.y + .25, .83, 1.12);
    }
    if (canMove && speed > .25) {
      const currentStep = Math.floor(v.stepPhase * 2), oldStep = v.previous ? v.previous.step : currentStep;
      if (currentStep !== oldStep) {
        const side = currentStep % 2 ? -1 : 1, sx = actor.x - Math.sin(angle) * .20 * side, sz = actor.y + Math.cos(angle) * .20 * side;
        this._splash(sx, .055, sz, 7, .26); this.particles.ripple(sx, .045, sz, .15, .42);
      }
    }
    if (actor.refilling && actor.alive !== false) {
      v.refillEmit += dt * 12;
      while (v.refillEmit >= 1) { v.refillEmit--; const a = this._random() * TAU; this.particles.emit(actor.x + Math.cos(a) * .34, .10, actor.y + Math.sin(a) * .34, 0, .8, 0, { life: .65, size: .075, gravity: 0, color: 0x8fffe0 }); }
    }
    v.root.updateMatrixWorld(true); v.muzzleObject.getWorldPosition(v.muzzle);
    v.previous = { x: actor.x, y: actor.y, vx: actor.vx, vy: actor.vy, kx: actor.kx, ky: actor.ky, step: Math.floor(v.stepPhase * 2) };
    v.lastShoot = !!actor.shooting;
  }

  _splash(x, y, z, count, strength) {
    for (let i = 0; i < count; i++) { const a = this._random() * TAU, s = (.25 + this._random()) * strength;
      this.particles.emit(x, y, z, Math.cos(a) * s, (.35 + this._random()) * strength, Math.sin(a) * s,
        { life: .35 + this._random() * .35, size: .045 + this._random() * .085, floor: y - .08, color: i % 3 ? 0xdafcf0 : 0xffffff });
    }
    if (count > 15) this.particles.ripple(x, y + .01, z, .4, .85);
  }

  _updateFountains(state, dt) {
    for (const f of this.fountains) {
      const source = (state.fountains || []).find(p => p.id === f.id);
      if (source && Number.isFinite(source.x) && Number.isFinite(source.y)) {
        f.x = source.x; f.z = source.y; f.root.position.set(f.x, 0, f.z);
      }
      const active = source ? !!source.active : f.index === 0, preview = source && source.preview;
      f.active = active;
      const refillScale = (source && source.radius ? source.radius : 1.2) / 1.2;
      f.ring.scale.set(refillScale, refillScale, refillScale);
      f.ring.material.color.set(active ? 0xb8ffe1 : preview ? 0xffe496 : 0xafc6ac);
      f.ring.material.opacity = active ? .35 : preview ? .12 + .12 * (1 + Math.sin(this._time * 9)) : .04;
      f.inner.material.opacity = active ? .06 : .01;
      f.flow.update(dt, active);
    }
    this._fallMist += dt * 105;
    while (this._fallMist >= 1) {
      this._fallMist--; const a = this._random() * TAU, r = 7.09 + this._random() * .30;
      this.particles.emit(Math.cos(a) * r, POOL + .08, Math.sin(a) * r, Math.cos(a) * .13, .10 + this._random() * .27, Math.sin(a) * .13,
        { life: .46 + this._random() * .40, size: .11 + this._random() * .16, floor: POOL + .008, gravity: .8, opacity: .34, color: 0xf0fff9, expand: .12 });
    }
  }

  _updateBeams(state, dt) {
    const actors = new Map((state.actors || []).map(actor => [actor.id, actor])), active = new Map();
    for (const beam of state.beams || []) {
      const actor = actors.get(beam.actorId), index = beam.jetIndex == null ? 0 : beam.jetIndex;
      if (!actor || actor.alive === false || beam.active === false || !Number.isInteger(index) || index < 0 || index > 2) continue;
      if (!Number.isFinite(beam.x2) || !Number.isFinite(beam.y2)) continue;
      const entry = this._getBeamEmitter(actor.id, index); active.set(entry, beam);
    }
    for (const entry of this._beamEmitters.values()) {
      const { flow, actorId } = entry, actor = actors.get(actorId), beam = active.get(entry), from = actor && this._actors.get(actor.id);
      const look = weaponAppearance(actor?.weapon, actor);
      flow.radius = look.radius; flow.splashScale = look.splashScale;
      flow.mesh.material.uniforms.uPower.value = look.highlight;
      if (beam && from && actor.alive !== false) {
        const a = from.muzzle, b = new THREE.Vector3(beam.x2, a.y, beam.y2);
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        const range = Number.isFinite(actor.weapon?.range) && actor.weapon.range > 0 ? actor.weapon.range : 5;
        if (beam.targetId == null) b.y = Math.max(.08, a.y - .28 * Math.pow(length / range, 2));
        flow.setEmission(length > .04, a, b, { hit: beam.targetId != null, contactId: beam.targetId, floor: .045, floorAt: this._receivingWaterHeight });
      } else flow.setEmission(false);
      flow.update(dt);
    }
  }

  render(state = {}, seconds = 0) {
    if (!this.supported || this._destroyed || !this.renderer) return;
    const rect = this.canvas.getBoundingClientRect(); if (Math.abs(rect.width - this._width) > .5 || Math.abs(rect.height - this._height) > .5) this.resize();
    const now = Number.isFinite(seconds) ? seconds : 0;
    let dt = this._lastSeconds == null ? 0 : clamp(now - this._lastSeconds, 0, .06); this._lastSeconds = now;
    if (state.phase === 'paused' || state.paused) dt = 0; this._time += dt;
    this._lastState = state;
    this._applyStage(state.stage);
    if (state.roundId != null && state.roundId !== this._roundId) this._resetRound(state);
    const actors = state.actors || [];
    if (this.modelLoaded) {
      for (let i = 0; i < this._views.length; i++) { const v = this._views[i], actor = actors[i]; v.root.visible = !!actor; if (actor) { v.id = actor.id; this._actors.set(actor.id, v); } }
      for (const event of state.events || []) {
        if (event.seq != null && event.seq <= this._eventSeq) continue;
        if (event.seq != null) this._eventSeq = Math.max(this._eventSeq, event.seq);
        if (event.roundId == null || state.roundId == null || event.roundId === state.roundId) this._event(state, event);
      }
      for (let i = 0; i < actors.length && i < this._views.length; i++) this._updateActor(this._views[i], actors[i], state, dt);
    }
    this.surfaceMaterial.uniforms.uTime.value = this._time; this.poolMaterial.uniforms.uTime.value = this._time;
    if (this.planarWater) this.planarWater.material.uniforms.uTime.value = this._time;
    this.waterfallMaterial.uniforms.uTime.value = this._time; this.foamMaterial.uniforms.uTime.value = this._time;
    this._updateFountains(state, dt); this._updateDecorativeSpouts(dt); this._updateBeams(state, dt); this.particles.update(dt);
    this.renderer.render(this.scene, this.camera);
    this.drawCalls = this.renderer.info.render.calls; this.triangleCount = this.renderer.info.render.triangles;
  }

  destroy() {
    this._destroyed = true; this.supported = false;
    if (this._contextLost) this.canvas.removeEventListener('webglcontextlost', this._contextLost, false);
    for (const v of this._views) { v.mixer.stopAllAction(); v.mixer.uncacheRoot(v.model); }
    for (const flow of this.beams || []) flow.dispose();
    for (const s of this._spouts || []) s.flow.dispose();
    for (const f of this.fountains || []) f.flow.dispose();
    const geometries = new Set(), materials = new Set(), textures = new Set();
    this.scene.traverse(node => {
      if (node.geometry) geometries.add(node.geometry);
      if (node.material) (Array.isArray(node.material) ? node.material : [node.material]).forEach(m => materials.add(m));
    });
    materials.forEach(m => { for (const value of Object.values(m)) if (value && value.isTexture) textures.add(value); m.dispose(); });
    geometries.forEach(g => g.dispose()); textures.forEach(t => t.dispose());
    if (this.planarWater) this.planarWater.dispose();
    this.scene.clear(); if (this._environmentTarget) this._environmentTarget.dispose();
    if (this.renderer) this.renderer.dispose(); this._actors.clear(); this._views.length = 0;
  }
}

window.WaterRenderer = WaterRenderer;
