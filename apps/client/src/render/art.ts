// Original procedural art for BROCCOLI. Everything is drawn with canvas paths; no external assets.
import type { BuildingType } from '../../../../packages/simulation/src/index';

export const TILT = 0.78; // vertical squash of the ground plane (2.5D look)
// emerald (player) is pushed toward blue-green so it separates from the olive meadow; crimson enemy; stone neutral
export const TEAM = ['#12c98f', '#e43b4b', '#3b9eff', '#a070ff'];
export const TEAM_DARK = ['#07694a', '#8e1a26', '#1f63b0', '#6337c4'];
export const NEUTRAL = '#dcd7c8';      // light stone
export const NEUTRAL_DARK = '#8d887a';
export const colorOf = (owner: number) => (owner < 0 ? NEUTRAL : TEAM[owner % 4]);
export const darkOf = (owner: number) => (owner < 0 ? NEUTRAL_DARK : TEAM_DARK[owner % 4]);

type Ctx = CanvasRenderingContext2D;
const ell = (c: Ctx, x: number, y: number, rx: number, ry: number) => { c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); };
const circ = (c: Ctx, x: number, y: number, r: number) => { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); };

export function shadow(c: Ctx, x: number, y: number, rx: number, ry: number, a = 0.22) {
  c.fillStyle = `rgba(10,30,15,${a})`; ell(c, x, y, rx, ry); c.fill();
}

// ---------- materials ----------
const WOOD = '#b98a56', WOOD_D = '#84603a', WOOD_L = '#d9b07c';
const STONE = '#a8a69d', STONE_D = '#77756e', STONE_L = '#d3d1c8';
export const AMBER = '#ffb43a';

/** Warm timber wall with plank seams and a lit top edge. */
// owned buildings have their planks painted in the team colour; neutral ones are bare wood
const PAINT = ['#4fbf93', '#cf5c67', '#5f9fe0', '#9b7fe0'];
let paintOwner = -1;
function timber(c: Ctx, x: number, y: number, w: number, h: number) {
  c.fillStyle = paintOwner < 0 ? WOOD : PAINT[paintOwner % 4]; c.strokeStyle = WOOD_D; c.lineWidth = 1.6;
  c.beginPath(); c.roundRect(x, y, w, h, 4); c.fill(); c.stroke();
  c.strokeStyle = 'rgba(90,60,30,.55)'; c.lineWidth = 1;
  for (let px = x + 8; px < x + w - 3; px += 9) { c.beginPath(); c.moveTo(px, y + 3); c.lineTo(px, y + h - 2); c.stroke(); }
  c.strokeStyle = 'rgba(110,78,44,.5)';
  for (let i = 0; i < w / 14; i++) { const gx = x + 5 + i * 14, gy = y + 8 + ((i * 7) % (h - 12)); c.beginPath(); c.moveTo(gx, gy); c.lineTo(gx + 3, gy + 4); c.stroke(); }
  c.fillStyle = WOOD_L; c.fillRect(x + 2, y + 1.5, w - 4, 2.5);
}

/** Rough stone course: staggered blocks with light upper edges. */
function masonry(c: Ctx, xl: number, xr: number, y0: number, y1: number, taper = 0) {
  c.fillStyle = STONE; c.strokeStyle = STONE_D; c.lineWidth = 1.6;
  c.beginPath(); c.moveTo(xl, y1); c.lineTo(xl + taper, y0); c.lineTo(xr - taper, y0); c.lineTo(xr, y1); c.closePath(); c.fill(); c.stroke();
  const rows = Math.max(2, Math.round((y1 - y0) / 9));
  for (let r = 0; r < rows; r++) {
    const ya = y0 + ((y1 - y0) * r) / rows, k = r / rows, l = xl + taper * (1 - k), rr = xr - taper * (1 - k);
    c.strokeStyle = 'rgba(70,68,62,.6)'; c.lineWidth = 1;
    if (r) { c.beginPath(); c.moveTo(l, ya); c.lineTo(rr, ya); c.stroke(); }
    for (let x = l + (r % 2 ? 7 : 13); x < rr - 3; x += 13) { c.beginPath(); c.moveTo(x, ya); c.lineTo(x, ya + (y1 - y0) / rows); c.stroke(); }
    c.strokeStyle = 'rgba(255,255,245,.45)'; c.beginPath(); c.moveTo(l + 2, ya + 1.5); c.lineTo(rr - 2, ya + 1.5); c.stroke();
  }
}

let flagRaise = 1;      // 0..1: how far up the pole the flag is (lowered and raised when a building changes owner)
let flagOwner = -1;     // whose flag is on the pole right now (the old owner's while it comes down)
function flag(c: Ctx, x: number, y: number, _owner: number, t: number) {
  const owner = flagOwner;
  c.strokeStyle = '#5b4a2e'; c.lineWidth = 3; c.lineCap = 'round';
  c.beginPath(); c.moveTo(x, y); c.lineTo(x, y - 32); c.stroke();
  c.fillStyle = '#e9c46a'; circ(c, x, y - 33, 2.4); c.fill();
  const w = Math.sin(t * 5 + x) * 3;
  c.save(); c.translate(0, (1 - flagRaise) * 18);
  c.fillStyle = colorOf(owner); c.strokeStyle = darkOf(owner); c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(x, y - 31);
  // each team flies its own flag shape as well as its own colour
  const k = owner < 0 ? -1 : owner % 4;
  if (k === 0) { c.quadraticCurveTo(x + 13, y - 31 + w, x + 24, y - 23.5 + w); c.quadraticCurveTo(x + 12, y - 18 + w, x, y - 15); }            // pennant
  else if (k === 1) { c.lineTo(x + 24, y - 31 + w); c.lineTo(x + 17, y - 23 + w); c.lineTo(x + 24, y - 15 + w); c.lineTo(x, y - 15); }           // swallowtail
  else if (k === 2) { c.lineTo(x + 22, y - 31 + w); c.lineTo(x + 22, y - 15 + w); c.lineTo(x, y - 15); }                                         // square
  else if (k === 3) { c.lineTo(x + 20, y - 31 + w); c.quadraticCurveTo(x + 27, y - 23 + w, x + 20, y - 15 + w); c.lineTo(x, y - 15); }           // rounded
  else { c.lineTo(x + 16, y - 29 + w * 0.5); c.lineTo(x + 16, y - 19 + w * 0.5); c.lineTo(x, y - 17); }                                          // small plain
  c.closePath(); c.fill(); c.stroke();
  emblemShape(c, x + 8.5, y - 23 + w * 0.5, 2.7, owner, owner < 0 ? NEUTRAL_DARK : '#fff');
  c.restore();
}

