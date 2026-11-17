import { Rng, type Army, type Building, type Match, type SimEvent, type Vec } from '../../../../packages/simulation/src/index';
import { FALL, SOLDIER, clearBuildingCache, TILT, buildingTop, colorOf, darkOf, drawBuilding, drawPond, drawRock, drawTree, drawWater, emblemShape, makeSoldierSheets, shadow } from './art';
import { VIS } from './config';
import { loadTextures, texture } from './textures';

export interface DragState { sources: number[]; target: number | null; wx: number; wy: number }
export interface BoxState { x0: number; y0: number; x1: number; y1: number }
export interface Frame {
  match: Match; alpha: number; time: number; human: number; pct: number; lowFx: boolean; sync: boolean;
  selection: Set<number>; drag: DragState | null; box: BoxState | null;
  labels: { attack: string; reinforce: string; capture: string; sec: string };
}
interface Particle { on: boolean; x: number; y: number; vx: number; vy: number; g: number; life: number; max: number; size: number; color: string }
interface Fallen { x: number; y: number; vx: number; vy: number; rot: number; vr: number; t: number; owner: number }
interface Cheer { x: number; y: number; owner: number; t: number; phase: number }
interface Pop { x: number; y: number; t: number; text: string; color: string; size: number }
interface Ring { x: number; y: number; t: number; color: string }
interface BView { shake: number; flash: number; kick: number; raise: number; prevOwner: number; aim: number; tension: number; hits: number; hitClock: number; hitColor: string }
interface AView { ang: number; dust: number; seen: number; hitIdx: number; hitUntil: number; flash: number }

type Ctx = CanvasRenderingContext2D;

export class Renderer {
  private ctx: Ctx;
  private bg = document.createElement('canvas');
  private sheets = makeSoldierSheets(3);
  private pool: Particle[] = Array.from({ length: VIS.maxParticles }, () => ({ on: false, x: 0, y: 0, vx: 0, vy: 0, g: 0, life: 0, max: 1, size: 1, color: '#fff' }));
  private cursor = 0;
  private fallen: Fallen[] = [];
  private cheers: Cheer[] = [];
  private pops: Pop[] = [];
  private rings: Ring[] = [];
  private bview: BView[] = [];
  private aview = new Map<number, AView>();
  private innerTrees: { x: number; y: number; s: number; alpha: number }[] = [];
  private fighters = new Map<number, Army>();
  private routed: { x: number; y: number; ang: number; t: number; owner: number }[] = [];
  private last = 0;
  private frameNo = 0;
  private low = false;
  scale = 1; ox = 0; oy = 0; dpr = 1;
  private cacheScale = 1;
  private gateDown = 1;
  frameMs = 0;          // smoothed frame time, for the perf readout, tests and automatic quality
  drawnSoldiers = 0;    // how many soldier sprites the last frame drew

  constructor(private canvas: HTMLCanvasElement, private stage: HTMLElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  toWorld(sx: number, sy: number): Vec { return { x: (sx - this.ox) / this.scale, y: (sy - this.oy) / (this.scale * TILT) }; }
  toScreen(x: number, y: number): Vec { return { x: this.ox + x * this.scale, y: this.oy + y * TILT * this.scale }; }
  /** Soldier draw scale: never smaller than a readable size on screen, however small the viewport is. */
  private get ss(): number { return Math.max(1, Math.min(VIS.soldierMaxScale, VIS.soldierMinPx / (SOLDIER.h * this.scale))); }

  resize(match: Match): void {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * this.dpr); this.canvas.height = Math.round(h * this.dpr);
    // layout boxes (unaffected by the automatic landscape rotation); the canvas fills the app from its top-left corner
    const st = this.stage, s = { left: st.offsetLeft, top: st.offsetTop, width: st.offsetWidth, height: st.offsetHeight }, c = { left: 0, top: 0 };
    // frame the buildings (plus room for roofs, flags and labels), not the whole empty map
    const bs = match.map.buildings, pad = VIS.fitPad;
    const x0 = Math.min(...bs.map(b => b.x)) - pad.side, x1 = Math.max(...bs.map(b => b.x)) + pad.side;
    const y0 = (Math.min(...bs.map(b => b.y)) * TILT) - pad.top, y1 = (Math.max(...bs.map(b => b.y)) * TILT) + pad.bottom;
    this.scale = Math.min(s.width / (x1 - x0), s.height / (y1 - y0));
    this.ox = s.left - c.left + (s.width - (x1 - x0) * this.scale) / 2 - x0 * this.scale;
    this.oy = s.top - c.top + (s.height - (y1 - y0) * this.scale) / 2 - y0 * this.scale;
    this.bview = match.buildings.map((_, i) => this.bview[i] ?? { shake: 0, flash: 0, kick: 0, raise: 1, prevOwner: -1, aim: 0, tension: 0, hits: 0, hitClock: 0, hitColor: '#fff' });
    clearBuildingCache(); this.cacheScale = Math.min(3, Math.max(1, Math.ceil(this.dpr * this.scale * 4) / 4));
    this.paintBackground(match);
    loadTextures(() => this.paintBackground(match));
  }

  private world(c: Ctx): void {
    const k = this.dpr * this.scale;
    c.setTransform(k, 0, 0, k, this.dpr * this.ox, this.dpr * this.oy);
  }

