(function (global) {
  'use strict';

  const DEFAULTS = Object.freeze({
    arenaRadius: 7, spawnRadius: 4, actorRadius: 0.35,
    moveSpeed: 3.2, shootingMoveFactor: 0.7, moveResponse: 0.035,
    turnSpeed: Math.PI * 4, range: 5, beamRadius: 0.18, muzzleOffset: 0.35,
    pushAcceleration: 24, damping: 5, maxKickSpeed: 4.5, maxSpeed: 6.5,
    waterCapacity: 100, waterUse: 25, refillRate: 50, refillRadius: 1.2,
    outerFountainRadius: 2.8, fountainPeriod: 4, fountainPreview: 0.5,
    roundDuration: 30, countdownDuration: 3, outsideGrace: 0.10,
    fixedStep: 1 / 60, maxFrameDelta: 0.25, maxAccumulatedTime: 0.25,
    hitFeedback: 0.12, aiReaction: 0.25, aiAimError: 7 * Math.PI / 180,
    aiTargetPeriod: 0.5, aiTargetHold: 1, aiLowWater: 25, aiFullWater: 80,
    aiEdgeMargin: 1.2, aiPrediction: 0.35, maxEvents: 80,
    playerShootingMoveFactor: null, playerPushFactor: 1,
    passiveWaterDelay: 0.9, passiveWaterRate: 0,
    aiMoveFactor: 1, aiBurstDuration: 0, aiBurstRest: 0,
    aiOpeningGrace: 0, aiPlayerTargetLimit: 0, aiPlayerTargetPenalty: 0
  });
  const DIFFICULTIES = Object.freeze({
    easy: Object.freeze({ id: 'easy', label: 'Easy', roundDuration: 45,
      description: '45-second round. Rivals have a 4-second opening delay. Water refills after 0.9 seconds without spraying.',
      params: Object.freeze({ roundDuration: 45, playerShootingMoveFactor: 0.9,
        playerPushFactor: 0.65, waterUse: 18, refillRadius: 1.5,
        passiveWaterDelay: 0.9, passiveWaterRate: 8, aiMoveFactor: 0.72,
        aiReaction: 0.4, aiAimError: 12 * Math.PI / 180,
        aiBurstDuration: 0.75, aiBurstRest: 0.85,
        aiOpeningGrace: 4, aiPlayerTargetLimit: 1, aiPlayerTargetPenalty: 0.75 }) }),
    standard: Object.freeze({ id: 'standard', label: 'Standard', roundDuration: 30,
      description: 'Stay on the platform. Stop spraying or use a fountain to refill.',
      params: Object.freeze({}) })
  });
  const EPS = 1e-9;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const len = (x, y) => Math.hypot(x, y);
  function normalize(x, y) {
    const n = len(x, y);
    return n > EPS ? { x: x / n, y: y / n } : { x: 0, y: 0 };
  }
  function limit(x, y, max) {
    const n = len(x, y);
    return n > max ? { x: x / n * max, y: y / n * max } : { x, y };
  }
  function angleDelta(a, b) {
    return Math.atan2(Math.sin(b - a), Math.cos(b - a));
  }
  function hashSeed(seed) {
    if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;
    let h = 2166136261;
    for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return h >>> 0;
  }
  function copyData(value) {
    if (Array.isArray(value)) return value.map(copyData);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, copyData(entry)]));
    return value;
  }
  function numeric(value, fallback, min, max) {
    return clamp(Number.isFinite(value) ? value : fallback, min, max);
  }

  /** Pure gameplay, independent of meshes, animation, camera and rendering.
   * Input moveX/moveY and aimX/aimY are world-space vectors on the x/y plane.
   * Returned state is a live read-only-by-convention view; renderers must not mutate it.
   */
  class WaterGameCore {
    constructor(options = {}) {
      const { seed, difficulty, params, ...legacyParams } = options;
      this.difficulty = Object.hasOwn(DIFFICULTIES, difficulty) ? difficulty : 'easy';
      this._quickDifficulty = this.difficulty;
      this._roundConfig = null;
      this._paramOverrides = { ...(params || legacyParams) };
      this.params = { ...DEFAULTS, ...DIFFICULTIES[this.difficulty].params, ...this._paramOverrides };
      this._eventSeq = 0;
      this._roundSeq = 0;
      this.reset(options.seed === undefined ? 1 : options.seed);
    }

    getDifficulty() { return this.difficulty; }

    getDifficultyInfo() {
      const { id, label, description } = DIFFICULTIES[this.difficulty];
      return { id, label, description, roundDuration: this.params.roundDuration };
    }

    getDifficultyOptions() { return WaterGameCore.getDifficultyOptions(); }

    setDifficulty(difficulty) {
      if (this.phase !== 'ready' || this._roundConfig || !Object.hasOwn(DIFFICULTIES, difficulty)) return false;
      if (difficulty === this.difficulty) return true;
      this.difficulty = difficulty;
      this._quickDifficulty = difficulty;
      this.params = { ...DEFAULTS, ...DIFFICULTIES[difficulty].params, ...this._paramOverrides };
      this.reset(this.seed);
      return true;
    }

    /** Campaign configs are snapshots; changing a shop object cannot alter a live round. */
    configureRound(config, seed = this.seed + 1) {
      if (this.phase !== 'ready' && this.phase !== 'result') return false;
      if (config != null && (typeof config !== 'object' || Array.isArray(config))) return false;
      if (config == null) {
        this._roundConfig = null;
        this.difficulty = this._quickDifficulty;
      } else {
        if (!this._roundConfig) this._quickDifficulty = this.difficulty;
        this._roundConfig = copyData(config);
        this.difficulty = 'easy';
      }
      this.params = { ...DEFAULTS, ...DIFFICULTIES[this.difficulty].params, ...this._paramOverrides,
        ...(this._roundConfig?.params || {}) };
      return this.reset(seed);
    }

    _weapon(overrides = {}) {
      const p = this.params;
      return {
        range: numeric(overrides.range, p.range, .1, 30),
        beamRadius: numeric(overrides.beamRadius, p.beamRadius, .01, 2),
        pushAcceleration: numeric(overrides.pushAcceleration, p.pushAcceleration, 0, 200),
        waterCapacity: numeric(overrides.waterCapacity, p.waterCapacity, 1, 10000),
        waterUse: numeric(overrides.waterUse, p.waterUse, .1, 1000),
        passiveWaterRate: numeric(overrides.passiveWaterRate, p.passiveWaterRate, 0, 500),
        refillRate: numeric(overrides.refillRate, p.refillRate, 0, 1000),
        jetCount: Math.round(numeric(overrides.jetCount, 1, 1, 3)),
        spreadAngle: numeric(overrides.spreadAngle, .14, 0, Math.PI / 3),
        visualScale: numeric(overrides.visualScale, 1, .1, 3),
        tier: Math.round(numeric(overrides.tier, 0, 0, 99))
      };
    }

    _enemyProfile(index) {
      const profiles = this._roundConfig?.enemyProfiles;
      let source = {};
      if (Array.isArray(profiles)) source = profiles.find(profile => profile?.id === 'ai' + index) ||
        (profiles[index - 1]?.id == null ? profiles[index - 1] : null) || {};
      else if (profiles && typeof profiles === 'object') source = profiles['ai' + index] || {};
      const p = this.params;
      return { ...copyData(source), id: 'ai' + index,
        moveFactor: numeric(source.moveFactor, 1, 0, 3),
        pushResistance: numeric(source.pushResistance, 1, .1, 10),
        scale: numeric(source.scale, 1, .5, 2.5),
        role: source.isBoss || source.role === 'boss' ? 'boss' : source.role || 'rival',
        reaction: numeric(source.reaction, p.aiReaction, p.fixedStep, 2),
        aimError: numeric(source.aimError, p.aiAimError, 0, Math.PI / 2),
        tacticalLevel: numeric(source.tacticalLevel, 0, 0, 1),
        aimLead: numeric(source.aimLead, 0, 0, .5),
        edgeMargin: numeric(source.edgeMargin, p.aiEdgeMargin, .25, 3),
        prediction: numeric(source.prediction, p.aiPrediction, .05, 1),
        preferredRange: numeric(source.preferredRange, 2.2, .8, 20),
        burstDuration: numeric(source.burstDuration, p.aiBurstDuration, 0, 10),
        burstRest: numeric(source.burstRest, p.aiBurstRest, 0, 10) };
    }

    reset(seed = this.seed + 1) {
      this.seed = hashSeed(seed);
      this._rngState = this.seed;
      this.roundId = ++this._roundSeq;
      this.phase = 'ready';
      this._resumePhase = null;
      this.countdown = this.params.countdownDuration;
      this.timeElapsed = 0;
      this.timeLeft = this.params.roundDuration;
      this.simTime = 0;
      this._accumulator = 0;
      this._fountainGroup = 0;
      this.events = [];
      this.beams = [];
      this.result = null;
      this.stage = this._roundConfig?.stage ? copyData(this._roundConfig.stage) : null;
      this.stageGoalCompleted = false;
      this.objectiveCompletedAt = null;
      this._bossDefeats = 0; this._bossRespawnAt = null;
      this.actors = [];
      this.fountains = [{ id: 'center', x: 0, y: 0, group: 0 }];
      for (let i = 0; i < 4; i++) {
        const a = i * Math.PI / 2;
        this.fountains.push({ id: 'outer' + i, x: Math.cos(a) * this.params.outerFountainRadius,
          y: Math.sin(a) * this.params.outerFountainRadius, group: 1 });
      }
      // Consecutive integer seeds rotate the player's slot clockwise.
      const playerSlot = this.seed % 4;
      const playerWeapon = this._weapon(this._roundConfig?.playerWeapon);
      for (let i = 0; i < 4; i++) {
        const a = Math.PI / 4 + ((playerSlot + i) % 4) * Math.PI / 2;
        const x = Math.cos(a) * this.params.spawnRadius;
        const y = Math.sin(a) * this.params.spawnRadius;
        const profile = i ? this._enemyProfile(i) : null;
        const weapon = i ? this._weapon(profile.weapon) : { ...playerWeapon };
        // Pressure improves the initial impulse; it must not also multiply the
        // victim's speed limit until retreating becomes physically impossible.
        const campaignKickCap = this.stage && i && this.params.damping > EPS ?
          this.params.maxKickSpeed + clamp((playerWeapon.pushAcceleration / Math.max(EPS, this.params.pushAcceleration) - 1) * .6, 0, .9) : this.params.maxKickSpeed;
        const kickCap = numeric(i ? profile.kickCap : this._roundConfig?.playerWeapon?.kickCap,
          campaignKickCap, .1, 40);
        this.actors.push({
          id: i === 0 ? 'p1' : 'ai' + i, index: i, isPlayer: i === 0,
          name: i === 0 ? 'P1' : 'AI ' + i, x, y, angle: Math.atan2(-y, -x),
          weapon, enemyProfile: profile, role: i ? profile.role : 'player',
          spawnVersion: 0,
          actorRadius: this.params.actorRadius * (i ? profile.scale : 1), kickCap,
          maxSpeed: this.stage ? Math.max(this.params.maxSpeed, kickCap) : this.params.maxSpeed,
          water: weapon.waterCapacity, alive: true, kx: 0, ky: 0,
          vx: 0, vy: 0, mx: 0, my: 0, shooting: false, hit: 0,
          refilling: false, regenerating: false, refillSource: null,
          rank: null, outsideTime: 0, eliminatedAt: null,
          aiState: i ? 'engaging' : null, targetId: null,
          stats: { shootingTime: 0, hitTime: 0, refillTime: 0, refillVisits: 0, regenTime: 0, eliminations: 0 },
          lastHitBy: null, lastHitAt: -1e9,
          _reaction: this._random() * (i ? profile.reaction : this.params.aiReaction),
          _targetTimer: 0, _targetHold: 0, _refillIntent: false,
          _command: { moveX: 0, moveY: 0, aimX: -x, aimY: -y, shoot: false },
          _stuckTime: 0, _lastDecisionX: x, _lastDecisionY: y,
          _hitEventAt: -10, _dry: false, _restTime: 0,
          _burstPhase: ((this.seed % 13) / 13 + Math.max(0, i - 1) / 3) *
            (i ? profile.burstDuration + profile.burstRest : 0)
        });
      }
      this._updateFountains();
      this._event('reset', { seed: this.seed, roundId: this.roundId });
      return this.getState();
    }

    start() {
      if (this.phase !== 'ready') return false;
      this.phase = 'countdown';
      this._accumulator = 0;
      this._event('countdown', { value: Math.ceil(this.countdown) });
      return true;
    }

    togglePause() {
      if (this.phase === 'paused') {
        this.phase = this._resumePhase;
        this._resumePhase = null;
        this._accumulator = 0;
        this._event('resume');
        return true;
      }
      if (this.phase !== 'playing' && this.phase !== 'countdown') return false;
      this._resumePhase = this.phase;
      this.phase = 'paused';
      this._accumulator = 0;
      this.beams = [];
      for (const a of this.actors) a.shooting = false;
      this._event('pause');
      return true;
    }

    /** Explicitly leaving bonus play banks a goal that was already earned. */
    endCompletedStage() {
      if (!this.stage || !this.stageGoalCompleted || (this.phase !== 'playing' && this.phase !== 'paused')) return false;
      this._finish('player-finish', true);
      return true;
    }

    update(realDeltaSeconds, input = {}) {
      if (this.phase !== 'playing' && this.phase !== 'countdown') return this.getState();
      const dt = Number.isFinite(realDeltaSeconds) ? clamp(realDeltaSeconds, 0, this.params.maxFrameDelta) : 0;
      this._accumulator = Math.min(this.params.maxAccumulatedTime, this._accumulator + dt);
      const command = this._sanitizeInput(input);
      while (this._accumulator + EPS >= this.params.fixedStep &&
        (this.phase === 'playing' || this.phase === 'countdown')) {
        this._accumulator -= this.params.fixedStep;
        this._fixedStep(this.params.fixedStep, command);
      }
      if (this.phase === 'result') this._accumulator = 0;
      return this.getState();
    }

    getState() {
      return { phase: this.phase, pausedFrom: this._resumePhase, countdown: this.countdown,
        timeLeft: this.timeLeft, timeElapsed: this.timeElapsed, simTime: this.simTime,
        roundId: this.roundId, seed: this.seed, params: this.params,
        difficulty: this.difficulty, difficultyInfo: this.getDifficultyInfo(), stage: this.stage,
        fountains: this.fountains, actors: this.actors, beams: this.beams,
        events: this.events, eventSeq: this._eventSeq, result: this.result,
        stageGoalCompleted: this.stageGoalCompleted, objectiveCompletedAt: this.objectiveCompletedAt,
        aliveCount: this.actors.filter(a => a.alive).length,
        fountainGroup: this._fountainGroup,
        fountainPattern: this._fountainPattern || 'alternating',
        fountainSwitchIn: this._fountainPeriod - Math.max(0, this.timeElapsed -
          Math.floor((this.timeElapsed + EPS) / this._fountainPeriod) * this._fountainPeriod),
        bossDefeats: this._bossDefeats,
        bossRespawnIn: this._bossRespawnAt == null ? null : Math.max(0, this._bossRespawnAt - this.timeElapsed),
        objectiveProgress: this._objectiveProgress() };
    }

    _sanitizeInput(input) {
      const finite = v => Number.isFinite(v) ? v : 0;
      const move = limit(finite(input.moveX), finite(input.moveY), 1);
      return { moveX: move.x, moveY: move.y, aimX: finite(input.aimX),
        aimY: finite(input.aimY), shoot: !!input.shoot };
    }

    _random() {
      this._rngState = (this._rngState + 0x6D2B79F5) >>> 0;
      let t = this._rngState;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    _event(type, data = {}) {
      this.events.push({ seq: ++this._eventSeq, time: this.simTime,
        roundTime: this.timeElapsed, roundId: this.roundId, type, ...data });
      if (this.events.length > this.params.maxEvents) this.events.splice(0, this.events.length - this.params.maxEvents);
    }

    _updateFountains() {
      const p = this.params;
      const pattern = ['ring', 'pulse'].includes(this.stage?.fountainPattern) ? this.stage.fountainPattern : 'alternating';
      const period = pattern === 'pulse' ? 3 : p.fountainPeriod;
      this._fountainPattern = pattern; this._fountainPeriod = period;
      const cycle = Math.floor((this.timeElapsed + EPS) / period), group = cycle % 2;
      const until = period - Math.max(0, this.timeElapsed - cycle * period);
      for (const f of this.fountains) {
        const fountainGroup = pattern === 'ring' ? (f.id === 'center' ? -1 : Number(f.id.slice(5)) % 2) : f.group;
        f.active = fountainGroup === group;
        f.preview = until <= p.fountainPreview + EPS && fountainGroup === 1 - group;
        f.radius = p.refillRadius;
      }
      if (group !== this._fountainGroup) this._event('fountain-swap', { group });
      this._fountainGroup = group;
    }

    _objectiveProgress() {
      if (!this.stage) return null;
      const objective = this.stage.objective || { type: 'survive' };
      const type = objective.type || 'survive';
      const aiEliminated = this.actors.filter(a => !a.isPlayer && !a.alive).length;
      const boss = this.actors.find(a => !a.isPlayer && (objective.bossId ? a.id === objective.bossId : a.role === 'boss'));
      const count = type === 'eliminate' ? Math.max(1, Math.floor(objective.count || 1)) :
        type === 'boss' ? this._bossRounds() : this.params.roundDuration;
      const current = type === 'eliminate' ? aiEliminated : type === 'boss' ? this._bossDefeats : this.timeElapsed;
      return { type, current, count, bossId: boss?.id || objective.bossId || null,
        completed: this.stageGoalCompleted || (type === 'survive' && this.actors[0]?.alive && current + EPS >= count),
        completedAt: this.objectiveCompletedAt,
        aiEliminated, playerEliminations: this.actors[0]?.stats.eliminations || 0 };
    }

    _bossRounds() { return Math.round(numeric(this.stage?.objective?.bossRounds, 1, 1, 20)); }

    _bossActor() {
      if (this.stage?.objective?.type !== 'boss') return null;
      const id = this.stage.objective.bossId;
      return this.actors.find(a => !a.isPlayer && (id ? a.id === id : a.role === 'boss')) || null;
    }

    _respawnBoss() {
      const a = this._bossActor(), player = this.actors[0];
      if (!a || a.alive || !player.alive || this.timeLeft <= EPS || this._bossRespawnAt == null ||
        this.timeElapsed + EPS < this._bossRespawnAt) return;
      this._bossRespawnAt = null;
      const radius = 2.7 + this._random() * .6;
      const angle = len(player.x, player.y) > .1 ? Math.atan2(-player.y, -player.x) : player.angle + Math.PI;
      let position = null, bestClearance = -Infinity;
      for (const offset of [0, Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3]) {
        const candidate = { x: Math.cos(angle + offset) * radius, y: Math.sin(angle + offset) * radius };
        const clearance = Math.min(...this.actors.filter(other => other !== a && other.alive).map(other =>
          len(candidate.x - other.x, candidate.y - other.y) - a.actorRadius - other.actorRadius));
        if (clearance > bestClearance) { position = candidate; bestClearance = clearance; }
        if (clearance >= .2) break;
      }
      Object.assign(a, { x: position.x, y: position.y, alive: true, water: a.weapon.waterCapacity,
        kx: 0, ky: 0, vx: 0, vy: 0, mx: 0, my: 0, shooting: false,
        hit: 0, refilling: false, regenerating: false, refillSource: null,
        rank: null, outsideTime: 0, eliminatedAt: null, aiState: 'engaging', targetId: null,
        lastHitBy: null, lastHitAt: -1e9, _reaction: 0, _targetTimer: 0, _targetHold: 0,
        _refillIntent: false, _stuckTime: 0, _lastDecisionX: position.x, _lastDecisionY: position.y,
        _hitEventAt: -10, _dry: false, _restTime: 0 });
      a.angle = Math.atan2(player.y - a.y, player.x - a.x);
      a._command = { moveX: 0, moveY: 0, aimX: player.x - a.x, aimY: player.y - a.y, shoot: false };
      a.spawnVersion++;
      const round = this._bossDefeats + 1, total = this._bossRounds();
      this._event('respawn', { actorId: a.id, x: a.x, y: a.y, round, total, spawnVersion: a.spawnVersion });
      this._event('boss-round', { actorId: a.id, round, total, phase: 'start' });
    }

    _fixedStep(dt, playerInput) {
      const p = this.params;
      this.simTime += dt;
      if (this.phase === 'countdown') {
        const before = Math.ceil(this.countdown - EPS);
        this.countdown = Math.max(0, this.countdown - dt);
        const after = Math.ceil(this.countdown - EPS);
        if (after > 0 && before !== after) this._event('countdown', { value: after });
        if (this.countdown <= EPS) {
          this.countdown = 0;
          this.phase = 'playing';
          this._event('play');
        }
        return;
      }

      const commands = new Map();
      for (const a of this.actors) {
        if (!a.alive) continue;
        a.hit = Math.max(0, a.hit - dt);
        commands.set(a.id, a.isPlayer ? playerInput : this._aiCommand(a, dt));
      }
      const shots = [];
      for (const a of this.actors) {
        if (!a.alive) continue;
        const c = commands.get(a.id);
        if (len(c.aimX, c.aimY) > EPS) {
          const desired = Math.atan2(c.aimY, c.aimX);
          a.angle += clamp(angleDelta(a.angle, desired), -p.turnSpeed * dt, p.turnSpeed * dt);
        }
        const wasShooting = a.shooting;
        const weapon = a.weapon;
        // Holding an empty trigger never starts automatic water recovery.
        a._restTime = c.shoot ? 0 : a._restTime + dt;
        const activeTime = c.shoot && a.water > EPS ? Math.min(dt, a.water / weapon.waterUse) : 0;
        a.shooting = activeTime > EPS;
        a.water = clamp(a.water - activeTime * weapon.waterUse, 0, weapon.waterCapacity);
        a.stats.shootingTime += activeTime;
        if (a.shooting && !wasShooting) this._event('shot-start', { actorId: a.id });
        if (!a.shooting && wasShooting) this._event('shot-stop', { actorId: a.id });
        if (c.shoot && a.water <= EPS && !a._dry) this._event('dry', { actorId: a.id });
        a._dry = c.shoot && a.water <= EPS;
        const shootingFactor = a.isPlayer && p.playerShootingMoveFactor != null ?
          p.playerShootingMoveFactor : p.shootingMoveFactor;
        const movementFactor = 1 - (1 - shootingFactor) * activeTime / dt;
        const moveSpeed = p.moveSpeed * (a.isPlayer ? 1 : p.aiMoveFactor * a.enemyProfile.moveFactor);
        const blend = 1 - Math.exp(-dt / Math.max(EPS, p.moveResponse));
        a.mx += (c.moveX * moveSpeed * movementFactor - a.mx) * blend;
        a.my += (c.moveY * moveSpeed * movementFactor - a.my) * blend;
        if (activeTime > EPS) shots.push({ actor: a, duration: activeTime });
      }

      const forces = new Map();
      this.beams = [];
      // Resolve all rays from one positional snapshot: actor order cannot affect hits.
      for (const shot of shots) {
        const a = shot.actor;
        const hits = new Map();
        for (const [jetIndex, angle] of this._jetAngles(a, a.angle).entries()) {
          const { x, y, dx, dy, target, endDistance } = this._traceShot(a, angle, a.angle);
          const push = a.weapon.pushAcceleration * (target?.isPlayer ? p.playerPushFactor : 1) /
            (target?.enemyProfile?.pushResistance || 1);
          const beam = { actorId: a.id, targetId: target ? target.id : null, jetIndex,
            radius: a.weapon.beamRadius, force: push, applied: false,
            x1: x, y1: y, x2: x + dx * endDistance, y2: y + dy * endDistance,
            dx, dy, length: endDistance, duration: shot.duration };
          this.beams.push(beam);
          if (target) {
            const alignment = Math.abs(angleDelta(a.angle, angle)), prior = hits.get(target.id);
            if (!prior || alignment < prior.alignment) hits.set(target.id, { target, dx, dy, push, beam, alignment });
          }
        }
        if (hits.size) a.stats.hitTime += shot.duration;
        // Several jets from the same gun can hit several actors, but never triple one impulse.
        for (const { target, dx, dy, push, beam } of hits.values()) {
          if (!forces.has(target.id)) forces.set(target.id, []);
          forces.get(target.id).push({ x: dx * push,
            y: dy * push, duration: shot.duration });
          beam.applied = true;
          target.hit = p.hitFeedback;
          target.lastHitBy = a.id; target.lastHitAt = this.timeElapsed + dt;
          if (this.timeElapsed - target._hitEventAt >= 0.12) {
            this._event('hit', { actorId: target.id, sourceId: a.id, x: target.x, y: target.y });
            target._hitEventAt = this.timeElapsed;
          }
        }
      }

      for (const a of this.actors) {
        if (!a.alive) continue;
        const decay = Math.exp(-p.damping * dt);
        let kx = a.kx * decay, ky = a.ky * decay;
        for (const f of forces.get(a.id) || []) {
          // Exact integration also handles the final partial water step.
          const weight = p.damping > EPS ? (1 - Math.exp(-p.damping * f.duration)) / p.damping *
            Math.exp(-p.damping * (dt - f.duration)) : f.duration;
          kx += f.x * weight;
          ky += f.y * weight;
        }
        const kick = limit(kx, ky, a.kickCap);
        a.kx = kick.x; a.ky = kick.y;
        const velocity = limit(a.mx + a.kx, a.my + a.ky, a.maxSpeed);
        a.vx = velocity.x; a.vy = velocity.y;
        a.x += a.vx * dt; a.y += a.vy * dt;
      }
      this._separateActors();

      const eliminated = [];
      for (const a of this.actors) {
        if (!a.alive) continue;
        a.outsideTime = len(a.x, a.y) > p.arenaRadius ? a.outsideTime + dt : 0;
        if (a.outsideTime + EPS >= p.outsideGrace) eliminated.push(a);
      }
      const survivors = this.actors.filter(a => a.alive).length - eliminated.length;
      for (const a of eliminated) {
        a.alive = false; a.rank = survivors + 1; a.eliminatedAt = this.timeElapsed + dt;
        a.shooting = false; a.refilling = false; a.regenerating = false;
        a.refillSource = null; a.vx = 0; a.vy = 0;
        a.aiState = a.isPlayer ? null : 'Out'; a.targetId = null;
        const credited = a.lastHitBy && a.eliminatedAt - a.lastHitAt <= 3 + EPS ?
          this.actors.find(source => source.id === a.lastHitBy && source !== a) : null;
        if (credited) credited.stats.eliminations++;
        this._event('elimination', { actorId: a.id, rank: a.rank, x: a.x, y: a.y,
          sourceId: credited?.id || null });
        if (a === this._bossActor()) {
          this._bossDefeats++;
          const total = this._bossRounds();
          this._bossRespawnAt = this._bossDefeats < total ? a.eliminatedAt + 1.3 : null;
          this._event('boss-round', { actorId: a.id, round: this._bossDefeats, total, phase: 'defeated' });
        }
      }
      this.beams = this.beams.filter(b => this.actors.find(a => a.id === b.actorId).alive);
      this.timeElapsed = Math.min(p.roundDuration, this.timeElapsed + dt);
      this.timeLeft = Math.max(0, p.roundDuration - this.timeElapsed);
      if (this.stage) {
        // Process the whole elimination batch before recording a goal: falling in
        // the first completion step loses, but an already earned clear stays earned.
        if (!this.actors[0].alive) { this._finish('player-out', this.stageGoalCompleted); return; }
        this._respawnBoss();
        const progress = this._objectiveProgress();
        if (progress.type !== 'survive' && !this.stageGoalCompleted && progress.current + EPS >= progress.count) {
          this.stageGoalCompleted = true;
          this.objectiveCompletedAt = this.timeElapsed;
          this._event('objective-complete', { completedAt: this.objectiveCompletedAt,
            objectiveProgress: this._objectiveProgress() });
        }
        // No opponent remains to play against. Bank a real campaign clear
        // immediately, while keeping the workshop's level-0 trial unrestricted.
        // A defeated Boss with another wave due is still an active opponent.
        if (Number(this.stage.levelId) > 0 && this._bossRespawnAt == null &&
          this.actors.slice(1).every(a => !a.alive) &&
          (this.stageGoalCompleted || progress.type === 'survive')) {
          this._finish('all-opponents-out', true); return;
        }
        if (this.timeLeft <= EPS) {
          this.timeLeft = 0; this._finish('timeout', this.stageGoalCompleted || progress.completed); return;
        }
      } else {
        if (survivors <= 1) {
          this._finish(survivors ? 'last-standing' : 'all-out');
          return;
        }
        if (this.timeLeft <= EPS) {
          this.timeLeft = 0;
          this._finish('timeout');
          return;
        }
      }

      for (const a of this.actors) {
        if (!a.alive) continue;
        const wasRefilling = a.refilling;
        const c = commands.get(a.id) || a._command;
        const weapon = a.weapon;
        a.refilling = !c.shoot && a.water < weapon.waterCapacity - EPS && this.fountains.some(f =>
          f.active && len(a.x - f.x, a.y - f.y) <= p.refillRadius);
        const wasRegenerating = a.regenerating;
        const recoveryTime = clamp(a._restTime - p.passiveWaterDelay, 0, dt);
        a.regenerating = !c.shoot && !a.refilling && weapon.passiveWaterRate > 0 &&
          recoveryTime > EPS && a.water < weapon.waterCapacity - EPS;
        a.refillSource = a.refilling ? 'fountain' : a.regenerating ? 'rest' : null;
        if (a.refilling) {
          a.water = Math.min(weapon.waterCapacity, a.water + weapon.refillRate * dt);
          a.stats.refillTime += dt;
        }
        if (a.regenerating) {
          a.water = Math.min(weapon.waterCapacity, a.water + weapon.passiveWaterRate * recoveryTime);
          a.stats.regenTime += recoveryTime;
        }
        if (a.regenerating !== wasRegenerating) this._event(a.regenerating ? 'regen-start' : 'regen-stop', { actorId: a.id });
        if (a.refilling && !wasRefilling) {
          a.stats.refillVisits++;
          this._event('refill-start', { actorId: a.id });
        }
        if (!a.refilling && wasRefilling) this._event('refill-stop', { actorId: a.id });
        // A depleted partial step contributes force above but shows no continuing stream.
        if (a.water <= EPS && a.shooting) {
          a.shooting = false;
          this._event('shot-stop', { actorId: a.id });
        }
      }
      this.beams = this.beams.filter(b => this.actors.find(a => a.id === b.actorId).shooting);
      // Integrate the interval with its starting group; show the new group at 4, 8, ... .
      this._updateFountains();
    }

    _jetAngles(a, angle) {
      const count = a.weapon.jetCount;
      return Array.from({ length: count }, (_, index) => angle +
        (count === 1 ? 0 : (index * 2 / (count - 1) - 1) * a.weapon.spreadAngle));
    }

    _traceShot(a, angle, muzzleAngle = angle) {
      const p = this.params, dx = Math.cos(angle), dy = Math.sin(angle);
      const x = a.x + Math.cos(muzzleAngle) * p.muzzleOffset, y = a.y + Math.sin(muzzleAngle) * p.muzzleOffset;
      let target = null, endDistance = a.weapon.range;
      for (const b of this.actors) {
        if (b === a || !b.alive) continue;
        const rx = b.x - x, ry = b.y - y, projected = rx * dx + ry * dy;
        const perpendicular2 = Math.max(0, rx * rx + ry * ry - projected * projected);
        const combined = b.actorRadius + a.weapon.beamRadius;
        if (perpendicular2 > combined * combined) continue;
        const half = Math.sqrt(Math.max(0, combined * combined - perpendicular2));
        if (projected + half < 0) continue;
        const entry = Math.max(0, projected - half);
        if (entry <= a.weapon.range && (entry < endDistance - EPS || (!target && entry <= endDistance + EPS))) {
          target = b; endDistance = entry;
        }
      }
      return { x, y, dx, dy, target, endDistance };
    }

    _separateActors() {
      const alive = this.actors.filter(a => a.alive);
      const offsets = new Map(alive.map(a => [a.id, { x: 0, y: 0 }]));
      for (let i = 0; i < alive.length; i++) for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i], b = alive[j];
        const radius = a.actorRadius + b.actorRadius;
        const dx = b.x - a.x, dy = b.y - a.y, d = len(dx, dy);
        if (d >= radius) continue;
        const dir = d > EPS ? { x: dx / d, y: dy / d } :
          { x: Math.cos((a.index + b.index) * 2.4), y: Math.sin((a.index + b.index) * 2.4) };
        const push = (radius - d) / 2;
        offsets.get(a.id).x -= dir.x * push; offsets.get(a.id).y -= dir.y * push;
        offsets.get(b.id).x += dir.x * push; offsets.get(b.id).y += dir.y * push;
      }
      for (const a of alive) { a.x += offsets.get(a.id).x; a.y += offsets.get(a.id).y; }
    }

    _finish(reason, cleared) {
      if (this.result) return;
      this._bossRespawnAt = null;
      if (this.stage && cleared && !this.stageGoalCompleted) {
        // Survival can also complete early when the arena has been cleared.
        this.stageGoalCompleted = true;
        this.objectiveCompletedAt = this.timeElapsed;
      }
      const alive = this.actors.filter(a => a.alive);
      for (const a of alive) a.rank = 1;
      const objectiveProgress = this._objectiveProgress();
      const winners = this.stage ? (cleared ? ['p1'] : []) : alive.map(a => a.id);
      this.result = { type: this.stage ? (cleared ? 'win' : 'loss') :
        winners.length === 0 ? 'draw' : winners.length === 1 ? 'win' : 'shared',
        reason, winners, playerWon: winners.includes('p1'),
        playerRank: this.actors[0].rank, duration: this.timeElapsed,
        cleared: this.stage ? !!cleared : winners.includes('p1'), objectiveProgress,
        stageGoalCompleted: this.stageGoalCompleted, objectiveCompletedAt: this.objectiveCompletedAt,
        completedAt: this.objectiveCompletedAt,
        playerEliminations: this.actors[0].stats.eliminations,
        aiEliminated: this.actors.filter(a => !a.isPlayer && !a.alive).length,
        ranks: this.actors.map(a => ({ actorId: a.id, rank: a.rank, alive: a.alive })) };
      this.phase = 'result';
      this._resumePhase = null;
      this._accumulator = 0;
      this.beams = [];
      for (const a of this.actors) {
        a.shooting = false; a.refilling = false; a.regenerating = false;
        a.refillSource = null; a.vx = 0; a.vy = 0;
        a.mx = 0; a.my = 0; a.kx = 0; a.ky = 0;
      }
      this._event('result', { result: this.result });
    }

    _aiCommand(a, dt) {
      const p = this.params, profile = a.enemyProfile;
      a._reaction -= dt; a._targetTimer -= dt; a._targetHold = Math.max(0, a._targetHold - dt);
      const eligible = b => b !== a && b.alive && (!b.isPlayer ||
        (this.timeElapsed + EPS >= p.aiOpeningGrace &&
          (!p.aiPlayerTargetLimit || this.actors.filter(other => !other.isPlayer && other !== a &&
            other.alive && other.targetId === b.id).length < p.aiPlayerTargetLimit)));
      const oldTarget = this.actors.find(b => b.id === a.targetId && eligible(b));
      if (!oldTarget) a._reaction = 0;
      if (a._reaction > EPS) return this._gateAICommand(a, a._command, dt);
      a._reaction = profile.reaction;
      const moved = len(a.x - a._lastDecisionX, a.y - a._lastDecisionY);
      a._stuckTime = moved < 0.06 && len(a._command.moveX, a._command.moveY) > 0.3 ?
        a._stuckTime + profile.reaction : 0;
      a._lastDecisionX = a.x; a._lastDecisionY = a.y;

      if (!oldTarget || (a._targetTimer <= EPS && a._targetHold <= EPS)) {
        a._targetTimer = p.aiTargetPeriod;
        let best = null, score = -Infinity;
        for (const b of this.actors) {
          if (!eligible(b)) continue;
          const distance = len(b.x - a.x, b.y - a.y);
          const value = 3.5 - distance * 0.55 + len(b.x, b.y) * 0.25 + this._random() * 0.8 -
            (b.isPlayer ? p.aiPlayerTargetPenalty : 0);
          if (value > score) { score = value; best = b; }
        }
        if (best && best.id !== a.targetId) { a.targetId = best.id; a._targetHold = p.aiTargetHold; }
        if (!best) a.targetId = null;
      }
      const target = this.actors.find(b => b.id === a.targetId && b.alive);
      const toward = target ? normalize(target.x - a.x, target.y - a.y) : normalize(-a.x, -a.y);
      const tactics = profile.tacticalLevel;
      // Aiming uses only the velocity visible at this reaction tick, with a
      // short capped lead. The AI never reads the player's next input.
      const aimDirection = target && tactics > 0 ? normalize(target.x - a.x + target.vx * profile.aimLead,
        target.y - a.y + target.vy * profile.aimLead) : toward;
      const noise = (this._random() * 2 - 1) * profile.aimError;
      const aimAngle = Math.atan2(aimDirection.y, aimDirection.x) + noise;
      const command = { moveX: 0, moveY: 0, aimX: Math.cos(aimAngle), aimY: Math.sin(aimAngle),
        shoot: !!target && a.water > EPS && len(target.x - a.x, target.y - a.y) <= a.weapon.range + p.muzzleOffset &&
          Math.abs(angleDelta(a.angle, aimAngle)) < 0.28 };
      const radial = len(a.x, a.y);
      const predicted = len(a.x + a.vx * (tactics ? profile.prediction : p.aiPrediction),
        a.y + a.vy * (tactics ? profile.prediction : p.aiPrediction));
      const inward = normalize(-a.x, -a.y);
      if (a.water < p.aiLowWater / p.waterCapacity * a.weapon.waterCapacity) a._refillIntent = true;
      if (a.water >= p.aiFullWater / p.waterCapacity * a.weapon.waterCapacity) a._refillIntent = false;

      // AI reads visible streams from the previous physical step, never future player input.
      let threat = null;
      for (const b of this.beams) {
        if (b.actorId === a.id) continue;
        const rx = a.x - b.x1, ry = a.y - b.y1;
        const along = rx * b.dx + ry * b.dy;
        const across = Math.abs(rx * b.dy - ry * b.dx);
        const warningWidth = tactics ? a.actorRadius + b.radius + .12 + tactics * .22 : .8;
        if (along >= -0.3 && along <= b.length + a.actorRadius + (tactics ? .4 : .8) && across < warningWidth) {
          threat = b; break;
        }
      }
      let movement;
      if (radial > p.arenaRadius - (tactics ? profile.edgeMargin : p.aiEdgeMargin) || predicted > p.arenaRadius - 0.25) {
        a.aiState = 'edge-recovery';
        movement = inward;
        if (tactics) {
          // Release the trigger to recover full running speed; add a sideways
          // step out of the visible stream rather than pulling against it.
          if (tactics >= .5 || predicted > p.arenaRadius - .25) command.shoot = false;
          if (threat) {
            const sidestep = this._safeSidestep(a, threat.dx, threat.dy, profile.prediction);
            movement = normalize(inward.x + sidestep.x * tactics * 1.15,
              inward.y + sidestep.y * tactics * 1.15);
          }
        }
      } else if (threat || a.hit > 0) {
        a.aiState = 'dodging';
        const incoming = !threat && tactics && len(a.kx, a.ky) > EPS ? normalize(a.kx, a.ky) : toward;
        const dx = threat ? threat.dx : incoming.x, dy = threat ? threat.dy : incoming.y;
        if (tactics) {
          const tangent = this._safeSidestep(a, dx, dy, profile.prediction);
          movement = normalize(tangent.x + inward.x * (.3 + tactics * .25),
            tangent.y + inward.y * (.3 + tactics * .25));
          // A short evasive reaction costs attack time, not extra water or an
          // invisible shield. Once the stream misses, normal attacks resume.
          if (tactics >= .65) command.shoot = false;
        } else {
          let tangent = { x: -dy, y: dx };
          if (tangent.x * inward.x + tangent.y * inward.y < 0) tangent = { x: -tangent.x, y: -tangent.y };
          movement = normalize(tangent.x + inward.x * 0.4, tangent.y + inward.y * 0.4);
        }
      } else if (a._refillIntent) {
        a.aiState = 'refilling'; command.shoot = false;
        const active = this.fountains.filter(f => f.active).sort((f, g) =>
          this._refillCost(a, f, tactics) - this._refillCost(a, g, tactics));
        const f = active[0];
        movement = f && len(f.x - a.x, f.y - a.y) > p.refillRadius * 0.65 ?
          normalize(f.x - a.x, f.y - a.y) : { x: 0, y: 0 };
      } else {
        a.aiState = 'engaging';
        const sign = a.index % 2 ? 1 : -1;
        const tangent = { x: -toward.y * sign, y: toward.x * sign };
        // Acquire the target's inner side so the stream pushes toward the edge.
        // This is a positional preference; all actor attributes remain identical.
        const outward = target && len(target.x, target.y) > 0.5 ?
          normalize(target.x, target.y) : toward;
        const attackRange = tactics ? Math.min(profile.preferredRange, a.weapon.range * .7) : 2.2;
        const stationX = target ? target.x - outward.x * attackRange : 0;
        const stationY = target ? target.y - outward.y * attackRange : 0;
        const stationDistance = len(stationX - a.x, stationY - a.y);
        const station = stationDistance > 0.35 ? normalize(stationX - a.x, stationY - a.y) : { x: 0, y: 0 };
        const strafe = .15 + tactics * (stationDistance < 1.5 ? .3 : .12);
        movement = limit(station.x + tangent.x * strafe, station.y + tangent.y * strafe, 1);
        if (tactics && stationDistance < 1.5) a.aiState = 'flanking';
        if (tactics && command.shoot) {
          const nextAngle = a.angle + clamp(angleDelta(a.angle, aimAngle), -p.turnSpeed * dt, p.turnSpeed * dt);
          // Don't drain the tank into an intervening actor or empty space. This
          // is the same finite ray geometry used by player and AI weapons.
          command.shoot = this._jetAngles(a, nextAngle).some(angle =>
            this._traceShot(a, angle, nextAngle).target?.id === target.id);
        }
      }
      // Gentle local avoidance; body collisions themselves have no attacking velocity.
      for (const b of this.actors) {
        if (b === a || !b.alive) continue;
        const dx = a.x - b.x, dy = a.y - b.y, distance = len(dx, dy);
        const avoidRadius = a.actorRadius + b.actorRadius + .4;
        if (distance > EPS && distance < avoidRadius) {
          movement.x += dx / distance * (avoidRadius - distance) * 0.7;
          movement.y += dy / distance * (avoidRadius - distance) * 0.7;
        }
      }
      if (a._stuckTime >= 1) {
        movement = normalize(inward.x + (this._random() - 0.5), inward.y + (this._random() - 0.5));
        a._stuckTime = 0;
      }
      movement = limit(movement.x, movement.y, 1);
      command.moveX = movement.x; command.moveY = movement.y;
      a._command = command;
      return this._gateAICommand(a, command, dt);
    }

    _safeSidestep(a, dx, dy, prediction) {
      const choices = [{ x: -dy, y: dx }, { x: dy, y: -dx }];
      const horizon = Math.max(.15, prediction), speed = this.params.moveSpeed * this.params.aiMoveFactor * a.enemyProfile.moveFactor;
      const score = dir => {
        const x = a.x + (a.vx + dir.x * speed) * horizon;
        const y = a.y + (a.vy + dir.y * speed) * horizon;
        let cost = len(x, y);
        for (const other of this.actors) {
          if (other === a || !other.alive) continue;
          const clearance = len(x - other.x, y - other.y) - a.actorRadius - other.actorRadius;
          cost += Math.max(0, .5 - clearance) * 2;
        }
        return cost;
      };
      return score(choices[0]) <= score(choices[1]) ? choices[0] : choices[1];
    }

    _refillCost(a, fountain, tactics) {
      const distance = len(fountain.x - a.x, fountain.y - a.y);
      if (!tactics) return distance;
      let danger = 0;
      for (const beam of this.beams) {
        if (beam.actorId === a.id) continue;
        const rx = fountain.x - beam.x1, ry = fountain.y - beam.y1;
        const along = rx * beam.dx + ry * beam.dy;
        const across = Math.abs(rx * beam.dy - ry * beam.dx);
        if (along >= 0 && along <= beam.length + this.params.refillRadius && across < this.params.refillRadius + beam.radius) danger += 5;
      }
      for (const other of this.actors) {
        if (other === a || !other.alive) continue;
        if (len(fountain.x - other.x, fountain.y - other.y) < this.params.refillRadius + other.actorRadius) danger += 1.3;
      }
      return distance + danger * tactics;
    }

    _gateAICommand(a, command, dt) {
      if (!command.shoot) return command;
      const p = this.params, profile = a.enemyProfile, cycle = profile.burstDuration + profile.burstRest;
      if (profile.burstDuration > 0 && cycle > 0 &&
        (this.timeElapsed + a._burstPhase) % cycle >= profile.burstDuration) return { ...command, shoot: false };
      if (this.timeElapsed + EPS < p.aiOpeningGrace) {
        // The same public ray geometry guards against accidental opening crossfire.
        const desired = Math.atan2(command.aimY, command.aimX);
        const nextAngle = a.angle + clamp(angleDelta(a.angle, desired), -p.turnSpeed * dt, p.turnSpeed * dt);
        if (this._jetAngles(a, nextAngle).some(angle => this._traceShot(a, angle, nextAngle).target?.isPlayer)) {
          return { ...command, shoot: false };
        }
      }
      return command;
    }
  }

  WaterGameCore.DEFAULTS = DEFAULTS;
  WaterGameCore.DIFFICULTIES = DIFFICULTIES;
  WaterGameCore.getDifficultyOptions = () => Object.values(DIFFICULTIES).map(({ id, label, description, roundDuration }) =>
    ({ id, label, description, roundDuration }));
  global.WaterGameCore = WaterGameCore;
  if (typeof module !== 'undefined' && module.exports) module.exports = WaterGameCore;
})(typeof window !== 'undefined' ? window : globalThis);