/**
 * Ground the building sits on, instead of a uniform ring: the village has a small packed yard with stepping stones,
 * the tower stands on a rock outcrop, the forge on scorched earth and ash. Ownership shows as a soft glow in the
 * team colour plus the painted walls, banner and flag.
 */
function foundation(c: Ctx, type: BuildingType, owner: number) {
  if (owner >= 0) {
    const g = c.createRadialGradient(0, 0, 8, 0, 0, 74);
    g.addColorStop(0, hexA(TEAM[owner % 4], 0.5)); g.addColorStop(1, hexA(TEAM[owner % 4], 0));
    c.save(); c.scale(1, 0.5); c.fillStyle = g; circ(c, 0, 0, 74); c.fill(); c.restore();
  }
  if (type === 'farm') {
    c.fillStyle = '#b8995f'; c.beginPath(); c.moveTo(-50, 2); c.bezierCurveTo(-52, -16, -18, -24, 6, -22); c.bezierCurveTo(40, -21, 56, -8, 50, 6); c.bezierCurveTo(44, 20, -40, 22, -50, 2); c.fill();
    c.fillStyle = '#d2b57c'; c.beginPath(); c.ellipse(-2, 0, 40, 14, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = STONE_L; c.strokeStyle = STONE_D; c.lineWidth = 1;
    for (const [sx, sy] of [[-4, 9], [4, 15], [-2, 21]]) { c.beginPath(); c.ellipse(sx, sy, 5.5, 2.6, 0, 0, Math.PI * 2); c.fill(); c.stroke(); }
    c.fillStyle = WOOD_D; for (const px of [36, 44]) c.fillRect(px, -2, 2.5, 10);
  } else if (type === 'tower') {
    const rock = (x: number, y: number, r: number) => {
      c.fillStyle = STONE_D; c.beginPath(); c.moveTo(x - r, y + r * 0.3); c.lineTo(x - r * 0.7, y - r * 0.5); c.lineTo(x + r * 0.2, y - r * 0.7); c.lineTo(x + r, y - r * 0.2); c.lineTo(x + r * 0.8, y + r * 0.35); c.closePath(); c.fill();
      c.fillStyle = STONE; c.beginPath(); c.moveTo(x - r * 0.75, y + r * 0.1); c.lineTo(x - r * 0.55, y - r * 0.42); c.lineTo(x + r * 0.15, y - r * 0.58); c.lineTo(x + r * 0.5, y - r * 0.2); c.closePath(); c.fill();
      c.strokeStyle = STONE_L; c.lineWidth = 1.6; c.beginPath(); c.moveTo(x - r * 0.55, y - r * 0.42); c.lineTo(x + r * 0.15, y - r * 0.58); c.stroke();
    };
    rock(-30, 6, 18); rock(30, 7, 16); rock(0, 4, 30); rock(-14, 14, 12); rock(18, 15, 11);
  } else {
    const g = c.createRadialGradient(0, 0, 4, 0, 0, 58);
    g.addColorStop(0, 'rgba(40,32,28,.75)'); g.addColorStop(0.6, 'rgba(70,58,48,.45)'); g.addColorStop(1, 'rgba(90,80,70,0)');
    c.save(); c.scale(1, 0.45); c.fillStyle = g; circ(c, 0, 0, 58); c.fill(); c.restore();
    c.fillStyle = 'rgba(255,150,60,.75)'; for (const [ex, ey] of [[-30, 6], [24, 9], [34, -2], [-38, -3], [8, 13]]) { circ(c, ex, ey, 1.4); c.fill(); }
    c.fillStyle = 'rgba(200,195,185,.55)'; for (const [ex, ey] of [[-20, 12], [30, 4], [-44, 4]]) { c.beginPath(); c.ellipse(ex, ey, 6, 2.4, 0, 0, Math.PI * 2); c.fill(); }
  }
}
function hexA(hex: string, a: number): string { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }

function baseRing(c: Ctx, owner: number) {
  const rx = 56, ry = 56 * TILT * 0.55;
  if (owner >= 0) { c.fillStyle = colorOf(owner); c.globalAlpha = 0.2; ell(c, 0, 0, rx + 12, ry + 6); c.fill(); }
  c.fillStyle = owner < 0 ? '#c9c4b2' : colorOf(owner); c.globalAlpha = owner < 0 ? 0.4 : 0.62; ell(c, 0, 0, rx, ry); c.fill();
  c.globalAlpha = 1; c.strokeStyle = owner < 0 ? 'rgba(110,105,90,.75)' : darkOf(owner); c.lineWidth = owner < 0 ? 2.5 : 4; ell(c, 0, 0, rx, ry); c.stroke();
  if (owner >= 0) { c.strokeStyle = 'rgba(255,255,255,.55)'; c.lineWidth = 1.5; ell(c, 0, 0, rx - 5, ry - 3); c.stroke(); }
}

const GREENS = ['#1f6630', '#2f8f3f', '#56bf5f'], DULL = ['#5f6b55', '#7f8c70', '#a3ae93'];
/** One broccoli floret: volume from three tones plus a thin lit rim on the upper-left edge. */
function floret(c: Ctx, x: number, y: number, r: number, pal = GREENS) {
  c.fillStyle = pal[0]; circ(c, x, y + r * 0.2, r); c.fill();
  c.fillStyle = pal[1]; circ(c, x, y, r); c.fill();
  c.fillStyle = pal[2]; circ(c, x - r * 0.26, y - r * 0.28, r * 0.58); c.fill();
  c.strokeStyle = 'rgba(235,255,200,.5)'; c.lineWidth = 1.4; c.beginPath(); c.arc(x, y, r - 1, Math.PI * 1.05, Math.PI * 1.6); c.stroke();
}

/** Team banner hung on a building front: the strongest ownership cue after the ring. */
function banner(c: Ctx, x: number, y: number, w: number, h: number, owner: number) {
  if (owner < 0) return;
  c.fillStyle = colorOf(owner); c.strokeStyle = darkOf(owner); c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(x - w / 2, y); c.lineTo(x + w / 2, y); c.lineTo(x + w / 2, y + h); c.lineTo(x, y + h - w * 0.4); c.lineTo(x - w / 2, y + h); c.closePath();
  c.fill(); c.stroke();
  emblemShape(c, x, y + h * 0.36, w * 0.24, owner, '#fff');
}

/** Colour-blind aid: every owner has its own shape (circle, triangle, square, diamond). */
export function emblemShape(c: Ctx, x: number, y: number, r: number, owner: number, fill: string) {
  c.fillStyle = fill; c.beginPath();
  if (owner < 0) c.arc(x, y, r * 0.6, 0, 7);
  else if (owner % 4 === 0) c.arc(x, y, r, 0, 7);
  else if (owner % 4 === 1) { c.moveTo(x, y - r * 1.1); c.lineTo(x + r * 1.1, y + r * 0.9); c.lineTo(x - r * 1.1, y + r * 0.9); }
  else if (owner % 4 === 2) c.rect(x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8);
  else { c.moveTo(x, y - r * 1.25); c.lineTo(x + r * 1.1, y); c.lineTo(x, y + r * 1.25); c.lineTo(x - r * 1.1, y); }
  c.closePath(); c.fill();
}

function door(c: Ctx, x: number, w: number, h: number) {
  c.fillStyle = '#5a3d22'; c.strokeStyle = WOOD_L; c.lineWidth = 1.6;
  c.beginPath(); c.moveTo(x - w, 0); c.lineTo(x - w, -h + w); c.arc(x, -h + w, w, Math.PI, 0); c.lineTo(x + w, 0); c.closePath(); c.fill(); c.stroke();
  c.strokeStyle = 'rgba(30,18,8,.6)'; c.lineWidth = 1; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, -h); c.stroke();
  c.fillStyle = '#e9c46a'; circ(c, x + w * 0.45, -h * 0.42, 1.3); c.fill();
}

