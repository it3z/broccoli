// Interactive lessons (short, scripted, no time pressure) and solo challenges (real matches with an extra rule).
import type { Match, SimEvent } from '../../../../packages/simulation/src/index';
import type { SessionOpts } from '../game';

export interface Progress { reinforced: boolean; upgraded: boolean; syncSent: boolean; captures: number; seed: boolean; upgradesTried: number }
export interface Lesson {
  id: string; kind: 'lesson' | 'challenge'; icon: string;
  title: [string, string]; goal: [string, string];
  opts: Partial<SessionOpts>;
  /** Prepare the board after the match is created. */
  setup?: (m: Match) => void;
  /** 'win' / 'fail' end the lesson; null keeps playing. */
  check: (m: Match, p: Progress) => 'win' | 'fail' | null;
}

const base = { goldenSeed: false, hero: null, mode: 'conquest' as const, roadClash: false };
const quiet = (m: Match) => { for (const p of m.players) p.lastActionTick = 1e9; };

export const LESSONS: Lesson[] = [
  { id: 'l1', kind: 'lesson', icon: '👆', title: ['الإرسال', 'Sending'], goal: ['اسحب من مبناك الأخضر إلى مبنى رمادي واستولِ عليه.', 'Drag from your green building to a grey one and capture it.'],
    opts: { ...base, mapIndex: 0, opponents: 1, difficulty: 'easy' }, setup: m => { quiet(m); m.buildings[0].garrison = 30; },
    check: (_m, p) => (p.captures >= 1 ? 'win' : null) },
  { id: 'l2', kind: 'lesson', icon: '🔁', title: ['النسب والتعزيز', 'Percent & reinforce'], goal: ['اختر 25% ثم أرسل جنوداً إلى مبنى آخر من مبانيك.', 'Pick 25%, then send troops to another building of yours.'],
    opts: { ...base, mapIndex: 0, opponents: 1, difficulty: 'easy' }, setup: quiet,
    check: (_m, p) => (p.reinforced ? 'win' : null) },
  { id: 'l3', kind: 'lesson', icon: '⬆️', title: ['الترقية', 'Upgrading'], goal: ['المس مزرعة لتحديدها، ثم اضغط زر الترقية وانتظر اكتمالها.', 'Tap a farm to select it, press Upgrade, and wait for it to finish.'],
    opts: { ...base, mapIndex: 0, opponents: 1, difficulty: 'easy' }, setup: m => { quiet(m); m.buildings[1].garrison = 30; },
    check: (_m, p) => (p.upgraded ? 'win' : null) },
  { id: 'l4', kind: 'lesson', icon: '⏱', title: ['معاً ضد البرج', 'Sync vs the tower'], goal: ['حدّد الكل، فعّل «معاً»، واستولِ على البرج الأحمر في المنتصف.', 'Select all, switch on Sync, and take the red tower in the middle.'],
    opts: { ...base, mapIndex: 0, opponents: 1, difficulty: 'easy' },
    setup: m => { quiet(m); for (const i of [0, 1]) m.buildings[i].garrison = 40; m.buildings[10].owner = 1; m.buildings[10].garrison = 18; },
    check: (m, p) => (m.buildings[10].owner === 0 && p.syncSent ? 'win' : m.buildings[10].owner === 0 ? 'fail' : null) },
  { id: 'l5', kind: 'lesson', icon: '🌰', title: ['البذرة الذهبية', 'The Golden Seed'], goal: ['انتظر العدّ التنازلي، ثم امسك المبنى المعلَّم حتى تحصل على البذرة.', 'Wait for the countdown, then hold the marked building until you claim the seed.'],
    opts: { ...base, goldenSeed: true, mapIndex: 0, opponents: 1, difficulty: 'easy' },
    setup: m => { quiet(m); m.nextSeedTick = 12 * m.bal.tickRate; for (const i of [0, 1]) m.buildings[i].garrison = 40; },
    check: (_m, p) => (p.seed ? 'win' : null) },
  { id: 'c1', kind: 'challenge', icon: '⚡', title: ['برق', 'Blitz'], goal: ['اهزم خصماً عادياً في مرج الربيع خلال 2:30.', 'Beat a normal opponent on Spring Meadow within 2:30.'],
    opts: { ...base, mapIndex: 0, opponents: 1, difficulty: 'normal' },
    check: (m) => (m.phase === 'ended' ? (m.winnerTeam === 0 ? 'win' : 'fail') : m.tick > 150 * m.bal.tickRate ? 'fail' : null) },
  { id: 'c2', kind: 'challenge', icon: '🛡️', title: ['وحيد ضد ثلاثة', 'One against three'], goal: ['انتصر في الغابة العميقة على ثلاثة خصوم عاديين.', 'Win in Deep Forest against three normal opponents.'],
    opts: { ...base, mapIndex: 1, opponents: 3, difficulty: 'normal', goldenSeed: true },
    check: (m) => (m.phase === 'ended' ? (m.winnerTeam === 0 ? 'win' : 'fail') : null) },
  { id: 'c3', kind: 'challenge', icon: '🚫', title: ['بلا ترقية', 'No upgrades'], goal: ['اهزم خصماً صعباً على جسر الربيع دون أي ترقية أو تحويل.', 'Beat a hard opponent on Spring Bridge without upgrading or converting.'],
    opts: { ...base, mapIndex: 2, opponents: 1, difficulty: 'hard', hero: 'sprig' },
    check: (m, p) => (p.upgradesTried > 0 ? 'fail' : m.phase === 'ended' ? (m.winnerTeam === 0 ? 'win' : 'fail') : null) },
];

/** Fold this tick's simulation events into the lesson progress. */
export function track(m: Match, ev: SimEvent[], p: Progress): void {
  const sentAt = new Set<number>();
  for (const e of ev) {
    if (e.type === 'army_arrived' && e.owner === 0 && e.reinforce && m.buildings[e.building].owner === 0) p.reinforced = true;
    if (e.type === 'upgraded' && m.buildings[e.building].owner === 0) p.upgraded = true;
    if (e.type === 'upgrade_started' && m.buildings[e.building].owner === 0) p.upgradesTried++;
    if (e.type === 'building_captured' && e.by === 0) p.captures++;
    if (e.type === 'seed_claimed' && e.player === 0) p.seed = true;
    if (e.type === 'order_queued' && e.player === 0) sentAt.add(e.to);
  }
  if (sentAt.size) p.syncSent = true;
}
