"""
Bushwhack asset builder: models every character, prop and the arena in Blender, then renders
them into the sprite atlases the game draws.

Run from the project root (Blender 4.2+, EEVEE):
    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
        -P tools/blender/build_assets.py -- public/assets [chars,props,ground,hero]

Coordinate conventions
- 1 Blender unit (BU) = 1 map tile = 64 game pixels.
- Game x -> Blender +X. Game y (down the screen) -> Blender -Y.
- The camera is orthographic, tilted ELEV degrees above the horizon and looking north (+Y).
  Ground-anchored scenery is stretched by 1/sin(ELEV) along Y so its footprint lands exactly on the
  game's square tile grid, while anything with height (walls, people) still shows its front face.
"""
import bpy
import bmesh
import json
import math
import os
import random
import sys

import numpy as np
from mathutils import Vector

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(ARGS[0] if ARGS else 'public/assets')
ONLY = set(ARGS[1].split(',')) if len(ARGS) > 1 else {'chars', 'props', 'ground', 'hero'}
TMP = os.path.join(OUT, '_tmp')
os.makedirs(TMP, exist_ok=True)

ELEV = math.radians(50)
SIN, COS = math.sin(ELEV), math.cos(ELEV)
SPRITE_PPB = 128  # sprite pixels per BU (= 2 px per game pixel, crisp on retina)
CHAR_ELEV = math.radians(35)  # characters get a lower camera so faces read, like Brawl Stars
CHAR_SCALE = 1.25
DIRS = 16
FRAMES = 4
SUN_DIR = Vector((0.55, -0.4, -1.0)).normalized()  # light travels right, down-screen and down

# ---------------------------------------------------------------- scene & materials


def hex_lin(h):
    h = h.lstrip('#')
    return tuple(((int(h[i:i + 2], 16) / 255) ** 2.2) for i in (0, 2, 4))


def reset_scene(transparent=True, samples=48):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.eevee.taa_render_samples = samples
    try:
        sc.eevee.use_shadows = True
        sc.eevee.use_fast_gi = True
    except AttributeError:
        pass
    try:
        sc.view_settings.view_transform = 'Standard'
    except TypeError:
        pass
    sc.render.film_transparent = transparent
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGBA'
    world = bpy.data.worlds.new('World')
    sc.world = world
    bg = world.node_tree.nodes.get('Background') or world.node_tree.nodes.new('ShaderNodeBackground')
    bg.inputs[0].default_value = (*hex_lin('#cfe6ff'), 1)
    bg.inputs[1].default_value = 0.85
    if not bg.outputs[0].links:
        out = world.node_tree.nodes.get('World Output') or world.node_tree.nodes.new('ShaderNodeOutputWorld')
        world.node_tree.links.new(bg.outputs[0], out.inputs[0])
    sun_data = bpy.data.lights.new('Sun', 'SUN')
    sun_data.energy = 3.4
    sun_data.angle = math.radians(8)
    sun = bpy.data.objects.new('Sun', sun_data)
    sc.collection.objects.link(sun)
    sun.rotation_euler = (-SUN_DIR).to_track_quat('Z', 'Y').to_euler()
    MATS.clear()
    return sc


MATS = {}
OUTLINE = False  # the reference style has no ink outlines
SEG = 32  # sphere segments; the glTF exporter lowers this for lighter real-time meshes


def mat(name, color, rough=0.6, emit=0.0, metal=0.0, spec=0.25):
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(name)
    p = m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = (*hex_lin(color), 1)
    p.inputs['Roughness'].default_value = rough
    p.inputs['Metallic'].default_value = metal
    p.inputs['Specular IOR Level'].default_value = spec
    if emit:
        p.inputs['Emission Color'].default_value = (*hex_lin(color), 1)
        p.inputs['Emission Strength'].default_value = emit
    MATS[name] = m
    return m


def outline_mat():
    if 'Outline' in MATS:
        return MATS['Outline']
    m = bpy.data.materials.new('Outline')
    p = m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = (*hex_lin('#1b1430'), 1)
    p.inputs['Roughness'].default_value = 1.0
    p.inputs['Specular IOR Level'].default_value = 0.0
    m.use_backface_culling = True
    MATS['Outline'] = m
    return m


NOISE_SPECS = {}  # name -> colours/pattern, so the glTF exporter can bake an equivalent image texture


def noise_mat(name, c1, c2, scale=6.0, rough=0.7, detail=4.0, brick=None, kind=None):
    """Mottled two-colour material (stone, leaves, wood, straw, cloth); optional brick pattern."""
    NOISE_SPECS[name] = dict(c1=c1, c2=c2, scale=scale, rough=rough, brick=brick, kind=kind)
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(name)
    nt = m.node_tree
    p = nt.nodes['Principled BSDF']
    p.inputs['Roughness'].default_value = rough
    p.inputs['Specular IOR Level'].default_value = 0.2
    tc = nt.nodes.new('ShaderNodeTexCoord')
    nz = nt.nodes.new('ShaderNodeTexNoise')
    nz.inputs['Scale'].default_value = scale
    nz.inputs['Detail'].default_value = detail
    nt.links.new(tc.outputs['Object'], nz.inputs['Vector'])
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.35
    ramp.color_ramp.elements[0].color = (*hex_lin(c1), 1)
    ramp.color_ramp.elements[1].position = 0.7
    ramp.color_ramp.elements[1].color = (*hex_lin(c2), 1)
    nt.links.new(nz.outputs['Fac'], ramp.inputs['Fac'])
    col = ramp.outputs['Color']
    if brick:
        br = nt.nodes.new('ShaderNodeTexBrick')
        br.inputs['Scale'].default_value = brick
        br.inputs['Mortar Size'].default_value = 0.025
        br.inputs['Color1'].default_value = (1, 1, 1, 1)
        br.inputs['Color2'].default_value = (0.82, 0.82, 0.82, 1)
        br.inputs['Mortar'].default_value = (0.35, 0.33, 0.3, 1)
        rot = nt.nodes.new('ShaderNodeMapping')
        rot.inputs['Rotation'].default_value = (math.pi / 2, 0, 0)  # courses run horizontally on side faces
        nt.links.new(tc.outputs['Object'], rot.inputs['Vector'])
        nt.links.new(rot.outputs['Vector'], br.inputs['Vector'])
        mul = nt.nodes.new('ShaderNodeMix')
        mul.data_type = 'RGBA'
        mul.blend_type = 'MULTIPLY'
        mul.inputs['Factor'].default_value = 1.0
        nt.links.new(col, mul.inputs[6])
        nt.links.new(br.outputs['Color'], mul.inputs[7])
        col = mul.outputs[2]
    nt.links.new(col, p.inputs['Base Color'])
    MATS[name] = m
    return m


# ---------------------------------------------------------------- geometry helpers


def _finish(o, m, outline, smooth, bevel=0.0):
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.select_set(False)
    if smooth:
        for poly in o.data.polygons:
            poly.use_smooth = True
    if bevel:
        b = o.modifiers.new('Bevel', 'BEVEL')
        b.width = bevel
        b.segments = 3
        b.limit_method = 'ANGLE'
        if smooth:
            o.modifiers.new('Smooth', 'WEIGHTED_NORMAL')
    o.data.materials.append(m)
    if outline and OUTLINE:
        o.data.materials.append(outline_mat())
        s = o.modifiers.new('Outline', 'SOLIDIFY')
        s.thickness = outline
        s.offset = 1.0
        s.use_flip_normals = True
        s.use_rim = False
        s.material_offset = 1
    return o


