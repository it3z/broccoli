---
name: broccoli-blender-art
description: Make BROCCOLI's buildings, soldier and props in Blender and drop them into the game's art pack. Use for any BROCCOLI 3D modelling, sprite rendering, art-pack slot or "replace the drawn art" request; it says which blender-* skills to load and how to render into packages/content/art/.
---

# BROCCOLI art from Blender

BROCCOLI draws on a 2D Canvas. Blender is the production tool for its painted look: models are built and
lit in Blender, then rendered to transparent PNG sprites that the game loads through its art pack.

## Before anything
1. Load `blender-core` and run `python .claude/skills/blender-core/scripts/run_in_blender.py --which`.
   If Blender is missing, say so plainly, stop the Blender part, and fall back to the procedural art
   (apps/client/src/render/art.ts) or ask the user for PNGs per `docs/ART_ASSETS_NEEDED.md`. Never claim a
   render exists without the PNG on disk.
2. Read `packages/content/art/manifest.json` (slots, sizes, pivots, frame order) and look at the matching
   template in `packages/content/art/templates/` for scale and silhouette.

## Which blender-* skills
| Task | Skills |
|---|---|
| Village, tower, forge models (chunky, stylized) | blender-scene-setup, blender-hardsurface-modeling, blender-sculpting (broccoli crowns) |
| Hand-painted look, outlines | blender-stylized-npr (toon bands + inverted-hull outline), blender-texturing |
| Soldier rig and run/attack/hit cycles | blender-character-rigging, blender-animation (loop_check) |
| Lighting | blender-lighting-lookdev — but the sprite light is fixed by the render script, do not add a second key |
| Batch renders, many owners/levels | blender-pipeline-automation, blender-rendering |
| Final checks | blender-asset-qa |

## House rules (same for every asset)
- Ground contact point at the object origin (0,0,0); +X is screen right, +Y goes away from the camera.
- 1 Blender metre = 100 game units by default: a village is about 2.5 m wide, a soldier about 0.4 m tall.
- Stylized and chunky: big readable shapes, toon shading, a dark outline; nothing finer than 2 px at game size.
- Team colour only on materials whose name contains `TEAM`, painted light grey (the game tints it), or render
  one file per owner with `--owner`.
- No ground shadow on the soldier (the game adds it); buildings carry their own yard/rock/ash base.

## Render into the game
```
blender -b farm.blend --python tools/blender/render_sprites.py -- --slot farm_1 --mask
blender -b soldier.blend --python tools/blender/render_sprites.py -- --slot soldier --object Soldier --run Run --attack Attack --hit Hit --mask
npm run build && npm run test:artpack
```
The script sets the shared camera (orthographic, ~51 deg, ground squashed 0.78), the upper-left key light, the
slot resolution and the pivot, and writes `packages/content/art/<slot>.png` (+ `_team.png`).

## Verify in the game, not in Blender
Build, start Spring Bridge, and capture `node scripts/showcase-bridge.mjs dist/broccoli.html <prefix>`.
Check at iPhone landscape size (844x390 CSS): soldier readable at ~23 px tall, team visible, feet on the
ground, no halo on the alpha edge, the same light direction as the other assets. Record source and licence
of anything you did not make in docs/ASSETS.md.
