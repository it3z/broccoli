"""BROCCOLI kit: builds the village, tower, forge and broccoli soldier procedurally in Blender and renders every
art-pack slot (packages/content/art/manifest.json) with one shared camera and light.

Run it from Blender's Scripting tab (Text > Open, then Run Script) or headless:
  blender -b --factory-startup --python tools/blender/broccoli_kit.py -- --out C:/Users/<you>/ClaudeWork/broccoli_art
Writes <slot>.png (neutral, team parts light grey) + <slot>_team.png (white = team colour) per slot, and
broccoli_kit.blend so the models can be edited by hand later. It works in its own scene "BroccoliKit" and
does not touch other scenes. Rendering uses Cycles (shadow catcher for the contact shadows).
"""
import math
import os
import random
import sys
import time

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

# ---------------------------------------------------------------- settings
OUT = os.path.join(os.path.expanduser('~'), 'ClaudeWork', 'broccoli_art')
ONLY = None          # e.g. {'soldier'} to render a subset
SAMPLES_BUILDING, SAMPLES_SOLDIER = 32, 48
if '--' in sys.argv:
    a = sys.argv[sys.argv.index('--') + 1:]
    if '--out' in a: OUT = a[a.index('--out') + 1]
    if '--only' in a: ONLY = set(a[a.index('--only') + 1].split(','))
UNITS = 100.0                                  # game units per metre
SQUASH = 0.78                                  # ground depth on screen (camera ~51.3 deg)
TILT = math.pi / 2 - math.asin(SQUASH)
LOG = []


def log(msg):
    line = f'[{time.strftime("%H:%M:%S")}] {msg}'
    print(line); LOG.append(line)
    try:
        with open(os.path.join(OUT, 'kit_log.txt'), 'w', encoding='utf-8') as f: f.write('\n'.join(LOG))
    except OSError:
        pass


# ---------------------------------------------------------------- scene
def fresh_scene():
    old = bpy.data.scenes.get('BroccoliKit')
    if old:
        for ob in list(old.objects): bpy.data.objects.remove(ob, do_unlink=True)
        bpy.data.scenes.remove(old)
    sc = bpy.data.scenes.new('BroccoliKit')
    try: bpy.context.window.scene = sc
    except Exception: pass
    sc.render.engine = 'CYCLES'
    sc.cycles.use_denoising = True
    sc.cycles.max_bounces = 6; sc.cycles.transparent_max_bounces = 16
    sc.render.film_transparent = True
    sc.render.image_settings.file_format = 'PNG'; sc.render.image_settings.color_mode = 'RGBA'
    sc.render.resolution_percentage = 100
    try: sc.view_settings.view_transform = 'Standard'
    except TypeError: pass
    w = bpy.data.worlds.get('BroccoliWorld') or bpy.data.worlds.new('BroccoliWorld')
    sc.world = w
    if w.node_tree is None: w.use_nodes = True
    nt = w.node_tree; nt.nodes.clear()
    bg = nt.nodes.new('ShaderNodeBackground'); out = nt.nodes.new('ShaderNodeOutputWorld')
    bg.inputs['Color'].default_value = (0.62, 0.72, 0.85, 1); bg.inputs['Strength'].default_value = 0.75
    nt.links.new(bg.outputs[0], out.inputs[0])
    # key light from the screen's upper-left: travels toward +X, -Y and down
    sun = bpy.data.objects.new('KitSun', bpy.data.lights.new('KitSun', 'SUN')); sc.collection.objects.link(sun)
    sun.data.energy = 3.4; sun.data.angle = math.radians(6); sun.data.color = (1.0, 0.96, 0.88)
    sun.rotation_euler = Vector((1, -1, -1.4)).normalized().to_track_quat('-Z', 'Y').to_euler()
    cam = bpy.data.objects.new('KitCam', bpy.data.cameras.new('KitCam')); sc.collection.objects.link(cam)
    cam.data.type = 'ORTHO'; sc.camera = cam
    # contact shadows land on an invisible catcher
    me = bpy.data.meshes.new('KitCatcher'); bm = bmesh.new(); bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=4); bm.to_mesh(me); bm.free()
    catcher = bpy.data.objects.new('KitCatcher', me); sc.collection.objects.link(catcher); catcher.is_shadow_catcher = True
    return sc, cam, sun, catcher


