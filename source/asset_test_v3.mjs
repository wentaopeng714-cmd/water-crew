import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from '../vendor/three.module.js';
import {GLTFLoader} from '../vendor/addons/loaders/GLTFLoader.js';
import {clone} from '../vendor/addons/utils/SkeletonUtils.js';
async function load(relative){const b=fs.readFileSync(new URL(relative, import.meta.url));return await new Promise((resolve,reject)=>new GLTFLoader().parse(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'',resolve,reject));}
const character=await load('../assets/character-v3.glb');
let skins=0,triangles=0,bones=new Set();
character.scene.traverse(o=>{if(o.isSkinnedMesh){skins++;assert.ok(o.geometry.attributes.skinWeight);o.skeleton.bones.forEach(b=>bones.add(b.name));}if(o.isMesh)triangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3;});
assert.ok(skins>=10);assert.equal(character.animations.length,17);assert.equal(bones.size,43);assert.ok(triangles>40000);
for(const name of ['Idle_Shoot','Run_Gun','Run_Shoot','HitReact','Death','Wave'])assert.ok(character.animations.find(c=>c.name===name));
console.log('PASS Blender character: actual curved geometry, 43 bones, 17 retained animation clips');
const a=clone(character.scene),b=clone(character.scene);let ak,bk;
a.traverse(o=>{if(o.isBone&&o.name==='LowerLegL')ak=o;});b.traverse(o=>{if(o.isBone&&o.name==='LowerLegL')bk=o;});
assert.ok(ak&&bk);assert.notEqual(ak,bk);
const bm=new THREE.AnimationMixer(b);bm.clipAction(character.animations.find(c=>c.name==='Idle_Shoot')).play();bm.update(.01);
const before=bk.quaternion.clone();
const am=new THREE.AnimationMixer(a);am.clipAction(character.animations.find(c=>c.name==='Run_Gun')).play();const qs=[];
for(const t of [.05,.23,.42,.60]){am.setTime(t);qs.push(ak.quaternion.clone());}
assert.ok(qs.some(q=>Math.abs(q.dot(qs[0]))<.99));assert.ok(Math.abs(before.dot(bk.quaternion))>.999999);
console.log('PASS Independent actor skeletons and actual running knee articulation');
for(const clip of character.animations){const model=clone(character.scene),m=new THREE.AnimationMixer(model);m.clipAction(clip).play();m.update(Math.min(.2,clip.duration*.4));model.updateMatrixWorld(true);model.traverse(o=>{if(o.isSkinnedMesh){o.skeleton.update();for(const i of [0,Math.floor(o.geometry.attributes.position.count/2)]){const p=o.getVertexPosition(i,new THREE.Vector3());assert.ok(p.toArray().every(Number.isFinite),clip.name);}}});}
console.log('PASS All 17 clips deform the new skinned character with finite vertices');
const environment=await load('../assets/environment-v3.glb');let meshes=0,envTriangles=0,nozzles=0,hasFlowers=false,hasLeaves=false,hasFloor=false;
environment.scene.traverse(o=>{if(o.name.startsWith('Env_SpoutNozzle_'))nozzles++;if(!o.isMesh)return;meshes++;envTriangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3;hasFlowers ||= o.name.includes('Env_Flowers');hasLeaves ||= o.name.includes('Env_Foliage');hasFloor ||= o.name.includes('Env_StoneFloor');});
assert.equal(meshes,28);assert.equal(nozzles,4);assert.ok(hasFlowers&&hasLeaves&&hasFloor);
console.log('PASS Blender environment: bevelled stone, shaped flower/leaf meshes and four spout markers');
console.log(JSON.stringify({character:{skins,bones:bones.size,triangles,clips:character.animations.length},environment:{meshes,triangles:envTriangles,nozzles}},null,2));
