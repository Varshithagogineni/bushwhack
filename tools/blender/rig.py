"""
Skeletons, skin weights, animation clips and baked ambient occlusion for the brawlers.
Executed by export_models.py (needs its builders and helpers in the namespace).

Every brawler gets the same bone names, so the game drives them all the same way:
  root > hips > spine > chest > head > hat|hood ; thigh_L/R > shin_L/R ; upperarm_L/R > forearm_L/R ;
  scarf1 > scarf2 ; cape
Clips: idle, run (loops), attack, hit (one-shots that start at the rest pose, played additively), victory.
"""
import bpy
import math
from mathutils import Vector, Quaternion

FPS = 30

# What each brawler holds in which hand (everything else on the upper body follows the chest).
HELD = {
    'kit': {'kamaL': 'forearm_L', 'bladeL': 'forearm_L', 'kamaR': 'forearm_R', 'bladeR': 'forearm_R'},
    'tink': {'wrench': 'forearm_R', 'wrenchhead': 'forearm_R', 'wrenchjaw': 'forearm_R', 'orb': 'forearm_L'},
    'boom': {'bomb': 'forearm_R', 'neck': 'forearm_R', 'cork': 'forearm_R', 'fuse': 'forearm_R', 'spark': 'forearm_R'},
}
# Arms that swing while running (two-handed weapons keep both hands on the weapon).
SWING = {'brick': '', 'vex': '', 'melo': '', 'boom': 'L', 'kit': 'LR', 'tink': 'LR'}
ATTACK = {'brick': 'recoil', 'vex': 'recoil', 'melo': 'strum', 'boom': 'throw', 'kit': 'slash', 'tink': 'cast'}

HAT_PARTS = {'hat', 'hatrim', 'hatband', 'hattop', 'goggle', 'lens', 'goggleband'}
HEAD_PARTS = {'head', 'eye', 'mask', 'facewrap', 'hood', 'hoodtrim'}
CHEST_PARTS = {'chest', 'belt', 'knot', 'tassel1', 'tassel2', 'scarf'}


