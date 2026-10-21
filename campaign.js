// Small, offline campaign and upgrade economy. Gameplay remains in WaterGameCore.
const clone = value => JSON.parse(JSON.stringify(value));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const int = (value, min, max, fallback = min) => Number.isFinite(value) ? clamp(Math.floor(value), min, max) : fallback;
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export const SAVE_KEY = 'water-push-campaign-v1';
export const CHAPTERS = freeze([
  { id: 1, name: 'Garden', theme: 'spring' },
  { id: 2, name: 'Sunset', theme: 'sunset' },
  { id: 3, name: 'Lagoon', theme: 'lagoon' },
  { id: 4, name: 'Moonlight', theme: 'moon' }
]);
export const LEVELS = freeze([
  { id: 1, name: 'First Splash', chapter: 1, type: 'survive', count: 0, duration: 25, fountainPattern: 'alternating', objectiveText: 'Stay on the platform and complete the goal.' },
  { id: 2, name: 'Washout', chapter: 1, type: 'eliminate', count: 1, duration: 38, fountainPattern: 'alternating', objectiveText: 'Stay on the platform and complete the goal.' },
  { id: 3, name: 'Garden Guard', chapter: 1, type: 'boss', count: 1, duration: 42, fountainPattern: 'ring', objectiveText: 'Stay on the platform and complete the goal.' },
  { id: 4, name: 'Sunset Chase', chapter: 2, type: 'survive', count: 0, duration: 36, fountainPattern: 'ring', objectiveText: 'Stay on the platform and complete the goal.' },
  { id: 5, name: 'Double Trouble', chapter: 2, type: 'eliminate', count: 2, duration: 44, fountainPattern: 'alternating', objectiveText: 'Stay on the platform and complete the goal.' },
  { id: 6, name: 'Sunset Ace', chapter: 2, type: 'boss', count: 1, bossRounds: 2, duration: 46, fountainPattern: 'pulse', objectiveText: 'Stay on the platform and complete the goal.' },
  { id: 7, name: 'High Tide', chapter: 3, type: 'survive', count: 0, duration: 42, fountainPattern: 'pulse', objectiveText: 'Stay on the platform and complete the goal.' },
  { id: 8, name: 'Crosscurrent', chapter: 3, type: 'eliminate', count: 2, duration: 48, fountainPattern: 'ring', objectiveText: 'Stay on the platform and complete the goal.' },
  { id: 9, name: 'Lagoon Tank', chapter: 3, type: 'boss', count: 1, bossRounds: 2, duration: 52, fountainPattern: 'pulse', objectiveText: 'Stay on the platform and complete the goal.' },
  { id: 10, name: 'Moon Sweep', chapter: 4, type: 'eliminate', count: 3, duration: 55, fountainPattern: 'ring', objectiveText: 'Stay on the platform and complete the goal.' },
  { id: 11, name: 'Fountain Rush', chapter: 4, type: 'eliminate', count: 3, duration: 58, fountainPattern: 'pulse', objectiveText: 'Stay on the platform and complete the goal.' },
  { id: 12, name: 'Final Splash', chapter: 4, type: 'boss', count: 1, bossRounds: 3, duration: 60, fountainPattern: 'pulse', objectiveText: 'Stay on the platform and complete the goal.' }
].map(level => ({ ...level, theme: CHAPTERS[level.chapter - 1].theme, bossId: level.type === 'boss' ? 'ai1' : null,
  bossRounds: level.type === 'boss' ? level.bossRounds || 1 : 0,
  firstClearCoins: 55 + (level.id - 1) * 4, replayCoins: 15 + Math.floor((level.id - 1) * 1.35) })));

