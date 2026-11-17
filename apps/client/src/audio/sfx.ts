// BROCCOLI audio: every sound is synthesized at runtime with Web Audio (no samples, nothing to license).
// Three buses with their own switches: music (layered), ambience (wind, birds, water) and effects (panned, voice-limited).
type Bus = 'music' | 'amb' | 'fx';
let ac: AudioContext | null = null;
let master: GainNode, buses: Record<Bus, GainNode>, layerB: GainNode, noiseBuf: AudioBuffer;
const on: Record<Bus, boolean> = { music: true, amb: true, fx: true };
// default mix: effects lead, music and ambience sit under them (each adjustable 0..1 in Settings)
const LEVEL: Record<Bus, number> = { music: 0.55, amb: 0.6, fx: 1 };
let voices = 0;
const MAX_VOICES = 9;
const lastAt: Record<string, number> = {};
let musicTimer = 0, beat = 0, nextBeat = 0, intensity = 0;
let scene: { birds: boolean; water: boolean } | null = null, ambNodes: AudioNode[] = [], birdTimer = 0;
let recorder: MediaRecorder | null = null, recChunks: Blob[] = [], recDest: MediaStreamAudioDestinationNode | null = null;

function init(): void {
  if (ac) return;
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  ac = new Ctor();
  // a gentle compressor on the master keeps several simultaneous battles from piling up into distortion
  const comp = ac.createDynamicsCompressor(); comp.threshold.value = -18; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
  master = ac.createGain(); master.gain.value = 0.9; master.connect(comp).connect(ac.destination);
  const mk = (b: Bus) => { const g = ac!.createGain(); g.gain.value = on[b] ? LEVEL[b] : 0; g.connect(master); return g; };
  buses = { music: mk('music'), amb: mk('amb'), fx: mk('fx') };
  layerB = ac.createGain(); layerB.gain.value = 0; layerB.connect(buses.music);
  noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
  const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  if (scene) startAmbience();
}

/** Call from a user gesture (Safari only starts audio after the first touch) and when the page comes back to the front. */
export function unlockAudio(): void {
  try { init(); if (ac!.state !== 'running') ac!.resume().catch(() => {}); } catch { ac = null; }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && ac && ac.state !== 'running') ac.resume().catch(() => {}); });

function setBus(b: Bus, v: boolean): void {
  on[b] = v;
  if (ac) buses[b].gain.setTargetAtTime(v ? LEVEL[b] : 0, ac.currentTime, 0.05);
}
export function setSound(v: boolean): void { setBus('fx', v); }
/** Volume of one bus, 0..1 (0 also counts as off). */
export function setLevel(b: Bus, v: number): void { LEVEL[b] = Math.max(0, Math.min(1, v)); setBus(b, LEVEL[b] > 0); if (b === 'music') setMusic(LEVEL[b] > 0); }
export const levels = () => ({ ...LEVEL });
export function setAmbience(v: boolean): void { setBus('amb', v); }
export function setMusic(v: boolean): void {
  setBus('music', v);
  clearInterval(musicTimer); musicTimer = 0;
  if (v) musicTimer = window.setInterval(pump, 120);
}
const live = () => !!ac && ac.state === 'running';

