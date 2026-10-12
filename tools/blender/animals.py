"""
Island wildlife for the real-time renderer: seagull, rabbit, frog, mallard duck, sea turtle and dolphin.
Executed by export_models.py (uses its builders/helpers). Each animal is a hierarchy of named pivots
(wings, ears, legs, head, flippers, tail) that the game animates procedurally; meshes under each pivot are
merged and get ambient occlusion baked into vertex colours so they read as solid, natural forms.
Animals face -Y, like the brawlers.
"""
import bpy
import bmesh
import math
import os
from mathutils import Vector

# Pivots the game drives, per animal.
PIVOTS = {
    'seagull': ['wingL', 'wingR', 'legs', 'head'],
    'rabbit': ['earL', 'earR', 'legsB', 'head'],
    'frog': ['legsB', 'throat'],
    'duck': ['head', 'tail'],
    'turtle': ['head', 'flipFL', 'flipFR', 'flipBL', 'flipBR'],
    'dolphin': ['tail'],
}


def flat_shape(name, pts, thick, m, parent=None, z=0.0):
    """Extrude a planform (list of (x, y)) by `thick` along Z: wings, fins, flukes, ears."""
    bm = bmesh.new()
    face = bm.faces.new([bm.verts.new((x, y, z - thick / 2)) for x, y in pts])
    ext = bmesh.ops.extrude_face_region(bm, geom=[face])
    for v in [g for g in ext['geom'] if isinstance(g, bmesh.types.BMVert)]:
        v.co.z += thick
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    _finish(o, m, 0.0, False, bevel=min(0.01, thick * 0.45))
    if parent:
        keep_parent(o, parent)
    return o


def eye(loc, r, parent, iris='#1b1410'):
    prim('sphere', 'eye', loc, (r, r, r), mat('eyewet_' + iris, iris, rough=0.08, spec=0.9), parent, seg=12, rings=8, outline=0)
    prim('sphere', 'glint', (loc[0], loc[1] - r * 0.6, loc[2] + r * 0.45), (r * 0.25,) * 3, mat('glint', '#ffffff', emit=1.5), parent, seg=8, rings=4, outline=0)


def build_seagull():
    root = empty('seagull')
    white = mat('gullwhite', '#f2f0ea', rough=0.55)
    grey = noise_mat('gullgrey', '#8e979e', '#a9b1b6', 18, kind='cloth')
    black = mat('gulltip', '#22201f', rough=0.6)
    yellow = mat('gullbeak', '#e8b23a', rough=0.4)
    body = empty('body', (0, 0, 0), root)
    prim('sphere', 'torso', (0, 0, 0), (0.1, 0.25, 0.095), white, body)
    prim('sphere', 'mantle', (0, 0.02, 0.035), (0.085, 0.2, 0.06), grey, body)
    head = empty('head', (0, -0.22, 0.05), body)
    prim('sphere', 'skull', (0, -0.25, 0.07), (0.068, 0.08, 0.065), white, head)
    bpy.ops.mesh.primitive_cone_add(vertices=12, radius1=0.022, radius2=0.004, depth=0.09, location=(0, -0.355, 0.06), rotation=(math.pi / 2, 0, 0))
    b = bpy.context.active_object; _finish(b, yellow, 0, True); keep_parent(b, head)
    prim('sphere', 'beakspot', (0, -0.37, 0.05), (0.008, 0.008, 0.008), mat('gullspot', '#c8402e'), head, seg=8, rings=4, outline=0)
    for sx in (1, -1):
        eye((0.042 * sx, -0.29, 0.09), 0.011, head, '#f0d060')
    flat_shape('tail', [(-0.06, 0.2), (0.06, 0.2), (0.07, 0.34), (0.0, 0.36), (-0.07, 0.34)], 0.018, white, body, z=0.0)
    flat_shape('tailtip', [(-0.07, 0.33), (0.07, 0.33), (0.065, 0.36), (0.0, 0.375), (-0.065, 0.36)], 0.02, black, body, z=0.0)
    for side, sx in (('L', 1), ('R', -1)):
        w = empty(f'wing{side}', (0.08 * sx, -0.03, 0.04), body)
        # Planform: broad inner arm, swept outer hand.
        pts = [(0.0, -0.09), (0.25, -0.1), (0.48, -0.04), (0.6, 0.05), (0.42, 0.06), (0.22, 0.1), (0.0, 0.11)]
        flat_shape(f'wing{side}m', [(0.08 * sx + x * sx, -0.03 + y) for x, y in pts], 0.022, grey, w, z=0.045)
        flat_shape(f'wing{side}tip', [(0.08 * sx + x * sx, -0.03 + y) for x, y in [(0.44, -0.05), (0.62, 0.05), (0.5, 0.065), (0.42, 0.06)]], 0.024, black, w, z=0.046)
        flat_shape(f'wing{side}edge', [(0.08 * sx + x * sx, -0.03 + y) for x, y in [(0.0, 0.1), (0.22, 0.09), (0.42, 0.055), (0.4, 0.075), (0.2, 0.115), (0.0, 0.125)]], 0.016, white, w, z=0.043)
    legs = empty('legs', (0, 0.05, -0.08), body)
    for sx in (1, -1):
        limb('leg', (0.03 * sx, 0.05, -0.07), (0.03 * sx, 0.04, -0.2), 0.008, mat('gullleg', '#d9a05c'), legs)
        flat_shape('foot', [(0.03 * sx - 0.025, -0.0), (0.03 * sx + 0.025, -0.0), (0.03 * sx, 0.06)], 0.008, mat('gullleg', '#d9a05c'), legs, z=-0.2)
    return root


