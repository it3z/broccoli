import type {
  Army, Balance, Building, BuildingType, Command, MapDef, MatchConfig, Pct, Player, Projectile, SimEvent,
} from './types';
import { buildPaths, pointAt, type Path } from './paths';

const PCTS = [25, 50, 75, 100];
const TYPES: BuildingType[] = ['farm', 'tower', 'forge'];

/**
 * Pure deterministic match simulation. No rendering, no timers, no Math.random.
 * Drive it with enqueue() + step(); read state and `events` after each step.
 *
 * Battle rules in one place:
 *  - A send order removes floor(garrison * pct) units (at least 1) from the source ONCE and creates one Army.
 *  - An Army marches at a constant speed fixed when it was sent. Opposing armies do not fight on the road.
 *  - Reaching a friendly building adds the units once (reinforcements may exceed capacity; production stops above it).
 *  - Reaching any other building starts a battle: the army commits `battleRate` units per second; each unit removes
 *    A/D from the garrison. When a unit's damage exceeds what is left, the building changes owner once and the
 *    surplus plus every unit still waiting becomes the new garrison.
 *  - Tower shots are simulated projectiles: damage lands exactly once on impact, and never from a tower that changed owner.
 */
export class Match {
  readonly bal: Balance;
  readonly map: MapDef;
  readonly paths: Path[][];
  readonly seed: number;
  tick = 0;
  players: Player[] = [];
  buildings: Building[] = [];
  armies: Army[] = [];
  projectiles: Projectile[] = [];
  events: SimEvent[] = [];
  phase: 'playing' | 'ended' = 'playing';
  winnerTeam: number | null = null;
  private nextId = 1;
  private queue: { seq: number; cmd: Command }[] = [];
  private seq = 0;

  constructor(cfg: MatchConfig) {
    this.bal = cfg.balance;
    this.map = cfg.map;
    this.seed = cfg.seed;
    this.paths = buildPaths(cfg.map);
    const slotToPlayer = new Map<number, number>();
    cfg.players.forEach((p, i) => {
      slotToPlayer.set(p.slot, i);
      this.players.push({
        id: i, team: p.team, isAI: p.isAI, alive: true, morale: this.bal.morale.start, lastActionTick: 0,
        stats: { produced: 0, lost: 0, killed: 0, captures: 0 },
      });
    });
    cfg.map.buildings.forEach((b, i) => {
      this.buildings.push({
        id: i, type: b.type as BuildingType, owner: slotToPlayer.has(b.slot) ? slotToPlayer.get(b.slot)! : -1,
        level: b.level, x: b.x, y: b.y, garrison: b.garrison,
        busyKind: null, busyStart: 0, busyEnd: 0, convertTo: null, cooldown: 0, sendReadyTick: 0,
      });
    });
  }