def aim_camera(cam, sc, fw, fh, scale, pivot, top_down=False):
    sc.render.resolution_x, sc.render.resolution_y = round(fw * scale), round(fh * scale)
    cam.data.ortho_scale = max(fw, fh) / UNITS
    cam.data.sensor_fit = 'AUTO'
    t = 0.0 if top_down else TILT
    cam.rotation_euler = (t, 0, 0)
    right, up = Vector((1, 0, 0)), Vector((0, math.cos(t), math.sin(t)))
    fwd = up.cross(right)
    dx, dy = (pivot[0] - fw / 2) / UNITS, (pivot[1] - fh / 2) / UNITS
    cam.location = -right * dx + up * dy - fwd * 15.0
    cam.data.clip_end = 60


# ---------------------------------------------------------------- materials
MATS = {}


def mat(name, color, rough=0.6, metal=0.0, emit=None, strength=0.0, team=False):
    key = ('TEAM_' if team else '') + name
    if key in MATS: return MATS[key]
    m = bpy.data.materials.get('kit_' + key) or bpy.data.materials.new('kit_' + key)
    nt = m.node_tree; nt.nodes.clear()
    b = nt.nodes.new('ShaderNodeBsdfPrincipled'); o = nt.nodes.new('ShaderNodeOutputMaterial')
    c = tuple(int(color[i:i + 2], 16) / 255 for i in (1, 3, 5))
    b.inputs['Base Color'].default_value = (*[x ** 2.2 for x in c], 1)
    b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metal
    if emit:
        e = tuple(int(emit[i:i + 2], 16) / 255 for i in (1, 3, 5))
        b.inputs['Emission Color'].default_value = (*[x ** 2.2 for x in e], 1); b.inputs['Emission Strength'].default_value = strength
    nt.links.new(b.outputs[0], o.inputs[0])
    m['kit_team'] = team
    MATS[key] = m
    return m


def outline_mat():
    if 'OUTLINE' in MATS: return MATS['OUTLINE']
    m = bpy.data.materials.get('kit_outline') or bpy.data.materials.new('kit_outline')
    nt = m.node_tree; nt.nodes.clear()
    geo = nt.nodes.new('ShaderNodeNewGeometry'); mix = nt.nodes.new('ShaderNodeMixShader')
    em = nt.nodes.new('ShaderNodeEmission'); em.inputs['Color'].default_value = (0.03, 0.04, 0.02, 1)
    tr = nt.nodes.new('ShaderNodeBsdfTransparent'); o = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(geo.outputs['Backfacing'], mix.inputs[0])
    nt.links.new(em.outputs[0], mix.inputs[1]); nt.links.new(tr.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], o.inputs[0])
    m['kit_outline'] = True
    MATS['OUTLINE'] = m
    return m


def palette():
    P = {
        'floret_d': mat('floret_d', '#2f6a2a', 0.75), 'floret': mat('floret', '#4e9a38', 0.7), 'floret_l': mat('floret_l', '#86c455', 0.65),
        'stem': mat('stem', '#bcd884', 0.55), 'wood': mat('wood', '#8f5f31', 0.7), 'wood_d': mat('wood_d', '#5a3a1d', 0.75),
        'stone': mat('stone', '#a7a194', 0.85), 'stone_d': mat('stone_d', '#726d63', 0.9), 'stone_l': mat('stone_l', '#c9c2b0', 0.85),
        'soil': mat('soil', '#8c6d47', 0.95), 'ash': mat('ash', '#3c3430', 0.95), 'metal': mat('metal', '#c8ccd2', 0.35, 0.9),
        'gold': mat('gold', '#e9b949', 0.3, 1.0), 'glow': mat('glow', '#2a1a0a', 0.5, 0, '#ffc25a', 4.0),
        'fire': mat('fire', '#3a1405', 0.5, 0, '#ff7a1a', 9.0), 'ember': mat('ember', '#401000', 0.5, 0, '#ff5a10', 6.0),
        'black': mat('black', '#121212', 0.4), 'white': mat('white', '#f4f1e8', 0.4),
        'team': mat('team', '#dcdcdc', 0.55, team=True), 'team_cloth': mat('team_cloth', '#d4d4d4', 0.8, team=True),
    }
    return P


# ---------------------------------------------------------------- mesh helpers
COLL = {}


def link(ob, group):
    sc = bpy.data.scenes['BroccoliKit']
    c = COLL.get(group)
    if c is None:
        c = bpy.data.collections.new('kit_' + group); sc.collection.children.link(c); COLL[group] = c
    c.objects.link(ob)
    return ob


