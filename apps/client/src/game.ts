import { AIController, BALANCE, MAPS, Match, type Building, type BuildingType, type Difficulty, type Pct } from '../../../packages/simulation/src/index';
import { Renderer, colorOf, type BoxState, type DragState } from './render/renderer';
import { TILT } from './render/art';
import { sfx, unlockAudio } from './audio/sfx';
import { t } from './ui/i18n';

export interface SessionOpts { mapIndex: number; opponents: number; difficulty: Difficulty; seed: number }
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ICON: Record<BuildingType, string> = { farm: '🥦', tower: '🗼', forge: '☀️' };

/** One running match: fixed-step simulation, AI, touch input, HUD and rendering glue. */
export class Session {
  readonly match: Match;
  readonly human = 0;
  readonly renderer: Renderer;
  selection = new Set<number>();
  pct: Pct = 50;
  paused = false;
  private ais: AIController[] = [];
  private drag: DragState | null = null;
  private box: BoxState | null = null;
  private raf = 0; private acc = 0; private lastT = 0; private time = 0;
  private finished = false; private disposed = false;
  private ptr: { id: number; x0: number; y0: number; down: number | null; moved: boolean; long: boolean; timer: number } | null = null;
  private cache = new Map<string, string>();
  private canvas = $<HTMLCanvasElement>('cv');
  private cleanup: (() => void)[] = [];
  stepsRun = 0;

  constructor(readonly opts: SessionOpts, private onEnd: (m: Match) => void) {
    const map = MAPS[opts.mapIndex];
    const players = [{ slot: 0, team: 0, isAI: false }];
    for (let i = 1; i <= Math.min(opts.opponents, map.slots - 1); i++) players.push({ slot: i, team: i, isAI: true });
    this.match = new Match({ map, balance: BALANCE, seed: opts.seed, players });
    for (let i = 1; i < players.length; i++) this.ais.push(new AIController(i, opts.difficulty, opts.seed));
    this.renderer = new Renderer(this.canvas, $('stage'));
    this.bind();
    this.buildHud();
    this.renderer.resize(this.match);
    this.raf = requestAnimationFrame(this.frame);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.cleanup.forEach(f => f());
    if (this.ptr) clearTimeout(this.ptr.timer);
  }

