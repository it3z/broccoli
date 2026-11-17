// End-to-end check of the art-pack import path: drop recoloured copies of two templates into packages/content/art/,
// build, open the game, confirm the pack loaded and the painted sprites are on screen, then remove the copies and rebuild.
// Usage: node scripts/test-artpack.mjs
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..'), art = join(root, 'packages/content/art');
const drop = [['farm_1@0', 'farm_1@0'], ['soldier@0', 'soldier@0']];
let ok = true;
const check = (c, msg) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${msg}`); ok &&= c; };
try {
  // magenta-shifted copies, so the swap is unmistakable in the screenshot
  for (const [src, dst] of drop) execSync(`convert "${join(art, 'templates', src + '.png')}" -modulate 100,120,40 "${join(art, dst + '.png')}"`);
  const log = execSync('node scripts/build.mjs', { cwd: root, env: { ...process.env, BROCCOLI_BUILD: 'artpack-test' } }).toString();
  check(log.includes('art pack: 2 file(s)'), 'build inlined the 2 pack files');
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2 });
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.goto(pathToFileURL(join(root, 'dist/broccoli.html')).href);
  await page.click('#btnSolo'); await page.click('#maps .map:nth-child(1)'); await page.click('#btnStart');
  await page.waitForTimeout(800);
  await page.evaluate(() => { const s = window.__broccoli; s.ais.length = 0; s.match.enqueue({ type: 'send', player: 0, from: [0], to: 2, pct: 1 }); });
  await page.waitForTimeout(1500);
  const names = await page.evaluate(() => window.__broccoliArt());
  check(names.includes('farm_1@0') && names.includes('soldier@0'), `pack loaded in the game: ${names.join(', ')}`);
  mkdirSync(join(root, 'test-artifacts'), { recursive: true });
  await page.screenshot({ path: join(root, 'test-artifacts/artpack.png') });
  check(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await browser.close();
} finally {
  for (const [, dst] of drop) rmSync(join(art, dst + '.png'), { force: true });
  execSync('node scripts/build.mjs', { cwd: root });
}
console.log(ok ? 'art pack import works' : 'art pack check FAILED'); process.exit(ok ? 0 : 1);