def obj_from_bm(name, bm, material, group, smooth=True, outline=0.0, parent=None):
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    if smooth: me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
    me.materials.append(material)
    ob = bpy.data.objects.new(name, me); link(ob, group)
    if outline > 0:
        me.materials.append(outline_mat())
        s = ob.modifiers.new('outline', 'SOLIDIFY'); s.thickness = outline; s.offset = 1.0
        s.use_flip_normals = True; s.material_offset = 1; s.use_rim = False
    if parent: ob.parent = parent
    return ob


def ico(name, group, loc, r, material, sub=2, scale=(1, 1, 1), outline=0.0, parent=None, smooth=True, jitter=0.0, seed=0):
    bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=r)
    if jitter:
        rr = random.Random(seed)
        for v in bm.verts: v.co *= 1 + rr.uniform(-jitter, jitter)
    for v in bm.verts: v.co = Vector((v.co.x * scale[0], v.co.y * scale[1], v.co.z * scale[2]))
    ob = obj_from_bm(name, bm, material, group, smooth, outline, parent); ob.location = loc
    return ob


def cyl(name, group, loc, r, h, material, verts=24, r2=None, outline=0.0, parent=None, smooth=True, rot=(0, 0, 0)):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=verts, radius1=r, radius2=r if r2 is None else r2, depth=h)
    ob = obj_from_bm(name, bm, material, group, smooth, outline, parent); ob.location = loc; ob.rotation_euler = rot
    return ob


def box(name, group, loc, size, material, outline=0.0, parent=None, rot=(0, 0, 0), bevel=0.0):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts: v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    ob = obj_from_bm(name, bm, material, group, False, outline, parent); ob.location = loc; ob.rotation_euler = rot
    if bevel:
        b = ob.modifiers.new('bevel', 'BEVEL'); b.width = bevel; b.segments = 2
        ob.modifiers.move(len(ob.modifiers) - 1, 0)
    return ob


def crown(group, P, center, radius, n, seed, outline=0.012, parent=None, flat=0.85, tag=''):
    """A broccoli crown: florets packed over a dome."""
    rr = random.Random(seed); obs = []; group_name = group; group = group
    name = group_name + tag
    golden = math.pi * (3 - math.sqrt(5))
    for i in range(n):
        y = 1 - (i / max(1, n - 1)) * 0.9            # upper hemisphere only
        rad = math.sqrt(max(0.0, 1 - y * y)); th = golden * i
        p = Vector((math.cos(th) * rad, math.sin(th) * rad, y * flat)) * radius
        r = radius * rr.uniform(0.34, 0.5)
        m = (P['floret_l'] if y > 0.7 else P['floret']) if rr.random() > 0.25 else P['floret_d']
        obs.append(ico(f'{name}_floret{i}', group, Vector(center) + p, r, m, sub=2, outline=outline, parent=parent, jitter=0.12, seed=seed + i))
    obs.append(ico(f'{name}_crowncore', group, Vector(center) + Vector((0, 0, radius * 0.15)), radius * 0.9, P['floret_d'], sub=2, parent=parent))
    return obs


def rocks(group, P, n, ring, seed, size=(0.12, 0.26), z=0.0, mat_key='stone_d', outline=0.01):
    rr = random.Random(seed)
    for i in range(n):
        a = i / n * math.tau + rr.uniform(-0.3, 0.3); d = rr.uniform(*ring)
        r = rr.uniform(*size)
        ico(f'{group}_rock{i}', group, (math.cos(a) * d, math.sin(a) * d, z + r * 0.25), r, P[mat_key if rr.random() > 0.3 else 'stone'],
            sub=1, scale=(1, rr.uniform(0.8, 1.2), rr.uniform(0.45, 0.7)), outline=outline, smooth=False, jitter=0.18, seed=seed * 31 + i)


