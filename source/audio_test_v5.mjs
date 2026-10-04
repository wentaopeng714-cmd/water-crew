import assert from 'node:assert/strict';
import { GameAudio, BUILTIN_MUSIC_DATA_URI } from '../game-audio.js';

class Param {
  constructor(value = 1) { this.value = value; this.calls = []; }
  cancelScheduledValues(t) { this.calls.push(['cancel',t]); }
  setValueAtTime(v,t) { this.value=v; this.calls.push(['value',v,t]); }
  linearRampToValueAtTime(v,t) { this.value=v; this.calls.push(['linear',v,t]); }
  exponentialRampToValueAtTime(v,t) { this.value=v; this.calls.push(['exp',v,t]); }
  setTargetAtTime(v,t,c) { this.value=v; this.calls.push(['target',v,t,c]); }
}
class Node {
  constructor(ctx,kind) {
    this.ctx=ctx; this.kind=kind; this.gain=new Param(); this.pan=new Param(0);
    this.frequency=new Param(440); this.Q=new Param(1); this.connections=[];
  }
  connect(dest) { this.connections.push(dest); return dest; }
  disconnect() { this.connections=[]; this.disconnected=true; }
  start(t=0,offset=0) { this.startedAt=t; this.offset=offset; this.running=true; this.ctx.sources.push(this); }
  stop(t=this.ctx.currentTime) {
    this.stopAt=t;
    if (t<=this.ctx.currentTime) { this.running=false; this.onended?.(); }
  }
}
class Context {
  constructor() { this.currentTime=0;this.sampleRate=8000;this.state='suspended';this.sources=[];this.destination={};this.nodes=[];this.decodes=0; }
  node(kind) { const node=new Node(this,kind);this.nodes.push(node);return node; }
  createGain() { return this.node('gain'); }
  createStereoPanner() { return this.node('pan'); }
  createBiquadFilter() { return this.node('filter'); }
  createOscillator() { return this.node('oscillator'); }
  createBufferSource() { return this.node('buffer'); }
  createBuffer(channels,length,sampleRate) {
    const data=Array.from({length:channels},()=>new Float32Array(length));
    return {duration:length/sampleRate,getChannelData:i=>data[i]};
  }
  async decodeAudioData(data) { assert.ok(data.byteLength>500000); this.decodes++;return {duration:35.55555556}; }
  async resume() { this.state='running'; }
  async close() { this.state='closed'; }
  advance(dt) { this.currentTime+=dt;for(const s of this.sources)if(s.running&&s.stopAt<=this.currentTime){s.running=false;s.onended?.();} }
  get live() { return this.sources.filter(s=>s.running).length; }
}
class Document {
  hidden=false;
  listeners=new Map();
  addEventListener(type,cb) { this.listeners.set(type,cb); }
  removeEventListener(type,cb) { if(this.listeners.get(type)===cb)this.listeners.delete(type); }
  setHidden(v) { this.hidden=v;this.listeners.get('visibilitychange')?.(); }
}

const p1={id:'p1',isPlayer:true,index:0,alive:true,shooting:false,refilling:false,water:80,x:-3,y:0};
const ai={id:'ai1',index:1,alive:true,shooting:false,water:90,x:3,y:1};
const state=(phase='playing')=>({phase,roundId:1,actors:[p1,ai],events:[]});
const doc=new Document(), ctx=new Context();let factories=0, checks=0;
const audio=new GameAudio({contextFactory:()=>{factories++;return ctx;},documentRef:doc});
const check=(label,fn)=>{fn();checks++;console.log('PASS',label);};

