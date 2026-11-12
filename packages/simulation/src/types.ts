export type BuildingType = 'farm' | 'tower' | 'forge';
export interface Vec { x: number; y: number }

export interface MapDef {
  id: string;
  name: { ar: string; en: string };
  biome: string;
  width: number;
  height: number;
  slots: number;
  buildings: { type: string; level: number; x: number; y: number; slot: number; garrison: number }[];
  obstacles: { kind: string; x: number; y: number; r: number }[];
}

export interface AiProfile { thinkMs: number[]; margin: number; reserve: number; skip: number; builds: boolean; towers: boolean; topPicks: number; defends: boolean; maxFarmLevel: number; forgeAtFarms: number }
export interface Balance {
  tickRate: number;
  unitSpeed: number;
  battleRate: number;
  sendCooldownSec: number;
  projectileSpeed: number;
  matchTimeLimitSec: number;
  ai: Record<'easy' | 'normal' | 'hard', AiProfile>;
  farm: { levels: { prod: number; cap: number; def: number }[]; upgradeCost: number[]; upgradeTimeSec: number[] };
  tower: { levels: { range: number; fireIntervalSec: number; damage: number; def: number }[]; upgradeCost: number[]; upgradeTimeSec: number[] };
  forge: { def: number; attackBonus: number; defenseBonus: number; maxStack: number };
  convert: { cost: number; timeSec: number };
  morale: {
    start: number; max: number; attackPerPoint: number; defensePerPoint: number; speedPerPoint: number;
    captureEnemy: number; captureNeutral: number; loseBuilding: number; defendWave: number; failedWave: number;
    waveShotDown: number; upgrade: number; idleAfterSec: number; idleDecayPerSec: number;
  };
}

export interface Building {
  id: number; type: BuildingType; owner: number; level: number; x: number; y: number;
  garrison: number;
  busyKind: null | 'upgrade' | 'convert'; busyStart: number; busyEnd: number; convertTo: BuildingType | null;
  cooldown: number; sendReadyTick: number;
}
export type ArmyState = 'moving' | 'fighting' | 'arrived' | 'cancelled';
/** A real marching group. Its units left the source garrison once, at the moment it was sent. */
export interface Army {
  id: number; owner: number; from: number; to: number;
  units: number; startUnits: number; state: ArmyState;
  dist: number; speed: number; createdTick: number; engage: number;
  x: number; y: number; px: number; py: number;
}
/** A tower shot in flight. Damage is applied exactly once, on the impact tick. */
export interface Projectile { id: number; tower: number; owner: number; target: number; damage: number; ticksLeft: number; totalTicks: number }

export interface PlayerStats { produced: number; lost: number; killed: number; captures: number }
export interface Player {
  id: number; team: number; isAI: boolean; alive: boolean; morale: number; lastActionTick: number; stats: PlayerStats;
}
export type Pct = 25 | 50 | 75 | 100;
export type Command =
  | { type: 'send'; player: number; from: number[]; to: number; pct: Pct }
  | { type: 'upgrade'; player: number; building: number }
  | { type: 'convert'; player: number; building: number; to: BuildingType }
  | { type: 'surrender'; player: number };

export type SimEvent =
  | { type: 'army_sent'; army: number; owner: number; from: number; to: number; units: number }
  | { type: 'army_arrived'; army: number; owner: number; building: number; units: number; reinforce: boolean }
  | { type: 'battle_started'; army: number; building: number; attacker: number; defender: number }
  | { type: 'battle_hit'; army: number; building: number; attacker: number }
  | { type: 'battle_resolved'; army: number; building: number; attacker: number; captured: boolean; survivors: number }
  | { type: 'building_captured'; building: number; by: number; from: number }
  | { type: 'building_lost'; building: number; player: number; by: number }
  | { type: 'tower_fired'; tower: number; projectile: number; army: number; owner: number }
  | { type: 'projectile_hit'; projectile: number; army: number; owner: number; x: number; y: number; kills: number }
  | { type: 'army_destroyed'; army: number; owner: number; x: number; y: number }
  | { type: 'order_rejected'; player: number; building: number; reason: 'empty' | 'not_owner' | 'cooldown' | 'invalid' }
  | { type: 'upgrade_started'; building: number }
  | { type: 'upgraded'; building: number }
  | { type: 'converted'; building: number }
  | { type: 'player_eliminated'; player: number }
  | { type: 'match_ended'; winnerTeam: number | null };

export interface MatchConfig {
  map: MapDef; balance: Balance; seed: number;
  players: { slot: number; team: number; isAI: boolean }[];
}