  // ---------- queries (safe for UI and AI) ----------
  maxLevel(b: Building): number {
    return b.type === 'farm' ? this.bal.farm.levels.length : b.type === 'tower' ? this.bal.tower.levels.length : 1;
  }
  capacity(b: Building): number { return b.type === 'farm' ? this.bal.farm.levels[b.level - 1].cap : 0; }
  prodRate(b: Building): number {
    return b.type === 'farm' && b.owner >= 0 && !b.busyKind ? this.bal.farm.levels[b.level - 1].prod : 0;
  }
  towerRange(b: Building): number { return b.type === 'tower' ? this.bal.tower.levels[b.level - 1].range : 0; }
  upgradeCost(b: Building): number | null {
    if (b.type === 'forge' || b.level >= this.maxLevel(b)) return null;
    return (b.type === 'farm' ? this.bal.farm : this.bal.tower).upgradeCost[b.level - 1];
  }
  canUpgrade(b: Building): boolean {
    const c = this.upgradeCost(b);
    return c !== null && !b.busyKind && Math.floor(b.garrison) >= c;
  }
  canConvert(b: Building, to: BuildingType): boolean {
    return TYPES.includes(to) && b.type !== to && !b.busyKind && Math.floor(b.garrison) >= this.bal.convert.cost;
  }
  forgeCount(player: number): number {
    let n = 0;
    for (const b of this.buildings) if (b.owner === player && b.type === 'forge' && !b.busyKind) n++;
    return Math.min(n, this.bal.forge.maxStack);
  }
  attackFactor(player: number): number {
    const p = this.players[player];
    return (1 + this.bal.morale.attackPerPoint * p.morale) * (1 + this.bal.forge.attackBonus * this.forgeCount(player));
  }
  defenseFactor(b: Building): number {
    const base = b.type === 'farm' ? this.bal.farm.levels[b.level - 1].def
      : b.type === 'tower' ? this.bal.tower.levels[b.level - 1].def : this.bal.forge.def;
    if (b.owner < 0) return base;
    const p = this.players[b.owner];
    return base * (1 + this.bal.morale.defensePerPoint * p.morale) * (1 + this.bal.forge.defenseBonus * this.forgeCount(b.owner));
  }
  speedFactor(player: number): number { return 1 + this.bal.morale.speedPerPoint * this.players[player].morale; }
  /** Units a send order of `pct` takes from this building right now: floor, but never less than 1 if any unit is home. */
  sendCount(b: Building, pct: number): number {
    const have = Math.floor(b.garrison);
    return have < 1 ? 0 : Math.max(1, Math.floor((have * pct) / 100));
  }
  /** What a `units`-strong attack by `player` would leave: >0 = survivors after capture, <=0 = garrison left (negated). */
  predict(player: number, target: Building, units: number): number {
    const A = this.attackFactor(player), D = this.defenseFactor(target);
    const dmg = (units * A) / D;
    return dmg > target.garrison ? ((dmg - target.garrison) * D) / A : -(target.garrison - dmg);
  }
  sameTeam(a: number, b: number): boolean { return a >= 0 && b >= 0 && this.players[a].team === this.players[b].team; }
  totalUnits(player: number): number {
    let n = 0;
    for (const b of this.buildings) if (b.owner === player) n += Math.floor(b.garrison);
    for (const a of this.armies) if (a.owner === player) n += a.units;
    return n;
  }
  /** Units per second this player is really gaining right now (capped or busy farms add nothing). */
  income(player: number): number {
    let n = 0;
    for (const b of this.buildings) if (b.owner === player && b.garrison < this.capacity(b)) n += this.prodRate(b);
    return n;
  }
  buildingCount(player: number): number {
    let n = 0;
    for (const b of this.buildings) if (b.owner === player) n++;
    return n;
  }
  /** Hostile units marching on or fighting at a building. */
  threatTo(b: Building): number {
    let n = 0;
    for (const a of this.armies) if (a.to === b.id && !this.sameTeam(a.owner, b.owner)) n += a.units;
    return n;
  }

  // ---------- commands ----------
  enqueue(cmd: Command): void { this.queue.push({ seq: this.seq++, cmd }); }

  private apply(cmd: Command): void {
    const p = this.players[cmd.player];
    if (!p || !p.alive) return;
    if (cmd.type === 'surrender') { this.eliminate(p, true); return; }
    if (cmd.type === 'send') {
      const target = this.buildings[cmd.to];
      if (!target || !PCTS.includes(cmd.pct) || !Array.isArray(cmd.from)) return;
      const seen = new Set<number>();
      for (const id of cmd.from) {
        const b = this.buildings[id];
        if (!b || id === cmd.to || seen.has(id)) continue;
        seen.add(id);
        const reject = (reason: 'empty' | 'not_owner' | 'cooldown') => this.events.push({ type: 'order_rejected', player: p.id, building: id, reason });
        if (b.owner !== p.id) { reject('not_owner'); continue; }
        if (this.tick < b.sendReadyTick) { reject('cooldown'); continue; }
        const count = this.sendCount(b, cmd.pct);
        if (count < 1) { reject('empty'); continue; }
        b.garrison -= count;                                   // the one and only deduction
        b.sendReadyTick = this.tick + Math.round(this.bal.sendCooldownSec * this.bal.tickRate);
        const army: Army = {
          id: this.nextId++, owner: p.id, from: id, to: cmd.to, units: count, startUnits: count, state: 'moving',
          dist: 0, speed: this.bal.unitSpeed * this.speedFactor(p.id), createdTick: this.tick, engage: 0,
          x: b.x, y: b.y, px: b.x, py: b.y,
        };
        this.armies.push(army);
        this.events.push({ type: 'army_sent', army: army.id, owner: p.id, from: id, to: cmd.to, units: count });
        p.lastActionTick = this.tick;
      }
      return;
    }
    const b = this.buildings[cmd.building];
    if (!b || b.owner !== p.id) return;
    if (cmd.type === 'upgrade') {
      if (!this.canUpgrade(b)) return;
      b.garrison -= this.upgradeCost(b)!;
      const t = (b.type === 'farm' ? this.bal.farm : this.bal.tower).upgradeTimeSec[b.level - 1];
      this.startBusy(b, 'upgrade', t, null);
    } else if (cmd.type === 'convert') {
      if (!this.canConvert(b, cmd.to)) return;
      b.garrison -= this.bal.convert.cost;
      this.startBusy(b, 'convert', this.bal.convert.timeSec, cmd.to);
    }
    p.lastActionTick = this.tick;
  }