check('music is an embedded original MP3, requiring no file fetch',()=>assert.ok(BUILTIN_MUSIC_DATA_URI.startsWith('data:audio/mpeg;base64,')));
audio.update(state());
check('no audio nodes or autoplay before a real unlock',()=>{assert.equal(factories,0);assert.equal(ctx.live,0);});
await Promise.all([audio.unlock(),audio.unlock()]);
check('concurrent gesture unlock creates one context and decodes once',()=>{assert.equal(factories,1);assert.equal(ctx.decodes,1);});
check('music plus low ambient start after unlock',()=>{assert.equal(audio.debugSnapshot().musicPlaying,true);assert.equal(ctx.live,2);});
for(let i=0;i<120;i++)audio.update(state(),1/60);
check('a continuous frame loop never stacks music or ambient nodes',()=>assert.equal(ctx.live,2));
p1.shooting=true;ai.shooting=true;audio.update(state());
check('only active gun streams start and retain actor identity',()=>{assert.equal(audio.debugSnapshot().streamCount,2);assert.equal(ctx.live,4);});
for(let i=0;i<60;i++)audio.update(state(),1/60);
check('held firing does not recreate persistent stream sources',()=>{assert.equal(ctx.live,4);assert.equal(audio.debugSnapshot().streamCount,2);});
ai.shooting=false;audio.update(state());
check('releasing a gun immediately stops that stream',()=>{assert.equal(audio.debugSnapshot().streamCount,1);assert.equal(ctx.live,3);});
p1.water=0;audio.update(state());
check('an empty tank cannot leave a water loop running',()=>assert.equal(audio.debugSnapshot().streamCount,0));
p1.shooting=false;p1.water=50;p1.refilling=true;audio.update(state());
check('player refill has one separate bubble loop',()=>{assert.equal(audio.debugSnapshot().refillPlaying,true);assert.equal(ctx.live,3);});
p1.refilling=false;audio.update(state());
check('leaving refill stops the refill loop',()=>assert.equal(ctx.live,2));
audio.event({type:'countdown',seq:1,value:3},state());
const afterCount=ctx.live;
audio.event({type:'countdown',seq:1,value:3},state());
check('duplicate event sequence never duplicates countdown bells',()=>assert.equal(ctx.live,afterCount));
ctx.advance(1);
check('one-shots clean up their voice nodes after ending',()=>{assert.equal(audio.debugSnapshot().voiceCount,0);assert.equal(ctx.live,2);});
audio.event({type:'hit',seq:2,sourceId:'p1',actorId:'ai1'},state());
const hitVoices=audio.debugSnapshot().voiceCount;
audio.event({type:'hit',seq:3,sourceId:'p1',actorId:'ai1'},state());
check('rapid hit events are mixed without an accumulating wall of noise',()=>assert.equal(audio.debugSnapshot().voiceCount,hitVoices));
audio.setEnabled(false);
check('global mute immediately zeros the master and stops all sources',()=>{assert.equal(audio.debugSnapshot().masterGain,0);assert.equal(ctx.live,0);assert.equal(audio.debugSnapshot().voiceCount,0);});
for(let i=0;i<60;i++)audio.update(state());
check('muted per-frame updates cannot restart sounds',()=>assert.equal(ctx.live,0));
audio.setEnabled(true);
check('unmuting restores only one music and one ambient voice',()=>assert.equal(ctx.live,2));
ctx.advance(2.25);audio.pause();
const offset=audio.debugSnapshot().musicOffset;
check('pause preserves music position and stops every active source',()=>{assert.ok(offset>=2.25);assert.equal(ctx.live,0);});
audio.update(state());
check('same-phase frames do not undo an explicit pause',()=>assert.equal(ctx.live,0));
audio.update(state('paused'));audio.update(state());
check('a game pause-to-play transition resumes the preserved score',()=>{assert.equal(ctx.live,2);const m=ctx.sources.findLast(s=>s.running&&s.buffer?.duration>30);assert.equal(m.offset,offset);});
audio.update(state('paused'));audio.pause();audio.update(state('ready'));
check('returning to the title releases manual pause for quiet menu music',()=>assert.equal(ctx.live,2));
audio.update(state());
doc.setHidden(true);audio.update(state());
check('backgrounding stops audio even if simulation still reports playing',()=>assert.equal(ctx.live,0));
doc.setHidden(false);audio.update(state());
check('foreground frames alone cannot resume hidden-tab audio',()=>assert.equal(ctx.live,0));
await audio.unlock();
check('a fresh foreground user gesture safely restores audio',()=>assert.equal(ctx.live,2));
audio.setMusicVolume(0);audio.setSfxVolume(0);
check('independent sliders clamp and zero their actual gain buses',()=>{assert.equal(audio._musicBus.gain.value,0);assert.equal(audio._sfxBus.gain.value,0);});
audio.setMusicVolume(2);audio.setSfxVolume(-1);
check('volume inputs are safely clamped',()=>{assert.equal(audio.musicVolume,1);assert.equal(audio.sfxVolume,0);});
audio.setSfxVolume(.78);audio.setMusicVolume(.52);
audio.update(state('result'));audio.event({type:'result',seq:4},state('result'));
const resultVoices=audio.debugSnapshot().voiceCount;audio.result(true);
check('result event and an explicit result call cannot stack stingers',()=>assert.equal(audio.debugSnapshot().voiceCount,resultVoices));
ctx.advance(2);
check('result fanfare voices release after their tail',()=>assert.equal(audio.debugSnapshot().voiceCount,0));
audio.stop();audio.update(state());
check('explicit stop is sticky until a user unlocks again',()=>assert.equal(ctx.live,0));
await audio.unlock();
check('unlock can intentionally recover from stop',()=>assert.equal(ctx.live,2));
audio.dispose();audio.dispose();
check('dispose is idempotent and removes listeners/nodes/context',()=>{assert.equal(ctx.live,0);assert.equal(doc.listeners.size,0);assert.equal(ctx.state,'closed');});
await audio.unlock();audio.update(state());
check('a disposed instance cannot recreate audio',()=>{assert.equal(factories,1);assert.equal(ctx.live,0);});

