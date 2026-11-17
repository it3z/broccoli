// Same crowded match for any build, each effects mode measured in its own fresh page at the same match moment.
// 4-way Deep Forest, AI on every seat (hard), 20 s in every owned building is stocked to 160, then 240 frames are sampled.
// Usage: node scripts/perf.mjs <broccoli.html> [runs=3]
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [html, runsArg] = process.argv.slice(2), RUNS = Number(runsArg || 3);
const url = pathToFileURL(resolve(html)).href;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const browser = await chromium.launch({ channel: 'chrome' });
const med = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const out = {};
for (const low of [false, true]) {
  const rows = [];
  for (let r = 0; r < RUNS; r++) {
    const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true, userAgent: UA });
    const page = await ctx.newPage();
    await page.goto(url);
    await page.tap('#btnSolo'); await page.tap('#maps .map:nth-child(2)'); await page.tap('#segOpp .segb:nth-child(3)'); await page.tap('#segDiff .segb:nth-child(3)');
    for (const sel of ['#segHero .segb:nth-child(1)', '#segSeed .segb:nth-child(2)']) if (await page.$(sel)) await page.tap(sel);
    await page.tap('#btnStart');
    await page.evaluate(low => { const s = window.__broccoli; s.opts.lowFx = low; s.autoLow = false; s.autoplay('hard', 1); }, low);
    await page.waitForTimeout(20000);
    await page.evaluate(() => { for (const b of window.__broccoli.match.buildings) if (b.owner >= 0) b.garrison = 160; });
    await page.waitForTimeout(3000);
    const drawMs = await page.evaluate(() => new Promise(r => { const rr = window.__broccoli.renderer, d = rr.draw.bind(rr); let sum = 0, n = 0;
      rr.draw = f => { const t = performance.now(); d(f); sum += performance.now() - t; if (++n === 200) { rr.draw = d; r(sum / n); } }; }));
    const xs = await page.evaluate(() => new Promise(r => { const xs = []; let last = performance.now(); const f = t => { xs.push(t - last); last = t; xs.length < 240 ? requestAnimationFrame(f) : r(xs); }; requestAnimationFrame(f); }));
    const sprites = await page.evaluate(() => window.__broccoli.renderer.drawnSoldiers);
    rows.push({ avgMs: xs.reduce((a, b) => a + b, 0) / xs.length, drawMs, long25: xs.filter(x => x > 25).length, long33: xs.filter(x => x > 33.4).length, sprites });
    await ctx.close();
  }
  out[low ? 'reduced' : 'full'] = { runs: rows.map(x => x.long25), avgMs: +med(rows.map(x => x.avgMs)).toFixed(2), drawMs: +med(rows.map(x => x.drawMs)).toFixed(2), longFrames25: med(rows.map(x => x.long25)), longFrames33: med(rows.map(x => x.long33)), sprites: med(rows.map(x => x.sprites)) };
}
console.log(JSON.stringify({ build: html, ...out }));
await browser.close();
