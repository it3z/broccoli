// Tiny synthesized sound effects (original, generated at runtime with Web Audio).
let ac: AudioContext | null = null;
let enabled = true;
let lastLaunch = 0;

export function setSound(on: boolean): void { enabled = on; }
export function unlockAudio(): void {
  try {
    if (!ac) ac = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume().catch(() => {});
  } catch { ac = null; }
}

function tone(freq: number, dur: number, type: OscillatorType, vol: number, slide = 0, delay = 0): void {
  if (!ac || !enabled || ac.state !== 'running') return;
  const t = ac.currentTime + delay, o = ac.createOscillator(), g = ac.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ac.destination); o.start(t); o.stop(t + dur + 0.02);
}

export const sfx = {
  tap: () => tone(520, 0.06, 'triangle', 0.08),
  send: () => { tone(330, 0.12, 'triangle', 0.12, 220); },
  launch: () => { const n = performance.now(); if (n - lastLaunch > 180) { lastLaunch = n; tone(240, 0.05, 'sine', 0.04, 60); } },
  shot: () => tone(900, 0.07, 'square', 0.035, -500),
  hit: () => tone(150, 0.08, 'sawtooth', 0.04, -60),
  capture: () => { tone(523, 0.12, 'triangle', 0.13); tone(784, 0.2, 'triangle', 0.13, 0, 0.1); },
  lost: () => { tone(300, 0.25, 'sawtooth', 0.09, -170); },
  upgrade: () => { tone(660, 0.1, 'sine', 0.1); tone(880, 0.1, 'sine', 0.1, 0, 0.09); tone(1320, 0.18, 'sine', 0.1, 0, 0.18); },
  deny: () => tone(160, 0.12, 'square', 0.05),
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, 'triangle', 0.14, 0, i * 0.14)),
  lose: () => [392, 330, 262, 196].forEach((f, i) => tone(f, 0.35, 'triangle', 0.12, 0, i * 0.18)),
};
