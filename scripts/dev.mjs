// Dev server: rebuilds on change and serves on every network interface so a phone on the same Wi-Fi can connect.
import { context } from 'esbuild';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 5173);
const ctx = await context({
  entryPoints: [join(root, 'apps/client/src/main.ts')],
  bundle: true, sourcemap: 'inline', format: 'iife', target: ['es2020', 'safari15'],
  outfile: join(root, 'dist/app.js'), logLevel: 'info',
});
await ctx.watch();

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };
createServer(async (req, res) => {
  const path = normalize(decodeURIComponent((req.url || '/').split('?')[0])).replace(/^([/\\]|\.\.)+/, '');
  const file = path === '' || path === 'index.html' ? join(root, 'apps/client/index.html') : join(root, 'dist', path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(port, '0.0.0.0', () => {
  console.log(`\nBROCCOLI dev server\n  this PC:  http://localhost:${port}`);
  for (const list of Object.values(networkInterfaces())) for (const n of list || []) {
    if (n.family === 'IPv4' && !n.internal) console.log(`  phone:    http://${n.address}:${port}   (same Wi-Fi)`);
  }
});
