import { Rng, type Match, type SimEvent, type Vec } from '../../../../packages/simulation/src/index';
import { TILT, buildingTop, colorOf, darkOf, drawBuilding, drawPond, drawRock, drawTree, makeUnitSprites, shadow } from './art';

export interface DragState { sources: number[]; target: number | null; wx: number; wy: number }
export interface BoxState { x0: number; y0: number; x1: number; y1: number }
export interface Frame {
  match: Match; alpha: number; time: number; human: number; pct: number;
  selection: Set<number>; drag: DragState | null; box: BoxState | null;
}
interface Particle { x: number; y: number; vx: number; vy: number; g: number; life: number; max: number; size: number; color: string }
interface Shot { x0: number; y0: number; x1: number; y1: number; t: number }
interface Pop { x: number; y: number; t: number; text: string; color: string }

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private bg = document.createElement('canvas');
  private sprites = makeUnitSprites(3);
  private particles: Particle[] = [];
  private shots: Shot[] = [];
  private pops: Pop[] = [];
  private last = 0;
  scale = 1; ox = 0; oy = 0; dpr = 1;
  frameMs = 0; // smoothed frame time, exposed for the perf readout and tests

  constructor(private canvas: HTMLCanvasElement, private stage: HTMLElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  toWorld(sx: number, sy: number): Vec { return { x: (sx - this.ox) / this.scale, y: (sy - this.oy) / (this.scale * TILT) }; }
  toScreen(x: number, y: number): Vec { return { x: this.ox + x * this.scale, y: this.oy + y * TILT * this.scale }; }

  resize(match: Match): void {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * this.dpr); this.canvas.height = Math.round(h * this.dpr);
    const s = this.stage.getBoundingClientRect(), c = this.canvas.getBoundingClientRect();
    const mw = match.map.width, mh = match.map.height * TILT;
    this.scale = Math.min(s.width / mw, s.height / mh);
    this.ox = s.left - c.left + (s.width - mw * this.scale) / 2;
    this.oy = s.top - c.top + (s.height - mh * this.scale) / 2;
    this.paintBackground(match);
  }

  private world(c: CanvasRenderingContext2D): void {
    const k = this.dpr * this.scale;
    c.setTransform(k, 0, 0, k, this.dpr * this.ox, this.dpr * this.oy);
  }

  private paintBackground(match: Match): void {
    const map = match.map, forest = map.biome === 'forest';
    this.bg.width = this.canvas.width; this.bg.height = this.canvas.height;
    const c = this.bg.getContext('2d')!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    const g = c.createLinearGradient(0, 0, 0, this.bg.height);
    g.addColorStop(0, forest ? '#3f8a45' : '#7cc95a'); g.addColorStop(1, forest ? '#2c6b3a' : '#59ad4a');
    c.fillStyle = g; c.fillRect(0, 0, this.bg.width, this.bg.height);
    this.world(c);
    const rng = new Rng(map.id.length * 977 + map.buildings.length);
    const W = map.width, H = map.height;
    const X = () => rng.range(-700, W + 700), Y = () => rng.range(-400, H + 400);
    for (let i = 0; i < 170; i++) {
      c.fillStyle = rng.next() < 0.5 ? 'rgba(255,255,170,.07)' : 'rgba(0,60,20,.08)';
      c.beginPath(); c.ellipse(X(), Y() * TILT, rng.range(40, 150), rng.range(16, 55), 0, 0, 7); c.fill();
    }
    c.fillStyle = 'rgba(255,255,200,.10)';
    c.beginPath(); c.ellipse(W / 2, (H / 2) * TILT, W * 0.56, H * 0.56 * TILT, 0, 0, 7); c.fill();
    const blocked = (x: number, y: number, pad: number) =>
      map.obstacles.some(o => Math.hypot(o.x - x, o.y - y) < o.r + pad) || map.buildings.some(b => Math.hypot(b.x - x, b.y - y) < 55 + pad);
    c.lineCap = 'round';
    for (let i = 0; i < 520; i++) {
      const x = X(), y = Y(); if (blocked(x, y, 6)) continue;
      c.strokeStyle = rng.next() < 0.5 ? 'rgba(20,90,35,.5)' : 'rgba(190,235,130,.5)'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(x - 4, y * TILT); c.lineTo(x - 6, y * TILT - 8); c.moveTo(x, y * TILT); c.lineTo(x, y * TILT - 11); c.moveTo(x + 4, y * TILT); c.lineTo(x + 7, y * TILT - 7); c.stroke();
    }
    const petals = forest ? ['#f4e9ff', '#ffd66b', '#ff9a6b'] : ['#ffffff', '#ffe36b', '#ff9ec4'];
    for (let i = 0; i < 150; i++) {
      const x = X(), y = Y(); if (blocked(x, y, 4)) continue;
      c.fillStyle = petals[rng.int(3)];
      for (let k = 0; k < 5; k++) { c.beginPath(); c.arc(x + Math.cos(k * 1.257) * 3.2, y * TILT + Math.sin(k * 1.257) * 2.6, 2.3, 0, 7); c.fill(); }
      c.fillStyle = '#e8a52a'; c.beginPath(); c.arc(x, y * TILT, 1.8, 0, 7); c.fill();
    }
    for (const o of map.obstacles) if (o.kind === 'pond') drawPond(c, o.x, o.y, o.r);
    for (const o of map.obstacles) if (o.kind !== 'pond') drawRock(c, o.x, o.y, o.r);
    const trees: [number, number, number][] = [];
    for (let i = 0; i < (forest ? 260 : 150); i++) {
      const x = X(), y = Y();
      if (x > 70 && x < W - 70 && y > 40 && y < H - 30) continue; // keep the battlefield clear
      trees.push([x, y, rng.range(0.9, 1.5)]);
    }
    trees.sort((a, b) => a[1] - b[1]);
    for (const [x, y, s] of trees) drawTree(c, x, y * TILT, s, forest);
  }

  /** Turn simulation events into particles, shots and floating labels. */
  onEvents(match: Match, events: SimEvent[]): void {
    for (const e of events) {
      if (e.type === 'shot') {
        const b = match.buildings[e.tower];
        this.shots.push({ x0: b.x, y0: b.y * TILT - buildingTop('tower', b.level) + 14, x1: e.x, y1: e.y * TILT - 8, t: 0 });
      } else if (e.type === 'capture') {
        const b = match.buildings[e.building];
        this.burst(b.x, b.y * TILT - 30, colorOf(e.by), 26, 150);
        this.burst(b.x, b.y * TILT - 30, '#ffffff', 10, 90);
        this.pops.push({ x: b.x, y: b.y * TILT - 110, t: 0, text: '⚑', color: colorOf(e.by) });
      } else if (e.type === 'hit') {
        const b = match.buildings[e.building];
        this.burst(b.x, b.y * TILT - 12, e.held ? '#e9dcae' : colorOf(e.by), 5, 70);
      } else if (e.type === 'upgraded' || e.type === 'converted') {
        const b = match.buildings[e.building];
        this.burst(b.x, b.y * TILT - 50, '#ffe36b', 18, 110, -40);
        this.pops.push({ x: b.x, y: b.y * TILT - 120, t: 0, text: e.type === 'upgraded' ? '▲' : '✦', color: '#ffe36b' });
      }
    }
  }

  private burst(x: number, y: number, color: string, n: number, speed: number, lift = 0): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random() * 0.6);
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.6 - 60 + lift, g: 260, life: 0, max: 0.45 + Math.random() * 0.35, size: 3 + Math.random() * 4, color });
    }
    if (this.particles.length > 600) this.particles.splice(0, this.particles.length - 600);
  }

  draw(f: Frame): void {
    const now = performance.now();
    const dt = Math.min(0.05, this.last ? (now - this.last) / 1000 : 0.016);
    if (this.last) this.frameMs = this.frameMs * 0.95 + (now - this.last) * 0.05;
    this.last = now;
    const c = this.ctx, m = f.match, t = f.time;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(this.bg, 0, 0);
    this.world(c);

    // ground markers: selection, tower range
    for (const b of m.buildings) {
      const y = b.y * TILT;
      if (f.selection.has(b.id)) {
        if (b.type === 'tower') {
          const r = m.towerRange(b);
          c.fillStyle = 'rgba(255,255,255,.07)'; c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = 2; c.setLineDash([10, 8]);
          c.beginPath(); c.ellipse(b.x, y, r, r * TILT, 0, 0, 7); c.fill(); c.stroke(); c.setLineDash([]);
        }
        c.strokeStyle = '#fff'; c.lineWidth = 5; c.setLineDash([14, 9]); c.lineDashOffset = -t * 40;
        c.beginPath(); c.ellipse(b.x, y, 62, 62 * TILT * 0.55, 0, 0, 7); c.stroke(); c.setLineDash([]);
      }
    }
    if (f.drag) this.drawOrders(c, f);

    // depth-sorted buildings and soldiers
    type Item = { y: number; b?: number; w?: number };
    const items: Item[] = m.buildings.map(b => ({ y: b.y, b: b.id }));
    m.waves.forEach((w, i) => items.push({ y: w.py + (w.y - w.py) * f.alpha, w: i }));
    items.sort((a, b) => a.y - b.y);
    for (const it of items) {
      if (it.b !== undefined) {
        const b = m.buildings[it.b];
        c.save(); c.translate(b.x, b.y * TILT);
        if (b.busyKind) c.globalAlpha = 0.72 + 0.2 * Math.sin(t * 9);
        drawBuilding(c, b.type, b.level, b.owner, t);
        c.restore();
      } else this.drawWave(c, m, it.w!, f.alpha, t);
    }

    // tower shots
    for (const s of this.shots) {
      s.t += dt / 0.16;
      const k = Math.min(1, s.t), x = s.x0 + (s.x1 - s.x0) * k, y = s.y0 + (s.y1 - s.y0) * k - Math.sin(k * Math.PI) * 18;
      const a = Math.atan2(s.y1 - s.y0, s.x1 - s.x0);
      c.save(); c.translate(x, y); c.rotate(a);
      c.fillStyle = '#f4ecc4'; c.strokeStyle = '#6d6335'; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(9, 0); c.lineTo(-7, -4); c.lineTo(-4, 0); c.lineTo(-7, 4); c.closePath(); c.fill(); c.stroke();
      c.restore();
      if (s.t >= 1) this.burst(s.x1, s.y1, '#f4ecc4', 4, 60);
    }
    this.shots = this.shots.filter(s => s.t < 1);

    // particles
    for (const p of this.particles) {
      p.life += dt; p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      const k = 1 - p.life / p.max; if (k <= 0) continue;
      c.globalAlpha = k; c.fillStyle = p.color; c.beginPath(); c.arc(p.x, p.y, p.size * (0.5 + k * 0.5), 0, 7); c.fill();
    }
    c.globalAlpha = 1;
    this.particles = this.particles.filter(p => p.life < p.max);

    // garrison labels
    const fs = Math.max(27, 13.5 / this.scale);
    c.font = `800 ${fs}px system-ui, -apple-system, "Segoe UI", sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
    for (const b of m.buildings) {
      const txt = String(Math.floor(b.garrison)), y = b.y * TILT + 24 + fs * 0.35;
      const tw = c.measureText(txt).width, pw = tw + fs * 1.5, ph = fs * 1.25, x0 = b.x - pw / 2;
      c.fillStyle = 'rgba(16,28,18,.82)'; c.strokeStyle = colorOf(b.owner); c.lineWidth = Math.max(3, fs * 0.11);
      c.beginPath(); c.roundRect(x0, y - ph / 2, pw, ph, ph / 2); c.fill(); c.stroke();
      this.emblem(c, x0 + fs * 0.55, y, fs * 0.26, b.owner);
      c.fillStyle = '#fff'; c.fillText(txt, b.x + fs * 0.28, y + fs * 0.04);
      const max = m.maxLevel(b);
      if (max > 1) for (let i = 0; i < max; i++) {
        c.fillStyle = i < b.level ? '#ffe36b' : 'rgba(255,255,255,.28)';
        c.beginPath(); c.arc(b.x + (i - (max - 1) / 2) * fs * 0.4, y + ph / 2 + fs * 0.24, fs * 0.13, 0, 7); c.fill();
      }
      if (b.busyKind) {
        const k = (m.tick + f.alpha - b.busyStart) / (b.busyEnd - b.busyStart), yy = b.y * TILT - buildingTop(b.type, b.level) - 22;
        c.lineWidth = 7; c.strokeStyle = 'rgba(0,0,0,.45)'; c.beginPath(); c.arc(b.x, yy, 15, 0, 7); c.stroke();
        c.strokeStyle = '#ffe36b'; c.beginPath(); c.arc(b.x, yy, 15, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, Math.min(1, k))); c.stroke();
      }
    }
    for (const p of this.pops) {
      p.t += dt;
      c.globalAlpha = Math.max(0, 1 - p.t / 0.9); c.fillStyle = p.color; c.strokeStyle = 'rgba(0,0,0,.6)'; c.lineWidth = 4;
      c.font = `900 ${fs * 1.5}px system-ui, sans-serif`;
      c.strokeText(p.text, p.x, p.y - p.t * 50); c.fillText(p.text, p.x, p.y - p.t * 50);
    }
    c.globalAlpha = 1;
    this.pops = this.pops.filter(p => p.t < 0.9);

    if (f.box) {
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const x = Math.min(f.box.x0, f.box.x1), y = Math.min(f.box.y0, f.box.y1);
      c.fillStyle = 'rgba(255,255,255,.14)'; c.strokeStyle = '#fff'; c.lineWidth = 2; c.setLineDash([6, 5]);
      c.fillRect(x, y, Math.abs(f.box.x1 - f.box.x0), Math.abs(f.box.y1 - f.box.y0));
      c.strokeRect(x, y, Math.abs(f.box.x1 - f.box.x0), Math.abs(f.box.y1 - f.box.y0)); c.setLineDash([]);
    }
  }

  /** Colour-blind aid: every owner also has its own shape. */
  private emblem(c: CanvasRenderingContext2D, x: number, y: number, r: number, owner: number): void {
    c.fillStyle = colorOf(owner); c.beginPath();
    if (owner < 0) c.arc(x, y, r * 0.6, 0, 7);
    else if (owner % 4 === 0) c.arc(x, y, r, 0, 7);
    else if (owner % 4 === 1) { c.moveTo(x, y - r * 1.1); c.lineTo(x + r * 1.1, y + r * 0.9); c.lineTo(x - r * 1.1, y + r * 0.9); }
    else if (owner % 4 === 2) c.rect(x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8);
    else { c.moveTo(x, y - r * 1.25); c.lineTo(x + r * 1.1, y); c.lineTo(x, y + r * 1.25); c.lineTo(x - r * 1.1, y); }
    c.closePath(); c.fill();
  }

  private drawWave(c: CanvasRenderingContext2D, m: Match, i: number, alpha: number, t: number): void {
    const w = m.waves[i];
    const x = w.px + (w.x - w.px) * alpha, y = w.py + (w.y - w.py) * alpha;
    let dx = w.x - w.px, dy = w.y - w.py;
    if (dx === 0 && dy === 0) { const p = m.paths[w.from][w.to].pts; dx = p[1].x - p[0].x; dy = p[1].y - p[0].y; }
    const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const frames = this.sprites[w.owner % 4];
    const order: { x: number; y: number; k: number }[] = [];
    for (let k = 0; k < w.units; k++) {
      const row = Math.floor(k / 4), cols = Math.min(4, w.units - row * 4), across = ((k % 4) - (cols - 1) / 2) * 13, along = -row * 12;
      order.push({ x: x + dx * along - dy * across, y: y + dy * along + dx * across, k });
    }
    order.sort((a, b) => a.y - b.y);
    for (const u of order) {
      const py = u.y * TILT, hop = Math.abs(Math.sin(t * 11 + u.k * 1.7 + w.id)) * 3;
      shadow(c, u.x, py + 1, 8, 3.5, 0.25);
      const img = frames[Math.floor(t * 9 + u.k + w.id) % 2];
      if (dx < -0.05) { c.save(); c.translate(u.x, 0); c.scale(-1, 1); c.drawImage(img, -13, py - 27 - hop, 26, 30); c.restore(); }
      else c.drawImage(img, u.x - 13, py - 27 - hop, 26, 30);
    }
  }

  private drawOrders(c: CanvasRenderingContext2D, f: Frame): void {
    const m = f.match, d = f.drag!, t = f.time;
    const target = d.target !== null ? m.buildings[d.target] : null;
    const fs = Math.max(24, 12 / this.scale);
    for (const id of d.sources) {
      if (id === d.target) continue;
      const b = m.buildings[id];
      const pts = target ? m.paths[id][target.id].pts : [{ x: b.x, y: b.y }, { x: d.wx, y: d.wy }];
      for (const [lw, col] of [[15, 'rgba(10,30,15,.45)'], [9, target ? '#fff' : 'rgba(255,255,255,.6)']] as const) {
        c.strokeStyle = col; c.lineWidth = lw; c.lineCap = 'round'; c.lineJoin = 'round';
        c.setLineDash(lw === 9 ? [18, 14] : []); c.lineDashOffset = -t * 70;
        c.beginPath(); pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y * TILT) : c.moveTo(p.x, p.y * TILT))); c.stroke();
      }
      c.setLineDash([]);
      const n = m.sendCount(b, f.pct);
      c.font = `800 ${fs}px system-ui, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
      const yy = b.y * TILT - buildingTop(b.type, b.level) - 30, tw = c.measureText('→ ' + n).width + fs;
      c.fillStyle = '#fff'; c.beginPath(); c.roundRect(b.x - tw / 2, yy - fs * 0.65, tw, fs * 1.3, fs * 0.65); c.fill();
      c.fillStyle = '#143d22'; c.fillText('→ ' + n, b.x, yy + 1);
    }
    if (target) {
      const friendly = target.owner === f.human;
      c.strokeStyle = friendly ? '#8dffb0' : '#ff7a6b'; c.lineWidth = 7;
      c.beginPath(); c.ellipse(target.x, target.y * TILT, 66 + Math.sin(t * 8) * 4, (66 + Math.sin(t * 8) * 4) * TILT * 0.55, 0, 0, 7); c.stroke();
    }
  }
}

export { colorOf, darkOf };