# ---------------------------------------------------------------- buildings
def build_farm(P, level):
    g = f'farm_{level}'; o = 0.014
    # yard: flagstones and two steps toward the camera
    cyl(g + '_yard', g, (0, 0.04, 0.02), 0.66, 0.04, P['stone_l'], verts=40, outline=o, smooth=False)
    rr = random.Random(level)
    for i in range(14):
        a = i / 14 * math.tau; d = rr.uniform(0.5, 0.64)
        box(f'{g}_flag{i}', g, (math.cos(a) * d, 0.04 + math.sin(a) * d, 0.035), (0.16, 0.11, 0.03), P['stone'], rot=(0, 0, a + rr.uniform(-.3, .3)))
    box(g + '_step1', g, (0, -0.5, 0.03), (0.34, 0.12, 0.06), P['stone'], outline=o, bevel=0.01)
    box(g + '_step2', g, (0, -0.62, 0.015), (0.4, 0.12, 0.03), P['stone_d'], outline=o, bevel=0.01)
    # cottage
    box(g + '_body', g, (0, 0.08, 0.24), (0.78, 0.56, 0.44), P['wood'], outline=o, bevel=0.02)
    for sx in (-1, 1):
        box(f'{g}_beam{sx}', g, (sx * 0.38, -0.2, 0.24), (0.06, 0.06, 0.46), P['wood_d'], outline=o)
    box(g + '_lintel', g, (0, -0.205, 0.45), (0.82, 0.06, 0.06), P['wood_d'], outline=o)
    box(g + '_door', g, (0, -0.205, 0.15), (0.2, 0.03, 0.28), P['wood_d'], outline=o)
    box(g + '_doortrim', g, (0, -0.215, 0.3), (0.26, 0.03, 0.04), P['team'], outline=o)
    for sx in (-1, 1):
        box(f'{g}_win{sx}', g, (sx * 0.24, -0.21, 0.27), (0.11, 0.02, 0.11), P['glow'])
        box(f'{g}_winf{sx}', g, (sx * 0.24, -0.215, 0.27), (0.14, 0.015, 0.14), P['wood_d'])
    # awning over the door in the team colour
    box(g + '_awning', g, (0, -0.29, 0.4), (0.4, 0.16, 0.025), P['team_cloth'], outline=o, rot=(math.radians(-22), 0, 0))
    # broccoli crown roof on a stem
    cyl(g + '_trunk', g, (0, 0.1, 0.55), 0.16, 0.25, P['stem'], outline=o)
    big = 1.0 + 0.12 * (level - 1)
    crown(g, P, (0, 0.1, 0.7), 0.46 * big, 26, 100 + level, outline=o)
    # props
    cyl(g + '_barrel', g, (-0.5, -0.25, 0.1), 0.08, 0.2, P['wood'], outline=o)
    box(g + '_crate', g, (0.5, -0.28, 0.07), (0.14, 0.14, 0.14), P['wood'], outline=o, rot=(0, 0, 0.3), bevel=0.01)
    if level >= 2:   # side wing
        box(g + '_wing', g, (0.5, 0.18, 0.17), (0.34, 0.4, 0.3), P['wood'], outline=o, bevel=0.015)
        crown(g, P, (0.5, 0.2, 0.36), 0.22, 12, 200 + level, outline=o, tag='w')
    if level >= 3:   # second wing and a fence
        box(g + '_wing2', g, (-0.5, 0.2, 0.15), (0.3, 0.36, 0.26), P['wood'], outline=o, bevel=0.015)
        crown(g, P, (-0.5, 0.22, 0.32), 0.2, 11, 300 + level, outline=o, tag='w2')
        for i in range(9):
            a = math.pi * (1.1 + i / 8 * 0.8)
            cyl(f'{g}_post{i}', g, (math.cos(a) * 0.62, 0.04 + math.sin(a) * 0.62 * 0.9, 0.09), 0.018, 0.16, P['wood_d'], verts=8, outline=o)
    if level >= 4:   # golden finial
        cyl(g + '_finialstem', g, (0, 0.1, 0.7 + 0.46 * big + 0.12), 0.02, 0.16, P['gold'], verts=10)
        ico(g + '_finial', g, (0, 0.1, 0.7 + 0.46 * big + 0.22), 0.06, P['gold'], outline=o)


def tower_height(level):
    # the game draws the launcher head (75 + 9*level) units above the pivot; a height z shows as z*sin(TILT) on screen
    return (0.75 + 0.09 * level) / math.sin(TILT) - 0.12


