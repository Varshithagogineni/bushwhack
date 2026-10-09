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


def noise_mat(name, c1, c2, scale=6.0, rough=0.7, detail=4.0, brick=None):
    """Mottled two-colour material (stone, leaves, wood); optional brick/plank pattern."""
    NOISE_SPECS[name] = dict(c1=c1, c2=c2, scale=scale, rough=rough, brick=brick)
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
    if outline:
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
    if outline:
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


def build_body(c):
    """Shared chibi human: legs and shoes on hip pivots, torso, head, eyes. Faces -Y."""
    root = empty(f"{c['id']}_root")
    upper = empty('upper', parent=root)
    hip = 0.3
    rig = {'root': root, 'upper': upper}
    for side, sx in (('L', 1), ('R', -1)):
        piv = empty(f'leg{side}', (0.095 * sx, 0, hip), parent=root)
        limb(f'thigh{side}', (0.095 * sx, 0, hip), (0.095 * sx, 0, 0.07), c.get('leg_r', 0.075), mat(c['id'] + 'pants', c['pants']), piv)
        prim('sphere', f'shoe{side}', (0.095 * sx, -0.035, 0.055), (0.09, 0.13, 0.065), mat(c['id'] + 'shoe', c['shoe']), piv)
        rig['leg' + side] = piv
    tz = 0.52
    tw, td, th = c['torso']
    prim('sphere', 'torso', (0, 0, tz), (tw, td, th), mat(c['id'] + 'top', c['top']), upper)
    prim('sphere', 'hips', (0, 0, hip + 0.05), (tw * 0.85, td * 0.9, 0.11), mat(c['id'] + 'pants', c['pants']), upper)
    hr = c['head_r']
    hz = tz + th + hr * 0.78
    skin = mat(c['id'] + 'skin', c['skin'], rough=0.5)
    prim('sphere', 'head', (0, 0, hz), (hr, hr * 0.95, hr), skin, upper)
    prim('sphere', 'neck', (0, 0, tz + th * 0.9), (0.07, 0.07, 0.06), skin, upper, outline=0)
    for sx in (1, -1):
        ear = prim('sphere', 'ear', (hr * 0.97 * sx, 0.02, hz), (0.05, 0.035, 0.065), skin, upper)
        ear.name = 'ear'
    eye = mat('eye', '#16121f', rough=0.3, spec=0.6)
    white = mat('eyewhite', '#ffffff', rough=0.2, emit=0.4)
    for sx in (1, -1):
        prim('sphere', 'eye', (0.088 * sx, -hr * 0.9, hz + 0.0), (0.048, 0.03, 0.068), eye, upper, outline=0)
        prim('sphere', 'glint', (0.088 * sx + 0.014, -hr * 0.98, hz + 0.03), (0.017, 0.01, 0.017), white, upper, outline=0)
        if c.get('brows'):
            prim('cube', 'brow', (0.09 * sx, -hr * 0.9, hz + 0.085), (0.075, 0.025, 0.022), mat(c['id'] + 'hair', c['hair']), upper,
                 rot=(0, c['brows'] * sx, 0), outline=0)
    prim('sphere', 'mouth', (0, -hr * 0.92, hz - 0.1), (0.045, 0.015, 0.018), mat('mouth', '#6b2a2a'), upper, outline=0)
    prim('sphere', 'nose', (0, -hr * 0.99, hz - 0.045), (0.026, 0.02, 0.022), skin, upper, outline=0)
    rig.update(hz=hz, hr=hr, tz=tz, tw=tw, td=td, th=th, skin=skin)
    return rig


def arm(rig, name, shoulder, hand, c, radius=0.058, parent=None):
    m = mat(c['id'] + 'top', c['top'])
    limb(name, shoulder, hand, radius, m, parent or rig['upper'])
    prim('sphere', name + 'hand', hand, (0.062, 0.062, 0.062), rig['skin'], parent or rig['upper'])


