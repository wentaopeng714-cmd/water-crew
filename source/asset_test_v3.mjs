import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from '../vendor/three.module.js';
import {GLTFLoader} from '../vendor/addons/loaders/GLTFLoader.js';
import {clone} from '../vendor/addons/utils/SkeletonUtils.js';
async function load(relative){const b=fs.readFileSync(new URL(relative, import.meta.url));return await new Promise((resolve,reject)=>new GLTFLoader().parse(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'',resolve,reject));}
globalThis.self=globalThis;
// Node geometry verification only; actual texture decoding is checked in browser QA.
globalThis.createImageBitmap=async()=>({width:1,height:1,close(){}});
globalThis.ProgressEvent=class {constructor(type,data){this.type=type;Object.assign(this,data);}};
for (const id of ['007','004','025','001']) {
  const data=fs.readFileSync(new URL(`../assets/pokemon/${id}.glb`,import.meta.url));
  const json=JSON.parse(data.toString('utf8',20,20+data.readUInt32LE(12)));
  assert.ok(json.images.length>0 && json.images.every(image=>!image.uri));
  assert.ok(json.buffers.every(buffer=>!buffer.uri));
  const character=await load(`../assets/pokemon/${id}.glb`);
  let skins=0; const bones=new Set();
  character.scene.traverse(o=>{if(o.isSkinnedMesh){skins++;assert.ok(o.geometry.attributes.skinWeight);o.skeleton.bones.forEach(b=>bones.add(b.name));}});
  assert.ok(skins>=2 && bones.size>=30);
  assert.deepEqual(character.animations.map(c=>c.name).sort(),['attack','happy','idle','run','sleep','walk']);
  console.log(`PASS ${id}: embedded textures, skinned geometry and six imported clips`);
  const a=clone(character.scene),b=clone(character.scene),ak=a.getObjectByName('left_leg_02'),bk=b.getObjectByName('left_leg_02');
  assert.ok(ak?.isBone && bk?.isBone);assert.notEqual(ak,bk);
  const before=bk.quaternion.clone(),am=new THREE.AnimationMixer(a);am.clipAction(character.animations.find(c=>c.name==='run')).play();
  const qs=[];for(const t of [.05,.23,.42,.60]){am.setTime(t);qs.push(ak.quaternion.clone());}
  assert.ok(qs.some(q=>Math.abs(q.dot(qs[0]))<.9999));assert.ok(Math.abs(before.dot(bk.quaternion))>.999999);
  console.log(`PASS ${id}: independent cloned skeleton and articulated run cycle`);
  for(const clip of character.animations){const model=clone(character.scene),m=new THREE.AnimationMixer(model);m.clipAction(clip).play();m.update(Math.min(.2,clip.duration*.4));model.updateMatrixWorld(true);model.traverse(o=>{if(o.isSkinnedMesh){o.skeleton.update();for(const i of [0,Math.floor(o.geometry.attributes.position.count/2)]){const p=o.getVertexPosition(i,new THREE.Vector3());assert.ok(p.toArray().every(Number.isFinite),clip.name);}}});}
  console.log(`PASS ${id}: all six animation clips deform finite vertices`);
}
const environment=await load('../assets/environment-v3.glb');let meshes=0,envTriangles=0,nozzles=0,hasFlowers=false,hasLeaves=false,hasFloor=false;
environment.scene.traverse(o=>{if(o.name.startsWith('Env_SpoutNozzle_'))nozzles++;if(!o.isMesh)return;meshes++;envTriangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3;hasFlowers ||= o.name.includes('Env_Flowers');hasLeaves ||= o.name.includes('Env_Foliage');hasFloor ||= o.name.includes('Env_StoneFloor');});
assert.equal(meshes,28);assert.equal(nozzles,4);assert.ok(hasFlowers&&hasLeaves&&hasFloor);
console.log('PASS Blender environment: bevelled stone, shaped flower/leaf meshes and four spout markers');
console.log('13 Pokemon/environment asset checks passed');
