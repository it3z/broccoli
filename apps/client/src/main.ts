import { MAPS, type Difficulty, type HeroId, type Match } from '../../../packages/simulation/src/index';
import { Session, type SessionOpts } from './game';
import { colorOf } from './render/art';
import { levels, setLevel, sfx, unlockAudio } from './audio/sfx';

declare const __BUILD__: string;
import { getLang, setLang, t, type Lang } from './ui/i18n';
import { initOrientation } from './ui/orient';
import { LESSONS, type Lesson } from './ui/lessons';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const store = {
  get(k: string, d: string): string { try { return localStorage.getItem('broccoli.' + k) ?? d; } catch { return d; } },
  set(k: string, v: string): void { try { localStorage.setItem('broccoli.' + k, v); } catch { /* storage unavailable */ } },
};

let session: Session | null = null;
let lowFx = store.get('fx', 'high') === 'low';
const vol = { ...levels() };
for (const b of ['music', 'amb', 'fx'] as const) { const v = store.get('vol.' + b, ''); if (v !== '') vol[b] = Number(v) / 100; }
let howFromPause = false;
let flipHud = store.get('side', 'left') === 'right';
let roadClash = false;
const setup: SessionOpts = {
  mapIndex: Number(store.get('map', '0')) % MAPS.length, opponents: 1,
  difficulty: store.get('diff', 'normal') as Difficulty, seed: 1, lowFx: false, roadClash: false, flipHud: false, firstMatch: false,
  goldenSeed: store.get('gseed', '1') === '1', mode: 'conquest', hero: (store.get('hero', 'sprig') || null) as HeroId | null,
};

function show(id: string | null): void {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', s.id === id));
  $('hud').classList.toggle('hidden', id !== null);
  $('cv').classList.toggle('hidden', id !== null);
}
const overlay = (id: string, on: boolean) => $(id).classList.toggle('on', on);

function seg(host: HTMLElement, items: { v: string; label: string }[], cur: string, pick: (v: string) => void): void {
  host.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'segb' + (it.v === cur ? ' on' : ''); b.textContent = it.label;
    b.onclick = () => { sfx.tap(); pick(it.v); };
    host.appendChild(b);
  }
}

function renderSetup(): void {
  const maps = $('maps'); maps.innerHTML = '';
  MAPS.forEach((map, i) => {
    const card = document.createElement('button');
    card.className = 'map' + (i === setup.mapIndex ? ' on' : '');
    const cv = document.createElement('canvas'); cv.width = 240; cv.height = 135;
    const c = cv.getContext('2d')!;
    c.fillStyle = map.biome === 'forest' ? '#2f7a3f' : '#6cbc52'; c.fillRect(0, 0, 240, 135);
    const k = 240 / map.width;
    for (const o of map.obstacles) { c.fillStyle = o.kind === 'rock' ? '#9a9da4' : o.kind === 'gate' ? '#b98a56' : '#58b3ec'; c.beginPath(); c.ellipse(o.x * k, o.y * k, o.r * k, o.r * k * 0.8, 0, 0, 7); c.fill(); }
    for (const b of map.buildings) {
      c.fillStyle = colorOf(b.slot); c.strokeStyle = 'rgba(0,0,0,.55)'; c.lineWidth = 1.5; c.beginPath();
      if (b.type === 'tower') { c.moveTo(b.x * k, b.y * k - 8); c.lineTo(b.x * k + 6, b.y * k + 5); c.lineTo(b.x * k - 6, b.y * k + 5); c.closePath(); }
      else if (b.type === 'forge') c.rect(b.x * k - 5, b.y * k - 5, 10, 10);
      else c.arc(b.x * k, b.y * k, 6, 0, 7);
      c.fill(); c.stroke();
    }
    const name = document.createElement('span'); name.textContent = `${map.name[getLang()]} · ${map.slots} ${t('players')}`;
    card.append(cv, name);
    card.onclick = () => { sfx.tap(); setup.mapIndex = i; store.set('map', String(i)); renderSetup(); };
    maps.appendChild(card);
  });
  const max = MAPS[setup.mapIndex].slots - 1;
  setup.opponents = Math.max(1, Math.min(setup.opponents, max));
  seg($('segOpp'), Array.from({ length: max }, (_, i) => ({ v: String(i + 1), label: String(i + 1) })), String(setup.opponents),
    v => { setup.opponents = Number(v); renderSetup(); });
  seg($('segDiff'), (['easy', 'normal', 'hard'] as const).map(d => ({ v: d, label: t(d) })), setup.difficulty,
    v => { setup.difficulty = v as Difficulty; store.set('diff', v); renderSetup(); });
  const hasBloom = MAPS[setup.mapIndex].id !== 'spring_bridge';   // the bridge map has no fair central building
  if (!hasBloom) setup.mode = 'conquest';
  seg($('segMode'), [{ v: 'conquest', label: t('conquest') }, ...(hasBloom ? [{ v: 'control', label: t('control') }] : [])], setup.mode,
    v => { setup.mode = v as 'conquest' | 'control'; renderSetup(); });
  seg($('segSeed'), [{ v: '1', label: t('on') }, { v: '0', label: t('off') }], setup.goldenSeed ? '1' : '0', v => { setup.goldenSeed = v === '1'; store.set('gseed', v); renderSetup(); });
  seg($('segHero'), [{ v: '', label: t('none') }, ...(['sprig', 'armorleaf', 'turnip'] as const).map(h => ({ v: h, label: t(h) }))], setup.hero ?? '',
    v => { setup.hero = (v || null) as HeroId | null; store.set('hero', v); renderSetup(); });
  seg($('segClash'), [{ v: '0', label: t('off') }, { v: '1', label: t('on') }], roadClash ? '1' : '0', v => { roadClash = v === '1'; renderSetup(); });
}

