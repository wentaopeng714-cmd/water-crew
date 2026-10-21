/** Load all four delivered assets through the actual renderer, without a WebGL context. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from '../vendor/three.module.js';
globalThis.window={};
const { WaterRenderer } = await import('../renderer_v3.js');
globalThis.self=globalThis;
globalThis.createImageBitmap=async()=>({width:1,height:1,close(){}});
globalThis.ProgressEvent=class {constructor(type,data){this.type=type;Object.assign(this,data);}};
const urls={};
for(const id of ['001','004','007','025'])urls[id]='data:model/gltf-binary;base64,'+(await fs.readFile(new URL(`../assets/pokemon/${id}.glb`,import.meta.url))).toString('base64');
globalThis.window={WATER_POKEMON_URLS:urls};
const r=Object.create(WaterRenderer.prototype);
Object.assign(r,{scene:new THREE.Scene(),_actors:new Map(),_views:[],fountains:[],_time:0,assetInfo:{},modelForwardOffset:0,gunHeight:.98,muzzleOffset:.35,environmentLoaded:true,particles:{clear(){},emit(){},ripple(){}},_random:()=>.5});
r._buildBeamPool();await r._loadCharacter();
assert.equal(r.modelLoaded,true);assert.deepEqual(r._views.map(v=>v.character.name),['Squirtle','Charmander','Pikachu','Bulbasaur']);
console.log('PASS four real Pokemon load into independent runtime views');
const actors=r._views.map((v,i)=>({id:'actor'+i,index:i,isPlayer:i===0,alive:true,spawnVersion:0,x:i*2-3,y:0,angle:0,mx:2,my:0,kx:0,ky:0,water:100,shooting:true,weapon:{waterCapacity:110,tier:0,visualScale:1}}));
const state={actors,phase:'playing',beams:[]};
r._resetRound({roundId:1});
for(let i=0;i<4;i++){r._views[i].id=actors[i].id;r._actors.set(actors[i].id,r._views[i]);}
for(const v of r._views){
 const actor=actors[v.index],leg=v.boneMap.get('leftleg02'),before=leg.quaternion.clone();
 for(let f=0;f<35;f++){r._time+=1/60;r._updateActor(v,actor,state,1/60);}
 assert.ok(Math.abs(before.dot(leg.quaternion))<.9999);
 assert.ok(v.muzzle.toArray().every(Number.isFinite));console.log('MUZZLE',v.character.name,v.muzzle.toArray());assert.ok(v.muzzle.y>.2&&v.muzzle.y<3);
 assert.ok(v.muzzle.distanceTo(v.root.position)<3);
 assert.ok(v.parts.shoot.tracks.length>0&&v.parts.run.tracks.length>0);
 if(!v.character.quadruped && !v.character.mounted)assert.equal(v.gun.parent.name,'right_hand');else assert.equal(v.gun.parent,v.root);
 const oldSocket=v.muzzleObject.position.clone();r._updateEquipment(v,{...actor,weapon:{waterCapacity:180,visualScale:1.8,tier:4}});assert.ok(v.muzzleObject.position.equals(oldSocket));
 console.log(`PASS ${v.character.name}: animated legs, attack layer, socket and upgraded equipment`);
}
const views=r._views.map(v=>({v,q:v.boneMap.get('leftleg02').quaternion.clone()}));
r._views[0].mixer.update(.23);for(const {v,q} of views.slice(1))assert.ok(Math.abs(q.dot(v.boneMap.get('leftleg02').quaternion))>.999999);
console.log('PASS animation mixers never affect another species');
for(const v of r._views){const actor=actors[v.index];r._fall(v,actor);assert.equal(v.fullState,'death');r._time+=1.1;r._updateActor(v,{...actor,alive:false},state,1/60);assert.equal(v.root.visible,false);r._respawn(v,{...actor,spawnVersion:1});assert.equal(v.root.visible,true);assert.equal(v.falling,null);assert.equal(v.actions.death.isRunning(),false);}
console.log('PASS all four real skeletons survive fall and respawn transitions');
for(const actor of actors)state.beams.push({actorId:actor.id,jetIndex:0,x2:5,y2:0});r._updateBeams(state,1/60);
for(const actor of actors){const e=r._getBeamEmitter(actor.id,0);assert.ok(e.flow.origin.equals(r._actors.get(actor.id).muzzle));}console.log('PASS all species emit water from their own animated cannon');
const html=await fs.readFile(new URL('./game_design_shell_v3.html',import.meta.url),'utf8');
const campaign=await fs.readFile(new URL('../campaign.js',import.meta.url),'utf8');
assert.ok(!/[\u3400-\u9fff]/.test(html+campaign));assert.ok(html.includes('lang="en"'));assert.ok(!html.includes('characters and scenery are original'));
console.log('PASS English UI, stage names and menu accessibility copy');
console.log('9 Pokemon runtime checks passed');