export const UPGRADE_DEFINITIONS = freeze([
  { id: 'pressure', name: 'Pressure', maxRank: 5, baseCost: 35, costStep: 25,
    description: 'Stronger, thicker spray.' },
  { id: 'reach', name: 'Reach', maxRank: 4, baseCost: 45, costStep: 25,
    description: 'Reach rivals from farther away.' },
  { id: 'nozzle', name: 'Spray', maxRank: 4, baseCost: 50, costStep: 30,
    description: 'Wider spray. Triple jets at level 2.' },
  { id: 'tank', name: 'Tank', maxRank: 4, baseCost: 40, costStep: 20,
    description: 'More water and faster refill.' }
]);
const emptyRanks = () => Object.fromEntries(UPGRADE_DEFINITIONS.map(upgrade => [upgrade.id, 0]));
const newSave = () => ({ version: 1, coins: 35, selectedLevel: 1, highestUnlocked: 1,
  upgrades: emptyRanks(), stars: Array(12).fill(0), best: Array(12).fill(null), lastOutcome: null });

function weaponFor(ranks) {
  const p = ranks.pressure || 0, r = ranks.reach || 0, n = ranks.nozzle || 0, t = ranks.tank || 0;
  return {
    // Ranks retain their saved value. Power grows steadily, while the larger
    // rendered stream and the three-jet unlock carry most of the spectacle.
    range: 5 + r * .34 + p * .05,
    beamRadius: .18 + n * .035,
    pushAcceleration: 24 + p * 2.2,
    waterCapacity: 110 + t * 14,
    waterUse: 17 * (1 - t * .03),
    refillRate: 50 + t * 3,
    passiveWaterRate: 9 + t * .75,
    visualScale: 1 + p * .14 + n * .06,
    tier: Math.max(p, n),
    jetCount: n >= 2 ? 3 : 1,
    spreadAngle: n >= 2 ? .14 + (n - 2) * .025 : 0,
    upgrades: { ...ranks }
  };
}

function sanitizeSave(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1) return newSave();
  const save = newSave();
  save.coins = int(raw.coins, 0, 999999, 35);
  for (const upgrade of UPGRADE_DEFINITIONS) save.upgrades[upgrade.id] = int(raw.upgrades?.[upgrade.id], 0, upgrade.maxRank);
  save.stars = Array.from({ length: 12 }, (_, index) => int(raw.stars?.[index], 0, 3));
  // Unlocking is backed by contiguous actual clear records, never by a stray index.
  let highest = 1;
  while (highest < 12 && save.stars[highest - 1] > 0) highest++;
  save.highestUnlocked = highest;
  save.selectedLevel = int(raw.selectedLevel ?? raw.selected, 1, highest);
  save.best = Array.from({ length: 12 }, (_, index) => {
    const record = raw.best?.[index];
    if (!record || typeof record !== 'object' || !save.stars[index]) return null;
    return { stars: int(record.stars, 1, save.stars[index]),
      duration: Number.isFinite(record.duration) ? clamp(record.duration, 0, 600) : LEVELS[index].duration,
      eliminations: int(record.eliminations, 0, (LEVELS[index].bossRounds || 1) + 2), clears: int(record.clears, 1, 100000) };
  });
  const outcome = raw.lastOutcome;
  if (outcome && typeof outcome === 'object' && typeof outcome.attemptId === 'string' && outcome.attemptId.length < 160 &&
    typeof outcome.sessionToken === 'string' && outcome.sessionToken.length < 160 && Number.isInteger(outcome.levelId) &&
    outcome.levelId >= 1 && outcome.levelId <= 12 && typeof outcome.cleared === 'boolean') {
    save.lastOutcome = { success: true, attemptId: outcome.attemptId, sessionToken: outcome.sessionToken,
      levelId: outcome.levelId, cleared: outcome.cleared, firstClear: !!outcome.firstClear,
      coinsEarned: int(outcome.coinsEarned, 0, 200), stars: int(outcome.stars, 0, 3),
      eliminations: int(outcome.eliminations, 0, (LEVELS[outcome.levelId - 1].bossRounds || 1) + 2), duration: Number.isFinite(outcome.duration) ? clamp(outcome.duration, 0, 600) : 0,
      nextLevel: outcome.cleared && outcome.levelId < 12 ? outcome.levelId + 1 : null,
      campaignComplete: !!outcome.campaignComplete, improvedStars: !!outcome.improvedStars };
  }
  return save;
}

