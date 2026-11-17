#!/bin/sh
# Copy Blender renders (tools/blender/broccoli_art.py writes them at 3x/4x) into the art pack at in-game resolution:
# buildings 1.5x, soldier 2x, tower head 2x. Usage: scripts/import-art.sh <folder with the rendered PNGs>
set -e
src="$1"; dst="$(dirname "$0")/../packages/content/art"
for f in "$src"/*.png; do
  n=$(basename "$f")
  case "$n" in tower_head*) k=67% ;; *) k=50% ;; esac
  convert "$f" -filter Lanczos -resize $k -define png:compression-level=9 -strip "$dst/$n"
done
echo "imported $(ls "$src"/*.png | wc -l) files into packages/content/art"
