#!/bin/sh
# Tileable grayscale detail textures for BROCCOLI ground materials (ImageMagick; deterministic via -seed).
# Blurring with a tiling virtual-pixel makes every texture wrap seamlessly. Colour comes from the game's palette at
# draw time (the textures are applied with 'soft-light'), so the ground stays calmer than the armies.
set -e
OUT="$(dirname "$0")/../packages/content/textures"; mkdir -p "$OUT"
C="convert -seed 7 -size 128x128 xc:gray50 -virtual-pixel tile"
$C +noise Random -blur 0x0.7 -motion-blur 0x5+80 -colorspace gray -auto-level -level 20%,80% "$OUT/grass.png"         # short blades
$C +noise Random -blur 0x1.3 -colorspace gray -auto-level -level 28%,72% "$OUT/dirt.png"                                   # packed earth grit
$C +noise Random -blur 0x3 -colorspace gray -auto-level \( +clone -edge 1 -negate \) -compose multiply -composite -level 10%,90% "$OUT/rock.png"   # rough stone
$C +noise Random -motion-blur 0x18+0 -colorspace gray -auto-level -level 30%,70% "$OUT/wood.png"                       # grain
$C +noise Random -blur 0x2.4 -colorspace gray -auto-level -level 15%,85% "$OUT/leaf.png"                               # soft clumps
ls -l "$OUT"