def prim(kind, name, loc, scale, m, parent=None, rot=(0, 0, 0), outline=0.012, smooth=True, bevel=0.0, **kw):
    if kind == 'sphere':
        bpy.ops.mesh.primitive_uv_sphere_add(segments=min(kw.get('seg', SEG), SEG), ring_count=min(kw.get('rings', SEG // 2), SEG // 2), radius=1)
    elif kind == 'ico':
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=kw.get('sub', 2), radius=1)
    elif kind == 'cyl':
        bpy.ops.mesh.primitive_cylinder_add(vertices=min(kw.get('seg', 24), max(8, SEG * 3 // 4)), radius=1, depth=1)
    elif kind == 'cube':
        bpy.ops.mesh.primitive_cube_add(size=1)
    elif kind == 'cone':
        bpy.ops.mesh.primitive_cone_add(vertices=kw.get('seg', 24), radius1=1, radius2=kw.get('r2', 0), depth=1)
    elif kind == 'torus':
        bpy.ops.mesh.primitive_torus_add(major_radius=1, minor_radius=kw.get('minor', 0.25), major_segments=32, minor_segments=12)
    o = bpy.context.active_object
    o.name = name
    o.location = loc
    o.rotation_euler = rot
    o.scale = scale
    _finish(o, m, outline, smooth, bevel)
    if parent:
        keep_parent(o, parent)
    return o


def dome(name, loc, scale, m, parent=None, cut=0.0, outline=0.012):
    """Upper part of a sphere (caps, hats, hair): verts below `cut` (in -1..1 sphere space) are removed."""
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=1)
    o = bpy.context.active_object
    o.name = name
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < cut - 1e-4], context='VERTS')
    bm.to_mesh(o.data)
    bm.free()
    o.location = loc
    o.scale = scale
    _finish(o, m, outline, True)
    if outline and OUTLINE:
        o.modifiers['Outline'].use_rim = False
    if parent:
        keep_parent(o, parent)
    return o


def limb(name, a, b, radius, m, parent=None, outline=0.012):
    """A capsule-ish cylinder from point a to point b."""
    a, b = Vector(a), Vector(b)
    d = b - a
    o = prim('cyl', name, (a + b) / 2, (radius, radius, d.length), m, outline=outline)
    o.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
    if parent:
        keep_parent(o, parent)
    return o


def empty(name, loc=(0, 0, 0), parent=None):
    e = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(e)
    e.location = loc
    if parent:
        keep_parent(e, parent)
    return e


def keep_parent(child, parent):
    bpy.context.view_layer.update()
    child.parent = parent
    child.matrix_parent_inverse = parent.matrix_world.inverted()


# ---------------------------------------------------------------- characters


def shade(h, f):
    """Lighten (f > 1) or darken (f < 1) a hex colour."""
    h = h.lstrip('#')
    return '#' + ''.join(f'{min(255, int(int(h[i:i + 2], 16) * f)):02x}' for i in (0, 2, 4))


def shaggy(name, z_top, z_bot, r_top, r_bot, m, parent, loc=(0, 0), jag=0.05, teeth=14):
    """A straw cape / skirt: a widening shell whose hem zig-zags like bundled straw."""
    bpy.ops.mesh.primitive_cone_add(vertices=teeth * 2, radius1=r_bot, radius2=r_top, depth=z_top - z_bot,
                                    location=(loc[0], loc[1], (z_top + z_bot) / 2), end_fill_type='NOTHING')
    o = bpy.context.active_object
    o.name = name
    bm = bmesh.new()
    bm.from_mesh(o.data)
    for v in bm.verts:
        if v.co.z < 0:
            a = math.atan2(v.co.y, v.co.x)
            v.co.z -= jag * (0.5 + 0.5 * math.cos(a * teeth))
    bm.to_mesh(o.data)
    bm.free()
    _finish(o, m, 0, True)
    o.data.materials[0].use_backface_culling = False
    keep_parent(o, parent)
    return o


def build_body(c):
    """Shared wanderer: straw kasa hat, dark mask with glowing eyes, scarf, rope-belted tunic. Faces -Y."""
    root = empty(f"{c['id']}_root")
    upper = empty('upper', parent=root)
    hip = 0.32
    rig = {'root': root, 'upper': upper}
    lr = c.get('leg_r', 0.068)
    trousers = noise_mat(c['id'] + 'trousers', c['pants'], shade(c['pants'], 1.18), 30, kind='cloth')
    wrap = noise_mat('legwrap', '#c9bb9a', '#e4d9bf', 30, kind='cloth')
    boot = mat('boot', '#3b2b21', rough=0.85)
    for side, sx in (('L', 1), ('R', -1)):
        piv = empty(f'leg{side}', (0.09 * sx, 0, hip), parent=root)
        limb(f'leg{side}m', (0.09 * sx, 0, hip), (0.09 * sx, 0, 0.07), lr, trousers, piv)
        prim('cyl', 'wrap', (0.09 * sx, 0, 0.14), (lr * 1.12, lr * 1.12, 0.1), wrap, piv)
        prim('sphere', 'boot', (0.09 * sx, -0.03, 0.05), (0.085, 0.12, 0.06), boot, piv)
        rig['leg' + side] = piv
    tw = c['tunic_r']
    tunic = noise_mat(c['id'] + 'tunic', c['tunic'], shade(c['tunic'], 1.15), 30, kind='cloth')
    prim('cone', 'skirt', (0, 0, 0.37), (tw * 1.15, tw * 0.98, 0.34), tunic, upper, r2=0.72, seg=24)
    prim('sphere', 'chest', (0, 0, 0.6), (tw, tw * 0.8, 0.18), tunic, upper)
    rope = noise_mat('rope', '#d8caa6', '#efe4c8', 40, kind='cloth')
    prim('torus', 'belt', (0, 0, 0.5), (tw * 1.0, tw * 0.82, 0.5), rope, upper, minor=0.1)
    prim('sphere', 'knot', (0.05, -tw * 0.82, 0.49), (0.035, 0.03, 0.035), rope, upper)
    limb('tassel1', (0.05, -tw * 0.84, 0.48), (0.065, -tw * 0.86, 0.35), 0.014, rope, upper)
    limb('tassel2', (0.04, -tw * 0.84, 0.48), (0.025, -tw * 0.87, 0.37), 0.014, rope, upper)
    hr = c['head_r']
    hz = 0.6 + 0.18 + hr * 0.7
    mask = mat('mask', '#2a2420', rough=0.9)
    prim('sphere', 'head', (0, 0, hz), (hr, hr * 0.95, hr * 1.02), mask, upper)
    glow = mat('eyeglow', '#ffd56a', emit=4.0, rough=0.4)
    for sx in (1, -1):
        prim('sphere', 'eye', (0.068 * sx, -hr * 0.92, hz + 0.02), (0.032, 0.016, 0.024), glow, upper, seg=12, rings=6)
    scarf = noise_mat(c['id'] + 'scarf', c['scarf'], shade(c['scarf'], 1.15), 30, kind='cloth')
    prim('torus', 'scarf', (0, 0, hz - hr * 0.78), (hr * 0.95, hr * 0.9, 0.16), scarf, upper, minor=0.3)
    prim('cube', 'scarftail', (0.07, -tw * 0.78, 0.62 - c.get('tail', 0.0) / 2), (0.075, 0.03, 0.2 + c.get('tail', 0.0)), scarf, upper,
         rot=(0.12, 0, 0.12), bevel=0.012)
    straw = noise_mat('straw', '#c49c5e', '#e2c48a', 20, kind='straw')
    hb = hz + hr * 0.5
    rig.update(hz=hz, hr=hr, tw=tw, glove=mask, tunic=tunic, straw=straw)
    if not c.get('hat', True):
        return rig
    prim('cone', 'hat', (0, 0, hb + c['hat_h'] / 2), (c['hat_r'], c['hat_r'], c['hat_h']), straw, upper, seg=32)
    prim('cyl', 'hatrim', (0, 0, hb), (c['hat_r'] * 1.01, c['hat_r'] * 1.01, 0.022), straw, upper, seg=32)
    prim('torus', 'hatband', (0, 0, hb + c['hat_h'] * 0.52), (c['hat_r'] * 0.5, c['hat_r'] * 0.5, 0.3),
         mat(c['id'] + 'band', c['band'], rough=0.6), upper, minor=0.1)
    prim('sphere', 'hattop', (0, 0, hb + c['hat_h'] * 0.98), (0.03, 0.03, 0.03), mat(c['id'] + 'band', c['band']), upper, seg=10, rings=6)
    rig.update(hz=hz, hr=hr, tw=tw, glove=mask, tunic=tunic, straw=straw)
    return rig


def arm(rig, name, shoulder, hand, c, radius=0.058, parent=None):
    limb(name, shoulder, hand, radius, rig['tunic'], parent or rig['upper'])
    prim('sphere', name + 'hand', hand, (0.058, 0.058, 0.058), rig['glove'], parent or rig['upper'])


def build_brick():
    c = dict(id='brick', tunic='#b4553a', pants='#3d4a63', scarf='#2f8f86', band='#2f8f86',
             tunic_r=0.28, head_r=0.2, hat_r=0.47, hat_h=0.2, leg_r=0.08)
    r = build_body(c)
    up, tw = r['upper'], r['tw']
    # Bundled straw cape over the shoulders makes him the big one.
    shaggy('cape', 0.82, 0.5, 0.17, 0.37, r['straw'], up, loc=(0, 0.03), jag=0.07, teeth=16)
    gz = 0.46
    wood = noise_mat('gunwood', '#6e4a2c', '#8f6a45', 10, kind='wood')
    brass = mat('brass', '#b8913a', rough=0.35, metal=0.7, spec=0.6)
    prim('cube', 'stock', (0, -0.06, gz - 0.02), (0.1, 0.3, 0.08), wood, up, bevel=0.02)
    limb('barrel', (0, -0.2, gz + 0.01), (0, -0.56, gz + 0.03), 0.038, brass, up)
    prim('cone', 'muzzle', (0, -0.6, gz + 0.03), (0.075, 0.075, 0.1), brass, up, rot=(math.pi / 2, 0, 0), r2=0.45, seg=16)
    arm(r, 'armL', (tw + 0.02, 0, 0.66), (0.07, -0.4, gz + 0.03), c, 0.07)
    arm(r, 'armR', (-tw - 0.02, 0, 0.66), (-0.06, -0.16, gz), c, 0.07)
    return r


def build_vex():
    c = dict(id='vex', tunic='#3f7f8c', pants='#4a3f36', scarf='#e6dcc4', band='#c8643b',
             tunic_r=0.21, head_r=0.19, hat_r=0.37, hat_h=0.3, leg_r=0.064, tail=0.12)
    r = build_body(c)
    up, tw = r['upper'], r['tw']
    gz = 0.66
    bamboo = noise_mat('bamboo', '#b99d5a', '#d9c07e', 12, kind='wood')
    joint = mat('bamboojoint', '#8a7240', rough=0.6)
    brass = mat('brass', '#b8913a', rough=0.35, metal=0.7, spec=0.6)
    limb('rifle', (-0.05, 0.08, gz), (-0.05, -0.86, gz + 0.02), 0.03, bamboo, up)
    for k in range(5):
        y = 0.02 - k * 0.19
        prim('cyl', 'joint', (-0.05, y, gz + 0.005 - k * 0.004), (0.036, 0.036, 0.022), joint, up, rot=(math.pi / 2, 0, 0), seg=12)
    prim('cyl', 'tip', (-0.05, -0.86, gz + 0.02), (0.036, 0.036, 0.06), brass, up, rot=(math.pi / 2, 0, 0), seg=12)
    arm(r, 'armR', (-tw - 0.02, 0, 0.66), (-0.06, -0.1, gz - 0.02), c)
    arm(r, 'armL', (tw + 0.02, 0, 0.66), (-0.03, -0.44, gz), c)
    return r


def build_boom():
    c = dict(id='boom', tunic='#7a4f7a', pants='#3a3346', scarf='#d9a441', band='#7ec8b8',
             tunic_r=0.23, head_r=0.2, hat_r=0.36, hat_h=0.17, leg_r=0.066)
    r = build_body(c)
    up, tw = r['upper'], r['tw']
    # Wicker basket of clay bombs on the back.
    prim('cyl', 'basket', (0, 0.22, 0.62), (0.13, 0.13, 0.24), r['straw'], up, rot=(-0.25, 0, 0), seg=16)
    clay = mat('clay', '#b5653a', rough=0.75)
    for k, (x, z) in enumerate(((-0.04, 0.78), (0.05, 0.77))):
        prim('sphere', f'pot{k}', (x, 0.25, z), (0.06, 0.06, 0.06), clay, up, seg=12, rings=8)
    hand = (-tw - 0.05, -0.05, 1.0)
    arm(r, 'armR', (-tw - 0.02, 0, 0.66), hand, c)
    prim('sphere', 'bomb', (hand[0], hand[1], hand[2] + 0.1), (0.1, 0.1, 0.095), clay, up)
    prim('cyl', 'neck', (hand[0], hand[1], hand[2] + 0.2), (0.04, 0.04, 0.04), clay, up, seg=12)
    prim('cyl', 'cork', (hand[0], hand[1], hand[2] + 0.235), (0.03, 0.03, 0.03), mat('cork', '#c9a77a'), up, seg=10)
    limb('fuse', (hand[0], hand[1], hand[2] + 0.25), (hand[0] + 0.04, hand[1], hand[2] + 0.32), 0.01, mat('fuse', '#d9b98a'), up)
    prim('ico', 'spark', (hand[0] + 0.045, hand[1], hand[2] + 0.34), (0.035, 0.035, 0.035), mat('spark', '#ffb02e', emit=6), up)
    piv = empty('armLpiv', (tw + 0.02, 0, 0.66), parent=up)
    arm(r, 'armL', (tw + 0.02, 0, 0.66), (tw + 0.07, 0, 0.4), c, parent=piv)
    r['swingArm'] = piv
    return r


def crescent(name, loc, radius, thick, m, parent, rot=(0, 0, 0)):
    """A curved blade: an outer arc and an offset inner arc, extruded thin (in the XZ plane, edge facing +X)."""
    bm = bmesh.new()
    pts = []
    n = 10
    for i in range(n + 1):
        a = -1.25 + 2.5 * i / n
        pts.append((math.cos(a) * radius, math.sin(a) * radius))
    for i in range(n + 1):
        a = 1.05 - 2.1 * i / n
        pts.append((radius * 0.22 + math.cos(a) * radius * 0.78, math.sin(a) * radius * 0.78))
    face = bm.faces.new([bm.verts.new((x, 0, z)) for x, z in pts])
    ext = bmesh.ops.extrude_face_region(bm, geom=[face])
    for v in [g for g in ext['geom'] if isinstance(g, bmesh.types.BMVert)]:
        v.co.y += thick
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0, -thick / 2, 0))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    o.location = loc
    o.rotation_euler = rot
    _finish(o, m, 0.006, False)
    keep_parent(o, parent)
    return o