// ---------- building blocks ----------
function out(node: AudioNode, bus: Bus | GainNode, pan: number): void {
  const dest = typeof bus === 'string' ? buses[bus] : bus;
  if (Math.abs(pan) > 0.12 && typeof ac!.createStereoPanner === 'function') { const p = ac!.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan)); node.connect(p).connect(dest); }
  else node.connect(dest);
}
function env(g: GainNode, t: number, vol: number, dur: number, attack = 0.008): void {
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
}
function tone(freq: number, dur: number, type: OscillatorType, vol: number, o: { slide?: number; delay?: number; pan?: number; bus?: Bus | GainNode; at?: number } = {}): void {
  if (!live()) return;
  const t = (o.at ?? ac!.currentTime) + (o.delay ?? 0), osc = ac!.createOscillator(), g = ac!.createGain();
  osc.type = type; osc.frequency.setValueAtTime(freq, t);
  if (o.slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + o.slide), t + dur);
  env(g, t, vol, dur);
  osc.connect(g); out(g, o.bus ?? 'fx', o.pan ?? 0); osc.start(t); osc.stop(t + dur + 0.03);
}
function noise(dur: number, vol: number, filter: BiquadFilterType, freq: number, o: { q?: number; delay?: number; pan?: number; bus?: Bus | GainNode; sweep?: number; at?: number } = {}): void {
  if (!live()) return;
  const t = (o.at ?? ac!.currentTime) + (o.delay ?? 0), src = ac!.createBufferSource(), f = ac!.createBiquadFilter(), g = ac!.createGain();
  src.buffer = noiseBuf; src.loop = true; src.loopStart = Math.random() * 0.5;
  f.type = filter; f.frequency.setValueAtTime(freq, t); f.Q.value = o.q ?? 1;
  if (o.sweep) f.frequency.exponentialRampToValueAtTime(Math.max(60, freq + o.sweep), t + dur);
  env(g, t, vol, dur, 0.004);
  src.connect(f).connect(g); out(g, o.bus ?? 'fx', o.pan ?? 0); src.start(t, Math.random() * 0.8); src.stop(t + dur + 0.03);
}
/** Voice limiting: at most MAX_VOICES effects at once, and each kind no more often than its own interval. */
function gate(kind: string, minGap: number, cost = 1, sec = 0.25): boolean {
  if (!live() || !on.fx) return false;
  const now = ac!.currentTime;
  if (now - (lastAt[kind] ?? -9) < minGap || voices + cost > MAX_VOICES) return false;
  lastAt[kind] = now; voices += cost; window.setTimeout(() => { voices -= cost; }, sec * 1000);
  return true;
}
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
function duck(): void {   // pull the music down for a moment so an important cue is heard
  if (!live() || !on.music) return;
  const g = buses.music.gain, t = ac!.currentTime;
  g.cancelScheduledValues(t); g.setTargetAtTime(LEVEL.music * 0.3, t, 0.04); g.setTargetAtTime(LEVEL.music, t + 0.7, 0.35);
}

