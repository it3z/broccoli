// Ground materials: tileable grayscale detail maps made by scripts/make-textures.sh (ImageMagick), inlined at build time.
import grass from '../../../../packages/content/textures/grass.png';
import dirt from '../../../../packages/content/textures/dirt.png';
import rock from '../../../../packages/content/textures/rock.png';
import wood from '../../../../packages/content/textures/wood.png';
import leaf from '../../../../packages/content/textures/leaf.png';

export type Material = 'grass' | 'dirt' | 'rock' | 'wood' | 'leaf';
const SRC: Record<Material, string> = { grass, dirt, rock, wood, leaf };
const imgs = new Map<Material, HTMLImageElement>();
let loaded = 0;
export const texturesReady = () => loaded === Object.keys(SRC).length;
export function loadTextures(onReady: () => void): void {
  if (imgs.size) { if (texturesReady()) onReady(); return; }
  for (const [k, src] of Object.entries(SRC) as [Material, string][]) {
    const im = new Image(); im.onload = () => { loaded++; if (texturesReady()) onReady(); }; im.src = src; imgs.set(k, im);
  }
}
/** Overlay a material's detail on whatever path is current (soft-light keeps the underlying colour). */
export function texture(c: CanvasRenderingContext2D, m: Material, alpha: number, scale = 1): void {
  const im = imgs.get(m); if (!im || !im.complete || !im.naturalWidth) return;
  const pat = c.createPattern(im, 'repeat'); if (!pat) return;
  pat.setTransform(new DOMMatrix().scale(scale));
  c.save(); c.globalCompositeOperation = 'soft-light'; c.globalAlpha = alpha; c.fillStyle = pat; c.fill(); c.restore();
}
