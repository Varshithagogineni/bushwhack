"""
Exports Bushwhack's 3D models for the real-time (Three.js) renderer.

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
        -P tools/blender/export_models.py -- public/models

Reuses the character/prop builders from build_assets.py, swaps their procedural materials for
generated image textures (procedural nodes don't survive glTF export), adds beach scenery
(palms, rocks, coral, starfish) and bakes the island's colour map + water mask.
"""
import bpy
import bmesh
import json
import math
import os
import random
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(ARGS[0] if ARGS else 'public/models')
ONLY = set(ARGS[1].split(',')) if len(ARGS) > 1 else None
os.makedirs(os.path.join(OUT, 'tex'), exist_ok=True)

# Load the shared builders (everything above build_assets.py's "main" section).
_src = open(os.path.join(HERE, 'build_assets.py')).read().split('# ---------------------------------------------------------------- main')[0]
_argv = sys.argv
sys.argv = ['blender', '--', os.path.join(OUT, '_tmp')]
L = {'__name__': 'bushwhack_lib', '__file__': os.path.join(HERE, 'build_assets.py')}
exec(compile(_src, 'build_assets.py', 'exec'), L)
sys.argv = _argv

L['SEG'] = 16
prim, mat, limb, empty, keep_parent, _finish = L['prim'], L['mat'], L['limb'], L['empty'], L['keep_parent'], L['_finish']
noise_mat, reset_scene, hex_lin = L['noise_mat'], L['reset_scene'], L['hex_lin']

# ---------------------------------------------------------------- tileable textures (numpy)

N = 256


def smooth_noise(rng, sx, sy=None):
    sy = sx if sy is None else sy
    w = rng.standard_normal((N, N))
    ky = np.fft.fftfreq(N)[:, None]
    kx = np.fft.fftfreq(N)[None, :]
    g = np.exp(-((kx * sx) ** 2 + (ky * sy) ** 2) * (2 * np.pi) ** 2 / 2)
    r = np.real(np.fft.ifft2(np.fft.fft2(w) * g))
    return (r - r.mean()) / (r.std() + 1e-9)


def fbm(seed, base=24.0, aniso=1.0, octaves=4):
    rng = np.random.default_rng(seed)
    out, amp, s = 0, 1.0, base
    for _ in range(octaves):
        out = out + amp * smooth_noise(rng, s * aniso, s)
        amp *= 0.5
        s /= 2
    return out / 1.6


def srgb(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])


def ramp(v, c1, c2, lo=-1.0, hi=1.0):
    t = np.clip((v - lo) / (hi - lo), 0, 1)[..., None]
    return srgb(c1) * (1 - t) + srgb(c2) * t