// ---------- effects ----------
export const sfx = {
  tap: () => { if (gate('tap', 0.03)) tone(520, 0.05, 'triangle', 0.07); },
  deny: () => { if (gate('deny', 0.1)) tone(160, 0.12, 'square', 0.05); },
  send: () => { if (gate('send', 0.05)) { tone(330, 0.12, 'triangle', 0.1, { slide: 220 }); noise(0.14, 0.03, 'bandpass', 900, { sweep: 1400 }); } },
  /** A squad leaves its building: two-note horn. */
  march: (pan = 0) => { if (gate('march', 0.12, 2)) { tone(196, 0.09, 'triangle', 0.08, { pan }); tone(262, 0.12, 'triangle', 0.08, { pan, delay: 0.08 }); } },
  queued: () => { if (gate('queued', 0.05)) tone(880, 0.05, 'sine', 0.06); },
  /** Soft footsteps of a marching squad; pitch and timing vary so they never loop audibly. */
  steps: (pan = 0) => {
    if (!gate('steps', 0.42, 1, 0.3)) return;
    for (let i = 0; i < 2; i++) noise(0.045, rnd(0.022, 0.035), 'lowpass', rnd(600, 1000), { pan, delay: i * rnd(0.07, 0.1) });
  },
  /** Battle blow: a wooden knock plus a rustle of leaves, four pitch variations. */
  hit: (pan = 0) => {
    if (!gate('hit', 0.11, 1, 0.15)) return;
    tone([170, 205, 240, 280][Math.floor(Math.random() * 4)] * rnd(0.95, 1.05), 0.07, 'sine', 0.085, { slide: -60, pan });
    noise(0.05, 0.03, 'highpass', rnd(2500, 4200), { pan });
  },
  clash: (pan = 0) => { if (gate('clash', 0.2, 2)) { tone(250, 0.07, 'sine', 0.09, { pan, slide: -80 }); tone(210, 0.07, 'sine', 0.09, { pan, delay: 0.06, slide: -60 }); noise(0.1, 0.035, 'highpass', 3000, { pan }); } },
  /** Tower: creak of the draw... */
  towerDraw: (pan = 0) => { if (gate('draw', 0.25, 1, 0.2)) tone(95, 0.2, 'sawtooth', 0.022, { slide: 90, pan }); },
  /** ...release... */
  shot: (pan = 0) => { if (gate('shot', 0.1, 1, 0.15)) { tone(rnd(640, 760), 0.09, 'triangle', 0.06, { slide: -430, pan }); noise(0.06, 0.03, 'bandpass', 2200, { pan, sweep: -1200 }); } },
  /** ...and impact. */
  impact: (pan = 0) => { if (gate('impact', 0.1, 1, 0.15)) { tone(150, 0.09, 'sine', 0.08, { slide: -80, pan }); noise(0.07, 0.035, 'lowpass', 900, { pan }); } },
  capture: (pan = 0) => { if (gate('capture', 0.15, 3, 0.5)) { tone(523, 0.11, 'triangle', 0.12, { pan }); tone(659, 0.11, 'triangle', 0.12, { pan, delay: 0.09 }); tone(784, 0.22, 'triangle', 0.13, { pan, delay: 0.18 }); } },
  /** One of your buildings fell: a different, darker cue, and the music ducks. */
  lost: (pan = 0) => { if (gate('lost', 0.15, 3, 0.6)) { duck(); tone(392, 0.16, 'sawtooth', 0.07, { pan, slide: -60 }); tone(311, 0.3, 'sawtooth', 0.07, { pan, delay: 0.15, slide: -90 }); tone(98, 0.35, 'sine', 0.12, { pan, delay: 0.15 }); } },
  defended: (pan = 0) => { if (gate('defended', 0.2, 2)) { tone(440, 0.09, 'triangle', 0.09, { pan }); tone(554, 0.14, 'triangle', 0.09, { pan, delay: 0.08 }); } },
  upgrade: (pan = 0) => { if (gate('upgrade', 0.2, 3, 0.5)) [660, 880, 1320].forEach((f, i) => tone(f, i === 2 ? 0.2 : 0.1, 'sine', 0.09, { pan, delay: i * 0.09 })); },
  alert: (pan = 0) => { if (gate('alert', 0.5, 2, 0.4)) { duck(); tone(740, 0.11, 'square', 0.055, { pan }); tone(740, 0.11, 'square', 0.055, { pan, delay: 0.17 }); } },
  seedWarn: (pan = 0) => { if (gate('seedWarn', 0.5, 3, 0.6)) { duck(); [988, 1319, 1568].forEach((f, i) => tone(f, 0.18, 'sine', 0.07, { pan, delay: i * 0.11 })); } },
  seedClaim: (pan = 0, mine = true) => { if (gate('seedClaim', 0.5, 4, 0.8)) (mine ? [784, 988, 1175, 1568] : [784, 659, 523]).forEach((f, i) => tone(f, 0.2, 'triangle', 0.1, { pan, delay: i * 0.1 })); },
  bridge: (pan = 0) => { if (gate('bridge', 0.4, 2, 0.6)) { noise(0.5, 0.05, 'bandpass', 380, { pan, sweep: -200 }); tone(70, 0.45, 'sawtooth', 0.04, { pan, slide: 30 }); } },
  ability: (pan = 0) => { if (gate('ability', 0.15, 2, 0.4)) { noise(0.25, 0.05, 'bandpass', 900, { pan, sweep: 2600, q: 2 }); tone(523, 0.22, 'sine', 0.06, { pan, slide: 520 }); } },
  zone: (pan = 0) => { if (gate('zone', 0.2, 2, 0.3)) { tone(110, 0.2, 'sine', 0.1, { pan, slide: -50 }); noise(0.18, 0.05, 'lowpass', 500, { pan }); } },
  win: () => { if (live() && on.fx) [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, 'triangle', 0.14, { delay: i * 0.14 })); },
  lose: () => { if (live() && on.fx) [392, 330, 262, 196].forEach((f, i) => tone(f, 0.35, 'triangle', 0.12, { delay: i * 0.18 })); },
};