/**
 * Sprout Village: a low timber hall under a wide broccoli roof. Each level changes the outline:
 * L2 adds a side wing, L3 a second wing and a fence, L4 a taller crown with a golden finial.
 */
function farm(c: Ctx, level: number, owner: number, t: number) {
  const pal = owner < 0 ? DULL : GREENS, w = 27 + level, h = 27;
  const r = 13.5 + level * 0.8, y0 = -h - 9, top = y0 - r * (level >= 4 ? 3.3 : 2.5);
  if (pass === DYNAMIC) { flag(c, 0, top, owner, t); return; }
  if (level >= 3) {                                        // left wing
    timber(c, -w - 21, -17, 24, 17); floret(c, -w - 15, -21, 9, pal); floret(c, -w - 4, -22, 9, pal);
    c.fillStyle = WOOD_D; for (let i = 0; i < 3; i++) c.fillRect(-w - 34 + i * 6, 2, 2.5, 9);
    c.fillRect(-w - 35, 4, 17, 2);
  }
  if (level >= 2) {                                        // right wing
    timber(c, w - 3, -19, 25, 19); floret(c, w + 4, -23, 10, pal); floret(c, w + 16, -24, 10, pal);
    c.fillStyle = '#ffe58a'; c.fillRect(w + 7, -13, 6, 6); c.strokeStyle = WOOD_D; c.lineWidth = 1; c.strokeRect(w + 7, -13, 6, 6);
  }
  timber(c, -w, -h, w * 2, h);
  door(c, -3, 7.5, 19);
  c.fillStyle = '#ffe58a'; c.strokeStyle = WOOD_D; c.lineWidth = 1.2; circ(c, w - 10, -15, 4); c.fill(); c.stroke();
  // green eave under the roof
  c.fillStyle = owner < 0 ? '#6f7b63' : '#3a8a3d'; c.beginPath(); c.roundRect(-w - 6, -h - 5, w * 2 + 12, 8, 4); c.fill();
  // wide, low broccoli roof
  const n = 5, spread = (w + 9) * 2;
  for (let i = 0; i < n; i++) floret(c, -spread / 2 + (spread * i) / (n - 1), y0 - (i === 0 || i === n - 1 ? 0 : 3), r, pal);
  for (let i = 0; i < 4; i++) floret(c, -spread * 0.36 + (spread * 0.72 * i) / 3, y0 - r * 0.95, r * 0.95, pal);
  for (let i = 0; i < (level >= 4 ? 3 : 2); i++) floret(c, (i - (level >= 4 ? 1 : 0.5)) * r * 1.25, y0 - r * 1.85, r * 0.9, pal);
  if (level >= 4) floret(c, 0, y0 - r * 2.7, r * 0.85, pal);
  banner(c, -w + 8, -h + 4, 11, 16, owner);
  if (pass !== STATIC) flag(c, 0, top, owner, t);
  if (level >= 4) { c.fillStyle = '#ffd95a'; c.strokeStyle = '#a8801d'; c.lineWidth = 1; circ(c, 0, top - 36, 4); c.fill(); c.stroke(); }
}