export class Campaign {
  constructor(options = {}) {
    this.key = options.key || SAVE_KEY;
    this._storage = options.storage;
    this._storageReadable = true;
    if (options.storage === undefined) {
      try { this._storage = globalThis.localStorage || null; }
      catch { this._storage = null; this._storageReadable = false; }
    }
    this._saveStatus = this._storage ? 'saved' : 'memory-only';
    this._active = null;
    this._sequence = 0;
    this._session = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() :
      Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    let raw = null;
    try {
      const stored = this._storage?.getItem(this.key);
      if (stored) raw = JSON.parse(stored);
    } catch { this._storageReadable = false; }
    this._save = sanitizeSave(raw);
    this._persist();
  }

  _persist() {
    if (!this._storage) { this._saveStatus = 'memory-only'; return; }
    try { this._storage.setItem(this.key, JSON.stringify(this._save)); this._saveStatus = 'saved'; }
    catch { this._saveStatus = 'memory-only'; }
  }

  getState() { return { ...clone(this._save), selected: this._save.selectedLevel, saveStatus: this._saveStatus,
    activeLevel: this._active?.levelId || null, activeAttemptId: this._active?.attemptId || null }; }

  getLevels() {
    return LEVELS.map(level => ({ ...clone(level), chapterName: CHAPTERS[level.chapter - 1].name,
      unlocked: level.id <= this._save.highestUnlocked, stars: this._save.stars[level.id - 1],
      selected: level.id === this._save.selectedLevel, best: clone(this._save.best[level.id - 1]) }));
  }

  getWeapon() { return weaponFor(this._save.upgrades); }

  getMaxWeapon() { return weaponFor(Object.fromEntries(UPGRADE_DEFINITIONS.map(upgrade => [upgrade.id, upgrade.maxRank]))); }

  getUpgrades() {
    return UPGRADE_DEFINITIONS.map(upgrade => {
      const rank = this._save.upgrades[upgrade.id], maxed = rank === upgrade.maxRank;
      const cost = maxed ? 0 : upgrade.baseCost + rank * upgrade.costStep;
      const next = { ...this._save.upgrades, [upgrade.id]: Math.min(upgrade.maxRank, rank + 1) };
      const stats = weaponFor(this._save.upgrades), nextStats = weaponFor(next);
      let nextDescription = 'Max level';
      if (!maxed) {
        if (upgrade.id === 'pressure') nextDescription = `Power ${stats.pushAcceleration.toFixed(1)} → ${nextStats.pushAcceleration.toFixed(1)} · Thicker spray`;
        if (upgrade.id === 'reach') nextDescription = `Range ${stats.range.toFixed(1)} → ${nextStats.range.toFixed(1)} m`;
        if (upgrade.id === 'nozzle') nextDescription = nextStats.jetCount > stats.jetCount ? 'Unlock triple spray' :
          `Spray width ${(stats.beamRadius * 2).toFixed(2)} → ${(nextStats.beamRadius * 2).toFixed(2)} m`;
        if (upgrade.id === 'tank') nextDescription = `Capacity ${stats.waterCapacity} → ${nextStats.waterCapacity} · Refill ${stats.passiveWaterRate} → ${nextStats.passiveWaterRate}/s`;
      }
      return { ...clone(upgrade), rank, level: rank, cost, maxed, canBuy: !this._active && !maxed && this._save.coins >= cost,
        nextDescription, stats, nextStats };
    });
  }

  selectLevel(levelId) {
    if (!Number.isInteger(levelId) || levelId < 1 || levelId > this._save.highestUnlocked) return false;
    this._save.selectedLevel = levelId; this._persist(); return true;
  }

  purchaseUpgrade(id) {
    if (this._active) return { success: false, reason: 'round-active' };
    const upgrade = UPGRADE_DEFINITIONS.find(upgrade => upgrade.id === id);
    if (!upgrade) return { success: false, reason: 'unknown-upgrade' };
    const rank = this._save.upgrades[id];
    if (rank >= upgrade.maxRank) return { success: false, reason: 'max-rank' };
    const cost = upgrade.baseCost + rank * upgrade.costStep;
    if (this._save.coins < cost) return { success: false, reason: 'insufficient-coins', cost };
    this._save.coins -= cost; this._save.upgrades[id]++; this._persist();
    return { success: true, id, rank: rank + 1, cost, coins: this._save.coins, weapon: this.getWeapon() };
  }

