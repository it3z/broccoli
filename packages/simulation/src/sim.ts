import type {
  Balance, Building, BuildingType, Command, Dispatch, MapDef, MatchConfig, Pct, Player, SimEvent, Wave,
} from './types';
import { buildPaths, pointAt, type Path } from './paths';

const PCTS = [25, 50, 75, 100];
const TYPES: BuildingType[] = ['farm', 'tower', 'forge'];

/**
 * Pure deterministic match simulation. No rendering, no timers, no Math.random.
 * Drive it with enqueue() + step(); read state and `events` after each step.
 */
export class Match {
  readonly bal: Balance;
  readonly map: MapDef;
  readonly paths: Path[][];
  readonly seed: number;
  tick = 0;
  players: Player[] = [];
  buildings: Building[] = [];
  dispatches: Dispatch[] = [];
  waves: Wave[] = [];
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
        busyKind: null, busyStart: 0, busyEnd: 0, convertTo: null, cooldown: 0,
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
  committed(buildingId: number): number {
    let n = 0;
    for (const d of this.dispatches) if (d.from === buildingId) n += d.remaining;
    return n;
  }
  /** How many units a send order of `pct` would queue from this building right now. */
  sendCount(b: Building, pct: number): number {
    const free = Math.floor(b.garrison) - this.committed(b.id);
    if (free < 1) return 0;
    return Math.max(1, Math.floor((free * pct) / 100));
  }
  totalUnits(player: number): number {
    let n = 0;
    for (const b of this.buildings) if (b.owner === player) n += Math.floor(b.garrison);
    for (const w of this.waves) if (w.owner === player) n += w.units;
    return n;
  }
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
        if (!b || b.owner !== p.id || id === cmd.to || seen.has(id)) continue;
        seen.add(id);
        const count = this.sendCount(b, cmd.pct);
        if (count < 1) continue;
        const existing = this.dispatches.find(d => d.from === id && d.to === cmd.to);
        if (existing) existing.remaining += count;
        else {
          if (this.dispatches.filter(d => d.from === id).length >= this.bal.maxDispatchesPerBuilding) continue;
          this.dispatches.push({ id: this.nextId++, owner: p.id, from: id, to: cmd.to, remaining: count, nextEmit: this.tick });
        }
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
    this.events.push({ type: 'busy', building: b.id });
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
      this.dispatches = this.dispatches.filter(d => d.owner !== p.id);
      this.waves = this.waves.filter(w => w.owner !== p.id);
    }
    this.events.push({ type: 'eliminated', player: p.id });
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

    // 4. dispatches release one wave at a time
    for (const d of this.dispatches) {
      if (this.tick < d.nextEmit) continue;
      const b = this.buildings[d.from];
      const n = Math.min(bal.waveSize, d.remaining, Math.floor(b.garrison));
      if (n <= 0) { d.remaining = 0; continue; }
      b.garrison -= n; d.remaining -= n; d.nextEmit = this.tick + bal.waveIntervalTicks;
      this.waves.push({ id: this.nextId++, owner: d.owner, from: d.from, to: d.to, units: n, dist: 0, x: b.x, y: b.y, px: b.x, py: b.y });
      this.events.push({ type: 'launch', building: b.id, owner: d.owner });
    }
    this.dispatches = this.dispatches.filter(d => d.remaining > 0);

    // 5. movement
    for (const w of this.waves) {
      const path = this.paths[w.from][w.to];
      w.px = w.x; w.py = w.y;
      w.dist += bal.unitSpeed * this.speedFactor(w.owner) * dt;
      const p = pointAt(path, w.dist);
      w.x = p.x; w.y = p.y;
    }

    // 6. towers
    for (const b of this.buildings) {
      if (b.type !== 'tower' || b.owner < 0 || b.busyKind) continue;
      if (b.cooldown > 0) { b.cooldown--; continue; }
      if (Math.floor(b.garrison) < 1) continue;
      const lv = bal.tower.levels[b.level - 1], team = this.players[b.owner].team;
      let best: Wave | null = null, bd = lv.range * lv.range;
      for (const w of this.waves) {
        if (w.units <= 0 || this.players[w.owner].team === team) continue;
        const d2 = (w.x - b.x) ** 2 + (w.y - b.y) ** 2;
        if (d2 <= bd) { bd = d2; best = w; }
      }
      if (!best) continue;
      const kill = Math.min(lv.damage, best.units);
      best.units -= kill;
      this.players[best.owner].stats.lost += kill;
      this.players[b.owner].stats.killed += kill;
      if (best.units <= 0) this.addMorale(best.owner, -bal.morale.waveShotDown);
      b.cooldown = Math.round(lv.fireIntervalSec * bal.tickRate);
      this.events.push({ type: 'shot', tower: b.id, x: best.x, y: best.y, owner: b.owner });
    }

    // 7. arrivals, in wave-id order so simultaneous hits resolve one after another
    for (const w of this.waves) {
      if (w.units > 0 && w.dist >= this.paths[w.from][w.to].len) { this.arrive(w); w.units = 0; }
    }
    this.waves = this.waves.filter(w => w.units > 0);

    // 8. idle morale decay
    for (const p of this.players) {
      if (p.alive && this.tick - p.lastActionTick > bal.morale.idleAfterSec * bal.tickRate) {
        this.addMorale(p.id, -bal.morale.idleDecayPerSec * dt);
      }
    }

    // 9. elimination and victory
    for (const p of this.players) {
      if (p.alive && this.buildingCount(p.id) === 0 && !this.waves.some(w => w.owner === p.id)) this.eliminate(p, false);
    }
    const teams = new Set(this.players.filter(p => p.alive).map(p => p.team));
    if (teams.size <= 1) this.finish(teams.size === 1 ? [...teams][0] : null);
    else if (this.tick >= bal.matchTimeLimitSec * bal.tickRate) this.finish(this.leaderOnTime());
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
    this.events.push({ type: 'end', winnerTeam: team });
  }

  private arrive(w: Wave): void {
    const b = this.buildings[w.to], m = this.bal.morale;
    const attacker = this.players[w.owner];
    if (b.owner >= 0 && this.players[b.owner].team === attacker.team) {
      b.garrison += w.units;
      this.events.push({ type: 'reinforce', building: b.id });
      return;
    }
    const A = this.attackFactor(w.owner), D = this.defenseFactor(b);
    const damage = (w.units * A) / D;
    const prev = b.owner;
    if (damage <= b.garrison) {
      b.garrison -= damage;
      attacker.stats.lost += w.units;
      if (prev >= 0) { this.players[prev].stats.lost += damage; this.players[prev].stats.killed += w.units; this.addMorale(prev, m.defendWave); }
      this.addMorale(w.owner, -m.failedWave);
      this.events.push({ type: 'hit', building: b.id, by: w.owner, held: true });
      return;
    }
    // captured: the surplus attackers become the new garrison
    const survivors = Math.min(w.units, ((damage - b.garrison) * D) / A);
    attacker.stats.lost += w.units - survivors;
    attacker.stats.captures++;
    if (prev >= 0) {
      this.players[prev].stats.lost += b.garrison;
      this.players[prev].stats.killed += w.units - survivors;
      this.addMorale(prev, -m.loseBuilding);
    }
    this.addMorale(w.owner, prev >= 0 ? m.captureEnemy : m.captureNeutral);
    this.dispatches = this.dispatches.filter(d => d.from !== b.id);   // previous owner's orders are void
    b.busyKind = null; b.convertTo = null; b.cooldown = 0;
    if (b.type !== 'forge') b.level = Math.max(1, b.level - 1);
    b.owner = w.owner; b.garrison = survivors;
    attacker.lastActionTick = this.tick;
    this.events.push({ type: 'capture', building: b.id, by: w.owner, from: prev });
  }

  /** Stable digest of the full state; equal digests mean identical matches. */
  hash(): string {
    const r = (n: number) => Math.round(n * 1000);
    return JSON.stringify([
      this.tick, this.phase, this.winnerTeam,
      this.players.map(p => [p.alive, r(p.morale)]),
      this.buildings.map(b => [b.type, b.owner, b.level, r(b.garrison), b.busyKind, b.busyEnd]),
      this.dispatches.map(d => [d.from, d.to, d.remaining]),
      this.waves.map(w => [w.owner, w.from, w.to, w.units, r(w.dist)]),
    ]);
  }
}

export type { Pct };