def build_rabbit():
    root = empty('rabbit')
    fur = noise_mat('rabbitfur', '#8a7058', '#b49a7c', 26, kind='cloth')
    belly = noise_mat('rabbitbelly', '#d8cbb4', '#ece3d2', 26, kind='cloth')
    pink = mat('rabbitpink', '#e2a3a0', rough=0.6)
    prim('sphere', 'torso', (0, 0.04, 0.13), (0.11, 0.17, 0.11), fur, root)
    prim('sphere', 'chest', (0, -0.07, 0.12), (0.085, 0.07, 0.09), belly, root)
    for sx in (1, -1):
        prim('sphere', 'haunch', (0.075 * sx, 0.1, 0.1), (0.055, 0.09, 0.075), fur, root)
    head = empty('head', (0, -0.12, 0.2), root)
    prim('sphere', 'skull', (0, -0.15, 0.22), (0.07, 0.085, 0.068), fur, head)
    prim('sphere', 'muzzle', (0, -0.225, 0.2), (0.042, 0.035, 0.035), belly, head)
    prim('sphere', 'nose', (0, -0.258, 0.212), (0.012, 0.01, 0.009), pink, head, seg=8, rings=4, outline=0)
    for sx in (1, -1):
        eye((0.048 * sx, -0.19, 0.24), 0.017, head, '#2a1a12')
        e = empty(f'ear{"L" if sx > 0 else "R"}', (0.03 * sx, -0.13, 0.27), head)
        prim('sphere', 'ear', (0.035 * sx, -0.12, 0.36), (0.026, 0.014, 0.095), fur, e, rot=(0.25, 0.18 * sx, 0))
        prim('sphere', 'earin', (0.035 * sx, -0.132, 0.36), (0.016, 0.006, 0.075), pink, e, rot=(0.25, 0.18 * sx, 0), outline=0)
    prim('sphere', 'tail', (0, 0.21, 0.16), (0.04, 0.04, 0.04), mat('rabbittail', '#f4efe6', rough=0.9), root)
    for sx in (1, -1):
        limb('frontleg', (0.035 * sx, -0.08, 0.08), (0.035 * sx, -0.1, 0.01), 0.018, fur, root)
    legs = empty('legsB', (0, 0.09, 0.06), root)
    for sx in (1, -1):
        prim('sphere', 'hindfoot', (0.07 * sx, 0.06, 0.015), (0.028, 0.075, 0.018), fur, legs)
    return root


def build_frog():
    root = empty('frog')
    skin = noise_mat('frogskin', '#4f7a2e', '#7aa645', 30, kind='cloth')
    belly = mat('frogbelly', '#d9d79a', rough=0.5)
    prim('sphere', 'torso', (0, 0.01, 0.055), (0.075, 0.095, 0.05), skin, root)
    prim('sphere', 'belly', (0, 0.0, 0.035), (0.068, 0.085, 0.035), belly, root)
    prim('sphere', 'head', (0, -0.07, 0.07), (0.07, 0.055, 0.04), skin, root)
    for sx in (1, -1):
        prim('sphere', 'eyebump', (0.04 * sx, -0.075, 0.1), (0.026, 0.026, 0.024), skin, root)
        eye((0.045 * sx, -0.088, 0.108), 0.017, root, '#c9a227')
        limb('arm', (0.05 * sx, -0.05, 0.04), (0.07 * sx, -0.09, 0.0), 0.011, skin, root)
    throat = empty('throat', (0, -0.08, 0.035), root)
    prim('sphere', 'sac', (0, -0.085, 0.03), (0.04, 0.03, 0.022), belly, throat)
    legs = empty('legsB', (0, 0.06, 0.04), root)
    for sx in (1, -1):
        prim('sphere', 'thigh', (0.065 * sx, 0.05, 0.04), (0.03, 0.055, 0.03), skin, legs, rot=(0, 0, 0.5 * sx))
        prim('sphere', 'shank', (0.085 * sx, 0.02, 0.015), (0.022, 0.06, 0.018), skin, legs, rot=(0, 0, -0.4 * sx))
        flat_shape('webfoot', [(0.08 * sx, -0.03), (0.12 * sx, -0.05), (0.11 * sx, 0.0)], 0.008, skin, legs, z=0.006)
    return root