def build_melo():
    """Support: a wandering lute player with a flower-trimmed hat. Heals with music."""
    c = dict(id='melo', tunic='#6f9a5a', pants='#5a4636', scarf='#e08aa0', band='#e08aa0',
             tunic_r=0.23, head_r=0.2, hat_r=0.44, hat_h=0.13, leg_r=0.064, tail=0.06)
    r = build_body(c)
    up, tw, hz, hr = r['upper'], r['tw'], r['hz'], r['hr']
    # Flowers tucked around the hat brim.
    hb = hz + hr * 0.5
    petals = (mat('petalpink', '#f2a3b8', rough=0.5), mat('petalwhite', '#f6efe0', rough=0.5), mat('petalgold', '#f2c85b', rough=0.5))
    for k in range(7):
        a = -math.pi / 2 + (k - 3) * 0.42
        rr = c['hat_r'] * 0.86
        prim('sphere', f'flower{k}', (math.cos(a) * rr, math.sin(a) * rr, hb + 0.03), (0.045, 0.045, 0.03), petals[k % 3], up, seg=10, rings=6)
    # Biwa lute held across the chest: pear body, sound hole, long neck, pegbox and strings.
    wood = noise_mat('lutewood', '#9a6a3c', '#c08d57', 10, kind='wood')
    dark = mat('lutedark', '#4a3020', rough=0.7)
    body_c = (0.04, -0.27, 0.55)
    prim('sphere', 'lutebody', body_c, (0.16, 0.05, 0.2), wood, up, rot=(0, -0.55, 0))
    prim('cyl', 'lutehole', (0.06, -0.325, 0.57), (0.035, 0.035, 0.01), dark, up, rot=(math.pi / 2, 0, 0), seg=12)
    neck_a, neck_b = (-0.06, -0.3, 0.7), (-0.3, -0.3, 1.02)
    limb('luteneck', neck_a, neck_b, 0.025, wood, up)
    prim('cube', 'pegbox', (-0.33, -0.3, 1.07), (0.06, 0.04, 0.1), dark, up, rot=(0, -0.55, 0), bevel=0.01)
    for k in range(4):
        prim('cyl', f'peg{k}', (-0.33 + (k % 2) * 0.05 - 0.025, -0.3, 1.04 + (k // 2) * 0.05), (0.008, 0.008, 0.06), dark, up, rot=(math.pi / 2, 0, 0), seg=8)
    silk = mat('lutestring', '#f3ead2', rough=0.4)
    for k in range(3):
        o = (k - 1) * 0.012
        limb(f'string{k}', (0.12 + o, -0.33, 0.45), (-0.3 + o, -0.33, 1.0), 0.003, silk, up, outline=0)
    arm(r, 'armL', (tw + 0.02, 0, 0.66), (0.11, -0.36, 0.52), c)
    arm(r, 'armR', (-tw - 0.02, 0, 0.66), (-0.22, -0.34, 0.9), c)
    return r


def build_kit():
    """Assassin: a lean shadow in a pointed ninja hood with a long red scarf and twin kama."""
    c = dict(id='kit', tunic='#3a3550', pants='#26222f', scarf='#c8433a', band='#c8433a',
             tunic_r=0.2, head_r=0.19, hat=False, leg_r=0.06, tail=0.24)
    r = build_body(c)
    up, tw, hz, hr = r['upper'], r['tw'], r['hz'], r['hr']
    hood = noise_mat('kithood', '#2b2638', '#3d3650', 30, kind='cloth')
    # Hood sits a little back so the glowing eyes peek out; a drooping point trails behind.
    dome('hood', (0, 0.07, hz + 0.01), (hr * 1.2, hr * 1.2, hr * 1.32), hood, up, cut=-0.25)
    limb('hoodtip', (0, 0.16, hz + hr * 0.95), (0, 0.36, hz + hr * 0.55), 0.06, hood, up)
    prim('sphere', 'hoodtipend', (0, 0.37, hz + hr * 0.52), (0.04, 0.04, 0.04), hood, up)
    prim('torus', 'hoodtrim', (0, 0.0, hz - hr * 0.25), (hr * 1.15, hr * 1.1, 0.3), mat('kittrim', '#c8433a', rough=0.6), up, minor=0.12)
    handle = noise_mat('kamahandle', '#5a3a22', '#7a5434', 10, kind='wood')
    steel = mat('kamasteel', '#d6dde2', rough=0.22, metal=0.85, spec=0.8)
    for side, sx in (('L', 1), ('R', -1)):
        hand = (sx * (tw + 0.1), -0.12, 0.46)
        arm(r, 'arm' + side, (sx * (tw + 0.02), 0, 0.66), hand, c)
        top = (hand[0] + sx * 0.02, hand[1] - 0.16, hand[2] + 0.16)
        limb('kama' + side, (hand[0], hand[1] + 0.04, hand[2] - 0.05), top, 0.018, handle, up)
        # Crescent blade hooking forward from the top of the handle.
        crescent('blade' + side, (top[0], top[1] - 0.12, top[2] + 0.03), 0.16, 0.022, steel, up, rot=(0.0, 0.0, -math.pi / 2 + sx * 0.25))
    return r


def build_tink():
    """Builder: a tinkerer with brass goggles, a gear backpack, a big wrench and a spark orb."""
    c = dict(id='tink', tunic='#d08a3a', pants='#3d4a63', scarf='#4a8fb8', band='#4a8fb8',
             tunic_r=0.22, head_r=0.2, hat_r=0.38, hat_h=0.16, leg_r=0.064)
    r = build_body(c)
    up, tw, hz, hr = r['upper'], r['tw'], r['hz'], r['hr']
    brass = mat('brass', '#b8913a', rough=0.35, metal=0.7, spec=0.6)
    glass = mat('goggleglass', '#9fe3ff', rough=0.1, emit=0.8)
    # Goggles pushed up onto the front slope of the hat, where the top-down camera sees them.
    hb = hz + hr * 0.5
    tilt = 0.75
    for sx in (1, -1):
        g = (0.085 * sx, -c['hat_r'] * 0.42, hb + c['hat_h'] * 0.55)
        prim('torus', 'goggle', g, (0.065, 0.065, 0.065), brass, up, rot=(tilt, 0, 0), minor=0.25)
        prim('cyl', 'lens', (g[0], g[1] - 0.004, g[2] + 0.004), (0.055, 0.055, 0.012), glass, up, rot=(tilt, 0, 0), seg=16)
    limb('goggleband', (-0.03, -c['hat_r'] * 0.42, hb + c['hat_h'] * 0.55), (0.03, -c['hat_r'] * 0.42, hb + c['hat_h'] * 0.55), 0.015, brass, up)
    # Backpack with a big brass gear.
    pack = noise_mat('packleather', '#6b4a2e', '#86603d', 12, kind='wood')
    prim('cube', 'pack', (0, 0.2, 0.62), (0.24, 0.12, 0.26), pack, up, bevel=0.02)
    prim('cyl', 'gear', (0, 0.27, 0.68), (0.1, 0.1, 0.03), brass, up, rot=(math.pi / 2, 0, 0), seg=16)
    for k in range(8):
        a = k * math.pi / 4
        prim('cube', f'tooth{k}', (math.cos(a) * 0.115, 0.27, 0.68 + math.sin(a) * 0.115), (0.03, 0.03, 0.03), brass, up, rot=(0, -a, 0), outline=0)
    prim('cyl', 'chimney', (0.08, 0.2, 0.86), (0.025, 0.025, 0.12), mat('iron', '#4a4a50', rough=0.5, metal=0.6), up, seg=10)
    # Wrench in the right hand.
    iron = mat('wrenchsteel', '#9aa3aa', rough=0.3, metal=0.8)
    hand = (-tw - 0.06, -0.1, 0.46)
    arm(r, 'armR', (-tw - 0.02, 0, 0.66), hand, c)
    wtop = (hand[0] - 0.02, hand[1] - 0.2, hand[2] + 0.24)
    limb('wrench', (hand[0], hand[1] + 0.03, hand[2] - 0.06), wtop, 0.024, iron, up)
    # Open-jaw head: a block with two prongs.
    prim('cube', 'wrenchhead', (wtop[0], wtop[1] - 0.02, wtop[2] + 0.04), (0.16, 0.06, 0.07), iron, up, rot=(0.6, 0, 0), bevel=0.012)
    for px in (-0.055, 0.055):
        prim('cube', 'wrenchjaw', (wtop[0] + px, wtop[1] - 0.06, wtop[2] + 0.1), (0.045, 0.05, 0.11), iron, up, rot=(0.6, 0, 0), bevel=0.01)
    # Crackling spark orb in the left hand.
    lhand = (tw + 0.04, -0.3, 0.62)
    arm(r, 'armL', (tw + 0.02, 0, 0.66), lhand, c)
    prim('ico', 'orb', (lhand[0], lhand[1] - 0.05, lhand[2] + 0.08), (0.075, 0.075, 0.075), mat('sparkorb', '#b8ff6a', emit=3.5, rough=0.2), up, sub=2)
    return r


CHARACTERS = {'brick': build_brick, 'vex': build_vex, 'boom': build_boom, 'melo': build_melo, 'kit': build_kit, 'tink': build_tink}


def set_pose(r, frame):
    s = (0, 1, 0, -1)[frame]
    r['legL'].rotation_euler.x = 0.5 * s
    r['legR'].rotation_euler.x = -0.5 * s
    if 'swingArm' in r:
        r['swingArm'].rotation_euler.x = -0.45 * s
    r['upper'].location.z = 0.03 * abs(s)


# ---------------------------------------------------------------- cameras & rendering


def ortho_camera(anchor, anchor_px, res, ppb, elev=ELEV):
    """Tilted orthographic camera placing 3D point `anchor` at pixel `anchor_px` (from top-left)."""
    sc = bpy.context.scene
    cam_data = bpy.data.cameras.new('Cam')
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = max(res) / ppb
    cam_data.clip_start = 0.1
    cam_data.clip_end = 500
    cam = bpy.data.objects.new('Cam', cam_data)
    sc.collection.objects.link(cam)
    cam.rotation_euler = (math.pi / 2 - elev, 0, 0)
    bpy.context.view_layer.update()
    m = cam.matrix_world.to_3x3()
    right, up, fwd = m.col[0], m.col[1], -m.col[2]
    a = Vector(anchor)
    cam.location = a - right * ((anchor_px[0] - res[0] / 2) / ppb) - up * ((res[1] / 2 - anchor_px[1]) / ppb) - fwd * 80
    sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    return cam


def render_to_array(w, h):
    path = os.path.join(TMP, 'frame.png')
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path)
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)[::-1]
    bpy.data.images.remove(img)
    return px


def save_array(arr, path, fmt='WEBP', quality=90):
    h, w = arr.shape[:2]
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=True)
    img.pixels = np.ascontiguousarray(arr[::-1]).ravel()
    img.filepath_raw = path
    img.file_format = fmt
    try:
        bpy.context.scene.render.image_settings.quality = quality
    except AttributeError:
        pass
    img.save()
    bpy.data.images.remove(img)
    print('saved', path, w, 'x', h, os.path.getsize(path) // 1024, 'KB')


def render_characters(manifest):
    cell, anchor = 224, (112, 178)
    only = [c for c in CHARACTERS if c in ONLY]
    for cid, build in CHARACTERS.items():
        if only and cid not in only:
            continue
        reset_scene(samples=32)
        r = build()
        r['root'].scale = (CHAR_SCALE,) * 3
        ortho_camera((0, 0, 0), anchor, (cell, cell), SPRITE_PPB, CHAR_ELEV)
        atlas = np.zeros((DIRS * cell, FRAMES * cell, 4), np.float32)
        for d in range(DIRS):
            a = d * 2 * math.pi / DIRS  # game aim angle: 0 = right, pi/2 = down the screen
            r['root'].rotation_euler.z = math.pi / 2 - a
            for f in range(FRAMES):
                set_pose(r, f)
                atlas[d * cell:(d + 1) * cell, f * cell:(f + 1) * cell] = render_to_array(cell, cell)
        save_array(atlas, os.path.join(OUT, f'{cid}.webp'))
        manifest['characters'][cid] = {'file': f'{cid}.webp', 'cell': cell, 'ax': anchor[0], 'ay': anchor[1],
                                       'dirs': DIRS, 'frames': FRAMES, 'scale': 64 / SPRITE_PPB}


# ---------------------------------------------------------------- props


def boulder(name, loc, size, seed, m, parent, moss=False):
    """A soft, lumpy boulder with a flattened base; optional moss cap."""
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3, radius=1)
    o = bpy.context.active_object
    o.name = name
    bm = bmesh.new()
    bm.from_mesh(o.data)
    for v in bm.verts:
        n = v.co.normalized()
        f = 1 + 0.13 * math.sin(n.x * 4 + seed) * math.cos(n.y * 3.3 + seed * 1.7) + 0.07 * math.sin(n.z * 6 + seed * 2.1)
        v.co *= f
        if v.co.z < -0.35:
            v.co.z = -0.35 + (v.co.z + 0.35) * 0.25
    bm.to_mesh(o.data)
    bm.free()
    o.location = loc
    o.scale = size
    _finish(o, m, 0, True)
    keep_parent(o, parent)
    if moss:
        cap = prim('ico', name + 'moss', (loc[0], loc[1], loc[2] + size[2] * 0.72), (size[0] * 0.75, size[1] * 0.72, size[2] * 0.32),
                   noise_mat('moss', '#5f7f3a', '#8aa458', 9), parent, sub=2)
        cap.rotation_euler.z = seed
    return o