  private startBusy(b: Building, kind: 'upgrade' | 'convert', sec: number, to: BuildingType | null): void {
    b.busyKind = kind; b.busyStart = this.tick; b.busyEnd = this.tick + Math.round(sec * this.bal.tickRate); b.convertTo = to;
    this.events.push({ type: 'upgrade_started', building: b.id });
  }

  private addMorale(player: number, d: number): void {
    if (player < 0) return;
    const p = this.players[player];
    p.morale = Math.max(0, Math.min(this.bal.morale.max, p.morale + d));
  }

  private eliminate(p: Player, surrender: boolean): void {
    if (!p.alive) return;
    p.alive = false;
    if (surrender) {
      for (const b of this.buildings) if (b.owner === p.id) { b.owner = -1; b.busyKind = null; b.convertTo = null; }
      for (const a of this.armies) if (a.owner === p.id) a.state = 'cancelled';
      this.armies = this.armies.filter(a => a.owner !== p.id);
      this.projectiles = this.projectiles.filter(s => s.owner !== p.id);
    }
    this.events.push({ type: 'player_eliminated', player: p.id });
  }

  // ---------- main loop ----------
  step(): void {
    this.events = [];
    if (this.phase !== 'playing') return;
    this.tick++;
    const bal = this.bal, dt = 1 / bal.tickRate;

    // 1. commands, in a fixed order: player id, then arrival order
    const q = this.queue; this.queue = [];
    q.sort((a, b) => a.cmd.player - b.cmd.player || a.seq - b.seq);
    for (const c of q) this.apply(c.cmd);

    // 2. finished upgrades / conversions
    for (const b of this.buildings) {
      if (b.busyKind && this.tick >= b.busyEnd) {
        if (b.busyKind === 'upgrade') { b.level++; this.addMorale(b.owner, bal.morale.upgrade); this.events.push({ type: 'upgraded', building: b.id }); }
        else { b.type = b.convertTo!; b.level = 1; b.cooldown = 0; this.events.push({ type: 'converted', building: b.id }); }
        b.busyKind = null; b.convertTo = null;
      }
    }

    // 3. production (fractional accumulation; the UI shows the floor)
    for (const b of this.buildings) {
      const rate = this.prodRate(b), cap = this.capacity(b);
      if (rate > 0 && b.garrison < cap) {
        const add = Math.min(rate * dt, cap - b.garrison);
        b.garrison += add;
        this.players[b.owner].stats.produced += add;
      }
    }

    // 4. marching
    for (const a of this.armies) {
      a.px = a.x; a.py = a.y;
      if (a.state !== 'moving') continue;
      const path = this.paths[a.from][a.to];
      a.dist = Math.min(path.len, a.dist + a.speed * dt);
      const p = pointAt(path, a.dist);
      a.x = p.x; a.y = p.y;
    }

    // 5. towers fire; projectiles in flight land
    this.towers();
    this.landProjectiles();

    // 6. arrivals and battles, in army-id order so simultaneous attackers resolve one after another
    for (const a of this.armies) {
      if (a.units <= 0) continue;
      if (a.state === 'moving' && a.dist >= this.paths[a.from][a.to].len) this.arrive(a);
      if (a.state === 'fighting') this.fight(a, dt);
    }
    this.armies = this.armies.filter(a => a.state === 'moving' || a.state === 'fighting');

    // 7. idle morale decay
    for (const p of this.players) {
      if (p.alive && this.tick - p.lastActionTick > bal.morale.idleAfterSec * bal.tickRate) {
        this.addMorale(p.id, -bal.morale.idleDecayPerSec * dt);
      }
    }

    // 8. elimination and victory: a player with no buildings stays in while an army is still on its way
    for (const p of this.players) {
      if (p.alive && this.buildingCount(p.id) === 0 && !this.armies.some(a => a.owner === p.id)) this.eliminate(p, false);
    }
    const teams = new Set(this.players.filter(p => p.alive).map(p => p.team));
    if (teams.size <= 1) this.finish(teams.size === 1 ? [...teams][0] : null);
    else if (this.tick >= bal.matchTimeLimitSec * bal.tickRate) this.finish(this.leaderOnTime());
  }

