// Production build: dist/index.html + dist/app.js, plus dist/broccoli.html (everything in one file).
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// build id: package version + UTC time + the commit the build was made from
let commit = 'nogit'; try { commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim(); } catch { /* not a git checkout */ }
const version = JSON.parse((await import('node:fs')).readFileSync(join(root, 'package.json'), 'utf8')).version;
const BUILD = process.env.BROCCOLI_BUILD || `v${version}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${commit}`;
const out = join(root, 'dist');
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(root, 'apps/client/src/main.ts')],
  define: { __BUILD__: JSON.stringify(BUILD) },
  bundle: true, minify: true, format: 'iife', target: ['es2020', 'safari15'],
  outfile: join(out, 'app.js'), logLevel: 'info',
});
const html = readFileSync(join(root, 'apps/client/index.html'), 'utf8')
  .replace('<div class="build"></div>', `<div class="build">${BUILD}</div>`)
  .replace('<title>', `<meta name="broccoli-build" content="${BUILD}">\n<title>`);
writeFileSync(join(out, 'index.html'), html);
const js = readFileSync(join(out, 'app.js'), 'utf8').replace(/<\/script/g, '<\\/script');
writeFileSync(join(out, 'broccoli.html'), html.replace('<script src="app.js"></script>', () => `<script>${js}</script>`));
console.log(`built ${BUILD}: dist/index.html, dist/app.js, dist/broccoli.html`);
