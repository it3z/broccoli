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

function flag(c: Ctx, x: number, y: number, owner: number, t: number) {
  c.strokeStyle = '#5b4a2e'; c.lineWidth = 3; c.lineCap = 'round';
  c.beginPath(); c.moveTo(x, y); c.lineTo(x, y - 30); c.stroke();
  const w = Math.sin(t * 5 + x) * 3;
  c.fillStyle = colorOf(owner); c.strokeStyle = darkOf(owner); c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(x, y - 30); c.quadraticCurveTo(x + 12, y - 30 + w, x + 22, y - 23 + w); c.quadraticCurveTo(x + 11, y - 18 + w, x, y - 15); c.closePath();
  c.fill(); c.stroke();
}

function baseRing(c: Ctx, owner: number) {
  c.fillStyle = colorOf(owner); c.globalAlpha = owner < 0 ? 0.25 : 0.45; ell(c, 0, 0, 50, 50 * TILT * 0.55); c.fill();
  c.globalAlpha = 1; c.strokeStyle = darkOf(owner); c.lineWidth = 3; ell(c, 0, 0, 50, 50 * TILT * 0.55); c.stroke();
}

function floret(c: Ctx, x: number, y: number, r: number) {
  c.fillStyle = '#226b30'; circ(c, x, y + r * 0.18, r); c.fill();
  c.fillStyle = '#2f8f3f'; circ(c, x, y, r); c.fill();
  c.fillStyle = '#4db85a'; circ(c, x - r * 0.28, y - r * 0.3, r * 0.55); c.fill();
  c.fillStyle = 'rgba(255,255,255,.18)'; circ(c, x - r * 0.38, y - r * 0.42, r * 0.22); c.fill();
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
  for (const [x, y, s] of spots) floret(c, x, cy + y, r * s);
  flag(c, 0, cy - r * (level >= 2 ? 1.7 : 0.9), owner, t);
}

/** Thorn Tower: a tapering thorn stalk with a watch pod. */
function tower(c: Ctx, level: number, owner: number, t: number) {
  const h = 62 + level * 9;
  c.fillStyle = '#3f6b2c';
  c.beginPath(); c.moveTo(-19, 0); c.quadraticCurveTo(-13, -h * 0.6, -11, -h); c.lineTo(11, -h); c.quadraticCurveTo(13, -h * 0.6, 19, 0); c.closePath(); c.fill();
  c.fillStyle = '#5c9140';
  c.beginPath(); c.moveTo(-14, 0); c.quadraticCurveTo(-9, -h * 0.6, -8, -h); c.lineTo(0, -h); c.lineTo(-1, 0); c.closePath(); c.fill();
  c.fillStyle = '#e9dfb0'; c.strokeStyle = '#7a6f3c'; c.lineWidth = 1.2;
  const n = 2 + level;
  for (let i = 0; i < n; i++) {
    const y = -h * (0.18 + (0.62 * i) / n), s = i % 2 ? 1 : -1, x = s * (16 - (i / n) * 5);
    c.beginPath(); c.moveTo(x - s * 3, y - 5); c.lineTo(x + s * 13, y - 9); c.lineTo(x - s * 3, y + 4); c.closePath(); c.fill(); c.stroke();
  }
  c.fillStyle = colorOf(owner); c.fillRect(-13, -h * 0.5 - 4, 26, 8);
  c.fillStyle = '#2c4f1f'; ell(c, 0, -h, 20, 8); c.fill();
  c.fillStyle = '#6fae4c';
  for (let i = -2; i <= 2; i++) { c.beginPath(); c.moveTo(i * 8 - 4, -h); c.lineTo(i * 8, -h - 13 - (i === 0 ? 4 : 0)); c.lineTo(i * 8 + 4, -h); c.closePath(); c.fill(); }
  flag(c, 0, -h - 12, owner, t);
}

/** Sun Forge: a warm clay dome with a glowing sun disc. */
function forge(c: Ctx, owner: number, t: number) {
  c.fillStyle = '#8a4f22'; c.beginPath(); c.moveTo(-34, 0); c.bezierCurveTo(-36, -52, 36, -52, 34, 0); c.closePath(); c.fill();
  c.fillStyle = '#c47a35'; c.beginPath(); c.moveTo(-28, 0); c.bezierCurveTo(-30, -46, 16, -48, 12, 0); c.closePath(); c.fill();
  c.fillStyle = colorOf(owner); c.fillRect(-34, -7, 68, 6);
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

export function drawBuilding(c: Ctx, type: BuildingType, level: number, owner: number, t: number) {
  shadow(c, 6, 4, 46, 17);
  baseRing(c, owner);
  if (type === 'farm') farm(c, level, owner, t); else if (type === 'tower') tower(c, level, owner, t); else forge(c, owner, t);
}
export const buildingTop = (type: BuildingType, level: number) => (type === 'farm' ? 80 + level * 12 : type === 'tower' ? 80 + level * 9 : 62);

/** Pre-rendered sprout soldier frames, one sheet per team colour. */
export function makeUnitSprites(scale: number): HTMLCanvasElement[][] {
  return TEAM.map((col, i) => [0, 1].map(frame => {
    const cv = document.createElement('canvas'); cv.width = Math.ceil(26 * scale); cv.height = Math.ceil(30 * scale);
    const c = cv.getContext('2d')!; c.scale(scale, scale);
    c.fillStyle = '#3b2a17';
    ell(c, 9 + (frame ? -1.5 : 1.5), 27, 3.2, 2); c.fill(); ell(c, 16 + (frame ? 1.5 : -1.5), 27, 3.2, 2); c.fill();
    c.fillStyle = TEAM_DARK[i]; circ(c, 13, 18, 9.5); c.fill();
    c.fillStyle = col; circ(c, 13, 17.5, 8); c.fill();
    c.fillStyle = 'rgba(255,255,255,.28)'; circ(c, 10.5, 14.5, 3.4); c.fill();
    c.fillStyle = '#fff'; circ(c, 15, 16.5, 2.6); c.fill(); circ(c, 19.5, 16.5, 2.2); c.fill();
    c.fillStyle = '#16210f'; circ(c, 15.8, 16.8, 1.2); c.fill(); circ(c, 20.1, 16.8, 1.1); c.fill();
    c.fillStyle = '#3fae4d'; c.strokeStyle = '#1f6b2b'; c.lineWidth = 1;
    for (const s of [-1, 1]) { c.beginPath(); c.moveTo(13, 9.5); c.quadraticCurveTo(13 + s * 9, 6 - frame, 13 + s * 7, 1 + frame); c.quadraticCurveTo(13 + s * 1, 3, 13, 9.5); c.fill(); c.stroke(); }
    return cv;
  }));
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