  getLevelConfig(levelId = this._save.selectedLevel) {
    if (!Number.isInteger(levelId) || levelId < 1 || levelId > 12) return null;
    const level = LEVELS[levelId - 1], progress = (levelId - 1) / 11, boss = level.type === 'boss';
    const params = {
      roundDuration: level.duration, countdownDuration: 3,
      playerShootingMoveFactor: .91, playerPushFactor: .60 + progress * .18,
      passiveWaterDelay: .8, waterUse: 17, waterCapacity: 110, passiveWaterRate: 9,
      aiMoveFactor: .70 + progress * .38, aiReaction: .46 - progress * .28,
      aiAimError: (15 - progress * 11) * Math.PI / 180,
      aiBurstDuration: .65 + progress * .40, aiBurstRest: .95 - progress * .50,
      aiOpeningGrace: 4.5 - progress * 3, aiPlayerTargetLimit: levelId < 7 ? 1 : 2,
      aiPlayerTargetPenalty: .75 - progress * .45,
      refillRadius: 1.5, outerFountainRadius: 2.5 + progress * .9,
      fountainPeriod: 5 - progress * 1.5, fountainPreview: .65,
      fountainPattern: level.fountainPattern
    };
    const enemyProfiles = [1, 2, 3].map(index => {
      const isBoss = boss && index === 1;
      // Rival equipment develops by chapter independently of the player's
      // purchases. Captains get the next tier early, including the scattergun.
      const weaponTier = level.chapter - 1 + (isBoss ? 1 : 0);
      const threeJets = isBoss ? level.chapter >= 2 : level.chapter >= 4;
      const weapon = { range: 4.6 + weaponTier * .30 + progress * .65 + (isBoss ? .20 : 0),
        beamRadius: .18 + weaponTier * .025 + progress * .025,
        pushAcceleration: 20.5 + weaponTier * 2.5 + progress * 4.5 + (isBoss ? 1.5 : 0),
        waterCapacity: 100 + weaponTier * 12 + progress * 10 + (isBoss ? 30 : 0),
        waterUse: 18 * (1 - weaponTier * .015),
        refillRate: 46 + progress * 10 + weaponTier * 3,
        passiveWaterRate: progress * 2.5 + weaponTier * .60 + (isBoss ? .3 : 0),
        tier: weaponTier, visualScale: 1 + weaponTier * .16 + progress * .04 + (isBoss ? .10 : 0),
        jetCount: threeJets ? 3 : 1, spreadAngle: threeJets ? .12 + weaponTier * .015 : 0 };
      return { id: 'ai' + index, role: isBoss ? 'boss' : 'rival', isBoss, name: isBoss ? level.name : 'AI ' + index,
        scale: isBoss ? 1.15 + (level.chapter - 1) * .05 : 1,
        // Opponents hold their footing longer; the player's purchased gun
        // keeps its pressure, stream size, reach and water economy unchanged.
        pushResistance: isBoss ? [1.45, 1.65, 1.90, 2.10][level.chapter - 1] :
          [1.10, 1.29, 1.30, 1.40, 1.42, 1.44, 1.55, 1.57, 1.59, 1.70, 1.72, 1.74][levelId - 1],
        tacticalLevel: .30 + progress * .65 + (isBoss ? .05 : 0),
        aimLead: .05 + progress * .13,
        edgeMargin: 1.15 + progress * .60,
        prediction: .35 + progress * .20,
        preferredRange: 2.2 + progress * .80,
        moveFactor: 1, weapon };
    });
    return { params, playerWeapon: this.getWeapon(), enemyProfiles,
      stage: { id: levelId, levelId, name: level.name, chapter: level.chapter, chapterName: CHAPTERS[level.chapter - 1].name,
        theme: level.theme, objectiveText: level.objectiveText, fountainPattern: level.fountainPattern,
        objective: { type: level.type, count: level.count, bossId: level.bossId, bossRounds: level.bossRounds }, attemptId: null, sessionToken: null } };
  }

