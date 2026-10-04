import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/addons/loaders/GLTFLoader.js';
import { WaterJet } from './water-flow.js';
import { weaponAppearance } from './renderer_v3.js';

const MOTIONS = ['idle', 'run', 'shoot', 'hit', 'fall'];
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const WEAPON_NAMES = /^(AK|GrenadeLauncher|Knife_\d+|Pistol|Revolver(?:_Small)?|RocketLauncher|ShortCannon|Shotgun|Shovel|SMG|Sniper(?:_\d+)?)$/i;

/** A separate asset/animation preview. It never reads or changes WaterGameCore. */
export class CharacterViewer {
  constructor(canvas, metadata = {}) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#edf4f7');
    this.scene.fog = new THREE.Fog('#edf4f7', 9, 18);
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.05, 50);
    this.camera.position.set(1.6, 1.8, 4.15);
    this.camera.lookAt(0, 1.03, 0);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.16;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.stage = new THREE.Group();
    this.stage.rotation.y = 0.12;
    this.stage.position.y = 0.035;
    this.scene.add(this.stage);
    this._motion = 'idle';
    this._weapon = Object.freeze({ visualScale: 1, tier: 0, jetCount: 1, spreadAngle: .14, range: 5, waterCapacity: 110 });
    this._lastTime = null;
    this._motionAge = 0;
    this._actions = new Map();
    this._currentAction = null;
    this._rootMotion = [];
    this._overlayBone = null;
    this._overlayApplied = false;
    this._overlayBase = new THREE.Quaternion();
    this._overlayRotation = new THREE.Quaternion();
    this._overlayAxis = new THREE.Vector3(1, 0, 0);
    this.assetInfo = {
      ...metadata, loaded: false, path: './assets/character-v3.glb', normalizedHeight: 2,
      animationNames: [], boneNames: [], motions: {}, selectedMotion: 'idle',
      hasSkinnedMesh: false, gunAttachment: null, error: null
    };
    this._createLighting();
    this._createGround();
    this.resize();
    this.ready = this._load().catch(error => {
      this.assetInfo.error = error.message || String(error);
      throw error;
    });
  }

  _createLighting() {
    this.scene.add(new THREE.HemisphereLight('#edfaff', '#91a3aa', 2.0));
    const key = new THREE.DirectionalLight('#fff6e8', 3.2);
    key.position.set(-3, 5, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -2.8, right: 2.8, top: 3.5, bottom: -2.8, near: 0.5, far: 14 });
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.015;
    key.shadow.radius = 4;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight('#d4efff', 1.35);
    fill.position.set(4, 2.5, 2);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight('#fff8ec', 2.3);
    rim.position.set(1.5, 4, -3);
    this.scene.add(rim);
  }

  _createGround() {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({ color: '#edf4f7', roughness: 1, metalness: 0 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.105;
    ground.receiveShadow = true;
    this.scene.add(ground);
    const platform = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.24, 0.1, 64),
      new THREE.MeshStandardMaterial({ color: '#f7fafb', roughness: 0.85 }));
    platform.position.y = -0.05;
    platform.receiveShadow = true;
    this.scene.add(platform);
    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = shadowCanvas.height = 128;
    const context = shadowCanvas.getContext('2d');
    const gradient = context.createRadialGradient(64, 64, 6, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(44,64,74,0.22)');
    gradient.addColorStop(0.45, 'rgba(44,64,74,0.10)');
    gradient.addColorStop(1, 'rgba(44,64,74,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
    const contactShadow = new THREE.Mesh(new THREE.PlaneGeometry(1.65, 1.65),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(shadowCanvas),
        transparent: true, depthWrite: false, toneMapped: false }));
    contactShadow.rotation.x = -Math.PI / 2;
    contactShadow.position.y = 0.006;
    this.scene.add(contactShadow);
  }

  async _load() {
    const gltf = await new GLTFLoader().loadAsync(window.WATER_CHARACTER_URL || './assets/character-v3.glb');
    this.model = gltf.scene;
    const bones = [];
    const materialCache = new Map();
    this.model.traverse(object => {
      if (object.isBone) bones.push(object);
      if (object.isSkinnedMesh) this.assetInfo.hasSkinnedMesh = true;
      // The source soldier ships with several weapon alternatives on one hand.
      // Hide any remaining alternatives before measuring the character itself.
      if (object.isMesh && WEAPON_NAMES.test(object.name)) object.visible = false;
      if (!object.isMesh) return;
      object.castShadow = object.receiveShadow = true;
      const recolor = material => {
        if (!materialCache.has(material)) {
          const copy = material.clone();
          if (/character_main/i.test(copy.name)) copy.color.set('#56bfc9');
          if (/pants/i.test(copy.name)) copy.color.set('#3e5368');
          if ('roughness' in copy) copy.roughness = Math.max(0.55, copy.roughness);
          if ('metalness' in copy) copy.metalness = Math.min(0.1, copy.metalness);
          materialCache.set(material, copy);
        }
        return materialCache.get(material);
      };
      object.material = Array.isArray(object.material) ? object.material.map(recolor) : recolor(object.material);
    });
    this.assetInfo.boneNames = bones.map(bone => bone.name);
    this.clips = gltf.animations;
    this.assetInfo.animationNames = this.clips.map(clip => clip.name);
    this.mixer = new THREE.AnimationMixer(this.model);
    this._chooseClips();
    for (const clip of this.clips) this._actions.set(clip.name, this.mixer.clipAction(clip));
    const referenceClip = this.motionClips.idle || this.clips[0];
    if (referenceClip) {
      const referenceAction = this._actions.get(referenceClip.name);
      referenceAction.play();
      this.mixer.update(0.01);
      this._currentAction = referenceAction;
    }
    this.model.updateMatrixWorld(true);
    this.model.traverse(object => {
      if (object.isSkinnedMesh) { object.skeleton.update(); object.computeBoundingBox(); }
    });
    // Box3 includes invisible alternatives; calculate only visible mesh bounds.
    const bounds = new THREE.Box3();
    this.model.traverse(object => {
      if (!object.isMesh || !object.visible) return;
      let ancestor = object.parent;
      while (ancestor && ancestor !== this.model) {
        if (!ancestor.visible) return;
        ancestor = ancestor.parent;
      }
      bounds.union(new THREE.Box3().setFromObject(object, true));
    });
    if (bounds.isEmpty()) throw new Error('角色 GLB 没有可显示的网格。');
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const scale = 2 / Math.max(size.y, 0.001);
    this.normalized = new THREE.Group();
    this.normalized.scale.setScalar(scale);
    const offset = new THREE.Group();
    offset.position.set(-center.x, -bounds.min.y, -center.z);
    offset.add(this.model);
    this.normalized.add(offset);
    this.stage.add(this.normalized);
    this.assetInfo.sourceHeight = size.y;
    this.assetInfo.scale = scale;
    this._overlayBone = bones.find(bone => /^(Torso|Spine2|Chest)$/i.test(bone.name)) ||
      bones.find(bone => /spine|torso|chest/i.test(bone.name)) || null;
    this._attachWaterGun(bones);
    this._attachWaterTank(bones);
    this._applyWeapon();
    this.assetInfo.loaded = true;
    this.assetInfo.availableMotions = MOTIONS.filter(motion => !!this.motionClips[motion]);
    this.setMotion(this._motion);
    this.resize();
    return this;
  }

  _chooseClips() {
    const exact = name => this.clips.find(clip => clip.name.toLowerCase() === name.toLowerCase());
    const match = expression => this.clips.find(clip => expression.test(clip.name));
    this.motionClips = {
      idle: exact('Idle_Shoot') || exact('Idle') || match(/idle|stand/i),
      run: exact('Run_Gun') || exact('Run_Shoot') || exact('Run') || match(/run/i) || match(/walk/i),
      shoot: exact('Idle_Shoot') || match(/shoot|fire|firing/i),
      hit: exact('HitReact') || match(/hit|hurt|damage|impact/i),
      fall: exact('Death') || match(/death|dead|fall|dying/i)
    };
    for (const motion of MOTIONS) {
      const clip = this.motionClips[motion];
      this.assetInfo.motions[motion] = {
        clipName: clip ? clip.name : null,
        source: clip ? 'external-clip' : motion === 'hit' ? 'bone-overlay' : 'unavailable',
        duration: clip ? clip.duration : null,
        note: clip ? `真实外部片段：${clip.name}` : motion === 'hit' ?
          '缺少独立受击片段；只叠加真实骨骼短促受击。' :
          `缺少${{ idle: '待机', run: '跑步', shoot: '射击', fall: '倒下' }[motion]}片段；保持可用待机姿态。`
      };
    }
  }

  _attachWaterGun(bones) {
    const hand = bones.find(bone => /^Index1[._]?R$/i.test(bone.name)) ||
      bones.find(bone => /(?:RightHand|Hand[._]R|hand_r|r_hand)$/i.test(bone.name)) ||
      bones.find(bone => /^(LowerArm[._]?R|RightForeArm)$/i.test(bone.name));
    if (!hand) { this.assetInfo.gunAttachment = '未找到右手挂点'; return; }
    const gun = new THREE.Group();
    gun.name = 'Viewer_WaterGun';
    const mint = new THREE.MeshStandardMaterial({ color: '#a0e2df', roughness: 0.35 });
    const cream = new THREE.MeshStandardMaterial({ color: '#fff4df', roughness: 0.42 });
    const orange = new THREE.MeshStandardMaterial({ color: '#f5ae58', roughness: 0.35 });
    const mesh = (geometry, material, x, y, z, rotateX = 0) => {
      const part = new THREE.Mesh(geometry, material);
      part.position.set(x, y, z); part.rotation.x = rotateX;
      part.castShadow = true; gun.add(part); return part;
    };
    mesh(new THREE.CapsuleGeometry(0.075, 0.16, 6, 12), mint, 0, 0.07, 0.075, Math.PI / 2);
    const barrel = mesh(new THREE.CylinderGeometry(0.052, 0.052, 0.16, 16), cream, 0, 0.07, 0.265, Math.PI / 2);
    const lip = mesh(new THREE.TorusGeometry(0.043, 0.012, 6, 16), orange, 0, 0.07, 0.348);
    mesh(new THREE.CapsuleGeometry(0.026, 0.08, 4, 8), cream, 0, -0.03, 0);
    mesh(new THREE.SphereGeometry(0.066, 14, 10), orange, 0, 0.13, -0.055);
    const indicators = Array.from({ length: 3 }, (_, index) => {
      const material = new THREE.MeshStandardMaterial({ color: '#68ffee', roughness: .15,
        emissive: '#3fffe7', emissiveIntensity: .65 });
      const dot = mesh(new THREE.SphereGeometry(.012, 8, 6), material, -.062, .1, -.025 + index * .052);
      dot.visible = false; return dot;
    });
    gun.userData.upgradeParts = { mint, cream, orange, barrel, lip, indicators,
      baseMint: mint.color.clone(), baseCream: cream.color.clone(), baseOrange: orange.color.clone() };
    gun.position.set(0.01, 0.15, -0.054);
    hand.add(gun);
    this.scene.updateMatrixWorld(true);
    const handWorldScale = hand.getWorldScale(new THREE.Vector3());
    gun.scale.set(1 / handWorldScale.x, 1 / handWorldScale.y, 1 / handWorldScale.z);
    const handWorldRotation = hand.getWorldQuaternion(new THREE.Quaternion());
    const desiredWorldRotation = this.stage.getWorldQuaternion(new THREE.Quaternion());
    gun.quaternion.copy(handWorldRotation.invert().multiply(desiredWorldRotation));
    this.gun = gun;
    this._createWaterSpray(gun);
    this.assetInfo.gunAttachment = hand.name;
    this.assetInfo.gunSource = '本地程序圆角玩具水枪，挂在真实骨骼；不是外部 GLB 动画片段。';
  }

  _attachWaterTank(bones) {
    const torso = this._overlayBone || bones.find(bone => /spine|torso|chest/i.test(bone.name));
    if (!torso) return;
    const root = new THREE.Group(); root.name = 'Viewer_WaterBackpack';
    const shell = new THREE.MeshStandardMaterial({ color: '#daf8e9', roughness: .12,
      transparent: true, opacity: .29, depthWrite: false, metalness: .05 });
    const cap = new THREE.MeshStandardMaterial({ color: '#a0e2df', roughness: .33, metalness: .02 });
    const waterMat = new THREE.MeshStandardMaterial({ color: '#42d5d6', roughness: .18,
      transparent: true, opacity: .86 });
    const stripeMat = new THREE.MeshStandardMaterial({ color: '#e0f2d7', roughness: .43 });
    const part = (geometry, material, x, y, z) => {
      const object = new THREE.Mesh(geometry, material); object.position.set(x, y, z);
      object.castShadow = true; root.add(object); return object;
    };
    part(new THREE.CylinderGeometry(.19, .19, .51, 14), shell, 0, 0, 0);
    part(new THREE.CylinderGeometry(.21, .21, .06, 14), cap, 0, .275, 0);
    part(new THREE.CylinderGeometry(.21, .21, .06, 14), cap, 0, -.275, 0);
    const water = part(new THREE.CylinderGeometry(.172, .172, .46, 14), waterMat, 0, 0, 0);
    const stripe = part(new THREE.BoxGeometry(.048, .45, .04), stripeMat, .19, 0, 0);
    this.scene.updateMatrixWorld(true);
    const desiredPosition = this.stage.localToWorld(new THREE.Vector3(0, .98, -.31));
    root.position.copy(torso.worldToLocal(desiredPosition)); torso.add(root);
    const parentScale = torso.getWorldScale(new THREE.Vector3());
    root.scale.set(1 / parentScale.x, 1 / parentScale.y, 1 / parentScale.z);
    root.quaternion.copy(torso.getWorldQuaternion(new THREE.Quaternion()).invert()
      .multiply(this.stage.getWorldQuaternion(new THREE.Quaternion())));
    this.tank = { root, water, stripe, cap, baseScale: root.scale.clone(), baseColor: cap.color.clone() };
  }

  /** A cosmetic equipment preview: never purchases upgrades or changes a campaign save. */
  setWeapon(weapon = {}) {
    weapon ||= {};
    const finite = (value, fallback, min, max) => clamp(Number.isFinite(value) ? value : fallback, min, max);
    const nextWeapon = {
      visualScale: finite(weapon.visualScale, 1, 1, 2),
      tier: Math.round(finite(weapon.tier, 0, 0, 9)),
      jetCount: Math.round(finite(weapon.jetCount, 1, 1, 3)),
      spreadAngle: finite(weapon.spreadAngle, .14, 0, Math.PI / 3),
      range: finite(weapon.range, 5, 1, 12),
      waterCapacity: finite(weapon.waterCapacity, 110, 10, 1000)
    };
    if (this._weapon && Object.keys(nextWeapon).every(key => nextWeapon[key] === this._weapon[key])) {
      return { ...this._weapon };
    }
    this._weapon = Object.freeze(nextWeapon);
    this._applyWeapon();
    return { ...this._weapon };
  }

  _applyWeapon() {
    const look = weaponAppearance(this._weapon), parts = this.gun?.userData.upgradeParts;
    if (parts) {
      parts.mint.color.copy(parts.baseMint); parts.mint.metalness = look.upgraded ? .26 : 0;
      parts.cream.color.copy(look.upgraded ? new THREE.Color(0xffd168) : parts.baseCream);
      parts.cream.metalness = look.upgraded ? .64 : 0;
      parts.orange.color.copy(look.upgraded ? new THREE.Color(0x8ffff0) : parts.baseOrange);
      parts.orange.emissive.set(look.upgraded ? 0x249f91 : 0);
      parts.orange.emissiveIntensity = look.upgraded ? .40 : 1;
      parts.barrel.scale.set(look.muzzleScale, 1, look.muzzleScale);
      parts.lip.scale.set(look.muzzleScale, look.muzzleScale, 1);
      parts.indicators.forEach((dot, index) => {
        dot.visible = look.upgraded && index < Math.max(1, Math.min(3, look.tier));
      });
    }
    if (this.tank) {
      this.tank.root.scale.copy(this.tank.baseScale)
        .multiply(new THREE.Vector3(look.tankScale, 1 + (look.tankScale - 1) * .45, look.tankScale));
      this.tank.cap.color.copy(look.upgraded ? new THREE.Color(0xffd168) : this.tank.baseColor);
      this.tank.cap.metalness = look.upgraded ? .55 : .02;
      this.tank.water.material.color.set(look.upgraded ? 0x62fff0 : 0x42d5d6);
      this.tank.stripe.material.color.set(look.upgraded ? 0xffdb82 : 0xe0f2d7);
    }
    if (this._waterJets) {
      while (this._waterJets.length < this._weapon.jetCount) this._waterJets.push(
        new WaterJet(this.scene, { radius: .032, speed: 14, splashScale: 1.25, seed: 41 + this._waterJets.length * 211 }));
      for (const flow of this._waterJets) {
        flow.radius = .032 * look.visualScale; flow.splashScale = look.splashScale;
        flow.mesh.material.uniforms.uPower.value = look.highlight;
        flow.reset();
      }
    }
    this.assetInfo.weapon = { ...this._weapon };
  }

  _createWaterSpray(gun) {
    // Only the nozzle follows the hand. Already emitted water stays in world space.
    this._waterMuzzle = new THREE.Object3D();
    this._waterMuzzle.name = 'Viewer_WaterMuzzle';
    this._waterMuzzle.position.set(0, 0.07, 0.365);
    gun.add(this._waterMuzzle);
    this._waterJet = new WaterJet(this.scene, { radius: .032, speed: 14, splashScale: 1.25, seed: 41 });
    this._waterJets = [this._waterJet];
    this._waterStart = new THREE.Vector3();
    this._waterEnd = new THREE.Vector3();
    this._waterFront = new THREE.Vector3();
    this._waterGunQuaternion = new THREE.Quaternion();
    this._waterDirection = new THREE.Vector3();
  }

  _updateWaterSpray(seconds, delta) {
    if (!this._waterJet || !this._waterMuzzle || !this.gun) return;
    this._waterMuzzle.getWorldPosition(this._waterStart);
    this.gun.getWorldQuaternion(this._waterGunQuaternion);
    this._waterFront.set(0, 0, 1).applyQuaternion(this._waterGunQuaternion).normalize();
    for (const [index, flow] of this._waterJets.entries()) {
      const active = this._motion === 'shoot' && index < this._weapon.jetCount;
      const angle = this._weapon.jetCount === 1 ? 0 :
        (index * 2 / (this._weapon.jetCount - 1) - 1) * this._weapon.spreadAngle;
      this._waterDirection.set(Math.sin(angle), 0, Math.cos(angle))
        .applyQuaternion(this._waterGunQuaternion).normalize();
      this._waterEnd.copy(this._waterStart).addScaledVector(this._waterDirection, 1.55);
      this._waterEnd.y -= .15;
      flow.setEmission(active, this._waterStart, this._waterEnd, { hit: false, floor: -.095 });
      flow.update(delta);
    }
  }

  setMotion(motion) {
    if (!MOTIONS.includes(motion)) throw new Error(`未知角色展示动作：${motion}`);
    this._motion = motion;
    this.assetInfo.selectedMotion = motion;
    this._motionAge = 0;
    if (!this.mixer) return;
    this._removeOverlay();
    const selected = this.motionClips[motion];
    const fallback = this.motionClips.idle || this.clips[0];
    const clip = selected || fallback;
    this.assetInfo.activeClipName = clip ? clip.name : null;
    this.assetInfo.activeMotionSource = selected ? 'external-clip' :
      motion === 'hit' && this._overlayBone ? 'bone-overlay' : 'fallback-pose';
    this._rootMotion = [];
    if (!clip) return;
    const action = this._actions.get(clip.name);
    action.reset();
    action.enabled = true;
    action.setEffectiveWeight(1);
    action.setEffectiveTimeScale(1);
    action.setLoop(motion === 'fall' || motion === 'hit' && selected ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = motion === 'fall' || motion === 'hit' && !!selected;
    action.play();
    if (this._currentAction && this._currentAction !== action) action.crossFadeFrom(this._currentAction, 0.14, false);
    this._currentAction = action;
    // Keep translational run clips on the pedestal while retaining their bone motion.
    if (motion === 'run') {
      for (const track of clip.tracks) {
        if (!/\.position$/.test(track.name) || track.values.length < 6) continue;
        const nodeName = track.name.slice(0, -9);
        if (!/root|hips|pelvis|armature/i.test(nodeName)) continue;
        const node = this.model.getObjectByName(nodeName);
        if (!node) continue;
        const count = track.values.length, dx = track.values[count - 3] - track.values[0];
        const dz = track.values[count - 1] - track.values[2];
        if (Math.hypot(dx, dz) > 0.1) this._rootMotion.push({ node, dx, dz });
      }
    }
  }

  _removeOverlay() {
    if (this._overlayApplied && this._overlayBone) this._overlayBone.quaternion.copy(this._overlayBase);
    this._overlayApplied = false;
  }

  render(seconds) {
    const now = Number.isFinite(seconds) ? seconds : 0;
    const delta = this._lastTime === null ? 0 : clamp(now - this._lastTime, 0, 0.1);
    this._lastTime = now;
    if (this.mixer) {
      this._removeOverlay();
      this._motionAge += delta;
      this.mixer.update(delta);
      const clip = this.motionClips[this._motion];
      if (clip && (this._motion === 'fall' || this._motion === 'hit') &&
        this._motionAge > clip.duration + (this._motion === 'fall' ? 0.85 : 0.5)) {
        this._currentAction.reset().play();
        this._motionAge = 0;
      }
      if (this._rootMotion.length && this._currentAction) {
        const progress = this._currentAction.time / this._currentAction.getClip().duration;
        for (const motion of this._rootMotion) {
          motion.node.position.x -= motion.dx * progress;
          motion.node.position.z -= motion.dz * progress;
        }
      }
      if (this._motion === 'hit' && !clip && this._overlayBone) {
        const cycle = this._motionAge % 1.15;
        const weight = cycle < 0.24 ? Math.sin(cycle / 0.24 * Math.PI) : 0;
        this._overlayBase.copy(this._overlayBone.quaternion);
        this._overlayRotation.setFromAxisAngle(this._overlayAxis, -0.17 * weight);
        this._overlayBone.quaternion.multiply(this._overlayRotation);
        this._overlayApplied = true;
      }
    }
    this._updateWaterSpray(now, delta);
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const rectangle = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rectangle.width || this.canvas.clientWidth || 640));
    const height = Math.max(1, Math.round(rectangle.height || this.canvas.clientHeight || 480));
    if (this._width === width && this._height === height) return;
    this._width = width; this._height = height;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    const distanceFactor = Math.max(1, 0.9 / this.camera.aspect);
    this.camera.position.set(1.6 * distanceFactor, 1.8, 4.15 * distanceFactor);
    this.camera.lookAt(0, 1.03, 0);
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    if (this.mixer) this.mixer.stopAllAction();
    if (this._waterJets) this._waterJets.forEach(flow => flow.dispose());
    this.scene.traverse(object => {
      if (!object.isMesh) return;
      object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (material.map) material.map.dispose();
        material.dispose();
      }
    });
    this.renderer.dispose();
  }
}
