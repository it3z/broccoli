import type { AiProfile, Building, Pct } from './types';
import type { Match } from './sim';
import { Rng } from './rng';
import { pointAt } from './paths';

export type Difficulty = 'easy' | 'normal' | 'hard';
export interface AiDecision { tick: number; action: 'defend' | 'upgrade' | 'build' | 'attack' | 'wait' | 'hero' | 'seed'; detail: string }

/**
 * Computer opponent. No hidden bonuses: it reads only what a human sees on the board (owners, garrisons,
 * marching armies), acts through the same command queue, and thinks on a human-like schedule.
 * All difficulty knobs live in balance.json under "ai". `trace` keeps the latest decisions for dev tools.
 */
export class AIController {
  private rng: Rng;
  private nextThink: number;
  private prof: AiProfile;
  readonly trace: AiDecision[] = [];
  orders = 0;

  constructor(readonly player: number, readonly difficulty: Difficulty, seed: number, profile?: AiProfile) {
    this.rng = new Rng(seed * 7919 + player * 104729 + 17);
    this.prof = profile!;
    this.nextThink = 30 + this.rng.int(20);
  }

  private log(m: Match, action: AiDecision['action'], detail: string): void {
    this.trace.push({ tick: m.tick, action, detail });
    if (this.trace.length > 60) this.trace.shift();
    if (action !== 'wait') this.orders++;
  }

  update(m: Match): void {
    if (!this.prof) this.prof = { ...m.bal.ai[this.difficulty], ...(m.bal.aiMap?.[m.map.id]?.[this.difficulty] ?? {}) } as AiProfile;
    if (m.phase !== 'playing' || !m.players[this.player].alive || m.tick < this.nextThink) return;
    const [a, b] = this.prof.thinkMs;
    this.nextThink = m.tick + Math.max(1, Math.round((this.rng.range(a, b) / 1000) * m.bal.tickRate));
    if (this.rng.next() < this.prof.skip) return;
    this.think(m);
  }

  /** Use a hero ability when it clearly pays: shield or fill a building about to fall, slow or root the biggest
   *  group marching on us, speed up our own attack, or let a tower fire faster at groups in its range. */
  private hero(m: Match, mine: Building[], threat: Map<number, number>, inDanger: (b: Building) => boolean): boolean {
    const me = this.player, defs = m.heroAbilities(me);
    if (!defs.length || this.rng.next() < this.prof.skip) return false;
    for (let slot = 0; slot < defs.length; slot++) {
      if (!m.abilityReady(me, slot)) continue;
      const d = defs[slot], use = (c: { building?: number; x?: number; y?: number }, why: string) => {
        m.enqueue({ type: 'ability', player: me, slot, ...c }); this.log(m, 'hero', `${d.id} ${why}`); return true;
      };
      const danger = mine.filter(inDanger).sort((x, y) => (threat.get(y.id) ?? 0) - (threat.get(x.id) ?? 0))[0];
      if ((d.id === 'bulwark' || d.id === 'burst') && danger) return use({ building: danger.id }, `on threatened #${danger.id}`);
      if (d.id === 'burst' && m.tick > 60 * m.bal.tickRate) {
        const front = [...mine].sort((x, y) => y.garrison - x.garrison)[0];
        if (front) return use({ building: front.id }, `boost #${front.id}`);
      }
      if (d.id === 'rush' && m.armies.filter(a => a.owner === me && a.state === 'moving' && !m.sameTeam(m.buildings[a.to].owner, me)).length >= 2) return use({}, 'own attack under way');
      if (d.id === 'volley') {
        const tw = mine.find(b => b.type === 'tower' && m.armies.some(a => !m.sameTeam(a.owner, me) && Math.hypot(a.x - b.x, a.y - b.y) <= m.towerRange(b)));
        if (tw) return use({ building: tw.id }, `tower #${tw.id}`);
      }
      if (d.id === 'mud' || d.id === 'snare') {
        const big = m.armies.filter(a => !m.sameTeam(a.owner, me) && a.state === 'moving' && m.buildings[a.to].owner === me && a.units >= 6)
          .sort((x, y) => y.units - x.units)[0];
        if (big) {
          const ahead = Math.min(m.pathOf(big).len - 30, big.dist + big.speed * (d.armSec ?? 1) * 1.1);
          const p = pointAt(m.pathOf(big), ahead);
          if (m.inReach(me, p.x, p.y, d.range ?? 500)) return use({ x: p.x, y: p.y }, `ahead of ${big.units} units`);
        }
      }
    }
    return false;
  }