def build_tower(P, level):
    g = f'tower_{level}'; o = 0.014; h = tower_height(level)
    rocks(g, P, 9, (0.18, 0.42), 40 + level, size=(0.13, 0.24))
    ico(g + '_mound', g, (0, 0, 0.02), 0.42, P['stone_d'], sub=2, scale=(1, 0.9, 0.3), outline=o, jitter=0.1, seed=7)
    cyl(g + '_shaft', g, (0, 0, 0.08 + h / 2), 0.25, h, P['stone'], verts=14, r2=0.22, outline=o, smooth=False)
    for k in range(1, int(h / 0.22) + 1):
        cyl(f'{g}_band{k}', g, (0, 0, 0.08 + k * 0.22), 0.262 - k * 0.006, 0.035, P['stone_d'], verts=14, smooth=False)
    box(g + '_slit', g, (0, -0.24, 0.08 + h * 0.55), (0.05, 0.03, 0.16), P['black'])
    # thorn vine spiralling up
    for k in range(int(10 + level * 2)):
        t = k / (10 + level * 2); a = t * math.tau * 1.6
        z = 0.15 + t * h * 0.85; r = 0.24
        ico(f'{g}_vine{k}', g, (math.cos(a) * r, math.sin(a) * r, z), 0.035, P['floret'], sub=1, outline=0.006)
        if k % 2 == 0:
            cyl(f'{g}_thorn{k}', g, (math.cos(a) * (r + 0.05), math.sin(a) * (r + 0.05), z), 0.02, 0.09, P['stem'], verts=6, r2=0.0,
                rot=(0, math.pi / 2, a), smooth=False)
    # hanging team banner on the front
    box(g + '_banner', g, (0, -0.255, 0.08 + h * 0.72), (0.16, 0.012, 0.26), P['team_cloth'], outline=0.008)
    box(g + '_bannerbar', g, (0, -0.26, 0.08 + h * 0.72 + 0.14), (0.22, 0.02, 0.02), P['wood_d'])
    top = 0.08 + h
    pr = 0.3 + 0.05 * max(0, level - 2)
    if level >= 2:   # throwing platform
        cyl(g + '_deck', g, (0, 0, top + 0.02), pr, 0.05, P['wood'], verts=20, outline=o, smooth=False)
        for i in range(8):
            a = i / 8 * math.tau
            cyl(f'{g}_rail{i}', g, (math.cos(a) * (pr - 0.02), math.sin(a) * (pr - 0.02), top + 0.08), 0.015, 0.1, P['wood_d'], verts=6)
    else:
        cyl(g + '_cap', g, (0, 0, top + 0.02), 0.25, 0.05, P['stone_d'], verts=14, outline=o, smooth=False)
    if level >= 4:   # stone crown
        for i in range(8):
            a = i / 8 * math.tau
            box(f'{g}_merlon{i}', g, (math.cos(a) * (pr + 0.02), math.sin(a) * (pr + 0.02), top + 0.1), (0.09, 0.09, 0.12), P['stone_l'],
                outline=o, rot=(0, 0, a))


def build_tower_head(P, drawn):
    g = 'tower_head_drawn' if drawn else 'tower_head'; o = 0.006
    cyl(g + '_base', g, (0, 0, 0.02), 0.12, 0.04, P['wood_d'], verts=20, outline=o)
    cyl(g + '_ring', g, (0, 0, 0.045), 0.1, 0.012, P['team'], verts=20)
    box(g + '_stock', g, (0.04, 0, 0.07), (0.3, 0.05, 0.035), P['wood'], outline=o)
    pull = -0.07 if drawn else 0.0
    for sy in (-1, 1):   # bow arms
        box(f'{g}_arm{sy}', g, (0.14, sy * 0.09, 0.075), (0.035, 0.18, 0.025), P['wood_d'], outline=o, rot=(0, 0, sy * math.radians(28 if drawn else 18)))
        cyl(f'{g}_str{sy}', g, (0.06 + pull / 2, sy * 0.085, 0.08), 0.004, 0.19, P['white'], verts=6, rot=(math.pi / 2, 0, sy * math.radians(55 if drawn else 70)))
    cyl(g + '_bolt', g, (0.1 + pull, 0, 0.095), 0.008, 0.26, P['wood_d'], verts=8, rot=(0, math.pi / 2, 0))
    cyl(g + '_tip', g, (0.24 + pull, 0, 0.095), 0.016, 0.05, P['metal'], verts=8, r2=0.0, rot=(0, math.pi / 2, 0))