def smooth(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def base(name):
    return name.split('.')[0]


# ---------------------------------------------------------------- skeleton

def build_armature(cid, r, objs):
    hz, hr = r['hz'], r['hr']
    names = {base(o.name) for o in objs}
    hb = hz + hr * 0.5
    bones = {
        'root': ((0, 0, 0), (0, 0, 0.12), None),
        'hips': ((0, 0, 0.3), (0, 0, 0.42), 'root'),
        'spine': ((0, 0, 0.42), (0, 0, 0.56), 'hips'),
        'chest': ((0, 0, 0.56), (0, 0, hz - hr * 0.8), 'spine'),
        'head': ((0, 0, hz - hr * 0.8), (0, 0, hz + hr * 0.6), 'chest'),
    }
    if 'hat' in names:
        bones['hat'] = ((0, 0, hb), (0, 0, hb + 0.2), 'head')
    if 'hoodtip' in names:
        bones['hood'] = ((0, 0.14, hz + hr * 0.95), (0, 0.37, hz + hr * 0.52), 'head')
    for side, sx in (('L', 1), ('R', -1)):
        bones[f'thigh_{side}'] = ((0.09 * sx, 0, 0.32), (0.09 * sx, 0, 0.19), 'hips')
        bones[f'shin_{side}'] = ((0.09 * sx, 0, 0.19), (0.09 * sx, -0.02, 0.04), f'thigh_{side}')
    for a in r.get('arms', []):
        side = 'L' if a['shoulder'][0] > 0 else 'R'
        s, h = Vector(a['shoulder']), Vector(a['hand'])
        elbow = s.lerp(h, 0.5) + Vector((0, 0.03, 0))
        bones[f'upperarm_{side}'] = (tuple(s), tuple(elbow), 'chest')
        bones[f'forearm_{side}'] = (tuple(elbow), tuple(h), f'upperarm_{side}')
    tail = next((o for o in objs if base(o.name) == 'scarftail'), None)
    if tail:
        zs = [ (tail.matrix_world @ v.co).z for v in tail.data.vertices ]
        c = tail.matrix_world.translation
        top, bot = max(zs), min(zs)
        mid = (top + bot) / 2
        bones['scarf1'] = ((c.x, c.y, top), (c.x, c.y, mid), 'chest')
        bones['scarf2'] = ((c.x, c.y, mid), (c.x, c.y, bot), 'scarf1')
    if 'cape' in names:
        bones['cape'] = ((0, 0.05, 0.82), (0, 0.14, 0.5), 'chest')

    data = bpy.data.armatures.new(f'{cid}_rig')
    rig = bpy.data.objects.new(f'{cid}_rig', data)
    bpy.context.scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    for name, (h, t, parent) in bones.items():
        eb = data.edit_bones.new(name)
        eb.head, eb.tail = h, t
    for name, (h, t, parent) in bones.items():
        if parent:
            data.edit_bones[name].parent = data.edit_bones[parent]
    bpy.ops.object.mode_set(mode='OBJECT')
    return rig, set(bones)


# ---------------------------------------------------------------- skin weights (objects already in world space)

def weights_for(cid, o, bones):
    """Returns a function vertex_position -> {bone: weight}."""
    n = base(o.name)
    held = HELD.get(cid, {})
    if n in held and held[n] in bones:
        return lambda p: {held[n]: 1.0}
    if n in ('legLm', 'legRm', 'wrap', 'boot'):
        def leg(p):
            side = 'L' if p.x > 0 else 'R'
            w = smooth(0.16, 0.22, p.z)
            return {f'thigh_{side}': w, f'shin_{side}': 1 - w}
        return leg
    if n == 'skirt':
        return lambda p: {'hips': 1 - smooth(0.36, 0.48, p.z), 'spine': smooth(0.36, 0.48, p.z)}
    if n in CHEST_PARTS:
        return lambda p: {'spine': 1 - smooth(0.5, 0.62, p.z), 'chest': smooth(0.5, 0.62, p.z)}
    if n in HEAD_PARTS:
        return lambda p: {'head': 1.0}
    if n in HAT_PARTS or n.startswith('flower'):
        return lambda p: {'hat' if 'hat' in bones else 'head': 1.0}
    if n in ('hoodtip', 'hoodtipend') and 'hood' in bones:
        return lambda p: {'hood': 1.0}
    if n == 'scarftail' and 'scarf1' in bones:
        top = max((o.matrix_world @ v.co).z for v in o.data.vertices)
        bot = min((o.matrix_world @ v.co).z for v in o.data.vertices)
        return lambda p: {'scarf1': 1 - smooth(bot, top, p.z) * 0 - (1 - smooth(bot, top, p.z)) * 0.8, 'scarf2': (1 - smooth(bot, top, p.z)) * 0.8}
    if n == 'cape' and 'cape' in bones:
        return lambda p: {'chest': smooth(0.6, 0.8, p.z), 'cape': 1 - smooth(0.6, 0.8, p.z)}
    if n in ('armL', 'armR', 'armLhand', 'armRhand'):
        side = 'L' if n.startswith('armL') else 'R'
        if f'upperarm_{side}' not in bones:
            return lambda p: {'chest': 1.0}
        if n.endswith('hand'):
            return lambda p: {f'forearm_{side}': 1.0}
        return None  # handled with the arm's own axis in skin()
    return lambda p: {'chest': 1.0}


def skin(cid, r, objs, rig, bones):
    arms = {('L' if a['shoulder'][0] > 0 else 'R'): a for a in r.get('arms', [])}
    for o in objs:
        n = base(o.name)
        fn = weights_for(cid, o, bones)
        if fn is None:  # an arm: split along shoulder -> hand with a soft elbow
            a = arms['L' if n.startswith('armL') else 'R']
            s, h = Vector(a['shoulder']), Vector(a['hand'])
            d = h - s
            side = 'L' if n.startswith('armL') else 'R'
            fn = lambda p, s=s, d=d, side=side: (lambda t: {f'upperarm_{side}': 1 - t, f'forearm_{side}': t})(smooth(0.4, 0.6, (p - s).dot(d) / d.length_squared))
        groups = {}
        for v in o.data.vertices:
            for bone, w in fn(v.co).items():
                if w <= 0.001:
                    continue
                if bone not in groups:
                    groups[bone] = o.vertex_groups.get(bone) or o.vertex_groups.new(name=bone)
                groups[bone].add([v.index], w, 'REPLACE')


# ---------------------------------------------------------------- animation

def keyer(rig):
    """key(bone, frame, rot=[(axis, angle)...] in armature space, loc=(x, y, z) in armature space)."""
    def key(bone, frame, rot=(), loc=None):
        pb = rig.pose.bones.get(bone)
        if pb is None:
            return
        pb.rotation_mode = 'QUATERNION'
        m = pb.bone.matrix_local.to_3x3()
        q = Quaternion()
        for axis, ang in rot:
            q = Quaternion(Vector(axis), ang) @ q
        pb.rotation_quaternion = (m.inverted() @ q.to_matrix() @ m).to_quaternion()
        pb.keyframe_insert('rotation_quaternion', frame=frame)
        if loc is not None:
            pb.location = m.inverted() @ Vector(loc)
            pb.keyframe_insert('location', frame=frame)
    return key


X, Y, Z = (1, 0, 0), (0, 1, 0), (0, 0, 1)


def new_action(rig, name):
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    rig.animation_data_create()
    rig.animation_data.action = act
    for pb in rig.pose.bones:
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.location = (0, 0, 0)
    return act


def make_clips(cid, rig, bones):
    key = keyer(rig)
    swing = SWING.get(cid, '')
    has = lambda b: b in bones

    # Idle: slow breathing, a little sway, the hat settles.
    new_action(rig, 'idle')
    for f, k in ((0, 0), (30, 1), (60, 0)):
        key('hips', f, loc=(0, 0, -0.006 * k))
        key('chest', f, rot=[(X, 0.035 * k)])
        key('head', f, rot=[(Z, 0.06 * (k - 0.5)), (X, -0.025 * k)])
        for s in swing:
            sx = 1 if s == 'L' else -1
            key(f'upperarm_{s}', f, rot=[(Y, sx * 0.05 * k)])
            key(f'forearm_{s}', f, rot=[(X, -0.15 - 0.05 * k)])

    # Run: 12 frames per stride pair (0.4 s at base speed). Contact, passing, contact, passing.
    new_action(rig, 'run')
    poses = [  # (thighL, shinL, thighR, shinR, hip bob, pelvis yaw)
        (-0.65, 0.15, 0.6, 0.75, -0.022, 0.12),
        (-0.05, 0.3, 0.05, 1.15, 0.02, 0.0),
        (0.6, 0.75, -0.65, 0.15, -0.022, -0.12),
        (0.05, 1.15, -0.05, 0.3, 0.02, 0.0),
    ]
    for i, f in enumerate((0, 3, 6, 9, 12)):
        tl, sl, tr, sr, bob, yaw = poses[i % 4]
        key('thigh_L', f, rot=[(X, tl)])
        key('shin_L', f, rot=[(X, sl)])
        key('thigh_R', f, rot=[(X, tr)])
        key('shin_R', f, rot=[(X, sr)])
        key('hips', f, rot=[(Z, yaw)], loc=(0, 0, bob))
        key('spine', f, rot=[(X, 0.08)])
        key('chest', f, rot=[(X, 0.1), (Z, -yaw * 0.9)])
        key('head', f, rot=[(X, -0.12), (Z, yaw * 0.3)])
        if 'L' in swing:
            key('upperarm_L', f, rot=[(X, -tl * 0.9)])
            key('forearm_L', f, rot=[(X, -0.5)])
        if 'R' in swing:
            key('upperarm_R', f, rot=[(X, -tr * 0.9)])
            key('forearm_R', f, rot=[(X, -0.5)])

    # Attack: starts and ends at rest so it can be layered (additively) over running or idling.
    style = ATTACK.get(cid, 'recoil')
    new_action(rig, 'attack')
    rest = lambda f, names: [key(b, f) for b in names]
    if style == 'recoil':
        rest(0, ['chest', 'head', 'spine'])
        # Small and snappy: big tilts read as the hat flipping up under the top-down camera.
        key('chest', 1, rot=[(X, -0.13)])
        key('spine', 1, rot=[(X, -0.05)])
        key('head', 2, rot=[(X, 0.06)])
        key('chest', 5, rot=[(X, 0.03)])
        rest(9, ['chest', 'head', 'spine'])
    elif style == 'throw':
        rest(0, ['chest', 'upperarm_R', 'forearm_R'])
        key('chest', 3, rot=[(Z, 0.35), (X, -0.08)])
        key('upperarm_R', 3, rot=[(X, 0.7)])
        key('forearm_R', 3, rot=[(X, 0.5)])
        key('chest', 6, rot=[(Z, -0.3), (X, 0.12)])
        key('upperarm_R', 6, rot=[(X, -1.1)])
        key('forearm_R', 6, rot=[(X, -0.3)])
        rest(11, ['chest', 'upperarm_R', 'forearm_R'])
    elif style == 'slash':
        rest(0, ['chest', 'upperarm_L', 'upperarm_R', 'forearm_L', 'forearm_R'])
        key('chest', 2, rot=[(Z, 0.45)])
        key('upperarm_L', 2, rot=[(Y, 0.9), (X, -0.6)])
        key('upperarm_R', 2, rot=[(Y, 0.6), (X, 0.4)])
        key('chest', 5, rot=[(Z, -0.5), (X, 0.12)])
        key('upperarm_L', 5, rot=[(Y, -0.6), (X, 0.4)])
        key('upperarm_R', 5, rot=[(Y, -0.9), (X, -0.6)])
        key('forearm_L', 5, rot=[(X, -0.5)])
        key('forearm_R', 5, rot=[(X, -0.5)])
        rest(10, ['chest', 'upperarm_L', 'upperarm_R', 'forearm_L', 'forearm_R'])
    elif style == 'strum':
        rest(0, ['chest', 'forearm_L', 'head'])
        key('forearm_L', 2, rot=[(X, 0.6)])
        key('chest', 2, rot=[(X, -0.12)])
        key('head', 3, rot=[(X, 0.12)])
        key('forearm_L', 5, rot=[(X, -0.35)])
        rest(10, ['chest', 'forearm_L', 'head'])
    elif style == 'cast':
        rest(0, ['chest', 'upperarm_L', 'forearm_L'])
        key('chest', 2, rot=[(Z, -0.25)])
        key('upperarm_L', 2, rot=[(X, 0.5)])
        key('chest', 5, rot=[(Z, 0.3), (X, 0.15)])
        key('upperarm_L', 5, rot=[(X, -1.2)])
        key('forearm_L', 5, rot=[(X, 0.2)])
        rest(10, ['chest', 'upperarm_L', 'forearm_L'])

    # Hit: a flinch backwards.
    new_action(rig, 'hit')
    for b in ('chest', 'head', 'spine', 'hips'):
        key(b, 0, loc=(0, 0, 0) if b == 'hips' else None)
    key('hips', 2, loc=(0, 0.03, -0.012))
    key('spine', 2, rot=[(X, -0.06)])
    key('chest', 2, rot=[(X, -0.1)])
    key('head', 3, rot=[(X, -0.08), (Z, 0.12)])
    for b in ('chest', 'head', 'spine', 'hips'):
        key(b, 9, loc=(0, 0, 0) if b == 'hips' else None)

    # Victory: bounce and celebrate.
    new_action(rig, 'victory')
    for f, up in ((0, 0), (6, 1), (12, 0), (18, 1), (24, 0)):
        key('hips', f, loc=(0, 0, 0.1 * up))
        key('chest', f, rot=[(X, -0.08 * up)])
        key('head', f, rot=[(X, -0.08 * up)])
        key('thigh_L', f, rot=[(X, -0.4 * (1 - up))])
        key('thigh_R', f, rot=[(X, -0.4 * (1 - up))])
        key('shin_L', f, rot=[(X, 0.8 * (1 - up))])
        key('shin_R', f, rot=[(X, 0.8 * (1 - up))])
        for s in swing:
            sx = 1 if s == 'L' else -1
            key(f'upperarm_{s}', f, rot=[(Y, sx * (1.2 + 0.4 * up))])
    rig.animation_data.action = None
    bpy.context.scene.render.fps = FPS


# ---------------------------------------------------------------- ambient occlusion

def bake_ao(body):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = 48
    sc.world.light_settings.distance = 0.25 if hasattr(sc.world, 'light_settings') else 0
    attr = body.data.color_attributes.new('AO', 'BYTE_COLOR', 'POINT')
    body.data.color_attributes.active_color = attr
    bpy.ops.object.select_all(action='DESELECT')
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    sc.render.bake.target = 'VERTEX_COLORS'
    bpy.ops.object.bake(type='AO')
    # Soften: crevices darken to ~45%, open surfaces stay at full brightness.
    for c in attr.data:
        v = c.color[0]
        v = 0.45 + 0.55 * min(1.0, v * 1.15)
        c.color = (v, v, v, 1.0)


# ---------------------------------------------------------------- whole pipeline

def export_rigged(cid, out_dir):
    reset_scene()
    r = CHARACTERS_[cid]()
    root = r['root']
    objs = [o for o in root.children_recursive if o.type == 'MESH']
    convert_materials([root] + list(root.children_recursive))
    # Bake modifiers and transforms so every vertex is in world space.
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.convert(target='MESH')
    bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    rig, bones = build_armature(cid, r, objs)
    skin(cid, r, objs, rig, bones)
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    body = bpy.context.view_layer.objects.active
    body.name = cid
    for nm in [e.name for e in bpy.data.objects if e.type == 'EMPTY']:
        bpy.data.objects.remove(bpy.data.objects[nm], do_unlink=True)
    bake_ao(body)
    body.parent = rig
    mod = body.modifiers.new('Armature', 'ARMATURE')
    mod.object = rig
    make_clips(cid, rig, bones)
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    body.select_set(True)
    bpy.context.view_layer.objects.active = rig
    import os
    path = os.path.join(out_dir, f'{cid}.glb')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=False, export_yup=True,
                              export_animations=True, export_animation_mode='ACTIONS', export_skins=True,
                              export_vertex_color='ACTIVE', export_cameras=False, export_lights=False)
    print('exported rigged', path, os.path.getsize(path) // 1024, 'KB', sorted(bones))