def build_duck():
    root = empty('duck')
    body = noise_mat('duckbody', '#8d8f8a', '#b3b3ab', 22, kind='cloth')
    chest = mat('duckchest', '#6e3f2a', rough=0.6)
    green = mat('duckhead', '#1f5a34', rough=0.25, spec=0.8, metal=0.2)
    prim('sphere', 'torso', (0, 0.02, 0.08), (0.1, 0.17, 0.08), body, root)
    prim('sphere', 'breast', (0, -0.1, 0.09), (0.08, 0.07, 0.07), chest, root)
    for sx in (1, -1):
        prim('sphere', 'wing', (0.07 * sx, 0.04, 0.11), (0.04, 0.12, 0.045), noise_mat('duckwing', '#6f6a62', '#8a857b', 22, kind='cloth'), root)
        prim('sphere', 'speculum', (0.085 * sx, 0.08, 0.115), (0.02, 0.035, 0.02), mat('duckblue', '#2e4fa8', rough=0.3, spec=0.8), root, outline=0)
    tail = empty('tail', (0, 0.17, 0.1), root)
    bpy.ops.mesh.primitive_cone_add(vertices=10, radius1=0.05, radius2=0.0, depth=0.1, location=(0, 0.2, 0.11), rotation=(-math.pi / 2 + 0.3, 0, 0))
    t = bpy.context.active_object; _finish(t, mat('ducktail', '#2a2a2a'), 0, True); keep_parent(t, tail)
    head = empty('head', (0, -0.13, 0.12), root)
    limb('neck', (0, -0.12, 0.12), (0, -0.16, 0.21), 0.03, green, head)
    prim('torus', 'collar', (0, -0.13, 0.145), (0.034, 0.034, 0.034), mat('duckcollar', '#f2f0ea'), head, minor=0.2)
    prim('sphere', 'skull', (0, -0.17, 0.235), (0.045, 0.055, 0.045), green, head)
    flat_shape('bill', [(-0.022, -0.21), (0.022, -0.21), (0.026, -0.27), (0.0, -0.29), (-0.026, -0.27)], 0.016, mat('duckbill', '#d8b13a', rough=0.5), head, z=0.225)
    for sx in (1, -1):
        eye((0.036 * sx, -0.19, 0.245), 0.009, head, '#1a1210')
    return root


def build_turtle():
    root = empty('turtle')
    shell = noise_mat('turtleshell', '#4e5a2c', '#7b6a3a', 9, kind='rock')
    skin = noise_mat('turtleskin', '#7d8a63', '#9aa57d', 24, kind='cloth')
    # Shell dome with scute rings.
    dome('carapace', (0, 0, 0.05), (0.2, 0.25, 0.12), shell, root, cut=0.0)
    prim('cyl', 'plastron', (0, 0, 0.045), (0.19, 0.24, 0.02), mat('plastron', '#c9b98a', rough=0.7), root, seg=24)
    for k in range(6):
        a = k * math.pi / 3
        prim('sphere', 'scute', (math.cos(a) * 0.1, math.sin(a) * 0.13, 0.135), (0.05, 0.06, 0.02), noise_mat('scute', '#5c5a2e', '#8a7a46', 9, kind='rock'), root)
    prim('sphere', 'scutetop', (0, 0, 0.165), (0.06, 0.07, 0.02), noise_mat('scute', '#5c5a2e', '#8a7a46', 9, kind='rock'), root)
    head = empty('head', (0, -0.22, 0.07), root)
    limb('neck', (0, -0.2, 0.07), (0, -0.27, 0.08), 0.035, skin, head)
    prim('sphere', 'skull', (0, -0.3, 0.085), (0.045, 0.06, 0.04), skin, head)
    for sx in (1, -1):
        eye((0.03 * sx, -0.33, 0.1), 0.009, head, '#1a1410')
    for nm, x, y, s in (('flipFL', 0.17, -0.12, 1.0), ('flipFR', -0.17, -0.12, 1.0), ('flipBL', 0.14, 0.17, 0.7), ('flipBR', -0.14, 0.17, 0.7)):
        p = empty(nm, (x * 0.8, y, 0.05), root)
        sx = 1 if x > 0 else -1
        flat_shape('flipper', [(x * 0.8, y - 0.03 * s), (x + sx * 0.12 * s, y - 0.06 * s), (x + sx * 0.14 * s, y + 0.0), (x * 0.8, y + 0.04 * s)], 0.022, skin, p, z=0.04)
    return root