def build_forge(P):
    g = 'forge_1'; o = 0.014
    ico(g + '_scorch', g, (0, 0.05, 0), 0.62, P['ash'], sub=2, scale=(1, 0.85, 0.04))
    rr = random.Random(9)
    for i in range(16):
        a = rr.uniform(0, math.tau); d = rr.uniform(0.25, 0.6)
        ico(f'{g}_ash{i}', g, (math.cos(a) * d, 0.05 + math.sin(a) * d * 0.85, 0.02), rr.uniform(0.03, 0.06), P['ash' if i % 3 else 'stone_d'], sub=1, scale=(1, 1, 0.4))
    for i in range(7):
        a = rr.uniform(math.pi * 1.1, math.pi * 1.9); d = rr.uniform(0.2, 0.45)
        ico(f'{g}_ember{i}', g, (math.cos(a) * d, math.sin(a) * d, 0.025), 0.014, P['ember'], sub=1)
    # stone hall, front face at y=0 so the furnace mouth sits where the game draws its fire
    box(g + '_hall', g, (0, 0.26, 0.2), (0.74, 0.52, 0.4), P['stone'], outline=o, bevel=0.025)
    for i in range(6):
        box(f'{g}_course{i}', g, (0, 0.0, 0.05 + i * 0.065), (0.76, 0.012, 0.012), P['stone_d'])
    for sx in (-1, 1):   # timber gable roof
        box(f'{g}_roof{sx}', g, (sx * 0.2, 0.26, 0.5), (0.48, 0.62, 0.05), P['wood_d'], outline=o, rot=(0, sx * math.radians(32), 0))
    box(g + '_ridge', g, (0, 0.26, 0.64), (0.06, 0.64, 0.06), P['wood'], outline=o)
    box(g + '_chimney', g, (0.24, 0.42, 0.62), (0.14, 0.14, 0.4), P['stone_d'], outline=o, bevel=0.01)
    # furnace mouth (lit) and anvil
    box(g + '_arch', g, (-0.04, -0.005, 0.14), (0.26, 0.04, 0.26), P['stone_d'], outline=o, bevel=0.02)
    box(g + '_mouth', g, (-0.04, -0.03, 0.13), (0.17, 0.02, 0.18), P['fire'])
    box(g + '_anvil', g, (0.38, -0.2, 0.08), (0.16, 0.08, 0.06), P['metal'], outline=o)
    box(g + '_anvilbase', g, (0.38, -0.2, 0.03), (0.08, 0.06, 0.06), P['wood_d'], outline=o)
    box(g + '_sign', g, (-0.3, -0.04, 0.33), (0.14, 0.02, 0.1), P['team'], outline=0.008)


# ---------------------------------------------------------------- soldier (rig = parented parts, posed per frame)
def build_soldier(P):
    g = 'soldier'; o = 0.0055
    root = bpy.data.objects.new('soldier_root', None); link(root, g)
    hip = bpy.data.objects.new('soldier_hip', None); link(hip, g); hip.parent = root; hip.location = (0, 0, 0.11)
    legs = []
    for sy in (-1, 1):
        leg = bpy.data.objects.new(f'soldier_legpivot{sy}', None); link(leg, g); leg.parent = hip; leg.location = (0, sy * 0.035, 0)
        cyl(f'soldier_leg{sy}', g, (0, 0, -0.05), 0.022, 0.1, P['floret_d'], verts=10, outline=o, parent=leg)
        ico(f'soldier_foot{sy}', g, (0.012, 0, -0.1), 0.026, P['wood_d'], sub=1, scale=(1.4, 1, 0.6), outline=o, parent=leg)
        legs.append(leg)
    body = bpy.data.objects.new('soldier_body', None); link(body, g); body.parent = hip
    cyl('soldier_torso', g, (0, 0, 0.06), 0.06, 0.13, P['stem'], verts=16, r2=0.052, outline=o, parent=body)
    cyl('soldier_tunic', g, (0, 0, 0.035), 0.064, 0.07, P['team_cloth'], verts=16, r2=0.06, outline=o, parent=body)
    cyl('soldier_belt', g, (0, 0, 0.003), 0.066, 0.016, P['wood_d'], verts=16, parent=body)
    ico('soldier_face', g, (0, 0, 0.16), 0.058, P['stem'], sub=2, outline=o, parent=body)
    for sy in (-1, 1):
        ico(f'soldier_eye{sy}', g, (0.05, sy * 0.022, 0.165), 0.011, P['black'], sub=1, parent=body)
    crown('soldier', P, (0, 0, 0.215), 0.075, 9, 77, outline=o, parent=body, flat=0.7)
    arms = {}
    for sy, key in ((-1, 'shield'), (1, 'spear')):
        sh = bpy.data.objects.new(f'soldier_shoulder{sy}', None); link(sh, g); sh.parent = body; sh.location = (0, sy * 0.068, 0.1)
        cyl(f'soldier_arm{sy}', g, (0, 0, -0.04), 0.016, 0.08, P['stem'], verts=8, outline=o, parent=sh)
        arms[key] = sh
    # round team shield on the camera side (-Y), wooden rim and a metal boss
    cyl('soldier_shieldrim', g, (0.02, -0.03, -0.06), 0.072, 0.012, P['wood'], verts=24, outline=o, parent=arms['shield'], rot=(math.pi / 2, 0, 0))
    cyl('soldier_shield', g, (0.02, -0.038, -0.06), 0.062, 0.008, P['team'], verts=24, parent=arms['shield'], rot=(math.pi / 2, 0, 0))
    ico('soldier_boss', g, (0.02, -0.045, -0.06), 0.017, P['metal'], sub=1, parent=arms['shield'])
    # spear held upright in the far hand
    cyl('soldier_spear', g, (0.02, 0.0, 0.02), 0.008, 0.36, P['wood'], verts=8, outline=0.004, parent=arms['spear'])
    cyl('soldier_tip', g, (0.02, 0.0, 0.225), 0.018, 0.05, P['metal'], verts=8, r2=0.0, outline=0.004, parent=arms['spear'])
    return root, hip, body, legs, arms