  private think(m: Match): void {
    const me = this.player, prof = this.prof;
    const mine = m.buildings.filter(b => b.owner === me);
    if (mine.length === 0) return;
    const hostile = (b: Building) => !m.sameTeam(b.owner, me);

    // what is marching where (visible to everyone on the board)
    const threat = new Map<number, number>(), friendly = new Map<number, number>(), support = new Map<number, number>();
    for (const a of m.armies) {
      const friendlyArmy = m.sameTeam(a.owner, me);
      const tb = m.buildings[a.to];
      if (!friendlyArmy && m.sameTeam(a.owner, tb.owner)) { support.set(a.to, (support.get(a.to) ?? 0) + a.units); continue; }
      if (!friendlyArmy && tb.owner !== me && !m.sameTeam(tb.owner, me)) continue; // enemies fighting each other / neutrals
      const map = friendlyArmy ? friendly : threat;
      const weight = friendlyArmy ? a.units : a.units * m.attackFactor(a.owner);
      map.set(a.to, (map.get(a.to) ?? 0) + weight);
    }
    const inDanger = (b: Building) => {
      const t = threat.get(b.id) ?? 0;
      return t > 0 && t * 1.15 > (b.garrison + (friendly.get(b.id) ?? 0)) * m.defenseFactor(b);
    };
    const foes = m.buildings.filter(b => b.owner >= 0 && hostile(b));
    // distances as a group leaving now would walk them: with the drawbridge closed it uses the other crossing
    const v = m.bal.unitSpeed * m.speedFactor(me), far2 = (a: number, b: number) => m.eta(a, b, me) * v;
    const front = (b: Building) => Math.min(...foes.map(e => far2(b.id, e.id)), 1e9);
    const farms = mine.filter(b => b.type === 'farm');
    const has = (t: string) => mine.some(b => b.type === t || b.convertTo === t);
    const idle = farms.filter(b => !b.busyKind);
    // building sites: only with a large economy, on a farm that is sitting full anyway (never starve the war effort)
    const full = (b: Building) => b.garrison >= m.capacity(b) - 1;
    const forgeSite = prof.builds && farms.length >= prof.forgeAtFarms && !has('forge')
      ? idle.filter(full).sort((x, y) => x.level - y.level || front(y) - front(x) || x.id - y.id)[0] : undefined;
    const towerSite = prof.towers && farms.length >= prof.forgeAtFarms - 1 && has('forge') && !has('tower')
      ? idle.filter(full).sort((x, y) => x.level - y.level || front(x) - front(y) || x.id - y.id)[0] : undefined;
    // one back-line level-1 farm at a time saves up for level 2 instead of feeding attacks
    const saver = mine.filter(b => b.type === 'farm' && !b.busyKind && b.level < Math.min(2, prof.maxFarmLevel) && !full(b))
      .sort((x, y) => x.level - y.level || front(y) - front(x) || x.id - y.id)[0];
    const ready = (b: Building) => m.tick >= b.sendReadyTick;
    // units a building can give away: never the ones it needs against an attack that is already on its way
    const hold = (b: Building) => Math.ceil(((threat.get(b.id) ?? 0) * 1.15) / m.defenseFactor(b));
    const spare = (b: Building) =>
      (inDanger(b) || b === saver || !ready(b) ? 0 : Math.floor(b.garrison) - prof.reserve - hold(b));
    const pctFor = (b: Building, want: number): Pct => {
      const have = Math.floor(b.garrison);
      for (const p of [25, 50, 75] as Pct[]) if (Math.floor((have * p) / 100) >= want) return p;
      return 100;
    };

    // 0. hero abilities (same rules and cooldowns as the player)
    if (this.hero(m, mine, threat, inDanger)) return;
    // objectives: the Golden Seed site and, in control mode, the central bloom are worth far more than their walls
    const sd = m.gseed, bloom = m.mode === 'control' ? m.sites[0] : -1;
    const objective = (id: number) => (sd && sd.site === id ? 2.6 : 1) * (id === bloom ? 4 : 1);

    // 1. defend: reinforce a threatened building from the nearest safe neighbour that can still help
    for (const b of mine) {
      if (!prof.defends || !(inDanger(b) || (objective(b.id) > 1 && (threat.get(b.id) ?? 0) > 0 && (threat.get(b.id) ?? 0) * 1.4 > b.garrison * m.defenseFactor(b)))) continue;
      const helper = mine.filter(o => o.id !== b.id && spare(o) >= 4)
        .sort((x, y) => far2(x.id, b.id) - far2(y.id, b.id))[0];
      if (helper) {
        m.enqueue({ type: 'send', player: me, from: [helper.id], to: b.id, pct: 75 });
        this.log(m, 'defend', `#${helper.id} -> #${b.id} (threat ${Math.round(threat.get(b.id) ?? 0)} vs ${Math.floor(b.garrison)})`);
        return;
      }
    }

    // 2. grow: upgrade farms (and towers on hard)
    for (const b of mine) {
      if (b.type === 'forge' || inDanger(b) || !m.canUpgrade(b)) continue;
      // level 1 -> 2 is saved for; higher levels only when the farm is sitting full and would waste production
      if (b.type === 'farm' && (b.level >= prof.maxFarmLevel || (b.level >= 2 && !full(b)))) continue;
      if (b.type === 'tower' && !prof.towers) continue;
      if (Math.floor(b.garrison) >= m.upgradeCost(b)! + prof.reserve + hold(b)) {
        m.enqueue({ type: 'upgrade', player: me, building: b.id });
        this.log(m, 'upgrade', `#${b.id} ${b.type} L${b.level} -> L${b.level + 1}`);
        return;
      }
    }

    // 3. build: convert the chosen site once it has saved enough
    for (const site of [forgeSite, towerSite]) {
      if (!site || inDanger(site)) continue;
      const to = site === forgeSite ? 'forge' : 'tower';
      if (m.canConvert(site, to) && Math.floor(site.garrison) >= m.bal.convert.cost + hold(site)) {
        m.enqueue({ type: 'convert', player: me, building: site.id, to });
        this.log(m, 'build', `#${site.id} -> ${to}`);
        return;
      }
    }

    // 4. expand / attack: the best target we can actually take, weighing value, distance and cost
    const A = m.attackFactor(me);
    const speed = m.bal.unitSpeed * m.speedFactor(me);
    const plans: { score: number; to: number; need: number; orders: { b: Building; want: number }[] }[] = [];
    const sources = mine.filter(b => spare(b) >= 2);
    const allFull = farms.length > 0 && farms.every(b => b.garrison >= m.capacity(b) - 1);
    for (const t of m.buildings) {
      if (!hostile(t)) continue;
      const D = m.defenseFactor(t);
      const near = [...sources].sort((x, y) => far2(x.id, t.id) - far2(y.id, t.id));
      const orders: { b: Building; want: number }[] = [];
      let sum = 0, need = Infinity, far = 0;
      for (const s of near) {
        far = Math.max(far, far2(s.id, t.id));
        const growth = Math.min(m.prodRate(t) * (far / speed), Math.max(0, m.capacity(t) - t.garrison));
        need = ((t.garrison + growth + (support.get(t.id) ?? 0)) * D) / A * prof.margin + 2 - (friendly.get(t.id) ?? 0);
        const want = Math.min(spare(s), Math.ceil(need - sum));
        if (want <= 0) break;
        orders.push({ b: s, want }); sum += want;
        if (sum >= need) break;
      }
      if (orders.length === 0) continue;
      const affordable = sum >= need;
      if (!affordable && !allFull) continue;
      const value = (t.type === 'farm' ? 10 + 4 * t.level : t.type === 'forge' ? 12 : 8) * (t.owner >= 0 ? 1.3 : 1);
      plans.push({ score: (value * objective(t.id) / (Math.max(need, 1) + far / 40)) * (affordable ? 1 : 0.2), to: t.id, need, orders });
    }
    if (plans.length === 0) { this.log(m, 'wait', 'no affordable target'); return; }
    plans.sort((x, y) => y.score - x.score);
    const pick = plans[this.rng.int(Math.min(Math.max(1, prof.topPicks), plans.length))];
    for (const o of pick.orders) {
      m.enqueue({ type: 'send', player: me, from: [o.b.id], to: pick.to, pct: pctFor(o.b, o.want) });
    }
    if (objective(pick.to) > 1) this.log(m, 'seed', `objective #${pick.to}`);
    this.log(m, 'attack', `${pick.orders.map(o => `#${o.b.id}x${o.want}`).join('+')} -> #${pick.to} (need ${Math.ceil(pick.need)})`);
  }
}