let towerAim = 0, towerTension = 0;
/**
 * Thorn Tower: a tall stalk on a stone base with a turning launcher head. L2 adds a throwing platform,
 * L3 a wider platform and more thorns, L4 a stone crown.
 */
function tower(c: Ctx, level: number, owner: number, t: number) {
  const h = 66 + level * 9, dull = owner < 0;
  if (pass !== DYNAMIC) {
  masonry(c, -26, 26, -24, 0, 6);
  c.fillStyle = dull ? '#5f6b55' : '#3f6b2c';
  c.beginPath(); c.moveTo(-15, -24); c.quadraticCurveTo(-11, -h * 0.65, -10, -h); c.lineTo(10, -h); c.quadraticCurveTo(11, -h * 0.65, 15, -24); c.closePath(); c.fill();
  c.fillStyle = dull ? '#84907a' : '#5f9643';
  c.beginPath(); c.moveTo(-11, -24); c.quadraticCurveTo(-8, -h * 0.65, -7, -h); c.lineTo(0, -h); c.lineTo(-1, -24); c.closePath(); c.fill();
  c.fillStyle = '#ece3b6'; c.strokeStyle = '#7a6f3c'; c.lineWidth = 1.2;
  const n = 1 + level;
  for (let i = 0; i < n; i++) {
    const y = -30 - ((h - 44) * i) / n, s = i % 2 ? 1 : -1, x = s * (13 - (i / n) * 3);
    c.beginPath(); c.moveTo(x - s * 3, y - 5); c.lineTo(x + s * 13, y - 9); c.lineTo(x - s * 3, y + 4); c.closePath(); c.fill(); c.stroke();
  }
  c.fillStyle = colorOf(owner); c.strokeStyle = darkOf(owner); c.lineWidth = 1.2; c.beginPath(); c.roundRect(-13.5, -h * 0.55 - 5, 27, 10, 3); c.fill(); c.stroke();
  banner(c, 0, -h * 0.55 + 5, 12, 16, owner);
  if (level >= 2) {                                        // throwing platform
    const pw = level >= 3 ? 27 : 22;
    c.fillStyle = WOOD_D; ell(c, 0, -h + 5, pw, 8); c.fill();
    c.fillStyle = WOOD; ell(c, 0, -h + 2, pw, 8); c.fill();
    c.strokeStyle = WOOD_L; c.lineWidth = 1.5; ell(c, 0, -h + 2, pw - 2, 6.5); c.stroke();
    c.fillStyle = WOOD_D; for (const px of [-pw + 3, -pw / 2, pw / 2, pw - 3]) c.fillRect(px - 1.2, -h - 8, 2.4, 9);
    if (level >= 4) { c.fillStyle = STONE; c.strokeStyle = STONE_D; c.lineWidth = 1; for (const px of [-pw + 1, pw - 9]) { c.beginPath(); c.roundRect(px, -h - 13, 8, 8, 2); c.fill(); c.stroke(); } }
  }
  }
  if (pass === STATIC) return;
  flag(c, -7, -h - 4, owner, t);
  // launcher head: turns toward the enemy, pulls back before a shot
  c.save(); c.translate(0, -h - 9);
  c.fillStyle = dull ? '#6f7b63' : '#2c5a26'; circ(c, 0, 2, 11); c.fill();
  c.fillStyle = dull ? '#93a086' : '#4f8f3d'; circ(c, -2, -1, 8); c.fill();
  c.rotate(towerAim);
  const pull = towerTension * 7;
  c.strokeStyle = WOOD_D; c.lineWidth = 3; c.lineCap = 'round';
  c.beginPath(); c.moveTo(4, -11); c.quadraticCurveTo(10 - pull * 0.5, 0, 4, 11); c.stroke();                     // bow arms
  c.strokeStyle = '#f4ecc4'; c.lineWidth = 1; c.beginPath(); c.moveTo(4, -11); c.lineTo(2 - pull, 0); c.lineTo(4, 11); c.stroke();   // string
  c.fillStyle = '#fff7cf'; c.strokeStyle = '#6d6335'; c.lineWidth = 1.2;
  c.beginPath(); c.moveTo(20 - pull, 0); c.lineTo(4 - pull, -3.5); c.lineTo(7 - pull, 0); c.lineTo(4 - pull, 3.5); c.closePath(); c.fill(); c.stroke();   // loaded thorn
  c.restore();
}

