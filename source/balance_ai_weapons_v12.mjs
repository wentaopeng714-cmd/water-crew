import {readFile,writeFile} from 'node:fs/promises';
import vm from 'node:vm';
let source;
for(const path of ['./campaign.js','../campaign.js']){
  try{source=await readFile(new URL(path,import.meta.url),'utf8');break;}
  catch(error){if(error.code!=='ENOENT')throw error;}
}
const {Campaign}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const context={module:{exports:{}}};
vm.runInNewContext(await readFile(new URL('./gameplay.js',import.meta.url),'utf8'),context);
const Core=context.module.exports;
const unit=(x,y)=>{const d=Math.hypot(x,y);return d>.01?{x:x/d,y:y/d}:{x:0,y:0};};
function control(state,memory,strategy){
  const player=state.actors[0],enemies=state.actors.filter(actor=>!actor.isPlayer&&actor.alive);
  let target=strategy==='inside-locked'?enemies.find(actor=>actor.id===memory.target):null;
  if(!target)target=enemies.sort((a,b)=>Math.hypot(a.x-player.x,a.y-player.y)-Math.hypot(b.x-player.x,b.y-player.y))[0];
  memory.target=target?.id;
  const lead=strategy==='inside-locked'?.06:0;
  const aim=target?unit(target.x-player.x+target.vx*lead,target.y-player.y+target.vy*lead):unit(-player.x,-player.y);
  if(player.water<player.weapon.waterCapacity*.20)memory.refill=true;
  if(player.water>=player.weapon.waterCapacity*.75)memory.refill=false;
  let move={x:0,y:0};
  if(!target)move=Math.hypot(player.x,player.y)>.75?unit(-player.x,-player.y):move;
  else {
    const outward=unit(target.x,target.y),spacing=strategy==='inside-locked'?2.0:2.3;
    const station={x:target.x-outward.x*spacing,y:target.y-outward.y*spacing};
    if(Math.hypot(station.x-player.x,station.y-player.y)>.4)move=unit(station.x-player.x,station.y-player.y);
    if(memory.refill){
      const fountain=state.fountains.filter(f=>f.active).sort((a,b)=>Math.hypot(a.x-player.x,a.y-player.y)-Math.hypot(b.x-player.x,b.y-player.y))[0];
      if(fountain)move=unit(fountain.x-player.x,fountain.y-player.y);
    }
    if(Math.hypot(player.x+player.vx*.35,player.y+player.vy*.35)>state.params.arenaRadius-1)move=unit(-player.x,-player.y);
  }
  const distance=target?Math.hypot(target.x-player.x,target.y-player.y):Infinity;
  return {moveX:move.x,moveY:move.y,aimX:aim.x,aimY:aim.y,shoot:!memory.refill&&player.water>0&&distance<player.weapon.range+state.params.muzzleOffset+state.params.actorRadius};
}
function configFor(level,ranks,version){
  const campaign=new Campaign({storage:{getItem:()=>JSON.stringify({version:1,upgrades:ranks}),setItem(){}}});
  const config=campaign.getLevelConfig(level),progress=(level-1)/11;
  if(version==='v0.11')for(const profile of config.enemyProfiles){
    const isBoss=profile.isBoss;
    profile.weapon={range:4.6+progress*1.05,beamRadius:.18+progress*.02,
      pushAcceleration:20.5+progress*9.5+(isBoss?1.5:0),
      waterCapacity:100+progress*16+(isBoss?25:0),waterUse:18,
      refillRate:46+progress*10,passiveWaterRate:progress*2.5,
      visualScale:isBoss?1.22+progress*.25:1,
      jetCount:isBoss&&level>=9?3:1,spreadAngle:isBoss&&level>=9?.12:0};
  }
  return config;
}
const samples=32,scenarios=[
  [3,{pressure:1,reach:1,tank:1}],
  [9,{pressure:3,reach:2,nozzle:2,tank:2}],
  [11,{pressure:5,reach:1,nozzle:3,tank:4}],
  [12,{pressure:5,reach:4,nozzle:4,tank:4}]
];
const rows=[];
for(const [level,ranks] of scenarios)for(const version of ['v0.11','v0.12']){
  const config=configFor(level,ranks,version);
  let clears=0,elapsed=0,clearTime=0,knockouts=0;const failedSeeds=[];
  for(let seed=1;seed<=samples;seed++){
    const game=new Core({seed});game.configureRound(config,seed);game.start();const memory={refill:false};let frames=0;
    while(game.phase!=='result'&&frames++<2200)game.update(1/30,control(game.getState(),memory,'inside-locked'));
    if(game.phase!=='result')throw Error('Round failed to finish');
    const result=game.result;elapsed+=result.duration;clears+=Number(result.cleared);knockouts+=result.playerEliminations;
    if(result.cleared)clearTime+=result.duration;else failedSeeds.push(seed);
  }
  const row={level,ranks,version,samples,clears,clearPercent:+(clears/samples*100).toFixed(1),
    averageRoundSeconds:+(elapsed/samples).toFixed(2),averageClearSeconds:clears?+(clearTime/clears).toFixed(2):null,
    averagePersonalKnockouts:+(knockouts/samples).toFixed(2),
    enemyWeapons:config.enemyProfiles.map(profile=>({id:profile.id,isBoss:profile.isBoss,resistance:profile.pushResistance,weapon:profile.weapon})),
    playerWeapon:config.playerWeapon,failedSeeds};
  rows.push(row);console.log(JSON.stringify({level,ranks,version,samples,clears,clearPercent:row.clearPercent,averageRoundSeconds:row.averageRoundSeconds,averageClearSeconds:row.averageClearSeconds,failedSeeds}));
}
const report={version:'v0.12 AI gun progression',samplesPerScenario:samples,totalSimulatedRounds:rows.length*samples,
  note:'Paired deterministic CPU probes on the same core and v0.11 resistance/tactics. Only AI weapon equipment changes. The scripted player locks a visible target, pursues its inner side, uses a short aim lead and refills. Perfect world-coordinate aiming is not a human difficulty rating. Actual stage 11 player equipment is pressure 5, reach 1, nozzle 3, tank 4.',
  ordinaryThreeJetsFromLevel:10,captainThreeJetsFromLevel:6,rows};
await writeFile(new URL('./ai-weapons-v12.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
