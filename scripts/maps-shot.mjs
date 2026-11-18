// Screenshot each map 6 s into a match at iPhone landscape size. Usage: node scripts/maps-shot.mjs <abs path to broccoli.html> <out prefix>
import { chromium } from 'playwright';
const [html, out] = process.argv.slice(2);
const b = await chromium.launch({ channel: 'chrome' });
for (const i of [1, 2, 3]) {
  const p = await b.newPage({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto('file://' + html); await p.tap('#btnSolo'); await p.tap(`#maps .map:nth-child(${i})`); await p.tap('#btnStart');
  await p.waitForTimeout(6000); await p.screenshot({ path: `${out}-map${i}.png` }); console.log(i, errs.join('|') || 'ok'); await p.close();
}
await b.close();