/** Sun Forge: a wide stone hall with an amber furnace mouth and a smoking chimney. */
function forge(c: Ctx, owner: number, t: number) {
  if (pass !== DYNAMIC) {
    masonry(c, 20, 36, -64, -24, 1.5);                     // chimney
    c.fillStyle = STONE_D; c.fillRect(18, -67, 20, 5);
    masonry(c, -42, 42, -30, 0, 4);
    // timber roof
    c.fillStyle = WOOD_D; c.beginPath(); c.moveTo(-46, -28); c.lineTo(-30, -47); c.lineTo(22, -47); c.lineTo(46, -28); c.closePath(); c.fill();
    c.fillStyle = WOOD; c.beginPath(); c.moveTo(-42, -30); c.lineTo(-29, -44); c.lineTo(20, -44); c.lineTo(40, -30); c.closePath(); c.fill();
    c.strokeStyle = 'rgba(90,60,30,.55)'; c.lineWidth = 1; for (let x = -30; x < 34; x += 9) { c.beginPath(); c.moveTo(x, -31); c.lineTo(x + 3, -43); c.stroke(); }
    c.fillStyle = WOOD_L; c.fillRect(-28, -45.5, 48, 2.2);
    c.fillStyle = '#3b2412'; c.strokeStyle = STONE_L; c.lineWidth = 2;   // furnace mouth
    c.beginPath(); c.moveTo(-17, 0); c.lineTo(-17, -12); c.arc(-4, -12, 13, Math.PI, 0); c.lineTo(9, 0); c.closePath(); c.fill(); c.stroke();
    c.fillStyle = '#ffd95a'; c.strokeStyle = '#a8801d'; c.lineWidth = 1.2; circ(c, -4, -36.5, 5.5); c.fill(); c.stroke();
    c.fillStyle = colorOf(owner); c.fillRect(-42, -3, 84, 3.5);
    banner(c, -31, -27, 12, 16, owner);
  }
  if (pass === STATIC) return;
  // live parts: chimney smoke, the amber fire and its glow, embers, the flag
  for (let i = 0; i < 3; i++) {
    const k = ((t * 0.45 + i / 3) % 1);
    c.fillStyle = `rgba(235,232,222,${0.5 * (1 - k)})`; circ(c, 28 + Math.sin(t + i * 2) * 4 * k + k * 8, -70 - k * 30, 5 + k * 8); c.fill();
  }
  const glow = 0.75 + 0.25 * Math.sin(t * 5);
  c.fillStyle = `rgba(255,190,70,${0.16 * glow})`; circ(c, -4, -9, 27); c.fill();
  c.fillStyle = `rgba(255,214,110,${0.2 * glow})`; circ(c, -4, -9, 17); c.fill();
  c.fillStyle = AMBER; c.beginPath(); c.moveTo(-13, 0); c.quadraticCurveTo(-12, -13 * glow, -7, -6); c.quadraticCurveTo(-4, -19 * glow, 0, -7); c.quadraticCurveTo(3, -13 * glow, 5, 0); c.closePath(); c.fill();
  c.fillStyle = '#fff1a8'; c.beginPath(); c.moveTo(-8, 0); c.quadraticCurveTo(-4, -10 * glow, 0, 0); c.closePath(); c.fill();
  for (let i = 0; i < 3; i++) { const k = (t * 0.9 + i * 0.37) % 1; c.fillStyle = `rgba(255,200,90,${1 - k})`; circ(c, -4 + Math.sin(i * 3 + t * 2) * 7, -14 - k * 22, 1.6); c.fill(); }
  flag(c, -20, -45, owner, t);
}

export interface BuildingLook { raise?: number; flagOwner?: number; aim?: number; tension?: number; low?: boolean; cacheScale?: number }
const ALL = 0, STATIC = 1, DYNAMIC = 2;
let pass = ALL;
// The unchanging part of each building (walls, roof, ring, shadows) is painted once per type/level/owner and reused;
// only flags, the tower head, fire and smoke are drawn every frame.
const bodyCache = new Map<string, HTMLCanvasElement>();
const BOX = { w: 250, h: 280, cx: 125, cy: 222 };
export function clearBuildingCache(): void { bodyCache.clear(); }
function body(c: Ctx, type: BuildingType, level: number, owner: number, t: number, low: boolean) {
  shadow(c, 9, 5, 58, 19, 0.2);                 // soft cast shadow
  if (!low) shadow(c, 0, 2, 44, 13, 0.3);       // tight contact shadow: the building sits on the ground
  foundation(c, type, owner);
  if (type === 'farm') farm(c, level, owner, t); else if (type === 'tower') tower(c, level, owner, t); else forge(c, owner, t);
}
export function drawBuilding(c: Ctx, type: BuildingType, level: number, owner: number, t: number, look: BuildingLook = {}) {
  flagRaise = look.raise ?? 1; flagOwner = look.flagOwner ?? owner; towerAim = look.aim ?? 0; towerTension = look.tension ?? 0; paintOwner = owner;
  const S = look.cacheScale ?? 0;
  if (!S) { pass = ALL; body(c, type, level, owner, t, !!look.low); return; }
  const key = `${type}${level}_${owner}_${look.low ? 1 : 0}_${S}`;
  let img = bodyCache.get(key);
  if (!img) {
    img = document.createElement('canvas'); img.width = Math.ceil(BOX.w * S); img.height = Math.ceil(BOX.h * S);
    const cc = img.getContext('2d')!; cc.scale(S, S); cc.translate(BOX.cx, BOX.cy);
    pass = STATIC; body(cc, type, level, owner, 0, !!look.low);
    bodyCache.set(key, img);
  }
  c.drawImage(img, -BOX.cx, -BOX.cy, BOX.w, BOX.h);
  pass = DYNAMIC;
  if (type === 'farm') farm(c, level, owner, t); else if (type === 'tower') tower(c, level, owner, t); else forge(c, owner, t);
  pass = ALL;
}
export const buildingTop = (type: BuildingType, level: number) => (type === 'farm' ? 96 + level * 5 + (level >= 4 ? 14 : 0) : type === 'tower' ? 112 + level * 9 : 82);

export const SOLDIER = { w: 34, h: 42, run: 4, attack: 2 };
/** run = side view (flipped for left), runF = walking toward the camera, runB = walking away from it. */
export interface SoldierSheet { run: HTMLCanvasElement[]; runF: HTMLCanvasElement[]; runB: HTMLCanvasElement[]; attack: HTMLCanvasElement[]; hit: HTMLCanvasElement; fall: HTMLCanvasElement }
export const FALL = { w: 46, h: 30 };