  // ---------- loop ----------
  private frame = (ts: number): void => {
    if (this.disposed) return;
    const dt = Math.min(0.25, this.lastT ? (ts - this.lastT) / 1000 : 0);
    this.lastT = ts;
    const m = this.match, step = 1 / m.bal.tickRate;
    const blocked = this.paused || matchMedia('(orientation: portrait) and (max-width: 820px)').matches;
    if (!blocked && m.phase === 'playing') {
      this.acc += dt; this.time += dt;
      while (this.acc >= step) {
        for (const ai of this.ais) ai.update(m);
        m.step(); this.stepsRun++;
        this.react();
        this.acc -= step;
      }
    } else if (m.phase === 'ended') this.time += dt;
    for (const id of this.selection) if (m.buildings[id].owner !== this.human) this.selection.delete(id);
    if (this.drag) this.drag.sources = this.drag.sources.filter(id => m.buildings[id].owner === this.human);
    if (this.drag && this.drag.sources.length === 0) this.drag = null;
    this.renderer.draw({
      match: m, alpha: m.phase === 'playing' && !blocked ? this.acc / step : 1, time: this.time, human: this.human,
      pct: this.pct, selection: this.selection, drag: this.drag, box: this.box,
    });
    this.updateHud();
    if (m.phase === 'ended' && !this.finished) {
      this.finished = true;
      this.drag = null; this.box = null; this.selection.clear();
      (m.winnerTeam === m.players[this.human].team ? sfx.win : sfx.lose)();
      setTimeout(() => { if (!this.disposed) this.onEnd(m); }, 1300);
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  private react(): void {
    const m = this.match;
    this.renderer.onEvents(m, m.events);
    for (const e of m.events) {
      if (e.type === 'capture') { if (e.by === this.human) sfx.capture(); else if (e.from === this.human) sfx.lost(); }
      else if (e.type === 'shot') sfx.shot();
      else if (e.type === 'hit') sfx.hit();
      else if (e.type === 'launch' && e.owner === this.human) sfx.launch();
      else if ((e.type === 'upgraded' || e.type === 'converted') && m.buildings[e.building].owner === this.human) sfx.upgrade();
    }
  }

  // ---------- input ----------
  private pick(sx: number, sy: number): Building | null {
    const r = this.renderer, lim = Math.max(30, 58 * r.scale);
    let best: Building | null = null, bd = lim;
    for (const b of this.match.buildings) {
      const p = r.toScreen(b.x, b.y);
      const d = Math.hypot(p.x - sx, p.y - 26 * r.scale - sy);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  private send(from: number[], to: number): void {
    const list = from.filter(id => id !== to);
    if (list.length === 0) return;
    this.match.enqueue({ type: 'send', player: this.human, from: list, to, pct: this.pct });
    sfx.send();
    $('hint').classList.add('hidden');
  }

  private bind(): void {
    const cv = this.canvas;
    const pos = (e: PointerEvent) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const live = () => !this.paused && this.match.phase === 'playing';
    const down = (e: PointerEvent) => {
      e.preventDefault(); unlockAudio();
      if (!live() || this.ptr) return;
      const p = pos(e), b = this.pick(p.x, p.y);
      try { cv.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      const st = { id: e.pointerId, x0: p.x, y0: p.y, down: b ? b.id : null, moved: false, long: false, timer: 0 };
      if (b && b.owner === this.human) {
        st.timer = window.setTimeout(() => {
          if (this.ptr === st && !st.moved) { st.long = true; this.selection.add(b.id); sfx.tap(); navigator.vibrate?.(15); }
        }, 380);
      }
      this.ptr = st;
    };
    const move = (e: PointerEvent) => {
      const st = this.ptr; if (!st || st.id !== e.pointerId) return;
      e.preventDefault();
      const p = pos(e);
      if (!st.moved && Math.hypot(p.x - st.x0, p.y - st.y0) > 10) { st.moved = true; clearTimeout(st.timer); }
      if (!st.moved || !live()) return;
      const own = st.down !== null && this.match.buildings[st.down].owner === this.human;
      if (own) {
        const sources = [...new Set([...this.selection, st.down!])];
        const hit = this.pick(p.x, p.y);
        const w = this.renderer.toWorld(p.x, p.y);
        const target = hit && !(sources.length === 1 && hit.id === sources[0]) ? hit.id : null;
        this.drag = { sources, target, wx: w.x, wy: w.y };
      } else if (st.down === null) this.box = { x0: st.x0, y0: st.y0, x1: p.x, y1: p.y };
    };
    const up = (e: PointerEvent) => {
      const st = this.ptr; if (!st || st.id !== e.pointerId) return;
      e.preventDefault();
      clearTimeout(st.timer); this.ptr = null;
      const m = this.match;
      if (!live()) { this.drag = null; this.box = null; return; }
      if (this.drag) {
        if (this.drag.target !== null) { this.send(this.drag.sources, this.drag.target); this.selection.clear(); }
        this.drag = null; return;
      }
      if (this.box) {
        const bx = this.box; this.box = null; this.selection.clear();
        for (const b of m.buildings) {
          if (b.owner !== this.human) continue;
          const p = this.renderer.toScreen(b.x, b.y);
          if (p.x >= Math.min(bx.x0, bx.x1) && p.x <= Math.max(bx.x0, bx.x1) && p.y >= Math.min(bx.y0, bx.y1) && p.y <= Math.max(bx.y0, bx.y1)) this.selection.add(b.id);
        }
        return;
      }
      if (st.moved || st.long) return;
      if (st.down === null) { this.selection.clear(); return; }
      const b = m.buildings[st.down];
      if (this.selection.size > 0 && !this.selection.has(b.id)) { this.send([...this.selection], b.id); this.selection.clear(); }
      else if (b.owner !== this.human) sfx.deny();
      else if (this.selection.has(b.id)) { this.selection.delete(b.id); sfx.tap(); }
      else { this.selection.add(b.id); sfx.tap(); }
    };
    const cancel = (e: PointerEvent) => {
      if (this.ptr && this.ptr.id === e.pointerId) { clearTimeout(this.ptr.timer); this.ptr = null; this.drag = null; this.box = null; }
    };
    const resize = () => this.renderer.resize(this.match);
    const noMenu = (e: Event) => e.preventDefault();
    cv.addEventListener('pointerdown', down); cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', cancel);
    cv.addEventListener('contextmenu', noMenu);
    window.addEventListener('resize', resize); window.addEventListener('orientationchange', resize);
    const ro = new ResizeObserver(resize); ro.observe($('stage'));
    this.cleanup.push(() => {
      cv.removeEventListener('pointerdown', down); cv.removeEventListener('pointermove', move);
      cv.removeEventListener('pointerup', up); cv.removeEventListener('pointercancel', cancel);
      cv.removeEventListener('contextmenu', noMenu);
      window.removeEventListener('resize', resize); window.removeEventListener('orientationchange', resize); ro.disconnect();
    });
  }

  // ---------- HUD ----------
  private buildHud(): void {
    const left = $('pcts'); left.innerHTML = '';
    for (const p of [100, 75, 50, 25] as Pct[]) {
      const b = document.createElement('button'); b.className = 'pct'; b.dataset.pct = String(p); b.textContent = p + '%';
      b.onclick = () => { this.pct = p; sfx.tap(); unlockAudio(); };
      left.appendChild(b);
    }
    $('btnAll').onclick = () => {
      const mine = this.match.buildings.filter(b => b.owner === this.human);
      const all = mine.every(b => this.selection.has(b.id));
      this.selection.clear(); if (!all) mine.forEach(b => this.selection.add(b.id));
      sfx.tap();
    };
    const acts = $('acts'); acts.innerHTML = '';
    for (const kind of ['upgrade', 'farm', 'tower', 'forge'] as const) {
      const b = document.createElement('button'); b.className = 'act hidden'; b.id = 'act-' + kind;
      b.onclick = () => {
        const id = [...this.selection][0]; if (id === undefined) return;
        if (kind === 'upgrade') this.match.enqueue({ type: 'upgrade', player: this.human, building: id });
        else this.match.enqueue({ type: 'convert', player: this.human, building: id, to: kind });
        sfx.tap();
      };
      acts.appendChild(b);
    }
    $('morale').innerHTML = '<span>🍃</span>'.repeat(BALANCE.morale.max);
    $('hint').textContent = t('hint'); $('hint').classList.remove('hidden');
    setTimeout(() => $('hint').classList.add('hidden'), 12000);
  }

  private set(id: string, v: string, html = false): void {
    if (this.cache.get(id) === v) return;
    this.cache.set(id, v);
    if (html) $(id).innerHTML = v; else $(id).textContent = v;
  }

  private updateHud(): void {
    const m = this.match, me = m.players[this.human];
    const leaves = $('morale').children;
    for (let i = 0; i < leaves.length; i++) {
      const o = String(Math.max(0.18, Math.min(1, me.morale - i)).toFixed(1));
      const el = leaves[i] as HTMLElement; if (el.style.opacity !== o) el.style.opacity = o;
    }
    this.set('units', '🥦 ' + m.totalUnits(this.human));
    this.set('income', '+' + m.income(this.human).toFixed(1) + '/s');
    const fc = m.forgeCount(this.human);
    this.set('forgeStat', fc ? `☀️ +${Math.round(fc * m.bal.forge.attackBonus * 100)}%` : '');
    const sec = Math.floor(m.tick / m.bal.tickRate);
    this.set('clock', `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`);
    this.set('foes', m.players.map(p =>
      `<span class="chip${p.alive ? '' : ' dead'}" style="--c:${colorOf(p.id)}">${m.buildingCount(p.id)}</span>`).join(''), true);
    document.querySelectorAll<HTMLElement>('.pct').forEach(b => b.classList.toggle('on', Number(b.dataset.pct) === this.pct));

    const one = this.selection.size === 1 ? m.buildings[[...this.selection][0]] : null;
    const label = (id: string, show: boolean, text: string, ok: boolean) => {
      const el = $<HTMLButtonElement>(id);
      el.classList.toggle('hidden', !show);
      if (!show) return;
      this.set(id, text, true); el.disabled = !ok;
    };
    const cost = one ? m.upgradeCost(one) : null;
    label('act-upgrade', !!one && cost !== null, `<b>⬆️</b><i>${t('upgrade')}</i><u>${cost}</u>`, !!one && m.canUpgrade(one));
    for (const k of ['farm', 'tower', 'forge'] as const) {
      label('act-' + k, !!one && one.type !== k, `<b>${ICON[k]}</b><i>${t(k)}</i><u>${m.bal.convert.cost}</u>`, !!one && m.canConvert(one, k));
    }
  }

  /** Test hook: where a building sits on screen. */
  screenOf(id: number): { x: number; y: number } {
    const b = this.match.buildings[id], p = this.renderer.toScreen(b.x, b.y), r = this.canvas.getBoundingClientRect();
    return { x: p.x + r.left, y: p.y - 26 * this.renderer.scale + r.top };
  }
}

export { TILT };
