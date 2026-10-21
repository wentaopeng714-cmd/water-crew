import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Run either beside the authoring module or from the downloadable source folder.
let source;
for (const path of ['./campaign.js', '../campaign.js']) {
  try { source = await readFile(new URL(path, import.meta.url), 'utf8'); break; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (!source) throw Error('campaign.js is missing');
const { Campaign, LEVELS, UPGRADE_DEFINITIONS, SAVE_KEY } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const storage = initial => {
  const values = new Map(initial === undefined ? [] : [[SAVE_KEY, typeof initial === 'string' ? initial : JSON.stringify(initial)]]);
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), values };
};
const make = raw => new Campaign({ storage: storage(raw) });
const result = (config, options = {}) => ({ phase: 'result', stage: config.stage,
  timeElapsed: options.duration ?? config.params.roundDuration,
  result: { cleared: options.cleared ?? true, duration: options.duration ?? config.params.roundDuration,
    playerEliminations: options.eliminations ?? 0 },
  actors: [{ id: 'p1', isPlayer: true, alive: options.alive ?? true,
    water: options.water ?? config.playerWeapon.waterCapacity, weapon: config.playerWeapon,
    stats: { eliminations: options.eliminations ?? 0, hitTime: options.hitTime ?? 0 } }] });
const clear = (campaign, id, options = {}) => campaign.finishAttempt(result(campaign.startLevel(id), options));
let passed = 0;
function test(name, run) { run(); passed++; console.log('PASS ' + name); }