def build_wall(v, stretch=True):
    """Brawl Stars-style cover: a stone block with a mossy top, in three stone tints."""
    root = empty('wall')
    sy = 1 / SIN if stretch else 1
    stone = [noise_mat('stoneA', '#a39b8b', '#c9bfaa', 5, brick=2.2),
             noise_mat('stoneB', '#8f8a80', '#b8b1a3', 5, brick=2.2),
             noise_mat('stoneC', '#ad9877', '#d1bd99', 5, brick=2.2)][v]
    prim('cube', 'block', (0, 0, 0.45), (0.98, 0.98 * sy, 0.9), stone, root, bevel=0.05, smooth=False)
    moss = noise_mat('moss', '#5f7f3a', '#8aa458', 9)
    prim('cube', 'moss', (0, 0, 0.905), (0.9, 0.9 * sy, 0.05), moss, root, bevel=0.025, smooth=False)
    rng = random.Random(v)
    for i in range(3 if v == 1 else 2):
        prim('ico', 'pebble', (rng.uniform(-0.4, 0.4), -0.5 * sy - 0.04, 0.05), (0.09, 0.07 * sy, 0.06),
             noise_mat('rock', '#8d897f', '#c2bcae', 6, kind='rock'), root)
    return root


def build_bush(v, stretch=True):
    root = empty('bush')
    sy = 1 / SIN if stretch else 1
    leaf = noise_mat('leafA' if v != 2 else 'leafB', '#46632e' if v != 2 else '#506a33', '#7d9a4e' if v != 2 else '#8ea65a', 7)
    rng = random.Random(10 + v)
    blobs = [(0, 0, 0.32, 0.36)] + [(math.cos(a) * 0.3, math.sin(a) * 0.3, 0.25, 0.27)
                                    for a in [i * 2 * math.pi / 6 + rng.uniform(-0.3, 0.3) for i in range(6)]]
    for i, (x, y, z, s) in enumerate(blobs):
        s *= rng.uniform(0.9, 1.1)
        prim('ico', f'leaf{i}', (x, y * sy, z), (s, s * sy, s * 0.85), leaf, root, sub=3)
    if v == 1:
        for i in range(7):
            a = rng.uniform(0, 2 * math.pi)
            prim('sphere', 'berry', (math.cos(a) * 0.28, math.sin(a) * 0.28 * sy, 0.42 + rng.uniform(-0.05, 0.12)),
                 (0.04, 0.04 * sy, 0.04), mat('berry', '#c4483f', rough=0.4, spec=0.6), root, seg=12, rings=8)
    if v == 2:
        for i in range(6):
            a = rng.uniform(0, 2 * math.pi)
            prim('sphere', 'flower', (math.cos(a) * 0.3, math.sin(a) * 0.3 * sy, 0.45 + rng.uniform(-0.05, 0.1)),
                 (0.05, 0.05 * sy, 0.025), mat('bloom', '#f3ead2', rough=0.6), root, seg=12, rings=8)
    return root