def pose_soldier(rig, kind, t):
    root, hip, body, legs, arms = rig
    hip.location = (0, 0, 0.11); hip.rotation_euler = (0, 0, 0); body.rotation_euler = (0, 0, 0)
    for leg in legs: leg.rotation_euler = (0, 0, 0)
    arms['shield'].rotation_euler = (0, 0, 0); arms['spear'].rotation_euler = (0, 0, 0)
    if kind == 'run':
        s = math.sin(t * math.tau)
        legs[0].rotation_euler = (0, s * 0.6, 0); legs[1].rotation_euler = (0, -s * 0.6, 0)
        hip.location = (0, 0, 0.11 + abs(math.cos(t * math.tau)) * 0.012)
        body.rotation_euler = (0, 0.14, 0)
        arms['shield'].rotation_euler = (0, -s * 0.3 - 0.3, 0); arms['spear'].rotation_euler = (0, s * 0.35, 0)
    elif kind == 'windup':
        body.rotation_euler = (0, -0.12, 0); arms['spear'].rotation_euler = (0, -0.9, 0); arms['shield'].rotation_euler = (0, -0.6, 0)
        legs[0].rotation_euler = (0, 0.35, 0); legs[1].rotation_euler = (0, -0.25, 0)
    elif kind == 'thrust':
        body.rotation_euler = (0, 0.32, 0); arms['spear'].rotation_euler = (0, 1.35, 0); arms['shield'].rotation_euler = (0, -0.9, 0)
        legs[0].rotation_euler = (0, 0.5, 0); legs[1].rotation_euler = (0, -0.45, 0); hip.location = (0, 0, 0.1)
    elif kind == 'hit':
        body.rotation_euler = (0, -0.42, 0); arms['spear'].rotation_euler = (0, -1.2, 0); arms['shield'].rotation_euler = (0, -1.6, 0)
        legs[0].rotation_euler = (0, -0.3, 0); legs[1].rotation_euler = (0, 0.2, 0)
    elif kind == 'fall':
        body.rotation_euler = (0, -0.2, 0); arms['spear'].rotation_euler = (0, -2.2, 0); arms['shield'].rotation_euler = (0, -2.4, 0)


# ---------------------------------------------------------------- rendering
def show_only(sc, group, catcher, with_shadow):
    for name, c in COLL.items():
        hidden = name != group
        c.hide_render = hidden
    catcher.hide_render = not with_shadow


def render(sc, path):
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True, scene=sc.name)


def mask_mode(on):
    """Swap every material for flat white (team) or black emission, outlines stay black/transparent."""
    if on:
        white = bpy.data.materials.get('kit_maskW') or bpy.data.materials.new('kit_maskW')
        black = bpy.data.materials.get('kit_maskB') or bpy.data.materials.new('kit_maskB')
        for m, c in ((white, (1, 1, 1, 1)), (black, (0, 0, 0, 1))):
            nt = m.node_tree; nt.nodes.clear()
            e = nt.nodes.new('ShaderNodeEmission'); e.inputs['Color'].default_value = c
            out = nt.nodes.new('ShaderNodeOutputMaterial'); nt.links.new(e.outputs[0], out.inputs[0])
        mask_mode.saved = []
        for c in COLL.values():
            for ob in c.objects:
                if ob.type != 'MESH': continue
                for i, m in enumerate(ob.data.materials):
                    if m is None or m.get('kit_outline'): continue
                    mask_mode.saved.append((ob.data, i, m))
                    ob.data.materials[i] = white if m.get('kit_team') else black
    else:
        for me, i, m in getattr(mask_mode, 'saved', []): me.materials[i] = m
        mask_mode.saved = []


