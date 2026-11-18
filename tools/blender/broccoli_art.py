"""BROCCOLI: Kingdom Clash - stylized 3D art built and rendered in Blender 5.3 into the game's art-pack slots.

Builds the broccoli soldier, the village (4 levels), the thorn tower (4 levels + launcher head) and the forge
from primitives, gives them toon materials with an inverted-hull outline, then renders every slot with one
shared camera (orthographic, ground squashed to 0.78) and one key light from the upper-left.
Writes transparent PNGs (+ team masks) to OUT/pack and a log to OUT/log.txt.

In Blender's Python console:
  exec(open(r"C:\\Users\\Atom\\ClaudeWork\\broccoli-art\\broccoli_art.py", encoding="utf-8").read())
Set MODE below: "test" renders a few previews, "all" renders the full pack.
"""
import json
import math
import os
import time
import traceback

import bpy
import numpy as np
from mathutils import Euler, Vector

OUT = globals().get("BROCCOLI_OUT", r"C:\Users\Atom\ClaudeWork\broccoli-art")   # set BROCCOLI_OUT before exec to render elsewhere
MODE = globals().get("BROCCOLI_MODE", "test")
UNITS = 100.0                      # game units per metre
SQUASH = 0.78
TILT = math.pi / 2 - math.asin(SQUASH)   # camera rotation about X (~38.7 deg)
PACK = os.path.join(OUT, "pack")
LOG = os.path.join(OUT, "log.txt")
os.makedirs(PACK, exist_ok=True)
log_lines = []


def log(*a):
    s = " ".join(str(x) for x in a)
    log_lines.append(s)
    print(s)
    with open(LOG, "w", encoding="utf-8") as f:
        f.write("\n".join(log_lines))


# ---------------------------------------------------------------- scene reset
def reset():
    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.cameras, bpy.data.lights, bpy.data.curves):
        for b in list(coll):
            coll.remove(b)
    for c in list(bpy.context.scene.collection.children):
        bpy.context.scene.collection.children.unlink(c)
    bpy.context.view_layer.active_layer_collection = bpy.context.view_layer.layer_collection


# ---------------------------------------------------------------- materials
def lin(hexs):
    h = hexs.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c) + (1.0,)


def shade(hexs, k):
    h = hexs.lstrip("#")
    c = [min(255, max(0, round(int(h[i:i + 2], 16) * k))) for i in (0, 2, 4)]
    return "#%02x%02x%02x" % tuple(c)


def hsv_shift(hexs, dv, ds, dh):
    """Painterly value change: darker tones get richer and cooler, lighter tones warmer (dh in turns)."""
    import colorsys
    h = hexs.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    hh, ss, vv = colorsys.rgb_to_hsv(r, g, b)
    hh = (hh + dh) % 1.0
    ss = min(1.0, ss * ds)
    vv = min(1.0, vv * dv)
    r, g, b = colorsys.hsv_to_rgb(hh, ss, vv)
    return "#%02x%02x%02x" % (round(r * 255), round(g * 255), round(b * 255))


MATS = {}


def toon(name, base, shadow=None, hi=None):
    """EEVEE toon: Shader to RGB of a white diffuse -> brightness -> 4 constant bands of the palette."""
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(name)
    if m.node_tree is None:
        m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    dif = nt.nodes.new("ShaderNodeBsdfDiffuse")
    dif.inputs["Color"].default_value = (1, 1, 1, 1)
    s2r = nt.nodes.new("ShaderNodeShaderToRGB")
    bw = nt.nodes.new("ShaderNodeRGBToBW")
    mul = nt.nodes.new("ShaderNodeMath")
    mul.operation = "MULTIPLY"
    mul.inputs[1].default_value = 0.5
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    cr = ramp.color_ramp
    cr.interpolation = "CONSTANT"
    shadow = shadow or hsv_shift(base, 0.62, 1.2, 0.03)
    hi = hi or hsv_shift(base, 1.15, 0.92, -0.015)
    cr.elements[0].position = 0.0
    cr.elements[0].color = lin(shadow)
    cr.elements[1].position = 0.30
    cr.elements[1].color = lin(hsv_shift(base, 0.84, 1.1, 0.012))
    e = cr.elements.new(0.42)
    e.color = lin(base)
    e = cr.elements.new(0.62)
    e.color = lin(hi)
    em = nt.nodes.new("ShaderNodeEmission")
    nt.links.new(dif.outputs[0], s2r.inputs[0])
    nt.links.new(s2r.outputs["Color"], bw.inputs[0])
    nt.links.new(bw.outputs[0], mul.inputs[0])
    nt.links.new(mul.outputs[0], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], em.inputs["Color"])
    nt.links.new(em.outputs[0], out.inputs["Surface"])
    MATS[name] = m
    return m


def glow(name, hexs, strength=2.0):
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(name)
    if m.node_tree is None:
        m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = lin(hexs)
    em.inputs["Strength"].default_value = strength
    nt.links.new(em.outputs[0], out.inputs["Surface"])
    MATS[name] = m
    return m


def outline_mat():
    if "OUTLINE" in MATS:
        return MATS["OUTLINE"]
    m = bpy.data.materials.new("OUTLINE")
    if m.node_tree is None:
        m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = lin("#1d2414")
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    mx = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(geo.outputs["Backfacing"], mx.inputs[0])
    nt.links.new(em.outputs[0], mx.inputs[1])
    nt.links.new(tr.outputs[0], mx.inputs[2])
    nt.links.new(mx.outputs[0], out.inputs["Surface"])
    m.use_backface_culling = True
    try:
        m.surface_render_method = "DITHERED"
    except Exception:
        pass
    MATS["OUTLINE"] = m
    return m