  private paintBackground(match: Match): void {
    const map = match.map, forest = map.biome === 'forest';
    this.bg.width = this.canvas.width; this.bg.height = this.canvas.height;
    const c = this.bg.getContext('2d')!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    // matte olive ground, slightly desaturated so the armies stand out
    const g = c.createLinearGradient(0, 0, 0, this.bg.height);
    g.addColorStop(0, forest ? '#3d7446' : '#5d8f50'); g.addColorStop(1, forest ? '#2b5a3a' : '#467844');
    c.fillStyle = g; c.fillRect(0, 0, this.bg.width, this.bg.height);
    this.world(c);
    const rng = new Rng(map.id.length * 977 + map.buildings.length);
    const W = map.width, H = map.height;
    const X = () => rng.range(-700, W + 700), Y = () => rng.range(-400, H + 400);
    for (let i = 0; i < 170; i++) {
      c.fillStyle = rng.next() < 0.5 ? 'rgba(235,240,170,.06)' : 'rgba(10,50,25,.09)';
      c.beginPath(); c.ellipse(X(), Y() * TILT, rng.range(40, 150), rng.range(16, 55), 0, 0, 7); c.fill();
    }

    // height layer 1: the battlefield is a raised plateau; its edge drops as an earthen bank with rocks at the foot
    const px0 = 55, py0 = 20 * TILT, pw = W - 110, ph = (H - 5) * TILT - py0, rad = 170, drop = 24;
    c.fillStyle = 'rgba(8,30,14,.32)'; c.beginPath(); c.roundRect(px0 + 8, py0 + drop + 14, pw, ph, rad); c.fill();
    c.fillStyle = forest ? '#5a4a30' : '#6e5636'; c.beginPath(); c.roundRect(px0, py0 + drop, pw, ph, rad); c.fill();
    c.fillStyle = forest ? '#766040' : '#93754a'; c.beginPath(); c.roundRect(px0, py0 + drop * 0.55, pw, ph, rad); c.fill();
    c.fillStyle = forest ? '#8a7350' : '#a98a5c'; c.beginPath(); c.roundRect(px0, py0 + drop * 0.22, pw, ph, rad); c.fill();
    c.beginPath(); c.roundRect(px0, py0 + drop * 0.22, pw, ph, rad); texture(c, 'rock', 0.6, 0.7);
    const top = c.createLinearGradient(0, py0, 0, py0 + ph);
    top.addColorStop(0, forest ? '#78a062' : '#a2b46c'); top.addColorStop(1, forest ? '#628a52' : '#8ba05c');   // olive, lower saturation
    c.fillStyle = top; c.beginPath(); c.roundRect(px0, py0, pw, ph, rad); c.fill();
    texture(c, 'grass', 0.3, 0.9); texture(c, 'leaf', 0.18, 2.2);
    c.strokeStyle = 'rgba(250,255,215,.42)'; c.lineWidth = 3; c.beginPath(); c.roundRect(px0 + 3, py0 + 3, pw - 6, ph - 6, rad - 3); c.stroke();
    for (let x = px0 + rad * 0.6; x < px0 + pw - rad * 0.6; x += rng.range(70, 130)) {
      drawRock(c, x, (py0 + ph + drop + rng.range(-2, 8)) / TILT, rng.range(9, 16));
    }
    for (const sx of [px0 - 4, px0 + pw + 4]) for (let i = 0; i < 3; i++) drawRock(c, sx + rng.range(-6, 6), (py0 + ph * (0.45 + i * 0.16)) / TILT, rng.range(8, 13));
    c.save(); c.beginPath(); c.roundRect(px0, py0, pw, ph, rad); c.clip();
    for (let i = 0; i < 70; i++) {
      c.fillStyle = rng.next() < 0.55 ? 'rgba(250,252,190,.085)' : 'rgba(40,85,30,.06)';
      c.beginPath(); c.ellipse(rng.range(0, W), rng.range(0, H) * TILT, rng.range(60, 170), rng.range(20, 60), 0, 0, 7); c.fill();
    }
    c.restore();

    // height layer 2: towers and forges stand on a low terrace with its own earthen step
    for (const b of map.buildings) {
      if (b.type === 'farm') continue;
      const y = b.y * TILT + 5;
      c.fillStyle = 'rgba(20,40,15,.22)'; c.beginPath(); c.ellipse(b.x + 4, y + 15, 112, 58, 0, 0, 7); c.fill();
      c.fillStyle = forest ? '#766040' : '#93754a'; c.beginPath(); c.ellipse(b.x, y + 9, 108, 56, 0, 0, 7); c.fill();
      c.fillStyle = forest ? '#6ea660' : '#a6c97a'; c.beginPath(); c.ellipse(b.x, y, 108, 56, 0, 0, 7); c.fill();
      c.strokeStyle = 'rgba(250,255,215,.45)'; c.lineWidth = 2.5; c.beginPath(); c.ellipse(b.x, y, 105, 53.5, 0, Math.PI, Math.PI * 2); c.stroke();
    }

    // packed-dirt roads drawn exactly along the routes the armies walk
    const routes: Vec[][] = match.roads;     // the same polylines every army route is built from
    c.lineCap = 'round'; c.lineJoin = 'round';
    for (const [lw, col] of [[32, 'rgba(70,52,26,.30)'], [24, forest ? '#b39a66' : '#c9ad74'], [12, forest ? 'rgba(206,184,128,.6)' : 'rgba(226,204,150,.75)']] as const) {
      c.strokeStyle = col; c.lineWidth = lw;
      for (const pts of routes) { c.beginPath(); pts.forEach((q, k) => (k ? c.lineTo(q.x, q.y * TILT) : c.moveTo(q.x, q.y * TILT))); c.stroke(); }
    }
    // ring road around every junction: squads passing a building walk this loop (radius B_PASS), never through the yard
    const degree = map.buildings.map(() => 0);
    for (const r of routes) for (const [k, b] of map.buildings.entries()) if ([r[0], r[r.length - 1]].some(p => p.x === b.x && p.y === b.y)) degree[k]++;
    for (const [lw, col] of [[30, 'rgba(70,52,26,.30)'], [22, forest ? '#b39a66' : '#c9ad74'], [10, forest ? 'rgba(206,184,128,.6)' : 'rgba(226,204,150,.75)']] as const) {
      c.strokeStyle = col; c.lineWidth = lw;
      for (const [k, b] of map.buildings.entries()) if (degree[k] >= 2) { c.beginPath(); c.ellipse(b.x, b.y * TILT, match.passR[k], match.passR[k] * TILT, 0, 0, 7); c.stroke(); }
    }
    // packed-earth yard under every building, so garrison numbers and fights read against calm ground
    for (const b of map.buildings) {
      c.fillStyle = forest ? '#b39a66' : '#c9ad74'; c.beginPath(); c.ellipse(b.x, b.y * TILT + 4, 84, 44, 0, 0, 7); c.fill();
      c.fillStyle = forest ? 'rgba(206,184,128,.6)' : 'rgba(226,204,150,.75)'; c.beginPath(); c.ellipse(b.x, b.y * TILT + 4, 64, 32, 0, 0, 7); c.fill();
    }
    // packed-dirt grain over every yard
    c.save(); c.beginPath();
    for (const b of map.buildings) c.ellipse(b.x, b.y * TILT + 4, 84, 44, 0, 0, 7);
    c.clip(); c.beginPath(); c.rect(-2000, -2000, W + 4000, H + 4000); texture(c, 'dirt', 0.55, 0.8); c.restore();
    const roads: [Vec, Vec][] = [];
    for (const pts of routes) for (let k = 1; k < pts.length; k++) roads.push([pts[k - 1], pts[k]]);
    const roadDist = (x: number, y: number) => roads.reduce((best, [a, b]) => {
      const dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      return Math.min(best, Math.hypot(a.x + dx * t - x, a.y + dy * t - y));
    }, 1e9);
    // a few pebbles along the road shoulders
    for (const [a, b] of roads) {
      const len = Math.hypot(b.x - a.x, b.y - a.y), nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
      for (let d = 30; d < len - 30; d += rng.range(45, 90)) {
        const s = rng.next() < 0.5 ? 1 : -1, off = rng.range(15, 19) * s, x = a.x + ((b.x - a.x) * d) / len + nx * off, y = a.y + ((b.y - a.y) * d) / len + ny * off;
        if (map.buildings.some(q => Math.hypot(q.x - x, q.y - y) < 90)) continue;
        c.fillStyle = '#9a978d'; c.beginPath(); c.ellipse(x, y * TILT, 3.4, 2.4, 0, 0, 7); c.fill();
        c.fillStyle = '#cfccc2'; c.beginPath(); c.ellipse(x - 0.8, y * TILT - 0.8, 1.8, 1.1, 0, 0, 7); c.fill();
      }
    }
    // decoration stays off buildings, obstacles and roads; it is sparse in the middle and richer toward the edges
    const blocked = (x: number, y: number, pad: number) =>
      map.obstacles.some(o => Math.hypot(o.x - x, o.y - y) < o.r + pad) || map.buildings.some(b => Math.hypot(b.x - x, b.y - y) < 100 + pad) || roadDist(x, y) < 28;
    const onPlateau = (x: number, y: number) => x > px0 + 30 && x < px0 + pw - 30 && y * TILT > py0 + 20 && y * TILT < py0 + ph - 20;
    const edge = (x: number, y: number) => !onPlateau(x, y) || Math.min(x - px0, px0 + pw - x, y * TILT - py0, py0 + ph - y * TILT) < 95;
    for (let i = 0; i < 620; i++) {
      const x = X(), y = Y(); if (blocked(x, y, 6) || (!edge(x, y) && rng.next() > 0.22)) continue;
      c.strokeStyle = rng.next() < 0.5 ? 'rgba(45,95,40,.5)' : 'rgba(205,230,140,.5)'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(x - 4, y * TILT); c.lineTo(x - 6, y * TILT - 8); c.moveTo(x, y * TILT); c.lineTo(x, y * TILT - 11); c.moveTo(x + 4, y * TILT); c.lineTo(x + 7, y * TILT - 7); c.stroke();
    }
    const petals = forest ? ['#f4e9ff', '#ffd66b', '#ff9a6b'] : ['#ffffff', '#ffe36b', '#ff9ec4'];
    for (let i = 0; i < 190; i++) {
      const x = X(), y = Y(); if (blocked(x, y, 4) || (!edge(x, y) && rng.next() > 0.18)) continue;
      c.fillStyle = petals[rng.int(3)];
      for (let k = 0; k < 5; k++) { c.beginPath(); c.arc(x + Math.cos(k * 1.257) * 3.2, y * TILT + Math.sin(k * 1.257) * 2.6, 2.3, 0, 7); c.fill(); }
      c.fillStyle = '#e8a52a'; c.beginPath(); c.arc(x, y * TILT, 1.8, 0, 7); c.fill();
    }
    for (const o of map.obstacles) if (o.kind === 'pond') drawPond(c, o.x, o.y, o.r);
    for (const o of map.obstacles) if (o.kind === 'rock') drawRock(c, o.x, o.y, o.r);
    this.paintRiver(c, match);
    // a few trees stand on the plateau itself; they are drawn live so they can fade when a squad walks behind them
    this.innerTrees = [];
    for (let i = 0; i < 400 && this.innerTrees.length < 9; i++) {
      const x = rng.range(px0 + 60, px0 + pw - 60), y = rng.range(60, H - 40);
      if (!onPlateau(x, y) || !edge(x, y) || roadDist(x, y) < 75 || map.buildings.some(b => Math.hypot(b.x - x, b.y - y) < 170)
        || map.obstacles.some(o => Math.hypot(o.x - x, o.y - y) < o.r + 70) || this.innerTrees.some(q => Math.hypot(q.x - x, q.y - y) < 150)) continue;
      this.innerTrees.push({ x, y, s: rng.range(0.85, 1.15), alpha: 1 });
    }
    const trees: [number, number, number][] = [];
    for (let i = 0; i < (forest ? 260 : 150); i++) {
      const x = X(), y = Y();
      if (x > 70 && x < W - 70 && y > 40 && y < H - 30) continue; // keep the battlefield clear
      trees.push([x, y, rng.range(0.9, 1.5)]);
    }
    trees.sort((a, b) => a[1] - b[1]);
    for (const [x, y, s] of trees) drawTree(c, x, y * TILT, s, forest);
    // soft vignette pulls the eye to the battlefield
    c.setTransform(1, 0, 0, 1, 0, 0);
    const v = c.createRadialGradient(this.bg.width / 2, this.bg.height / 2, this.bg.height * 0.45, this.bg.width / 2, this.bg.height / 2, this.bg.width * 0.75);
    v.addColorStop(0, 'rgba(0,20,10,0)'); v.addColorStop(1, 'rgba(0,20,10,.38)');
    c.fillStyle = v; c.fillRect(0, 0, this.bg.width, this.bg.height);
  }