/**
 * Original broccoli soldier, pre-rendered per team: floret head, stalk body, team tunic and shield, leaf-tipped spear.
 * run[0..3] is the march cycle (run[0] doubles as idle), attack[0..1] is wind-up and thrust.
 */
/** Dark 1px rim around a sprite so a soldier reads against grass, dirt and effects alike. */
function outline(src: HTMLCanvasElement, scale: number): HTMLCanvasElement {
  const sil = document.createElement('canvas'); sil.width = src.width; sil.height = src.height;
  const s = sil.getContext('2d')!; s.drawImage(src, 0, 0); s.globalCompositeOperation = 'source-in'; s.fillStyle = '#0c2116'; s.fillRect(0, 0, sil.width, sil.height);
  const out = document.createElement('canvas'); out.width = src.width; out.height = src.height;
  const c = out.getContext('2d')!, d = 1.1 * scale;
  for (let k = 0; k < 8; k++) c.drawImage(sil, Math.round(Math.cos(k * Math.PI / 4) * d), Math.round(Math.sin(k * Math.PI / 4) * d));
  c.drawImage(src, 0, 0);
  return out;
}

/** Bake the contact shadow and the team-coloured footing under the soldier, so the renderer draws one image per soldier. */
function grounded(src: HTMLCanvasElement, team: number, scale: number): HTMLCanvasElement {
  const out = document.createElement('canvas'); out.width = src.width; out.height = src.height;
  const c = out.getContext('2d')!; c.scale(scale, scale);
  c.fillStyle = 'rgba(10,30,15,.32)'; c.beginPath(); c.ellipse(17.5, 39.4, 10, 2.5, 0, 0, Math.PI * 2); c.fill();
  c.fillStyle = team < 4 ? TEAM[team] : NEUTRAL; c.globalAlpha = 0.6; c.beginPath(); c.ellipse(16.5, 39, 8, 2.4, 0, 0, Math.PI * 2); c.fill();
  c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.drawImage(src, 0, 0);
  return out;
}

