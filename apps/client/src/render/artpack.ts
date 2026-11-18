// Painted art pack: optional PNG sprites from packages/content/art/ that replace the procedural drawings slot by slot.
// The build inlines every PNG it finds there (virtual module "broccoli:artpack"); with no files the game draws
// everything procedurally exactly as before. Slots, sizes, pivots and frame order: packages/content/art/manifest.json.
import PACK from 'broccoli:artpack';
import { TEAM, NEUTRAL } from './art';

const imgs = new Map<string, HTMLImageElement>();
let pending = 0;
const waiters: (() => void)[] = [];
/** Load every image in the pack once; `onReady` runs when all have decoded (immediately if the pack is empty). */
export function loadArtPack(onReady: () => void): void {
  if (imgs.size && pending === 0) { onReady(); return; }
  waiters.push(onReady);
  if (imgs.size) return;
  const entries = Object.entries(PACK as Record<string, string>);
  if (!entries.length) { waiters.splice(0).forEach(f => f()); return; }
  pending = entries.length;
  for (const [name, src] of entries) {
    const im = new Image();
    const done = () => { if (--pending === 0) waiters.splice(0).forEach(f => f()); };
    im.onload = done; im.onerror = () => { imgs.delete(name); done(); };
    im.src = src; imgs.set(name, im);
  }
}
/** Names of the pack files that loaded (for tests and the debug overlay). */
export const artPackNames = (): string[] => [...imgs.entries()].filter(([, im]) => im.complete && im.naturalWidth > 0).map(([k]) => k);

/**
 * The image for a slot and an owner, or null when the pack does not supply it.
 * Lookup order: `<id>@<owner>` (owner n = neutral), then `<id>` tinted through `<id>_team` (a grayscale mask, white = team colour).
 */
const tinted = new Map<string, HTMLCanvasElement | HTMLImageElement>();
export function artFor(id: string, owner: number): HTMLCanvasElement | HTMLImageElement | null {
  const key = `${id}@${owner < 0 ? 'n' : owner % 4}`;
  const hit = tinted.get(key); if (hit) return hit;
  const ok = (n: string) => { const im = imgs.get(n); return im && im.complete && im.naturalWidth > 0 ? im : null; };
  const own = ok(key); if (own) { tinted.set(key, own); return own; }
  const base = ok(id); if (!base) return null;
  const mask = ok(`${id}_team`);
  if (!mask) { tinted.set(key, base); return base; }
  const out = document.createElement('canvas'); out.width = base.naturalWidth; out.height = base.naturalHeight;
  const c = out.getContext('2d')!;
  // the mask's brightness becomes the alpha of a flat team-colour layer, which is multiplied onto the painted base:
  // black mask areas leave the base untouched, white areas take the team colour and keep the base's shading
  const tint = document.createElement('canvas'); tint.width = out.width; tint.height = out.height;
  const t = tint.getContext('2d', { willReadFrequently: true })!;
  t.drawImage(mask, 0, 0, out.width, out.height);
  const px = t.getImageData(0, 0, out.width, out.height), d = px.data;
  const hex = owner < 0 ? NEUTRAL : TEAM[owner % 4], r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), bl = parseInt(hex.slice(5, 7), 16);
  for (let i = 0; i < d.length; i += 4) { const lum = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255; d[i + 3] = Math.round(lum * d[i + 3]); d[i] = r; d[i + 1] = g; d[i + 2] = bl; }
  t.putImageData(px, 0, 0);
  c.drawImage(base, 0, 0);
  if (owner < 0) {   // neutral buildings read as unclaimed: partly desaturated (team parts are stone grey), still sunlit
    const im = c.getImageData(0, 0, out.width, out.height), q = im.data;
    for (let i = 0; i < q.length; i += 4) { const l = q[i] * 0.299 + q[i + 1] * 0.587 + q[i + 2] * 0.114; q[i] = l + (q[i] - l) * 0.55; q[i + 1] = l + (q[i + 1] - l) * 0.55; q[i + 2] = l + (q[i + 2] - l) * 0.55; }
    c.putImageData(im, 0, 0);
  }
  c.globalCompositeOperation = 'multiply'; c.drawImage(tint, 0, 0);
  c.globalCompositeOperation = 'destination-in'; c.drawImage(base, 0, 0);   // keep the base silhouette
  tinted.set(key, out);
  return out;
}
/** Cut frame `i` (counted left to right) of width `fw` out of a horizontal strip. */
export function frameOf(strip: HTMLCanvasElement | HTMLImageElement, i: number, fw: number, fh: number, scale: number): HTMLCanvasElement {
  const cv = document.createElement('canvas'); cv.width = Math.ceil(fw * scale); cv.height = Math.ceil(fh * scale);
  const px = (strip instanceof HTMLImageElement ? strip.naturalHeight : strip.height) / fh;   // supplied resolution (e.g. 2 for @2x files)
  cv.getContext('2d')!.drawImage(strip, i * fw * px, 0, fw * px, fh * px, 0, 0, cv.width, cv.height);
  return cv;
}
/** Average colour of the opaque pixels of a slot for an owner (test hook). */
export function artAverage(id: string, owner: number): number[] | null {
  const im = artFor(id, owner); if (!im) return null;
  const w = im instanceof HTMLImageElement ? im.naturalWidth : im.width, h = im instanceof HTMLImageElement ? im.naturalHeight : im.height;
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const c = cv.getContext('2d')!; c.drawImage(im, 0, 0);
  const d = c.getImageData(0, 0, w, h).data; let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  return n ? [r / n, g / n, b / n].map(Math.round) : null;
}