def build_brick():
    c = dict(id='brick', skin='#e3a074', top='#f08c3a', pants='#3b5ba5', shoe='#4a2f1e', hair='#5a341a',
             torso=(0.27, 0.2, 0.2), head_r=0.235, leg_r=0.085, brows=-0.25)
    r = build_body(c)
    up, hz, hr, tz, tw = r['upper'], r['hz'], r['hr'], r['tz'], r['tw']
    denim = mat('brickpants', c['pants'])
    prim('cube', 'bib', (0, -0.18, tz - 0.05), (0.22, 0.05, 0.18), denim, up, bevel=0.02)
    for sx in (1, -1):
        prim('cube', 'strap', (0.12 * sx, -0.17, tz + 0.12), (0.05, 0.04, 0.16), denim, up, outline=0)
    prim('sphere', 'beard', (0, -0.1, hz - 0.14), (0.2, 0.16, 0.12), mat('brickhair', c['hair'], rough=0.9), up)
    hat = mat('hardhat', '#ffcd3c', rough=0.35, spec=0.5)
    dome('hat', (0, 0.01, hz + 0.1), (hr * 1.1, hr * 1.1, hr * 0.95), hat, up)
    prim('cyl', 'brim', (0, -0.03, hz + 0.1), (hr * 1.3, hr * 1.32, 0.03), hat, up)
    prim('cube', 'ridge', (0, 0.01, hz + 0.3), (0.06, hr * 1.6, 0.05), hat, up, bevel=0.015, outline=0)
    gz = tz - 0.06
    metal = mat('gunmetal', '#2b2b38', rough=0.35, metal=0.6, spec=0.6)
    wood = mat('gunwood', '#8a5a2b', rough=0.6)
    for sx in (1, -1):
        limb('barrel', (0.035 * sx, -0.18, gz), (0.035 * sx, -0.66, gz + 0.02), 0.04, metal, up)
    prim('cube', 'stock', (0, -0.08, gz - 0.02), (0.11, 0.24, 0.09), wood, up, bevel=0.02)
    arm(r, 'armL', (tw + 0.02, 0, tz + 0.1), (0.07, -0.42, gz + 0.03), c, 0.07)
    arm(r, 'armR', (-tw - 0.02, 0, tz + 0.1), (-0.06, -0.2, gz), c, 0.07)
    return r


def build_vex():
    c = dict(id='vex', skin='#f3c9a5', top='#4ea4ff', pants='#2d2f45', shoe='#1d1d24', hair='#ff5fa2',
             torso=(0.2, 0.15, 0.21), head_r=0.235, leg_r=0.068, brows=0.12)
    r = build_body(c)
    up, hz, hr, tz, tw = r['upper'], r['hz'], r['hr'], r['tz'], r['tw']
    hair = mat('vexhair', c['hair'], rough=0.45, spec=0.5)
    dome('hairtop', (0, 0.0, hz + 0.06), (hr * 1.08, hr * 1.07, hr * 1.0), hair, up)
    prim('sphere', 'hairback', (0, 0.08, hz), (hr * 1.0, hr * 0.85, hr * 0.95), hair, up)
    prim('sphere', 'bangs', (0.05, -hr * 0.78, hz + 0.12), (0.17, 0.07, 0.07), hair, up, rot=(0, -0.35, 0))
    for i, (y, z, s) in enumerate(((0.26, hz + 0.08, 0.1), (0.36, hz - 0.04, 0.085), (0.42, hz - 0.16, 0.07))):
        prim('sphere', f'pony{i}', (0, y, z), (s, s, s * 1.2), hair, up)
    prim('torus', 'band', (0, 0.0, hz + 0.13), (hr * 1.02, hr * 1.02, 0.25), mat('vexband', '#ffcd3c'), up, rot=(0.25, 0, 0), minor=0.12)
    prim('sphere', 'collar', (0, 0.0, tz + 0.17), (0.17, 0.13, 0.06), mat('vexcollar', '#1d5fa8'), up)
    gz = tz + 0.1
    metal = mat('gunmetal', '#2b2b38', rough=0.35, metal=0.6, spec=0.6)
    limb('rifle', (-0.05, 0.05, gz), (-0.05, -0.85, gz + 0.02), 0.032, metal, up)
    prim('cyl', 'scope', (-0.05, -0.32, gz + 0.07), (0.035, 0.035, 0.2), mat('scope', '#59d0ff', rough=0.2, emit=0.6), up, rot=(math.pi / 2, 0, 0))
    prim('cube', 'stock', (-0.05, 0.02, gz - 0.04), (0.06, 0.18, 0.09), mat('vexstock', '#1d5fa8'), up, bevel=0.015)
    arm(r, 'armR', (-tw - 0.02, 0, tz + 0.1), (-0.06, -0.12, gz - 0.02), c)
    arm(r, 'armL', (tw + 0.02, 0, tz + 0.1), (-0.03, -0.46, gz), c)
    return r


