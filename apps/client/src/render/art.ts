// Original procedural art for BROCCOLI. Everything is drawn with canvas paths; no external assets.
import type { BuildingType } from '../../../../packages/simulation/src/index';

export const TILT = 0.78; // vertical squash of the ground plane (2.5D look)
export const TEAM = ['#2fbf71', '#e5484d', '#3b9eff', '#a070ff'];
export const TEAM_DARK = ['#1c7a47', '#9c2327', '#1f63b0', '#6337c4'];
export const NEUTRAL = '#cfc8b4';
export const NEUTRAL_DARK = '#857f6c';
export const colorOf = (owner: number) => (owner < 0 ? NEUTRAL : TEAM[owner % 4]);
export const darkOf = (owner: number) => (owner < 0 ? NEUTRAL_DARK : TEAM_DARK[owner % 4]);

type Ctx = CanvasRenderingContext2D;
const ell = (c: Ctx, x: number, y: number, rx: number, ry: number) => { c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); };
const circ = (c: Ctx, x: number, y: number, r: number) => { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); };

export function shadow(c: Ctx, x: number, y: number, rx: number, ry: number, a = 0.22) {
  c.fillStyle = `rgba(10,30,15,${a})`; ell(c, x, y, rx, ry); c.fill();
}

let flagRaise = 1; // 0..1: how far up the pole the flag is (animated when a building changes owner)
function flag(c: Ctx, x: number, y: number, owner: number, t: number) {
  c.strokeStyle = '#5b4a2e'; c.lineWidth = 3; c.lineCap = 'round';
  c.beginPath(); c.moveTo(x, y); c.lineTo(x, y - 30); c.stroke();
  const w = Math.sin(t * 5 + x) * 3;
  c.save(); c.translate(0, (1 - flagRaise) * 17);
  c.fillStyle = colorOf(owner); c.strokeStyle = darkOf(owner); c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(x, y - 30); c.quadraticCurveTo(x + 12, y - 30 + w, x + 22, y - 23 + w); c.quadraticCurveTo(x + 11, y - 18 + w, x, y - 15); c.closePath();
  c.fill(); c.stroke();
  emblemShape(c, x + 8, y - 23 + w * 0.5, 2.6, owner, owner < 0 ? '#857f6c' : '#fff');
  c.restore();
}

function baseRing(c: Ctx, owner: number) {
  const rx = 54, ry = 54 * TILT * 0.55;
  if (owner >= 0) { c.fillStyle = colorOf(owner); c.globalAlpha = 0.22; ell(c, 0, 0, rx + 12, ry + 6); c.fill(); }
  c.fillStyle = owner < 0 ? '#a9a48f' : colorOf(owner); c.globalAlpha = owner < 0 ? 0.35 : 0.6; ell(c, 0, 0, rx, ry); c.fill();
  c.globalAlpha = 1; c.strokeStyle = owner < 0 ? 'rgba(90,86,70,.7)' : darkOf(owner); c.lineWidth = owner < 0 ? 2.5 : 4; ell(c, 0, 0, rx, ry); c.stroke();
  if (owner >= 0) { c.strokeStyle = 'rgba(255,255,255,.55)'; c.lineWidth = 1.5; ell(c, 0, 0, rx - 5, ry - 3); c.stroke(); }
}