def build_crate(stretch=True):
    root = empty('crate')
    sy = 1 / SIN if stretch else 1
    wood = noise_mat('plank', '#86653f', '#ad8a5c', 4, kind='planks')
    dark = mat('plankdark', '#5a4330', rough=0.8)
    rope = noise_mat('rope', '#d8caa6', '#efe4c8', 40, kind='cloth')
    s = 0.84
    prim('cube', 'box', (0, 0, s / 2), (s, s * sy, s), wood, root, bevel=0.03, smooth=False)
    for z in (0.05, s - 0.05):
        prim('cube', 'band', (0, 0, z), (s + 0.02, s * sy + 0.02, 0.07), dark, root, smooth=False)
    # Cross-strapped rope over the lid and down the sides.
    prim('cube', 'strapA', (0, 0, s / 2), (s + 0.025, 0.07 * sy, s + 0.025), rope, root, smooth=False)
    prim('cube', 'strapB', (0, 0, s / 2), (0.07, s * sy + 0.025, s + 0.025), rope, root, smooth=False)
    prim('cube', 'gem', (0, 0, s + 0.07), (0.2, 0.2 * sy, 0.2), mat('cubeglow', '#5fc9a6', emit=0.5, rough=0.2),
         root, rot=(0.6, 0.6, 0.3), smooth=False)
    return root


def build_cube():
    root = empty('powercube')
    prim('cube', 'cube', (0, 0, 0.3), (0.34, 0.34, 0.34), mat('cubeglow2', '#2ee87a', emit=2.2, rough=0.2), root,
         rot=(0.62, 0.62, 0.2), outline=0.014, smooth=False, bevel=0.03)
    prim('cube', 'core', (0, -0.05, 0.31), (0.12, 0.12, 0.12), mat('cubecore', '#eaffdf', emit=4), root,
         rot=(0.62, 0.62, 0.2), outline=0, smooth=False)
    return root


def build_turret():
    """Tink's turret: a brass drum on a wooden tripod with a stubby barrel and a glowing eye. Faces -Y."""
    root = empty('turret')
    wood = noise_mat('turretwood', '#6e4a2c', '#8f6a45', 10, kind='wood')
    brass = mat('brass', '#b8913a', rough=0.35, metal=0.7, spec=0.6)
    for k in range(3):
        a = k * 2 * math.pi / 3 + math.pi / 2
        limb(f'leg{k}', (0, 0, 0.36), (math.cos(a) * 0.3, math.sin(a) * 0.3, 0.0), 0.03, wood, root)
    prim('cyl', 'drum', (0, 0, 0.46), (0.17, 0.17, 0.18), brass, root, seg=20)
    prim('sphere', 'dome', (0, 0, 0.56), (0.15, 0.15, 0.09), brass, root)
    for z in (0.39, 0.53):
        prim('torus', 'rivetband', (0, 0, z), (0.172, 0.172, 0.172), mat('iron', '#4a4a50', rough=0.5, metal=0.6), root, minor=0.08)
    limb('barrel', (0, -0.12, 0.47), (0, -0.42, 0.49), 0.045, mat('iron', '#4a4a50'), root)
    prim('cyl', 'muzzle', (0, -0.43, 0.49), (0.06, 0.06, 0.04), brass, root, rot=(math.pi / 2, 0, 0), seg=14)
    prim('sphere', 'eye', (0, -0.15, 0.58), (0.045, 0.03, 0.035), mat('sparkorb', '#b8ff6a', emit=3.5, rough=0.2), root, seg=12, rings=8)
    return root


