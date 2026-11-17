import { AIController, BALANCE, MAPS, Match, Rng, type Building, type BuildingType, type Difficulty, type HeroId, type Pct } from '../../../packages/simulation/src/index';
import { Renderer, colorOf, type BoxState, type DragState } from './render/renderer';
import { VIS } from './render/config';
import { setIntensity, setScene, sfx, unlockAudio } from './audio/sfx';
import { t } from './ui/i18n';
import { toLocal, toScreenPx } from './ui/orient';
import { track, type Lesson, type Progress } from './ui/lessons';
import type { Net } from './net';
import { applySnapshot, roomMatchConfig, type RoomConfig } from '../../../packages/simulation/src/online';

export interface SessionOpts { mapIndex: number; opponents: number; difficulty: Difficulty; seed: number; lowFx: boolean; roadClash: boolean; flipHud: boolean; firstMatch: boolean;
  goldenSeed: boolean; mode: 'conquest' | 'control'; hero: HeroId | null; lesson?: Lesson | null;
  online?: { net: Net; rc: RoomConfig; seat: number } | null }
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ICON: Record<BuildingType, string> = { farm: '🥦', tower: '🗼', forge: '☀️' };
const ABI: Record<string, string> = { burst: '🌱', rush: '💨', bulwark: '🛡️', volley: '🏹', mud: '🟤', snare: '🌿' };
const MAX_DT = 0.1; // a long frame (tab switch, Safari in background) never advances the match by more than this