function renderLearn(): void {
  const host = $('learnList'); host.innerHTML = '';
  for (const kind of ['lesson', 'challenge'] as const) {
    const h = document.createElement('h3'); h.textContent = t(kind === 'lesson' ? 'lessons' : 'challenges'); host.appendChild(h);
    for (const L of LESSONS.filter(x => x.kind === kind)) {
      const b = document.createElement('button'), lg = getLang() === 'en' ? 1 : 0, done = store.get('done.' + L.id, '') === '1';
      b.className = 'lesson' + (done ? ' done' : '');
      b.innerHTML = `<b>${L.icon}</b><span><strong>${L.title[lg]}</strong><small>${L.goal[lg]}</small></span><i>${done ? '✓' : ''}</i>`;
      b.onclick = () => { sfx.tap(); startMatch(L); };
      host.appendChild(b);
    }
  }
}

function renderSettings(): void {
  seg($('segLang'), [{ v: 'ar', label: 'العربية' }, { v: 'en', label: 'English' }], getLang(),
    v => { setLang(v as Lang); store.set('lang', v); renderSettings(); });
  for (const [id, bus] of [['volMusic', 'music'], ['volAmb', 'amb'], ['volFx', 'fx']] as const) {
    const el = $<HTMLInputElement>(id), show = () => { (el.nextElementSibling as HTMLElement).textContent = el.value; };
    el.value = String(Math.round(vol[bus] * 100)); show();
    el.oninput = () => { vol[bus] = Number(el.value) / 100; setLevel(bus, vol[bus]); store.set('vol.' + bus, el.value); show(); };
  }
  seg($('segFx'), [{ v: 'high', label: t('fxHigh') }, { v: 'low', label: t('fxLow') }], lowFx ? 'low' : 'high',
    v => { lowFx = v === 'low'; store.set('fx', v); renderSettings(); });
  seg($('segSide'), [{ v: 'left', label: t('left') }, { v: 'right', label: t('right') }], flipHud ? 'right' : 'left',
    v => { flipHud = v === 'right'; store.set('side', v); renderSettings(); });
}

let current: Lesson | null = null;
function startMatch(lesson: Lesson | null = null): void {
  current = lesson;
  session?.dispose();
  overlay('pause', false); overlay('result', false);
  show(null);
  setup.seed = (Date.now() % 2147483647) | 1;
  session = new Session({ ...setup, lowFx, roadClash, flipHud, firstMatch: store.get('lesson', '0') !== '1', ...(lesson ? lesson.opts : {}), lesson, seed: setup.seed }, onEnd);
  session.onFirstOrder = () => store.set('lesson', '1');
  (window as unknown as { __broccoli: Session }).__broccoli = session;
}