  startLevel(levelId = this._save.selectedLevel) {
    if (!this.selectLevel(levelId)) return null;
    const config = this.getLevelConfig(levelId), attemptId = `${this._session}:${++this._sequence}`;
    this._active = { levelId, attemptId, sessionToken: this._session };
    config.stage.attemptId = attemptId; config.stage.sessionToken = this._session;
    return config;
  }

  // Quitting a round grants nothing and lets the workshop become available again.
  abandonAttempt() { this._active = null; }

  finishAttempt(state) {
    const stage = state?.stage, result = state?.result;
    if (state?.phase !== 'result' || !result || !stage?.attemptId || !stage?.sessionToken) return { success: false, reason: 'unfinished-round' };
    if (this._save.lastOutcome?.attemptId === stage.attemptId && this._save.lastOutcome?.sessionToken === stage.sessionToken)
      return { ...clone(this._save.lastOutcome), duplicate: true };
    const active = this._active;
    if (!active || active.attemptId !== stage.attemptId || active.sessionToken !== stage.sessionToken ||
      active.levelId !== (stage.levelId ?? stage.id)) return { success: false, reason: 'unknown-attempt' };
    const level = LEVELS[active.levelId - 1], player = state.actors?.find(actor => actor.isPlayer || actor.id === 'p1');
    const eliminations = int(result.playerEliminations ?? player?.stats?.eliminations, 0, (level.bossRounds || 1) + 2);
    const cleared = !!result.cleared;
    const actualDuration = Number.isFinite(result.duration ?? state.timeElapsed) ? clamp(result.duration ?? state.timeElapsed, 0, level.duration) : level.duration;
    // Rate the moment the player achieved the goal, while the actual match can keep running.
    const priorGoal = cleared && level.type !== 'survive' && result.stageGoalCompleted === true &&
      Number.isFinite(result.objectiveCompletedAt) && result.objectiveCompletedAt >= 0 &&
      result.objectiveCompletedAt <= actualDuration + 1e-7;
    const duration = priorGoal ? clamp(result.objectiveCompletedAt, 0, actualDuration) : actualDuration;
    const ratingAlive = !!player?.alive || priorGoal;
    let stars = 0;
    if (cleared) {
      stars = 1;
      if (ratingAlive && (level.type !== 'survive' || eliminations >= 1 || (player.stats?.hitTime || 0) >= 1)) stars = 2;
      if (ratingAlive && ((level.type === 'survive' && eliminations >= 1 && player.water >= (player.weapon?.waterCapacity || 110) * .30) ||
        (level.type !== 'survive' && duration < level.duration * .75))) stars = 3;
    }
    const previousStars = this._save.stars[level.id - 1], firstClear = cleared && previousStars === 0;
    const improvedStars = stars > previousStars;
    const coinsEarned = (cleared ? (firstClear ? level.firstClearCoins : level.replayCoins) : 10) + Math.min(3, eliminations) * 5 +
      (cleared && improvedStars ? Math.max(0, stars - Math.max(1, previousStars)) * 5 : 0);
    this._save.coins = Math.min(999999, this._save.coins + coinsEarned);
    if (cleared) {
      this._save.stars[level.id - 1] = Math.max(previousStars, stars);
      this._save.highestUnlocked = Math.max(this._save.highestUnlocked, Math.min(12, level.id + 1));
      const previous = this._save.best[level.id - 1];
      this._save.best[level.id - 1] = { stars: Math.max(previousStars, stars), duration: previous ? Math.min(previous.duration, duration) : duration,
        eliminations: Math.max(previous?.eliminations || 0, eliminations), clears: (previous?.clears || 0) + 1 };
    }
    const outcome = { success: true, attemptId: active.attemptId, sessionToken: active.sessionToken, levelId: level.id,
      cleared, firstClear, coinsEarned, stars, eliminations, duration, improvedStars,
      nextLevel: cleared && level.id < 12 ? level.id + 1 : null,
      campaignComplete: cleared && level.id === 12 };
    this._save.lastOutcome = outcome; this._active = null; this._persist(); return clone(outcome);
  }
}

export default Campaign;