def palette():
    # saturated, sunlit palette (shadows are derived: cooler and richer; highlights warmer)
    toon("BroccoliHead", "#3daa35")
    toon("BroccoliTop", "#62c83f")
    toon("Stalk", "#b9e27a")
    toon("TEAM_cloth", "#f2f2f2", "#a9a9b4", "#ffffff")
    toon("Wood", "#b5793f")
    toon("WoodDark", "#7a4a24")
    toon("Plank", "#c98e4f")
    toon("Stone", "#b9b2a0")
    toon("StoneDark", "#8c8576")
    toon("Plaster", "#f7e3b2")
    toon("Steel", "#cfd8de", "#7c8a96", "#ffffff")
    toon("Gold", "#ffc93a")
    toon("Soil", "#bb8b52")
    toon("Grass", "#79c94a")
    toon("Ash", "#4e4743")
    toon("Coal", "#2f2b2a")
    toon("Roof", "#a5553a")
    toon("Leaf", "#52b83c")
    toon("TreeA", "#4fb441")
    toon("TreeB", "#72cf4c")
    toon("TreeC", "#9be260")
    toon("TreeDarkA", "#22764a")
    toon("TreeDarkB", "#2f9455")
    toon("TreeDarkC", "#4cb264")
    toon("Bark", "#8a5a33")
    toon("Rope", "#e8cf8a")
    toon("Moss", "#6dbb46")
    toon("Black", "#151515", "#000000", "#2a2a2a")
    toon("White", "#ffffff", "#d8d8e0", "#ffffff")
    glow("Window", "#ffd25e", 2.6)
    glow("Fire", "#ffb030", 5.0)
    glow("Ember", "#ff6a1a", 4.0)
    outline_mat()


# ---------------------------------------------------------------- primitives
def link(ob, parent=None):
    bpy.context.scene.collection.objects.link(ob)
    if parent is not None:
        ob.parent = parent
    return ob


