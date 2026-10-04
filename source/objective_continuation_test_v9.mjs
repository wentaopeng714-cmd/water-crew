import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const Core=require('./gameplay.js');
let source;
for(const relative of ['./campaign.js','../campaign.js']){
  try{source=await readFile(new URL(relative,import.meta.url),'utf8');break;}
  catch(error){if(error.code!=='ENOENT')throw error;}
}
const {Campaign}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const values=new Map(),storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)};
const campaign=new Campaign({storage});
const idle={moveX:0,moveY:0,aimX:1,aimY:0,shoot:false},step=1/60;
let checks=0;
function check(label,run){run();checks++;console.log('PASS '+label);}
function advance(game,seconds,input=idle){for(let i=0;i<Math.ceil(seconds/step);i++)game.update(step,input);}
function start(id){
  const config=campaign.startLevel(id),game=new Core({seed:7});
  config.params.countdownDuration=0;
  game.configureRound(config,7);game._aiCommand=()=>({...idle,aimX:0});game.start();game.update(step,idle);
  [[0,0],[4,0],[0,4],[0,-4]].forEach(([x,y],i)=>Object.assign(game.actors[i],{x,y,mx:0,my:0,kx:0,ky:0}));
  return game;
}
const intro=start(1);advance(intro,25);assert.equal(campaign.finishAttempt(intro.getState()).cleared,true);
const game=start(2),before=campaign.getState().coins;
// The target leaves through actual water-force integration, not a fabricated result.
Object.assign(game.actors[0],{x:3,y:0});Object.assign(game.actors[1],{x:6.6,y:0});
advance(game,1,{...idle,shoot:true});
check('Actual water knock-off latches the campaign goal without a result or payment',()=>{
  assert.equal(game.stageGoalCompleted,true);assert.equal(game.phase,'playing');assert.equal(game.result,null);
  assert.equal(game.actors.filter(actor=>actor.alive&&!actor.isPlayer).length,2);
  assert.equal(game.actors[0].stats.eliminations,1);
  assert.equal(campaign.finishAttempt(game.getState()).reason,'unfinished-round');assert.equal(campaign.getState().coins,before);
});
const time=game.timeElapsed,water=game.actors[0].water;advance(game,.5,{...idle,shoot:true,moveY:1});
check('After achievement the player still moves, sprays, spends water and advances the timer',()=>{
  assert.ok(game.timeElapsed>time);assert.ok(game.actors[0].y>.1);assert.ok(game.actors[0].water<water);
  assert.equal(game.events.filter(e=>e.type==='objective-complete').length,1);
});
game.togglePause();const frozen=JSON.stringify(game.getState());advance(game,3,{...idle,shoot:true});
check('Paused bonus play cannot issue premature rewards or advance the achieved round',()=>{
  assert.equal(JSON.stringify(game.getState()),frozen);assert.equal(campaign.finishAttempt(game.getState()).success,false);
  assert.equal(campaign.getState().coins,before);
});
assert.equal(game.endCompletedStage(),true);
const outcome=campaign.finishAttempt(game.getState());
check('Explicit settlement of a paused achieved round banks real progress and its fast-clear stars',()=>{
  assert.equal(game.result.reason,'player-finish');assert.equal(outcome.cleared,true);assert.equal(outcome.stars,3);
  assert.equal(campaign.getState().highestUnlocked,3);assert.equal(outcome.duration,game.objectiveCompletedAt);
  assert.ok(game.result.duration>outcome.duration);
});
const paid=campaign.getState().coins;
check('The settled real round cannot pay twice, including after a storage reload',()=>{
  assert.equal(game.endCompletedStage(),false);assert.equal(campaign.finishAttempt(game.getState()).duplicate,true);
  const reloaded=new Campaign({storage});assert.equal(reloaded.finishAttempt(game.getState()).duplicate,true);
  assert.equal(reloaded.getState().coins,paid);
});
const sweep=start(2),sweepCoins=campaign.getState().coins;
for(const target of sweep.actors.slice(1)){
  Object.assign(sweep.actors[0],{x:3,y:0,mx:0,my:0,kx:0,ky:0});
  Object.assign(target,{x:6.6,y:0,mx:0,my:0,kx:0,ky:0});
  advance(sweep,1,{...idle,shoot:true});
}
check('A real water sweep automatically settles and banks a cleared stage without manual confirmation',()=>{
  assert.equal(sweep.actors.filter(actor=>actor.alive&&!actor.isPlayer).length,0);
  assert.equal(sweep.phase,'result');assert.equal(sweep.result.reason,'all-opponents-out');
  assert.equal(sweep.result.cleared,true);assert.equal(sweep.endCompletedStage(),false);
  const sweepOutcome=campaign.finishAttempt(sweep.getState());
  assert.equal(sweepOutcome.cleared,true);assert.ok(campaign.getState().coins>sweepCoins);
  assert.equal(campaign.finishAttempt(sweep.getState()).duplicate,true);
});
console.log(`${checks} objective continuation integration checks passed.`);
