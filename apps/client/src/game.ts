import { AIController, BALANCE, MAPS, Match, type Building, type BuildingType, type Difficulty, type Pct } from '../../../packages/simulation/src/index';
import { Renderer, colorOf, type BoxState, type DragState } from './render/renderer';
import { VIS } from './render/config';
import { sfx, unlockAudio } from './audio/sfx';
import { t } from './ui/i18n';

export interface SessionOpts { mapIndex: number; opponents: number; difficulty: Difficulty; seed: number; lowFx: boolean }
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ICON: Record<BuildingType, string> = { farm: '🥦', tower: '🗼', forge: '☀️' };
const MAX_DT = 0.1; // a long frame (tab switch, Safari in background) never advances the match by more than this

/** One running match: fixed-step simulation, AI, touch input, HUD and rendering glue. */
export class Session {
  readonly match: Match;
  readonly human = 0;
  readonly renderer: Renderer;
  readonly ais: AIController[] = [];
  selection = new Set<number>();
  pct: Pct = 50;
  autoLow = false;
  /** Test/dev hooks: let an AI play the human seat, and run several simulation steps per frame. */
  autopilot: AIController | null = null;
  speed = 1;
  stepsRun = 0;
  private _paused = false;
  private drag: DragState | null = null;
  private box: BoxState | null = null;
  private raf = 0; private acc = 0; private lastT = 0; private time = 0; private slowFor = 0;
  private finished = false; private disposed = false; private ordered = false;
  private ptr: { id: number; x0: number; y0: number; down: number | null; moved: boolean; long: boolean; timer: number } | null = null;
  private cache = new Map<string, string>();
  private canvas = $<HTMLCanvasElement>('cv');
  private cleanup: (() => void)[] = [];
  private alerted = new Set<number>(); private lastAlert = -99; private lastHitSfx = 0; private toastTimer = 0;
  private debug = location.hash === '#debug';

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