def mesh_obj(name, verts, faces, mat, parent=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    ob = bpy.data.objects.new(name, me)
    ob.data.materials.append(MATS[mat])
    link(ob, parent)
    for p in me.polygons:
        p.use_smooth = True
    return ob


def prim(kind, name, mat, loc=(0, 0, 0), scale=(1, 1, 1), rot=(0, 0, 0), parent=None, outline=0.012, **kw):
    """Create a primitive with bpy.ops (works in the GUI and headless), then re-link and style it."""
    fn = {
        "ico": bpy.ops.mesh.primitive_ico_sphere_add,
        "uv": bpy.ops.mesh.primitive_uv_sphere_add,
        "cyl": bpy.ops.mesh.primitive_cylinder_add,
        "cone": bpy.ops.mesh.primitive_cone_add,
        "cube": bpy.ops.mesh.primitive_cube_add,
        "torus": bpy.ops.mesh.primitive_torus_add,
    }[kind]
    fn(**kw)
    ob = bpy.context.active_object
    ob.name = name
    ob.location = loc
    ob.scale = scale
    ob.rotation_euler = rot
    if parent is not None:
        ob.parent = parent
    ob.data.materials.clear()
    ob.data.materials.append(MATS[mat])
    if kind not in ("cube",):
        for p in ob.data.polygons:
            p.use_smooth = True
    if outline:
        add_outline(ob, outline)
    return ob


def add_outline(ob, width):
    ob.data.materials.append(MATS["OUTLINE"])
    md = ob.modifiers.new("Outline", "SOLIDIFY")
    sx = max(ob.scale) or 1
    md.thickness = width / sx
    md.offset = 1.0
    md.use_flip_normals = True
    md.use_rim = False
    md.material_offset = len(ob.data.materials) - 1


def empty(name, loc=(0, 0, 0), parent=None):
    ob = bpy.data.objects.new(name, None)
    ob.location = loc
    link(ob, parent)
    return ob


def floret(name, center, r, parent, n=9, seed=1, mat_lo="BroccoliHead", mat_hi="BroccoliTop"):
    """Broccoli crown: a dome of overlapping bumpy spheres."""
    rng = np.random.default_rng(seed)
    pieces = [prim("ico", f"{name}_core", mat_lo, loc=center, scale=(r * 0.95, r * 0.95, r * 0.78), parent=parent,
                   subdivisions=3, radius=1.0)]
    for i in range(n):
        a = i / n * math.tau + rng.uniform(-0.2, 0.2)
        up = rng.uniform(0.15, 0.75)
        d = r * rng.uniform(0.55, 0.75)
        c = (center[0] + math.cos(a) * d * (1 - up * 0.5), center[1] + math.sin(a) * d * (1 - up * 0.5), center[2] + up * r * 0.6)
        rr = r * rng.uniform(0.42, 0.58)
        pieces.append(prim("ico", f"{name}_{i}", mat_hi if up > 0.45 else mat_lo, loc=c, scale=(rr, rr, rr * 0.9),
                           parent=parent, subdivisions=2, radius=1.0))
    pieces.append(prim("ico", f"{name}_top", mat_hi, loc=(center[0], center[1], center[2] + r * 0.55),
                       scale=(r * 0.55, r * 0.55, r * 0.45), parent=parent, subdivisions=2, radius=1.0))
    for p in pieces:
        dm = p.modifiers.new("Bumps", "DISPLACE")
        tex = bpy.data.textures.get("BroccoliBumps") or bpy.data.textures.new("BroccoliBumps", "VORONOI")
        tex.noise_scale = 0.35
        dm.texture = tex
        dm.strength = 0.08
        p.modifiers.move(len(p.modifiers) - 1, 0)   # bumps before the outline shell
    return pieces


# ---------------------------------------------------------------- soldier
def build_soldier():
    root = empty("Soldier")
    # model scale; the root is stretched 1.6x in height so the soldier stands ~37 game units tall on screen
    # (the camera shows one metre of height as 0.625 m) and reads like the chibi silhouette of the 2D sprite
    S = 0.9
    root.scale = (1, 1, 1.6)
    body = empty("Body", parent=root)
    p = {}
    p["legL"] = prim("cyl", "LegL", "WoodDark", loc=(0, -0.035 * S, 0.05 * S), scale=(0.022 * S, 0.022 * S, 0.05 * S), parent=body, vertices=10)
    p["legR"] = prim("cyl", "LegR", "WoodDark", loc=(0, 0.035 * S, 0.05 * S), scale=(0.022 * S, 0.022 * S, 0.05 * S), parent=body, vertices=10)
    for k in ("legL", "legR"):
        p[k].data.transform(__import__("mathutils").Matrix.Translation((0, 0, -1)))   # pivot at the hip
        p[k].location.z = 0.1 * S
    p["stalk"] = prim("cone", "Stalk", "Stalk", loc=(0, 0, 0.165 * S), scale=(0.07 * S, 0.07 * S, 0.075 * S), parent=body,
                      vertices=16, radius1=1.0, radius2=0.8, depth=2.0)
    p["tunic"] = prim("cone", "Tunic", "TEAM_cloth", loc=(0, 0, 0.135 * S), scale=(0.08 * S, 0.08 * S, 0.045 * S), parent=body,
                      vertices=16, radius1=1.0, radius2=0.85, depth=2.0)
    p["belt"] = prim("torus", "Belt", "WoodDark", loc=(0, 0, 0.175 * S), scale=(0.071 * S, 0.071 * S, 0.06 * S), parent=body,
                     major_radius=1.0, minor_radius=0.12, major_segments=24, minor_segments=6, outline=0.006)
    head = empty("Head", loc=(0, 0, 0.258 * S), parent=body)
    head.scale = (1, 1, 0.72)
    floret("Crown", (0, 0, 0.0), 0.097 * S, head, n=8, seed=3)
    for i, y in enumerate((-0.03, 0.03)):
        prim("uv", f"Eye{i}", "Black", loc=(0.062 * S, y * S, 0.21 * S), scale=(0.012 * S, 0.012 * S, 0.016 * S), parent=body, outline=0,
             segments=10, ring_count=6)
        prim("uv", f"Glint{i}", "White", loc=(0.071 * S, y * S + 0.004, 0.214 * S), scale=(0.004 * S,) * 3, parent=body, outline=0,
             segments=6, ring_count=4)
    # shield on the near side (-Y when facing +X), facing the camera side
    shield = empty("Shield", loc=(0.01 * S, -0.085 * S, 0.17 * S), parent=body)
    shield.scale = (1, 1, 1 / 1.6)
    prim("cyl", "ShieldRim", "Wood", scale=(0.075 * S, 0.075 * S, 0.012 * S), rot=(math.pi / 2, 0, 0), parent=shield, vertices=24)
    prim("cyl", "ShieldFace", "TEAM_cloth", loc=(0, -0.006 * S, 0), scale=(0.062 * S, 0.062 * S, 0.008 * S), rot=(math.pi / 2, 0, 0),
         parent=shield, vertices=24, outline=0)
    prim("cyl", "ShieldBoss", "White", loc=(0, -0.012 * S, 0), scale=(0.024 * S, 0.024 * S, 0.006 * S), rot=(math.pi / 2, 0, 0),
         parent=shield, vertices=12, outline=0.004)
    # spear on the far side
    spear = empty("Spear", loc=(0.02 * S, 0.075 * S, 0.17 * S), parent=body)
    prim("cyl", "Shaft", "Wood", loc=(0.02 * S, 0, 0.05 * S), scale=(0.009 * S, 0.009 * S, 0.17 * S), rot=(0, 0.35, 0), parent=spear,
         vertices=8, outline=0.005)
    prim("cone", "Tip", "Steel", loc=(0.08 * S, 0, 0.215 * S), scale=(0.022 * S, 0.012 * S, 0.04 * S), rot=(0, 0.35, 0), parent=spear,
         vertices=4, outline=0.005)
    prim("uv", "HandR", "Stalk", loc=(0, 0, 0), scale=(0.022 * S,) * 3, parent=spear, segments=10, ring_count=6, outline=0.006)
    return {"root": root, "body": body, "head": head, "shield": shield, "spear": spear, **p, "S": S}


def pose_soldier(s, kind, t):
    """t in [0,1): phase of the run cycle; kind: run / windup / thrust / hit / fall / idle."""
    S = s["S"]
    sw = math.sin(t * math.tau)
    s["body"].location = (0, 0, 0)
    s["body"].rotation_euler = (0, 0, 0)
    s["head"].rotation_euler = (0, 0, 0)
    s["legL"].rotation_euler = (0, 0, 0)
    s["legR"].rotation_euler = (0, 0, 0)
    s["spear"].location = (0.02 * S, 0.075 * S, 0.17 * S)
    s["spear"].rotation_euler = (0, 0, 0)
    s["shield"].location = (0.01 * S, -0.085 * S, 0.17 * S)
    if kind == "run":
        s["legL"].rotation_euler = (0, 0.6 * sw, 0)
        s["legR"].rotation_euler = (0, -0.6 * sw, 0)
        s["body"].location = (0, 0, 0.012 * S * abs(math.cos(t * math.tau)))
        s["body"].rotation_euler = (0, 0.12, 0)          # lean into the run
        s["head"].rotation_euler = (0.06 * sw, 0, 0)
        s["spear"].rotation_euler = (0, 0.15 * sw, 0)
    elif kind == "windup":
        s["spear"].location = (-0.03 * S, 0.075 * S, 0.19 * S)
        s["spear"].rotation_euler = (0, -0.35, 0)
        s["body"].rotation_euler = (0, -0.1, 0)
    elif kind == "thrust":
        s["spear"].location = (0.08 * S, 0.06 * S, 0.17 * S)
        s["spear"].rotation_euler = (0, 0.9, 0)
        s["body"].rotation_euler = (0, 0.22, 0)
        s["legL"].rotation_euler = (0, 0.5, 0)
        s["legR"].rotation_euler = (0, -0.4, 0)
    elif kind == "hit":
        s["body"].rotation_euler = (0, -0.3, 0)
        s["body"].location = (-0.02 * S, 0, 0)
        s["head"].rotation_euler = (0, -0.25, 0)
    elif kind == "fall":
        s["body"].rotation_euler = (0, -math.pi / 2, 0)
        s["body"].location = (-0.12 * S, 0, 0.06 * S)
    bpy.context.view_layer.update()


# ---------------------------------------------------------------- buildings
def ground_disk(name, mat, rx, ry, parent, z=0.0, n=40, jitter=0.08, seed=1):
    rng = np.random.default_rng(seed)
    verts = [(0, 0, z)]
    for i in range(n):
        a = i / n * math.tau
        k = 1 + rng.uniform(-jitter, jitter)
        verts.append((math.cos(a) * rx * k, math.sin(a) * ry * k, z))
    faces = [(0, i + 1, (i + 1) % n + 1) for i in range(n)]
    ob = mesh_obj(name, verts, faces, mat, parent)
    return ob


def stones(name, parent, rx, ry, count, seed, mat="Stone", size=(0.08, 0.13), z=0.01):
    rng = np.random.default_rng(seed)
    out = []
    for i in range(count):
        a = rng.uniform(0, math.tau)
        d = math.sqrt(rng.uniform(0.15, 1.0))
        r = rng.uniform(*size)
        out.append(prim("ico", f"{name}{i}", mat, loc=(math.cos(a) * rx * d, math.sin(a) * ry * d, z), scale=(r, r * rng.uniform(0.7, 1.0), r * 0.35),
                        rot=(0, 0, rng.uniform(0, 3)), parent=parent, subdivisions=1, radius=1.0, outline=0.008))
    return out


BSCALE = 0.6   # buildings: ~150 game units wide, like the 2D art they replace


def build_farm(level):
    root = empty(f"Farm{level}")
    root.scale = (BSCALE,) * 3
    ground_disk("Yard", "Soil", 1.15, 0.7, root, seed=level)
    ground_disk("YardGrass", "Grass", 1.22, 0.75, root, z=-0.005, seed=level + 7)
    stones("Flag", root, 0.95, 0.6, 14, seed=11)
    # main house: plaster drum, wooden band, door and lit windows, broccoli crown roof
    prim("cyl", "Walls", "Plaster", loc=(0, 0, 0.42), scale=(0.52, 0.52, 0.42), parent=root, vertices=28, outline=0.014)
    prim("cyl", "Band", "TEAM_cloth", loc=(0, 0, 0.82), scale=(0.56, 0.56, 0.07), parent=root, vertices=28, outline=0.012)
    prim("cube", "Door", "WoodDark", loc=(0.0, -0.5, 0.24), scale=(0.13, 0.05, 0.24), parent=root, outline=0.01)
    prim("cube", "DoorGlow", "Window", loc=(0.0, -0.53, 0.2), scale=(0.08, 0.02, 0.16), parent=root, outline=0)
    for i, ax in enumerate((-0.32, 0.32)):
        prim("cube", f"Win{i}", "Window", loc=(ax, -0.42, 0.5), scale=(0.07, 0.05, 0.08), rot=(0, 0, -ax * 1.1), parent=root, outline=0.01)
    prim("cube", "Awning", "TEAM_cloth", loc=(0, -0.58, 0.55), scale=(0.24, 0.1, 0.03), rot=(0.45, 0, 0), parent=root, outline=0.01)
    prim("cube", "Step", "Stone", loc=(0, -0.62, 0.04), scale=(0.2, 0.09, 0.04), parent=root, outline=0.01)
    floret("Roof", (0, 0, 1.18 + 0.08 * level), 0.66 + 0.04 * level, root, n=10, seed=20 + level)
    # banner pole on the side carrying the team colour
    prim("cyl", "Pole", "WoodDark", loc=(0.62, -0.22, 0.75), scale=(0.025, 0.025, 0.75), parent=root, vertices=8, outline=0.008)
    prim("cube", "Banner", "TEAM_cloth", loc=(0.62, -0.26, 1.18), scale=(0.02, 0.17, 0.26), rot=(0, 0, 0.5), parent=root, outline=0.01)
    if level >= 2:   # side wing
        prim("cyl", "Wing", "Plaster", loc=(-0.72, 0.15, 0.25), scale=(0.3, 0.3, 0.25), parent=root, vertices=20, outline=0.012)
        floret("WingRoof", (-0.72, 0.15, 0.62), 0.36, root, n=7, seed=40)
        prim("cube", "WingWin", "Window", loc=(-0.72, -0.13, 0.28), scale=(0.06, 0.04, 0.07), parent=root, outline=0.008)
    if level >= 3:   # second wing + fence
        prim("cyl", "Wing2", "Plaster", loc=(0.72, 0.28, 0.22), scale=(0.27, 0.27, 0.22), parent=root, vertices=20, outline=0.012)
        floret("Wing2Roof", (0.72, 0.28, 0.55), 0.32, root, n=7, seed=41)
        for i in range(9):
            a = math.pi * 1.1 + i / 8 * math.pi * 0.8
            prim("cube", f"Post{i}", "Wood", loc=(math.cos(a) * 1.05, math.sin(a) * 0.62, 0.14), scale=(0.03, 0.03, 0.14), parent=root, outline=0.008)
        for i in range(8):
            a = math.pi * 1.1 + (i + 0.5) / 8 * math.pi * 0.8
            prim("cube", f"Rail{i}", "Wood", loc=(math.cos(a) * 1.05, math.sin(a) * 0.62, 0.2), scale=(0.13, 0.015, 0.015),
                 rot=(0, 0, a + math.pi / 2), parent=root, outline=0.006)
    if level >= 4:   # golden finial
        prim("cone", "Finial", "Gold", loc=(0, 0, 2.0 + 0.08 * level), scale=(0.07, 0.07, 0.16), parent=root, vertices=12, outline=0.01)
        prim("uv", "FinialBall", "Gold", loc=(0, 0, 1.86 + 0.08 * level), scale=(0.08,) * 3, parent=root, outline=0.01)
    return root


def build_tower(level):
    root = empty(f"Tower{level}")
    ground_disk("Moss", "Grass", 0.62, 0.42, root, seed=50 + level)
    rng = np.random.default_rng(5)
    for i in range(9):   # rock outcrop the tower stands on
        a = i / 9 * math.tau + rng.uniform(-0.3, 0.3)
        r = rng.uniform(0.12, 0.19)
        prim("ico", f"Rock{i}", "StoneDark" if i % 2 else "Stone", loc=(math.cos(a) * 0.33, math.sin(a) * 0.24, r * 0.35),
             scale=(r, r * 0.8, r * 0.75), rot=(0, 0, rng.uniform(0, 3)), parent=root, subdivisions=1, radius=1.0, outline=0.012)
    # body top so the head lands on its anchor: the game puts it (66 + 9*level) units above the pivot, and one metre
    # of height shows as 62.5 units from this camera
    top = (66 + 9 * level) / 62.5
    rings = 5 + level
    for i in range(rings):   # stacked stone courses, slightly tapering
        z0, z1 = 0.15 + (top - 0.15) * i / rings, 0.15 + (top - 0.15) * (i + 1) / rings
        r = 0.23 - 0.04 * i / rings
        prim("cyl", f"Course{i}", "Stone" if i % 2 == 0 else "StoneDark", loc=(0, 0, (z0 + z1) / 2), scale=(r, r, (z1 - z0) / 2 * 0.98),
             rot=(0, 0, i * 0.3), parent=root, vertices=10, outline=0.012)
    prim("cyl", "TeamRing", "TEAM_cloth", loc=(0, 0, top - 0.06), scale=(0.205, 0.205, 0.05), parent=root, vertices=12, outline=0.01)
    prim("cube", "Slit", "Black", loc=(0, -0.21, top * 0.62), scale=(0.025, 0.02, 0.08), parent=root, outline=0)
    prim("cube", "TowerBanner", "TEAM_cloth", loc=(0.0, -0.24, top * 0.36), scale=(0.09, 0.012, 0.17), parent=root, outline=0.01)
    for i in range(5 + level * 2):   # thorn vines
        a = i / (5 + level * 2) * math.tau
        z = 0.25 + (i * 0.37 % 1) * (top - 0.4)
        prim("cone", f"Thorn{i}", "Leaf", loc=(math.cos(a) * 0.22, math.sin(a) * 0.22, z), scale=(0.028, 0.028, 0.09),
             rot=(math.pi / 2, 0, a - math.pi / 2), parent=root, vertices=6, outline=0.006)
    if level >= 2:   # wooden throwing platform
        prim("cyl", "Deck", "TEAM_cloth", loc=(0, 0, top + 0.03), scale=(0.28 + 0.03 * (level - 2), 0.28 + 0.03 * (level - 2), 0.035), parent=root,
             vertices=16, outline=0.012)
    if level >= 4:   # stone crown
        for i in range(8):
            a = i / 8 * math.tau
            prim("cube", f"Merlon{i}", "Stone", loc=(math.cos(a) * 0.3, math.sin(a) * 0.3, top + 0.1), scale=(0.05, 0.05, 0.07),
                 rot=(0, 0, a), parent=root, outline=0.01)
    return root, top


def build_head(drawn=False):
    root = empty("Head")
    prim("cube", "Stock", "Wood", loc=(0, 0, 0), scale=(0.17, 0.035, 0.03), parent=root, outline=0.008)
    prim("cone", "Bolt", "Steel", loc=(0.2 - (0.05 if drawn else 0), 0, 0.04), scale=(0.02, 0.02, 0.05), rot=(0, math.pi / 2, 0), parent=root,
         vertices=6, outline=0.005)
    prim("cyl", "BoltShaft", "WoodDark", loc=(0.06 - (0.05 if drawn else 0), 0, 0.04), scale=(0.008, 0.008, 0.13), rot=(0, math.pi / 2, 0),
         parent=root, vertices=6, outline=0.004)
    bend = 0.06 if drawn else 0.0
    for sgn in (-1, 1):
        prim("cube", f"Limb{sgn}", "WoodDark", loc=(0.11 - bend * 0.5, sgn * 0.12, 0.02), scale=(0.02, 0.12, 0.02),
             rot=(0, 0, sgn * (0.35 + bend * 3)), parent=root, outline=0.006)
    prim("cube", "TEAM_band", "TEAM_cloth", loc=(-0.08, 0, 0.035), scale=(0.04, 0.04, 0.012), parent=root, outline=0.005)
    return root


def prism(name, mat, w, d, h, loc, parent, outline=0.012):
    """Gable roof: a triangular prism along X (w long, d deep, h high), eaves at z=0."""
    v = [(-w, -d, 0), (w, -d, 0), (w, d, 0), (-w, d, 0), (-w, 0, h), (w, 0, h)]
    f = [(0, 1, 5, 4), (2, 3, 4, 5), (0, 4, 3), (1, 2, 5), (0, 3, 2, 1)]
    ob = mesh_obj(name, v, f, mat, parent)
    ob.location = loc
    for p in ob.data.polygons:
        p.use_smooth = False
    add_outline(ob, outline)
    return ob


def build_forge():
    root = empty("Forge")
    root.scale = (BSCALE,) * 3
    rng = np.random.default_rng(72)
    ground_disk("Scorch", "Ash", 1.12, 0.7, root, seed=70, jitter=0.15)
    stones("Cinder", root, 0.95, 0.58, 12, seed=71, mat="StoneDark", size=(0.05, 0.09))
    # stone plinth, then walls laid in alternating courses of blocks
    prim("cube", "Plinth", "StoneDark", loc=(0, 0.05, 0.06), scale=(0.72, 0.5, 0.06), parent=root, outline=0.012)
    for row in range(5):
        z = 0.16 + row * 0.12
        off = 0.11 if row % 2 else 0.0
        for side, y, sx, sy in (("F", -0.37, 1, 0), ("B", 0.47, 1, 0)):
            x = -0.6 + off
            while x < 0.6:
                w = min(0.2, 0.6 - x)
                prim("cube", f"Blk{side}{row}_{x:.2f}", "Stone" if rng.random() > 0.35 else "StoneDark",
                     loc=(x + w / 2, y, z), scale=(w / 2 - 0.006, 0.05, 0.056), parent=root, outline=0.006)
                x += w
        for side, xx in (("L", -0.62), ("R", 0.62)):
            prim("cube", f"Side{side}{row}", "Stone" if (row + (side == "L")) % 2 else "StoneDark",
                 loc=(xx, 0.05, z), scale=(0.05, 0.42, 0.056), parent=root, outline=0.006)
    prim("cube", "Inner", "Coal", loc=(0, 0.05, 0.4), scale=(0.57, 0.4, 0.3), parent=root, outline=0)
    # gable roof in the team colour, with a ridge beam and a smoking chimney
    prism("Roof", "TEAM_cloth", 0.74, 0.55, 0.42, (0, 0.05, 0.76), root, outline=0.014)
    prim("cube", "Ridge", "WoodDark", loc=(0, 0.05, 1.19), scale=(0.76, 0.03, 0.03), parent=root, outline=0.008)
    slope = math.atan2(0.42, 0.55)
    for k in range(4):   # dark battens across both slopes break the roof into rows of tiles
        t = (k + 0.5) / 4
        for side in (-1, 1):
            prim("cube", f"Batten{side}{k}", "WoodDark", loc=(0, 0.05 + side * 0.55 * (1 - t), 0.76 + 0.42 * t + 0.012),
                 scale=(0.745, 0.012, 0.008), rot=(side * slope, 0, 0), parent=root, outline=0)
    prim("cube", "Chimney", "StoneDark", loc=(0.38, 0.22, 1.12), scale=(0.11, 0.11, 0.3), parent=root, outline=0.012)
    prim("cube", "ChimneyCap", "Stone", loc=(0.38, 0.22, 1.43), scale=(0.14, 0.14, 0.03), parent=root, outline=0.01)
    prim("cube", "ChimneyGlow", "Ember", loc=(0.38, 0.22, 1.465), scale=(0.08, 0.08, 0.01), parent=root, outline=0)
    # furnace: a stone arch on the front with a bright fire, embers and a coal heap
    prim("cyl", "Arch", "Stone", loc=(0, -0.43, 0.3), scale=(0.24, 0.24, 0.06), rot=(math.pi / 2, 0, 0), parent=root, vertices=20, outline=0.012)
    prim("cyl", "Mouth", "Coal", loc=(0, -0.48, 0.28), scale=(0.17, 0.17, 0.03), rot=(math.pi / 2, 0, 0), parent=root, vertices=20, outline=0)
    prim("cyl", "FireGlow", "Fire", loc=(0, -0.5, 0.24), scale=(0.13, 0.1, 0.02), rot=(math.pi / 2, 0, 0), parent=root, vertices=16, outline=0)
    for i in range(6):
        prim("ico", f"Ember{i}", "Ember", loc=(-0.1 + i * 0.04, -0.52, 0.17 + (i % 2) * 0.03), scale=(0.02,) * 3, parent=root,
             subdivisions=1, radius=1.0, outline=0)
    for i in range(7):
        a = rng.uniform(0, math.pi)
        prim("ico", f"Coal{i}", "Coal", loc=(-0.45 + math.cos(a) * 0.1, -0.55 + math.sin(a) * 0.05, 0.04), scale=(0.05, 0.05, 0.04),
             parent=root, subdivisions=1, radius=1.0, outline=0.005)
    # anvil on a stump, barrels and a tool rack
    prim("cyl", "Stump", "Bark", loc=(0.48, -0.56, 0.08), scale=(0.08, 0.08, 0.08), parent=root, vertices=12, outline=0.008)
    prim("cube", "Anvil", "Steel", loc=(0.48, -0.56, 0.2), scale=(0.11, 0.05, 0.04), parent=root, outline=0.008)
    prim("cone", "AnvilHorn", "Steel", loc=(0.62, -0.56, 0.2), scale=(0.04, 0.035, 0.06), rot=(0, math.pi / 2, 0), parent=root, vertices=8, outline=0.006)
    for i, (bx, by) in enumerate(((-0.72, -0.25), (-0.78, -0.02))):
        prim("cyl", f"Barrel{i}", "Wood", loc=(bx, by, 0.11), scale=(0.08, 0.08, 0.11), parent=root, vertices=14, outline=0.008)
        prim("torus", f"Hoop{i}", "Steel", loc=(bx, by, 0.15), scale=(0.083, 0.083, 0.08), parent=root, major_radius=1.0, minor_radius=0.08,
             major_segments=16, minor_segments=4, outline=0)
    prim("cube", "Banner", "TEAM_cloth", loc=(-0.38, -0.44, 0.52), scale=(0.1, 0.012, 0.17), parent=root, outline=0.008)
    return root


# ---------------------------------------------------------------- bridges, trees, rocks
def build_bridge_deck():
    """Plank deck spanning X (1.56 m between footings), deck top at z=0, rope rails on both sides."""
    root = empty("BridgeDeck")
    rng = np.random.default_rng(80)
    half, w = 0.74, 0.25
    for side in (-1, 1):
        prim("cube", f"Beam{side}", "WoodDark", loc=(0, side * w, -0.035), scale=(half + 0.04, 0.025, 0.03), parent=root, outline=0.008)
    x = -half
    i = 0
    while x < half:
        pw = rng.uniform(0.075, 0.095)
        prim("cube", f"Plank{i}", "Plank" if i % 3 else "Wood", loc=(x + pw / 2, rng.uniform(-0.01, 0.01), rng.uniform(-0.006, 0.006)),
             scale=(pw / 2 - 0.005, w + 0.02, 0.016), rot=(0, 0, rng.uniform(-0.03, 0.03)), parent=root, outline=0.005)
        x += pw
        i += 1
    for side in (-1, 1):
        posts = [-half + 0.04 + k * (2 * half - 0.08) / 4 for k in range(5)]
        for k, px in enumerate(posts):
            prim("cyl", f"Post{side}{k}", "WoodDark", loc=(px, side * (w + 0.03), 0.07), scale=(0.018, 0.018, 0.09), parent=root,
                 vertices=8, outline=0.005)
        for k in range(4):   # sagging rope between posts
            a, b = posts[k], posts[k + 1]
            for j in range(6):
                t = (j + 0.5) / 6
                z = 0.14 - 0.035 * math.sin(t * math.pi)
                prim("cyl", f"Rope{side}{k}{j}", "Rope", loc=(a + (b - a) * t, side * (w + 0.03), z), scale=(0.007, 0.007, (b - a) / 12 + 0.004),
                     rot=(0, math.pi / 2, 0), parent=root, vertices=6, outline=0)
    return root


def build_bridge_base():
    """Stone footings on both banks with dirt ramps; the deck is a separate sprite so a drawbridge can tilt."""
    root = empty("BridgeBase")
    rng = np.random.default_rng(81)
    for side in (-1, 1):
        ramp = ground_disk(f"Ramp{side}", "Soil", 0.32, 0.36, root, z=0.0, seed=82 + side)
        ramp.location = (side * 1.0, 0, -0.02)
        for row in range(3):
            for k in range(3):
                prim("cube", f"Foot{side}{row}{k}", "Stone" if (row + k) % 2 else "StoneDark",
                     loc=(side * 0.8 + rng.uniform(-0.01, 0.01), -0.2 + k * 0.2, -0.05 - row * 0.09),
                     scale=(0.07, 0.095, 0.043), parent=root, outline=0.006)
        for k in range(3):
            r = rng.uniform(0.05, 0.08)
            prim("ico", f"BankRock{side}{k}", "StoneDark", loc=(side * (0.9 + k * 0.08), rng.uniform(-0.38, 0.38), -0.02), scale=(r, r, r * 0.6),
                 parent=root, subdivisions=1, radius=1.0, outline=0.006)
    return root


def build_tree(name, seed, dark=False):
    root = empty(name)
    rng = np.random.default_rng(seed)
    mats = ("TreeDarkA", "TreeDarkB", "TreeDarkC") if dark else ("TreeA", "TreeB", "TreeC")
    prim("cone", "Trunk", "Bark", loc=(0, 0, 0.3), scale=(0.075, 0.075, 0.3), parent=root, vertices=10, radius1=1.0, radius2=0.6, depth=2.0, outline=0.01)
    for k in range(4):   # roots
        a = k / 4 * math.tau + rng.uniform(-0.3, 0.3)
        prim("cone", f"Root{k}", "Bark", loc=(math.cos(a) * 0.07, math.sin(a) * 0.07, 0.02), scale=(0.03, 0.03, 0.05),
             rot=(0, math.pi / 2 - 0.2, a), parent=root, vertices=6, outline=0.004)
    cz, R = 0.82 + rng.uniform(-0.05, 0.05), 0.3 + rng.uniform(-0.03, 0.04)
    blobs = [((0, 0, cz), R, 0)]
    for k in range(6):
        a = k / 6 * math.tau + rng.uniform(-0.3, 0.3)
        up = rng.uniform(-0.3, 0.5)
        blobs.append(((math.cos(a) * R * 0.62, math.sin(a) * R * 0.62, cz + up * R * 0.5), R * rng.uniform(0.5, 0.66), 1 if up < 0.25 else 2))
    blobs.append(((-R * 0.15, -R * 0.1, cz + R * 0.6), R * 0.5, 2))
    for i, (c, r, tone) in enumerate(blobs):
        ob = prim("ico", f"Leaves{i}", mats[tone], loc=c, scale=(r, r, r * 0.88), parent=root, subdivisions=2, radius=1.0, outline=0.012)
        dm = ob.modifiers.new("Bumps", "DISPLACE")
        tex = bpy.data.textures.get("LeafBumps") or bpy.data.textures.new("LeafBumps", "VORONOI")
        tex.noise_scale = 0.4
        dm.texture = tex
        dm.strength = 0.12
        ob.modifiers.move(len(ob.modifiers) - 1, 0)
    return root


def build_rock(name, seed):
    root = empty(name)
    rng = np.random.default_rng(seed)
    for k in range(rng.integers(2, 4)):
        r = rng.uniform(0.07, 0.12) * (1.25 if k == 0 else 1)
        ob = prim("ico", f"Chunk{k}", "Stone" if k % 2 == 0 else "StoneDark", loc=(rng.uniform(-0.08, 0.08), rng.uniform(-0.04, 0.04), r * 0.35),
                  scale=(r, r * rng.uniform(0.7, 0.95), r * rng.uniform(0.6, 0.85)), rot=(0, 0, rng.uniform(0, 3)), parent=root,
                  subdivisions=1, radius=1.0, outline=0.008)
    prim("ico", "Moss", "Moss", loc=(-0.06, 0.02, 0.07), scale=(0.06, 0.05, 0.02), parent=root, subdivisions=1, radius=1.0, outline=0)
    for k in range(3):   # grass tufts at the foot
        prim("cone", f"Tuft{k}", "Grass", loc=(rng.uniform(-0.13, 0.13), -0.07, 0.03), scale=(0.012, 0.012, 0.05), rot=(rng.uniform(-0.3, 0.3), 0, 0),
             parent=root, vertices=4, outline=0)
    return root


# ---------------------------------------------------------------- camera, light, render
def setup_render(fw, fh, scale, pivot):
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.film_transparent = True
    try:
        sc.render.image_settings.media_type = "IMAGE"
    except Exception:
        pass
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"
    sc.render.resolution_x = round(fw * scale)
    sc.render.resolution_y = round(fh * scale)
    sc.render.resolution_percentage = 100
    sc.render.filter_size = 1.2
    try:
        sc.eevee.taa_render_samples = 32
    except Exception:
        pass
    cam = bpy.data.objects.get("BroccoliCam")
    if cam is None:
        cd = bpy.data.cameras.new("BroccoliCam")
        cd.type = "ORTHO"
        cd.clip_end = 200
        cam = bpy.data.objects.new("BroccoliCam", cd)
        link(cam)
    cam.data.ortho_scale = max(fw, fh) / UNITS
    cam.rotation_euler = (TILT, 0, 0)
    right, up = Vector((1, 0, 0)), Vector((0, math.cos(TILT), math.sin(TILT)))
    fwd = up.cross(right)
    dx, dy = (pivot[0] - fw / 2) / UNITS, (pivot[1] - fh / 2) / UNITS
    cam.location = -right * dx + up * dy - fwd * 30.0
    sc.camera = cam
    if bpy.data.objects.get("BroccoliSun") is None:
        ld = bpy.data.lights.new("BroccoliSun", "SUN")
        ld.energy = 3.0
        ld.angle = math.radians(3)
        sun = bpy.data.objects.new("BroccoliSun", ld)
        link(sun)
        d = Vector((1, -0.9, -1.3)).normalized()
        sun.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    if sc.world is None:
        sc.world = bpy.data.worlds.new("BroccoliWorld")
    if sc.world.node_tree is None:
        sc.world.use_nodes = True
    bg = next((n for n in sc.world.node_tree.nodes if n.type == "BACKGROUND"), None)
    if bg:
        bg.inputs[0].default_value = (1, 1, 1, 1)
        bg.inputs[1].default_value = 0.55


def only(root):
    keep = {root, *root.children_recursive}
    for ob in bpy.context.scene.objects:
        if ob.type in ("MESH",):
            ob.hide_render = ob not in keep


def render(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def masked(fn):
    """Render with team materials flat white and everything else flat black (alpha kept)."""
    white, black = glow("MaskWhite", "#ffffff", 1.0), glow("MaskBlack", "#000000", 1.0)
    saved = []
    for ob in bpy.context.scene.objects:
        if ob.type != "MESH":
            continue
        for s in ob.material_slots:
            saved.append((s, s.material))
            if s.material is MATS["OUTLINE"]:
                continue
            s.material = white if s.material and s.material.name.startswith("TEAM") else black
    try:
        fn()
    finally:
        for s, m in saved:
            s.material = m


def stitch(paths, out):
    imgs = [bpy.data.images.load(p) for p in paths]
    w, h = imgs[0].size
    strip = np.zeros((h, w * len(imgs), 4), dtype=np.float32)
    for i, im in enumerate(imgs):
        px = np.array(im.pixels[:], dtype=np.float32).reshape(h, w, 4)
        strip[:, i * w:(i + 1) * w] = px
    for im in imgs:
        bpy.data.images.remove(im)
    img = bpy.data.images.new("strip", width=w * len(paths), height=h, alpha=True)
    img.pixels[:] = strip.ravel()
    img.filepath_raw = out
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)
    for p in paths:
        os.remove(p)


SOLDIER_PLAN = [("run", 0.0, k / 4) for k in range(4)] + [("run", -math.pi / 2, k / 4) for k in range(4)] + \
               [("run", math.pi / 2, k / 4) for k in range(4)] + [("windup", 0, 0), ("thrust", 0, 0), ("hit", 0, 0)]


def render_soldier(s, frames=None, mask=True):
    setup_render(34, 42, 4, (17, 39))
    only(s["root"])
    plan = SOLDIER_PLAN if frames is None else [SOLDIER_PLAN[i] for i in frames]

    def run(tag):
        paths = []
        for i, (kind, yaw, t) in enumerate(plan):
            s["root"].rotation_euler = (0, 0, yaw)
            pose_soldier(s, kind, t)
            p = os.path.join(PACK, f"_tmp_{tag}_{i:02d}.png")
            render(p)
            paths.append(p)
        return paths

    stitch(run("c"), os.path.join(PACK, "soldier.png"))
    if mask:
        masked(lambda: stitch(run("m"), os.path.join(PACK, "soldier_team.png")))
    # knocked-out pose for soldier_fall
    setup_render(46, 30, 4, (23, 24))
    s["root"].rotation_euler = (0, 0, 0)
    pose_soldier(s, "fall", 0)
    render(os.path.join(PACK, "soldier_fall.png"))
    if mask:
        masked(lambda: render(os.path.join(PACK, "soldier_fall_team.png")))
    pose_soldier(s, "idle", 0)


def render_building(root, slot, mask=True):
    setup_render(250, 280, 3, (125, 222))
    only(root)
    render(os.path.join(PACK, slot + ".png"))
    if mask:
        masked(lambda: render(os.path.join(PACK, slot + "_team.png")))


def main():
    t0 = time.time()
    log(f"BROCCOLI art, Blender {bpy.app.version_string}, mode {MODE}")
    reset()
    palette()
    s = build_soldier()
    log("soldier built")
    farms = [build_farm(l) for l in range(1, 5)]
    for i, f in enumerate(farms):
        f.location.x = 10 + i * 4
    towers = []
    for l in range(1, 5):
        tr, top = build_tower(l)
        tr.location.x = -10 - l * 4
        towers.append((tr, top))
    forge = build_forge()
    forge.location.y = 10
    heads = [build_head(False), build_head(True)]
    for i, h in enumerate(heads):
        h.location = (0, 20 + i * 3, 0)
    deck, base = build_bridge_deck(), build_bridge_base()
    deck.location, base.location = (0, -10, 0), (0, -14, 0)
    trees = [(build_tree(f"Tree{i}", 90 + i), f"tree_{i + 1}") for i in range(3)] + \
            [(build_tree(f"TreeF{i}", 95 + i, dark=True), f"tree_dark_{i + 1}") for i in range(3)]
    rocks = [(build_rock(f"Rock{i}", 110 + i), f"rock_{i + 1}") for i in range(3)]
    for i, (ob, _) in enumerate(trees + rocks):
        ob.location = (30 + i * 3, 0, 0)
    log("buildings and scenery built")

    def scenery():
        for ob, slot, fw, fh, sc, pv in ([(deck, "bridge_deck", 200, 110, 3, (100, 60)), (base, "bridge_base", 260, 130, 3, (130, 65))]
                                         + [(t, sl, 120, 140, 4, (60, 125)) for t, sl in trees]
                                         + [(r, sl, 60, 50, 3, (30, 38)) for r, sl in rocks]):
            def go(ob=ob, slot=slot, fw=fw, fh=fh, sc=sc, pv=pv):
                setup_render(fw, fh, sc, pv)
                only(ob)
                render(os.path.join(PACK, slot + ".png"))
            at_origin(ob, go)

    def at_origin(ob, fn):
        saved = ob.location.copy()
        ob.location = (0, 0, 0)
        bpy.context.view_layer.update()
        try:
            fn()
        finally:
            ob.location = saved

    if MODE == "test":
        render_soldier(s, frames=[0, 1, 4, 8, 12, 13, 14], mask=False)
        for f, slot in ((farms[0], "farm_1"), (towers[1][0], "tower_2"), (forge, "forge_1")):
            at_origin(f, lambda f=f, slot=slot: render_building(f, slot, mask=False))
        scenery()
    else:
        render_soldier(s)
        for l, f in enumerate(farms, 1):
            at_origin(f, lambda f=f, l=l: render_building(f, f"farm_{l}"))
        for l, (tr, _) in enumerate(towers, 1):
            at_origin(tr, lambda tr=tr, l=l: render_building(tr, f"tower_{l}"))
        at_origin(forge, lambda: render_building(forge, "forge_1"))
        for h, slot in zip(heads, ("tower_head", "tower_head_drawn")):
            def go(h=h, slot=slot):
                setup_render(48, 48, 3, (24, 24))
                only(h)
                render(os.path.join(PACK, slot + ".png"))
                masked(lambda: render(os.path.join(PACK, slot + "_team.png")))
            at_origin(h, go)
        scenery()
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "broccoli_art.blend"))
    files = sorted(f for f in os.listdir(PACK) if f.endswith(".png"))
    log(json.dumps({"ok": True, "seconds": round(time.time() - t0, 1), "files": files}))


try:
    main()
except Exception:
    log("ERROR\n" + traceback.format_exc())
