// Every visual tuning number in one place. Nothing here affects the rules; those live in balance.json.
export const VIS = {
  // camera framing around the buildings (world units)
  fitPad: { side: 125, top: 150, bottom: 112 },
  // minimum on-screen sizes in CSS px, so things stay readable on a small phone viewport
  soldierMinPx: 19,
  soldierMaxScale: 1.7,
  labelMinPx: 13.5,
  badgeMinPx: 12,
  // how a real unit count turns into drawn soldiers
  iconsOneToOne: 10,        // up to this many: one sprite per unit
  unitsPerExtraIcon: 5,     // beyond that: one more sprite per this many units
  maxIcons: 20,
  maxIconsLow: 9,           // reduced-effects mode
  formationWidth: 5,        // soldiers per rank
  spacingAcross: 15,
  spacingAlong: 14,
  // battle staging
  engageStart: 150,         // distance at which a hostile group starts fanning out around its target
  engageBlend: 80,
  battleRadius: 66,
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
