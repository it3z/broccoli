// Tiny synthesized sound effects (original, generated at runtime with Web Audio).
let ac: AudioContext | null = null;
let enabled = true;
let musicOn = true;
let musicTimer = 0;
let beat = 0;
let nextBeat = 0;
let lastLaunch = 0;

export function setSound(on: boolean): void { enabled = on; }
/** Original generated background loop (pentatonic, soft). Kept separate from effects so each can be muted alone. */
export function setMusic(on: boolean): void {
  musicOn = on;
  clearInterval(musicTimer); musicTimer = 0;
  if (on) musicTimer = window.setInterval(pump, 120);
}
const SCALE = [196, 220, 261.6, 293.7, 329.6, 392, 440, 523.3];
const TUNE = [0, 2, 4, 5, 4, 2, 3, 1, 0, 2, 4, 7, 5, 4, 2, 1];
function pump(): void {
  if (!ac || !musicOn || ac.state !== 'running' || document.hidden) return;
  if (nextBeat < ac.currentTime) nextBeat = ac.currentTime + 0.05;
  while (nextBeat < ac.currentTime + 0.3) {
    const i = beat % 32, n = TUNE[(i >> 1) % 16];
    if (i % 2 === 0) note(SCALE[n], nextBeat, 0.5, 'triangle', 0.028);
    if (i % 8 === 0) note(SCALE[[0, 3, 1, 2][(i >> 3) % 4]] / 2, nextBeat, 1.5, 'sine', 0.05);
    if (i % 4 === 2) note(SCALE[(n + 2) % 8] * 2, nextBeat, 0.25, 'sine', 0.012);
    beat++; nextBeat += 0.24;
  }
}
function note(freq: number, at: number, dur: number, type: OscillatorType, vol: number): void {
  if (!ac) return;
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, at);
  g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(vol, at + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(ac.destination); o.start(at); o.stop(at + dur + 0.05);
}
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
  hit: () => tone(170 + Math.random() * 60, 0.06, 'sawtooth', 0.035, -70),
  capture: () => { tone(523, 0.12, 'triangle', 0.13); tone(784, 0.2, 'triangle', 0.13, 0, 0.1); },
  lost: () => { tone(300, 0.25, 'sawtooth', 0.09, -170); },
  upgrade: () => { tone(660, 0.1, 'sine', 0.1); tone(880, 0.1, 'sine', 0.1, 0, 0.09); tone(1320, 0.18, 'sine', 0.1, 0, 0.18); },
  deny: () => tone(160, 0.12, 'square', 0.05),
  march: () => { tone(196, 0.07, 'triangle', 0.07); tone(262, 0.09, 'triangle', 0.07, 0, 0.07); },
  queued: () => tone(880, 0.05, 'sine', 0.06),
  clash: () => { tone(620, 0.05, 'square', 0.05, -300); tone(480, 0.07, 'square', 0.05, -200, 0.05); },
  defended: () => { tone(440, 0.09, 'triangle', 0.09); tone(554, 0.14, 'triangle', 0.09, 0, 0.08); },
  alert: () => { tone(740, 0.11, 'square', 0.06); tone(740, 0.11, 'square', 0.06, 0, 0.17); },
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, 'triangle', 0.14, 0, i * 0.14)),
  lose: () => [392, 330, 262, 196].forEach((f, i) => tone(f, 0.35, 'triangle', 0.12, 0, i * 0.18)),
};