def build_boom():
    c = dict(id='boom', skin='#a8693f', top='#b56cf0', pants='#3a2a55', shoe='#f2f2f2', hair='#2b1a12',
             torso=(0.21, 0.16, 0.19), head_r=0.245, leg_r=0.07, brows=-0.1)
    r = build_body(c)
    up, hz, hr, tz, tw = r['upper'], r['hz'], r['hr'], r['tz'], r['tw']
    beanie = mat('beanie', '#6b2ea0', rough=0.85)
    dome('beanie', (0, 0.01, hz + 0.09), (hr * 1.08, hr * 1.08, hr * 1.05), beanie, up)
    prim('torus', 'cuff', (0, 0.0, hz + 0.1), (hr * 1.07, hr * 1.07, 0.35), beanie, up, minor=0.16)
    prim('ico', 'pompom', (0, 0.02, hz + hr + 0.12), (0.07, 0.07, 0.07), mat('pompom', '#ffcd3c', rough=0.95), up)
    gog = mat('goggle', '#ff9f1a', rough=0.15, emit=0.3, spec=0.8)
    prim('cube', 'gogband', (0, -hr * 0.9, hz + 0.19), (0.26, 0.04, 0.035), mat('gogband', '#2b1a12'), up, rot=(-0.6, 0, 0), outline=0)
    for sx in (1, -1):
        prim('cyl', 'goggle', (0.075 * sx, -hr * 0.92, hz + 0.19), (0.058, 0.058, 0.045), gog, up, rot=(math.pi / 2 - 0.6, 0, 0))
    prim('cube', 'satchel', (tw + 0.02, 0.02, tz - 0.12), (0.08, 0.15, 0.12), mat('satchel', '#7a4a22'), up, bevel=0.02)
    limb('strap', (-tw * 0.7, -0.1, tz + 0.18), (tw * 0.9, -0.1, tz - 0.08), 0.02, mat('satchel', '#7a4a22'), up, outline=0)
    hand = (-tw - 0.06, -0.05, tz + 0.42)
    arm(r, 'armR', (-tw - 0.02, 0, tz + 0.1), hand, c)
    prim('sphere', 'bomb', (hand[0], hand[1], hand[2] + 0.11), (0.11, 0.11, 0.11), mat('bomb', '#1e1e28', rough=0.3, spec=0.7), up)
    limb('fuse', (hand[0], hand[1], hand[2] + 0.2), (hand[0] + 0.04, hand[1], hand[2] + 0.28), 0.012, mat('fuse', '#d9b98a'), up, outline=0)
    prim('ico', 'spark', (hand[0] + 0.045, hand[1], hand[2] + 0.3), (0.035, 0.035, 0.035), mat('spark', '#ffb02e', emit=6), up, outline=0)
    piv = empty('armLpiv', (tw + 0.02, 0, tz + 0.1), parent=up)
    arm(r, 'armL', (tw + 0.02, 0, tz + 0.1), (tw + 0.08, 0, tz - 0.17), c, parent=piv)
    r['swingArm'] = piv
    return r