test('New campaign starts with only level 1 and exactly one affordable starter upgrade', () => {
  const campaign = make(), save = campaign.getState();
  assert.equal(save.coins, 35); assert.equal(save.highestUnlocked, 1); assert.equal(save.selectedLevel, 1);
  assert.deepEqual(save.stars, Array(12).fill(0)); assert.deepEqual(save.upgrades, { pressure: 0, reach: 0, nozzle: 0, tank: 0 });
  assert.equal(campaign.getLevels().filter(level => level.unlocked).length, 1);
  assert.deepEqual(campaign.getUpgrades().filter(upgrade => upgrade.canBuy).map(upgrade => upgrade.id), ['pressure']);
});
test('All twelve stages have four real themes and different objective/fountain configurations', () => {
  const campaign = make();
  assert.equal(LEVELS.length, 12); assert.equal(new Set(LEVELS.map(level => level.theme)).size, 4);
  assert.deepEqual(LEVELS.filter(level => level.type === 'boss').map(level => level.id), [3, 6, 9, 12]);
  assert.deepEqual(LEVELS.filter(level => level.type === 'boss').map(level => level.bossRounds), [1, 2, 2, 3]);
  assert.equal(new Set(LEVELS.map(level => level.fountainPattern)).size, 3);
  for (let id = 1; id <= 12; id++) {
    const config = campaign.getLevelConfig(id);
    assert.equal(config.stage.levelId, id); assert.ok(config.stage.objectiveText);
    assert.equal(config.enemyProfiles.length, 3); assert.equal(config.stage.attemptId, null);
    assert.equal(config.stage.objective.bossRounds, LEVELS[id - 1].bossRounds);
    assert.ok(config.params.roundDuration >= 25 && config.params.roundDuration <= 60);
    for (const enemy of config.enemyProfiles) {
      assert.ok(enemy.weapon.pushAcceleration > 0); assert.ok(enemy.scale >= 1);
      assert.equal(enemy.isBoss, id % 3 === 0 && enemy.id === 'ai1');
    }
  }
});
test('Stage opposition grows smoothly while the introductory round stays short', () => {
  const campaign = make(); let previous = campaign.getLevelConfig(1);
  assert.equal(previous.params.roundDuration, 25);
  for (let id = 2; id <= 12; id++) {
    const next = campaign.getLevelConfig(id);
    assert.ok(next.params.aiMoveFactor >= previous.params.aiMoveFactor);
    assert.ok(next.params.aiAimError <= previous.params.aiAimError);
    assert.ok(next.params.aiBurstDuration >= previous.params.aiBurstDuration);
    assert.ok(next.params.aiMoveFactor - previous.params.aiMoveFactor < .04);
    previous = next;
  }
});
test('Locked or malformed levels cannot be selected or started', () => {
  const campaign = make();
  for (const id of [0, -1, 2, 13, '1', NaN, 1.4]) {
    assert.equal(campaign.selectLevel(id), false); assert.equal(campaign.startLevel(id), null);
  }
  assert.equal(campaign.getState().selectedLevel, 1); assert.equal(campaign.getLevelConfig(13), null);
});
test('Starter pressure purchase spends real coins and increases physical and visual power', () => {
  const campaign = make(), before = campaign.getWeapon(), purchase = campaign.purchaseUpgrade('pressure');
  assert.equal(purchase.success, true); assert.equal(campaign.getState().coins, 0);
  assert.equal(campaign.getState().upgrades.pressure, 1);
  assert.ok(campaign.getWeapon().pushAcceleration > before.pushAcceleration);
  assert.ok(campaign.getWeapon().visualScale > before.visualScale);
  assert.equal(campaign.purchaseUpgrade('reach').reason, 'insufficient-coins');
  assert.equal(campaign.purchaseUpgrade('made-up').reason, 'unknown-upgrade');
  assert.equal(campaign.getState().coins, 0);
});
test('Maximum ranks are capped and their full cost is deducted without overspending', () => {
  const campaign = make({ version: 1, coins: 5000 }), before = campaign.getState().coins;
  let spent = 0, ranks = 0;
  for (const definition of UPGRADE_DEFINITIONS) {
    for (let rank = 0; rank < definition.maxRank; rank++) {
      const purchase = campaign.purchaseUpgrade(definition.id);
      assert.equal(purchase.success, true); spent += purchase.cost; ranks++;
    }
    assert.equal(campaign.purchaseUpgrade(definition.id).reason, 'max-rank');
  }
  assert.equal(ranks, 17); assert.equal(spent, 1415); assert.equal(campaign.getState().coins, before - spent);
  assert.ok(campaign.getUpgrades().every(upgrade => upgrade.maxed && !upgrade.canBuy && upgrade.cost === 0));
});
test('Second nozzle rank enables three independently aimed jets; tank lowers consumption', () => {
  const campaign = make({ version: 1, coins: 1000 }), base = campaign.getWeapon();
  campaign.purchaseUpgrade('nozzle'); assert.equal(campaign.getWeapon().jetCount, 1);
  campaign.purchaseUpgrade('nozzle'); assert.equal(campaign.getWeapon().jetCount, 3);
  assert.ok(campaign.getWeapon().spreadAngle > 0); assert.ok(campaign.getWeapon().beamRadius > base.beamRadius);
  campaign.purchaseUpgrade('tank'); const upgraded = campaign.getWeapon();
  assert.ok(upgraded.waterCapacity > base.waterCapacity); assert.ok(upgraded.waterUse < base.waterUse);
  assert.ok(upgraded.refillRate > base.refillRate); assert.ok(upgraded.passiveWaterRate > base.passiveWaterRate);
});
test('Upgrade purchases cannot alter an active round snapshot; quitting permits purchase again', () => {
  const campaign = make(), config = campaign.startLevel(1);
  assert.equal(campaign.purchaseUpgrade('pressure').reason, 'round-active');
  assert.ok(campaign.getUpgrades().every(upgrade => !upgrade.canBuy));
  campaign.abandonAttempt(); assert.equal(campaign.purchaseUpgrade('pressure').success, true);
  assert.equal(config.playerWeapon.pushAcceleration, 24);
});
test('Countdown, playing and paused states never issue rewards', () => {
  const campaign = make(), config = campaign.startLevel(1);
  for (const phase of ['ready', 'countdown', 'playing', 'paused']) {
    assert.equal(campaign.finishAttempt({ ...result(config), phase }).success, false);
  }
  assert.equal(campaign.getState().coins, 35); assert.equal(campaign.getState().highestUnlocked, 1);
});
test('First survival clear gives the promised reward and unlocks only the next stage', () => {
  const campaign = make(), outcome = clear(campaign, 1);
  assert.equal(outcome.cleared, true); assert.equal(outcome.firstClear, true); assert.equal(outcome.stars, 1);
  assert.equal(outcome.coinsEarned, 55); assert.equal(campaign.getState().coins, 90);
  assert.equal(campaign.getState().highestUnlocked, 2); assert.equal(outcome.nextLevel, 2);
  assert.equal(campaign.getState().stars[0], 1); assert.equal(campaign.getState().stars[1], 0);
});
test('The same attempt cannot pay twice even after a save/reload', () => {
  const store = storage(), campaign = new Campaign({ storage: store }), config = campaign.startLevel(1), state = result(config);
  const first = campaign.finishAttempt(state), coins = campaign.getState().coins;
  const repeated = campaign.finishAttempt(state); assert.equal(repeated.duplicate, true);
  assert.equal(repeated.coinsEarned, first.coinsEarned); assert.equal(campaign.getState().coins, coins);
  const reloaded = new Campaign({ storage: store });
  assert.equal(reloaded.finishAttempt(state).duplicate, true); assert.equal(reloaded.getState().coins, coins);
});
test('A preview config, canceled round or wrong session cannot fabricate progression', () => {
  const campaign = make(); assert.equal(campaign.finishAttempt(result(campaign.getLevelConfig(1))).success, false);
  const config = campaign.startLevel(1), wrong = result(config); wrong.stage = { ...wrong.stage, sessionToken: 'other-tab' };
  assert.equal(campaign.finishAttempt(wrong).success, false);
  campaign.abandonAttempt(); assert.equal(campaign.finishAttempt(result(config)).success, false);
  assert.equal(campaign.getState().coins, 35); assert.equal(campaign.getState().highestUnlocked, 1);
});
test('An uncompleted attempt replaced by a new round cannot award old results', () => {
  const campaign = make(), oldConfig = campaign.startLevel(1), config = campaign.startLevel(1);
  assert.notEqual(config.stage.attemptId, oldConfig.stage.attemptId);
  assert.equal(campaign.finishAttempt(result(oldConfig)).reason, 'unknown-attempt');
  assert.equal(campaign.finishAttempt(result(config)).success, true);
});
test('Failure rewards participation and personal knockouts without granting stars or unlocking', () => {
  const campaign = make(), outcome = clear(campaign, 1, { cleared: false, alive: false, eliminations: 2, duration: 9 });
  assert.equal(outcome.coinsEarned, 20); assert.equal(outcome.stars, 0); assert.equal(outcome.nextLevel, null);
  assert.equal(campaign.getState().highestUnlocked, 1); assert.deepEqual(campaign.getState().stars, Array(12).fill(0));
});
test('Replay rewards are lower and cannot erase an earned star record or best time', () => {
  const campaign = make(), first = clear(campaign, 1, { eliminations: 1, duration: 25 });
  assert.equal(first.stars, 3); assert.equal(first.coinsEarned, 70);
  const replay = clear(campaign, 1, { duration: 25 });
  assert.equal(replay.firstClear, false); assert.equal(replay.coinsEarned, 15);
  assert.equal(campaign.getState().stars[0], 3); assert.equal(campaign.getState().best[0].clears, 2);
  assert.equal(campaign.getState().best[0].eliminations, 1);
});
test('All twelve stages unlock sequentially and final clear has no fictional level 13', () => {
  const campaign = make(); let last;
  for (let id = 1; id <= 12; id++) {
    last = clear(campaign, id, { eliminations: 1, duration: id === 1 ? 25 : 15 });
    assert.equal(last.cleared, true); assert.equal(campaign.getState().highestUnlocked, Math.min(12, id + 1));
  }
  assert.equal(last.campaignComplete, true); assert.equal(last.nextLevel, null);
  assert.ok(campaign.getLevels().every(level => level.unlocked && level.stars > 0));
});
test('Intermediate boss rounds issue no reward; final clear pays once and caps knockout coins', () => {
  const store = storage(), campaign = new Campaign({ storage: store });
  for (let id = 1; id < 12; id++) clear(campaign, id);
  const config = campaign.startLevel(12), before = campaign.getState().coins;
  assert.equal(config.stage.objective.bossRounds, 3);
  for (const knockoutCount of [1, 2]) {
    const intermediate = result(config, { eliminations: knockoutCount, duration: 8 * knockoutCount });
    intermediate.phase = 'playing'; intermediate.result = null;
    assert.equal(campaign.finishAttempt(intermediate).success, false);
    assert.equal(campaign.getState().coins, before);
  }
  const state = result(config, { eliminations: 5, duration: 25 }), outcome = campaign.finishAttempt(state);
  assert.equal(outcome.eliminations, 5); assert.equal(outcome.coinsEarned, 99 + 15 + 10);
  assert.equal(campaign.getState().best[11].eliminations, 5);
  const reloaded = new Campaign({ storage: store });
  assert.equal(reloaded.getState().best[11].eliminations, 5); assert.equal(reloaded.getState().lastOutcome.eliminations, 5);
  assert.equal(reloaded.finishAttempt(state).duplicate, true); assert.equal(reloaded.getState().coins, before + outcome.coinsEarned);
});
test('Coins, upgrades, selected level and stars survive an actual storage round trip', () => {
  const store = storage(), campaign = new Campaign({ storage: store });
  campaign.purchaseUpgrade('pressure'); clear(campaign, 1); campaign.purchaseUpgrade('tank'); campaign.selectLevel(2);
  const before = campaign.getState(), after = new Campaign({ storage: store }).getState();
  for (const key of ['coins', 'upgrades', 'selectedLevel', 'highestUnlocked', 'stars', 'best', 'lastOutcome']) assert.deepEqual(after[key], before[key]);
  assert.equal(after.saveStatus, 'saved');
});
test('Corrupt JSON and an unrelated save schema recover as a fresh campaign', () => {
  for (const raw of ['{broken', '{"version":88,"coins":99999}', '[]', 'null']) {
    const save = make(raw).getState(); assert.equal(save.coins, 35); assert.equal(save.highestUnlocked, 1);
    assert.deepEqual(save.upgrades, { pressure: 0, reach: 0, nozzle: 0, tank: 0 });
  }
});
test('Invalid fields are clamped and an unbacked unlock index is ignored', () => {
  const campaign = make({ version: 1, coins: -400, highestUnlocked: 12, selectedLevel: 12,
    upgrades: { pressure: 9999, reach: -4, nozzle: 'bad', tank: 1.9 }, stars: [0, NaN, -5, '3'], best: ['bad'] });
  const state = campaign.getState(); assert.equal(state.coins, 0); assert.equal(state.highestUnlocked, 1); assert.equal(state.selectedLevel, 1);
  assert.deepEqual(state.upgrades, { pressure: 5, reach: 0, nozzle: 0, tank: 1 });
  for (const value of Object.values(campaign.getWeapon())) if (typeof value === 'number') assert.ok(Number.isFinite(value));
});
test('Blocked local storage remains playable and honestly reports memory-only saves', () => {
  const broken = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
  const campaign = new Campaign({ storage: broken });
  assert.equal(campaign.getState().saveStatus, 'memory-only');
  assert.equal(campaign.purchaseUpgrade('pressure').success, true); assert.equal(clear(campaign, 1).cleared, true);
  assert.equal(campaign.getState().highestUnlocked, 2); assert.equal(campaign.getState().coins, 55);
});
test('Read-only snapshots cannot mutate the economy, configurations or progression', () => {
  const campaign = make(), save = campaign.getState(), levels = campaign.getLevels(), config = campaign.getLevelConfig(1);
  save.coins = 1000; save.upgrades.pressure = 5; save.stars[0] = 3;
  levels[0].name = 'fake'; config.enemyProfiles[0].weapon.pushAcceleration = 999;
  assert.equal(campaign.getState().coins, 35); assert.equal(campaign.getWeapon().pushAcceleration, 24);
  assert.equal(campaign.getState().stars[0], 0); assert.equal(campaign.getLevels()[0].name, 'First Splash');
  assert.ok(campaign.getLevelConfig(1).enemyProfiles[0].weapon.pushAcceleration < 30);
});
test('Maximum-gun preview provides three strong jets without spending or faking progress', () => {
  const campaign = make(), before = campaign.getState(), max = campaign.getMaxWeapon();
  assert.equal(max.jetCount, 3); assert.ok(max.visualScale > 1.8); assert.equal(max.pushAcceleration, 35);
  assert.ok(max.range > 6.5 && max.range < 6.7); assert.equal(max.waterCapacity, 166); assert.deepEqual(campaign.getState(), before);
  max.upgrades.pressure = 0; assert.equal(campaign.getMaxWeapon().upgrades.pressure, 5);
});
test('Two pump upgrades improve pressure without granting a runaway advantage; saved high ranks use the same curve', () => {
  const base=make().getWeapon(), two=make({version:1,upgrades:{pressure:2}}).getWeapon();
  assert.ok(two.pushAcceleration>base.pushAcceleration);
  assert.ok(two.pushAcceleration/base.pushAcceleration<1.20);
  const oldSave=make({version:1,coins:94,upgrades:{pressure:5,reach:4,nozzle:4,tank:4}});
  assert.equal(oldSave.getState().coins,94);assert.equal(oldSave.getState().upgrades.pressure,5);
  assert.equal(oldSave.getWeapon().pushAcceleration,35);
  assert.equal(oldSave.getWeapon().jetCount,3);assert.ok(oldSave.getWeapon().visualScale>1.8);
});
test('Every upgrade rank adds controlled real benefit and tank efficiency cannot double sustained fire', () => {
  const base=make().getWeapon();
  for(const definition of UPGRADE_DEFINITIONS){
    let previous=base;
    for(let rank=1;rank<=definition.maxRank;rank++){
      const next=make({version:1,upgrades:{[definition.id]:rank}}).getWeapon();
      if(definition.id==='pressure')assert.ok(next.pushAcceleration>previous.pushAcceleration);
      if(definition.id==='reach')assert.ok(next.range>previous.range);
      if(definition.id==='nozzle')assert.ok(next.beamRadius>previous.beamRadius);
      if(definition.id==='tank'){
        assert.ok(next.waterCapacity>previous.waterCapacity);assert.ok(next.waterUse<previous.waterUse);
        assert.ok(next.passiveWaterRate>previous.passiveWaterRate);
      }
      previous=next;
    }
  }
  const tank=make({version:1,upgrades:{tank:4}}).getWeapon();
  assert.ok((tank.waterCapacity/tank.waterUse)/(base.waterCapacity/base.waterUse)<1.8);
});
test('Campaign tactics, prediction and refilling develop across chapters without changing quick-match defaults', () => {
  const campaign=make(),first=campaign.getLevelConfig(1),last=campaign.getLevelConfig(12);
  assert.ok(first.params.aiOpeningGrace>=4);
  for(let id=2;id<=12;id++){
    const before=campaign.getLevelConfig(id-1),after=campaign.getLevelConfig(id);
    assert.ok(after.enemyProfiles[2].tacticalLevel>before.enemyProfiles[2].tacticalLevel);
    assert.ok(after.enemyProfiles[2].aimLead>before.enemyProfiles[2].aimLead);
    assert.ok(after.enemyProfiles[2].weapon.refillRate>before.enemyProfiles[2].weapon.refillRate);
    assert.ok(after.params.aiReaction<before.params.aiReaction);
  }
  assert.ok(last.enemyProfiles[0].tacticalLevel<=1);
  assert.ok(last.enemyProfiles[0].weapon.pushAcceleration>first.enemyProfiles[0].weapon.pushAcceleration);
  assert.ok(last.enemyProfiles[0].pushResistance>first.enemyProfiles[2].pushResistance);
});
test('Campaign rivals gain real footing by chapter and captains are firmer than ordinary opponents', () => {
  const campaign=make(),normal=[1.10,1.29,1.30,1.40,1.42,1.44,1.55,1.57,1.59,1.70,1.72,1.74];
  let previous=0;
  for(let id=1;id<=12;id++){
    const config=campaign.getLevelConfig(id),rival=config.enemyProfiles[2];
    assert.ok(Math.abs(rival.pushResistance-normal[id-1])<1e-9);
    assert.ok(rival.pushResistance>previous);previous=rival.pushResistance;
    if(id%3===0){
      const captain=config.enemyProfiles[0],expected=[1.45,1.65,1.90,2.10][config.stage.chapter-1];
      assert.ok(Math.abs(captain.pushResistance-expected)<1e-9);
      assert.ok(captain.pushResistance>rival.pushResistance);
    }
  }
  assert.ok(campaign.getLevelConfig(5).enemyProfiles[2].pushResistance>=1.35);
  assert.ok(campaign.getLevelConfig(10).enemyProfiles[2].pushResistance>=1.65);
  assert.ok(Math.abs(campaign.getLevelConfig(12).enemyProfiles[0].pushResistance-2.1)<1e-9);
});
test('Firmer opposition preserves existing currency, purchased gun power and save schema', () => {
  const store=storage({version:1,coins:94,upgrades:{pressure:2,reach:0,nozzle:0,tank:0},stars:[3,3,3,2]});
  const campaign=new Campaign({storage:store}),before=campaign.getState(),gun=campaign.getWeapon();
  assert.equal(before.coins,94);assert.equal(before.version,1);assert.equal(before.upgrades.pressure,2);
  assert.equal(gun.pushAcceleration,28.4);assert.equal(gun.range,5.1);assert.equal(gun.visualScale,1.28);
  assert.equal(gun.waterCapacity,110);assert.equal(gun.waterUse,17);
  assert.deepEqual(campaign.getLevelConfig(5).playerWeapon,gun);
  assert.ok(campaign.getLevelConfig(5).enemyProfiles[0].pushResistance>=1.35);
  const reloaded=new Campaign({storage:store});
  assert.deepEqual(reloaded.getState(),before);assert.deepEqual(reloaded.getWeapon(),gun);
  assert.equal(UPGRADE_DEFINITIONS.find(upgrade=>upgrade.id==='pressure').baseCost,35);
});
test('AI guns visibly and physically advance by chapter; captains unlock three jets earlier', () => {
  const campaign=make();let previous=campaign.getLevelConfig(1).enemyProfiles[2].weapon;
  assert.equal(previous.tier,0);assert.equal(previous.jetCount,1);assert.equal(previous.visualScale,1);
  for(let id=2;id<=12;id++){
    const config=campaign.getLevelConfig(id),ordinary=config.enemyProfiles[2].weapon;
    for(const stat of ['range','beamRadius','pushAcceleration','waterCapacity','refillRate','passiveWaterRate','visualScale'])
      assert.ok(ordinary[stat]>previous[stat],stat+' grows at level '+id);
    assert.equal(ordinary.tier,config.stage.chapter-1);
    assert.equal(ordinary.jetCount,id>=10?3:1);
    assert.ok(ordinary.waterUse>16&&ordinary.waterUse<=18);
    if(id%3===0){
      const captain=config.enemyProfiles[0].weapon;
      assert.equal(captain.tier,config.stage.chapter);assert.equal(captain.jetCount,id>=6?3:1);
      for(const stat of ['range','beamRadius','pushAcceleration','waterCapacity','visualScale'])assert.ok(captain[stat]>ordinary[stat]);
    }
    previous=ordinary;
  }
});
test('AI equipment is independent of purchases and cannot consume player coins or rewrite their ranks', () => {
  const campaign=make({version:1,coins:5000}),before=campaign.getLevelConfig(11).enemyProfiles;
  const beforeSave=campaign.getState();
  for(const definition of UPGRADE_DEFINITIONS)for(let rank=0;rank<definition.maxRank;rank++)
    assert.equal(campaign.purchaseUpgrade(definition.id).success,true);
  const afterSave=campaign.getState();
  assert.deepEqual(campaign.getLevelConfig(11).enemyProfiles,before);
  assert.equal(afterSave.coins,beforeSave.coins-1415);
  assert.deepEqual(afterSave.stars,beforeSave.stars);assert.equal(afterSave.highestUnlocked,beforeSave.highestUnlocked);
  assert.equal(campaign.getWeapon().pushAcceleration,35);assert.equal(campaign.getWeapon().waterCapacity,166);
});
test('Quota failure during a later purchase keeps earned progression and never throws', () => {
  const store = storage(), campaign = new Campaign({ storage: store });
  clear(campaign, 1); store.setItem = () => { throw Error('quota exceeded'); };
  assert.equal(campaign.purchaseUpgrade('pressure').success, true); assert.equal(campaign.getState().coins, 55);
  assert.equal(campaign.getState().highestUnlocked, 2); assert.equal(campaign.getState().saveStatus, 'memory-only');
});
test('An early goal played through timeout retains fast-clear stars and best completion time', () => {
  const campaign=make(); clear(campaign,1);
  const config=campaign.startLevel(2),state=result(config,{duration:38,eliminations:2});
  Object.assign(state.result,{stageGoalCompleted:true,objectiveCompletedAt:10});
  const outcome=campaign.finishAttempt(state);
  assert.equal(outcome.cleared,true);assert.equal(outcome.stars,3);assert.equal(outcome.duration,10);
  assert.equal(state.result.duration,38);assert.equal(campaign.getState().best[1].duration,10);
  assert.equal(outcome.coinsEarned,59+10+10);
});
test('Continuing after a goal and later falling preserves earned stars and unlocks', () => {
  const campaign=make();clear(campaign,1);
  const config=campaign.startLevel(2),state=result(config,{duration:20,alive:false,eliminations:1});
  Object.assign(state.result,{stageGoalCompleted:true,objectiveCompletedAt:10});
  const outcome=campaign.finishAttempt(state);
  assert.equal(outcome.cleared,true);assert.equal(outcome.stars,3);
  assert.equal(campaign.getState().highestUnlocked,3);assert.equal(campaign.getState().best[1].duration,10);
  const late=campaign.startLevel(2),lateState=result(late,{duration:37,alive:false});
  Object.assign(lateState.result,{stageGoalCompleted:true,objectiveCompletedAt:32});
  assert.equal(campaign.finishAttempt(lateState).stars,2);
});
test('A reached goal pays nothing while playing or paused and its final reward survives reload exactly once', () => {
  const store=storage(),campaign=new Campaign({storage:store});clear(campaign,1);
  const config=campaign.startLevel(2),before=campaign.getState().coins;
  const final=result(config,{duration:38});Object.assign(final.result,{stageGoalCompleted:true,objectiveCompletedAt:12});
  for(const phase of ['playing','paused']){
    assert.equal(campaign.finishAttempt({...final,phase}).reason,'unfinished-round');
    assert.equal(campaign.getState().coins,before);
  }
  const outcome=campaign.finishAttempt(final),paid=campaign.getState().coins;
  assert.equal(paid,before+outcome.coinsEarned);assert.equal(campaign.finishAttempt(final).duplicate,true);
  const reloaded=new Campaign({storage:store});assert.equal(reloaded.finishAttempt(final).duplicate,true);
  assert.equal(reloaded.getState().coins,paid);
});
test('Malformed completion timestamps and failure cannot manufacture fast-clear rewards', () => {
  for(const timestamp of [-1,39,Infinity]){
    const campaign=make();clear(campaign,1);const config=campaign.startLevel(2),state=result(config,{duration:38,alive:false});
    Object.assign(state.result,{stageGoalCompleted:true,objectiveCompletedAt:timestamp});
    const outcome=campaign.finishAttempt(state);assert.equal(outcome.stars,1);assert.equal(outcome.duration,38);
  }
  const campaign=make();clear(campaign,1);const config=campaign.startLevel(2),state=result(config,{duration:12,alive:false,cleared:false});
  Object.assign(state.result,{stageGoalCompleted:false,objectiveCompletedAt:null});
  const outcome=campaign.finishAttempt(state);assert.equal(outcome.stars,0);assert.equal(campaign.getState().highestUnlocked,2);
});
console.log(`Campaign checks: ${passed} passed`);
