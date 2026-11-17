import type {
  AbilityDef, Army, Balance, Building, BuildingType, Command, HeroId, MapDef, MatchConfig, Pct, PendingOrder, Player, Projectile, SimEvent, Zone,
} from './types';
import { buildNetwork, pointAt, type Path } from './paths';
import { Rng } from './rng';
import type { Vec } from './types';

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
 *  - A synchronized order holds nearer sources back so all groups reach the target together; units are still
 *    deducted once, at each group's own launch. Losing the building cancels its waiting order.
 *  - Optional road-clash rule (config.roadClash): hostile groups that meet on the road stop and trade losses.
 *  - Tower shots are simulated projectiles: damage lands exactly once on impact, and never from a tower that changed owner.
 */
export class Match {
  readonly bal: Balance;
  readonly map: MapDef;
  readonly paths: Path[][];
  /** The roads drawn on the map: exactly the polylines that army routes are built from. */
  readonly roads: Vec[][];
  readonly passR: number[];
  /** Drawbridge maps: routes and roads while the gate is closed, and where each open route crosses the gate. */
  readonly closedPaths: Path[][] | null = null;
  readonly gateSpan: ([number, number] | null)[][] = [];
  bridge: { open: boolean; nextTick: number; warned: boolean } | null = null;
  readonly goldenSeed: boolean;
  gseed: { site: number; phase: 'warn' | 'active'; atTick: number; holder: number; holdTicks: number } | null = null;
  nextSeedTick = 0;
  buffs: { player: number; x: number; y: number; untilTick: number }[] = [];
  readonly mode: 'conquest' | 'control';
  /** Buildings closest to the middle of the map: Golden Seed sites, and (first one) the control-mode bloom. */
  readonly sites: number[];
  control: number[] = [];   // ticks each team has held the bloom
  zones: Zone[] = [];
  bbuffs: { building: number; kind: 'bulwark' | 'volley'; untilTick: number; mult: number }[] = [];
  pbuffs: { player: number; kind: 'rush'; untilTick: number; mult: number }[] = [];
  private rng: Rng;
  readonly seed: number;
  tick = 0;
  players: Player[] = [];
  buildings: Building[] = [];
  armies: Army[] = [];
  projectiles: Projectile[] = [];
  pending: PendingOrder[] = [];
  readonly roadClash: boolean;
  /** Buildings owned by each player, sampled once per second (for the post-match summary). */
  history: number[][] = [];
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
    this.roadClash = !!cfg.roadClash;
    this.goldenSeed = !!cfg.goldenSeed;
    this.mode = cfg.mode ?? 'conquest';
    this.rng = new Rng(cfg.seed * 2654435761 + 7);
    const net = buildNetwork(cfg.map);
    this.paths = net.paths; this.roads = net.roads; this.passR = net.passR;
    const gates = cfg.map.obstacles.filter(o => o.kind === 'gate');
    if (gates.length) {
      this.closedPaths = buildNetwork(cfg.map, true).paths;
      this.bridge = { open: true, nextTick: Math.round(cfg.balance.bridge.openSec * cfg.balance.tickRate), warned: false };
      this.gateSpan = this.paths.map(row => row.map(p => {
        let dIn = -1, dOut = -1;
        for (let d = 0; d <= p.len; d += 4) {
          const q = pointAt(p, d), inside = gates.some(g => Math.hypot(q.x - g.x, q.y - g.y) < g.r + 6);
          if (inside && dIn < 0) dIn = d;
          if (inside) dOut = d;
        }
        return dIn < 0 ? null : [dIn, dOut + 4] as [number, number];
      }));
    }
    const cx = cfg.map.width / 2, cy = cfg.map.height / 2;
    this.sites = cfg.map.buildings.map((b, i) => [i, Math.hypot(b.x - cx, b.y - cy)]).sort((a, b) => a[1] - b[1]).slice(0, 4).map(v => v[0]);
    this.nextSeedTick = Math.round(cfg.balance.seed.firstAtSec * cfg.balance.tickRate);
    const slotToPlayer = new Map<number, number>();
    cfg.players.forEach((p, i) => {
      slotToPlayer.set(p.slot, i);
      this.players.push({
        id: i, team: p.team, isAI: p.isAI, alive: true, morale: this.bal.morale.start, lastActionTick: 0,
        stats: { produced: 0, lost: 0, killed: 0, captures: 0 },
        hero: cfg.heroes?.[i] ?? null, cd: [0, 0].map(() => Math.round(this.bal.heroStartCooldownSec * this.bal.tickRate)),
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
    if (b.type !== 'farm' || b.owner < 0 || b.busyKind) return 0;
    const base = this.bal.farm.levels[b.level - 1].prod;
    // Golden Seed reward: villages of the claimer near the seed grow faster for a while
    for (const f of this.buffs) if (f.player === b.owner && Math.hypot(b.x - f.x, b.y - f.y) <= this.bal.seed.radius) return base * this.bal.seed.prodMult;
    return base;
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
    const wall = this.bbuffs.find(x => x.building === b.id && x.kind === 'bulwark');
    return base * (1 + this.bal.morale.defensePerPoint * p.morale) * (1 + this.bal.forge.defenseBonus * this.forgeCount(b.owner)) * (wall ? wall.mult : 1);
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
    if (cmd.type === 'ability') { this.ability(p, cmd); return; }
    if (cmd.type === 'send') {
      const target = this.buildings[cmd.to];
      if (!target || !PCTS.includes(cmd.pct) || !Array.isArray(cmd.from)) return;
      const seen = new Set<number>(), valid: Building[] = [];
      for (const id of cmd.from) {
        const b = this.buildings[id];
        if (!b || id === cmd.to || seen.has(id)) continue;
        seen.add(id);
        if (b.owner !== p.id) { this.events.push({ type: 'order_rejected', player: p.id, building: id, reason: 'not_owner' }); continue; }
        valid.push(b);
      }
      // synchronized attack: the farthest group leaves now, nearer ones wait so that all arrive together
      const far = cmd.sync && valid.length > 1 ? Math.max(...valid.map(b => this.eta(b.id, cmd.to, p.id))) : 0;
      for (const b of valid) {
        const wait = far > 0 ? Math.round((far - this.eta(b.id, cmd.to, p.id)) * this.bal.tickRate) : 0;
        if (wait <= 0) { this.launch(p, b, cmd.to, cmd.pct); continue; }
        if (this.sendCount(b, cmd.pct) < 1) { this.events.push({ type: 'order_rejected', player: p.id, building: b.id, reason: 'empty' }); continue; }
        this.pending = this.pending.filter(o => o.from !== b.id);       // a new order replaces a waiting one
        this.pending.push({ id: this.nextId++, owner: p.id, from: b.id, to: cmd.to, pct: cmd.pct, orderTick: this.tick, launchTick: this.tick + wait });
        this.events.push({ type: 'order_queued', player: p.id, building: b.id, to: cmd.to, launchTick: this.tick + wait });
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

  /** Travel time in seconds for a group of `player` leaving now. */
  eta(from: number, to: number, player: number): number { return this.routeFor(from, to, player).eta; }

  /** The route a group leaving now would take. With the drawbridge closed it either waits at the gate or goes round. */
  routeFor(from: number, to: number, player: number): { route: 0 | 1; eta: number } {
    const v = this.bal.unitSpeed * this.speedFactor(player), open = this.paths[from][to], span = this.gateSpan[from]?.[to];
    if (!this.bridge || !span) return { route: 0, eta: open.len / v };
    if (this.bridge.open) return { route: 0, eta: open.len / v };
    const waitSec = Math.max(0, (this.bridge.nextTick - this.tick) / this.bal.tickRate);
    const viaGate = Math.max(span[0] / v, waitSec) + (open.len - span[0]) / v, round = this.closedPaths![from][to].len / v;
    return viaGate <= round ? { route: 0, eta: viaGate } : { route: 1, eta: round };
  }
  pathOf(a: Army): Path { return a.route === 1 && this.closedPaths ? this.closedPaths[a.from][a.to] : this.paths[a.from][a.to]; }

  /** The one place units leave a garrison: deduct once, create one Army. */
  private launch(p: Player, b: Building, to: number, pct: Pct): boolean {
    const reject = (reason: 'empty' | 'cooldown') => { this.events.push({ type: 'order_rejected', player: p.id, building: b.id, reason }); return false; };
    if (this.tick < b.sendReadyTick) return reject('cooldown');
    const count = this.sendCount(b, pct);
    if (count < 1) return reject('empty');
    b.garrison -= count;
    b.sendReadyTick = this.tick + Math.round(this.bal.sendCooldownSec * this.bal.tickRate);
    const army: Army = {
      id: this.nextId++, owner: p.id, from: b.id, to, units: count, startUnits: count, state: 'moving',
      dist: 0, speed: this.bal.unitSpeed * this.speedFactor(p.id), createdTick: this.tick, engage: 0, foe: 0, wound: 0, heldTicks: 0,
      route: this.routeFor(b.id, to, p.id).route,
      x: b.x, y: b.y, px: b.x, py: b.y,
    };
    this.armies.push(army);
    this.events.push({ type: 'army_sent', army: army.id, owner: p.id, from: b.id, to, units: count });
    p.lastActionTick = this.tick;
    return true;
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
      this.pending = this.pending.filter(o => o.owner !== p.id);
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

    // 1b. synchronized orders whose moment has come (void if the building changed hands meanwhile)
    if (this.pending.length) {
      for (const o of this.pending) {
        if (o.launchTick > this.tick) continue;
        const b = this.buildings[o.from];
        if (b.owner === o.owner && this.players[o.owner].alive) { b.sendReadyTick = 0; this.launch(this.players[o.owner], b, o.to, o.pct); }
      }
      this.pending = this.pending.filter(o => o.launchTick > this.tick);
    }

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
    this.features();
    for (const a of this.armies) {
      a.px = a.x; a.py = a.y;
      if (a.state !== 'moving') continue;
      const path = this.pathOf(a);
      let step = a.speed * dt * this.speedMult(a);
      // closed drawbridge: groups not yet on it stop at the gate; groups already on it finish crossing
      const span = a.route === 0 && this.bridge && !this.bridge.open ? this.gateSpan[a.from][a.to] : null;
      if (span && a.dist < span[0]) step = Math.min(step, Math.max(0, span[0] - 2 - a.dist));
      a.heldTicks += Math.max(0, 1 - step / (a.speed * dt));   // time lost to mud, snares and the gate (in ticks)
      a.dist = Math.min(path.len, a.dist + step);
      const p = pointAt(path, a.dist);
      a.x = p.x; a.y = p.y;
    }

    if (this.roadClash) this.clashes(dt);

    // 5. towers fire; projectiles in flight land
    this.towers();
    this.landProjectiles();

    // 6. arrivals and battles, in army-id order so simultaneous attackers resolve one after another
    for (const a of this.armies) {
      if (a.units <= 0) continue;
      if (a.state === 'moving' && a.dist >= this.pathOf(a).len) this.arrive(a);
      if (a.state === 'fighting') this.fight(a, dt);
    }
    this.armies = this.armies.filter(a => a.state === 'moving' || a.state === 'fighting' || a.state === 'clashing');
    if (this.tick % bal.tickRate === 0) this.history.push(this.players.map(p => this.buildingCount(p.id)));

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
    if (this.mode === 'control' && this.phase === 'playing') {
      const bloom = this.buildings[this.sites[0]];
      if (bloom.owner >= 0) {
        const tm = this.players[bloom.owner].team;
        this.control[tm] = (this.control[tm] ?? 0) + 1;
        if (this.control[tm] >= bal.control.holdSec * bal.tickRate) { this.finish(tm); return; }
      }
    }
    if (teams.size <= 1) this.finish(teams.size === 1 ? [...teams][0] : null);
    else if (this.tick >= bal.matchTimeLimitSec * bal.tickRate) this.finish(this.leaderOnTime());
  }

  /** Experimental road-clash rule: hostile groups that meet stop and wear each other down; the survivor marches on. */
  /** March speed multiplier right now: Green Rush speeds own groups up, armed mud slows hostile ones, a snare roots them. */
  private speedMult(a: Army): number {
    let k = 1;
    for (const f of this.pbuffs) if (f.player === a.owner && f.kind === 'rush') k *= f.mult;
    for (const z of this.zones) {
      if (this.tick < z.armTick || this.sameTeam(z.owner, a.owner) || (a.x - z.x) ** 2 + (a.y - z.y) ** 2 > z.r * z.r) continue;
      k *= z.kind === 'snare' ? 0 : z.mult;
    }
    return k;
  }

  /** Map events and timed effects: Golden Seed, drawbridge, hero effects expiring. */
  private features(): void {
    const bal = this.bal, rate = bal.tickRate;
    if (this.bridge && this.tick >= this.bridge.nextTick - bal.bridge.warnSec * rate && !this.bridge.warned) {
      this.bridge.warned = true;
      this.events.push({ type: 'bridge_warning', closing: this.bridge.open, atTick: this.bridge.nextTick });
    }
    if (this.bridge && this.tick >= this.bridge.nextTick) {
      this.bridge.open = !this.bridge.open; this.bridge.warned = false;
      this.bridge.nextTick = this.tick + Math.round((this.bridge.open ? bal.bridge.openSec : bal.bridge.closedSec) * rate);
      this.events.push({ type: 'bridge_changed', open: this.bridge.open });
    }
    if (this.goldenSeed) {
      if (!this.gseed && this.tick >= this.nextSeedTick - bal.seed.warnSec * rate) {
        const site = this.sites[this.rng.int(this.sites.length)];
        this.gseed = { site, phase: 'warn', atTick: this.nextSeedTick, holder: -1, holdTicks: 0 };
        this.events.push({ type: 'seed_warning', building: site, atTick: this.nextSeedTick });
      }
      const sd = this.gseed;
      if (sd && sd.phase === 'warn' && this.tick >= sd.atTick) { sd.phase = 'active'; this.events.push({ type: 'seed_spawned', building: sd.site }); }
      if (sd && sd.phase === 'active') {
        const own = this.buildings[sd.site].owner;
        if (own < 0) { sd.holder = -1; sd.holdTicks = 0; }
        else if (own === sd.holder) sd.holdTicks++;
        else { sd.holder = own; sd.holdTicks = 1; }        // a capture during the hold restarts the count for the new owner
        if (sd.holder >= 0 && sd.holdTicks >= bal.seed.holdSec * rate) {
          const b = this.buildings[sd.site], until = this.tick + Math.round(bal.seed.buffSec * rate);
          this.buffs.push({ player: sd.holder, x: b.x, y: b.y, untilTick: until });
          this.events.push({ type: 'seed_claimed', building: sd.site, player: sd.holder, untilTick: until });
          this.gseed = null; this.nextSeedTick = this.tick + Math.round(bal.seed.intervalSec * rate);
        }
      }
      this.buffs = this.buffs.filter(f => f.untilTick > this.tick);
    }
    for (const z of this.zones) if (z.armTick === this.tick) this.events.push({ type: 'zone_armed', zone: z.id, kind: z.kind });
    this.zones = this.zones.filter(z => z.endTick > this.tick);
    this.bbuffs = this.bbuffs.filter(f => f.untilTick > this.tick && this.buildings[f.building].owner >= 0);
    this.pbuffs = this.pbuffs.filter(f => f.untilTick > this.tick);
  }

  heroAbilities(player: number): AbilityDef[] { const h = this.players[player]?.hero; return h ? this.bal.heroes[h].abilities : []; }
  abilityReady(player: number, slot: number): boolean { const p = this.players[player]; return !!p?.hero && this.tick >= p.cd[slot]; }
  /** Point targets must be within reach of one of the caster's buildings. */
  inReach(player: number, x: number, y: number, range: number): boolean {
    return this.buildings.some(b => b.owner === player && Math.hypot(b.x - x, b.y - y) <= range);
  }

  private ability(p: Player, cmd: Extract<Command, { type: 'ability' }>): void {
    const def = this.heroAbilities(p.id)[cmd.slot];
    if (!def || !this.abilityReady(p.id, cmd.slot)) return;
    const rate = this.bal.tickRate, dur = Math.round((def.durationSec ?? 0) * rate);
    const b = cmd.building !== undefined ? this.buildings[cmd.building] : undefined;
    if (def.target === 'own' && (!b || b.owner !== p.id)) return;
    if (def.target === 'ownTower' && (!b || b.owner !== p.id || b.type !== 'tower')) return;
    if (def.target === 'point' && (cmd.x === undefined || cmd.y === undefined || !Number.isFinite(cmd.x) || !Number.isFinite(cmd.y) || !this.inReach(p.id, cmd.x, cmd.y, def.range ?? 500))) return;
    if (def.id === 'burst') b!.garrison += def.amount ?? 0;
    else if (def.id === 'rush') this.pbuffs.push({ player: p.id, kind: 'rush', untilTick: this.tick + dur, mult: def.mult ?? 1 });
    else if (def.id === 'bulwark' || def.id === 'volley') {
      this.bbuffs = this.bbuffs.filter(f => !(f.building === b!.id && f.kind === def.id));
      this.bbuffs.push({ building: b!.id, kind: def.id, untilTick: this.tick + dur, mult: def.mult ?? 1 });
    } else {
      const arm = this.tick + Math.max(1, Math.round((def.armSec ?? 0) * rate));
      this.zones.push({ id: this.nextId++, owner: p.id, kind: def.id as Zone['kind'], x: cmd.x!, y: cmd.y!, r: def.radius ?? 80, armTick: arm, endTick: arm + dur, mult: def.mult ?? 0 });
    }
    p.cd[cmd.slot] = this.tick + Math.round(def.cooldownSec * rate);
    p.lastActionTick = this.tick;
    this.events.push({ type: 'ability_used', player: p.id, ability: def.id, building: b?.id, x: cmd.x ?? b?.x, y: cmd.y ?? b?.y });
  }

  private clashes(dt: number): void {
    const R2 = this.bal.clash.radius ** 2, list = this.armies;
    for (let i = 0; i < list.length; i++) {
      const a = list[i]; if (a.state !== 'moving' || a.units <= 0) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.state !== 'moving' || b.units <= 0 || this.sameTeam(a.owner, b.owner)) continue;
        if ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 > R2) continue;
        a.state = b.state = 'clashing'; a.foe = b.id; b.foe = a.id; a.wound = b.wound = 0;
        this.events.push({ type: 'clash_started', a: a.id, b: b.id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        break;
      }
    }
    for (const a of list) {
      if (a.state !== 'clashing') continue;
      a.heldTicks++;
      const b = list.find(x => x.id === a.foe);
      if (!b || b.units <= 0 || b.state !== 'clashing') { a.state = 'moving'; a.foe = 0; continue; }   // opponent gone (e.g. shot down)
      if (a.id > b.id) continue;                                                                       // each pair once
      const Aa = this.attackFactor(a.owner), Ab = this.attackFactor(b.owner), rate = this.bal.clash.rate * dt;
      a.wound += rate * (Ab / Aa); b.wound += rate * (Aa / Ab);
      for (const [x, y] of [[a, b], [b, a]] as const) {
        while (x.wound >= 1 && x.units > 0) {
          x.wound -= 1; x.units -= 1;
          this.players[x.owner].stats.lost += 1; this.players[y.owner].stats.killed += 1;
          this.events.push({ type: 'clash_hit', army: x.id, owner: x.owner, x: x.x, y: x.y });
        }
      }
      for (const [x, y] of [[a, b], [b, a]] as const) {
        if (x.units > 0) continue;
        x.state = 'cancelled';
        this.addMorale(x.owner, -this.bal.morale.waveShotDown);
        this.events.push({ type: 'army_destroyed', army: x.id, owner: x.owner, x: x.x, y: x.y });
        if (y.units > 0) { y.state = 'moving'; y.foe = 0; this.events.push({ type: 'clash_resolved', winner: y.id, x: y.x, y: y.y }); }
      }
    }
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
      const vol = this.bbuffs.find(x => x.building === b.id && x.kind === 'volley');
      b.cooldown = Math.round(lv.fireIntervalSec * bal.tickRate * (vol ? vol.mult : 1));
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
      this.events.push({ type: 'projectile_hit', projectile: s.id, army: a.id, owner: s.owner, victim: a.owner, x: a.x, y: a.y, kills });
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
      this.pending = this.pending.filter(o => o.from !== b.id);            // and so is its waiting order
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
      this.pending.map(o => [o.from, o.to, o.launchTick]),
      this.gseed && [this.gseed.site, this.gseed.phase, this.gseed.holder, this.gseed.holdTicks], this.buffs.length, this.bridge?.open, this.control,
      this.zones.map(z => [z.kind, Math.round(z.x), z.endTick]), this.bbuffs.length, this.pbuffs.length, this.players.map(p => p.cd),
    ]);
  }
}

export type { Pct };