def stitch(paths, out):
    ims = [bpy.data.images.load(p, check_existing=False) for p in paths]
    w, h = ims[0].size
    strip = np.zeros((h, w * len(ims), 4), dtype=np.float32)
    for i, im in enumerate(ims):
        buf = np.empty(w * h * 4, dtype=np.float32); im.pixels.foreach_get(buf)
        strip[:, i * w:(i + 1) * w] = buf.reshape(h, w, 4)
        bpy.data.images.remove(im)
    img = bpy.data.images.new('kit_strip', width=w * len(paths), height=h, alpha=True)
    img.pixels.foreach_set(strip.ravel()); img.filepath_raw = out; img.file_format = 'PNG'; img.save()
    bpy.data.images.remove(img)
    for p in paths: os.remove(p)


def want(slot):
    return ONLY is None or slot in ONLY or slot.split('_')[0] in ONLY


def main():
    os.makedirs(OUT, exist_ok=True)
    t0 = time.time()
    sc, cam, sun, catcher = fresh_scene()
    P = palette()
    for lv in (1, 2, 3, 4): build_farm(P, lv); build_tower(P, lv)
    build_forge(P); build_tower_head(P, False); build_tower_head(P, True)
    rig = build_soldier(P)
    log(f'built {len(sc.objects)} objects')
    jobs = [(f'farm_{l}', 'farm') for l in (1, 2, 3, 4)] + [(f'tower_{l}', 'tower') for l in (1, 2, 3, 4)] + [('forge_1', 'forge'), ('tower_head', 'head'), ('tower_head_drawn', 'head')]
    for slot, kind in jobs:
        if not want(slot): continue
        if kind == 'head': aim_camera(cam, sc, 48, 48, 3, (24, 24), top_down=True)
        else: aim_camera(cam, sc, 250, 280, 3, (125, 222))
        sc.cycles.samples = SAMPLES_BUILDING
        show_only(sc, slot, catcher, kind != 'head'); render(sc, os.path.join(OUT, slot + '.png'))
        show_only(sc, slot, catcher, False); mask_mode(True); render(sc, os.path.join(OUT, slot + '_team.png')); mask_mode(False)
        log(f'{slot}: done ({time.time() - t0:.0f}s)')
    if want('soldier'):
        sc.cycles.samples = SAMPLES_SOLDIER
        show_only(sc, 'soldier', catcher, False)
        root = rig[0]
        plan = [('run', 0.0, k / 4) for k in range(4)] + [('run', -math.pi / 2, k / 4) for k in range(4)] + [('run', math.pi / 2, k / 4) for k in range(4)]
        plan += [('windup', 0.0, 0), ('thrust', 0.0, 0), ('hit', 0.0, 0)]
        for mask in (False, True):
            aim_camera(cam, sc, 34, 42, 4, (17, 39))
            if mask: mask_mode(True)
            paths = []
            for i, (kind, yaw, t) in enumerate(plan):
                pose_soldier(rig, kind, t); root.rotation_euler = (0, 0, yaw); root.location = (0, 0, 0)
                sc.view_layers[0].update()
                p = os.path.join(OUT, f'_frame{i:02d}.png'); render(sc, p); paths.append(p)
            stitch(paths, os.path.join(OUT, 'soldier_team.png' if mask else 'soldier.png'))
            # knocked-out soldier lying on its back
            aim_camera(cam, sc, 46, 30, 4, (23, 24))
            pose_soldier(rig, 'fall', 0); root.rotation_euler = (0, -math.pi / 2 + 0.12, 0.35); root.location = (-0.12, 0, 0.07)
            sc.view_layers[0].update()
            render(sc, os.path.join(OUT, 'soldier_fall_team.png' if mask else 'soldier_fall.png'))
            root.rotation_euler = (0, 0, 0); root.location = (0, 0, 0)
            if mask: mask_mode(False)
        log(f'soldier: done ({time.time() - t0:.0f}s)')
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'broccoli_kit.blend'), copy=True)
    log(f'ALL DONE in {time.time() - t0:.0f}s -> {OUT}')


main()