// ---------- ambience ----------
/** Start the map's background: wind in the leaves, distant birds, and water if the map has ponds. Pass null to stop. */
export function setScene(s: { birds: boolean; water: boolean } | null): void {
  scene = s; stopAmbience();
  if (s && ac) startAmbience();
}
function stopAmbience(): void {
  for (const n of ambNodes) { try { (n as AudioScheduledSourceNode).stop?.(); } catch { /* already stopped */ } n.disconnect(); }
  ambNodes = []; clearTimeout(birdTimer);
}
function startAmbience(): void {
  if (!ac || !scene) return;
  const loop = (filter: BiquadFilterType, freq: number, q: number, vol: number, lfoHz: number) => {
    const src = ac!.createBufferSource(), f = ac!.createBiquadFilter(), g = ac!.createGain(), lfo = ac!.createOscillator(), lg = ac!.createGain();
    src.buffer = noiseBuf; src.loop = true; f.type = filter; f.frequency.value = freq; f.Q.value = q; g.gain.value = vol;
    lfo.frequency.value = lfoHz; lg.gain.value = vol * 0.6; lfo.connect(lg).connect(g.gain);
    src.connect(f).connect(g).connect(buses.amb); src.start(); lfo.start();
    ambNodes.push(src, lfo, g);
  };
  loop('lowpass', 520, 0.6, 0.05, 0.13);             // wind through the leaves
  loop('bandpass', 3200, 0.8, 0.012, 0.21);          // leaf hiss
  if (scene.water) loop('bandpass', 1500, 1.4, 0.014, 0.9);   // pond lapping
  const chirp = () => {
    if (live() && scene?.birds && on.amb && !document.hidden) {
      const pan = rnd(-0.9, 0.9), base = rnd(2400, 4200), n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) tone(base * rnd(0.92, 1.1), 0.07, 'sine', 0.018, { slide: rnd(300, 900), delay: i * rnd(0.09, 0.14), pan, bus: 'amb' });
    }
    birdTimer = window.setTimeout(chirp, rnd(2500, 7000));
  };
  birdTimer = window.setTimeout(chirp, 1500);
}

// ---------- music: a calm base layer, plus a second layer that swells with the fighting ----------
/** 0 = quiet board, 1 = heavy fighting. The battle layer rises quickly and settles slowly. */
export function setIntensity(v: number): void {
  intensity = Math.max(0, Math.min(1, v));
  if (live()) layerB.gain.setTargetAtTime(intensity, ac!.currentTime, intensity > layerB.gain.value ? 0.6 : 2.5);
}
const SCALE = [196, 220, 261.6, 293.7, 329.6, 392, 440, 523.3];
const TUNE = [0, 2, 4, 5, 4, 2, 3, 1, 0, 2, 4, 7, 5, 4, 2, 1];
function pump(): void {
  if (!live() || !on.music || document.hidden) return;
  if (nextBeat < ac!.currentTime) nextBeat = ac!.currentTime + 0.05;
  while (nextBeat < ac!.currentTime + 0.3) {
    const i = beat % 32, n = TUNE[(i >> 1) % 16], at = nextBeat;
    if (i % 2 === 0) tone(SCALE[n], 0.5, 'triangle', 0.026, { bus: 'music', at });
    if (i % 8 === 0) tone(SCALE[[0, 3, 1, 2][(i >> 3) % 4]] / 2, 1.5, 'sine', 0.05, { bus: 'music', at });
    if (i % 4 === 2) tone(SCALE[(n + 2) % 8] * 2, 0.25, 'sine', 0.011, { bus: 'music', at });
    // battle layer: pulse bass, off-beat ticks and a fifth above the tune
    if (intensity > 0.02) {
    if (i % 2 === 0) tone(SCALE[[0, 3, 1, 2][(i >> 3) % 4]] / 2, 0.2, 'sawtooth', 0.034, { bus: layerB, at });
    if (i % 2 === 1) noise(0.04, 0.035, 'highpass', 5000, { bus: layerB, at });
    if (i % 4 === 0) { tone(110, 0.12, 'sine', 0.09, { bus: layerB, at, slide: -50 }); tone(SCALE[(n + 4) % 8], 0.3, 'square', 0.012, { bus: layerB, at }); }
    }
    beat++; nextBeat += 0.24;
  }
}

// ---------- recording hook (used by scripts/showcase.mjs to capture the game's own sound for demo clips) ----------
(window as unknown as { __broccoliAudio: unknown }).__broccoliAudio = {
  startRecording(): number {
    unlockAudio(); if (!ac) return 0;
    recDest = ac.createMediaStreamDestination(); master.connect(recDest);
    recChunks = []; recorder = new MediaRecorder(recDest.stream);
    recorder.ondataavailable = e => { if (e.data.size) recChunks.push(e.data); };
    recorder.start(250);
    return Date.now();
  },
  stopRecording(): Promise<string | null> {
    return new Promise(res => {
      if (!recorder) return res(null);
      recorder.onstop = () => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(new Blob(recChunks, { type: recorder!.mimeType })); if (recDest) master.disconnect(recDest); };
      recorder.stop();
    });
  },
  state: () => ({ running: live(), voices, intensity, on: { ...on }, levels: { ...LEVEL }, scene }),
};