export function makeSoldierSheets(scale: number): SoldierSheet[] {
  const draw = (team: number, leg: number, bob: number, thrust: number, dazed = false, view = 0): HTMLCanvasElement => {
    const cv = document.createElement('canvas'); cv.width = Math.ceil(SOLDIER.w * scale); cv.height = Math.ceil(SOLDIER.h * scale);
    const c = cv.getContext('2d')!; c.scale(scale, scale); c.lineJoin = 'round'; c.lineCap = 'round';
    const col = team < 4 ? TEAM[team] : NEUTRAL, dark = team < 4 ? TEAM_DARK[team] : NEUTRAL_DARK, y = bob;
    // legs
    c.strokeStyle = '#3f6b2c'; c.lineWidth = 3.4;
    c.beginPath(); c.moveTo(13, 30 + y); c.lineTo(13 - leg * 3.5, 39); c.moveTo(19, 30 + y); c.lineTo(19 + leg * 3.5, 39); c.stroke();
    c.fillStyle = '#2b2416'; ell(c, 13 - leg * 3.5 + 1, 39.6, 3, 1.7); c.fill(); ell(c, 19 + leg * 3.5 + 1, 39.6, 3, 1.7); c.fill();
    // spear (behind the body when resting, forward on thrust)
    const sx = 23 + thrust * 6, sy = 22 + y;
    c.strokeStyle = '#7a5a34'; c.lineWidth = 2.2; c.beginPath(); c.moveTo(sx - 9, sy + 9 - thrust * 5); c.lineTo(sx + 8, sy - 12 + thrust * 9); c.stroke();
    c.fillStyle = '#eaf6c9'; c.strokeStyle = '#6a8a3a'; c.lineWidth = 1;
    c.save(); c.translate(sx + 8, sy - 12 + thrust * 9); c.rotate(Math.atan2(-21 + thrust * 14, 17));
    c.beginPath(); c.moveTo(7, 0); c.quadraticCurveTo(1, -4, -2, 0); c.quadraticCurveTo(1, 4, 7, 0); c.fill(); c.stroke(); c.restore();
    // body: pale stalk with a team tunic
    c.fillStyle = '#dfe8b4'; c.strokeStyle = '#7d8f4f'; c.lineWidth = 1.2;
    c.beginPath(); c.roundRect(10, 17 + y, 12, 15, 5); c.fill(); c.stroke();
    c.fillStyle = col; c.strokeStyle = dark; c.beginPath(); c.roundRect(9.5, 23 + y, 13, 8.5, 3); c.fill(); c.stroke();
    // leaf shield with the team shape (on the back when walking away)
    if (view !== 2) {
    c.fillStyle = dark; c.beginPath(); c.moveTo(9, 18.5 + y); c.quadraticCurveTo(17, 25 + y, 9, 34 + y); c.quadraticCurveTo(1, 25 + y, 9, 18.5 + y); c.fill();
    c.fillStyle = col; c.beginPath(); c.moveTo(9, 20 + y); c.quadraticCurveTo(15.3, 25.5 + y, 9, 32.5 + y); c.quadraticCurveTo(2.7, 25.5 + y, 9, 20 + y); c.fill();
    c.strokeStyle = 'rgba(255,255,255,.55)'; c.lineWidth = 0.9; c.beginPath(); c.moveTo(9, 21 + y); c.lineTo(9, 31.5 + y); c.stroke();
    emblemShape(c, 9, 26 + y, 2.3, team < 4 ? team : -1, team < 4 ? '#fff' : NEUTRAL_DARK);
    } else {
      c.fillStyle = dark; c.beginPath(); c.moveTo(16, 18 + y); c.quadraticCurveTo(26, 25 + y, 16, 35 + y); c.quadraticCurveTo(6, 25 + y, 16, 18 + y); c.fill();
      c.fillStyle = col; c.beginPath(); c.moveTo(16, 19.5 + y); c.quadraticCurveTo(24, 25.5 + y, 16, 33.5 + y); c.quadraticCurveTo(8, 25.5 + y, 16, 19.5 + y); c.fill();
      emblemShape(c, 16, 26 + y, 2.6, team < 4 ? team : -1, team < 4 ? '#fff' : NEUTRAL_DARK);
    }
    // face
    if (dazed) {   // knocked silly: crossed eyes, no blood
      c.strokeStyle = '#16210f'; c.lineWidth = 1.3;
      for (const ex of [15.5, 20.3]) { c.beginPath(); c.moveTo(ex - 1.8, 17.8 + y); c.lineTo(ex + 1.8, 21.2 + y); c.moveTo(ex + 1.8, 17.8 + y); c.lineTo(ex - 1.8, 21.2 + y); c.stroke(); }
    } else if (view === 1) {   // facing the camera
      c.fillStyle = '#fff'; circ(c, 13.6, 19.5 + y, 2.3); c.fill(); circ(c, 18.6, 19.5 + y, 2.3); c.fill();
      c.fillStyle = '#16210f'; circ(c, 13.8, 20 + y, 1.2); c.fill(); circ(c, 18.4, 20 + y, 1.2); c.fill();
    } else if (view === 0) {
      c.fillStyle = '#fff'; circ(c, 15.5, 19.5 + y, 2.3); c.fill(); circ(c, 20.3, 19.5 + y, 2.1); c.fill();
      c.fillStyle = '#16210f'; circ(c, 16.3, 19.8 + y, 1.15); c.fill(); circ(c, 20.9, 19.8 + y, 1.05); c.fill();
    }
    // broccoli head with a team headband
    for (const [fx, fy, fr] of [[9.5, 11, 6], [22.5, 11, 6], [16, 7.5, 7.5], [12, 13, 5], [20, 13, 5]] as const) {
      c.fillStyle = '#1f6a2e'; circ(c, fx, fy + y + 0.8, fr); c.fill();
      c.fillStyle = '#34a046'; circ(c, fx, fy + y, fr - 0.6); c.fill();
      c.fillStyle = '#62c56a'; circ(c, fx - fr * 0.3, fy + y - fr * 0.3, fr * 0.45); c.fill();
    }
    c.fillStyle = col; c.strokeStyle = dark; c.lineWidth = 0.8; c.beginPath(); c.roundRect(9.5, 15 + y, 13.5, 3, 1.5); c.fill(); c.stroke();
    return grounded(outline(cv, scale), team, scale);
  };
  const lying = (src: HTMLCanvasElement): HTMLCanvasElement => {
    const cv = document.createElement('canvas'); cv.width = Math.ceil(FALL.w * scale); cv.height = Math.ceil(FALL.h * scale);
    const c = cv.getContext('2d')!; c.scale(scale, scale);
    c.translate(4, 27); c.rotate(-Math.PI / 2 * 0.94); c.drawImage(src, -6, 0, SOLDIER.w, SOLDIER.h);
    return cv;
  };
  // sheets 0-3 are the teams, sheet 4 is the neutral (stone) garrison
  return [0, 1, 2, 3, 4].map(i => {
    const hit = draw(i, 0.9, 1.5, -0.8, true);
    return {
      run: [draw(i, 1, 0, 0), draw(i, 0.2, -1.5, 0), draw(i, -1, 0, 0), draw(i, -0.2, -1.5, 0)],
      runF: [1, 0.2, -1, -0.2].map((l, k) => draw(i, l * 0.6, k % 2 ? -1.5 : 0, 0, false, 1)),
      runB: [1, 0.2, -1, -0.2].map((l, k) => draw(i, l * 0.6, k % 2 ? -1.5 : 0, 0, false, 2)),
      attack: [draw(i, 0.6, 0, -0.5), draw(i, -0.6, 1, 1)],
      hit, fall: lying(hit),
    };
  });
}

export function drawPond(c: Ctx, x: number, y: number, r: number) {
  const py = y * TILT, ry = r * TILT;
  c.fillStyle = 'rgba(70,58,30,.28)'; ell(c, x + 2, py + 5, r + 13, ry + 10); c.fill();          // damp earth
  c.fillStyle = '#d9c992'; ell(c, x, py, r + 10, ry + 8); c.fill();                              // sandy bank
  c.fillStyle = '#c2b077'; ell(c, x, py + 1.5, r + 4, ry + 3.5); c.fill();                       // wet edge
  const g = c.createRadialGradient(x, py, r * 0.15, x, py, r);
  g.addColorStop(0, '#2f7fb3'); g.addColorStop(0.7, '#4ea5cf'); g.addColorStop(1, 'rgba(150,222,226,.85)');   // shallow, clearer rim
  c.save(); c.translate(x, py); c.scale(1, TILT); c.translate(-x, -py);
  c.fillStyle = g; circ(c, x, py, r); c.fill(); c.restore();
  c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = 1.6; ell(c, x, py, r - 1.5, ry - 1.5); c.stroke();
  // reeds and a lily pad on the bank
  c.strokeStyle = '#4f8a3a'; c.lineWidth = 2; c.lineCap = 'round';
  for (const [dx, hh] of [[-r * 0.86, 15], [-r * 0.74, 21], [-r * 0.62, 13], [r * 0.8, 17], [r * 0.9, 11]] as const) {
    c.beginPath(); c.moveTo(x + dx, py + ry * 0.45); c.quadraticCurveTo(x + dx + 3, py + ry * 0.45 - hh * 0.6, x + dx + 1, py + ry * 0.45 - hh); c.stroke();
  }
  c.fillStyle = '#4c9e4a'; ell(c, x + r * 0.42, py - ry * 0.12, 9, 5.5); c.fill();
  c.fillStyle = '#ff9ec4'; circ(c, x + r * 0.42, py - ry * 0.12 - 2, 2.6); c.fill();
}