  private towers(): void {
    const bal = this.bal;
    let pending: Map<number, number> | null = null;
    for (const b of this.buildings) {
      if (b.type !== 'tower' || b.owner < 0 || b.busyKind) continue;
      if (b.cooldown > 0) { b.cooldown--; continue; }
      if (Math.floor(b.garrison) < 1) continue;
      if (!pending) {
        pending = new Map();
        for (const s of this.projectiles) pending.set(s.target, (pending.get(s.target) ?? 0) + s.damage);
      }
      const lv = bal.tower.levels[b.level - 1];
      let best: Army | null = null, bd = lv.range * lv.range;
      for (const a of this.armies) {
        if (a.units <= (pending.get(a.id) ?? 0) || this.sameTeam(a.owner, b.owner)) continue;
        const d2 = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
        if (d2 <= bd) { bd = d2; best = a; }
      }
      if (!best) continue;
      const ticks = Math.max(2, Math.round((Math.sqrt(bd) / bal.projectileSpeed) * bal.tickRate));
      const shot: Projectile = { id: this.nextId++, tower: b.id, owner: b.owner, target: best.id, damage: lv.damage, ticksLeft: ticks, totalTicks: ticks };
      this.projectiles.push(shot);
      pending.set(best.id, (pending.get(best.id) ?? 0) + lv.damage);
      b.cooldown = Math.round(lv.fireIntervalSec * bal.tickRate);
      this.events.push({ type: 'tower_fired', tower: b.id, projectile: shot.id, army: best.id, owner: b.owner });
    }
  }

  private landProjectiles(): void {
    for (const s of this.projectiles) {
      if (--s.ticksLeft > 0) continue;
      const a = this.armies.find(x => x.id === s.target);
      // a shot is void if its tower changed hands, or its target is gone or no longer hostile
      if (!a || a.units <= 0 || this.buildings[s.tower].owner !== s.owner || this.sameTeam(a.owner, s.owner)) continue;
      const kills = Math.min(s.damage, a.units);
      a.units -= kills;
      this.players[a.owner].stats.lost += kills;
      this.players[s.owner].stats.killed += kills;
      this.events.push({ type: 'projectile_hit', projectile: s.id, army: a.id, owner: s.owner, x: a.x, y: a.y, kills });
      if (a.units <= 0) {
        a.state = 'cancelled';
        this.addMorale(a.owner, -this.bal.morale.waveShotDown);
        this.events.push({ type: 'army_destroyed', army: a.id, owner: a.owner, x: a.x, y: a.y });
      }
    }
    this.projectiles = this.projectiles.filter(s => s.ticksLeft > 0);
  }

  private arrive(a: Army): void {
    const b = this.buildings[a.to];
    const friendly = this.sameTeam(a.owner, b.owner);
    this.events.push({ type: 'army_arrived', army: a.id, owner: a.owner, building: b.id, units: a.units, reinforce: friendly });
    if (friendly) { b.garrison += a.units; a.units = 0; a.state = 'arrived'; return; }
    a.state = 'fighting'; a.engage = 0;
    this.events.push({ type: 'battle_started', army: a.id, building: b.id, attacker: a.owner, defender: b.owner });
  }

