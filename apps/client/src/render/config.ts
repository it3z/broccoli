// Every visual tuning number in one place. Nothing here affects the rules; those live in balance.json.
export const VIS = {
  // camera framing around the buildings (world units)
  fitPad: { side: 125, top: 150, bottom: 112 },
  // minimum on-screen sizes in CSS px, so things stay readable on a small phone viewport
  soldierMinPx: 23,
  soldierMaxScale: 2.0,
  labelMinPx: 13.5,
  badgeMinPx: 11,
  // how a real unit count turns into drawn soldiers
  iconsOneToOne: 14,        // up to this many: one sprite per unit
  unitsPerExtraIcon: 3,     // beyond that: one more sprite per this many units
  maxIcons: 34,
  maxIconsLow: 10,           // reduced-effects mode
  formationWidth: 7,        // most soldiers per rank (groups form two or three ranks)
  spacingAcross: 16,
  spacingAlong: 14,
  exitRankDelay: 0.14,
  exitWaveSec: 0.42,        // seconds between waves (two ranks each)      // seconds between ranks filing out of the door
  exitWalkSec: 0.4,         // seconds a soldier takes from the door to his place
  laneOffset: 17,
  queueGap: 95,             // how far behind a squad of the same owner the next one queues at a choke point (world units)
  buildingBody: 54,         // visual radius of a building and its base; squads keep clear of it           // sideways spacing between squads on the same road
  // battle staging
  engageStart: 175,         // distance at which a hostile group starts fanning out around its target
  engageBlend: 80,
  battleRadius: 88,
  damageTickSec: 0.45,      // one "-N" number per building per interval
  cheerSec: 1.3,
  unitsPerGuard: 8,
  // background
  roadMaxLen: 340,
  // budgets
  maxParticles: 420,
  maxFallen: 14,
  autoLowFxFrameMs: 27,     // sustained frame time above this switches to reduced effects
};
