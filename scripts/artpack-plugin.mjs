// esbuild plugin: the virtual module "broccoli:artpack" maps every PNG in packages/content/art/ (not its subfolders) to a data URL.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export function artPack(root) {
  const dir = process.env.BROCCOLI_ART_DIR || join(root, 'packages/content/art');   // override used by scripts/test-artpack.mjs
  return {
    name: 'artpack',
    setup(b) {
      b.onResolve({ filter: /^broccoli:artpack$/ }, () => ({ path: 'artpack', namespace: 'artpack' }));
      b.onLoad({ filter: /.*/, namespace: 'artpack' }, () => {
        const pack = {};
        const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.png')).sort() : [];
        for (const f of files) pack[f.slice(0, -4)] = 'data:image/png;base64,' + readFileSync(join(dir, f)).toString('base64');
        if (files.length) console.log(`art pack: ${files.length} file(s) from packages/content/art`);
        return { contents: 'export default ' + JSON.stringify(pack), loader: 'js', watchDirs: [dir] };
      });
    },
  };
}