  get paused(): boolean { return this._paused; }
  set paused(v: boolean) { this._paused = v; this.lastT = 0; this.cancelPointer(); }   // resuming never replays the paused time
  get lowFx(): boolean { return this.opts.lowFx || this.autoLow; }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.cleanup.forEach(f => f());
    clearTimeout(this.toastTimer);
    if (this.ptr) clearTimeout(this.ptr.timer);
    $('debug').classList.add('hidden');
  }

  // ---------- loop ----------
  private frame = (ts: number): void => {
    if (this.disposed) return;
    const dt = Math.min(MAX_DT, this.lastT ? (ts - this.lastT) / 1000 : 0);
    this.lastT = ts;
    const m = this.match, step = 1 / m.bal.tickRate;
    const blocked = this._paused || matchMedia('(orientation: portrait) and (max-width: 820px)').matches;
    if (!blocked && m.phase === 'playing') {
      this.acc += dt * this.speed; this.time += dt;
      while (this.acc >= step && m.phase === 'playing') {
        for (const ai of this.ais) ai.update(m);
        this.autopilot?.update(m);
        m.step(); this.stepsRun++;
        this.react();
        this.acc -= step;
      }
    } else if (m.phase === 'ended') this.time += dt;
    for (const id of this.selection) if (m.buildings[id].owner !== this.human) this.selection.delete(id);
    if (this.drag) this.drag.sources = this.drag.sources.filter(id => m.buildings[id].owner === this.human);
    if (this.drag && this.drag.sources.length === 0) this.drag = null;
    this.renderer.draw({
      match: m, alpha: m.phase === 'playing' && !blocked ? Math.min(1, this.acc / step) : 1, time: this.time, human: this.human,
      pct: this.pct, selection: this.selection, drag: this.drag, box: this.box, lowFx: this.lowFx,
      labels: { attack: t('lblAttack'), reinforce: t('lblReinforce'), capture: t('lblCapture') },
    });
    // weak device: if frames stay slow for 3 seconds, drop to reduced effects (fewer sprites and particles)
    if (!this.lowFx && !blocked) {
      this.slowFor = this.renderer.frameMs > VIS.autoLowFxFrameMs ? this.slowFor + dt : 0;
      if (this.slowFor > 3) this.autoLow = true;
    }
    this.updateHud();
    if (m.phase === 'ended' && !this.finished) {
      this.finished = true;
      this.drag = null; this.box = null; this.selection.clear();
      (m.winnerTeam === m.players[this.human].team ? sfx.win : sfx.lose)();
      setTimeout(() => { if (!this.disposed) this.onEnd(m); }, 1300);
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  /** Sound and messages for what just happened in the simulation. */
  private react(): void {
    const m = this.match;
    this.renderer.onEvents(m, m.events);
    for (const e of m.events) {
      if (e.type === 'building_captured') { if (e.by === this.human) sfx.capture(); else if (e.from === this.human) sfx.lost(); }
      else if (e.type === 'tower_fired') sfx.shot();
      else if (e.type === 'battle_hit') { if (this.time - this.lastHitSfx > 0.09) { this.lastHitSfx = this.time; sfx.hit(); } }
      else if (e.type === 'battle_resolved' && !e.captured && e.survivors === 0 && m.buildings[e.building].owner === this.human) sfx.defended();
      else if ((e.type === 'upgraded' || e.type === 'converted') && m.buildings[e.building].owner === this.human) sfx.upgrade();
      else if (e.type === 'order_rejected' && e.player === this.human && !this.autopilot) this.toast(t(e.reason === 'empty' ? 'msgEmpty' : e.reason === 'cooldown' ? 'msgCooldown' : 'msgNotYours'));
    }
    // one alert per newly threatened building, never more often than every few seconds
    const now = new Set<number>();
    for (const a of m.armies) { const b = m.buildings[a.to]; if (b.owner === this.human && !m.sameTeam(a.owner, this.human)) now.add(b.id); }
    for (const id of now) if (!this.alerted.has(id) && this.time - this.lastAlert > 4) { this.lastAlert = this.time; sfx.alert(); break; }
    this.alerted = now;
  }

  private toast(text: string): void {
    const el = $('toast'); el.textContent = text; el.classList.remove('hidden');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.add('hidden'), 1500);
  }

  // ---------- input ----------
  private pick(sx: number, sy: number): Building | null {
    const r = this.renderer, lim = Math.max(30, 60 * r.scale);
    let best: Building | null = null, bd = lim;
    for (const b of this.match.buildings) {
      const p = r.toScreen(b.x, b.y);
      const d = Math.hypot(p.x - sx, p.y - 26 * r.scale - sy);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  private send(from: number[], to: number): void {
    const m = this.match;
    const list = from.filter(id => id !== to && m.buildings[id].owner === this.human);
    if (list.length === 0) return;
    if (list.every(id => m.sendCount(m.buildings[id], this.pct) === 0)) { this.toast(t('msgEmpty')); sfx.deny(); return; }
    m.enqueue({ type: 'send', player: this.human, from: list, to, pct: this.pct });
    sfx.send();
    if (!this.ordered) { this.ordered = true; $('hint').classList.add('hidden'); }   // the tutorial hint leaves after the first real order
  }

  private cancelPointer(): void {
    if (this.ptr) clearTimeout(this.ptr.timer);
    this.ptr = null; this.drag = null; this.box = null;
  }

  private bind(): void {
    const cv = this.canvas;
    const pos = (e: PointerEvent) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const live = () => !this._paused && this.match.phase === 'playing';
    const down = (e: PointerEvent) => {
      e.preventDefault(); unlockAudio();
      if (!live()) return;
      if (this.ptr) { this.cancelPointer(); return; }   // a second finger cancels the gesture instead of sending something by accident
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
      else if (b.owner !== this.human) { sfx.deny(); this.toast(t('msgNotYours')); }
      else if (this.selection.has(b.id)) { this.selection.delete(b.id); sfx.tap(); }
      else { this.selection.add(b.id); sfx.tap(); }
    };
    const cancel = (e: PointerEvent) => { if (this.ptr && this.ptr.id === e.pointerId) this.cancelPointer(); };
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
    // «الكل»: select every building you own (tap again to clear), ready to send them all at one target
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
    $('toast').classList.add('hidden');
    const hintTimer = window.setTimeout(() => $('hint').classList.add('hidden'), 9000);   // and never sits on the map for long
    this.cleanup.push(() => clearTimeout(hintTimer));
    $('debug').classList.toggle('hidden', !this.debug);
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
    // one chip per player: how many buildings that player owns right now
    this.set('foes', m.players.map(p =>
      `<span class="chip${p.alive ? '' : ' dead'}" style="--c:${colorOf(p.id)}"><i>⌂</i>${m.buildingCount(p.id)}</span>`).join(''), true);
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
    if (this.debug && m.tick % 5 === 0) {
      const r = this.renderer;
      this.set('debug', `${r.frameMs.toFixed(1)} ms · ${r.drawnSoldiers} sprites · ${m.armies.length} armies${this.lowFx ? ' · lowFx' : ''}\n` +
        this.ais.map(a => `AI${a.player} ${a.difficulty}: ` + a.trace.slice(-3).map(d => `[${d.tick}] ${d.action} ${d.detail}`).join(' | ')).join('\n'));
    }
  }

  /** Test hook: where a building sits on screen. */
  screenOf(id: number): { x: number; y: number } {
    const b = this.match.buildings[id], p = this.renderer.toScreen(b.x, b.y), r = this.canvas.getBoundingClientRect();
    return { x: p.x + r.left, y: p.y - 26 * this.renderer.scale + r.top };
  }
  /** Test hook: let an AI of the given level play the human seat. */
  autoplay(diff: Difficulty | null, speed = 1): void {
    this.autopilot = diff ? new AIController(this.human, diff, this.opts.seed + 99) : null;
    this.speed = speed;
  }
}