const GREENS = ['#226b30', '#2f8f3f', '#4db85a'], DULL = ['#5d6b52', '#7b8a6c', '#9aa88b'];
function floret(c: Ctx, x: number, y: number, r: number, pal = GREENS) {
  c.fillStyle = pal[0]; circ(c, x, y + r * 0.18, r); c.fill();
  c.fillStyle = pal[1]; circ(c, x, y, r); c.fill();
  c.fillStyle = pal[2]; circ(c, x - r * 0.28, y - r * 0.3, r * 0.55); c.fill();
  c.fillStyle = 'rgba(255,255,255,.18)'; circ(c, x - r * 0.38, y - r * 0.42, r * 0.22); c.fill();
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

/** Sprout Farm: a stalk house under a broccoli crown that grows with each level. */
function farm(c: Ctx, level: number, owner: number, t: number) {
  const h = 34 + level * 5, w = 17 + level;
  c.fillStyle = '#cfc98f';
  c.beginPath(); c.moveTo(-w - 4, 0); c.quadraticCurveTo(-w, -h * 0.5, -w + 3, -h); c.lineTo(w - 3, -h); c.quadraticCurveTo(w, -h * 0.5, w + 4, 0); c.closePath(); c.fill();
  c.fillStyle = '#eee8c6';
  c.beginPath(); c.moveTo(-w + 2, 0); c.quadraticCurveTo(-w + 4, -h * 0.5, -w + 6, -h); c.lineTo(2, -h); c.lineTo(4, 0); c.closePath(); c.fill();
  c.strokeStyle = '#8f8a55'; c.lineWidth = 2;
  c.beginPath(); c.moveTo(-w - 4, 0); c.quadraticCurveTo(-w, -h * 0.5, -w + 3, -h); c.moveTo(w - 3, -h); c.quadraticCurveTo(w, -h * 0.5, w + 4, 0); c.stroke();
  c.fillStyle = '#5b4a2e'; c.beginPath(); c.moveTo(-7, 0); c.lineTo(-7, -13); c.arc(0, -13, 7, Math.PI, 0); c.lineTo(7, 0); c.closePath(); c.fill();
  c.fillStyle = '#ffe58a'; circ(c, w - 8, -h * 0.55, 3.5); c.fill();
  const r = 15 + level * 2.2, cy = -h - r * 0.55;
  const spots: [number, number, number][] = [[-r * 1.15, 6, 0.8], [r * 1.15, 6, 0.8], [0, 4, 1], [-r * 0.62, -r * 0.6, 0.9], [r * 0.62, -r * 0.6, 0.9]];
  if (level >= 2) spots.push([0, -r * 1.05, 0.85]);
  if (level >= 3) spots.push([-r * 1.7, -r * 0.2, 0.62], [r * 1.7, -r * 0.2, 0.62]);
  if (level >= 4) spots.push([-r * 1.1, -r * 1.2, 0.6], [r * 1.1, -r * 1.2, 0.6]);
  spots.sort((a, b) => a[1] - b[1]);
  const pal = owner < 0 ? DULL : GREENS;
  if (level >= 3) { floret(c, -w - 22, -9, 10, pal); c.fillStyle = '#b08a52'; c.fillRect(w + 8, -12, 4, 12); c.fillRect(w + 18, -12, 4, 12); c.fillRect(w + 6, -9, 18, 3); }
  for (const [x, y, s] of spots) floret(c, x, cy + y, r * s, pal);
  banner(c, -w + 5, -h + 3, 12, 17, owner);
  const top = cy - r * (level >= 2 ? 1.7 : 0.9);
  flag(c, 0, top, owner, t);
  if (level >= 4) { c.fillStyle = '#ffd95a'; c.strokeStyle = '#a8801d'; c.lineWidth = 1; circ(c, 0, top - 33, 4.5); c.fill(); c.stroke(); }
}

/** Thorn Tower: a tapering thorn stalk with a watch pod. */
function tower(c: Ctx, level: number, owner: number, t: number) {
  const h = 62 + level * 9;
  c.fillStyle = owner < 0 ? '#5d6b52' : '#3f6b2c';
  c.beginPath(); c.moveTo(-19, 0); c.quadraticCurveTo(-13, -h * 0.6, -11, -h); c.lineTo(11, -h); c.quadraticCurveTo(13, -h * 0.6, 19, 0); c.closePath(); c.fill();
  c.fillStyle = owner < 0 ? '#7f8d72' : '#5c9140';
  c.beginPath(); c.moveTo(-14, 0); c.quadraticCurveTo(-9, -h * 0.6, -8, -h); c.lineTo(0, -h); c.lineTo(-1, 0); c.closePath(); c.fill();
  c.fillStyle = '#e9dfb0'; c.strokeStyle = '#7a6f3c'; c.lineWidth = 1.2;
  const n = 2 + level;
  for (let i = 0; i < n; i++) {
    const y = -h * (0.18 + (0.62 * i) / n), s = i % 2 ? 1 : -1, x = s * (16 - (i / n) * 5);
    c.beginPath(); c.moveTo(x - s * 3, y - 5); c.lineTo(x + s * 13, y - 9); c.lineTo(x - s * 3, y + 4); c.closePath(); c.fill(); c.stroke();
  }
  c.fillStyle = colorOf(owner); c.fillRect(-14, -h * 0.5 - 5, 28, 10);
  banner(c, 0, -h * 0.5 + 5, 13, 18, owner);
  c.fillStyle = '#2c4f1f'; ell(c, 0, -h, 20, 8); c.fill();
  c.fillStyle = '#6fae4c';
  for (let i = -2; i <= 2; i++) { c.beginPath(); c.moveTo(i * 8 - 4, -h); c.lineTo(i * 8, -h - 13 - (i === 0 ? 4 : 0)); c.lineTo(i * 8 + 4, -h); c.closePath(); c.fill(); }
  flag(c, 0, -h - 12, owner, t);
}

/** Sun Forge: a warm clay dome with a glowing sun disc. */
function forge(c: Ctx, owner: number, t: number) {
  c.fillStyle = '#8a4f22'; c.beginPath(); c.moveTo(-34, 0); c.bezierCurveTo(-36, -52, 36, -52, 34, 0); c.closePath(); c.fill();
  c.fillStyle = '#c47a35'; c.beginPath(); c.moveTo(-28, 0); c.bezierCurveTo(-30, -46, 16, -48, 12, 0); c.closePath(); c.fill();
  c.fillStyle = colorOf(owner); c.fillRect(-34, -8, 68, 8);
  banner(c, 22, -30, 12, 17, owner);
  const gy = -24, pulse = 1 + Math.sin(t * 4) * 0.08;
  c.save(); c.translate(0, gy); c.rotate(t * 0.6);
  c.fillStyle = 'rgba(255,196,60,.9)';
  for (let i = 0; i < 8; i++) { c.rotate(Math.PI / 4); c.beginPath(); c.moveTo(-3.5, -11); c.lineTo(0, -20 * pulse); c.lineTo(3.5, -11); c.closePath(); c.fill(); }
  c.restore();
  c.fillStyle = '#ffd95a'; circ(c, 0, gy, 11); c.fill();
  c.fillStyle = '#fff3b8'; circ(c, -3, gy - 3, 4.5); c.fill();
  c.fillStyle = '#6b3d1a'; c.fillRect(16, -52, 9, 16);
  c.fillStyle = `rgba(255,220,150,${0.35 + 0.25 * Math.sin(t * 3)})`; circ(c, 20.5, -58 - ((t * 14) % 14), 4); c.fill();
  flag(c, -16, -40, owner, t);
}

export function drawBuilding(c: Ctx, type: BuildingType, level: number, owner: number, t: number, raise = 1) {
  flagRaise = raise;
  shadow(c, 6, 4, 46, 17);
  baseRing(c, owner);
  if (type === 'farm') farm(c, level, owner, t); else if (type === 'tower') tower(c, level, owner, t); else forge(c, owner, t);
}
export const buildingTop = (type: BuildingType, level: number) => (type === 'farm' ? 80 + level * 12 : type === 'tower' ? 80 + level * 9 : 62);

export const SOLDIER = { w: 34, h: 42, run: 4, attack: 2 };
export interface SoldierSheet { run: HTMLCanvasElement[]; attack: HTMLCanvasElement[]; hit: HTMLCanvasElement; fall: HTMLCanvasElement }
export const FALL = { w: 46, h: 30 };

/**
 * Original broccoli soldier, pre-rendered per team: floret head, stalk body, team tunic and shield, leaf-tipped spear.
 * run[0..3] is the march cycle (run[0] doubles as idle), attack[0..1] is wind-up and thrust.
 */
export function makeSoldierSheets(scale: number): SoldierSheet[] {
  const draw = (team: number, leg: number, bob: number, thrust: number, dazed = false): HTMLCanvasElement => {
    const cv = document.createElement('canvas'); cv.width = Math.ceil(SOLDIER.w * scale); cv.height = Math.ceil(SOLDIER.h * scale);
    const c = cv.getContext('2d')!; c.scale(scale, scale); c.lineJoin = 'round'; c.lineCap = 'round';
    const col = TEAM[team], dark = TEAM_DARK[team], y = bob;
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
    // shield with the team shape
    c.fillStyle = dark; circ(c, 9, 26 + y, 6.2); c.fill(); c.fillStyle = col; circ(c, 9, 26 + y, 4.9); c.fill();
    emblemShape(c, 9, 26 + y, 2.6, team, '#fff');
    // face
    if (dazed) {   // knocked silly: crossed eyes, no blood
      c.strokeStyle = '#16210f'; c.lineWidth = 1.3;
      for (const ex of [15.5, 20.3]) { c.beginPath(); c.moveTo(ex - 1.8, 17.8 + y); c.lineTo(ex + 1.8, 21.2 + y); c.moveTo(ex + 1.8, 17.8 + y); c.lineTo(ex - 1.8, 21.2 + y); c.stroke(); }
    } else {
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
    return cv;
  };
  const lying = (src: HTMLCanvasElement): HTMLCanvasElement => {
    const cv = document.createElement('canvas'); cv.width = Math.ceil(FALL.w * scale); cv.height = Math.ceil(FALL.h * scale);
    const c = cv.getContext('2d')!; c.scale(scale, scale);
    c.translate(4, 27); c.rotate(-Math.PI / 2 * 0.94); c.drawImage(src, -6, 0, SOLDIER.w, SOLDIER.h);
    return cv;
  };
  return TEAM.map((_, i) => {
    const hit = draw(i, 0.9, 1.5, -0.8, true);
    return {
      run: [draw(i, 1, 0, 0), draw(i, 0.2, -1.5, 0), draw(i, -1, 0, 0), draw(i, -0.2, -1.5, 0)],
      attack: [draw(i, 0.6, 0, -0.5), draw(i, -0.6, 1, 1)],
      hit, fall: lying(hit),
    };
  });
}

export function drawPond(c: Ctx, x: number, y: number, r: number) {
  const py = y * TILT, ry = r * TILT;
  c.fillStyle = '#d8c98b'; ell(c, x, py, r + 9, ry + 7); c.fill();
  c.fillStyle = '#2f86c9'; ell(c, x, py, r, ry); c.fill();
  c.fillStyle = '#58b3ec'; ell(c, x - 3, py - 3, r - 7, ry - 6); c.fill();
  c.strokeStyle = 'rgba(255,255,255,.55)'; c.lineWidth = 2.5; c.lineCap = 'round';
  c.beginPath(); c.ellipse(x - r * 0.25, py - ry * 0.25, r * 0.4, ry * 0.3, 0, Math.PI * 1.05, Math.PI * 1.5); c.stroke();
  c.beginPath(); c.ellipse(x + r * 0.2, py + ry * 0.3, r * 0.3, ry * 0.2, 0, 0.1, 1.2); c.stroke();
  c.fillStyle = '#3f9e4a'; ell(c, x + r * 0.45, py - ry * 0.1, 9, 5.5); c.fill();
  c.fillStyle = '#ff9ec4'; circ(c, x + r * 0.45, py - ry * 0.1 - 2, 2.6); c.fill();
}

export function drawRock(c: Ctx, x: number, y: number, r: number) {
  const py = y * TILT;
  shadow(c, x + 5, py + r * 0.35, r * 1.05, r * 0.4);
  const blob = (bx: number, by: number, br: number, a: string, b: string) => {
    c.fillStyle = a; c.beginPath(); c.moveTo(bx - br, by + br * 0.35); c.quadraticCurveTo(bx - br * 0.9, by - br, bx - br * 0.1, by - br * 1.05);
    c.quadraticCurveTo(bx + br, by - br * 0.9, bx + br, by + br * 0.35); c.closePath(); c.fill();
    c.fillStyle = b; c.beginPath(); c.moveTo(bx - br * 0.75, by - br * 0.1); c.quadraticCurveTo(bx - br * 0.6, by - br * 0.85, bx - br * 0.05, by - br * 0.9);
    c.quadraticCurveTo(bx - br * 0.2, by - br * 0.3, bx - br * 0.75, by - br * 0.1); c.fill();
  };
  blob(x + r * 0.35, py + 2, r * 0.6, '#7d8088', '#a4a8b0');
  blob(x - r * 0.2, py + 4, r * 0.85, '#8b8f97', '#b9bdc4');
  c.fillStyle = '#4c9a48'; ell(c, x - r * 0.5, py + r * 0.3, r * 0.3, r * 0.12); c.fill();
}

export function drawTree(c: Ctx, x: number, y: number, s: number, dark: boolean) {
  shadow(c, x + 6 * s, y + 2, 26 * s, 9 * s);
  c.fillStyle = '#6b4a2b'; c.fillRect(x - 5 * s, y - 30 * s, 10 * s, 32 * s);
  const cols = dark ? ['#17512a', '#1f6a35', '#2a8242'] : ['#22703a', '#2e8f48', '#44ad58'];
  c.fillStyle = cols[0]; circ(c, x, y - 50 * s, 30 * s); c.fill();
  c.fillStyle = cols[1]; circ(c, x - 14 * s, y - 44 * s, 20 * s); c.fill(); circ(c, x + 14 * s, y - 46 * s, 20 * s); c.fill();
  c.fillStyle = cols[2]; circ(c, x - 6 * s, y - 62 * s, 17 * s); c.fill();
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