def build_gem():
    """Gem Grab crystal: a tall faceted amethyst with a bright core."""
    root = empty('gem')
    bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=0.2, radius2=0.0, depth=0.26, location=(0, 0, 0.53))
    top = bpy.context.active_object
    _finish(top, mat('gemcrystal', '#b56cf0', rough=0.12, emit=0.9, spec=0.8), 0.01, False)
    keep_parent(top, root)
    bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=0.2, radius2=0.0, depth=0.4, location=(0, 0, 0.2), rotation=(math.pi, 0, 0))
    bot = bpy.context.active_object
    _finish(bot, mat('gemcrystal', '#b56cf0'), 0.01, False)
    keep_parent(bot, root)
    prim('ico', 'gemcore', (0, 0, 0.4), (0.07, 0.07, 0.07), mat('gemcore', '#f3dcff', emit=3.0), root, outline=0, sub=1)
    return root


def build_star():
    """Bounty star: a chunky, bevelled golden five-point star standing upright."""
    root = empty('star')
    bm = bmesh.new()
    pts = []
    for k in range(10):
        a = math.pi / 2 + k * math.pi / 5
        rr = 0.3 if k % 2 == 0 else 0.13
        pts.append(bm.verts.new((math.cos(a) * rr, 0, math.sin(a) * rr)))
    face = bm.faces.new(pts)
    ext = bmesh.ops.extrude_face_region(bm, geom=[face])
    for v in [g for g in ext['geom'] if isinstance(g, bmesh.types.BMVert)]:
        v.co.y += 0.09
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0, -0.045, 0.34))
    me = bpy.data.meshes.new('star')
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new('star', me)
    bpy.context.scene.collection.objects.link(o)
    _finish(o, mat('stargold', '#f2c13a', rough=0.25, metal=0.6, emit=0.35, spec=0.7), 0.01, False, bevel=0.025)
    keep_parent(o, root)
    return root


def build_drink():
    """Energy Drink: an orange can with a cream band and a lightning stripe."""
    root = empty('drink')
    prim('cyl', 'can', (0, 0, 0.26), (0.13, 0.13, 0.42), mat('canorange', '#ff8a1f', rough=0.3, metal=0.4, emit=0.25), root, seg=24, bevel=0.01)
    prim('cyl', 'band', (0, 0, 0.27), (0.133, 0.133, 0.12), mat('canband', '#fff1b0', rough=0.4), root, seg=24)
    prim('cyl', 'lid', (0, 0, 0.485), (0.115, 0.115, 0.03), mat('canlid', '#c9c9c9', rough=0.3, metal=0.8), root, seg=24)
    # Zig-zag bolt across the band.
    bolt = mat('canbolt', '#ff5a1f', rough=0.4, emit=0.4)
    for k, (z0, z1, x0, x1) in enumerate(((0.36, 0.28, -0.03, 0.02), (0.28, 0.26, 0.02, -0.02), (0.26, 0.17, -0.02, 0.03))):
        limb(f'bolt{k}', (x0, -0.135, z0), (x1, -0.135, z1), 0.014, bolt, root, outline=0)
    return root


def build_trophy():
    """Trophy cup for the trophy counter."""
    root = empty('trophy')
    gold = mat('trophygold', '#e8b53a', rough=0.25, metal=0.8, spec=0.7)
    prim('cone', 'cup', (0, 0, 0.47), (0.2, 0.2, 0.26), gold, root, rot=(math.pi, 0, 0), r2=0.45, seg=24)
    prim('cyl', 'rim', (0, 0, 0.6), (0.205, 0.205, 0.02), gold, root, seg=24)
    for sx in (1, -1):
        prim('torus', 'handle', (sx * 0.2, 0, 0.48), (0.08, 0.08, 0.08), gold, root, rot=(math.pi / 2, 0, 0), minor=0.22)
    limb('stem', (0, 0, 0.34), (0, 0, 0.16), 0.03, gold, root)
    prim('cube', 'base', (0, 0, 0.1), (0.24, 0.18, 0.12), noise_mat('trophybase', '#5a3a22', '#7a5434', 10, kind='wood'), root, bevel=0.015)
    return root


ICONS = {'gem': build_gem, 'star': build_star, 'cube': None, 'drink': build_drink, 'trophy': build_trophy}


def render_icons(manifest):
    """Square, transparent icons of the collectibles for the HUD (replacing emoji)."""
    os.makedirs(os.path.join(OUT, 'icons'), exist_ok=True)
    icons = {}
    for name, build in ICONS.items():
        reset_scene(samples=64)
        root = (build or build_cube)()
        # Turn props a little so they read as 3D, then frame them.
        root.rotation_euler.z = {'star': 0.35, 'cube': 0.0, 'drink': -0.4, 'trophy': -0.3, 'gem': 0.3}[name]
        ortho_camera((0, 0, 0.36), (64, 70), (128, 128), 150, math.radians(22))
        save_array(render_to_array(128, 128), os.path.join(OUT, 'icons', f'{name}.png'), fmt='PNG')
        icons[name] = f'icons/{name}.png'
    manifest['icons'] = icons


def build_ghost():
    root = empty('ghost')
    body = mat('ghostbody', '#eef0ff', rough=0.3, emit=0.6)
    bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=0.32, depth=0.5, location=(0, 0, 0.45))
    sk = bpy.context.active_object
    bm = bmesh.new()
    bm.from_mesh(sk.data)
    for v in bm.verts:
        if v.co.z < 0:
            ang = math.atan2(v.co.y, v.co.x)
            v.co.z += 0.06 * math.sin(ang * 6)
            v.co.x *= 1.15
            v.co.y *= 1.15
    bm.to_mesh(sk.data)
    bm.free()
    _finish(sk, body, 0.012, True)
    keep_parent(sk, root)
    prim('sphere', 'top', (0, 0, 0.7), (0.32, 0.32, 0.3), body, root)
    for sx in (1, -1):
        prim('sphere', 'eye', (0.1 * sx, -0.29, 0.72), (0.06, 0.03, 0.09), mat('ghosteye', '#2a1d5a'), root, outline=0)
    prim('sphere', 'mouth', (0, -0.31, 0.58), (0.05, 0.02, 0.06), mat('ghosteye', '#2a1d5a'), root, outline=0)
    return root


def render_props(manifest):
    # name: (builder, cell w, cell h, anchor x, anchor y)
    specs = {}
    for v in range(3):
        specs[f'wall{v}'] = (lambda v=v: build_wall(v), 160, 256, 80, 184)
        specs[f'bush{v}'] = (lambda v=v: build_bush(v), 192, 224, 96, 140)
    specs['crate'] = (build_crate, 160, 224, 80, 150)
    specs['cube'] = (build_cube, 112, 128, 56, 92)
    specs['ghost'] = (build_ghost, 128, 176, 64, 136)
    cols = []
    x = 0
    for name, (build, w, h, ax, ay) in specs.items():
        reset_scene(samples=48)
        build()
        ortho_camera((0, 0, 0), (ax, ay), (w, h), SPRITE_PPB)
        cols.append((name, x, render_to_array(w, h), ax, ay))
        x += w
    H = max(c[2].shape[0] for c in cols)
    atlas = np.zeros((H, x, 4), np.float32)
    props = {}
    for name, x0, arr, ax, ay in cols:
        h, w = arr.shape[:2]
        atlas[:h, x0:x0 + w] = arr
        props[name] = {'x': x0, 'y': 0, 'w': w, 'h': h, 'ax': ax, 'ay': ay}
    save_array(atlas, os.path.join(OUT, 'props.webp'))
    manifest['props'] = {'file': 'props.webp', 'scale': 64 / SPRITE_PPB, 'sprites': props}


# ---------------------------------------------------------------- ground (the arena)


