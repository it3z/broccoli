import type { AiProfile, Building, Pct } from './types';
import type { Match } from './sim';
import { Rng } from './rng';

export type Difficulty = 'easy' | 'normal' | 'hard';
export interface AiDecision { tick: number; action: 'defend' | 'upgrade' | 'build' | 'attack' | 'wait'; detail: string }

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
    if (!this.prof) this.prof = m.bal.ai[this.difficulty];
    if (m.phase !== 'playing' || !m.players[this.player].alive || m.tick < this.nextThink) return;
    const [a, b] = this.prof.thinkMs;
    this.nextThink = m.tick + Math.max(1, Math.round((this.rng.range(a, b) / 1000) * m.bal.tickRate));
    if (this.rng.next() < this.prof.skip) return;
    this.think(m);
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
    const front = (b: Building) => Math.min(...foes.map(e => m.paths[b.id][e.id].len), 1e9);
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

    // 1. defend: reinforce a threatened building from the nearest safe neighbour that can still help
    for (const b of mine) {
      if (!prof.defends || !inDanger(b)) continue;
      const helper = mine.filter(o => o.id !== b.id && spare(o) >= 4)
        .sort((x, y) => m.paths[x.id][b.id].len - m.paths[y.id][b.id].len)[0];
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
      const near = [...sources].sort((x, y) => m.paths[x.id][t.id].len - m.paths[y.id][t.id].len);
      const orders: { b: Building; want: number }[] = [];
      let sum = 0, need = Infinity, far = 0;
      for (const s of near) {
        far = Math.max(far, m.paths[s.id][t.id].len);
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
      plans.push({ score: (value / (Math.max(need, 1) + far / 40)) * (affordable ? 1 : 0.2), to: t.id, need, orders });
    }
    if (plans.length === 0) { this.log(m, 'wait', 'no affordable target'); return; }
    plans.sort((x, y) => y.score - x.score);
    const pick = plans[this.rng.int(Math.min(Math.max(1, prof.topPicks), plans.length))];
    for (const o of pick.orders) {
      m.enqueue({ type: 'send', player: me, from: [o.b.id], to: pick.to, pct: pctFor(o.b, o.want) });
    }
    this.log(m, 'attack', `${pick.orders.map(o => `#${o.b.id}x${o.want}`).join('+')} -> #${pick.to} (need ${Math.ceil(pick.need)})`);
  }
}
