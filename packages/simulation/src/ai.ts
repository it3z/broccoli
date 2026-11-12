import type { Building, Pct } from './types';
import type { Match } from './sim';
import { Rng } from './rng';

export type Difficulty = 'easy' | 'normal' | 'hard';

interface Profile { thinkMs: [number, number]; margin: number; reserve: number; skip: number; builds: boolean; towers: boolean }
const PROFILES: Record<Difficulty, Profile> = {
  easy: { thinkMs: [650, 800], margin: 1.6, reserve: 5, skip: 0.4, builds: false, towers: false },
  normal: { thinkMs: [350, 550], margin: 1.3, reserve: 3, skip: 0.12, builds: true, towers: false },
  hard: { thinkMs: [150, 300], margin: 1.15, reserve: 2, skip: 0, builds: true, towers: true },
};

/**
 * Computer opponent. It only reads what a human sees on the board (owners, garrisons, marching waves)
 * and acts through the same command queue, on a human-like thinking schedule.
 */
export class AIController {
  private rng: Rng;
  private nextThink: number;
  private prof: Profile;
  constructor(readonly player: number, readonly difficulty: Difficulty, seed: number) {
    this.rng = new Rng(seed * 7919 + player * 104729 + 17);
    this.prof = PROFILES[difficulty];
    this.nextThink = 30 + this.rng.int(20);
  }

  update(m: Match): void {
    if (m.phase !== 'playing' || !m.players[this.player].alive || m.tick < this.nextThink) return;
    const [a, b] = this.prof.thinkMs;
    this.nextThink = m.tick + Math.max(1, Math.round((this.rng.range(a, b) / 1000) * m.bal.tickRate));
    if (this.rng.next() < this.prof.skip) return;
    this.think(m);
  }

  private think(m: Match): void {
    const me = this.player, team = m.players[me].team, prof = this.prof;
    const mine = m.buildings.filter(b => b.owner === me);
    if (mine.length === 0) return;
    const hostile = (b: Building) => b.owner < 0 || m.players[b.owner].team !== team;

    // what is marching where
    const threat = new Map<number, number>(), friendly = new Map<number, number>();
    for (const w of m.waves) {
      const map = m.players[w.owner].team === team ? friendly : threat;
      map.set(w.to, (map.get(w.to) ?? 0) + w.units);
    }
    const inDanger = (b: Building) => {
      const t = threat.get(b.id) ?? 0;
      return t > 0 && t * 1.2 > b.garrison * m.defenseFactor(b) + (friendly.get(b.id) ?? 0);
    };
    // one back-line farm at a time saves up for its next level instead of feeding attacks
    const foes = m.buildings.filter(b => b.owner >= 0 && m.players[b.owner].team !== team);
    const front = (b: Building) => Math.min(...foes.map(e => m.paths[b.id][e.id].len), 1e9);
    const farms = mine.filter(b => b.type === 'farm');
    const has = (t: string) => mine.some(b => b.type === t || b.convertTo === t);
    const idle = farms.filter(b => !b.busyKind);
    const forgeSite = prof.builds && farms.length >= 4 && !has('forge')
      ? [...idle].sort((x, y) => x.level - y.level || front(y) - front(x) || x.id - y.id)[0] : undefined;
    const towerSite = prof.towers && farms.length >= 5 && has('forge') && !has('tower')
      ? [...idle].sort((x, y) => x.level - y.level || front(x) - front(y) || x.id - y.id)[0] : undefined;
    const saver = mine.filter(b => b.type === 'farm' && !b.busyKind && m.upgradeCost(b) !== null && b.garrison < m.capacity(b) - 1 && b !== forgeSite && b !== towerSite)
      .sort((x, y) => x.level - y.level || front(y) - front(x) || x.id - y.id)[0];
    const spare = (b: Building) =>
      (inDanger(b) || b === saver || b === forgeSite || b === towerSite ? 0 : Math.floor(b.garrison) - m.committed(b.id) - prof.reserve);
    const pctFor = (b: Building, want: number): Pct => {
      const free = Math.floor(b.garrison) - m.committed(b.id);
      for (const p of [25, 50, 75] as Pct[]) if (Math.floor((free * p) / 100) >= want) return p;
      return 100;
    };

    // 1. rescue a threatened building from the nearest safe neighbour
    for (const b of mine) {
      if (!inDanger(b)) continue;
      const helper = mine.filter(o => o.id !== b.id && spare(o) >= 4)
        .sort((x, y) => m.paths[x.id][b.id].len - m.paths[y.id][b.id].len)[0];
      if (helper) { m.enqueue({ type: 'send', player: me, from: [helper.id], to: b.id, pct: 75 }); return; }
    }

    // 2. grow: upgrade farms (and towers on hard)
    for (const b of mine) {
      if (b.type === 'forge' || inDanger(b) || !m.canUpgrade(b) || b === forgeSite || b === towerSite) continue;
      if (b.type === 'tower' && !prof.towers) continue;
      const cost = m.upgradeCost(b)!;
      if (Math.floor(b.garrison) - m.committed(b.id) >= cost + prof.reserve) {
        m.enqueue({ type: 'upgrade', player: me, building: b.id });
        return;
      }
    }

    // 3. build: convert the chosen site once it has saved enough
    for (const site of [forgeSite, towerSite]) {
      if (!site || inDanger(site)) continue;
      const to = site === forgeSite ? 'forge' : 'tower';
      if (m.canConvert(site, to) && Math.floor(site.garrison) - m.committed(site.id) >= m.bal.convert.cost) {
        m.enqueue({ type: 'convert', player: me, building: site.id, to });
        return;
      }
    }

    // 4. attack the best target we can actually take
    const A = m.attackFactor(me);
    const speed = m.bal.unitSpeed * m.speedFactor(me);
    const plans: { score: number; to: number; orders: { b: Building; want: number }[] }[] = [];
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
        need = ((t.garrison + growth) * D) / A * prof.margin + 2 - (friendly.get(t.id) ?? 0);
        const want = Math.min(spare(s), Math.ceil(need - sum));
        if (want <= 0) break;
        orders.push({ b: s, want }); sum += want;
        if (sum >= need) break;
      }
      if (orders.length === 0) continue;
      const affordable = sum >= need;
      if (!affordable && !allFull) continue;
      const value = (t.type === 'farm' ? 10 + 4 * t.level : t.type === 'forge' ? 12 : 8) * (t.owner >= 0 ? 1.3 : 1);
      plans.push({ score: (value / (Math.max(need, 1) + far / 40)) * (affordable ? 1 : 0.2), to: t.id, orders });
    }
    if (plans.length === 0) return;
    plans.sort((x, y) => y.score - x.score);
    const pick = this.difficulty === 'easy' ? plans[this.rng.int(Math.min(3, plans.length))] : plans[0];
    for (const o of pick.orders) {
      m.enqueue({ type: 'send', player: me, from: [o.b.id], to: pick.to, pct: pctFor(o.b, o.want) });
    }
  }
}
