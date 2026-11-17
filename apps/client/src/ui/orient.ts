// Automatic landscape: on a phone held upright the whole game is turned 90° so it always plays in landscape.
// (Safari on iPhone cannot lock orientation from a web page, so the page rotates itself instead.)
const html = document.documentElement;
export const isRotated = () => html.classList.contains('rot');

/** Turn a screen point (clientX/Y) into the game's own landscape coordinates. */
export function toLocal(x: number, y: number): { x: number; y: number } {
  return isRotated() ? { x: y, y: window.innerWidth - x } : { x, y };
}
/** And back: a point in game coordinates to where it is on the physical screen. */
export function toScreenPx(x: number, y: number): { x: number; y: number } {
  return isRotated() ? { x: window.innerWidth - y, y: x } : { x, y };
}

export function applyOrientation(): void {
  const w = window.innerWidth, h = window.innerHeight;
  const rotate = h > w && (matchMedia('(pointer: coarse)').matches || w <= 820);
  html.classList.toggle('rot', rotate);
  const app = document.getElementById('app')!;
  app.style.width = rotate ? `${h}px` : '';
  app.style.height = rotate ? `${w}px` : '';
}

export function initOrientation(): void {
  applyOrientation();
  // applied synchronously (this listener is registered before any match's), and again next frame for late viewport updates
  for (const ev of ['resize', 'orientationchange']) window.addEventListener(ev, () => { applyOrientation(); requestAnimationFrame(applyOrientation); });
  window.visualViewport?.addEventListener('resize', () => requestAnimationFrame(applyOrientation));
  // where the browser allows it (Android, installed web app), also ask for a real landscape lock after the first tap
  const lock = () => { (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })?.lock?.('landscape').catch(() => {}); };
  document.addEventListener('pointerdown', lock, { once: true });
}