/** One running match: fixed-step simulation, AI, touch input, HUD and rendering glue. */
export class Session {
  readonly match: Match;
  readonly human: number;
  /** Online: the server runs the match; this client only renders snapshots and sends commands. */
  readonly online: { net: Net; rc: RoomConfig; seat: number } | null;
  private lastSnap = 0;
  readonly renderer: Renderer;
  readonly ais: AIController[] = [];
  selection = new Set<number>();
  pct: Pct = 50;
  /** Synchronized attack: with several sources selected, nearer buildings wait so everyone arrives together. */
  sync = false;
  autoLow = false;
  onFirstOrder: (() => void) | null = null;
  /** Hero ability waiting for a target tap (slot index), or null. */
  aiming: number | null = null;
  lessonResult: 'win' | 'fail' | null = null;
  private progress: Progress = { reinforced: false, upgraded: false, syncSent: false, captures: 0, seed: false, upgradesTried: 0 };
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
    // computer opponents get a hero too (picked from the match seed), so abilities are in play on both sides
    const pick = new Rng(opts.seed + 31), HEROES: HeroId[] = ['sprig', 'armorleaf', 'turnip'];
    const heroes = players.map((_, i) => (i === 0 ? opts.hero : opts.hero ? HEROES[pick.int(3)] : null));
    this.online = opts.online ?? null; this.human = this.online ? this.online.seat : 0;
    this.match = this.online ? new Match(roomMatchConfig(this.online.rc))
      : new Match({ map, balance: BALANCE, seed: opts.seed, players, roadClash: opts.roadClash, goldenSeed: opts.goldenSeed, mode: opts.mode, heroes });
    if (this.online) { const net = this.online.net; this.match.enqueue = cmd => net.send(cmd); }   // commands go to the server
    if (!this.online) for (let i = 1; i < players.length; i++) this.ais.push(new AIController(i, opts.difficulty, opts.seed));
    this.renderer = new Renderer(this.canvas, $('stage'));
    opts.lesson?.setup?.(this.match);
    this.bind();
    this.buildHud();
    this.renderer.resize(this.match);
    setScene({ birds: true, water: map.obstacles.some(o => o.kind === 'pond') });
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
    setScene(null); setIntensity(0);
  }

  // ---------- loop ----------
  private frame = (ts: number): void => {
    if (this.disposed) return;
    const dt = Math.min(MAX_DT, this.lastT ? (ts - this.lastT) / 1000 : 0);
    this.lastT = ts;
    const m = this.match, step = 1 / m.bal.tickRate;
    const blocked = this._paused && !this.online;
    if (this.online) { this.time += dt; }
    else if (!blocked && m.phase === 'playing') {
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
      match: m, alpha: this.online ? Math.min(1, (performance.now() - this.lastSnap) / (1000 * step)) : m.phase === 'playing' && !blocked ? Math.min(1, this.acc / step) : 1, time: this.time, human: this.human,
      pct: this.pct, selection: this.selection, drag: this.drag, box: this.box, lowFx: this.lowFx,
      sync: this.sync, labels: { attack: t('lblAttack'), reinforce: t('lblReinforce'), capture: t('lblCapture'), sec: t('sec') },
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

  /** Online: a server snapshot replaces the match state, then sounds and effects play from its events. */
  applySnap(ev: unknown[], s: Record<string, unknown>): void {
    applySnapshot(this.match, s);
    this.match.events = ev as Match['events'];
    this.lastSnap = performance.now(); this.stepsRun++;
    this.react();
  }

  /** Stereo position of a world point: -1 left edge of the screen, +1 right edge. */
  private pan(x: number): number {
    const p = this.renderer.toScreen(x, 0).x / Math.max(1, this.canvas.clientWidth);
    return Math.max(-0.85, Math.min(0.85, (p - 0.5) * 1.8));
  }

  /** Sound and messages for what just happened in the simulation. Every cue is tied to a simulation event. */
  private react(): void {
    const m = this.match, bx = (id: number) => this.pan(m.buildings[id].x);
    this.renderer.onEvents(m, m.events);
    if (this.opts.lesson && !this.lessonResult) {
      track(m, m.events, this.progress);
      const r = this.opts.lesson.check(m, this.progress);
      if (r) { this.lessonResult = r; if (m.phase === 'playing') { m.phase = 'ended'; m.winnerTeam = r === 'win' ? m.players[this.human].team : null; } }
    }
    for (const e of m.events) {
      if (e.type === 'building_captured') { if (e.from === this.human) sfx.lost(bx(e.building)); else sfx.capture(bx(e.building)); }
      else if (e.type === 'tower_fired') sfx.shot(bx(e.tower));
      else if (e.type === 'projectile_hit') sfx.impact(this.pan(e.x));
      else if (e.type === 'battle_hit') sfx.hit(bx(e.building));
      else if (e.type === 'clash_started') sfx.clash(this.pan(e.x));
      else if (e.type === 'clash_hit') sfx.hit(this.pan(e.x));
      else if (e.type === 'army_sent') sfx.march(bx(e.from));
      else if (e.type === 'order_queued' && e.player === this.human) sfx.queued();
      else if (e.type === 'seed_warning') { sfx.seedWarn(bx(e.building)); this.toast(t('seedWarn').replace('{s}', String(m.bal.seed.warnSec)), true); }
      else if (e.type === 'seed_claimed') { const mine = m.sameTeam(e.player, this.human); sfx.seedClaim(bx(e.building), mine); this.toast(t(mine ? 'seedYou' : 'seedThem'), mine); }
      else if (e.type === 'bridge_warning') { const g = m.map.obstacles.find(o => o.kind === 'gate')!; sfx.bridge(this.pan(g.x)); this.toast(t(e.closing ? 'bridgeClose' : 'bridgeOpen').replace('{s}', String(m.bal.bridge.warnSec)), true); }
      else if (e.type === 'bridge_changed') sfx.bridge(this.pan(m.map.obstacles.find(o => o.kind === 'gate')!.x));
      else if (e.type === 'ability_used') sfx.ability(this.pan(e.x ?? 800));
      else if (e.type === 'zone_armed') { const z = m.zones.find(q => q.id === e.zone); if (z) sfx.zone(this.pan(z.x)); }
      else if (e.type === 'battle_resolved' && !e.captured && e.survivors === 0 && m.buildings[e.building].owner === this.human) sfx.defended(bx(e.building));
      else if ((e.type === 'upgraded' || e.type === 'converted') && m.buildings[e.building].owner === this.human) sfx.upgrade(bx(e.building));
      else if (e.type === 'order_rejected' && e.player === this.human && !this.autopilot) this.toast(t(e.reason === 'empty' ? 'msgEmpty' : e.reason === 'cooldown' ? 'msgCooldown' : 'msgNotYours'));
    }
    // tower draw creak a few ticks before a shot, footsteps under one marching squad at a time
    for (const b of m.buildings) if (b.type === 'tower' && b.owner >= 0 && b.cooldown === 4 && m.armies.some(a => !m.sameTeam(a.owner, b.owner) && (a.x - b.x) ** 2 + (a.y - b.y) ** 2 <= m.towerRange(b) ** 2)) sfx.towerDraw(bx(b.id));
    if (m.tick % 7 === 0) {
      const mv = m.armies.filter(a => a.state === 'moving');
      if (mv.length) { const a = mv[(m.tick / 7) % mv.length | 0]; sfx.steps(this.pan(a.x), (m.map.bridges ?? []).some(br => Math.hypot(br.x - a.x, br.y - a.y) < 62)); }
    }
    // music follows the fight: more squads and battles bring the second layer in, and it settles slowly afterwards
    if (m.tick % 10 === 0) setIntensity(m.armies.length * 0.1 + m.armies.filter(a => a.state !== 'moving').length * 0.3);
    // one alert per newly threatened building, never more often than every few seconds
    const now = new Set<number>();
    for (const a of m.armies) { const b = m.buildings[a.to]; if (b.owner === this.human && !m.sameTeam(a.owner, this.human)) now.add(b.id); }
    for (const id of now) if (!this.alerted.has(id) && this.time - this.lastAlert > 4) { this.lastAlert = this.time; sfx.alert(bx(id)); break; }
    this.alerted = now;
  }

  private toast(text: string, info = false): void {
    const el = $('toast'); el.textContent = text; el.classList.remove('hidden'); el.classList.toggle('info', info);
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
    m.enqueue({ type: 'send', player: this.human, from: list, to, pct: this.pct, sync: this.sync && list.length > 1 });
    sfx.send();
    if (!this.ordered) { this.ordered = true; if (!this.opts.lesson) $('hint').classList.add('hidden'); this.onFirstOrder?.(); }   // the drag lesson leaves after the first successful order, for good
  }

  private cancelPointer(): void {
    if (this.ptr) clearTimeout(this.ptr.timer);
    this.ptr = null; this.drag = null; this.box = null;
  }

  private bind(): void {
    const cv = this.canvas;
    const pos = (e: PointerEvent) => toLocal(e.clientX, e.clientY);   // canvas fills the (possibly rotated) app, so local = canvas coords
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
      if (this.aiming !== null) { this.aimAt(st.x0, st.y0, st.down); return; }
      if (st.down === null) { this.selection.clear(); return; }
      const b = m.buildings[st.down];
      if (this.selection.size > 0 && !this.selection.has(b.id)) { this.send([...this.selection], b.id); this.selection.clear(); }
      else if (b.owner !== this.human) { sfx.deny(); this.toast(t('msgNotYours')); }
      else if (this.selection.has(b.id)) { this.selection.delete(b.id); sfx.tap(); }
      else { this.selection.add(b.id); sfx.tap(); }
    };
    const cancel = (e: PointerEvent) => { if (this.ptr && this.ptr.id === e.pointerId) this.cancelPointer(); };
    const resize = () => { this.renderer.resize(this.match); requestAnimationFrame(() => this.renderer.resize(this.match)); };
    const noMenu = (e: Event) => e.preventDefault();
    cv.addEventListener('pointerdown', down); cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', cancel);
    cv.addEventListener('contextmenu', noMenu);
    window.addEventListener('resize', resize); window.addEventListener('orientationchange', resize);
    window.visualViewport?.addEventListener('resize', resize);   // Safari toolbars sliding in and out
    const ro = new ResizeObserver(resize); ro.observe($('stage'));
    this.cleanup.push(() => {
      cv.removeEventListener('pointerdown', down); cv.removeEventListener('pointermove', move);
      cv.removeEventListener('pointerup', up); cv.removeEventListener('pointercancel', cancel);
      cv.removeEventListener('contextmenu', noMenu);
      window.removeEventListener('resize', resize); window.removeEventListener('orientationchange', resize); ro.disconnect();
      window.visualViewport?.removeEventListener('resize', resize);
    });
  }

  /** Resolve a hero ability on the tapped spot or building. */
  private aimAt(sx: number, sy: number, building: number | null): void {
    const slot = this.aiming!, def = this.match.heroAbilities(this.human)[slot], m = this.match;
    const b = building !== null ? m.buildings[building] : null, w = this.renderer.toWorld(sx, sy);
    let ok = false;
    if (def.target === 'own') ok = !!b && b.owner === this.human;
    else if (def.target === 'ownTower') ok = !!b && b.owner === this.human && b.type === 'tower';
    else ok = m.inReach(this.human, w.x, w.y, def.range ?? 500);
    if (!ok) { sfx.deny(); this.toast(t('aimBad')); return; }
    m.enqueue({ type: 'ability', player: this.human, slot, ...(def.target === 'point' ? { x: w.x, y: w.y } : { building: b!.id }) });
    this.aiming = null; this.selection.clear();
  }

  // ---------- HUD ----------
  private buildHud(): void {
    const hb = $('heroBar'); hb.innerHTML = '';
    this.match.heroAbilities(this.human).forEach((def, slot) => {
      const btn = document.createElement('button'); btn.className = 'ab'; btn.id = 'ab' + slot;
      btn.innerHTML = `<b>${ABI[def.id]}</b><i>${t('ab_' + def.id)}</i><u></u>`;
      btn.onclick = () => {
        unlockAudio();
        if (!this.match.abilityReady(this.human, slot)) { sfx.deny(); return; }
        if (this.aiming === slot) { this.aiming = null; return; }
        if (def.target === 'none') { this.match.enqueue({ type: 'ability', player: this.human, slot }); return; }
        this.aiming = slot; sfx.tap(); this.toast(t('aim_' + def.target), true);
      };
      hb.appendChild(btn);
    });
    const left = $('pcts'); left.innerHTML = '';
    for (const p of [100, 75, 50, 25] as Pct[]) {
      const b = document.createElement('button'); b.className = 'pct'; b.dataset.pct = String(p); b.textContent = p + '%';
      b.onclick = () => { this.pct = p; sfx.tap(); unlockAudio(); };
      left.appendChild(b);
    }
    $('hud').classList.toggle('flip', this.opts.flipHud);
    $('btnSync').onclick = () => { this.sync = !this.sync; sfx.tap(); this.toast(t(this.sync ? 'msgSyncOn' : 'msgSyncOff'), true); };
    // «تحديد الكل»: selects every building you own (tap again to clear), ready to send them all at one target
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
    const L = this.opts.lesson, lang = document.documentElement.lang === 'en' ? 1 : 0;
    $('hint').textContent = L ? `${L.icon} ${L.goal[lang]}` : t('hint'); $('hint').classList.toggle('hidden', !this.opts.firstMatch && !L);   // drag lesson only until the first order ever
    $('toast').classList.add('hidden');
    $('debug').classList.toggle('hidden', !this.debug);
  }

  private set(id: string, v: string, html = false): void {
    if (this.cache.get(id) === v) return;
    this.cache.set(id, v);
    if (!document.getElementById(id)) return;
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
    // strength bar: every team's troops as a share of all troops on the board
    const teams = [...new Set(m.players.map(p => p.team))], tot = teams.map(tm => m.players.filter(p => p.team === tm).reduce((n, p) => n + m.totalUnits(p.id), 0));
    // whole percents only, and the bars are reused: the HUD is not rebuilt every time one unit is produced
    const all = tot.reduce((x, y) => x + y, 0) || 1, bar = $('power');
    if (bar.children.length !== teams.length) bar.innerHTML = teams.map(tm => `<i style="background:${colorOf(m.players.find(p => p.team === tm)!.id)}"></i>`).join('');
    tot.forEach((n, i) => { const g = String(Math.max(1, Math.round((n / all) * 100))), el = bar.children[i] as HTMLElement; if (el.style.flexGrow !== g) el.style.flexGrow = g; });
    this.set('income', '+' + m.income(this.human).toFixed(1) + '/s');
    const fc = m.forgeCount(this.human);
    this.set('forgeStat', fc ? `☀️ +${Math.round(fc * m.bal.forge.attackBonus * 100)}%` : '');
    const sec = Math.floor(m.tick / m.bal.tickRate);
    this.set('clock', `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`);
    // one chip per player: how many buildings that player owns right now
    this.set('foes', m.players.map(p =>
      `<span class="chip${p.alive ? '' : ' dead'}" style="--c:${colorOf(p.id)}"><i>⌂</i>${m.buildingCount(p.id)}</span>`).join(''), true);
    document.querySelectorAll<HTMLElement>('.pct').forEach(b => b.classList.toggle('on', Number(b.dataset.pct) === this.pct));
    $('btnSync').classList.toggle('on', this.sync);
    this.match.heroAbilities(this.human).forEach((_, slot) => {
      const el = $('ab' + slot), left = Math.max(0, (m.players[this.human].cd[slot] - m.tick) / m.bal.tickRate);
      el.classList.toggle('ready', left === 0); el.classList.toggle('aim', this.aiming === slot);
      this.set('ab' + slot + 'cd', left > 0 ? String(Math.ceil(left)) : '');
      const u = el.querySelector('u')!; if (u.textContent !== this.cache.get('ab' + slot + 'cd')) u.textContent = this.cache.get('ab' + slot + 'cd') ?? '';
    });
    if (m.mode === 'control') {
      const goal = m.bal.control.holdSec * m.bal.tickRate, mine = m.control[m.players[this.human].team] ?? 0;
      const best = Math.max(0, ...m.control.filter((_, tm) => tm !== m.players[this.human].team).map(v => v ?? 0));
      this.set('crown', `👑 ${Math.floor(mine / m.bal.tickRate)}/${m.bal.control.holdSec} · ${Math.floor(best / m.bal.tickRate)}`);
      void goal;
    } else this.set('crown', '');
    const owned = m.buildingCount(this.human);
    $('btnAll').classList.toggle('on', this.selection.size > 0 && this.selection.size === owned);
    this.set('allCount', `${this.selection.size}/${owned}`);

    const one = this.selection.size === 1 ? m.buildings[[...this.selection][0]] : null;
    const label = (id: string, show: boolean, text: string, ok: boolean) => {
      const el = $<HTMLButtonElement>(id);
      el.classList.toggle('hidden', !show);
      if (!show) return;
      this.set(id, text, true); el.disabled = !ok;
    };
    const cost = one ? m.upgradeCost(one) : null;
    // cost in units and build time, shown only while a building is selected
    const upSec = one && cost !== null ? (one.type === 'farm' ? m.bal.farm : m.bal.tower).upgradeTimeSec[one.level - 1] : 0;
    label('act-upgrade', !!one && cost !== null, `<b>⬆️</b><i>${t('upgrade')}</i><u>${cost}🥦 ${upSec}${t('sec')}</u>`, !!one && m.canUpgrade(one));
    for (const k of ['farm', 'tower', 'forge'] as const) {
      label('act-' + k, !!one && one.type !== k, `<b>${ICON[k]}</b><i>${t(k)}</i><u>${m.bal.convert.cost}🥦 ${m.bal.convert.timeSec}${t('sec')}</u>`, !!one && m.canConvert(one, k));
    }
    if (this.debug && m.tick % 5 === 0) {
      const r = this.renderer;
      this.set('debug', `${r.frameMs.toFixed(1)} ms · ${r.drawnSoldiers} sprites · ${m.armies.length} armies${this.lowFx ? ' · lowFx' : ''}\n` +
        this.ais.map(a => `AI${a.player} ${a.difficulty}: ` + a.trace.slice(-3).map(d => `[${d.tick}] ${d.action} ${d.detail}`).join(' | ')).join('\n'));
    }
  }

  /** Test hook: where a building sits on screen. */
  screenOf(id: number): { x: number; y: number } {
    const b = this.match.buildings[id], p = this.renderer.toScreen(b.x, b.y);
    return toScreenPx(p.x, p.y - 26 * this.renderer.scale);
  }
  /** Test hook: let an AI of the given level play the human seat. */
  autoplay(diff: Difficulty | null, speed = 1): void {
    this.autopilot = diff ? new AIController(this.human, diff, this.opts.seed + 99) : null;
    this.speed = speed;
  }
}
