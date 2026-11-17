// Fixed Spring Bridge scene for before/after stills and the demo clip (works on any build since v0.5).
// Two squads (synchronized) cross the north bridge, an enemy tower shoots them, Green Rush speeds them past it,
// and they take the enemy village on the far bank. Usage: node scripts/showcase-bridge.mjs <html> <out-prefix> [--clip]
import { chromium } from 'playwright';
import { writeFileSync, renameSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [html, out] = process.argv.slice(2), CLIP = process.argv.includes('--clip');
mkdirSync(dirname(resolve(out)), { recursive: true });
const vdir = join(dirname(resolve(out)), '_vid');
const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: CLIP ? 2 : 3, hasTouch: true, isMobile: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  ...(CLIP ? { recordVideo: { dir: vdir, size: { width: 844, height: 390 } } } : {}) });
const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(String(e)));
const t0 = Date.now();
await page.goto(pathToFileURL(resolve(html)).href);
const cdp = await ctx.newCDPSession(page);
const touch = (type, p) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: p.x, y: p.y, id: 1 }] : [] });
const at = id => page.evaluate(i => window.__broccoli.screenOf(i), id);
await page.tap('#btnSolo'); await page.tap('#maps .map:nth-child(3)');
if (await page.$('#segSeed')) await page.tap('#segSeed .segb:nth-child(2)');
if (await page.$('#segHero')) await page.tap('#segHero .segb:nth-child(2)');   // Sprig
await page.tap('#btnStart'); await page.waitForTimeout(300);
await page.evaluate(() => {
  const s = window.__broccoli, m = s.match; s.ais.length = 0;
  const own = (i, o, g) => { m.buildings[i].owner = o; m.buildings[i].garrison = g; };
  own(0, 0, 44); own(1, 0, 20); own(3, 0, 18); own(5, 0, 34); own(2, 0, 12);
  own(13, 1, 12); own(10, 1, 16); own(8, 1, 24); own(9, 1, 20);
  m.players[0].cd = [0, 0];
  if (m.bridge) m.bridge.nextTick = 1e9;
  document.getElementById('hint').classList.add('hidden');
});
let audioStart = 0;
if (CLIP) { audioStart = await page.evaluate(() => window.__broccoliAudio.startRecording()); await page.waitForTimeout(1200); }
await page.evaluate(() => { const s = window.__broccoli; s.selection.clear(); s.selection.add(0); s.selection.add(5); });
await page.tap('#btnSync'); await page.waitForTimeout(CLIP ? 500 : 60);
await page.tap('.pct[data-pct="75"]'); await page.waitForTimeout(CLIP ? 300 : 60);
const a = await at(5), b = await at(10);
await touch('touchStart', a);
for (let i = 1; i <= 16; i++) { await touch('touchMove', { x: a.x + (b.x - a.x) * i / 16, y: a.y + (b.y - a.y) * i / 16 }); await page.waitForTimeout(CLIP ? 45 : 10); }
await page.waitForTimeout(CLIP ? 700 : 120);
if (!CLIP) await page.screenshot({ path: `${out}-1-order.png` });
await touch('touchEnd');
const t = () => page.evaluate(() => window.__broccoli.match.tick);
const o = await t();
const until = n => page.waitForFunction(n => window.__broccoli.match.tick >= n, n, { timeout: 60000 });
// Green Rush as the squads reach the bridge under the tower's fire
await page.waitForFunction(() => { const m = window.__broccoli.match; return m.armies.filter(a => a.owner === 0).length >= 2 && m.armies.some(a => a.owner === 0 && a.x > 700); }, null, { timeout: 30000 });
if (!CLIP) await page.screenshot({ path: `${out}-2-bridge.png` });
await page.evaluate(() => window.__broccoli.match.enqueue({ type: 'ability', player: 0, slot: 1 }));
await page.waitForTimeout(700);
if (!CLIP) await page.screenshot({ path: `${out}-3-tower-rush.png` });
await page.waitForFunction(() => window.__broccoli.match.buildings[10].owner === 0, null, { timeout: 40000 });
await page.waitForTimeout(450);
if (!CLIP) await page.screenshot({ path: `${out}-4-capture.png` });
const res = await page.evaluate(() => { const m = window.__broccoli.match; return { tick: m.tick, owner10: m.buildings[10].owner, garrison10: Math.floor(m.buildings[10].garrison) }; });
if (CLIP) {
  await page.waitForTimeout(2600);
  const audio = await page.evaluate(() => window.__broccoliAudio.stopRecording());
  await ctx.close();
  renameSync(join(vdir, readdirSync(vdir).find(x => x.endsWith('.webm'))), `${out}-video.webm`);
  writeFileSync(`${out}-audio.webm`, Buffer.from(audio.split(',')[1], 'base64'));
  console.log(JSON.stringify({ audioOffsetMs: audioStart - t0, ...res, orderTick: o, errors }));
} else { await ctx.close(); console.log(JSON.stringify({ ...res, orderTick: o, errors })); }
await browser.close();
