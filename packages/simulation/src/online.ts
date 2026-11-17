// Shared by the online server and the browser client: the match set-up for a room, and the snapshot format.
import { BALANCE, MAPS } from './index';
import type { HeroId, MatchConfig } from './types';
import type { Match } from './sim';

export interface RoomConfig { size: 2 | 4; mapIndex: number; seed: number; heroes: (HeroId | null)[]; goldenSeed: boolean }
/** 1v1 uses the map's two slots; 2v2 (Deep Forest) puts the two left corners against the two right corners. */
export const TEAMS_2V2 = [0, 1, 1, 0];
export function roomMatchConfig(rc: RoomConfig): MatchConfig {
  return {
    map: MAPS[rc.mapIndex], balance: BALANCE, seed: rc.seed, goldenSeed: rc.goldenSeed, mode: 'conquest', heroes: rc.heroes,
    players: Array.from({ length: rc.size }, (_, s) => ({ slot: s, team: rc.size === 4 ? TEAMS_2V2[s] : s, isAI: false })),
  };
}
/** Everything that changes during a match. The client copies it onto its own Match built from the same config. */
const KEYS = ['tick', 'phase', 'winnerTeam', 'buildings', 'armies', 'projectiles', 'pending', 'players', 'gseed', 'nextSeedTick',
  'buffs', 'bridge', 'control', 'zones', 'bbuffs', 'pbuffs'] as const;
export function snapshot(m: Match): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of KEYS) o[k] = (m as unknown as Record<string, unknown>)[k];
  return o;
}
export function applySnapshot(m: Match, s: Record<string, unknown>): void {
  for (const k of KEYS) if (k in s) (m as unknown as Record<string, unknown>)[k] = s[k];
}
