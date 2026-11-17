"""Render a Blender model into a BROCCOLI art-pack slot (packages/content/art/manifest.json).

Same camera, light and pixel scale for every asset, so buildings and soldiers made in Blender share one
perspective: orthographic, about 51 degrees above the ground (ground plane squashed to 0.78 on screen),
key light from the upper-left. The model's origin (0, 0, 0) is the ground contact point and lands on the
slot's pivot pixel. Output: transparent PNG at the slot's size, plus an optional team mask.

Run (Blender 5.2+ in the background):
  blender -b model.blend --python tools/blender/render_sprites.py -- --slot farm_1 --out packages/content/art
  blender -b soldier.blend --python tools/blender/render_sprites.py -- --slot soldier --object Soldier \
      --run Run --attack Attack --hit Hit --out packages/content/art

Options:
  --slot ID          manifest slot (farm_1..4, tower_1..4, tower_head, tower_head_drawn, forge_1, soldier, soldier_fall)
  --object NAME      object (or armature) to render; default: every visible object
  --units N          game world units per Blender metre (default 100: a 2.5 m house fills a building slot)
  --owner TAG        write <slot>@TAG.png instead of <slot>.png (0,1,2,3 or n)
  --mask             also write <slot>_team.png: white where a material's name contains TEAM, black elsewhere
  --run/--attack/--hit ACTION   soldier strip actions (4 run frames per facing, 2 attack, 1 hit)
  --engine EEVEE|CYCLES (default EEVEE) --samples N
Status: written against the Blender 5.x Python API; it has not been run in this repository yet because
Blender is not installed in the build environment. Check the first render against the template in
packages/content/art/templates/ before producing a full set.
"""
import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SQUASH = 0.78                                   # on-screen height of one unit of ground depth
ELEV = math.asin(SQUASH)                        # camera elevation above the ground plane (~51.3 deg)


def args():
    a = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    o = {'slot': None, 'object': None, 'units': 100.0, 'owner': None, 'mask': False, 'out': os.path.join(ROOT, 'packages/content/art'),
         'run': None, 'attack': None, 'hit': None, 'engine': 'EEVEE', 'samples': 64}
    i = 0
    while i < len(a):
        k = a[i].lstrip('-')
        if k == 'mask':
            o['mask'] = True; i += 1; continue
        o[k] = a[i + 1]; i += 2
    o['units'] = float(o['units']); o['samples'] = int(o['samples'])
    if not o['slot']:
        sys.exit('--slot is required')
    return o


def slot_spec(slot):
    m = json.load(open(os.path.join(ROOT, 'packages/content/art/manifest.json'), encoding='utf-8'))
    for s in m['slots']:
        if s['id'] == slot:
            return s
    sys.exit(f'unknown slot {slot}')


def setup_scene(o, fw, fh, scale, pivot):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES' if o['engine'].upper() == 'CYCLES' else 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in {e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items} else 'BLENDER_EEVEE'
    if sc.render.engine == 'CYCLES':
        sc.cycles.samples = o['samples']
    sc.render.film_transparent = True
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGBA'
    sc.view_settings.view_transform = 'Standard'          # flat sRGB so colours match the game's palette
    sc.render.resolution_x = round(fw * scale)
    sc.render.resolution_y = round(fh * scale)
    sc.render.resolution_percentage = 100
    # orthographic camera: right = +X, up = (0, cos a, sin a) with a = 90 deg - elevation
    tilt = math.pi / 2 - ELEV
    cam_data = bpy.data.cameras.new('BroccoliCam'); cam_data.type = 'ORTHO'
    cam_data.ortho_scale = max(fw, fh) / o['units']
    cam = bpy.data.objects.new('BroccoliCam', cam_data); sc.collection.objects.link(cam)
    cam.rotation_euler = (tilt, 0.0, 0.0)
    right, up = Vector((1, 0, 0)), Vector((0, math.cos(tilt), math.sin(tilt)))
    fwd = up.cross(right)                                  # direction the camera looks
    dx, dy = (pivot[0] - fw / 2) / o['units'], (pivot[1] - fh / 2) / o['units']
    cam.location = -right * dx + up * dy - fwd * 20.0      # origin lands on the pivot pixel
    sc.camera = cam
    # key light from the upper-left of the screen: from -X and from the far side (+Y), 45 deg up
    sun_data = bpy.data.lights.new('BroccoliSun', 'SUN'); sun_data.energy = 3.2; sun_data.angle = math.radians(8)
    sun = bpy.data.objects.new('BroccoliSun', sun_data); sc.collection.objects.link(sun)
    d = Vector((1, -1, -1.4)).normalized()                 # direction the light travels
    sun.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    if sc.world is None:
        sc.world = bpy.data.worlds.new('BroccoliWorld')
    sc.world.use_nodes = True
    bg = next((n for n in sc.world.node_tree.nodes if n.type == 'BACKGROUND'), None)
    if bg:
        bg.inputs[0].default_value = (0.78, 0.85, 0.95, 1); bg.inputs[1].default_value = 0.6   # soft sky fill
    return sc, cam