const failed = new GameAudio({contextFactory:()=>null,documentRef:new Document()});
check('unsupported devices fail gracefully with no gameplay exception',()=>assert.equal(failed.debugSnapshot().musicPlaying,false));
assert.equal(await failed.unlock(),false);failed.dispose();

const badContext=new Context();badContext.decodeAudioData=async()=>{throw new Error('bad music data');};
const decodeFailed=new GameAudio({contextFactory:()=>badContext,documentRef:new Document()});
assert.equal(await decodeFailed.unlock(),false);
check('music decode failures report a false result and visible diagnostic',()=>{assert.equal(decodeFailed.debugSnapshot().decodeFailed,true);assert.match(decodeFailed.debugSnapshot().error,/bad music data/);});
decodeFailed.dispose();

let finishDecode;const lateContext=new Context();lateContext.decodeAudioData=()=>new Promise(resolve=>{finishDecode=resolve;});
const late=new GameAudio({contextFactory:()=>lateContext,documentRef:new Document()});
const opening=late.unlock();await Promise.resolve();await Promise.resolve();late.dispose();finishDecode({duration:35.55555});await opening;
check('disposing during asynchronous music decoding cannot start a late source',()=>assert.equal(lateContext.live,0));
const upgradeCtx=new Context(),upgradeAudio=new GameAudio({contextFactory:()=>upgradeCtx,documentRef:new Document()});
await upgradeAudio.unlock();
const cannonPlayer={id:'p1',index:0,isPlayer:true,alive:true,shooting:true,water:110,x:0,y:0,weapon:{visualScale:1}};
const cannonState={phase:'playing',roundId:80,actors:[cannonPlayer],beams:[]};
upgradeAudio.update(cannonState);
const originalVoice=upgradeAudio._streams.get('p1'),originalGain=originalVoice.gain.gain.value,originalHz=originalVoice.filter.frequency.value;
cannonPlayer.weapon.visualScale=1.94;upgradeAudio.update(cannonState);
check('Upgraded water cannons deepen the same stream without stacking sources',()=>{assert.equal(upgradeAudio._streams.get('p1'),originalVoice);assert.ok(originalVoice.gain.gain.value>originalGain);assert.ok(originalVoice.filter.frequency.value<originalHz);assert.equal(upgradeAudio.debugSnapshot().streamCount,1);});
const beforeFanfare=upgradeAudio.debugSnapshot().voiceCount;upgradeAudio.event({type:'boss-round',seq:200,round:2,phase:'start'},cannonState);
check('A returning Boss plays one short round signal and deduplicates its event',()=>{assert.equal(upgradeAudio.debugSnapshot().voiceCount,beforeFanfare+3);upgradeAudio.event({type:'boss-round',seq:200,round:2,phase:'start'},cannonState);assert.equal(upgradeAudio.debugSnapshot().voiceCount,beforeFanfare+3);});
check('A Boss defeat cannot play a premature return signal',()=>{const before=upgradeAudio.debugSnapshot().voiceCount;upgradeAudio.event({type:'boss-round',seq:201,round:2,phase:'defeated'},cannonState);assert.equal(upgradeAudio.debugSnapshot().voiceCount,before);});
upgradeAudio.dispose();
const goalContext=new Context(),goalAudio=new GameAudio({contextFactory:()=>goalContext,documentRef:new Document()});
await goalAudio.unlock();
const outcomes=[];goalAudio.result=won=>outcomes.push(won);
const fallen={...p1,alive:false},goalState={phase:'result',roundId:99,actors:[fallen,ai],result:{cleared:true,playerWon:true}};
goalAudio.update(goalState);goalAudio.event({type:'result',seq:1,result:goalState.result},goalState);
goalAudio.event({type:'result',seq:1,result:goalState.result},goalState);
check('A completed mission plays success after later falling and duplicate result events are ignored',()=>assert.deepEqual(outcomes,[true]));
goalAudio.event({type:'result',seq:2,result:{cleared:false,playerWon:false}}, {...goalState,actors:[p1,ai]});
check('A failed objective plays failure even when the player survives',()=>assert.deepEqual(outcomes,[true,false]));
goalAudio.dispose();
console.log(`${checks} audio lifecycle checks passed.`);
