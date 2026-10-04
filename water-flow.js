import * as THREE from './vendor/three.module.js';

const TAU = Math.PI * 2, UP = new THREE.Vector3(0, 1, 0);
const clamp = THREE.MathUtils.clamp;
function random(seed) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296; }; }
function viewport(points, material) {
  const size = new THREE.Vector2();
  points.onBeforeRender = renderer => {
    const target = renderer.getRenderTarget();
    material.uniforms.uViewport.value = target ? target.height : renderer.getDrawingBufferSize(size).y;
  };
}
const dropFragment = `
  varying float vOpacity; varying float vStretch; varying float vAngle; varying float vFoam;
  void main(){
    vec2 p=gl_PointCoord*2.0-1.0;
    float c=cos(vAngle),s=sin(vAngle);
    vec2 q=vec2(c*p.x+s*p.y,-s*p.x+c*p.y); q.y*=vStretch;
    float d=dot(q,q); if(d>1.0)discard;
    float edge=1.0-smoothstep(.38,1.0,d);
    float rim=pow(clamp(d,0.0,1.0),2.0);
    float glint=pow(max(0.0,1.0-length(q-vec2(-.25,-.30))/.59),5.0);
    vec3 clear=mix(vec3(.36,.65,.68),vec3(1.05,1.16,1.15),rim*.55+glint*.8);
    vec3 foam=vec3(.94,1.07,1.05);
    vec3 col=mix(clear,foam,vFoam);
    float alpha=edge*vOpacity*(.48+rim*.40+glint*.42+vFoam*.24);
    if(alpha<.018)discard;
    gl_FragColor=vec4(col,alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

/** All rings lie on the actual receiving water plane. */
class Ripples {
  constructor(parent, capacity = 40) {
    this.items = Array.from({ length: capacity }, () => ({ alive: false, age: 0, life: 1 })); this.cursor = 0;
    const geo = new THREE.PlaneGeometry(1, 1); geo.rotateX(-Math.PI / 2);
    this.opacity = new Float32Array(capacity);
    geo.setAttribute('aOpacity', new THREE.InstancedBufferAttribute(this.opacity, 1));
    const mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false,
      vertexShader: `attribute float aOpacity;varying vec2 vUv;varying float vOpacity;
        void main(){vUv=uv;vOpacity=aOpacity;gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.0);}`,
      fragmentShader: `varying vec2 vUv;varying float vOpacity;void main(){
        float r=length(vUv*2.0-1.0);
        float a=(1.0-smoothstep(.018,.065,abs(r-.85)))*.70;
        a+=(1.0-smoothstep(.015,.046,abs(r-.61)))*.25;
        if(a*vOpacity<.006)discard;gl_FragColor=vec4(.89,1.04,1.01,a*vOpacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }` });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity); this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.mesh.renderOrder = 6;
    this.obj = new THREE.Object3D(); parent.add(this.mesh); this.update(0);
  }
  emit(x, y, z, radius = .65, strength = .30) {
    Object.assign(this.items[this.cursor++ % this.items.length], { alive: true, x, y, z, radius, strength, age: 0, life: .58 + radius * .46 });
  }
  update(dt) {
    this.items.forEach((p, i) => {
      p.age += dt;
      if (!p.alive || p.age >= p.life) { p.alive = false; this.opacity[i] = 0; this.obj.position.set(0, 0, 0); this.obj.scale.set(0, 0, 0); }
      else {
        const f = p.age / p.life, r = .11 + p.radius * f;
        this.obj.position.set(p.x, p.y, p.z); this.obj.scale.set(r * 2, 1, r * 2);
        this.opacity[i] = p.strength * (1 - f) * Math.min(1, f * 15 + .1);
      }
      this.obj.updateMatrix(); this.mesh.setMatrixAt(i, this.obj.matrix);
    });
    this.mesh.instanceMatrix.needsUpdate = true; this.mesh.geometry.attributes.aOpacity.needsUpdate = true;
  }
  reset() { this.items.forEach(p => p.alive = false); this.update(0); }
  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.mesh.removeFromParent(); }
}

/** Detached droplets retain their launch position and momentum in world space. */
class Droplets {
  constructor(parent, ripples, capacity = 640) {
    this.ripples = ripples; this.cursor = 0; this.items = Array.from({ length: capacity }, () => ({ alive: false }));
    this.position = new Float32Array(capacity * 3); this.velocity = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity); this.opacity = new Float32Array(capacity); this.foam = new Float32Array(capacity);
    const geo = new THREE.BufferGeometry();
    for (const [name, array, width] of [['position', this.position, 3], ['aVelocity', this.velocity, 3], ['aSize', this.size, 1], ['aOpacity', this.opacity, 1], ['aFoam', this.foam, 1]])
      geo.setAttribute(name, new THREE.BufferAttribute(array, width).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, uniforms: { uViewport: { value: 700 } },
      vertexShader: `attribute vec3 aVelocity;attribute float aSize;attribute float aOpacity;attribute float aFoam;
        uniform float uViewport;varying float vOpacity;varying float vStretch;varying float vAngle;varying float vFoam;
        void main(){vec4 p=modelViewMatrix*vec4(position,1.0);vec3 vel=mat3(viewMatrix)*aVelocity;
          vOpacity=aOpacity;vFoam=aFoam;vStretch=clamp(1.0+length(vel)*.075,1.0,2.15);
          vAngle=atan(-vel.y,vel.x);gl_Position=projectionMatrix*p;
          float perspective=projectionMatrix[2][3]<-.5?max(.05,-p.z):1.0;
          gl_PointSize=max(1.0,aSize*vStretch*uViewport*.5*projectionMatrix[1][1]/perspective);
        }`, fragmentShader: dropFragment });
    this.points = new THREE.Points(geo, mat); this.points.frustumCulled = false; this.points.renderOrder = 8;
    parent.add(this.points); viewport(this.points, mat);
  }
  emit(position, velocity, options = {}) {
    const p = this.items[this.cursor++ % this.items.length];
    Object.assign(p, { alive: true, x: position.x, y: position.y, z: position.z, vx: velocity.x, vy: velocity.y, vz: velocity.z,
      age: 0, life: options.life || .52, size: options.size || .055, gravity: options.gravity == null ? 9.8 : options.gravity,
      floor: options.floor == null ? .04 : options.floor, opacity: options.opacity == null ? .78 : options.opacity,
      floorAt: options.floorAt || null, foam: options.foam || 0, ripple: options.ripple !== false, drag: options.drag == null ? .6 : options.drag });
  }
  update(dt) {
    this.items.forEach((p, i) => {
      if (!p.alive) { this.opacity[i] = 0; return; }
      const drag = Math.exp(-p.drag * dt); p.vx *= drag; p.vz *= drag;
      p.x += p.vx * dt; p.z += p.vz * dt; p.y += p.vy * dt - .5 * p.gravity * dt * dt; p.vy -= p.gravity * dt; p.age += dt;
      if (p.floorAt) { const floor = p.floorAt(p.x, p.z); if (Number.isFinite(floor)) p.floor = floor; }
      if (p.y <= p.floor && p.age > .035) {
        if (p.ripple && i % 3 === 0) this.ripples.emit(p.x, p.floor + .007, p.z, .23 + p.size * 3, .23);
        p.alive = false;
      }
      if (p.age >= p.life) p.alive = false;
      this.position.set([p.x, p.y, p.z], i * 3); this.velocity.set([p.vx, p.vy, p.vz], i * 3);
      this.size[i] = p.size; this.foam[i] = p.foam;
      this.opacity[i] = p.alive ? p.opacity * Math.min(1, (1 - p.age / p.life) * 3) : 0;
    });
    Object.values(this.points.geometry.attributes).forEach(a => a.needsUpdate = true);
  }
  reset() { this.items.forEach(p => p.alive = false); this.update(0); }
  dispose() { this.points.geometry.dispose(); this.points.material.dispose(); this.points.removeFromParent(); }
}

/** An advected stream: the old water continues on its own when the muzzle turns or stops. */
export class WaterJet {
  constructor(scene, options = {}) {
    this.group = new THREE.Group(); this.group.name = 'AdvectedWaterJet'; scene.add(this.group);
    this.radius = options.radius || .032; this.splashScale = options.splashScale || 1; this.speed = options.speed || 22; this.rng = random(options.seed || 701);
    this.active = false; this.clock = 0; this.rate = 230; this.emitCarry = 0; this.serial = 0;
    this.origin = new THREE.Vector3(); this.end = new THREE.Vector3(); this.previousOrigin = new THREE.Vector3(); this.previousEnd = new THREE.Vector3(); this.spawnOrigin = new THREE.Vector3(); this.spawnEnd = new THREE.Vector3(); this.opts = {};
    this.packets = Array.from({ length: 200 }, () => ({ alive: false, age: 0, life: 1 })); this.cursor = 0;
    this.ripples = new Ripples(this.group); this.drops = new Droplets(this.group, this.ripples);
    const max = 128, sides = 8; this.max = max; this.sides = sides;
    this.positions = new Float32Array(max * sides * 3); this.normals = new Float32Array(max * sides * 3);
    this.uv = new Float32Array(max * sides * 2); const indices = [];
    for (let j = 0; j < max - 1; j++) for (let k = 0; k < sides; k++) {
      const a = j * sides + k, b = j * sides + (k + 1) % sides, c = a + sides, d = b + sides;
      indices.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry(); geo.setIndex(indices);
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.normals, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, side: THREE.FrontSide,
      uniforms: { uTime: { value: 0 }, uPower: { value: 1 } },
      vertexShader: `varying vec3 vNormal;varying vec3 vView;varying vec2 vUv;
        void main(){vec4 p=modelViewMatrix*vec4(position,1.0);vView=-p.xyz;vNormal=normalMatrix*normal;vUv=uv;gl_Position=projectionMatrix*p;}`,
      fragmentShader: `uniform float uTime,uPower;varying vec3 vNormal;varying vec3 vView;varying vec2 vUv;
        void main(){vec3 n=normalize(vNormal),v=normalize(vView);float fresnel=pow(1.0-abs(dot(n,v)),2.2);
          float wave=.5+.5*sin(vUv.x*126.0-uTime*66.0+sin(vUv.y*6.283)*2.0);
          float glint=pow(max(0.0,dot(n,normalize(vec3(-.3,.75,.58)))),20.0);
          float broken=mix(1.0,smoothstep(.12,.56,wave),smoothstep(.70,1.0,vUv.x));
          float flowBand=smoothstep(.78,.98,.5+.5*sin(vUv.x*52.0-uTime*85.0));
          vec3 c=mix(vec3(.43,.72,.79),vec3(1.25,1.38,1.38)*uPower,clamp(fresnel*.60+glint*.72+flowBand*.34,0.0,1.0));
          float alpha=(.23+fresnel*.35+glint*.24+flowBand*.12)*broken*(1.0+(uPower-1.0)*.18);
          gl_FragColor=vec4(c,alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }` });
    this.mesh = new THREE.Mesh(geo, mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 7;
    this.group.add(this.mesh);
    this._tangent = new THREE.Vector3(); this._side = new THREE.Vector3(); this._normal = new THREE.Vector3();
    this._position = new THREE.Vector3(); this._velocity = new THREE.Vector3(); this._impactIndex = 0;
  }
  setEmission(active, start, end, options = {}) {
    const wasActive = this.active;
    const changedContact = !!active && !!options.hit && (!this.active || options.contactId !== this.contactId);
    this.active = !!active; this.contactId = options.contactId;
    if (start) this.origin.copy(start); if (end) this.end.copy(end); this.opts = options;
    if (!wasActive) { this.previousOrigin.copy(this.origin); this.previousEnd.copy(this.end); }
    if (changedContact && !options.surface && start && end) {
      const dx = end.x - start.x, dz = end.z - start.z;
      this._impact({ endX: end.x, endY: end.y, endZ: end.z, vx: dx, vz: dz, floor: options.floor == null ? .04 : options.floor, surface: false });
    }
  }
  _spawn(age, dt) {
    const fraction = dt > 0 ? clamp(1 - age / dt, 0, 1) : 1;
    const a = this.spawnOrigin.lerpVectors(this.previousOrigin, this.origin, fraction), b = this.spawnEnd.lerpVectors(this.previousEnd, this.end, fraction), dx = b.x - a.x, dz = b.z - a.z;
    const distance = Math.hypot(dx, dz); if (!Number.isFinite(distance) || distance < .025) return;
    const travel = this.opts.flight || clamp(distance / this.speed, .035, .62), gravity = this.opts.gravity == null ? 9.8 : this.opts.gravity;
    const p = this.packets[this.cursor++ % this.packets.length];
    Object.assign(p, { alive: true, serial: this.serial++, age, travel, gravity,
      x0: a.x, y0: a.y, z0: a.z, vx: dx / travel, vz: dz / travel,
      vy: (b.y - a.y + .5 * gravity * travel * travel) / travel,
      floor: this.opts.floor == null ? .04 : this.opts.floor, floorAt: this.opts.floorAt || null, hit: !!this.opts.hit, surface: !!this.opts.surface,
      endX: b.x, endY: b.y, endZ: b.z, shed: false });
  }
  _impact(p) {
    const speed = Math.hypot(p.vx, p.vz) || 1, dx = p.vx / speed, dz = p.vz / speed;
    const surface = p.surface || p.endY <= p.floor + .08;
    const n = (surface ? 3 : 4) + Math.max(0, Math.round((this.splashScale - 1.25) * 3));
    for (let i = 0; i < n; i++) {
      const side = (this.rng() - .5) * (surface ? 1.3 : 2.2), back = surface ? (this.rng() - .5) * 1.3 : -.8 - this.rng() * 1.4;
      this._position.set(p.endX, Math.max(p.floor + .016, p.endY), p.endZ);
      this._velocity.set(dx * back - dz * side, .7 + this.rng() * (surface ? .8 : 1.45), dz * back + dx * side);
      this.drops.emit(this._position, this._velocity, { life: .45 + this.rng() * .25, size: (.032 + this.rng() * .045) * this.splashScale, floor: p.floor, floorAt: p.floorAt, foam: surface ? .4 : .1, opacity: .84 });
    }
    if (surface && this._impactIndex % 3 === 0) this.ripples.emit(p.endX, p.floor + .008, p.endZ, .35 + this.rng() * .35, .28);
  }
  update(dt) {
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, .10); this.clock += dt;
    for (const p of this.packets) if (p.alive) p.age += dt;
    if (this.active && dt > 0) {
      this.emitCarry += dt * this.rate;
      while (this.emitCarry >= 1) { this.emitCarry--; this._spawn(this.emitCarry / this.rate, dt); }
    } else if (!this.active) this.emitCarry = 0;
    const live = [];
    for (const p of this.packets) {
      if (!p.alive) continue;
      const t = Math.min(p.age, p.travel);
      p.x = p.x0 + p.vx * t; p.y = p.y0 + p.vy * t - .5 * p.gravity * t * t; p.z = p.z0 + p.vz * t;
      if (p.age >= p.travel) {
        if (p.serial % 4 === 0) {
          this._impactIndex++;
          if (p.hit) this._impact(p);
          else {
            this._position.set(p.x, Math.max(p.floor + .025, p.y), p.z);
            this._velocity.set(p.vx * .14, p.vy - p.gravity * t, p.vz * .14);
            this.drops.emit(this._position, this._velocity, { floor: p.floor, floorAt: p.floorAt, size: (.036 + this.rng() * .028) * this.splashScale, life: .60, opacity: .79 });
          }
        }
        p.alive = false; continue;
      }
      if (!p.shed && p.age > p.travel * .70 && p.serial % 7 === 0 && dt > 0) {
        p.shed = true; this._position.set(p.x, p.y, p.z);
        this._velocity.set(p.vx * .13 - p.vz / this.speed * .15, p.vy - p.gravity * t - .35, p.vz * .13 + p.vx / this.speed * .15);
        this.drops.emit(this._position, this._velocity, { floor: p.floor, floorAt: p.floorAt, size: (.025 + this.rng() * .021) * this.splashScale, life: .50, opacity: .71 });
      }
      live.push(p);
    }
    live.sort((a, b) => b.serial - a.serial);
    const count = Math.min(this.max, live.length);
    this.mesh.visible = count >= 2; this.mesh.material.uniforms.uTime.value = this.clock;
    for (let j = 0; j < count; j++) {
      const p = live[j], prev = live[Math.max(0, j - 1)], next = live[Math.min(count - 1, j + 1)];
      this._tangent.set(next.x - prev.x, next.y - prev.y, next.z - prev.z).normalize();
      this._side.crossVectors(this._tangent, Math.abs(this._tangent.y) > .95 ? new THREE.Vector3(1, 0, 0) : UP).normalize();
      this._normal.crossVectors(this._side, this._tangent).normalize();
      const progress = p.age / p.travel, radius = this.radius * (1 - .42 * progress) * (1 + .13 * Math.sin(this.clock * 38 - progress * 77));
      for (let k = 0; k < this.sides; k++) {
        const a = k / this.sides * TAU, cx = Math.cos(a), cy = Math.sin(a), index = j * this.sides + k;
        const nx = this._side.x * cx + this._normal.x * cy, ny = this._side.y * cx + this._normal.y * cy, nz = this._side.z * cx + this._normal.z * cy;
        this.positions.set([p.x + nx * radius, p.y + ny * radius, p.z + nz * radius], index * 3);
        this.normals.set([nx, ny, nz], index * 3); this.uv.set([progress, k / this.sides], index * 2);
      }
    }
    this.mesh.geometry.setDrawRange(0, Math.max(0, count - 1) * this.sides * 6);
    Object.values(this.mesh.geometry.attributes).forEach(a => a.needsUpdate = true);
    this.drops.update(dt); this.ripples.update(dt);
    if (this.active) { this.previousOrigin.copy(this.origin); this.previousEnd.copy(this.end); }
  }
  reset() { this.active = false; this.contactId = null; this.previousOrigin.copy(this.origin); this.previousEnd.copy(this.end); this.packets.forEach(p => p.alive = false); this.emitCarry = 0; this.drops.reset(); this.ripples.reset(); this.update(0); }
  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.drops.dispose(); this.ripples.dispose(); this.group.removeFromParent(); }
}

/** GPU ballistic water; switching off stops emission, rather than deleting the water in flight. */
export class FountainSpray {
  constructor(parent, options = {}) {
    this.clock = 0; this.first = true; this.active = false; this.on = -100; this.off = -100; this.rippleCarry = 0;
    this.height = options.height || 3.1; this.width = options.width || .58; this.rng = random(options.seed || 291);
    const count = options.count || 1450, seeds = new Float32Array(count * 4), sizes = new Float32Array(count), phases = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      seeds.set([this.rng(), this.rng(), this.rng(), this.rng()], i * 4);
      phases[i] = this.rng(); sizes[i] = .016 + this.rng() * .039;
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4)); geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1)); geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    const mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false,
      uniforms: { uTime: { value: 0 }, uOn: { value: -100 }, uOff: { value: -100 }, uHeight: { value: this.height }, uWidth: { value: this.width }, uViewport: { value: 700 } },
      vertexShader: `attribute vec4 aSeed;attribute float aPhase;attribute float aSize;
        uniform float uTime,uOn,uOff,uHeight,uWidth,uViewport;varying float vOpacity,vStretch,vAngle,vFoam;
        void main(){
          float g=9.8,vy=sqrt(2.0*g*uHeight)*(.82+aSeed.z*.18);
          float life=(vy+sqrt(vy*vy+2.0*g*.075))/g;
          float age=mod(uTime+aPhase*life,life),born=uTime-age;
          float angle=aSeed.x*6.2831853, r=sqrt(aSeed.y)*uWidth*.27;
          float lateral=(.14+pow(aSeed.w,2.0)*.68)*uWidth/.58;
          vec3 velocity=vec3(cos(angle)*lateral,vy-g*age,sin(angle)*lateral);
          vec3 pos=vec3(cos(angle)*(r+lateral*age),.09+vy*age-.5*g*age*age,sin(angle)*(r+lateral*age));
          vec4 p=modelViewMatrix*vec4(pos,1.0);vec3 vel=mat3(modelViewMatrix)*velocity;
          float valid=step(uOn,born)*step(born,uOff);
          vStretch=clamp(1.0+abs(velocity.y)*.08,1.0,1.8);vAngle=atan(-vel.y,vel.x);
          float apex=1.0-smoothstep(.0,2.5,abs(velocity.y));
          vFoam=clamp(.42+apex*.5+aSeed.w*.20,0.0,1.0);
          vOpacity=valid*(.67+apex*.20)*(1.0-smoothstep(.88,1.0,age/life)*.60);
          float size=aSize*(1.0+apex*.35);
          float perspective=projectionMatrix[2][3]<-.5?max(.05,-p.z):1.0;
          gl_PointSize=max(1.0,size*vStretch*uViewport*.5*projectionMatrix[1][1]/perspective);
          gl_Position=projectionMatrix*p;
        }`, fragmentShader: dropFragment });
    this.points = new THREE.Points(geo, mat); this.points.frustumCulled = false; this.points.renderOrder = 7;
    parent.add(this.points); viewport(this.points, mat);
    // A continuous aerated rise is surrounded by individually falling ballistic droplets.
    // The shader follows emission time; it never bobs or scales the whole fountain.
    const coreGeo = new THREE.CylinderGeometry(this.width*.18,this.width*.35,this.height*.96,16,44,true);
    coreGeo.translate(0,this.height*.48+.085,0);
    const coreMat = new THREE.ShaderMaterial({transparent:true,depthWrite:false,side:THREE.DoubleSide,
      uniforms: { uTime:{value:0},uOn:{value:-100},uOff:{value:-100},uHeight:{value:this.height} },
      vertexShader: `uniform float uTime,uHeight;varying vec2 vUv;varying float vHeight;varying vec3 vNormal;
        void main(){vUv=uv;vec3 p=position;float a=atan(p.z,p.x),h=p.y/uHeight;
          float ripple=sin(p.y*17.0-uTime*24.0+a*3.0)*.07+sin(p.y*39.0-uTime*42.0-a*5.0)*.045;
          p.xz*=1.0+ripple;vHeight=p.y;vNormal=normalMatrix*normal;
          gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);}`,
      fragmentShader: `uniform float uTime,uOn,uOff,uHeight;varying vec2 vUv;varying float vHeight;varying vec3 vNormal;
        float hsh(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
        float nse(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hsh(i),hsh(i+vec2(1,0)),f.x),mix(hsh(i+vec2(0,1)),hsh(i+vec2(1)),f.x),f.y);}
        void main(){float v=sqrt(19.6*uHeight),y=max(0.0,vHeight-.085);
          float travel=(v-sqrt(max(.0,v*v-19.6*y)))/9.8,born=uTime-travel;
          float valid=step(uOn,born)*step(born,uOff);
          float n=nse(vec2(vUv.x*14.0,vUv.y*22.0-uTime*10.0))*.65+nse(vec2(vUv.x*31.0,vUv.y*46.0-uTime*19.0))*.35;
          float top=1.0-smoothstep(.68,1.0,vUv.y);
          float edge=.45+.55*pow(1.0-abs(normalize(vNormal).z),.75);
          vec3 c=mix(vec3(.53,.80,.77),vec3(1.12,1.25,1.22),smoothstep(.2,.7,n));
          gl_FragColor=vec4(c,valid*top*(.28+n*.44)*edge);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`});
    this.core = new THREE.Mesh(coreGeo,coreMat);this.core.renderOrder=6;parent.add(this.core);
    const foamGeo = new THREE.CircleGeometry(this.width * 1.65, 64); foamGeo.rotateX(-Math.PI / 2);
    const foamMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false,
      uniforms: { uTime: { value: 0 }, uStrength: { value: 0 } },
      vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
      fragmentShader: `uniform float uTime,uStrength;varying vec2 vUv;
        float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
        float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1)),f.x),f.y);}
        void main(){vec2 p=vUv*2.0-1.0;float r=length(p);float n=noise(p*10.0+uTime*.45)*.65+noise(p*23.0-uTime*.83)*.35;
          float coverage=(1.0-smoothstep(.45,.98,r))*(.13+.57*smoothstep(.37,.70,n));
          gl_FragColor=vec4(.94,1.08,1.04,coverage*uStrength);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }` });
    this.foam = new THREE.Mesh(foamGeo, foamMat); this.foam.position.y = .055; this.foam.renderOrder = 5; parent.add(this.foam);
    this.ripples = new Ripples(parent, 24); this.strength = 0;
  }
  update(dt, active) {
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, .1); this.clock += dt; active = !!active;
    if (this.first) { this.on = active ? -100 : this.clock; this.off = active ? 1e8 : -100; this.first = false; }
    else if (active !== this.active) { if (active) { this.on = this.clock; this.off = 1e8; } else this.off = this.clock; }
    this.active = active; const life = Math.sqrt(8 * this.height / 9.8);
    this.points.visible = active || this.clock - this.off <= life + .1;
    const uniforms = this.points.material.uniforms; uniforms.uTime.value = this.clock; uniforms.uOn.value = this.on; uniforms.uOff.value = this.off;
    this.core.visible = this.points.visible;this.core.material.uniforms.uTime.value = this.clock;this.core.material.uniforms.uOn.value = this.on;this.core.material.uniforms.uOff.value = this.off;
    const returnFlow = (active && this.clock - this.on > life * .64) || (!active && this.clock - this.off < life * .78);
    this.strength = THREE.MathUtils.lerp(this.strength, returnFlow ? .86 : 0, 1 - Math.exp(-dt * 4.5));
    this.foam.material.uniforms.uTime.value = this.clock; this.foam.material.uniforms.uStrength.value = this.strength;
    if (returnFlow) this.rippleCarry += dt * 6;
    while (this.rippleCarry >= 1) {
      this.rippleCarry--; const a = this.rng() * TAU, r = this.width * (.58 + this.rng() * .74);
      this.ripples.emit(Math.cos(a) * r, .065, Math.sin(a) * r, .40 + this.rng() * .38, .26);
    }
    this.ripples.update(dt);
  }
  reset() {
    this.first = true; this.active = false; this.on = -100; this.off = -100; this.strength = 0; this.rippleCarry = 0;
    for (const m of [this.points.material, this.core.material]) {m.uniforms.uOn.value = -100;m.uniforms.uOff.value = -100;}
    this.points.visible = false;this.core.visible = false;this.foam.material.uniforms.uStrength.value = 0;this.ripples.reset();
  }
  dispose() { this.points.geometry.dispose(); this.points.material.dispose(); this.points.removeFromParent(); this.core.geometry.dispose();this.core.material.dispose();this.core.removeFromParent(); this.foam.geometry.dispose(); this.foam.material.dispose(); this.foam.removeFromParent(); this.ripples.dispose(); }
}
