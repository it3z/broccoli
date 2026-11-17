// End-to-end check of the art-pack import path: build with a throwaway pack folder holding recoloured templates and a team mask,
// build, open the game, confirm the pack loaded and the painted sprites are on screen, then remove the copies and rebuild.
// Usage: node scripts/test-artpack.mjs
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { rmSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..'), templates = join(root, 'packages/content/art/templates');
// a throwaway pack folder, so the real art pack is never touched
const art = mkdtempSync(join(tmpdir(), 'artpack-'));
const drop = [['farm_1@0', 'farm_1@0'], ['soldier@0', 'soldier@0'], ['tower_1@0', 'tower_1'], ['tower_1@0', 'tower_1_team']];
let ok = true;
const check = (c, msg) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${msg}`); ok &&= c; };
try {
  // magenta-shifted copies, so the swap is unmistakable in the screenshot
  // per-owner files: magenta-shifted copies, so the swap is unmistakable in the screenshot
  for (const [src, dst] of drop.slice(0, 2)) execSync(`convert "${join(templates, src + '.png')}" -modulate 100,120,40 "${join(art, dst + '.png')}"`);
  // neutral base + team mask: a grey tower whose saturated (team-painted) parts become the white mask
  const t = join(templates, 'tower_1@0.png');
  execSync(`convert "${t}" -colorspace Gray -level 0,80% "${join(art, 'tower_1.png')}"`);
  const tmp = join(art, '_mask');
  execSync(`convert "${t}" -alpha off -colorspace HSL -channel G -separate +channel -threshold 45% "${tmp}-s.png"`);
  execSync(`convert "${t}" -alpha extract "${tmp}-a.png"`);
  execSync(`convert "${tmp}-s.png" "${tmp}-a.png" -compose CopyOpacity -composite "${join(art, 'tower_1_team.png')}"`);
  rmSync(`${tmp}-s.png`); rmSync(`${tmp}-a.png`);
  const log = execSync('node scripts/build.mjs', { cwd: root, env: { ...process.env, BROCCOLI_BUILD: 'artpack-test', BROCCOLI_ART_DIR: art } }).toString();
  check(log.includes('art pack: 4 file(s)'), 'build inlined the 4 pack files');
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
  const red = await page.evaluate(() => window.__broccoliArtAverage('tower_1', 1)), grey = await page.evaluate(() => window.__broccoliArtAverage('tower_1', -1));
  check(red && grey && red[0] - red[1] > grey[0] - grey[1] + 4, `team mask tints the neutral base (red owner avg ${red}, neutral avg ${grey})`);
  mkdirSync(join(root, 'test-artifacts'), { recursive: true });
  await page.screenshot({ path: join(root, 'test-artifacts/artpack.png') });
  check(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await browser.close();
} finally {
  rmSync(art, { recursive: true, force: true });
  execSync('node scripts/build.mjs', { cwd: root });
}
console.log(ok ? 'art pack import works' : 'art pack check FAILED'); process.exit(ok ? 0 : 1);