def build_dolphin():
    root = empty('dolphin')
    back = mat('dolphinback', '#5d7a8c', rough=0.25, spec=0.6)
    belly = mat('dolphinbelly', '#d9e2e6', rough=0.3, spec=0.5)
    prim('sphere', 'body', (0, 0, 0), (0.17, 0.72, 0.17), back, root)
    prim('sphere', 'bellyside', (0, -0.05, -0.04), (0.155, 0.62, 0.135), belly, root)
    prim('sphere', 'melon', (0, -0.62, 0.02), (0.12, 0.16, 0.11), back, root)
    bpy.ops.mesh.primitive_cone_add(vertices=14, radius1=0.05, radius2=0.025, depth=0.16, location=(0, -0.8, -0.02), rotation=(math.pi / 2, 0, 0))
    r = bpy.context.active_object; _finish(r, back, 0, True); keep_parent(r, root)
    for sx in (1, -1):
        eye((0.085 * sx, -0.62, 0.02), 0.014, root, '#141414')
        flat_shape('pectoral', [(0.1 * sx, -0.28), (0.3 * sx, -0.12), (0.27 * sx, -0.05), (0.1 * sx, -0.16)], 0.022, back, root, z=-0.08)
    # Dorsal fin: a swept triangle standing up.
    bm = bmesh.new()
    pts = [(-0.0, 0.0, 0.14), (0.0, 0.18, 0.14), (0.0, 0.2, 0.36), (0.0, 0.1, 0.3)]
    face = bm.faces.new([bm.verts.new(p) for p in pts])
    ext = bmesh.ops.extrude_face_region(bm, geom=[face])
    for v in [g for g in ext['geom'] if isinstance(g, bmesh.types.BMVert)]:
        v.co.x += 0.025
    bmesh.ops.translate(bm, verts=bm.verts, vec=(-0.0125, 0, 0))
    me = bpy.data.meshes.new('dorsal'); bm.to_mesh(me); bm.free()
    d = bpy.data.objects.new('dorsal', me); bpy.context.scene.collection.objects.link(d)
    _finish(d, back, 0, False, bevel=0.01); keep_parent(d, root)
    tail = empty('tail', (0, 0.6, 0.0), root)
    prim('sphere', 'peduncle', (0, 0.72, 0.0), (0.07, 0.18, 0.06), back, tail)
    flat_shape('fluke', [(0, 0.82), (0.24, 0.92), (0.22, 0.98), (0, 0.9), (-0.22, 0.98), (-0.24, 0.92)], 0.025, back, tail, z=0.0)
    return root


ANIMALS = {'seagull': build_seagull, 'rabbit': build_rabbit, 'frog': build_frog, 'duck': build_duck, 'turtle': build_turtle, 'dolphin': build_dolphin}


def export_animal(name, out_dir):
    reset_scene()
    root = ANIMALS[name]()
    objs = [o for o in root.children_recursive if o.type == 'MESH']
    convert_materials([root] + list(root.children_recursive))
    pivots = set(PIVOTS.get(name, []))
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.convert(target='MESH')  # bake modifiers
    # Merge the meshes under each pivot (and the rest under the root) so each moving part is one object.
    groups = {}
    for o in objs:
        p = o.parent
        while p and p is not root and p.name.split('.')[0] not in pivots:
            p = p.parent
        groups.setdefault(p or root, []).append(o)
    joined = []
    for pivot, members in groups.items():
        bpy.ops.object.select_all(action='DESELECT')
        for o in members:
            o.select_set(True)
        bpy.context.view_layer.objects.active = members[0]
        bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
        if len(members) > 1:
            bpy.ops.object.join()
        j = bpy.context.view_layer.objects.active
        j.name = f'{pivot.name}_mesh'
        keep_parent(j, pivot)
        joined.append(j)
    # Ambient occlusion into vertex colours (all parts at once so they shadow each other).
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = 48
    for j in joined:
        a = j.data.color_attributes.new('AO', 'BYTE_COLOR', 'POINT')
        j.data.color_attributes.active_color = a
    bpy.ops.object.select_all(action='DESELECT')
    for j in joined:
        j.select_set(True)
    bpy.context.view_layer.objects.active = joined[0]
    sc.render.bake.target = 'VERTEX_COLORS'
    bpy.ops.object.bake(type='AO')
    for j in joined:
        for c in j.data.color_attributes['AO'].data:
            v = 0.5 + 0.5 * min(1.0, c.color[0] * 1.15)
            c.color = (v, v, v, 1.0)
    bpy.ops.object.select_all(action='DESELECT')
    for o in [root] + list(root.children_recursive):
        o.select_set(True)
    path = os.path.join(out_dir, f'{name}.glb')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
                              export_animations=False, export_vertex_color='ACTIVE', export_cameras=False, export_lights=False)
    print('exported animal', path, os.path.getsize(path) // 1024, 'KB')