export function drawRock(c: Ctx, x: number, y: number, r: number) {
  const py = y * TILT;
  shadow(c, x + 6, py + r * 0.36, r * 1.1, r * 0.4, 0.22);
  shadow(c, x, py + r * 0.32, r * 0.85, r * 0.22, 0.3);
  const chunk = (bx: number, by: number, br: number) => {
    c.fillStyle = STONE_D; c.beginPath(); c.moveTo(bx - br, by + br * 0.35); c.lineTo(bx - br * 0.85, by - br * 0.55); c.lineTo(bx - br * 0.2, by - br);
    c.lineTo(bx + br * 0.55, by - br * 0.8); c.lineTo(bx + br, by - br * 0.1); c.lineTo(bx + br * 0.9, by + br * 0.35); c.closePath(); c.fill();
    c.fillStyle = STONE; c.beginPath(); c.moveTo(bx - br * 0.8, by + br * 0.2); c.lineTo(bx - br * 0.7, by - br * 0.5); c.lineTo(bx - br * 0.15, by - br * 0.9);
    c.lineTo(bx + br * 0.45, by - br * 0.7); c.lineTo(bx + br * 0.3, by + br * 0.1); c.closePath(); c.fill();
    c.strokeStyle = STONE_L; c.lineWidth = 1.8; c.lineJoin = 'round';
    c.beginPath(); c.moveTo(bx - br * 0.7, by - br * 0.5); c.lineTo(bx - br * 0.15, by - br * 0.9); c.lineTo(bx + br * 0.45, by - br * 0.7); c.stroke();
    c.strokeStyle = 'rgba(60,58,52,.5)'; c.lineWidth = 1; c.beginPath(); c.moveTo(bx - br * 0.1, by - br * 0.4); c.lineTo(bx + br * 0.1, by + br * 0.05); c.stroke();
  };
  chunk(x + r * 0.4, py + 2, r * 0.6); chunk(x - r * 0.2, py + 4, r * 0.85);
  c.fillStyle = '#5c9a4a'; ell(c, x - r * 0.55, py + r * 0.3, r * 0.3, r * 0.12); c.fill();
}

export function drawTree(c: Ctx, x: number, y: number, s: number, dark: boolean) {
  shadow(c, x + 8 * s, y + 3, 30 * s, 10 * s, 0.2);
  shadow(c, x, y + 1, 11 * s, 4 * s, 0.34);                    // contact shadow at the trunk
  c.fillStyle = '#7a5632'; c.beginPath(); c.moveTo(x - 7 * s, y + 1); c.lineTo(x - 4.5 * s, y - 32 * s); c.lineTo(x + 4.5 * s, y - 32 * s); c.lineTo(x + 7 * s, y + 1); c.closePath(); c.fill();
  c.strokeStyle = 'rgba(60,38,18,.55)'; c.lineWidth = 1; c.beginPath(); c.moveTo(x - 1.5 * s, y - 2); c.lineTo(x - 1 * s, y - 28 * s); c.moveTo(x + 2.5 * s, y - 6); c.lineTo(x + 2 * s, y - 24 * s); c.stroke();
  const cols = dark ? ['#1d5230', '#2a6b3a', '#3c8448'] : ['#356f3a', '#4b8a47', '#6aa657'];
  const blob = (bx: number, by: number, r: number, k: number) => {
    c.fillStyle = cols[k]; circ(c, bx, by, r); c.fill();
    c.strokeStyle = 'rgba(225,245,180,.38)'; c.lineWidth = 1.5; c.beginPath(); c.arc(bx, by, r - 1, Math.PI * 1.05, Math.PI * 1.55); c.stroke();
  };
  blob(x, y - 50 * s, 30 * s, 0); blob(x - 15 * s, y - 44 * s, 20 * s, 1); blob(x + 15 * s, y - 46 * s, 20 * s, 1); blob(x - 6 * s, y - 63 * s, 17 * s, 2);
}

/** Calm moving water: drifting ripples and a glint, drawn every frame over the painted pond. */
export function drawWater(c: Ctx, x: number, y: number, r: number, t: number) {
  const py = y * TILT, ry = r * TILT;
  c.save(); c.beginPath(); c.ellipse(x, py, r - 2, ry - 2, 0, 0, Math.PI * 2); c.clip();
  c.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    const k = ((t * 0.16 + i / 3) % 1), rr = 6 + k * r * 0.95;
    c.strokeStyle = `rgba(255,255,255,${0.32 * (1 - k)})`; c.lineWidth = 2;
    c.beginPath(); c.ellipse(x + r * 0.15, py + ry * 0.1, rr, rr * TILT, 0, 0, Math.PI * 2); c.stroke();
  }
  const gx = x - r * 0.3 + Math.sin(t * 0.7) * r * 0.25;
  c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = 2.5;
  c.beginPath(); c.moveTo(gx - 10, py - ry * 0.35); c.lineTo(gx + 8, py - ry * 0.35); c.stroke();
  c.beginPath(); c.moveTo(gx + 14, py - ry * 0.18); c.lineTo(gx + 24, py - ry * 0.18); c.stroke();
  c.restore();
}