  // ---------- effects driven by simulation events (visual only; never feeds back into the rules) ----------
  onEvents(match: Match, events: SimEvent[]): void {
    for (const e of events) {
      if (e.type === 'battle_hit') {
        const b = match.buildings[e.building], v = this.bview[e.building];
        v.shake = 0.16; v.hits++; v.hitColor = colorOf(e.attacker);
        const a = (b.x * 7 + v.hits * 2.4) % 6.28;
        this.burst(b.x + Math.cos(a) * 34, b.y * TILT - 22 + Math.sin(a) * 12, v.hits % 2 ? '#fff6c2' : colorOf(b.owner), this.low ? 1 : 3, 90);
        if (!this.low && v.hits % 3 === 0) this.fall(b.x + Math.cos(a) * 52, b.y * TILT + 10, e.attacker);
        const av = this.aview.get(e.army); if (av) { av.hitIdx = v.hits; av.hitUntil = performance.now() + 170; }
      } else if (e.type === 'building_captured') {
        const b = match.buildings[e.building], y = b.y * TILT;
        const bv = this.bview[e.building]; bv.flash = 1; bv.raise = -1; bv.prevOwner = e.from;   // old flag comes down, the new one climbs
        if (!this.low) for (let i = 0; i < 2; i++) this.fall(b.x - 14 + i * 26, y + 16, e.from < 0 ? 4 : e.from);
        this.rings.push({ x: b.x, y, t: 0, color: colorOf(e.by) });
        this.burst(b.x, y - 40, colorOf(e.by), this.low ? 10 : 30, 170);
        this.burst(b.x, y - 40, '#ffffff', this.low ? 4 : 12, 100);
        this.pops.push({ x: b.x, y: y - buildingTop(b.type, b.level) - 6, t: 0, text: '⚑', color: colorOf(e.by), size: 1.7 });
        for (let i = 0; i < (this.low ? 2 : 4); i++) this.cheers.push({ x: b.x + (i - 1.5) * 26, y: b.y + 26 + (i % 2) * 8, owner: e.by, t: 0, phase: i * 0.9 });
      } else if (e.type === 'battle_resolved' && !e.captured && e.survivors === 0) {
        const b = match.buildings[e.building];
        this.rings.push({ x: b.x, y: b.y * TILT, t: 0.35, color: colorOf(b.owner) });
        // the beaten attack breaks: the last few stumble back the way they came, then drop
        const av = this.aview.get(e.army), ang = av ? av.ang + Math.PI : 0;
        for (let i = 0; i < (this.low ? 1 : 3); i++) this.routed.push({ x: b.x + Math.cos(ang) * 66 + (i - 1) * 16, y: b.y + Math.sin(ang) * 52 + (i % 2) * 10, ang, t: -i * 0.08, owner: e.attacker });
      } else if (e.type === 'tower_fired') {
        this.bview[e.tower].kick = 1;
      } else if (e.type === 'projectile_hit') {
        this.burst(e.x, e.y * TILT - 14, '#f4ecc4', this.low ? 2 : 6, 80);
        const hv = this.aview.get(e.army); if (hv) hv.flash = 1;   // the squad's counter flashes on the very tick it loses a unit
        this.fall(e.x, e.y * TILT, e.victim);
      } else if (e.type === 'clash_started') {
        this.rings.push({ x: e.x, y: e.y * TILT, t: 0.3, color: '#fff6c2' });
        this.pops.push({ x: e.x, y: e.y * TILT - 70, t: 0, text: '⚔', color: '#fff6c2', size: 1.3 });
      } else if (e.type === 'clash_hit') {
        this.burst(e.x, e.y * TILT - 16, '#fff6c2', this.low ? 1 : 3, 90);
        if (!this.low) this.fall(e.x + (Math.random() - 0.5) * 30, e.y * TILT, e.owner);
        const av = this.aview.get(e.army); if (av) { av.hitIdx++; av.hitUntil = performance.now() + 170; }
      } else if (e.type === 'army_destroyed') {
        this.burst(e.x, e.y * TILT - 10, colorOf(e.owner), 10, 110);
      } else if (e.type === 'upgraded' || e.type === 'converted') {
        const b = match.buildings[e.building];
        this.burst(b.x, b.y * TILT - 50, '#ffe36b', this.low ? 8 : 20, 120, -40);
        this.pops.push({ x: b.x, y: b.y * TILT - buildingTop(b.type, b.level) - 6, t: 0, text: e.type === 'upgraded' ? '▲' : '✦', color: '#ffe36b', size: 1.5 });
      }
    }
  }

