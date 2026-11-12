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

export interface Balance {
  tickRate: number;
  waveSize: number;
  waveIntervalTicks: number;
  unitSpeed: number;
  maxDispatchesPerBuilding: number;
  matchTimeLimitSec: number;
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
  cooldown: number;
}
/** Units queued to leave a building; drawn from the garrison wave by wave. */
export interface Dispatch { id: number; owner: number; from: number; to: number; remaining: number; nextEmit: number }
export interface Wave {
  id: number; owner: number; from: number; to: number; units: number;
  dist: number; x: number; y: number; px: number; py: number;
}
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
  | { type: 'capture'; building: number; by: number; from: number }
  | { type: 'shot'; tower: number; x: number; y: number; owner: number }
  | { type: 'hit'; building: number; by: number; held: boolean }
  | { type: 'reinforce'; building: number }
  | { type: 'launch'; building: number; owner: number }
  | { type: 'upgraded'; building: number }
  | { type: 'converted'; building: number }
  | { type: 'busy'; building: number }
  | { type: 'eliminated'; player: number }
  | { type: 'end'; winnerTeam: number | null };

export interface MatchConfig {
  map: MapDef; balance: Balance; seed: number;
  players: { slot: number; team: number; isAI: boolean }[];
}
