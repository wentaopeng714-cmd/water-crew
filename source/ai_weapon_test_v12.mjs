import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),Core=require('./gameplay.js');
let source;
for(const path of ['./campaign.js','../campaign.js']){
  try{source=await readFile(new URL(path,import.meta.url),'utf8');break;}
  catch(error){if(error.code!=='ENOENT')throw error;}
}
const {Campaign}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const NONE={moveX:0,moveY:0,aimX:1,aimY:0,shoot:false},STEP=1/60;
let passed=0;
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
function test(label,run){run();passed++;console.log('PASS '+label);}
function fixture(level,shooterId='ai2',modify){
  const config=new Campaign({storage:null}).getLevelConfig(level);
  config.params.countdownDuration=0;modify?.(config);
  const game=new Core({seed:7});game.configureRound(config,7);let firing=false;
  game._aiCommand=actor=>({...NONE,shoot:firing&&actor.id===shooterId});game.start();game.update(STEP,NONE);
  const shooter=game.actors.find(actor=>actor.id===shooterId),target=game.actors.find(actor=>actor.id==='ai3');
  for(const actor of game.actors)Object.assign(actor,{x:-4+actor.index*.5,y:-4,mx:0,my:0,kx:0,ky:0,angle:0});
  Object.assign(shooter,{x:0,y:0});Object.assign(target,{x:2,y:0});
  return {game,shooter,target,fire:value=>{firing=value;}};
}
const advance=(game,seconds)=>{for(let i=0;i<Math.ceil(seconds/STEP);i++)game.update(STEP,NONE);};
test('Real campaign AI actors receive their chapter equipment tier, stream size and finite reservoirs',()=>{
  for(const level of [1,4,7,10,12]){
    const config=new Campaign({storage:null}).getLevelConfig(level),game=fixture(level).game;
    for(const actor of game.actors.slice(1)){
      const expected=config.enemyProfiles.find(profile=>profile.id===actor.id).weapon;
      for(const field of ['tier','visualScale','jetCount','range','beamRadius','waterCapacity','pushAcceleration','waterUse'])near(actor.weapon[field],expected[field]);
      near(actor.water,actor.weapon.waterCapacity);assert.ok(actor.weapon.waterUse>0);
    }
  }
});
test('Ordinary AI emits one real jet early and three separate real jets from chapter four',()=>{
  for(const [level,count] of [[3,1],[9,1],[10,3],[12,3]]){
    const f=fixture(level);f.fire(true);f.game.update(STEP,NONE);
    assert.equal(f.game.beams.filter(beam=>beam.actorId==='ai2').length,count);
    near(f.shooter.stats.shootingTime,STEP);
  }
});
test('A chapter two captain already emits three jets while its two rivals still emit one',()=>{
  const boss=fixture(6,'ai1');boss.fire(true);boss.game.update(STEP,NONE);
  assert.equal(boss.game.beams.filter(beam=>beam.actorId==='ai1').length,3);
  assert.equal(boss.game.actors[2].weapon.jetCount,1);assert.equal(boss.game.actors[3].weapon.jetCount,1);
  const first=fixture(3,'ai1');first.fire(true);first.game.update(STEP,NONE);
  assert.equal(first.game.beams.filter(beam=>beam.actorId==='ai1').length,1);
});
test('Three overlapping AI rays apply one resisted impulse and one water cost to a single victim',()=>{
  const single=fixture(12,'ai2',config=>{config.enemyProfiles[1].weapon.jetCount=1;}),triple=fixture(12);
  for(const f of [single,triple]){f.fire(true);f.game.update(STEP,NONE);}
  const rays=triple.game.beams.filter(beam=>beam.actorId==='ai2'&&beam.targetId==='ai3');
  assert.equal(rays.length,3);assert.equal(rays.filter(beam=>beam.applied).length,1);
  near(triple.target.kx,single.target.kx);near(triple.target.x,single.target.x);
  near(triple.shooter.water,single.shooter.water);
  near(triple.shooter.weapon.waterCapacity-triple.shooter.water,triple.shooter.weapon.waterUse*STEP);
});
test('Upgraded AI stream applies its real stronger pressure and larger radius to another AI',()=>{
  const early=fixture(1),late=fixture(12);
  for(const f of [early,late]){f.fire(true);f.game.update(STEP,NONE);}
  const beam=late.game.beams.find(beam=>beam.actorId==='ai2'&&beam.applied);
  near(beam.force,late.shooter.weapon.pushAcceleration/late.target.enemyProfile.pushResistance);
  near(beam.radius,late.shooter.weapon.beamRadius);assert.equal(late.target.lastHitBy,'ai2');
  assert.ok(late.shooter.weapon.pushAcceleration>early.shooter.weapon.pushAcceleration);
  assert.ok(beam.radius>early.game.beams.find(beam=>beam.actorId==='ai2').radius);
});
test('AI spray respects the player push factor and has no separate player-only damage multiplier',()=>{
  const f=fixture(12);Object.assign(f.game.actors[0],{x:2,y:0});Object.assign(f.target,{x:-4,y:4});
  f.fire(true);f.game.update(STEP,NONE);
  const rays=f.game.beams.filter(beam=>beam.actorId==='ai2'&&beam.targetId==='p1');
  assert.equal(rays.filter(beam=>beam.applied).length,1);
  near(rays.find(beam=>beam.applied).force,f.shooter.weapon.pushAcceleration*f.game.params.playerPushFactor);
});
test('Even a final upgraded AI tank empties; holding the dry trigger cannot refill or keep a stream alive',()=>{
  const f=fixture(12);f.fire(true);
  advance(f.game,f.shooter.weapon.waterCapacity/f.shooter.weapon.waterUse+.1);
  near(f.shooter.water,0);assert.equal(f.shooter.shooting,false);
  assert.equal(f.game.beams.filter(beam=>beam.actorId==='ai2').length,0);
  const shootingTime=f.shooter.stats.shootingTime;advance(f.game,.5);
  near(f.shooter.water,0);near(f.shooter.stats.shootingTime,shootingTime);
  assert.ok(f.game.events.some(event=>event.type==='dry'&&event.actorId==='ai2'));
});
test('AI fountain refilling uses the upgraded reservoir rate and never overfills the tank',()=>{
  const f=fixture(12);f.shooter.water=0;Object.assign(f.target,{x:-4,y:4});
  advance(f.game,.5);near(f.shooter.water,f.shooter.weapon.refillRate*.5);
  assert.equal(f.shooter.refillSource,'fountain');
  f.shooter.water=f.shooter.weapon.waterCapacity-.1;advance(f.game,STEP);
  near(f.shooter.water,f.shooter.weapon.waterCapacity);
});
test('Away from fountains upgraded AI rest recovery waits for the same delay and stays bounded',()=>{
  const f=fixture(12);Object.assign(f.shooter,{x:4.5,y:4.5,water:0,_restTime:0});Object.assign(f.target,{x:-4,y:4});
  advance(f.game,f.game.params.passiveWaterDelay);near(f.shooter.water,0);
  advance(f.game,.5);near(f.shooter.water,f.shooter.weapon.passiveWaterRate*.5);
  assert.equal(f.shooter.refillSource,'rest');assert.ok(f.shooter.water<f.shooter.weapon.waterCapacity);
});
console.log(`AI weapon physics checks: ${passed} passed`);