  private burst(x: number, y: number, color: string, n: number, speed: number, lift = 0): void {
    for (let i = 0; i < n; i++) {
      const p = this.pool[this.cursor]; this.cursor = (this.cursor + 1) % this.pool.length;   // pooled: no per-particle allocation
      const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random() * 0.6);
      p.on = true; p.x = x; p.y = y; p.vx = Math.cos(a) * v; p.vy = Math.sin(a) * v * 0.6 - 60 + lift; p.g = 260;
      p.life = 0; p.max = 0.4 + Math.random() * 0.35; p.size = 3 + Math.random() * 4; p.color = color;
    }
  }
  private fall(x: number, y: number, owner: number): void {
    if (this.fallen.length >= VIS.maxFallen) this.fallen.shift();
    this.fallen.push({ x, y, vx: (Math.random() - 0.5) * 90, vy: -130 - Math.random() * 40, rot: 0, vr: (Math.random() < 0.5 ? -1 : 1) * (5 + Math.random() * 5), t: 0, owner });
  }

  /** How many soldier sprites stand for a group of `units` (the badge always shows the real number). */
  private icons(units: number): number {
    const max = this.low ? VIS.maxIconsLow : VIS.maxIcons;
    return units <= VIS.iconsOneToOne ? Math.max(1, units) : Math.min(max, VIS.iconsOneToOne + Math.ceil((units - VIS.iconsOneToOne) / VIS.unitsPerExtraIcon));
  }

  draw(f: Frame): void {
    const now = performance.now();
    const dt = Math.min(0.05, this.last ? (now - this.last) / 1000 : 0.016);
    if (this.last) this.frameMs = this.frameMs * 0.95 + (now - this.last) * 0.05;
    this.last = now; this.frameNo++; this.low = f.lowFx;
    const c = this.ctx, m = f.match, t = f.time, ss = this.ss;
    if (this.bview.length !== m.buildings.length) this.resize(m);
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(this.bg, 0, 0);
    this.world(c);
    if (!this.low) for (const o of m.map.obstacles) if (o.kind === 'pond') drawWater(c, o.x, o.y, o.r, t);

    // who is under attack (for warning markers)
    const threatened = new Set<number>();
    for (const a of m.armies) { const b = m.buildings[a.to]; if (b.owner === f.human && !m.sameTeam(a.owner, f.human)) threatened.add(b.id); }

    // ground markers
    for (const b of m.buildings) {
      const y = b.y * TILT;
      if (threatened.has(b.id)) {
        const k = 0.5 + 0.5 * Math.sin(t * 7);
        c.strokeStyle = `rgba(255,70,60,${0.45 + 0.45 * k})`; c.lineWidth = 6;
        c.beginPath(); c.ellipse(b.x, y, 66 + k * 6, (66 + k * 6) * TILT * 0.55, 0, 0, 7); c.stroke();
      }
      if (f.selection.has(b.id)) {
        if (b.type === 'tower') {
          const r = m.towerRange(b);
          c.fillStyle = 'rgba(255,255,255,.07)'; c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = 2; c.setLineDash([10, 8]);
          c.beginPath(); c.ellipse(b.x, y, r, r * TILT, 0, 0, 7); c.fill(); c.stroke(); c.setLineDash([]);
        }
        c.strokeStyle = '#fff'; c.lineWidth = 5; c.setLineDash([14, 9]); c.lineDashOffset = -t * 40;
        c.beginPath(); c.ellipse(b.x, y, 64, 64 * TILT * 0.55, 0, 0, 7); c.stroke(); c.setLineDash([]);
      }
    }
    for (const r of this.rings) {
      r.t += dt / 0.6;
      c.globalAlpha = Math.max(0, 1 - r.t); c.strokeStyle = r.color; c.lineWidth = 9 * (1 - r.t) + 2;
      c.beginPath(); c.ellipse(r.x, r.y, 50 + r.t * 90, (50 + r.t * 90) * TILT * 0.55, 0, 0, 7); c.stroke();
    }
    c.globalAlpha = 1;
    this.rings = this.rings.filter(r => r.t < 1);
    this.drawObjectives(c, f, dt);
    if (f.drag) this.drawOrderPaths(c, f);

    // depth-sorted scene: buildings, soldiers, cheering captors
    type Item = { y: number; kind: 0 | 1 | 2 | 3 | 4; ref: number; x: number; frame: HTMLCanvasElement | null; flip: boolean; hop: number };
    const items: Item[] = [];
    for (const b of m.buildings) items.push({ y: b.y, kind: 0, ref: b.id, x: b.x, frame: null, flip: false, hop: 0 });
    const badges: { x: number; y: number; a: Army }[] = [];
    let soldiers = 0;
    const atTarget = new Map<number, number>();
    const squeezeAt = (x: number, y: number) => { let g = 1e9; for (const q of m.buildings) g = Math.min(g, Math.hypot(q.x - x, q.y - y) - VIS.buildingBody); return Math.max(0.15, Math.min(1, (g - 14) / 46)); };
    for (const a of m.armies) {
      const sheet = this.sheets[a.owner % 4], target = m.buildings[a.to];
      let ax = a.px + (a.x - a.px) * f.alpha, ay = a.py + (a.y - a.py) * f.alpha;
      let v = this.aview.get(a.id);
      const path = m.pathOf(a).pts;
      let dx = a.x - a.px, dy = a.y - a.py;
      if (dx === 0 && dy === 0) { const n = path.length; dx = path[n - 1].x - path[n - 2].x; dy = path[n - 1].y - path[n - 2].y; }
      const foe = a.state === 'clashing' ? m.armies.find(x => x.id === a.foe) : undefined;
      if (foe) { dx = foe.x - a.x; dy = foe.y - a.y; }             // in a road clash the group turns to face its opponent
      const want = Math.atan2(dy, dx);
      if (!v) { v = { ang: want, dust: 0, seen: 0, hitIdx: 0, hitUntil: 0, flash: 0 }; this.aview.set(a.id, v); }
      let d = want - v.ang; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
      v.ang += d * Math.min(1, dt * 9); v.seen = this.frameNo;
      const cos = Math.cos(v.ang), sin = Math.sin(v.ang);
      // squads sharing a road keep to their own lane, so synchronized groups read as separate units (drawing only)
      const lane = (((a.id * 7) % 3) - 1) * VIS.laneOffset * Math.min(1, a.dist / 70, (m.pathOf(a).len - a.dist) / 70);
      const sq = squeezeAt(ax, ay); ax -= sin * lane * sq; ay += cos * lane * sq;
      const hostile = !m.sameTeam(a.owner, target.owner);
      const toTarget = Math.hypot(target.x - ax, target.y - ay);
      // blend from marching block to a battle arc around the target as the group closes in
      const blend = a.state === 'fighting' ? 1 : hostile ? Math.max(0, Math.min(1, (VIS.engageStart - toTarget) / VIS.engageBlend)) : 0;
      const n = this.icons(a.units);
      // two or three ranks; the block narrows and stretches where the road squeezes past a pond or rock
      let gap = 1e9; for (const o of m.map.obstacles) gap = Math.min(gap, Math.hypot(o.x - ax, o.y - ay) - o.r);
      // passing a building on the way: narrow to a column before the yard, widen again after it
      for (const q of m.buildings) if (q.id !== a.from && q.id !== a.to) gap = Math.min(gap, Math.hypot(q.x - ax, q.y - ay) - VIS.buildingBody);
      const squeeze = Math.max(0.4, Math.min(1, (gap - 14) / 46));
      const per = squeeze < 0.75 ? 2 : Math.max(3, Math.min(VIS.formationWidth, Math.ceil(n / 3)));
      // soldiers file out of the door rank by rank instead of appearing as a block
      const age = (m.tick + f.alpha - a.createdTick) / m.bal.tickRate, home = m.buildings[a.from];
      if (!this.fighters.has(a.to) && a.state === 'fighting') this.fighters.set(a.to, a);
      const n2 = path.length, inAng = Math.atan2(path[n2 - 2].y - path[n2 - 1].y, path[n2 - 2].x - path[n2 - 1].x);
      for (let k = 0; k < n; k++) {
        const row = Math.floor(k / per), cols = Math.min(per, n - row * per);
        const out = (age - row * VIS.exitRankDelay) / VIS.exitWalkSec;
        if (out <= 0) continue;                                    // this rank is still inside the building
        const across = ((k % per) - (cols - 1) / 2) * VIS.spacingAcross * ss * squeeze, along = -row * VIS.spacingAlong * ss * (2 - squeeze);
        let x = ax + cos * along - sin * across, y = ay + sin * along + cos * across;
        if (out < 1) { const e = out * out * (3 - 2 * out); x = home.x + (x - home.x) * e; y = home.y + 12 + (y - home.y - 12) * e; }
        let frame = sheet.run[(Math.floor(t * 10 + k * 1.3 + a.id) % 4 + 4) % 4], hop = 0, flip = cos < -0.05;
        if (blend > 0) {
          const ring = Math.floor(k / 7), slot = k % 7, inRing = Math.min(7, n - ring * 7);
          const ang = inAng + (slot - (inRing - 1) / 2) * 0.42;
          const lunge = a.state === 'fighting' ? Math.max(0, Math.sin(t * 9 + k * 1.9)) * 9 : 0;
          const rad = VIS.battleRadius + ring * 19 * ss - lunge;
          const bx = target.x + Math.cos(ang) * rad, by = target.y + Math.sin(ang) * rad * 0.8;
          x += (bx - x) * blend; y += (by - y) * blend;
          if (a.state === 'fighting') { frame = sheet.attack[Math.sin(t * 9 + k * 1.9) > 0.3 ? 1 : 0]; flip = target.x < x; }
        } else if (foe) {
          const lunge = Math.max(0, Math.sin(t * 9 + k * 1.9)) * 8;
          x += cos * lunge; y += sin * lunge;
          frame = sheet.attack[Math.sin(t * 9 + k * 1.9) > 0.3 ? 1 : 0];
        } else hop = Math.abs(Math.sin(t * 10 + k * 1.7 + a.id)) * 2.5;
        if (v.hitUntil > now && k === v.hitIdx % n) frame = sheet.hit;   // this one just took a knock
        items.push({ y, kind: 1, ref: a.owner, x, frame, flip, hop });
        soldiers++;
      }
      if (a.state === 'moving' && !this.low && (v.dust += dt) > 0.16) {
        v.dust = 0; const p = this.pool[this.cursor]; this.cursor = (this.cursor + 1) % this.pool.length;
        p.on = true; p.x = ax - cos * 14; p.y = ay * TILT - 2; p.vx = -cos * 12; p.vy = -14; p.g = 0; p.life = 0; p.max = 0.55; p.size = 6; p.color = 'rgba(235,225,180,.55)';
      }
      // counters of several squads at one target are stacked instead of piled on each other
      const nth = blend > 0.5 ? (atTarget.get(a.to) ?? 0) : 0; if (blend > 0.5) atTarget.set(a.to, nth + 1);
      badges.push({ x: blend > 0.5 ? target.x + Math.cos(inAng) * (VIS.battleRadius + 34) : ax, y: blend > 0.5 ? target.y + Math.sin(inAng) * (VIS.battleRadius + 34) * 0.8 - nth * 42 : ay, a });
    }
    this.drawnSoldiers = soldiers;
    if (this.frameNo % 120 === 0) for (const [id, v] of this.aview) if (v.seen < this.frameNo - 2) this.aview.delete(id);
    for (const ch of this.cheers) { ch.t += dt; items.push({ y: ch.y, kind: 2, ref: ch.owner, x: ch.x, frame: this.sheets[ch.owner % 4].run[0], flip: false, hop: Math.abs(Math.sin(ch.t * 9 + ch.phase)) * 16 }); }
    this.cheers = this.cheers.filter(ch => ch.t < VIS.cheerSec);
    // defenders step out to the gate while their building is under attack, facing the attackers
    for (const [bid, a] of this.fighters) {
      const b = m.buildings[bid], sheet = this.sheets[b.owner < 0 ? 4 : b.owner % 4];
      const path = m.pathOf(a).pts, n2 = path.length;
      const ang = Math.atan2(path[n2 - 2].y - path[n2 - 1].y, path[n2 - 2].x - path[n2 - 1].x);
      const count = Math.min(this.low ? 1 : 3, Math.ceil(b.garrison / 6));
      for (let i = 0; i < count; i++) {
        const side = (i - (count - 1) / 2) * 0.5, lunge = Math.max(0, Math.sin(t * 9 + i * 2.3 + 1.5)) * 7;
        const x = b.x + Math.cos(ang + side) * (34 + lunge), y = b.y + Math.sin(ang + side) * (34 + lunge) * 0.8;
        items.push({ y, kind: 1, ref: b.owner, x, frame: sheet.attack[Math.sin(t * 9 + i * 2.3 + 1.5) > 0.3 ? 1 : 0], flip: Math.cos(ang) < 0, hop: 0 });
        soldiers++;
      }
    }
    this.fighters.clear();
    for (const r of this.routed) {
      r.t += dt; if (r.t < 0) continue;
      const sheet = this.sheets[r.owner % 4];
      if (r.t < 0.55) { r.x += Math.cos(r.ang) * 120 * dt; r.y += Math.sin(r.ang) * 120 * dt; items.push({ y: r.y, kind: 1, ref: r.owner, x: r.x, frame: r.t > 0.4 ? sheet.hit : sheet.run[Math.floor(r.t * 14) % 4], flip: Math.cos(r.ang) < 0, hop: 0 }); }
      else items.push({ y: r.y, kind: 4, ref: r.owner, x: r.x, frame: sheet.fall, flip: false, hop: Math.max(0, Math.min(1, (1.3 - r.t) / 0.4)) });
    }
    this.routed = this.routed.filter(r => r.t < 1.3);
    this.innerTrees.forEach((tr, i) => items.push({ y: tr.y, kind: 3, ref: i, x: tr.x, frame: null, flip: false, hop: 0 }));
    items.sort((p, q) => p.y - q.y);

    const sw = SOLDIER.w * ss, sh = SOLDIER.h * ss;
    for (const it of items) {
      if (it.kind === 0) {
        const b = m.buildings[it.ref], v = this.bview[it.ref];
        v.shake = Math.max(0, v.shake - dt); v.flash = Math.max(0, v.flash - dt / 0.45); v.kick = Math.max(0, v.kick - dt / 0.22);
        v.raise = Math.min(1, v.raise + dt / 0.42);          // -1..0 old flag down, 0..1 new flag up
        if (b.type === 'tower') this.aimTower(m, b, v, dt);
        c.save();
        c.translate(b.x + (v.shake > 0 ? Math.sin(t * 90) * 2.5 : 0), b.y * TILT);
        if (v.kick > 0) c.scale(1 + v.kick * 0.05, 1 - v.kick * 0.07);
        if (b.busyKind) c.globalAlpha = 0.72 + 0.2 * Math.sin(t * 9);
        drawBuilding(c, b.type, b.level, b.owner, t, { raise: Math.abs(v.raise), flagOwner: v.raise < 0 ? v.prevOwner : b.owner, aim: v.aim, tension: v.tension, low: this.low, cacheScale: this.cacheScale });
        if (v.flash > 0) { c.globalAlpha = v.flash * 0.4; c.fillStyle = '#fff'; c.beginPath(); c.ellipse(0, -34, 50, 46, 0, 0, 7); c.fill(); }
        c.restore();
        if (b.owner >= 0 && !this.low) this.guards(c, b, t, ss);
      } else if (it.kind === 3) {
        // a tree on the plateau: fades while a squad is behind its crown
        const tr = this.innerTrees[it.ref];
        let hide = false;
        for (const a of m.armies) { if (Math.abs(a.x - tr.x) < 46 * tr.s && a.y < tr.y + 6 && tr.y - a.y < 105 * tr.s) { hide = true; break; } }
        tr.alpha += ((hide ? 0.3 : 1) - tr.alpha) * Math.min(1, dt * 8);
        c.globalAlpha = tr.alpha; drawTree(c, tr.x, tr.y * TILT, tr.s, m.map.biome === 'forest'); c.globalAlpha = 1;
      } else if (it.kind === 4) {
        const py = it.y * TILT;   // a routed soldier lying where he dropped
        c.globalAlpha = it.hop; c.drawImage(it.frame!, it.x - FALL.w * ss * 0.45, py - FALL.h * ss * 0.7, FALL.w * ss * 0.9, FALL.h * ss * 0.9); c.globalAlpha = 1;
      } else {
        const py = it.y * TILT;
        if (!this.low) {   // team-coloured footing under every soldier: ownership reads even where the sprite is small
          shadow(c, it.x, py + 1, 9 * ss, 3.6 * ss, 0.3);
          c.fillStyle = colorOf(it.ref); c.globalAlpha = 0.55; c.beginPath(); c.ellipse(it.x, py + 1, 7.5 * ss, 3 * ss, 0, 0, 7); c.fill(); c.globalAlpha = 1;
        }
        if (it.flip) { c.save(); c.translate(it.x, 0); c.scale(-1, 1); c.drawImage(it.frame!, -sw / 2, py - sh + 4 * ss - it.hop, sw, sh); c.restore(); }
        else c.drawImage(it.frame!, it.x - sw / 2, py - sh + 4 * ss - it.hop, sw, sh);
      }
    }

    // soldiers knocked out by towers or in battle tumble away (cartoon, no gore)
    for (const d of this.fallen) {
      d.t += dt; if (d.t < 0.3) { d.vy += 900 * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.rot += d.vr * dt; }
      const sheet = this.sheets[d.owner % 4];
      c.save(); c.globalAlpha = Math.max(0, Math.min(1, (0.95 - d.t) / 0.3));
      if (d.t < 0.3) { c.translate(d.x, d.y - 16); c.rotate(d.rot * 0.35); c.drawImage(sheet.hit, -sw * 0.45, -sh * 0.45, sw * 0.9, sh * 0.9); }
      else c.drawImage(sheet.fall, d.x - FALL.w * ss * 0.45, d.y - FALL.h * ss * 0.7, FALL.w * ss * 0.9, FALL.h * ss * 0.9);   // lies where it landed, then fades
      c.restore();
    }
    this.fallen = this.fallen.filter(d => d.t < 0.95);

    // tower projectiles: drawn straight from simulation state, so what you see is what deals the damage
    for (const s of m.projectiles) {
      const tw = m.buildings[s.tower], a = m.armies.find(x => x.id === s.target); if (!a) continue;
      const k = Math.max(0, Math.min(1, 1 - (s.ticksLeft - f.alpha) / s.totalTicks));
      const x0 = tw.x, y0 = tw.y * TILT - buildingTop('tower', tw.level) + 16;
      const x1 = a.px + (a.x - a.px) * f.alpha, y1 = (a.py + (a.y - a.py) * f.alpha) * TILT - 14;
      const at = (q: number) => ({ x: x0 + (x1 - x0) * q, y: y0 + (y1 - y0) * q - Math.sin(q * Math.PI) * 26 });
      const p = at(k), p0 = at(Math.max(0, k - 0.22));
      c.strokeStyle = 'rgba(255,250,210,.75)'; c.lineWidth = 3.5; c.lineCap = 'round';
      c.beginPath(); c.moveTo(p0.x, p0.y); c.lineTo(p.x, p.y); c.stroke();
      c.save(); c.translate(p.x, p.y); c.rotate(Math.atan2(p.y - p0.y, p.x - p0.x));
      c.fillStyle = '#fff7cf'; c.strokeStyle = '#6d6335'; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(11, 0); c.lineTo(-8, -5); c.lineTo(-4, 0); c.lineTo(-8, 5); c.closePath(); c.fill(); c.stroke();
      c.restore();
    }

    // particles (pooled)
    for (const p of this.pool) {
      if (!p.on) continue;
      p.life += dt; if (p.life >= p.max) { p.on = false; continue; }
      p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      const k = 1 - p.life / p.max;
      c.globalAlpha = k; c.fillStyle = p.color; c.beginPath(); c.arc(p.x, p.y, p.size * (0.5 + k * 0.5), 0, 7); c.fill();
    }
    c.globalAlpha = 1;

    this.drawLabels(c, f, badges, threatened, dt);
    this.drawObjectiveLabels(c, f);
    if (f.drag) this.drawOrderLabels(c, f);

    if (f.box) {
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const x = Math.min(f.box.x0, f.box.x1), y = Math.min(f.box.y0, f.box.y1);
      c.fillStyle = 'rgba(255,255,255,.14)'; c.strokeStyle = '#fff'; c.lineWidth = 2; c.setLineDash([6, 5]);
      c.fillRect(x, y, Math.abs(f.box.x1 - f.box.x0), Math.abs(f.box.y1 - f.box.y0));
      c.strokeRect(x, y, Math.abs(f.box.x1 - f.box.x0), Math.abs(f.box.y1 - f.box.y0)); c.setLineDash([]);
    }
  }

  /** Tower head: turn toward the nearest hostile squad in range and draw back as the next shot comes due. */
  private aimTower(m: Match, b: Building, v: BView, dt: number): void {
    let best: Army | null = null, bd = m.towerRange(b) ** 2;
    if (b.owner >= 0) for (const a of m.armies) {
      if (m.sameTeam(a.owner, b.owner)) continue;
      const d2 = (a.x - b.x) ** 2 + (a.y - b.y) ** 2; if (d2 <= bd) { bd = d2; best = a; }
    }
    if (best) {
      const want = Math.atan2((best.y - b.y) * TILT, best.x - b.x);
      let d = want - v.aim; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
      v.aim += d * Math.min(1, dt * 10);
      const every = Math.max(1, Math.round(m.bal.tower.levels[b.level - 1].fireIntervalSec * m.bal.tickRate));
      v.tension = Math.max(0, Math.min(1, 1 - b.cooldown / every)) * (1 - v.kick);
    } else { v.tension = Math.max(0, v.tension - dt * 3); v.aim += Math.sin(performance.now() / 1300 + b.id) * dt * 0.25; }   // idle scan
  }

  /** One or two idle soldiers stand guard at an owned building. */
  private guards(c: Ctx, b: Building, t: number, ss: number): void {
    const n = Math.min(2, Math.floor(b.garrison / VIS.unitsPerGuard));
    const sw = SOLDIER.w * ss * 0.85, sh = SOLDIER.h * ss * 0.85, img = this.sheets[b.owner % 4].run[0];
    for (let i = 0; i < n; i++) {
      const x = b.x + (i ? 44 : -44), y = b.y * TILT + 10 + Math.sin(t * 2 + b.id + i) * 0.8;
      shadow(c, x, y + 1, 8 * ss, 3.2 * ss, 0.24);
      if (i) { c.save(); c.translate(x, 0); c.scale(-1, 1); c.drawImage(img, -sw / 2, y - sh + 4, sw, sh); c.restore(); }
      else c.drawImage(img, x - sw / 2, y - sh + 4, sw, sh);
    }
  }

  private pill(c: Ctx, x: number, y: number, text: string, fs: number, fill: string, stroke: string, owner: number | null, ink = '#fff'): void {
    const tw = c.measureText(text).width, pw = tw + fs * (owner === null ? 0.9 : 1.5), ph = fs * 1.25, x0 = x - pw / 2;
    c.fillStyle = 'rgba(0,0,0,.35)'; c.beginPath(); c.roundRect(x0 - 2, y - ph / 2 + 1, pw + 4, ph + 3, ph / 2 + 2); c.fill();   // dark halo keeps numbers legible over bright effects
    c.fillStyle = fill; c.strokeStyle = stroke; c.lineWidth = Math.max(3, fs * 0.11);
    c.beginPath(); c.roundRect(x0, y - ph / 2, pw, ph, ph / 2); c.fill(); c.stroke();
    if (owner !== null) emblemShape(c, x0 + fs * 0.55, y, fs * 0.26, owner, owner < 0 ? '#cfc8b4' : '#fff');
    c.fillStyle = ink; c.fillText(text, x + (owner === null ? 0 : fs * 0.28), y + fs * 0.04);
  }

  private drawLabels(c: Ctx, f: Frame, badges: { x: number; y: number; a: Army }[], threatened: Set<number>, dt: number): void {
    const m = f.match, t = f.time, ss = this.ss;
    const fs = Math.max(27, VIS.labelMinPx / this.scale);
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = `800 ${fs}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    for (const b of m.buildings) {
      const v = this.bview[b.id], y = b.y * TILT + 24 + fs * 0.35, ph = fs * 1.25;
      this.pill(c, b.x + (v.shake > 0 ? Math.sin(t * 90) * 2.5 : 0), y, String(Math.floor(b.garrison)), fs,
        b.owner < 0 ? 'rgba(40,42,36,.86)' : darkOf(b.owner), b.owner < 0 ? '#cfc8b4' : '#fff', b.owner);
      const max = m.maxLevel(b);
      if (max > 1) for (let i = 0; i < max; i++) {
        c.fillStyle = i < b.level ? '#ffe36b' : 'rgba(0,0,0,.35)';
        c.beginPath(); c.arc(b.x + (i - (max - 1) / 2) * fs * 0.42, y + ph / 2 + fs * 0.26, fs * 0.14, 0, 7); c.fill();
      }
      const top = b.y * TILT - buildingTop(b.type, b.level);
      if (b.busyKind) {
        const k = (m.tick + f.alpha - b.busyStart) / (b.busyEnd - b.busyStart);
        c.lineWidth = 7; c.strokeStyle = 'rgba(0,0,0,.45)'; c.beginPath(); c.arc(b.x, top - 22, 15, 0, 7); c.stroke();
        c.strokeStyle = '#ffe36b'; c.beginPath(); c.arc(b.x, top - 22, 15, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, Math.min(1, k))); c.stroke();
      } else if (threatened.has(b.id)) {
        // warning sign over a building of yours that is being attacked
        const r = fs * 0.5, yy = top - 24 - r + Math.sin(t * 7) * 3;
        c.fillStyle = '#ffcf33'; c.strokeStyle = '#7a1d12'; c.lineWidth = 3; c.lineJoin = 'round';
        c.beginPath(); c.moveTo(b.x, yy - r); c.lineTo(b.x + r * 1.05, yy + r * 0.8); c.lineTo(b.x - r * 1.05, yy + r * 0.8); c.closePath(); c.fill(); c.stroke();
        c.fillStyle = '#7a1d12'; c.font = `900 ${r * 1.25}px system-ui, sans-serif`; c.fillText('!', b.x, yy + r * 0.18);
        c.font = `800 ${fs}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      }
      // battle damage ticker: one compact number per building, not one per hit
      if (v.hits > 0 && (v.hitClock += dt) > VIS.damageTickSec) {
        this.pops.push({ x: b.x + 46, y: b.y * TILT - 46, t: 0, text: '-' + v.hits, color: v.hitColor, size: 0.95 });
        v.hits = 0; v.hitClock = 0;
      }
    }
    // synchronized orders waiting to launch: countdown ring and seconds over the waiting building
    for (const o of m.pending) {
      if (o.owner !== f.human) continue;
      const b = m.buildings[o.from], yy = b.y * TILT - buildingTop(b.type, b.level) - 24;
      const k = Math.max(0, Math.min(1, (m.tick + f.alpha - o.orderTick) / Math.max(1, o.launchTick - o.orderTick)));
      c.lineWidth = 7; c.strokeStyle = 'rgba(0,0,0,.5)'; c.beginPath(); c.arc(b.x, yy, 17, 0, 7); c.stroke();
      c.strokeStyle = '#8fd8ff'; c.beginPath(); c.arc(b.x, yy, 17, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k); c.stroke();
      c.font = `800 ${fs * 0.72}px system-ui, sans-serif`; c.fillStyle = '#fff';
      c.fillText(((o.launchTick - m.tick) / m.bal.tickRate).toFixed(1), b.x, yy + 1);
      c.font = `800 ${fs}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    }
    // army badges: the real number of units in the group, with the team shape
    const afs = Math.max(21, VIS.badgeMinPx / this.scale);
    c.font = `800 ${afs}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    for (const g of badges) {
      const hv = this.aview.get(g.a.id), fl = hv ? hv.flash : 0;
      if (hv && fl > 0) hv.flash = Math.max(0, fl - dt / 0.25);
      this.pill(c, g.x, g.y * TILT - SOLDIER.h * ss - afs * (0.55 + fl * 0.25), String(g.a.units), afs * (1 + fl * 0.18), fl > 0.5 ? '#fff' : colorOf(g.a.owner), '#fff', g.a.owner, fl > 0.5 ? '#7a1d12' : '#fff');
    }
    for (const p of this.pops) {
      p.t += dt;
      c.globalAlpha = Math.max(0, 1 - p.t / 0.9); c.fillStyle = p.color; c.strokeStyle = 'rgba(0,0,0,.7)'; c.lineWidth = 5; c.lineJoin = 'round';
      c.font = `900 ${fs * p.size}px system-ui, sans-serif`;
      c.strokeText(p.text, p.x, p.y - p.t * 50); c.fillText(p.text, p.x, p.y - p.t * 50);
    }
    c.globalAlpha = 1;
    this.pops = this.pops.filter(p => p.t < 0.9);
  }

  /** River band with sandy banks; a timber bridge over every gap that has no drawbridge. */
  private paintRiver(c: Ctx, m: Match): void {
    const riv = m.map.obstacles.filter(o => o.kind === 'river').sort((a, b) => a.y - b.y || a.x - b.x);
    if (!riv.length) return;
    const r = riv[0].r, line = () => { c.beginPath(); riv.forEach((o, i) => (i ? c.lineTo(o.x, o.y * TILT) : c.moveTo(o.x, o.y * TILT))); };
    c.lineCap = 'round'; c.lineJoin = 'round';
    for (const [w, col] of [[r * 2 + 34, 'rgba(70,58,30,.3)'], [r * 2 + 22, '#d9c992'], [r * 2 + 8, '#c2b077'], [r * 2 - 6, '#4ea5cf'], [r * 0.9, '#3a8fc0']] as const) { c.strokeStyle = col; c.lineWidth = w; line(); c.stroke(); }
    c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = 2; c.setLineDash([18, 26]); line(); c.stroke(); c.setLineDash([]);
    const gates = m.map.obstacles.filter(o => o.kind === 'gate');
    for (let i = 1; i < riv.length; i++) {
      const a = riv[i - 1], b = riv[i];
      if (Math.hypot(b.x - a.x, b.y - a.y) < r * 2.6) continue;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (gates.some(g => Math.hypot(g.x - mx, g.y - my) < r)) continue;
      this.planks(c, mx, my, r * 2.6, 1);
    }
  }
  /** Timber deck across the river at (x, y); `down` 0..1 lowers it (drawbridges are raised when 0). */
  private planks(c: Ctx, x: number, y: number, len: number, down: number): void {
    const py = y * TILT, w = 46, half = len / 2;
    c.save(); c.translate(x, py);
    c.fillStyle = 'rgba(20,30,40,.3)'; c.fillRect(-half, 6, len, w * TILT * 0.9);
    const lift = (1 - down) * 26;
    c.fillStyle = '#84603a'; c.fillRect(-half, -w * TILT / 2 + 4 - lift, len, w * TILT);
    c.fillStyle = '#b98a56'; c.fillRect(-half, -w * TILT / 2 - lift, len, w * TILT);
    c.strokeStyle = 'rgba(90,60,30,.6)'; c.lineWidth = 1.2;
    for (let k = -half + 8; k < half; k += 10) { c.beginPath(); c.moveTo(k, -w * TILT / 2 - lift); c.lineTo(k, w * TILT / 2 - lift); c.stroke(); }
    c.fillStyle = '#5a3d22'; for (const sx of [-half - 3, half - 5]) for (const sy of [-w * TILT / 2 - 6, w * TILT / 2 - 6]) c.fillRect(sx, sy - lift * 0.4, 8, 14 + lift * 0.4);
    c.restore();
  }

  /** Map objectives drawn on the ground: drawbridge, Golden Seed site, seed rewards, hero zones and shields. */
  private drawObjectives(c: Ctx, f: Frame, dt: number): void {
    const m = f.match, t = f.time, R = m.bal.tickRate;
    if (m.bridge) for (const g of m.map.obstacles.filter(o => o.kind === 'gate')) {
      this.gateDown += ((m.bridge.open ? 1 : 0) - this.gateDown) * Math.min(1, dt * 4);
      this.planks(c, g.x, g.y, 46 * 2.6, this.gateDown);
      if (!m.bridge.open || m.bridge.warned) {
        const k = 0.5 + 0.5 * Math.sin(t * 8);
        c.strokeStyle = m.bridge.open ? `rgba(255,180,58,${0.5 + 0.4 * k})` : 'rgba(228,59,75,.85)'; c.lineWidth = 5; c.setLineDash([10, 7]);
        c.beginPath(); c.ellipse(g.x, g.y * TILT, 70, 70 * TILT, 0, 0, 7); c.stroke(); c.setLineDash([]);
      }
    }
    for (const fb of m.buffs) for (const b of m.buildings) {
      if (b.owner !== fb.player || b.type !== 'farm' || Math.hypot(b.x - fb.x, b.y - fb.y) > m.bal.seed.radius) continue;
      const k = 0.5 + 0.5 * Math.sin(t * 5 + b.id);
      c.strokeStyle = `rgba(255,214,90,${0.45 + 0.4 * k})`; c.lineWidth = 6; c.beginPath(); c.ellipse(b.x, b.y * TILT, 70 + k * 6, (70 + k * 6) * TILT * 0.6, 0, 0, 7); c.stroke();
    }
    const sd = m.gseed;
    if (sd) {
      const b = m.buildings[sd.site], k = 0.5 + 0.5 * Math.sin(t * 6);
      c.strokeStyle = `rgba(255,214,90,${sd.phase === 'warn' ? 0.4 + 0.5 * k : 0.95})`; c.lineWidth = sd.phase === 'warn' ? 5 : 8; c.setLineDash(sd.phase === 'warn' ? [12, 9] : []);
      c.beginPath(); c.ellipse(b.x, b.y * TILT, 92, 92 * TILT * 0.62, 0, 0, 7); c.stroke(); c.setLineDash([]);
      if (sd.phase === 'active' && sd.holder >= 0) {
        const p = sd.holdTicks / (m.bal.seed.holdSec * R);
        c.strokeStyle = colorOf(sd.holder); c.lineWidth = 9;
        c.beginPath(); c.ellipse(b.x, b.y * TILT, 92, 92 * TILT * 0.62, 0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p); c.stroke();
      }
    }
    for (const z of m.zones) {
      const armed = m.tick >= z.armTick, k = 0.5 + 0.5 * Math.sin(t * 10), y = z.y * TILT;
      if (z.kind === 'mud') {
        c.fillStyle = armed ? 'rgba(110,78,40,.55)' : 'rgba(110,78,40,.22)'; c.beginPath(); c.ellipse(z.x, y, z.r, z.r * TILT, 0, 0, 7); c.fill();
        if (armed) { c.fillStyle = 'rgba(70,48,22,.6)'; for (let i = 0; i < 7; i++) { const a = i * 0.9 + t * 0.3; c.beginPath(); c.ellipse(z.x + Math.cos(a) * z.r * 0.55, y + Math.sin(a) * z.r * 0.4, 7, 4, 0, 0, 7); c.fill(); } }
      } else {
        if (armed) {
          c.strokeStyle = '#4f8a3a'; c.lineWidth = 4; c.lineCap = 'round';
          for (let i = 0; i < 9; i++) { const a = (i / 9) * Math.PI * 2, rx = z.x + Math.cos(a) * z.r * 0.7, ry = y + Math.sin(a) * z.r * 0.5; c.beginPath(); c.moveTo(rx, ry); c.quadraticCurveTo(rx + 6, ry - 18, rx - 2, ry - 26 - k * 4); c.stroke(); }
        }
      }
      c.strokeStyle = z.kind === 'snare' && !armed ? `rgba(228,59,75,${0.5 + 0.5 * k})` : colorOf(z.owner); c.lineWidth = armed ? 3 : 5; c.setLineDash(armed ? [] : [9, 7]);
      c.beginPath(); c.ellipse(z.x, y, z.r, z.r * TILT, 0, 0, 7); c.stroke(); c.setLineDash([]);
    }
    for (const fb of m.bbuffs) {
      const b = m.buildings[fb.building], y = b.y * TILT;
      if (fb.kind === 'bulwark') {
        c.fillStyle = 'rgba(140,220,255,.16)'; c.strokeStyle = 'rgba(160,230,255,.85)'; c.lineWidth = 3;
        c.beginPath(); c.ellipse(b.x, y - 30, 66, 74, 0, Math.PI, Math.PI * 2); c.lineTo(b.x + 66, y); c.ellipse(b.x, y, 66, 66 * TILT * 0.55, 0, 0, Math.PI); c.closePath(); c.fill(); c.stroke();
      } else {
        const k = 0.5 + 0.5 * Math.sin(t * 14);
        c.fillStyle = `rgba(255,180,58,${0.25 + 0.25 * k})`; c.beginPath(); c.arc(b.x, y - buildingTop('tower', b.level) + 18, 22, 0, 7); c.fill();
      }
    }
  }

  /** Countdowns over objectives: drawbridge seconds, seed warning and hold time, crown on the bloom. */
  private drawObjectiveLabels(c: Ctx, f: Frame): void {
    const m = f.match, R = m.bal.tickRate, fs = Math.max(22, VIS.badgeMinPx / this.scale);
    c.font = `800 ${fs}px system-ui, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
    if (m.bridge) for (const g of m.map.obstacles.filter(o => o.kind === 'gate')) {
      const s = Math.max(0, Math.ceil((m.bridge.nextTick - m.tick) / R));
      this.pill(c, g.x, g.y * TILT - 58, `${m.bridge.open ? '🌉' : '⛔'} ${s}`, fs, m.bridge.open ? (m.bridge.warned ? '#d98a00' : 'rgba(16,38,26,.9)') : '#a3222f', '#fff', null);
    }
    const sd = m.gseed;
    if (sd) {
      const b = m.buildings[sd.site], y = b.y * TILT - buildingTop(b.type, b.level) - 46;
      const txt = sd.phase === 'warn' ? `🌰 ${Math.ceil((sd.atTick - m.tick) / R)}` : sd.holder >= 0 ? `🌰 ${Math.ceil((m.bal.seed.holdSec * R - sd.holdTicks) / R)}` : '🌰';
      this.pill(c, b.x, y, txt, fs * 1.1, '#ffd95a', '#7a5a10', null, '#3b2a05');
    }
    if (m.mode === 'control') {
      const b = m.buildings[m.sites[0]];
      this.pill(c, b.x, b.y * TILT - buildingTop(b.type, b.level) - (sd && sd.site === b.id ? 90 : 46), '👑', fs * 1.1, '#ffd95a', '#7a5a10', null, '#3b2a05');
    }
    for (const fb of m.pbuffs) for (const a of m.armies) if (a.owner === fb.player && a.state === 'moving') {
      c.strokeStyle = 'rgba(255,214,90,.8)'; c.lineWidth = 3; c.lineCap = 'round';
      const ang = this.aview.get(a.id)?.ang ?? 0;
      for (let i = -1; i <= 1; i++) { const bx = a.x - Math.cos(ang) * 30 - Math.sin(ang) * i * 10, by = (a.y - Math.sin(ang) * 30 + Math.cos(ang) * i * 10) * TILT - 12; c.beginPath(); c.moveTo(bx, by); c.lineTo(bx - Math.cos(ang) * 22, by - Math.sin(ang) * 22 * TILT); c.stroke(); }
    }
  }

  private drawOrderPaths(c: Ctx, f: Frame): void {
    const m = f.match, d = f.drag!, t = f.time;
    const target = d.target !== null ? m.buildings[d.target] : null;
    const col = !target ? 'rgba(255,255,255,.7)' : m.sameTeam(target.owner, f.human) ? '#9dffb9' : '#ffd08a';
    for (const id of d.sources) {
      if (id === d.target) continue;
      const b = m.buildings[id];
      const route = target ? m.routeFor(id, target.id, f.human).route : 0;
      const pts = target ? (route === 1 && m.closedPaths ? m.closedPaths : m.paths)[id][target.id].pts : [{ x: b.x, y: b.y }, { x: d.wx, y: d.wy }];
      for (const [lw, cl] of [[17, 'rgba(10,30,15,.5)'], [10, col]] as const) {
        c.strokeStyle = cl; c.lineWidth = lw; c.lineCap = 'round'; c.lineJoin = 'round';
        c.setLineDash(lw === 10 ? [20, 15] : []); c.lineDashOffset = -t * 80;
        c.beginPath(); pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y * TILT) : c.moveTo(p.x, p.y * TILT))); c.stroke();
      }
      c.setLineDash([]);
      c.strokeStyle = '#fff'; c.lineWidth = 6; c.beginPath(); c.ellipse(b.x, b.y * TILT, 60, 60 * TILT * 0.55, 0, 0, 7); c.stroke();
    }
    if (target) {
      const k = Math.sin(t * 8) * 4;
      c.strokeStyle = col; c.lineWidth = 8;
      c.beginPath(); c.ellipse(target.x, target.y * TILT, 68 + k, (68 + k) * TILT * 0.55, 0, 0, 7); c.stroke();
    }
  }

  /** While dragging: how many units each source sends, and what the order will do at the target. */
  private drawOrderLabels(c: Ctx, f: Frame): void {
    const m = f.match, d = f.drag!;
    const fs = Math.max(24, VIS.badgeMinPx / this.scale);
    c.font = `800 ${fs}px system-ui, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
    let total = 0, far = 0;
    const srcs = d.sources.filter(id => id !== d.target);
    if (d.target !== null) for (const id of srcs) far = Math.max(far, m.eta(id, d.target, f.human));
    for (const id of srcs) {
      const b = m.buildings[id], n = m.sendCount(b, f.pct); total += n;
      // with a synchronized order, nearer buildings show how long they will wait before leaving
      const wait = f.sync && d.target !== null && srcs.length > 1 ? far - m.eta(id, d.target, f.human) : 0;
      this.pill(c, b.x, b.y * TILT - buildingTop(b.type, b.level) - 34, wait > 0.25 ? `→ ${n} · +${wait.toFixed(1)}${f.labels.sec}` : '→ ' + n, fs, '#fff', '#143d22', null, '#143d22');
    }
    if (d.target === null) return;
    const tb = m.buildings[d.target], friendly = m.sameTeam(tb.owner, f.human);
    const wins = !friendly && m.predict(f.human, tb, total) > 0;
    const text = `${friendly ? f.labels.reinforce : wins ? f.labels.capture : f.labels.attack} ${total} · ${far.toFixed(1)}${f.labels.sec}`;
    c.font = `900 ${fs * 1.1}px system-ui, sans-serif`;
    this.pill(c, tb.x, tb.y * TILT - buildingTop(tb.type, tb.level) - 40, text, fs * 1.1,
      friendly ? '#1f8f4a' : wins ? '#d98a00' : '#c23a34', '#fff', null);
  }
}

export { colorOf, darkOf };