def game_map():
    """Read the map + crate spots from shared/game.js so art and gameplay never drift apart."""
    here = os.path.dirname(os.path.abspath(globals().get('__file__') or 'tools/blender/build_assets.py'))
    src = open(os.path.join(here, '..', '..', 'shared', 'game.js')).read()
    quad = src.split('const QUADRANT = [')[1].split('];')[0]
    rows = [ln.strip().strip(',').strip("'") for ln in quad.strip().splitlines() if ln.strip().startswith("'")]
    n = len(rows) * 2
    full = []
    for r in range(n):
        full.append(''.join(rows[r if r < n // 2 else n - 1 - r][c if c < n // 2 else n - 1 - c] for c in range(n)))
    return full


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def ground_masks(n, margin, res_per_bu, rows=None):
    size = n + 2 * margin
    px = int(size * res_per_bu)
    g = (np.arange(px) + 0.5) / res_per_bu - margin
    X, Y = np.meshgrid(g, g)  # game BU coords, Y down
    cx = cy = n / 2
    dx, dy = X - cx, Y - cy
    rad = np.hypot(dx, dy)
    ang = np.arctan2(dy, dx)
    wob = 0.12 * np.sin(ang * 7) + 0.08 * np.sin(ang * 13 + 1)
    ring = smoothstep(0.75, 0.55, np.abs(rad - n * 0.37 + wob))
    spokes = np.zeros_like(rad)
    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
        along = dx * math.cos(a) + dy * math.sin(a)
        across = np.abs(-dx * math.sin(a) + dy * math.cos(a)) + 0.1 * np.sin(along * 1.7)
        spokes = np.maximum(spokes, smoothstep(0.62, 0.42, across) * (along > 2) * (along < n * 0.6))
    path = np.maximum(ring, spokes)
    plaza = smoothstep(n * 0.09, n * 0.09 - 0.3, rad + 0.05 * np.sin(ang * 9))
    inside = smoothstep(-0.02, 0.06, np.minimum(np.minimum(X, n - X), np.minimum(Y, n - Y)))
    # Rounded-square island: arena plus a sandy beach
    half = n / 2 + 0.85
    cr = 1.4
    qx, qy = np.abs(dx) - (half - cr), np.abs(dy) - (half - cr)
    sd = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - cr
    sd += 0.12 * np.sin(X * 2.1) * np.sin(Y * 1.7)
    land = smoothstep(0.05, -0.05, sd)
    shore = np.clip(sd / 2.0, 0, 1)
    # Ponds: rounded water pools carved out of the arena wherever the map has 'w' tiles.
    # Each connected group of 'w' tiles becomes one rounded, slightly wobbly pool.
    pond_sd = np.full_like(sd, 9.0)
    seen = set()
    for r0, row in enumerate(rows or []):
        for c0, ch in enumerate(row):
            if ch != 'w' or (r0, c0) in seen:
                continue
            stack, cells = [(r0, c0)], []
            seen.add((r0, c0))
            while stack:
                r, c = stack.pop()
                cells.append((r, c))
                for rr, cc in ((r + 1, c), (r - 1, c), (r, c + 1), (r, c - 1)):
                    if 0 <= rr < len(rows) and 0 <= cc < len(rows[0]) and rows[rr][cc] == 'w' and (rr, cc) not in seen:
                        seen.add((rr, cc))
                        stack.append((rr, cc))
            rs, cs = [r for r, _ in cells], [c for _, c in cells]
            cx2, cy2 = (min(cs) + max(cs) + 1) / 2, (min(rs) + max(rs) + 1) / 2
            hx, hy, rad2 = (max(cs) - min(cs) + 1) / 2, (max(rs) - min(rs) + 1) / 2, 0.55
            qx2, qy2 = np.abs(X - cx2) - hx + rad2, np.abs(Y - cy2) - hy + rad2
            t_sd = np.hypot(np.maximum(qx2, 0), np.maximum(qy2, 0)) + np.minimum(np.maximum(qx2, qy2), 0) - rad2
            pond_sd = np.minimum(pond_sd, t_sd + 0.05 * np.sin(X * 4.1) * np.sin(Y * 3.7))
    in_pond = pond_sd < 0.05
    land = land * smoothstep(-0.05, 0.05, pond_sd)
    inside = inside * smoothstep(-0.05, 0.05, pond_sd)
    shore = np.where(in_pond, 0.35 + 0.65 * np.clip(-pond_sd / 0.6, 0, 1), shore)
    foam = smoothstep(0.0, 0.08, sd) * smoothstep(0.45, 0.15, sd + 0.06 * np.sin(X * 5 + Y * 3))
    a = np.stack([path * inside, plaza * inside, inside, np.ones_like(rad)], -1)
    b = np.stack([land, shore, foam, np.ones_like(rad)], -1)
    return a.astype(np.float32), b.astype(np.float32), px


def mask_image(name, arr):
    h, w = arr.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=True, float_buffer=True)
    img.colorspace_settings.name = 'Non-Color'
    img.pixels = np.ascontiguousarray(arr[::-1]).ravel()
    img.pack()
    return img


def ground_material(mask_a, mask_b):
    m = bpy.data.materials.new('Ground')
    nt = m.node_tree
    N, L = nt.nodes, nt.links
    p = N['Principled BSDF']
    p.inputs['Specular IOR Level'].default_value = 0.15
    uv = N.new('ShaderNodeTexCoord')

    def tex(img):
        t = N.new('ShaderNodeTexImage')
        t.image = img
        t.interpolation = 'Linear'
        t.extension = 'EXTEND'
        L.new(uv.outputs['UV'], t.inputs['Vector'])
        sep = N.new('ShaderNodeSeparateColor')
        L.new(t.outputs['Color'], sep.inputs['Color'])
        return sep

    A, B = tex(mask_a), tex(mask_b)

    def noise(scale, detail=3, coord='Object'):
        nz = N.new('ShaderNodeTexNoise')
        nz.inputs['Scale'].default_value = scale
        nz.inputs['Detail'].default_value = detail
        L.new(uv.outputs[coord], nz.inputs['Vector'])
        return nz.outputs['Fac']

    def ramp(fac, stops):
        r = N.new('ShaderNodeValToRGB')
        r.color_ramp.elements[0].position, r.color_ramp.elements[0].color = stops[0][0], (*hex_lin(stops[0][1]), 1)
        r.color_ramp.elements[1].position, r.color_ramp.elements[1].color = stops[-1][0], (*hex_lin(stops[-1][1]), 1)
        for pos, col in stops[1:-1]:
            e = r.color_ramp.elements.new(pos)
            e.color = (*hex_lin(col), 1)
        L.new(fac, r.inputs['Fac'])
        return r.outputs['Color']

    def mix(c1, c2, fac):
        mx = N.new('ShaderNodeMix')
        mx.data_type = 'RGBA'
        L.new(fac, mx.inputs['Factor']) if not isinstance(fac, float) else None
        if isinstance(fac, float):
            mx.inputs['Factor'].default_value = fac
        L.new(c1, mx.inputs[6])
        L.new(c2, mx.inputs[7])
        return mx.outputs[2]

    # Grass: soft noise + a faint per-tile checker so movement reads clearly.
    grass = ramp(noise(0.9, 4), [(0.3, '#4fa63f'), (0.55, '#62b84a'), (0.75, '#79c957')])
    chk = N.new('ShaderNodeTexChecker')
    chk.inputs['Scale'].default_value = 0.5
    chk.inputs['Color1'].default_value = (1, 1, 1, 1)
    chk.inputs['Color2'].default_value = (0.9, 0.93, 0.88, 1)
    mapping = N.new('ShaderNodeMapping')
    mapping.inputs['Scale'].default_value = (1, SIN, 1)  # undo the Y stretch so checks stay square tiles
    L.new(uv.outputs['Object'], mapping.inputs['Vector'])
    L.new(mapping.outputs['Vector'], chk.inputs['Vector'])
    gmul = N.new('ShaderNodeMix')
    gmul.data_type = 'RGBA'
    gmul.blend_type = 'MULTIPLY'
    gmul.inputs['Factor'].default_value = 1.0
    L.new(grass, gmul.inputs[6])
    L.new(chk.outputs['Color'], gmul.inputs[7])
    grass = gmul.outputs[2]
    sand = ramp(noise(3, 3), [(0.35, '#dcc287'), (0.7, '#ecd9a3')])
    vor = N.new('ShaderNodeTexVoronoi')
    vor.feature = 'DISTANCE_TO_EDGE'
    vor.inputs['Scale'].default_value = 2.6
    L.new(mapping.outputs['Vector'], vor.inputs['Vector'])
    cobble = ramp(vor.outputs['Distance'], [(0.0, '#6e6458'), (0.07, '#a89a84'), (0.3, '#c2b39a')])
    beach = ramp(noise(2.5, 3), [(0.35, '#ead39a'), (0.7, '#f6e6bb')])
    shallow_deep = ramp(B.outputs['Green'], [(0.0, '#5fd4e8'), (0.3, '#2fa6d8'), (0.75, '#1f78c2')])
    sparkle = ramp(noise(5, 2), [(0.62, '#000000'), (0.7, '#ffffff')])
    fade = N.new('ShaderNodeMath')  # sparkles fade out toward the deep edge so it meets the page background
    fade.operation = 'MULTIPLY'
    L.new(noise(5, 2), fade.inputs[0])
    inv = N.new('ShaderNodeMath')
    inv.operation = 'SUBTRACT'
    inv.inputs[0].default_value = 1.0
    L.new(B.outputs['Green'], inv.inputs[1])
    L.new(inv.outputs[0], fade.inputs[1])
    water = mix(shallow_deep, mix(shallow_deep, sparkle, 0.5), fade.outputs[0])
    foam_col = N.new('ShaderNodeRGB')
    foam_col.outputs[0].default_value = (1, 1, 1, 1)
    water = mix(water, foam_col.outputs[0], B.outputs['Blue'])
    arena = mix(mix(grass, sand, A.outputs['Red']), cobble, A.outputs['Green'])
    landcol = mix(beach, arena, A.outputs['Blue'])
    final = mix(water, landcol, B.outputs['Red'])
    L.new(final, p.inputs['Base Color'])
    rough = N.new('ShaderNodeMapRange')
    rough.inputs['To Min'].default_value = 0.25
    rough.inputs['To Max'].default_value = 0.85
    L.new(B.outputs['Red'], rough.inputs['Value'])
    L.new(rough.outputs['Result'], p.inputs['Roughness'])
    return m


def render_ground(manifest):
    reset_scene(transparent=False, samples=64)
    rows = game_map()
    n = len(rows)
    margin = 3
    size = n + 2 * margin
    res_px_per_bu = 72  # keeps the 2D fallback map under mobile image-size limits
    res = int(size * res_px_per_bu)
    mask_a, mask_b, _ = ground_masks(n, margin, 24, rows)
    gmat = ground_material(mask_image('maskA', mask_a), mask_image('maskB', mask_b))

    def to_b(gx, gy, z=0.0):
        return (gx, -gy / SIN, z)

    bpy.ops.mesh.primitive_plane_add(size=1)
    plane = bpy.context.active_object
    plane.scale = (size, size / SIN, 1)
    plane.location = to_b(n / 2, n / 2)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    plane.data.materials.append(gmat)

    # Shadow-only copies of walls and bushes, so the baked ground has their shadows.
    caster_cache = {}
    rng = random.Random(42)
    for r, row in enumerate(rows):
        for c, ch in enumerate(row):
            if ch not in '#*':
                continue
            v = (r * 7 + c * 13) % 3
            obj = build_wall(v) if ch == '#' else build_bush(v)
            obj.location = to_b(c + 0.5, r + 0.5)
            for o in [obj] + list(obj.children_recursive):
                o.visible_camera = False
            caster_cache[(r, c)] = obj

    # Decorations: flowers, tufts and pebbles on open grass; rocks and lily pads in the water.
    a_mask = mask_a
    def free_tile(gx, gy):
        c, r = int(gx), int(gy)
        if not (0 <= r < n and 0 <= c < n):
            return False
        if rows[r][c] != '.':
            return False
        i, j = int((gy + margin) * 24), int((gx + margin) * 24)
        return a_mask[i, j, 0] < 0.2 and a_mask[i, j, 1] < 0.2
    petal_cols = ['#ffffff', '#fff3a8', '#ff9ec7', '#c9a7ff']
    count = 0
    while count < 260:
        gx, gy = rng.uniform(0.3, n - 0.3), rng.uniform(0.3, n - 0.3)
        if not free_tile(gx, gy):
            continue
        kind = rng.random()
        if kind < 0.45:
            col = rng.choice(petal_cols)
            for k in range(rng.randint(2, 4)):
                ox, oy = rng.uniform(-0.12, 0.12), rng.uniform(-0.12, 0.12)
                prim('sphere', 'flower', to_b(gx + ox, gy + oy, 0.04), (0.065, 0.065 / SIN, 0.035), mat('petal' + col, col, rough=0.5), outline=0, seg=10, rings=6)
                prim('sphere', 'fc', to_b(gx + ox, gy + oy, 0.07), (0.025, 0.025 / SIN, 0.015), mat('fcenter', '#ffb02e'), outline=0, seg=8, rings=4)
        elif kind < 0.85:
            for k in range(rng.randint(3, 5)):
                ox, oy = rng.uniform(-0.1, 0.1), rng.uniform(-0.1, 0.1)
                prim('cone', 'tuft', to_b(gx + ox, gy + oy, 0.08), (0.045, 0.045 / SIN, 0.16), mat('tuft', '#3c8a30'), outline=0, seg=6,
                     rot=(rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3), 0))
        else:
            s = rng.uniform(0.06, 0.11)
            prim('ico', 'pebble', to_b(gx, gy, 0.02), (s, s / SIN, s * 0.6), noise_mat('stoneB', '#9a948a', '#c2bbab', 5, brick=2.2), outline=0.006, sub=1)
        count += 1
    for k in range(26):
        side = rng.randrange(4)
        t = rng.uniform(-2.5, n + 2.5)
        d = rng.uniform(-2.6, -1.6)
        gx, gy = [(t, d), (t, n - d), (d, t), (n - d, t)][side]
        if rng.random() < 0.5:
            s = rng.uniform(0.18, 0.4)
            prim('ico', 'rock', to_b(gx, gy, 0.0), (s, s / SIN, s * 0.55), noise_mat('stoneA', '#b3a487', '#d6c8a8', 5, brick=2.2), sub=2)
        else:
            prim('cyl', 'lily', to_b(gx, gy, 0.01), (0.22, 0.22 / SIN, 0.01), mat('lily', '#4caf50'), outline=0.006)
            if rng.random() < 0.4:
                prim('sphere', 'lotus', to_b(gx + 0.05, gy, 0.05), (0.07, 0.07 / SIN, 0.05), mat('lotus', '#ff9ec7'), outline=0, seg=12, rings=8)

    ortho_camera(to_b(-margin, -margin), (0, 0), (res, res), res_px_per_bu)
    arr = render_to_array(res, res)
    save_array(arr, os.path.join(OUT, 'ground.webp'), quality=82)
    manifest['ground'] = {'file': 'ground.webp', 'x': -margin * 64, 'y': -margin * 64, 'size': size * 64}


# ---------------------------------------------------------------- hero key art


def render_hero(manifest):
    reset_scene(transparent=True, samples=96)
    sc = bpy.context.scene
    bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=3.2, depth=0.4, location=(0, 0.6, -0.2))
    island = bpy.context.active_object
    _finish(island, noise_mat('herograss', '#6a8a40', '#97ad62', 2), 0.02, True)
    for (x, y, v) in ((-1.9, 1.6, 0), (1.9, 1.7, 2), (0.0, 2.4, 1), (-2.6, 0.2, 1), (2.6, 0.3, 0)):
        b = build_bush(v, stretch=False)
        b.location = (x, y, 0)
        b.scale = (1.3, 1.3, 1.3)
    w = build_wall(0, stretch=False)
    w.location = (-1.1, 2.6, 0)
    poses = (('vex', (-1.25, 0.2, 0), 0.75), ('brick', (0, -0.3, 0), -0.35), ('boom', (1.25, 0.2, 0), -0.45))
    for cid, loc, rot in poses:
        r = CHARACTERS[cid]()
        r['root'].location = loc
        r['root'].rotation_euler.z = rot
        set_pose(r, 1 if cid == 'boom' else 0)
    cam_data = bpy.data.cameras.new('HeroCam')
    cam_data.lens = 50
    cam = bpy.data.objects.new('HeroCam', cam_data)
    sc.collection.objects.link(cam)
    cam.location = (0, -6.2, 3.0)
    cam.rotation_euler = (math.radians(68), 0, 0)
    sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y = 1600, 900
    arr = render_to_array(1600, 900)
    save_array(arr, os.path.join(OUT, 'hero.webp'), quality=88)
    manifest['hero'] = {'file': 'hero.webp'}


# ---------------------------------------------------------------- main

manifest_path = os.path.join(OUT, 'manifest.json')
manifest = json.load(open(manifest_path)) if os.path.exists(manifest_path) else {}
manifest.setdefault('characters', {})
for stage, fn in (('chars', render_characters), ('props', render_props), ('ground', render_ground), ('hero', render_hero), ('icons', render_icons)):
    if stage in ONLY or (stage == 'chars' and any(c in ONLY for c in CHARACTERS)):
        fn(manifest)
        json.dump(manifest, open(manifest_path, 'w'), indent=2)
print('MANIFEST', json.dumps(manifest))
