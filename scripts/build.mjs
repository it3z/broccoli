// Production build: dist/index.html + dist/app.js, plus dist/broccoli.html (everything in one file).
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(root, 'apps/client/src/main.ts')],
  bundle: true, minify: true, format: 'iife', target: ['es2020', 'safari15'],
  outfile: join(out, 'app.js'), logLevel: 'info',
});
const html = readFileSync(join(root, 'apps/client/index.html'), 'utf8');
writeFileSync(join(out, 'index.html'), html);
const js = readFileSync(join(out, 'app.js'), 'utf8').replace(/<\/script/g, '<\\/script');
writeFileSync(join(out, 'broccoli.html'), html.replace('<script src="app.js"></script>', () => `<script>${js}</script>`));
console.log('built dist/index.html, dist/app.js, dist/broccoli.html');