function onEnd(m: Match): void {
  const me = m.players[0], won = m.winnerTeam === me.team, foes = m.players.filter(p => p.team !== me.team);
  $('resTitle').textContent = m.winnerTeam === null ? t('draw') : won ? t('victory') : t('defeat');
  $('resTitle').className = won ? 'win' : 'loss';
  $('resIcon').textContent = won ? '🏆' : m.winnerTeam === null ? '🤝' : '🥀';
  const sec = Math.floor(m.tick / m.bal.tickRate);
  const rows: [string, string][] = [
    [t('time'), `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`],
    [t('captures'), String(me.stats.captures)],
    [t('produced'), String(Math.floor(me.stats.produced))],
    [t('lost'), String(Math.round(me.stats.lost))],
    [t('enemyCaptures'), String(foes.reduce((n, p) => n + p.stats.captures, 0))],
    [t('enemyLost'), String(Math.round(foes.reduce((n, p) => n + p.stats.lost, 0)))],
    [t('turning'), turning(m)],
  ];
  $('resStats').innerHTML = rows.map(r => `<div><span>${r[0]}</span><b>${r[1]}</b></div>`).join('');
  if (current && session) {
    const ok = session.lessonResult === 'win' || (!session.lessonResult && won);
    if (ok) store.set('done.' + current.id, '1');
    $('resTitle').textContent = `${current.icon} ${current.title[getLang() === 'en' ? 1 : 0]} — ${ok ? t('passed') : t('failed')}`;
    $('resTitle').className = ok ? 'win' : 'loss'; $('resIcon').textContent = ok ? '✅' : '↩️';
  }
  overlay('result', true);
}

/** The last moment the eventual winner stopped being behind or level on buildings and stayed ahead. */
function turning(m: Match): string {
  if (m.winnerTeam === null) return '—';
  const w = m.players.findIndex(p => p.team === m.winnerTeam);
  let at = -1;
  m.history.forEach((h, i) => { if (h[w] <= Math.max(...h.filter((_, j) => j !== w))) at = i; });
  const sec = at + 2;
  return at < 0 ? t('fromStart') : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function toMenu(): void {
  session?.dispose(); session = null;
  overlay('pause', false); overlay('result', false);
  show('menu');
}

function init(): void {
  initOrientation();
  setLang(store.get('lang', 'ar') as Lang);
  for (const b of ['music', 'amb', 'fx'] as const) setLevel(b, vol[b]);
  document.querySelectorAll<HTMLElement>('.build').forEach(el => (el.textContent = __BUILD__));
  (window as unknown as { __broccoliBuild: string }).__broccoliBuild = __BUILD__;
  document.addEventListener('pointerdown', unlockAudio, { passive: true });
  document.addEventListener('click', unlockAudio);
  // iOS Safari: stop pinch-zoom and double-tap zoom from hijacking the battlefield
  for (const ev of ['gesturestart', 'gesturechange', 'dblclick']) document.addEventListener(ev, e => e.preventDefault());

  $('btnSolo').onclick = () => { sfx.tap(); renderSetup(); show('setup'); };
  $('btnLearn').onclick = () => { sfx.tap(); renderLearn(); show('learn'); };
  $('btnHow').onclick = () => { sfx.tap(); show('howto'); };
  $('btnSettings').onclick = () => { sfx.tap(); renderSettings(); show('settings'); };
  document.querySelectorAll<HTMLElement>('[data-back]').forEach(b => (b.onclick = () => {
    sfx.tap();
    if (howFromPause) { howFromPause = false; $('howto').classList.remove('on'); return; }   // back to the paused match
    show('menu');
  }));
  $('btnPauseHow').onclick = () => { sfx.tap(); howFromPause = true; $('howto').classList.add('on'); };
  $('btnStart').onclick = () => startMatch();

  $('btnPause').onclick = () => { if (session && session.match.phase === 'playing') { session.paused = true; overlay('pause', true); } };
  $('btnResume').onclick = () => { if (session) session.paused = false; overlay('pause', false); };
  $('btnRestart').onclick = () => startMatch(current);
  $('btnSurrender').onclick = () => {
    if (!session) return;
    session.match.enqueue({ type: 'surrender', player: 0 });
    session.paused = false; overlay('pause', false);
  };
  $('btnQuit').onclick = toMenu;
  $('btnAgain').onclick = () => startMatch(current);
  $('btnResMenu').onclick = toMenu;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && session && session.match.phase === 'playing' && !session.paused) { session.paused = true; overlay('pause', true); }
  });
  show('menu');
}

init();
