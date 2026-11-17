// Scripted Spring Meadow scene, identical for any build: used for before/after stills, the demo clip and the stress benchmark.
// Usage: node scripts/showcase.mjs <path-to-broccoli.html> <out-prefix> [--clip] [--perf]
import { chromium } from 'playwright';
import { writeFileSync, renameSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [html, out] = process.argv.slice(2);
const CLIP = process.argv.includes('--clip'), PERF = process.argv.includes('--perf');
const url = html.startsWith('http') ? html : pathToFileURL(resolve(html)).href;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
mkdirSync(dirname(resolve(out)), { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const vdir = join(dirname(resolve(out)), '_video');
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: CLIP ? 2 : 3, hasTouch: true, isMobile: true, userAgent: UA,
  ...(CLIP ? { recordVideo: { dir: vdir, size: { width: 844, height: 390 } } } : {}) });
const page = await ctx.newPage();
const t0 = Date.now();
const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(url);
const cdp = await ctx.newCDPSession(page);
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(p => ({ x: p.x, y: p.y, id: 1 })) });
const at = id => page.evaluate(i => window.__broccoli.screenOf(i), id);
const tick = n => page.waitForFunction(n => window.__broccoli.match.tick >= n, n, { timeout: 60000 });

if (process.env.NOAUDIO) { await page.tap('#btnSettings'); for (const id of ['segMusic', 'segAmb', 'segSound']) if (await page.$(`#${id}`)) await page.tap(`#${id} .segb:nth-child(2)`); await page.tap('#settings [data-back]'); }
await page.tap('#btnSolo'); await page.tap('#maps .map:nth-child(1)'); await page.tap('#segDiff .segb:nth-child(1)'); await page.tap('#btnStart');
await page.waitForTimeout(300);
// fixed scene: no AI, the centre tower belongs to the enemy, both home farms are well stocked
await page.evaluate(() => {
  const s = window.__broccoli, m = s.match; s.ais.length = 0;
  m.buildings[0].garrison = 30; m.buildings[1].garrison = 30; m.buildings[8].owner = 0; m.buildings[8].garrison = 24;   // a forward farm that will have to wait
  m.buildings[10].owner = 1; m.buildings[10].garrison = 14; m.buildings[9].garrison = 9;
  document.getElementById('hint').classList.add('hidden');
});
let audioStart = 0;
if (CLIP) {
  audioStart = await page.evaluate(() => window.__broccoliAudio ? window.__broccoliAudio.startRecording() : 0);
  await page.waitForTimeout(1200);
}
const start = (await page.evaluate(() => window.__broccoli.match.tick));
await page.tap('#btnAll'); await page.waitForTimeout(CLIP ? 500 : 80);
await page.tap('#btnSync'); await page.waitForTimeout(CLIP ? 700 : 80);
await page.tap('.pct[data-pct="75"]'); await page.waitForTimeout(CLIP ? 400 : 80);
const a = await at(0), b = await at(9);
await touch('touchStart', [a]);
for (let i = 1; i <= 16; i++) { await touch('touchMove', [{ x: a.x + ((b.x - a.x) * i) / 16, y: a.y + ((b.y - a.y) * i) / 16 }]); await page.waitForTimeout(CLIP ? 45 : 12); }
await page.waitForTimeout(CLIP ? 700 : 120);
if (!CLIP && !PERF) await page.screenshot({ path: `${out}-1-order.png` });
const orderTick = await page.evaluate(() => window.__broccoli.match.tick);
await touch('touchEnd', []);
if (!CLIP && !PERF) {
  await tick(orderTick + 24); await page.screenshot({ path: `${out}-2-leaving.png` });
  await tick(orderTick + 125); await page.screenshot({ path: `${out}-3-tower.png` });
  await page.waitForFunction(() => window.__broccoli.match.armies.some(x => x.state === 'fighting'), null, { timeout: 30000 });
  await page.waitForTimeout(300); await page.screenshot({ path: `${out}-4-battle.png` });
  await page.waitForFunction(() => window.__broccoli.match.buildings[9].owner === 0, null, { timeout: 30000 });
  await page.waitForTimeout(350); await page.screenshot({ path: `${out}-5-capture.png` });
}
if (CLIP) {
  await page.waitForFunction(() => window.__broccoli.match.buildings[9].owner === 0, null, { timeout: 40000 });
  await page.waitForTimeout(3200);
  const audio = await page.evaluate(() => window.__broccoliAudio ? window.__broccoliAudio.stopRecording() : null);
  const end = Date.now();
  await ctx.close();
  const f = readdirSync(vdir).find(x => x.endsWith('.webm'));
  renameSync(join(vdir, f), `${out}-video.webm`);
  if (audio) writeFileSync(`${out}-audio.webm`, Buffer.from(audio.split(',')[1], 'base64'));
  console.log(JSON.stringify({ videoStartToAudioStartMs: audioStart - t0, totalMs: end - t0, hasAudio: !!audio, errors }));
}
if (PERF) {
  // same crowded scenario for every build: 4-way Deep Forest, AI on every seat, then every owned building stocked to 160
  await page.tap('#btnPause'); await page.tap('#btnQuit');
  await page.tap('#btnSolo'); await page.tap('#maps .map:nth-child(2)'); await page.tap('#segOpp .segb:nth-child(3)'); await page.tap('#segDiff .segb:nth-child(3)'); await page.tap('#btnStart');
  await page.evaluate(() => window.__broccoli.autoplay('hard', 1));
  await page.waitForTimeout(20000);
  const res = {};
  for (const low of [false, true]) {
    await page.evaluate(low => { const s = window.__broccoli, m = s.match; s.opts.lowFx = low; s.autoLow = false; for (const b of m.buildings) if (b.owner >= 0) b.garrison = 160; }, low);
    await page.waitForTimeout(3000);
    // cost of drawing one frame, measured the same way on every build (the frame rate itself is capped by vsync)
    const drawMs = await page.evaluate(() => new Promise(r => { const rr = window.__broccoli.renderer, d = rr.draw.bind(rr); let sum = 0, n = 0;
      rr.draw = f => { const t = performance.now(); d(f); sum += performance.now() - t; if (++n === 200) { rr.draw = d; r(sum / n); } }; }));
    const samples = await page.evaluate(() => new Promise(r => { const xs = []; let last = performance.now(); const f = t => { xs.push(t - last); last = t; xs.length < 240 ? requestAnimationFrame(f) : r(xs); }; requestAnimationFrame(f); }));
    samples.sort((x, y) => x - y);
    const info = await page.evaluate(() => { const s = window.__broccoli; return { sprites: s.renderer.drawnSoldiers, armies: s.match.armies.length, units: s.match.players.reduce((n, p) => n + s.match.totalUnits(p.id), 0) }; });
    res[low ? 'reduced' : 'full'] = { avgMs: +(samples.reduce((x, y) => x + y, 0) / samples.length).toFixed(2), p95Ms: +samples[Math.floor(samples.length * 0.95)].toFixed(2), drawMs: +drawMs.toFixed(2), ...info };
  }
  console.log(JSON.stringify({ build: html, ...res, errors }));
}
if (!CLIP) await ctx.close();
await browser.close();
