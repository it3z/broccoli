// Renders the current procedural sprites into packages/content/art/templates/ at 2x, in exactly the slot sizes,
// pivots and frame order the art pack expects (see packages/content/art/manifest.json). An artist can paint over
// these, and copying any of them into packages/content/art/ proves the import path end to end.
// Usage: node scripts/export-art.mjs
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artPack } from './artpack-plugin.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..'), out = join(root, 'packages/content/art/templates');
mkdirSync(out, { recursive: true });
const entry = `
import { staticBody, makeSoldierSheets, SOLDIER, FALL } from './apps/client/src/render/art';
const S = 2, files = {};
const png = cv => cv.toDataURL('image/png');
for (const [type, levels] of [['farm', 4], ['tower', 4], ['forge', 1]]) for (let l = 1; l <= levels; l++)
  for (const [tag, o] of [['n', -1], ['0', 0], ['1', 1]]) files[type + '_' + l + '@' + tag] = png(staticBody(type, l, o, S));
const sheets = makeSoldierSheets(S);
for (const [tag, i] of [['0', 0], ['1', 1], ['n', 4]]) {
  const sh = sheets[i], frames = [...sh.run, ...sh.runF, ...sh.runB, ...sh.attack, sh.hit];
  const strip = document.createElement('canvas'); strip.width = SOLDIER.w * S * frames.length; strip.height = SOLDIER.h * S;
  frames.forEach((f, k) => strip.getContext('2d').drawImage(f, k * SOLDIER.w * S, 0, SOLDIER.w * S, SOLDIER.h * S));
  files['soldier@' + tag] = png(strip); files['soldier_fall@' + tag] = png(sh.fall);
}
window.__files = files;`;
const res = await build({ stdin: { contents: entry, resolveDir: root, loader: 'ts' }, bundle: true, write: false, format: 'iife', loader: { '.png': 'dataurl' }, plugins: [artPack(root)] });
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
await page.setContent('<html><body></body></html>');
await page.addScriptTag({ content: res.outputFiles[0].text });
const files = await page.evaluate(() => window.__files);
for (const [name, url] of Object.entries(files)) writeFileSync(join(out, name + '.png'), Buffer.from(url.split(',')[1], 'base64'));
console.log(`wrote ${Object.keys(files).length} templates to packages/content/art/templates/`);
await browser.close();