def tex_brick(c1, c2, seed):
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:N, 0:N]
    rows, row_h = 4, N // 4
    r = y // row_h
    xo = (x + (r % 2) * (N // 4)) % N
    bw = N // 2
    bi = xo // bw
    brick_id = r * 4 + bi
    tint = rng.uniform(0.86, 1.1, 64)[brick_id]
    dy = np.minimum(y % row_h, row_h - 1 - y % row_h)
    dx = np.minimum(xo % bw, bw - 1 - xo % bw)
    edge = np.minimum(dx, dy)
    col = ramp(fbm(seed, 10), c1, c2) * tint[..., None]
    col *= (0.82 + 0.18 * np.clip(edge / 7, 0, 1))[..., None]
    mortar = edge < 3
    col[mortar] = srgb('#6d6458') * 0.95
    return col


def tex_planks(c1, c2, seed):
    y, x = np.mgrid[0:N, 0:N]
    grain = fbm(seed, 30, aniso=0.15)
    col = ramp(grain, c1, c2)
    plank = (y % (N // 4)) < 4
    col[plank] = srgb('#5b3a1a')
    col *= (0.92 + 0.08 * np.sin(x / 9 + fbm(seed + 1, 20) * 2))[..., None]
    return col


def tex_leaves(c1, c2, seed):
    base = fbm(seed, 20)
    detail = fbm(seed + 3, 4, octaves=2)
    col = ramp(base * 0.7 + detail * 0.6, c1, c2)
    dark = detail < -0.9
    col[dark] *= 0.7
    light = detail > 1.1
    col[light] = col[light] * 0.6 + srgb('#b9f08a') * 0.4
    return col


def tex_noise(c1, c2, seed, scale=16):
    return ramp(fbm(seed, scale), c1, c2)


def tex_straw(c1, c2, seed):
    """Basket-weave straw: diagonal fibres that switch direction every block."""
    y, x = np.mgrid[0:N, 0:N]
    a = np.sin((x + y) / N * 2 * np.pi * 28)
    b = np.sin((x - y) / N * 2 * np.pi * 28)
    weave = np.where(((x // 16 + y // 16) % 2) == 0, a, b)
    col = ramp(weave * 0.45 + fbm(seed, 8) * 0.5, c1, c2)
    return col * (0.8 + 0.2 * np.abs(weave))[..., None]


def tex_cloth(c1, c2, seed):
    y, x = np.mgrid[0:N, 0:N]
    weave = np.sin(x * np.pi / 2) * np.sin(y * np.pi / 2) * 0.25
    return ramp(fbm(seed, 28) * 0.5 + weave, c1, c2, -1.2, 1.2)


def tex_rock(c1, c2, seed):
    col = ramp(fbm(seed, 22), c1, c2)
    cracks = np.abs(fbm(seed + 5, 14)) < 0.05
    col[cracks] *= 0.68
    lichen = fbm(seed + 9, 6) > 1.15
    col[lichen] = col[lichen] * 0.5 + srgb('#b9b78a') * 0.5
    return col


def tex_wood(c1, c2, seed):
    y, x = np.mgrid[0:N, 0:N]
    grain = fbm(seed, 30, aniso=0.12)
    return ramp(grain + 0.35 * np.sin(y / N * 2 * np.pi * 10 + grain * 2), c1, c2)


def tex_bark(seed):
    y, x = np.mgrid[0:N, 0:N]
    rings = (np.sin(y / N * 2 * np.pi * 6) + 1) / 2
    col = ramp(fbm(seed, 12) * 0.6 + rings * 1.2 - 0.6, '#7a4a25', '#c48a52')
    col[(y % (N // 6)) < 5] *= 0.7
    return col


def save_tex(name, rgb):
    path = os.path.join(OUT, 'tex', f'{name}.png')
    img = bpy.data.images.new(name, N, N, alpha=False)
    rgba = np.concatenate([np.clip(rgb, 0, 1), np.ones((N, N, 1))], -1).astype(np.float32)
    img.pixels = np.ascontiguousarray(rgba[::-1]).ravel()
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)
    return path


TEX_CACHE = {}


def texture_for(name, spec):
    """Generate (once) an image texture equivalent to a procedural noise material."""
    if name in TEX_CACHE:
        return TEX_CACHE[name]
    seed = sum(ord(ch) * (i + 1) for i, ch in enumerate(name)) % 10000  # stable across runs
    kind = spec.get('kind')
    if kind == 'straw':
        rgb = tex_straw(spec['c1'], spec['c2'], seed)
    elif kind == 'cloth':
        rgb = tex_cloth(spec['c1'], spec['c2'], seed)
    elif kind == 'rock':
        rgb = tex_rock(spec['c1'], spec['c2'], seed)
    elif kind == 'wood':
        rgb = tex_wood(spec['c1'], spec['c2'], seed)
    elif kind == 'planks' or name.startswith('plank'):
        rgb = tex_planks(spec['c1'], spec['c2'], seed)
    elif spec.get('brick'):
        rgb = tex_brick(spec['c1'], spec['c2'], seed)
    elif name.startswith('leaf'):
        rgb = tex_leaves(spec['c1'], spec['c2'], seed)
    elif name == 'bark':
        rgb = tex_bark(seed)
    else:
        rgb = tex_noise(spec['c1'], spec['c2'], seed)
    TEX_CACHE[name] = save_tex(name, rgb)
    return TEX_CACHE[name]


def textured_mat(name, spec):
    m = bpy.data.materials.get('tx_' + name)
    if m:
        return m
    m = bpy.data.materials.new('tx_' + name)
    nt = m.node_tree
    p = nt.nodes['Principled BSDF']
    p.inputs['Roughness'].default_value = spec.get('rough', 0.7)
    p.inputs['Specular IOR Level'].default_value = 0.2
    t = nt.nodes.new('ShaderNodeTexImage')
    t.image = bpy.data.images.load(texture_for(name, spec), check_existing=True)
    nt.links.new(t.outputs['Color'], p.inputs['Base Color'])
    return m


def box_uv(o, scale=1.0):
    """World-scale box mapping so textures keep the same size on every face."""
    me = o.data
    if not me.uv_layers:
        me.uv_layers.new()
    uv = me.uv_layers.active.data
    mw = o.matrix_world
    for poly in me.polygons:
        n = (mw.to_3x3() @ poly.normal)
        ax = max(range(3), key=lambda i: abs(n[i]))
        for li in poly.loop_indices:
            co = mw @ me.vertices[me.loops[li].vertex_index].co
            u, v = [(co.y, co.z), (co.x, co.z), (co.x, co.y)][ax]
            uv[li].uv = (u * scale + 0.5, v * scale + 0.5)


def convert_materials(objs):
    for o in objs:
        if o.type != 'MESH':
            continue
        textured = False
        for slot in o.material_slots:
            m = slot.material
            if m and m.name in L['NOISE_SPECS']:
                slot.material = textured_mat(m.name, L['NOISE_SPECS'][m.name])
                textured = True
        if textured:
            box_uv(o)


# ---------------------------------------------------------------- export helpers


def select_only(objs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]


def export(root, name, join=True):
    bpy.context.view_layer.update()
    objs = [root] + list(root.children_recursive)
    convert_materials(objs)
    if join:
        meshes = [o for o in objs if o.type == 'MESH']
        empties = [o.name for o in objs if o.type == 'EMPTY']
        select_only(meshes)
        bpy.ops.object.convert(target='MESH')
        bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
        bpy.ops.object.join()
        joined = bpy.context.view_layer.objects.active
        joined.name = name
        for nm in empties:
            if nm in bpy.data.objects:
                bpy.data.objects.remove(bpy.data.objects[nm], do_unlink=True)
        objs = [joined]
    select_only(objs)
    path = os.path.join(OUT, f'{name}.glb')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True,
                              export_yup=True, export_animations=False, export_cameras=False, export_lights=False)
    print('exported', path, os.path.getsize(path) // 1024, 'KB')


# ---------------------------------------------------------------- new scenery models


def build_palm(v):
    root = empty('palm')
    rng = random.Random(v + 5)
    bark = noise_mat('bark', '#6f4f33', '#a7845c', 4)
    height = 2.6 + v * 0.5
    lean = rng.uniform(0.25, 0.4) * (1 if v % 2 else -1)
    segs = 9
    pts = []
    for i in range(segs + 1):
        t = i / segs
        pts.append((lean * t * t * 1.6, 0, t * height))
    for i in range(segs):
        r = 0.16 - 0.06 * i / segs
        limb(f'trunk{i}', pts[i], pts[i + 1], r, bark, root, outline=0.014)
        prim('torus', 'ring', pts[i + 1], (r * 1.05, r * 1.05, 0.25), bark, root, minor=0.18, outline=0)
    top = pts[-1]
    leaf = mat('palmleaf', '#62873a', rough=0.65)
    leaf.use_backface_culling = False
    for k in range(9):
        a = k / 9 * 2 * math.pi + rng.uniform(-0.15, 0.15)
        frond(f'frond{k}', top, a, rng.uniform(1.3, 1.6), rng.uniform(0.6, 0.95), leaf, root)
    for k in range(3):
        a = k / 3 * 2 * math.pi
        prim('sphere', 'coconut', (top[0] + math.cos(a) * 0.13, math.sin(a) * 0.13, top[2] - 0.12), (0.09, 0.09, 0.1),
             mat('coconut', '#5a3a1e', rough=0.5), root, seg=16, rings=8)
    return root


def frond(name, base, ang, length, droop, m, parent, steps=14):
    """A feathered palm frond: a drooping, V-folded strip whose edge zig-zags into leaflets."""
    bm = bmesh.new()
    ca, sa = math.cos(ang), math.sin(ang)
    rows = []
    for i in range(steps + 1):
        t = i / steps
        along = length * t
        z = 0.12 * math.sin(t * math.pi * 0.6) - droop * t * t
        width = 0.34 * math.sin(math.pi * min(1, t * 1.1)) ** 0.7 * (1.0 if i % 2 else 0.45)
        cx, cy = base[0] + ca * along, base[1] + sa * along
        px, py = -sa, ca  # perpendicular, in the ground plane
        rows.append([bm.verts.new((cx + px * width, cy + py * width, base[2] + z - 0.06 * width)),
                     bm.verts.new((cx, cy, base[2] + z + 0.03)),
                     bm.verts.new((cx - px * width, cy - py * width, base[2] + z - 0.06 * width))])
    for i in range(steps):
        for j in range(2):
            bm.faces.new((rows[i][j], rows[i][j + 1], rows[i + 1][j + 1], rows[i + 1][j]))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    for poly in me.polygons:
        poly.use_smooth = True
    me.materials.append(m)
    keep_parent(o, parent)
    return o


def build_rock(v):
    root = empty('rock')
    rng = random.Random(v + 20)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3, radius=1)
    o = bpy.context.active_object
    bm = bmesh.new()
    bm.from_mesh(o.data)
    for vert in bm.verts:
        n = vert.co.normalized()
        f = 1 + 0.12 * math.sin(n.x * 5 + v) * math.cos(n.y * 4) + rng.uniform(-0.04, 0.04)
        vert.co *= f
    bm.to_mesh(o.data)
    bm.free()
    o.scale = ([0.55, 0.5, 0.35], [0.4, 0.45, 0.4], [0.7, 0.55, 0.3])[v]
    o.location = (0, 0, 0.05)
    _finish(o, noise_mat('rockstone', '#8f9290', '#c9cbc2', 5, kind='rock'), 0, True)
    keep_parent(o, root)
    if v == 0:
        prim('ico', 'moss', (0.05, 0.05, 0.3), (0.3, 0.28, 0.08), noise_mat('moss', '#4f9a3a', '#7cc455', 9), root, sub=2, outline=0)
    return root


def build_coral(v):
    root = empty('coral')
    rng = random.Random(v + 40)
    cols = [('#ff7aa8', '#ffd25e'), ('#b48cff', '#ff9f5e'), ('#ff9f5e', '#7ee0c3')][v]
    prim('ico', 'base', (0, 0, 0.0), (0.45, 0.42, 0.18), noise_mat('rockstone', '#8f9290', '#c9cbc2', 5, kind='rock'), root, sub=2)
    for i in range(7):
        a = rng.uniform(0, 2 * math.pi)
        r = rng.uniform(0.05, 0.3)
        base = (math.cos(a) * r, math.sin(a) * r, 0.1)
        h = rng.uniform(0.25, 0.5)
        tip = (base[0] + rng.uniform(-0.1, 0.1), base[1] + rng.uniform(-0.1, 0.1), base[2] + h)
        c = cols[i % 2]
        limb(f'branch{i}', base, tip, 0.045, mat('coral' + c, c, rough=0.5), root, outline=0.008)
        prim('sphere', 'tip', tip, (0.065, 0.065, 0.065), mat('coral' + c, c, rough=0.5), root, outline=0.008, seg=12, rings=8)
    prim('sphere', 'fan', (0.2, -0.1, 0.3), (0.28, 0.05, 0.22), mat('coralfan', '#c79bff', rough=0.6), root, rot=(0, 0, 0.6), outline=0.008)
    return root


def build_crab():
    root = empty('crab')
    shell = mat('crabshell', '#c4573a', rough=0.55)
    prim('sphere', 'body', (0, 0, 0.07), (0.13, 0.1, 0.055), shell, root, seg=16, rings=8)
    for sx in (1, -1):
        limb('arm', (0.09 * sx, -0.06, 0.07), (0.15 * sx, -0.14, 0.08), 0.018, shell, root)
        prim('sphere', 'claw', (0.16 * sx, -0.16, 0.085), (0.045, 0.035, 0.03), shell, root, seg=12, rings=6)
        for k in range(3):
            y = 0.03 - k * 0.04
            limb('leg', (0.1 * sx, y, 0.06), (0.19 * sx, y + 0.02, 0.0), 0.012, shell, root)
        prim('sphere', 'eye', (0.035 * sx, -0.09, 0.12), (0.014, 0.014, 0.014), mat('crabeye', '#1b1b1b'), root, seg=8, rings=4)
    return root


def build_starfish():
    root = empty('starfish')
    m = mat('starfish', '#ff8a4c', rough=0.6)
    prim('sphere', 'center', (0, 0, 0.03), (0.08, 0.08, 0.035), m, root, outline=0.006)
    for k in range(5):
        a = k / 5 * 2 * math.pi
        limb(f'arm{k}', (0, 0, 0.03), (math.cos(a) * 0.2, math.sin(a) * 0.2, 0.02), 0.04, m, root, outline=0.006)
    return root


# ---------------------------------------------------------------- island colour map + water mask


def albedo_material(mask_a, mask_b):
    """Unlit version of the arena ground: grass, sandy paths, cobbled plaza, beach and wet seabed."""
    m = bpy.data.materials.new('GroundAlbedo')
    nt = m.node_tree
    nodes, links = nt.nodes, nt.links
    for n in list(nodes):
        nodes.remove(n)
    out = nodes.new('ShaderNodeOutputMaterial')
    emit = nodes.new('ShaderNodeEmission')
    links.new(emit.outputs[0], out.inputs['Surface'])
    co = nodes.new('ShaderNodeTexCoord')

    def sep(img):
        t = nodes.new('ShaderNodeTexImage')
        t.image = img
        t.extension = 'EXTEND'
        links.new(co.outputs['UV'], t.inputs['Vector'])
        s = nodes.new('ShaderNodeSeparateColor')
        links.new(t.outputs['Color'], s.inputs['Color'])
        return s

    A, B = sep(mask_a), sep(mask_b)

    def noise(scale, detail=3):
        n = nodes.new('ShaderNodeTexNoise')
        n.inputs['Scale'].default_value = scale
        n.inputs['Detail'].default_value = detail
        links.new(co.outputs['Object'], n.inputs['Vector'])
        return n.outputs['Fac']

    def cramp(fac, stops):
        r = nodes.new('ShaderNodeValToRGB')
        els = r.color_ramp.elements
        els[0].position, els[0].color = stops[0][0], (*hex_lin(stops[0][1]), 1)
        els[1].position, els[1].color = stops[-1][0], (*hex_lin(stops[-1][1]), 1)
        for pos, c in stops[1:-1]:
            els.new(pos).color = (*hex_lin(c), 1)
        links.new(fac, r.inputs['Fac'])
        return r.outputs['Color']

    def mix(a, b, fac):
        mx = nodes.new('ShaderNodeMix')
        mx.data_type = 'RGBA'
        if isinstance(fac, float):
            mx.inputs['Factor'].default_value = fac
        else:
            links.new(fac, mx.inputs['Factor'])
        links.new(a, mx.inputs[6])
        links.new(b, mx.inputs[7])
        return mx.outputs[2]

    grass = cramp(noise(0.9, 4), [(0.3, '#6a8a40'), (0.55, '#7b9a4c'), (0.78, '#97ad62')])
    grass = mix(grass, cramp(noise(7, 2), [(0.45, '#5d7d39'), (0.6, '#8aa35a')]), 0.25)
    # Wind-blown ripples for every sandy surface.
    wave = nodes.new('ShaderNodeTexWave')
    wave.inputs['Scale'].default_value = 0.9
    wave.inputs['Distortion'].default_value = 7.0
    wave.inputs['Detail'].default_value = 2.0
    wave.inputs['Detail Scale'].default_value = 1.2
    links.new(co.outputs['Object'], wave.inputs['Vector'])
    ripple = cramp(wave.outputs['Fac'], [(0.2, '#c9b38a'), (0.55, '#ffffff')])

    def rippled(col):
        mx = nodes.new('ShaderNodeMix')
        mx.data_type = 'RGBA'
        mx.blend_type = 'MULTIPLY'
        mx.inputs['Factor'].default_value = 0.6
        links.new(col, mx.inputs[6])
        links.new(ripple, mx.inputs[7])
        return mx.outputs[2]

    sand = rippled(cramp(noise(3, 3), [(0.35, '#cdb68a'), (0.7, '#ddc9a0')]))
    vor = nodes.new('ShaderNodeTexVoronoi')
    vor.feature = 'DISTANCE_TO_EDGE'
    vor.inputs['Scale'].default_value = 2.4
    links.new(co.outputs['Object'], vor.inputs['Vector'])
    cobble = cramp(vor.outputs['Distance'], [(0.0, '#6c655b'), (0.07, '#a29a89'), (0.3, '#bdb3a0')])
    beach = rippled(cramp(noise(2.5, 3), [(0.35, '#dfcaa0'), (0.7, '#ecdcb8')]))
    seabed = rippled(cramp(B.outputs['Green'], [(0.0, '#d4bf93'), (0.35, '#b2b590'), (1.0, '#4d8a84')]))
    arena = mix(mix(grass, sand, A.outputs['Red']), cobble, A.outputs['Green'])
    land = mix(beach, arena, A.outputs['Blue'])
    links.new(mix(seabed, land, B.outputs['Red']), emit.inputs['Color'])
    return m


def bake_ground(manifest):
    reset_scene(transparent=False, samples=8)
    sc = bpy.context.scene
    for o in list(sc.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    sc.world.node_tree.nodes['Background'].inputs[1].default_value = 0
    rows = L['game_map']()
    n, margin, ppb = len(rows), 3, 48
    size = n + 2 * margin
    mask_a, mask_b, _ = L['ground_masks'](n, margin, 24, rows)
    gm = albedo_material(L['mask_image']('maskA', mask_a), L['mask_image']('maskB', mask_b))
    bpy.ops.mesh.primitive_plane_add(size=size, location=(n / 2, -n / 2, 0))
    plane = bpy.context.active_object
    plane.data.materials.append(gm)
    cam_data = bpy.data.cameras.new('Top')
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = size
    cam = bpy.data.objects.new('Top', cam_data)
    sc.collection.objects.link(cam)
    cam.location = (n / 2, -n / 2, 20)
    sc.camera = cam
    res = size * ppb
    sc.render.resolution_x = sc.render.resolution_y = res
    arr = L['render_to_array'](res, res)
    L['save_array'](arr, os.path.join(OUT, 'ground_albedo.webp'), quality=90)
    # Water mask: R = land, G = distance from shore (0..1), B = surf foam.
    L['save_array'](np.ascontiguousarray(mask_b), os.path.join(OUT, 'ground_mask.png'), fmt='PNG')
    manifest['ground'] = {'albedo': 'ground_albedo.webp', 'mask': 'ground_mask.png', 'min': -margin, 'size': size}


# ---------------------------------------------------------------- main


def run(manifest):
    jobs = []
    for cid in ('brick', 'vex', 'boom', 'melo', 'kit', 'tink'):
        jobs.append((cid, lambda cid=cid: L['CHARACTERS'][cid](), False, 'characters'))
    for v in range(3):
        jobs.append((f'wall{v}', lambda v=v: L['build_wall'](v, stretch=False), True, 'props'))
        jobs.append((f'bush{v}', lambda v=v: L['build_bush'](v, stretch=False), True, 'props'))
        jobs.append((f'rock{v}', lambda v=v: build_rock(v), True, 'scenery'))
        jobs.append((f'coral{v}', lambda v=v: build_coral(v), True, 'scenery'))
    for v in range(2):
        jobs.append((f'palm{v}', lambda v=v: build_palm(v), True, 'scenery'))
    jobs.append(('crate', lambda: L['build_crate'](stretch=False), True, 'props'))
    jobs.append(('cube', L['build_cube'], True, 'props'))
    jobs.append(('ghost', L['build_ghost'], True, 'props'))
    jobs.append(('turret', L['build_turret'], True, 'props'))
    jobs.append(('gem', L['build_gem'], True, 'props'))
    jobs.append(('drink', L['build_drink'], True, 'props'))
    jobs.append(('starfish', build_starfish, True, 'scenery'))
    jobs.append(('crab', build_crab, True, 'scenery'))
    for name, build, join, group in jobs:
        if ONLY and name not in ONLY and group not in ONLY:
            continue
        reset_scene()
        root = build()
        root = root['root'] if isinstance(root, dict) else root
        export(root, name, join)
        manifest.setdefault(group, [])
        if name not in manifest[group]:
            manifest[group].append(name)
    if not ONLY or 'ground' in ONLY:
        bake_ground(manifest)


manifest_path = os.path.join(OUT, 'manifest.json')
manifest = json.load(open(manifest_path)) if os.path.exists(manifest_path) else {}
run(manifest)
json.dump(manifest, open(manifest_path, 'w'), indent=2)
print('MANIFEST', json.dumps(manifest))