def only(o):
    if not o['object']:
        return
    keep = bpy.data.objects.get(o['object'])
    if keep is None:
        sys.exit(f"object {o['object']} not found")
    keep_set = {keep, *keep.children_recursive}
    for ob in bpy.context.scene.objects:
        if ob.type in {'MESH', 'CURVE', 'SURFACE', 'META', 'FONT', 'ARMATURE'} and ob not in keep_set:
            ob.hide_render = True


def render_to(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def with_mask_materials(fn):
    """Render with every material swapped for flat white (name contains TEAM) or black, then restore."""
    white, black = bpy.data.materials.new('MaskWhite'), bpy.data.materials.new('MaskBlack')
    for m, c in ((white, (1, 1, 1, 1)), (black, (0, 0, 0, 1))):
        m.use_nodes = True; nt = m.node_tree; nt.nodes.clear()
        e = nt.nodes.new('ShaderNodeEmission'); e.inputs[0].default_value = c
        out = nt.nodes.new('ShaderNodeOutputMaterial'); nt.links.new(e.outputs[0], out.inputs[0])
    saved = []
    for ob in bpy.context.scene.objects:
        for s in getattr(ob, 'material_slots', []):
            saved.append((s, s.material))
            s.material = white if s.material and 'TEAM' in s.material.name.upper() else black
    try:
        fn()
    finally:
        for s, m in saved:
            s.material = m


def stitch(paths, out, fw, fh, scale):
    """Join frame PNGs left to right into one strip."""
    w, h = round(fw * scale), round(fh * scale)
    strip = np.zeros((h, w * len(paths), 4), dtype=np.float32)
    for i, p in enumerate(paths):
        im = bpy.data.images.load(p); px = np.array(im.pixels[:], dtype=np.float32).reshape(im.size[1], im.size[0], 4)
        strip[:, i * w:(i + 1) * w] = px[:h, :w]; bpy.data.images.remove(im)
    img = bpy.data.images.new('strip', width=w * len(paths), height=h, alpha=True)
    img.pixels[:] = strip.ravel(); img.filepath_raw = out; img.file_format = 'PNG'; img.save()
    bpy.data.images.remove(img)
    for p in paths:
        os.remove(p)


def soldier_frames(o, sc, tag, fw, fh, scale):
    """15 frames: run facing right x4, toward camera x4, away x4, attack x2, hit x1."""
    rig = bpy.data.objects.get(o['object']) if o['object'] else next((x for x in sc.objects if x.type == 'ARMATURE'), None)
    if rig is None:
        sys.exit('soldier needs --object (the armature or root object)')
    ad = rig.animation_data or rig.animation_data_create()

    def frames(action_name, n):
        act = bpy.data.actions.get(action_name) if action_name else None
        if act is None:
            return [sc.frame_current] * n
        ad.action = act
        a, b = act.frame_range
        return [round(a + (b - a) * k / n) for k in range(n)]

    plan = []
    for yaw in (0.0, -math.pi / 2, math.pi / 2):           # +X (right), -Y (toward camera), +Y (away)
        plan += [(o['run'], yaw, f) for f in frames(o['run'], 4)]
    plan += [(o['attack'], 0.0, f) for f in frames(o['attack'], 2)]
    plan += [(o['hit'], 0.0, f) for f in frames(o['hit'], 1)]
    base_rot = rig.rotation_euler.copy()
    tmp = []
    for i, (act, yaw, f) in enumerate(plan):
        if act and bpy.data.actions.get(act):
            ad.action = bpy.data.actions[act]
        sc.frame_set(f)
        rig.rotation_euler = (base_rot[0], base_rot[1], base_rot[2] + yaw)
        p = os.path.join(o['out'], f'_tmp_{tag}_{i:02d}.png'); render_to(p); tmp.append(p)
    rig.rotation_euler = base_rot
    return tmp


def main():
    o = args(); spec = slot_spec(o['slot'])
    fw, fh = spec.get('frame', [spec['w'], spec['h']])
    scale, pivot = spec.get('scale', 3), spec['pivot']
    os.makedirs(o['out'], exist_ok=True)
    only(o)
    sc, _ = setup_scene(o, fw, fh, scale, pivot)
    name = o['slot'] + (f"@{o['owner']}" if o['owner'] else '')
    target = os.path.join(o['out'], name + '.png')
    if o['slot'] == 'soldier':
        stitch(soldier_frames(o, sc, 'c', fw, fh, scale), target, fw, fh, scale)
        if o['mask']:
            with_mask_materials(lambda: stitch(soldier_frames(o, sc, 'm', fw, fh, scale), os.path.join(o['out'], o['slot'] + '_team.png'), fw, fh, scale))
    else:
        render_to(target)
        if o['mask']:
            with_mask_materials(lambda: render_to(os.path.join(o['out'], o['slot'] + '_team.png')))
    print(json.dumps({'ok': True, 'slot': o['slot'], 'file': target, 'size': [round(fw * scale) * (15 if o['slot'] == 'soldier' else 1), round(fh * scale)]}))


main()