CHARACTERS = {'brick': build_brick, 'vex': build_vex, 'boom': build_boom}


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
    for cid, build in CHARACTERS.items():
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


def build_wall(v, stretch=True):
    root = empty('wall')
    sy = 1 / SIN if stretch else 1
    stone = [noise_mat('stoneA', '#b3a487', '#d6c8a8', 5, brick=2.2),
             noise_mat('stoneB', '#9a948a', '#c2bbab', 5, brick=2.2),
             noise_mat('stoneC', '#c2a77f', '#e2cba2', 5, brick=2.2)][v]
    prim('cube', 'block', (0, 0, 0.45), (0.98, 0.98 * sy, 0.9), stone, root, bevel=0.05, outline=0.012, smooth=False)
    moss = noise_mat('moss', '#4f9a3a', '#7cc455', 9)
    if True:
        prim('cube', 'moss', (0, 0, 0.905), (0.9, 0.9 * sy, 0.05), moss, root, bevel=0.025, outline=0, smooth=False)
    rng = random.Random(v)
    for i in range(3 if v == 1 else 2):
        prim('ico', 'pebble', (rng.uniform(-0.4, 0.4), -0.5 * sy - 0.04, 0.05), (0.09, 0.07 * sy, 0.06),
             noise_mat('stoneB', '#9a948a', '#c2bbab', 5, brick=2.2), root, outline=0.008)
    return root


def build_bush(v, stretch=True):
    root = empty('bush')
    sy = 1 / SIN if stretch else 1
    leaf = noise_mat('leafA' if v != 2 else 'leafB', '#2f8f3a', '#56c04f', 7)
    rng = random.Random(10 + v)
    blobs = [(0, 0, 0.32, 0.36)] + [(math.cos(a) * 0.3, math.sin(a) * 0.3, 0.25, 0.27)
                                    for a in [i * 2 * math.pi / 6 + rng.uniform(-0.3, 0.3) for i in range(6)]]
    for i, (x, y, z, s) in enumerate(blobs):
        s *= rng.uniform(0.9, 1.1)
        prim('ico', f'leaf{i}', (x, y * sy, z), (s, s * sy, s * 0.85), leaf, root, sub=3, outline=0.012)
    if v == 1:
        for i in range(7):
            a = rng.uniform(0, 2 * math.pi)
            prim('sphere', 'berry', (math.cos(a) * 0.28, math.sin(a) * 0.28 * sy, 0.42 + rng.uniform(-0.05, 0.12)),
                 (0.045, 0.045 * sy, 0.045), mat('berry', '#ff4d6d', rough=0.3, spec=0.7), root, outline=0, seg=12, rings=8)
    if v == 2:
        for i in range(6):
            a = rng.uniform(0, 2 * math.pi)
            prim('sphere', 'flower', (math.cos(a) * 0.3, math.sin(a) * 0.3 * sy, 0.45 + rng.uniform(-0.05, 0.1)),
                 (0.05, 0.05 * sy, 0.025), mat('bloom', '#fff3a8', rough=0.5, emit=0.2), root, outline=0, seg=12, rings=8)
    return root