  private fight(a: Army, dt: number): void {
    const b = this.buildings[a.to], m = this.bal.morale, attacker = this.players[a.owner];
    if (this.sameTeam(a.owner, b.owner)) {          // an ally took it first: the rest walk in as reinforcements
      b.garrison += a.units;
      this.events.push({ type: 'battle_resolved', army: a.id, building: b.id, attacker: a.owner, captured: false, survivors: a.units });
      a.units = 0; a.state = 'arrived'; return;
    }
    a.engage += this.bal.battleRate * dt;
    while (a.engage >= 1 && a.units > 0) {
      a.engage -= 1; a.units -= 1;
      const A = this.attackFactor(a.owner), D = this.defenseFactor(b), dmg = A / D, prev = b.owner;
      this.events.push({ type: 'battle_hit', army: a.id, building: b.id, attacker: a.owner });
      if (dmg <= b.garrison) {
        b.garrison -= dmg;
        attacker.stats.lost += 1;
        if (prev >= 0) { this.players[prev].stats.lost += dmg; this.players[prev].stats.killed += 1; }
        continue;
      }
      // the garrison breaks: ownership changes exactly once, survivors move in
      const part = Math.min(1, ((dmg - b.garrison) * D) / A);
      const survivors = part + a.units;
      attacker.stats.lost += 1 - part;
      attacker.stats.captures++;
      if (prev >= 0) {
        this.players[prev].stats.lost += b.garrison; this.players[prev].stats.killed += 1 - part;
        this.addMorale(prev, -m.loseBuilding);
        this.events.push({ type: 'building_lost', building: b.id, player: prev, by: a.owner });
      }
      this.addMorale(a.owner, prev >= 0 ? m.captureEnemy : m.captureNeutral);
      b.busyKind = null; b.convertTo = null; b.cooldown = 0; b.sendReadyTick = 0;
      if (b.type !== 'forge') b.level = Math.max(1, b.level - 1);
      b.owner = a.owner; b.garrison = survivors;
      this.projectiles = this.projectiles.filter(s => s.tower !== b.id);   // shots from the old owner are void
      attacker.lastActionTick = this.tick;
      this.events.push({ type: 'building_captured', building: b.id, by: a.owner, from: prev });
      this.events.push({ type: 'battle_resolved', army: a.id, building: b.id, attacker: a.owner, captured: true, survivors });
      a.units = 0; a.state = 'arrived';
      return;
    }
    if (a.units <= 0) {                             // attack spent, the defenders held
      a.state = 'arrived';
      if (b.owner >= 0) this.addMorale(b.owner, m.defendWave);
      this.addMorale(a.owner, -m.failedWave);
      this.events.push({ type: 'battle_resolved', army: a.id, building: b.id, attacker: a.owner, captured: false, survivors: 0 });
    }
  }

  private leaderOnTime(): number | null {
    const score = new Map<number, number>();
    for (const p of this.players) {
      if (!p.alive) continue;
      score.set(p.team, (score.get(p.team) ?? 0) + this.buildingCount(p.id) * 10000 + this.totalUnits(p.id));
    }
    const sorted = [...score.entries()].sort((a, b) => b[1] - a[1]);
    return sorted.length > 1 && sorted[0][1] === sorted[1][1] ? null : sorted[0][0];
  }

  private finish(team: number | null): void {
    this.phase = 'ended'; this.winnerTeam = team;
    this.events.push({ type: 'match_ended', winnerTeam: team });
  }

  /** Stable digest of the full state; equal digests mean identical matches. */
  hash(): string {
    const r = (n: number) => Math.round(n * 1000);
    return JSON.stringify([
      this.tick, this.phase, this.winnerTeam,
      this.players.map(p => [p.alive, r(p.morale)]),
      this.buildings.map(b => [b.type, b.owner, b.level, r(b.garrison), b.busyKind, b.busyEnd]),
      this.armies.map(a => [a.owner, a.from, a.to, a.units, a.state, r(a.dist)]),
      this.projectiles.map(s => [s.tower, s.target, s.ticksLeft]),
    ]);
  }
}

export type { Pct };