def build_crate(stretch=True):
    root = empty('crate')
    sy = 1 / SIN if stretch else 1
    wood = noise_mat('plank', '#a56a33', '#c98d4e', 4, brick=None)
    dark = mat('plankdark', '#6e4319', rough=0.7)
    s = 0.84
    prim('cube', 'box', (0, 0, s / 2), (s, s * sy, s), wood, root, bevel=0.03, smooth=False)
    for z in (0.04, s - 0.04):
        prim('cube', 'bandF', (0, -s * sy / 2 - 0.005, z), (s + 0.02, 0.04, 0.08), dark, root, outline=0, smooth=False)
    for x in (-s / 2 + 0.06, s / 2 - 0.06):
        prim('cube', 'post', (x, -s * sy / 2 - 0.005, s / 2), (0.08, 0.04, s), dark, root, outline=0, smooth=False)
    prim('cube', 'diag', (0, -s * sy / 2 - 0.01, s / 2), (0.08, 0.04, s * 1.25), dark, root, rot=(0, 0.8, 0), outline=0, smooth=False)
    prim('cube', 'gem', (0, 0, s + 0.06), (0.22, 0.22 * sy, 0.22), mat('cubeglow', '#38e07b', emit=1.4, rough=0.2),
         root, rot=(0.6, 0.6, 0.3), outline=0.01, smooth=False)
    return root


def build_cube():
    root = empty('powercube')
    prim('cube', 'cube', (0, 0, 0.3), (0.34, 0.34, 0.34), mat('cubeglow2', '#2ee87a', emit=2.2, rough=0.2), root,
         rot=(0.62, 0.62, 0.2), outline=0.014, smooth=False, bevel=0.03)
    prim('cube', 'core', (0, -0.05, 0.31), (0.12, 0.12, 0.12), mat('cubecore', '#eaffdf', emit=4), root,
         rot=(0.62, 0.62, 0.2), outline=0, smooth=False)
    return root


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
    src = open(os.path.join(os.path.dirname(OUT), '..', 'shared', 'game.js')).read()
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


def ground_masks(n, margin, res_per_bu):
    size = n + 2 * margin
    px = int(size * res_per_bu)
    g = (np.arange(px) + 0.5) / res_per_bu - margin
    X, Y = np.meshgrid(g, g)  # game BU coords, Y down
    cx = cy = n / 2
    dx, dy = X - cx, Y - cy
    rad = np.hypot(dx, dy)
    ang = np.arctan2(dy, dx)
    wob = 0.12 * np.sin(ang * 7) + 0.08 * np.sin(ang * 13 + 1)
    ring = smoothstep(0.75, 0.55, np.abs(rad - 11.4 + wob))
    spokes = np.zeros_like(rad)
    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
        along = dx * math.cos(a) + dy * math.sin(a)
        across = np.abs(-dx * math.sin(a) + dy * math.cos(a)) + 0.1 * np.sin(along * 1.7)
        spokes = np.maximum(spokes, smoothstep(0.62, 0.42, across) * (along > 2) * (along < 15.5))
    path = np.maximum(ring, spokes)
    plaza = smoothstep(3.2, 2.9, rad + 0.05 * np.sin(ang * 9))
    inside = smoothstep(-0.02, 0.06, np.minimum(np.minimum(X, n - X), np.minimum(Y, n - Y)))
    # Rounded-square island: arena plus a sandy beach
    half = n / 2 + 0.85
    cr = 1.4
    qx, qy = np.abs(dx) - (half - cr), np.abs(dy) - (half - cr)
    sd = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - cr
    sd += 0.12 * np.sin(X * 2.1) * np.sin(Y * 1.7)
    land = smoothstep(0.05, -0.05, sd)
    shore = np.clip(sd / 2.0, 0, 1)
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
    res_px_per_bu = 96  # 1.5 image pixels per game pixel
    res = int(size * res_px_per_bu)
    mask_a, mask_b, _ = ground_masks(n, margin, 24)
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
    _finish(island, noise_mat('herograss', '#4fa63f', '#79c957', 2), 0.02, True)
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
for stage, fn in (('chars', render_characters), ('props', render_props), ('ground', render_ground), ('hero', render_hero)):
    if stage in ONLY:
        fn(manifest)
        json.dump(manifest, open(manifest_path, 'w'), indent=2)
print('MANIFEST', json.dumps(manifest))
