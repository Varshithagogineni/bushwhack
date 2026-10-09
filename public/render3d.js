// Real-time 3D renderer (Three.js). Same interface as the 2D Renderer it extends, which it reuses for
// the HUD overlay (joysticks, hurt vignette). Models come from tools/blender/export_models.py.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { MAP, TILE, CENTER, BRAWLERS, MAX_AMMO, EMOTES, HAUNT, POISON } from '/shared/game.js';
import { Renderer } from './render.js';

const U = 1 / TILE; // game pixels -> world units (1 unit = 1 tile)
const CHAR_SCALE = 1.25;
const PIVOTS = ['legL', 'legR', 'upper', 'armLpiv'];
const ME = '#3ccf6e';
const FOE = '#ff4d4f';

const rand = (seed) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

export class Renderer3D extends Renderer {
  static supported() {
    try {
      const c = document.createElement('canvas');
      return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
    } catch {
      return false;
    }
  }

  constructor(overlayCanvas) {
    super(overlayCanvas);
    this.is3D = true;
    this.glCanvas = document.createElement('canvas');
    this.glCanvas.className = 'gl';
    overlayCanvas.parentNode.insertBefore(this.glCanvas, overlayCanvas);
    this.gl = new THREE.WebGLRenderer({ canvas: this.glCanvas, antialias: true, powerPreference: 'high-performance' });
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 0.98;
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#1f6d7e');
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.5, 300);
    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.players = new Map();
    this.ghostObjs = new Map();
    this.crateObjs = new Map();
    this.cubeObjs = new Map();
    this.projObjs = new Map();
    this.hauntObjs = new Map();
    this.fx = [];
    this.floaters = [];
    this.camTarget = new THREE.Vector3(CENTER * U, 0, CENTER * U);
    this.uniforms = { time: { value: 0 } };
    this.setupLights();
  }

  resize() {
    super.resize();
    if (!this.gl) return;
    const coarse = matchMedia('(pointer: coarse)').matches;
    this.gl.setPixelRatio(Math.min(devicePixelRatio || 1, coarse ? 1.5 : 2));
    this.gl.setSize(this.w, this.h, false);
    this.camera.aspect = this.w / this.h;
    // Frame roughly the same play area as the 2D view on every screen shape.
    const visibleW = this.w / this.scale * U;
    const hfov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect);
    this.camDist = visibleW / 2 / Math.tan(hfov / 2) * 0.84;
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setPixelRatio(this.gl.getPixelRatio());
      this.composer.setSize(this.w, this.h);
      const px = this.gl.getPixelRatio();
      for (const pass of [this.tiltH, this.tiltV]) {
        pass.uniforms.texel.value.set(1 / (this.w * px), 1 / (this.h * px));
        pass.uniforms.amount.value = 2.6 * Math.min(1, this.h / 850); // gentler on short phone screens
      }
    }
  }

  setupLights() {
    this.scene.add(new THREE.HemisphereLight('#bcd6e3', '#8c7a52', 0.95));
    const sun = new THREE.DirectionalLight('#ffcf8f', 3.0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 15;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 80 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.025;
    this.sun = sun;
    this.sunOffset = new THREE.Vector3(-15, 12, 8); // low golden-hour sun from the front-left: long shadows
    this.scene.add(sun, sun.target);
  }

  // ------------------------------------------------------------ loading

  async load() {
    const manifest = await (await fetch('/models/manifest.json', { cache: 'no-cache' })).json();
    const loader = new GLTFLoader();
    const names = [...manifest.characters, ...manifest.props, ...manifest.scenery];
    const gltfs = await Promise.all(names.map((n) => loader.loadAsync(`/models/${n}.glb`)));
    this.models = Object.fromEntries(names.map((n, i) => [n, gltfs[i].scene]));
    const texLoader = new THREE.TextureLoader();
    const [albedo, mask] = await Promise.all([
      texLoader.loadAsync(`/models/${manifest.ground.albedo}`),
      texLoader.loadAsync(`/models/${manifest.ground.mask}`),
    ]);
    albedo.colorSpace = THREE.SRGBColorSpace;
    albedo.anisotropy = this.gl.capabilities.getMaxAnisotropy();
    this.ground = manifest.ground;
    this.outlineMat = new THREE.MeshBasicMaterial({ color: '#1b1430' });
    for (const scene of Object.values(this.models)) this.fixMaterials(scene);
    for (const id of manifest.characters) this.optimizeCharacter(this.models[id]);
    this.buildGround(albedo);
    this.buildWater(mask);
    this.buildPoison();
    this.buildStatic();
    this.buildDecor(albedo.image);
    this.setupPost();
    this.resize();
    this.ready = true;
  }

  setupPost() {
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.gl, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const tilt = (dir) => new ShaderPass({
      uniforms: { tDiffuse: { value: null }, dir: { value: new THREE.Vector2(...dir) }, texel: { value: new THREE.Vector2() }, amount: { value: 2.6 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform vec2 dir, texel;
        uniform float amount;
        varying vec2 vUv;
        void main() {
          float d = abs(vUv.y - 0.5) * 2.0;
          float r = smoothstep(0.45, 1.0, d) * amount;
          vec4 sum = vec4(0.0);
          float tw = 0.0;
          for (int i = -4; i <= 4; i++) {
            float w = exp(-float(i * i) / 8.0);
            sum += texture2D(tDiffuse, vUv + dir * texel * float(i) * r) * w;
            tw += w;
          }
          gl_FragColor = sum / tw;
        }`,
    });
    this.tiltH = tilt([1, 0]);
    this.tiltV = tilt([0, 1]);
    const grade = new ShaderPass({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
          vec3 col = mix(vec3(l), c.rgb, 0.86) * vec3(1.05, 1.0, 0.93);
          col = col * 0.97 + vec3(0.012, 0.01, 0.006);
          col *= mix(0.74, 1.0, smoothstep(0.95, 0.35, length(vUv - 0.5)));
          gl_FragColor = vec4(col, c.a);
        }`,
    });
    this.composer.addPass(this.tiltH);
    this.composer.addPass(this.tiltV);
    this.composer.addPass(grade);
    this.composer.addPass(new OutputPass());
    this.frameTimes = [];
  }

  // If the device can't hold ~45 fps, drop the post effects and shadow resolution.
  watchPerf(dt) {
    if (!this.frameTimes || this.lowPower) return;
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 150) return;
    const avg = this.frameTimes.slice(30).reduce((a, b) => a + b, 0) / (this.frameTimes.length - 30);
    this.frameTimes = null;
    if (avg > 1 / 45) {
      this.lowPower = true;
      this.composer = null;
      this.sun.shadow.mapSize.set(1024, 1024);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
      this.gl.setPixelRatio(1);
      this.resize();
    }
  }

  fixMaterials(root) {
    root.traverse((o) => {
      if (!o.isMesh) return;
      if (/^Outline/.test(o.material.name)) {
        o.material = this.outlineMat;
        o.castShadow = false;
      } else {
        o.castShadow = true;
        o.receiveShadow = true;
        o.material.metalness = Math.min(o.material.metalness, 0.3);
      }
    });
  }

  // Merge each character into a handful of meshes (one per animated pivot), using vertex colours,
  // so six brawlers cost ~60 draw calls instead of ~500.
  optimizeCharacter(root) {
    root.updateMatrixWorld(true);
    const pivots = new Set();
    root.traverse((o) => { if (PIVOTS.includes(o.name)) pivots.add(o); });
    const groups = new Map();
    const meshes = [];
    root.traverse((o) => { if (o.isMesh) meshes.push(o); });
    for (const m of meshes) {
      let pivot = root;
      for (let p = m.parent; p && p !== root; p = p.parent) if (pivots.has(p)) { pivot = p; break; }
      const mat = m.material;
      const outline = mat === this.outlineMat;
      const glow = !outline && mat.emissive && mat.emissive.getHex() !== 0;
      const map = !outline && !glow ? mat.map : null;
      const kind = outline ? 'o' : glow ? 'g' : map ? `t${map.uuid}` : 'v';
      const key = `${pivot.uuid}|${kind}`;
      const geo = m.geometry.clone();
      geo.applyMatrix4(new THREE.Matrix4().copy(pivot.matrixWorld).invert().multiply(m.matrixWorld));
      const keep = map ? ['position', 'normal', 'uv'] : ['position', 'normal'];
      for (const name of Object.keys(geo.attributes)) if (!keep.includes(name)) geo.deleteAttribute(name);
      const c = glow ? mat.emissive.clone().multiplyScalar(1.6) : mat.color.clone();
      const n = geo.attributes.position.count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      if (!groups.has(key)) groups.set(key, { pivot, kind, map, geos: [] });
      groups.get(key).geos.push(geo.index ? geo : geo.setIndex([...Array(n).keys()]));
      m.removeFromParent();
    }
    for (const { pivot, kind, map, geos } of groups.values()) {
      const material = kind === 'o' ? this.outlineMat
        : kind === 'g' ? new THREE.MeshBasicMaterial({ vertexColors: true })
          : new THREE.MeshStandardMaterial({ vertexColors: true, map, roughness: 0.8 });
      const mesh = new THREE.Mesh(mergeGeometries(geos), material);
      mesh.userData.body = kind !== 'o';
      mesh.castShadow = kind !== 'o' && kind !== 'g';
      pivot.add(mesh);
    }
  }

  // ------------------------------------------------------------ world building

  buildGround(albedo) {
    const g = this.ground;
    const geo = new THREE.PlaneGeometry(g.size, g.size);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: albedo, roughness: 0.95, metalness: 0 }));
    mesh.position.set(g.min + g.size / 2, 0, g.min + g.size / 2);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    // Seabed beyond the baked map
    const bed = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: '#2f6f73', roughness: 1 }));
    bed.position.set(CENTER * U, -0.02, CENTER * U);
    this.scene.add(bed);
  }

  buildWater(mask) {
    mask.colorSpace = THREE.NoColorSpace;
    const g = this.ground;
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        time: this.uniforms.time,
        mask: { value: mask },
        uMin: { value: g.min },
        uSize: { value: g.size },
        shallow: { value: new THREE.Color('#a6e3d2') },
        mid: { value: new THREE.Color('#4cb3a5') },
        deep: { value: new THREE.Color('#1f6d7e') },
      },
      vertexShader: /* glsl */`
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D mask;
        uniform float time, uMin, uSize;
        uniform vec3 shallow, mid, deep;
        varying vec3 vWorld;
        float caustic(vec2 p, float t) {
          vec2 i = p;
          float c = 1.0;
          float inten = 0.005;
          for (int n = 0; n < 4; n++) {
            float tt = t * (1.0 - (3.5 / float(n + 1)));
            i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
            c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
          }
          c /= 4.0;
          c = 1.17 - pow(c, 1.4);
          return pow(abs(c), 8.0);
        }
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
        }
        // Cellular noise: distance to nearest and second-nearest drifting cell points.
        vec2 worley(vec2 p) {
          vec2 n = floor(p), f = fract(p);
          float f1 = 8.0, f2 = 8.0;
          for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
            vec2 g = vec2(float(i), float(j));
            vec2 o = vec2(hash(n + g), hash(n + g + 17.3));
            o = 0.5 + 0.45 * sin(time * 0.5 + 6.2831 * o);
            vec2 r = g + o - f;
            float d = dot(r, r);
            if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
          }
          return vec2(sqrt(f1), sqrt(f2));
        }
        void main() {
          vec2 uv = vec2((vWorld.x - uMin) / uSize, 1.0 - (vWorld.z - uMin) / uSize);
          vec3 m = vec3(0.0, 1.0, 0.0);
          if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) m = texture2D(mask, uv).rgb;
          float land = m.r, shore = m.g;
          if (land > 0.97) discard;
          vec3 col = mix(shallow, mid, smoothstep(0.0, 0.35, shore));
          col = mix(col, deep, smoothstep(0.35, 1.0, shore));
          float alpha = mix(0.28, 0.93, smoothstep(0.0, 0.75, shore));
          float c = clamp(caustic(vWorld.xz * 2.6 + 40.0, time * 0.55), 0.0, 1.0);
          col += vec3(0.85, 1.0, 0.95) * c * 0.22 * (1.0 - smoothstep(0.1, 0.7, shore));
          // Surf: bands that roll in toward the beach and fade.
          // Lacy surf: a web of foam that washes in and out along the beach.
          vec2 w = worley(vWorld.xz * 3.2);
          float lace = 1.0 - smoothstep(0.03, 0.11, w.y - w.x);
          float wash = 0.06 + 0.035 * sin(time * 0.9 + vWorld.x * 0.4 + vWorld.z * 0.3);
          float band = 1.0 - smoothstep(wash * 0.4, wash, shore);
          float edge = 1.0 - smoothstep(0.0, 0.016, shore);
          float foam = clamp(max(edge, lace * band * 0.95), 0.0, 1.0);
          col = mix(col, vec3(1.0), foam);
          alpha = max(alpha, foam * 0.95);
          gl_FragColor = vec4(col, alpha * (1.0 - land));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const water = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), mat);
    water.position.set(CENTER * U, 0.03, CENTER * U);
    water.renderOrder = 2;
    this.scene.add(water);
  }

  buildPoison() {
    this.poisonMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { time: this.uniforms.time, radius: { value: 30 }, center: { value: new THREE.Vector2(CENTER * U, CENTER * U) } },
      vertexShader: /* glsl */`
        varying vec3 vWorld;
        void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */`
        uniform float time, radius;
        uniform vec2 center;
        varying vec3 vWorld;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
        }
        void main() {
          float d = distance(vWorld.xz, center);
          float inside = smoothstep(radius, radius + 0.35, d);
          if (inside <= 0.0) discard;
          float n = vnoise(vWorld.xz * 0.6 + time * 0.25) * 0.6 + vnoise(vWorld.xz * 1.7 - time * 0.4) * 0.4;
          vec3 col = mix(vec3(0.25, 0.75, 0.25), vec3(0.6, 1.0, 0.45), n);
          float rim = 1.0 - smoothstep(0.0, 0.6, d - radius);
          gl_FragColor = vec4(col + rim * 0.4, inside * (0.42 + 0.18 * n) + rim * 0.25);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const gas = new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2), this.poisonMat);
    gas.position.set(CENTER * U, 1.1, CENTER * U);
    gas.renderOrder = 5;
    this.poisonMesh = gas;
    this.scene.add(gas);
  }

  // Walls and bushes never move: draw each variant as one instanced mesh.
  instanced(name, transforms, { cast = true } = {}) {
    const group = new THREE.Group();
    const src = this.models[name];
    src.updateMatrixWorld(true);
    src.traverse((o) => {
      if (!o.isMesh) return;
      const im = new THREE.InstancedMesh(o.geometry, o.material, transforms.length);
      const local = o.matrixWorld.clone();
      transforms.forEach((m, i) => im.setMatrixAt(i, new THREE.Matrix4().multiplyMatrices(m, local)));
      im.castShadow = cast && o.material !== this.outlineMat;
      im.receiveShadow = true;
      group.add(im);
    });
    this.scene.add(group);
    return group;
  }

  buildStatic() {
    const walls = [[], [], []];
    const bushes = [[], [], []];
    this.bushTiles = [];
    MAP.forEach((row, r) => [...row].forEach((ch, c) => {
      const v = (r * 7 + c * 13) % 3;
      const m = new THREE.Matrix4().makeTranslation(c + 0.5, 0, r + 0.5);
      if (ch === '#') walls[v].push(m);
      if (ch === '*') {
        const rot = new THREE.Matrix4().makeRotationY(((r * 31 + c * 17) % 8) * Math.PI / 4);
        m.multiply(rot).multiply(new THREE.Matrix4().makeScale(1.1, 1.1, 1.1));
        this.bushTiles.push({ r, c, v, index: bushes[v].length, matrix: m });
        bushes[v].push(m);
      }
    }));
    walls.forEach((list, v) => list.length && this.instanced(`wall${v}`, list));
    this.bushGroups = bushes.map((list, v) => (list.length ? this.instanced(`bush${v}`, list) : null));
    // A see-through copy for the bush you're standing in.
    this.myBush = new THREE.Group();
    this.scene.add(this.myBush);
    this.myBushKey = null;
  }

  buildDecor(albedoImg) {
    const rnd = rand(1234);
    const g = this.ground;
    // Read the baked map to find open grass.
    const S = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(albedoImg, 0, 0, S, S);
    const px = cx.getImageData(0, 0, S, S).data;
    const at = (x, z) => {
      const i = Math.floor((x - g.min) / g.size * S), j = Math.floor((z - g.min) / g.size * S);
      const k = (j * S + i) * 4;
      return [px[k], px[k + 1], px[k + 2]];
    };
    const open = (x, z) => {
      const ch = MAP[Math.floor(z)]?.[Math.floor(x)];
      return ch === '.';
    };
    const isGrass = (x, z) => { const [r, gg, b] = at(x, z); return gg > r * 1.15 && gg > b * 1.4; };

    // Grass tufts that sway in the wind.
    const tuft = this.makeTuft();
    const tufts = [];
    for (let i = 0; tufts.length < 3600 && i < 30000; i++) {
      const x = rnd() * 30, z = rnd() * 30;
      if (!open(x, z) || !isGrass(x, z)) continue;
      const s = 0.7 + rnd() * 0.7;
      tufts.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI * 2), new THREE.Vector3(s, s * (0.8 + rnd() * 0.6), s)));
    }
    const tm = new THREE.InstancedMesh(tuft.geometry, tuft.material, tufts.length);
    tufts.forEach((m, i) => tm.setMatrixAt(i, m));
    tm.receiveShadow = true;
    this.scene.add(tm);

    // Flowers
    const flowerGeo = new THREE.SphereGeometry(0.055, 8, 6);
    const flowerMat = new THREE.MeshStandardMaterial({ roughness: 0.6 });
    const palette = ['#ffffff', '#fff3a8', '#ff9ec7', '#c9a7ff', '#ffb27a'].map((c) => new THREE.Color(c));
    const flowers = [];
    for (let i = 0; flowers.length < 700 && i < 20000; i++) {
      const x = rnd() * 30, z = rnd() * 30;
      if (!open(x, z) || !isGrass(x, z)) continue;
      const col = palette[Math.floor(rnd() * palette.length)];
      for (let k = 0; k < 3; k++) flowers.push([x + (rnd() - 0.5) * 0.25, z + (rnd() - 0.5) * 0.25, col]);
    }
    const fm = new THREE.InstancedMesh(flowerGeo, flowerMat, flowers.length);
    flowers.forEach(([x, z, col], i) => {
      fm.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(x, 0.08, z), new THREE.Quaternion(), new THREE.Vector3(1, 0.6, 1)));
      fm.setColorAt(i, col);
    });
    this.scene.add(fm);

    // Beach and shallows: palms, rocks, coral, starfish.
    const ring = (d, count, jitter) => Array.from({ length: count }, (_, i) => {
      const t = i / count * 4;
      const side = Math.floor(t), f = t - side;
      const along = -1.5 + f * 33 + (rnd() - 0.5) * jitter;
      const off = d + (rnd() - 0.5) * jitter * 0.3;
      return [[along, -off], [30 + off, along], [30 - along, 30 + off], [-off, 30 - along]][side];
    });
    const place = (name, pts, scale = 1, yaw = true) => this.instanced(name, pts.map(([x, z]) => new THREE.Matrix4().compose(
      new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw ? rnd() * Math.PI * 2 : 0),
      new THREE.Vector3().setScalar(scale * (0.85 + rnd() * 0.35)))));
    // Palms lean out toward the sea so their crowns never hide the arena.
    // None on the south beach: the camera looks north, so they'd block the bottom of the screen.
    const palms = ring(0.5, 34, 1.0).filter(([, z]) => z < 29);
    for (const v of [0, 1]) {
      this.instanced(`palm${v}`, palms.filter((_, i) => i % 2 === v).map(([x, z]) => new THREE.Matrix4().compose(
        new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-(z - 15), x - 15) + (rnd() - 0.5) * 0.6),
        new THREE.Vector3().setScalar(0.85 + rnd() * 0.3))));
    }
    for (let v = 0; v < 3; v++) {
      place(`rock${v}`, ring(1.6 + v * 0.4, 9, 3), 1.3);
      place(`coral${v}`, ring(2.1 + v * 0.3, 7, 3), 1.1);
    }
    place('starfish', ring(0.35, 14, 2), 1.2);

    // Fish circling in the shallows.
    const body = new THREE.SphereGeometry(0.1, 10, 6).scale(1, 0.4, 0.5);
    const tail = new THREE.ConeGeometry(0.06, 0.1, 4).rotateZ(Math.PI / 2).translate(-0.13, 0, 0);
    this.fish = new THREE.InstancedMesh(mergeGeometries([body, tail]), new THREE.MeshStandardMaterial({ color: '#41606a', roughness: 0.5 }), 40);
    this.fishData = ring(2.1, 40, 3.5).map(([x, z]) => ({ x, z, r: 0.35 + rnd() * 0.8, w: (0.4 + rnd() * 0.6) * (rnd() < 0.5 ? -1 : 1), ph: rnd() * 6.28, s: 0.7 + rnd() * 0.6 }));
    this.scene.add(this.fish);
    // Crabs scuttling sideways along the beach.
    this.crabs = this.dynamicInstanced('crab', 8);
    this.crabData = ring(0.32, 8, 4).map(([x, z]) => {
      const out = Math.atan2(z - 15, x - 15);
      return { x, z, tx: -Math.sin(out), tz: Math.cos(out), yaw: -out + Math.PI / 2, ph: rnd() * 6.28, sp: 0.5 + rnd() * 0.6 };
    });
  }

  dynamicInstanced(name, count) {
    const src = this.models[name];
    src.updateMatrixWorld(true);
    const parts = [];
    src.traverse((o) => {
      if (!o.isMesh) return;
      const im = new THREE.InstancedMesh(o.geometry, o.material, count);
      im.castShadow = true;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(im);
      parts.push({ im, local: o.matrixWorld.clone() });
    });
    const tmp = new THREE.Matrix4();
    return {
      set: (i, m) => { for (const p of parts) p.im.setMatrixAt(i, tmp.multiplyMatrices(m, p.local)); },
      commit: () => { for (const p of parts) p.im.instanceMatrix.needsUpdate = true; },
    };
  }

  animateWildlife(t) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), pos = new THREE.Vector3(), sc = new THREE.Vector3();
    this.fishData.forEach((f, i) => {
      const a = f.ph + f.w * t;
      pos.set(f.x + Math.cos(a) * f.r, 0.012, f.z + Math.sin(a) * f.r);
      q.setFromAxisAngle(up, -a - Math.sign(f.w) * Math.PI / 2 + Math.sin(t * 8 + i) * 0.15);
      this.fish.setMatrixAt(i, m.compose(pos, q, sc.setScalar(f.s)));
    });
    this.fish.instanceMatrix.needsUpdate = true;
    this.crabData.forEach((c, i) => {
      const k = Math.sin(t * c.sp + c.ph) * 0.7 + Math.sin(t * c.sp * 2.3 + c.ph) * 0.2;
      pos.set(c.x + c.tx * k, 0, c.z + c.tz * k);
      q.setFromAxisAngle(up, c.yaw);
      this.crabs.set(i, m.compose(pos, q, sc.setScalar(1.3)));
    });
    this.crabs.commit();
  }

  makeTuft() {
    const blades = [];
    for (let b = 0; b < 5; b++) {
      const a = b / 5 * Math.PI;
      const g = new THREE.BufferGeometry();
      const w = 0.05, h = 0.2;
      const dx = Math.cos(a) * w, dz = Math.sin(a) * w, lean = (b - 2) * 0.04;
      g.setAttribute('position', new THREE.Float32BufferAttribute([-dx, 0, -dz, dx, 0, dz, lean, h, lean * 0.5], 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute([0.1, 0.27, 0.06, 0.1, 0.27, 0.06, 0.3, 0.55, 0.14], 3));
      // Normals point up so blades are lit like the lawn they grow from.
      g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
      blades.push(g);
    }
    const geometry = mergeGeometries(blades);
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.9 });
    material.onBeforeCompile = (shader) => {
      shader.uniforms.time = this.uniforms.time;
      // Blades are double-sided but should light like the lawn on both sides.
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', 'float faceDirection = 1.0;\nvec3 normal = normalize( vNormal );\nvec3 nonPerturbedNormal = normal;');
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float time;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vec2 ip = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
          transformed.x += sin(time * 1.8 + ip.x * 0.7 + ip.y * 0.5) * 0.06 * position.y / 0.28;
          transformed.z += cos(time * 1.3 + ip.y * 0.6) * 0.03 * position.y / 0.28;`);
    };
    return { geometry, material };
  }

  // ------------------------------------------------------------ per-frame objects

  charObj(p) {
    let e = this.players.get(p.id);
    if (e && e.brawler !== p.brawler) { this.scene.remove(e.obj); e = null; }
    if (!e) {
      const obj = this.models[p.brawler].clone(true);
      obj.scale.setScalar(CHAR_SCALE);
      const mats = new Map();
      const piv = {};
      obj.traverse((o) => {
        if (PIVOTS.includes(o.name)) piv[o.name] = o;
        if (o.isMesh && o.userData.body) {
          if (!mats.has(o.material)) mats.set(o.material, o.material.clone());
          o.material = mats.get(o.material);
        }
      });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 40).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: p.isMe ? ME : FOE, transparent: true, opacity: 0.9, depthWrite: false }));
      ring.position.y = 0.04;
      const holder = new THREE.Group();
      holder.add(obj, ring);
      this.scene.add(holder);
      e = { obj: holder, model: obj, mats: [...mats.values()], piv, brawler: p.brawler, phase: 0, last: null, yaw: Math.PI / 2 - p.aim, superRing: null, su: -1 };
      this.players.set(p.id, e);
    }
    e.seen = true;
    return e;
  }

  updatePlayer(p, now, dt, flash) {
    const e = this.charObj(p);
    const x = p.x * U, z = p.y * U;
    const moved = e.last ? Math.hypot(x - e.last.x, z - e.last.z) : 0;
    e.last = { x, z };
    const speed = dt > 0 ? moved / dt : 0;
    e.walk = THREE.MathUtils.lerp(e.walk ?? 0, speed > 0.5 ? 1 : 0, Math.min(1, dt * 10));
    e.phase += dt * 11 * e.walk;
    e.obj.position.set(x, 0, z);
    // Turn smoothly toward the aim.
    const target = Math.PI / 2 - p.aim;
    let d = ((target - e.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    e.yaw += d * Math.min(1, dt * 18);
    e.model.rotation.y = e.yaw;
    const s = Math.sin(e.phase) * e.walk;
    if (e.piv.legL) e.piv.legL.rotation.x = 0.55 * s;
    if (e.piv.legR) e.piv.legR.rotation.x = -0.55 * s;
    if (e.piv.armLpiv) e.piv.armLpiv.rotation.x = -0.45 * s;
    if (e.piv.upper) e.piv.upper.position.y = Math.abs(Math.cos(e.phase)) * 0.035 * e.walk + Math.sin(now / 500) * 0.008;
    for (const m of e.mats) {
      m.opacity = p.bush ? (p.isMe ? 0.55 : 0.4) : 1;
      // Only blend while hidden in a bush; opaque rendering keeps the model's parts sorted correctly.
      if (m.transparent !== m.opacity < 1) { m.transparent = m.opacity < 1; m.needsUpdate = true; }
      m.emissive?.setScalar(flash * 0.9);
    }
    e.model.position.y = p.dash ? 0.08 : 0;
    // Super charge ring under your own feet.
    if (p.isMe) {
      const su = Math.round((this.me?.su ?? 0) * 40) / 40;
      if (su !== e.su) {
        e.su = su;
        if (e.superRing) { e.obj.remove(e.superRing); e.superRing.geometry.dispose(); }
        if (su > 0) {
          e.superRing = new THREE.Mesh(new THREE.RingGeometry(0.54, 0.62, 48, 1, Math.PI / 2, -Math.PI * 2 * su).rotateX(-Math.PI / 2),
            new THREE.MeshBasicMaterial({ color: '#ffd23c', transparent: true, depthWrite: false }));
          e.superRing.position.y = 0.045;
          e.obj.add(e.superRing);
        } else e.superRing = null;
      }
      if (e.superRing) e.superRing.material.opacity = su >= 1 ? 0.65 + 0.35 * Math.sin(now / 80) : 0.9;
    }
  }

  syncMap(map, items, make, update) {
    for (const v of map.values()) v.seen = false;
    for (const it of items) {
      let o = map.get(it.i);
      if (!o) { o = make(it); map.set(it.i, o); }
      o.seen = true;
      update(o, it);
    }
    for (const [k, o] of map) {
      if (!o.seen) { this.scene.remove(o.obj); map.delete(k); }
    }
  }

  // ------------------------------------------------------------ effects

  addEvent(e, now) {
    if (e.k === 'dmg') {
      this.flashes.set(e.id, now);
      this.floaters.push({ ...e, born: now, life: 0.9 });
      return;
    }
    if (e.k === 'cube') { this.floaters.push({ ...e, born: now, life: 0.9 }); return; }
    if (!this.ready) return;
    const at = new THREE.Vector3(e.x * U, 0, e.y * U);
    const add = (obj, life, update) => { this.scene.add(obj); this.fx.push({ obj, born: now, life, update }); };
    const burst = (n, color, speed, size, upward, life) => {
      const g = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true });
      const geo = new THREE.IcosahedronGeometry(size, 0);
      const parts = Array.from({ length: n }, () => {
        const m = new THREE.Mesh(geo, mat);
        const a = Math.random() * Math.PI * 2;
        m.userData.v = new THREE.Vector3(Math.cos(a) * speed * (0.5 + Math.random()), upward * (0.5 + Math.random()), Math.sin(a) * speed * (0.5 + Math.random()));
        g.add(m);
        return m;
      });
      g.position.copy(at).setY(0.4);
      add(g, life, (k) => {
        for (const m of parts) {
          m.position.copy(m.userData.v).multiplyScalar(k * life).add(new THREE.Vector3(0, -4 * (k * life) ** 2, 0));
          m.rotation.x += 0.2;
        }
        mat.opacity = 1 - k;
      });
    };
    if (e.k === 'boom') {
      const r = e.r * U;
      const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), new THREE.MeshBasicMaterial({ color: '#ffb347', transparent: true }));
      ball.position.copy(at).setY(0.2);
      add(ball, e.big ? 0.6 : 0.45, (k) => {
        ball.scale.setScalar(r * (0.4 + 0.8 * k));
        ball.material.opacity = 0.85 * (1 - k);
        ball.material.color.lerpColors(new THREE.Color('#fff2a8'), new THREE.Color('#ff5a1f'), k);
      });
      burst(e.big ? 18 : 10, '#5a4a3a', 3, 0.07, 3, 0.7);
    } else if (e.k === 'spark') {
      burst(5, '#fff3a8', 1.5, 0.04, 1.5, 0.25);
    } else if (e.k === 'ko') {
      burst(16, '#ffffff', 2.5, 0.09, 3, 0.8);
    } else if (e.k === 'crateBreak') {
      burst(12, '#b77a3d', 3, 0.1, 4, 0.8);
    } else if (e.k === 'crate') {
      const c = [...this.crateObjs.values()].find((o) => Math.hypot(o.obj.position.x - at.x, o.obj.position.z - at.z) < 0.3);
      if (c) c.hitAt = now;
    } else if (e.k === 'haunt' || e.k === 'super') {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: e.k === 'haunt' ? '#be96ff' : '#ffd63c', transparent: true, depthWrite: false }));
      ring.position.copy(at).setY(0.06);
      const R = e.k === 'haunt' ? HAUNT.radius * U : 0.9;
      add(ring, 0.55, (k) => { ring.scale.setScalar(R * (0.3 + k)); ring.material.opacity = 1 - k; });
    }
  }

  // ------------------------------------------------------------ projection helpers (used by input/aim)

  toScreen(cam, x, y, h = 0) {
    const v = new THREE.Vector3(x * U, h, y * U).project(this.camera);
    return { x: (v.x + 1) / 2 * this.w, y: (1 - v.y) / 2 * this.h, behind: v.z > 1 };
  }

  groundPoint(sx, sy) {
    this.raycaster.setFromCamera(new THREE.Vector2(sx / this.w * 2 - 1, -(sy / this.h) * 2 + 1), this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, hit)) return null;
    return { x: hit.x / U, y: hit.z / U };
  }

  // ------------------------------------------------------------ main draw

  draw(v, now) {
    if (!this.ready) return;
    const dt = Math.min(0.1, (now - (this.lastNow ?? now)) / 1000);
    this.lastNow = now;
    this.me = v.me;
    const t = now / 1000;
    this.uniforms.time.value = t;
    const flashOf = (id) => { const at = this.flashes.get(id); return at ? Math.max(0, 1 - (now - at) / 140) : 0; };

    // Camera follows the view's camera point, high and tilted like a diorama.
    this.shakeAmt *= 0.88;
    this.camTarget.set(v.cam.x * U, 0, v.cam.y * U);
    const pitch = THREE.MathUtils.degToRad(50);
    this.camera.position.set(
      this.camTarget.x + (Math.random() - 0.5) * this.shakeAmt * 0.02,
      this.camDist * Math.sin(pitch),
      this.camTarget.z + this.camDist * Math.cos(pitch) + (Math.random() - 0.5) * this.shakeAmt * 0.02,
    );
    this.camera.lookAt(this.camTarget);
    // Sun and its shadow box follow the camera.
    this.sun.target.position.copy(this.camTarget);
    this.sun.position.copy(this.camTarget).add(this.sunOffset);
    this.poisonMat.uniforms.radius.value = v.poison * U;
    this.poisonMesh.visible = v.poison < POISON.startR - 1;

    // Players
    for (const e of this.players.values()) e.seen = false;
    for (const p of v.players) this.updatePlayer(p, now, dt, flashOf(p.id));
    for (const [id, e] of this.players) if (!e.seen) { this.scene.remove(e.obj); this.players.delete(id); }

    // See-through bush when you're inside it.
    const me = v.players.find((p) => p.isMe);
    const tile = me ? this.bushTiles.find((b) => b.c === Math.floor(me.x / TILE) && b.r === Math.floor(me.y / TILE)) : null;
    const key = tile ? `${tile.r},${tile.c}` : null;
    if (key !== this.myBushKey) {
      if (this.myBushKey) {
        const old = this.myBushTile;
        this.bushGroups[old.v].children.forEach((im) => { im.setMatrixAt(old.index, old.matrix); im.instanceMatrix.needsUpdate = true; });
        this.myBush.clear();
      }
      if (tile) {
        const hide = new THREE.Matrix4().makeScale(0, 0, 0);
        this.bushGroups[tile.v].children.forEach((im) => { im.setMatrixAt(tile.index, hide); im.instanceMatrix.needsUpdate = true; });
        const copy = this.models[`bush${tile.v}`].clone(true);
        copy.traverse((o) => {
          if (o.isMesh) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.35; o.material.depthWrite = false; o.castShadow = false; }
        });
        copy.applyMatrix4(tile.matrix);
        this.myBush.add(copy);
      }
      this.myBushKey = key;
      this.myBushTile = tile;
    }

    // Ghosts
    this.syncMap(this.ghostObjs, v.ghosts.map((g) => ({ ...g, i: g.id })), () => {
      const obj = this.models.ghost.clone(true);
      obj.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.6; o.castShadow = false; } });
      obj.scale.setScalar(1.2);
      this.scene.add(obj);
      return { obj };
    }, (o, g) => {
      o.obj.position.set(g.x * U, 0.25 + Math.sin(t * 3 + g.x) * 0.1, g.y * U);
      o.obj.rotation.y = Math.sin(t * 1.5 + g.x) * 0.4;
    });

    // Crates (wobble when hit)
    this.syncMap(this.crateObjs, v.crates, () => {
      const obj = this.models.crate.clone(true);
      this.scene.add(obj);
      return { obj, hitAt: 0 };
    }, (o, c) => {
      o.obj.position.set(c.x * U, 0, c.y * U);
      const k = Math.max(0, 1 - (now - o.hitAt) / 200);
      o.obj.rotation.z = Math.sin(now / 25) * 0.08 * k;
      o.obj.scale.setScalar(1 + 0.06 * k);
      o.h = c.h;
    });

    // Power cubes
    this.syncMap(this.cubeObjs, v.cubes, () => {
      const obj = this.models.cube.clone(true);
      this.scene.add(obj);
      return { obj };
    }, (o, c) => {
      o.obj.position.set(c.x * U, 0.1 + Math.sin(t * 3 + c.i) * 0.08, c.y * U);
      o.obj.rotation.y = t * 1.5 + c.i;
    });

    // Projectiles
    const bulletMats = this.bulletMats ??= {
      b: new THREE.MeshBasicMaterial({ color: '#fff3a8' }),
      p: new THREE.MeshBasicMaterial({ color: '#ffb347' }),
      v: new THREE.MeshBasicMaterial({ color: '#7fe9ff' }),
      bomb: new THREE.MeshStandardMaterial({ color: '#222228', roughness: 0.3 }),
      bigbomb: new THREE.MeshStandardMaterial({ color: '#7a1010', roughness: 0.3 }),
      zone: new THREE.MeshBasicMaterial({ color: '#ff3b3b', transparent: true, opacity: 0.22, depthWrite: false }),
    };
    this.syncMap(this.projObjs, v.projs, (p) => {
      const obj = new THREE.Group();
      if (p.k === 'l') {
        const r = p.big ? 0.32 : 0.2;
        const bomb = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 10), p.big ? bulletMats.bigbomb : bulletMats.bomb);
        bomb.castShadow = true;
        const zone = new THREE.Mesh(new THREE.CircleGeometry(p.r * U, 40).rotateX(-Math.PI / 2), bulletMats.zone);
        zone.position.set(p.tx * U, 0.05, p.ty * U);
        obj.add(bomb, zone);
        obj.userData = { bomb, zone };
        this.scene.add(obj);
        return { obj, lob: true };
      }
      const r = p.k === 'p' ? 0.09 : 0.12;
      const core = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), bulletMats[p.k]);
      const glow = new THREE.Sprite(this.glowMat(p.k));
      glow.scale.setScalar(r * 6);
      obj.add(core, glow);
      this.scene.add(obj);
      return { obj };
    }, (o, p) => {
      if (o.lob) {
        const gx = p.sx + (p.tx - p.sx) * p.p, gy = p.sy + (p.ty - p.sy) * p.p;
        const h = Math.sin(Math.PI * p.p) * (p.big ? 3.2 : 2.2) + 0.3;
        o.obj.userData.bomb.position.set(gx * U, h, gy * U);
        o.obj.userData.zone.material.opacity = 0.15 + 0.15 * Math.sin(now / 60);
        return;
      }
      o.obj.position.set(p.x * U, 0.75, p.y * U);
    });

    // Haunt zones
    this.syncMap(this.hauntObjs, v.haunts, (h) => {
      const disc = new THREE.Mesh(new THREE.CircleGeometry(h.r * U, 40).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: '#8c46ff', transparent: true, opacity: 0.3, depthWrite: false }));
      disc.position.set(h.x * U, 0.06, h.y * U);
      this.scene.add(disc);
      return { obj: disc };
    }, (o, h) => {
      o.obj.material.opacity = 0.3 * Math.min(1, h.l / 0.5) * (0.8 + 0.2 * Math.sin(now / 120));
      o.obj.rotation.y = t;
    });

    // Aim guide on the ground
    this.updateAim(v.aim);

    // Effects
    this.fx = this.fx.filter((f) => {
      const k = (now - f.born) / 1000 / f.life;
      if (k >= 1) { this.scene.remove(f.obj); return false; }
      f.update(k);
      return true;
    });

    this.animateWildlife(t);
    if (this.composer) this.composer.render(dt);
    else this.gl.render(this.scene, this.camera);
    this.watchPerf(dt);
    this.drawOverlay(v, now);
  }

  glowMat(kind) {
    this.glowMats ??= {};
    if (this.glowMats[kind]) return this.glowMats[kind];
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const col = { b: '255,225,77', p: '255,138,0', v: '40,200,255' }[kind];
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, `rgba(${col},0.9)`);
    grd.addColorStop(1, `rgba(${col},0)`);
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.glowMats[kind] = new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false });
    return this.glowMats[kind];
  }

  updateAim(a) {
    if (!a) { if (this.aimObj) this.aimObj.visible = false; return; }
    const b = BRAWLERS[a.brawler];
    const kind = a.super ? b.super.kind : b.attack;
    const key = `${a.brawler}:${a.super}`;
    if (this.aimKey !== key) {
      if (this.aimObj) this.scene.remove(this.aimObj);
      const mat = new THREE.MeshBasicMaterial({ color: a.super ? '#ffd63c' : '#ffffff', transparent: true, opacity: 0.28, depthWrite: false });
      const range = (a.super ? b.super.range : b.range) * U;
      const g = new THREE.Group();
      if (kind === 'shotgun' || kind === 'volley') {
        const spread = kind === 'volley' ? b.super.spread : b.spread;
        g.add(new THREE.Mesh(new THREE.CircleGeometry(range, 32, -spread / 2, spread).rotateX(-Math.PI / 2), mat));
      } else if (kind === 'bullet' || kind === 'charge') {
        const w = (kind === 'charge' ? 52 : 18) * U;
        const geo = new THREE.PlaneGeometry(range, w).rotateX(-Math.PI / 2).translate(range / 2, 0, 0);
        g.add(new THREE.Mesh(geo, mat));
      } else {
        const blast = (a.super ? b.super.blast : b.blast) * U;
        const zone = new THREE.Mesh(new THREE.CircleGeometry(blast, 40).rotateX(-Math.PI / 2), mat);
        zone.name = 'zone';
        g.add(zone);
      }
      g.position.y = 0.07;
      g.renderOrder = 3;
      this.scene.add(g);
      this.aimObj = g;
      this.aimKey = key;
      this.aimKind = kind;
      this.aimRange = range;
    }
    this.aimObj.visible = true;
    const x = a.x * U, z = a.y * U;
    if (this.aimKind === 'lob' || this.aimKind === 'mega') {
      const d = Math.min(this.aimRange, Math.max(80 * U, a.dist * U));
      this.aimObj.position.set(x + Math.cos(a.angle) * d, 0.07, z + Math.sin(a.angle) * d);
      this.aimObj.rotation.y = 0;
    } else {
      this.aimObj.position.set(x, 0.07, z);
      this.aimObj.rotation.y = -a.angle;
    }
  }

  // ------------------------------------------------------------ 2D overlay: names, bars, numbers, HUD

  drawOverlay(v, now) {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.textAlign = 'center';
    for (const p of v.players) {
      const s = this.toScreen(null, p.x, p.y, 2.25);
      if (s.behind) continue;
      ctx.font = '17px "Patrick Hand", system-ui';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(40,28,18,0.85)';
      ctx.fillStyle = p.isMe ? '#c9f2b6' : '#f6eedb';
      const label = p.isMe ? 'You' : p.name;
      ctx.strokeText(label, s.x, s.y - 16);
      ctx.fillText(label, s.x, s.y - 16);
      const w = 64, h = 10;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(s.x - w / 2 - 2, s.y - 10, w + 4, h + 4);
      ctx.fillStyle = p.isMe ? ME : FOE;
      ctx.fillRect(s.x - w / 2, s.y - 8, Math.max(0, w * (p.hp / p.maxHp)), h);
      ctx.font = 'bold 11px system-ui';
      ctx.fillStyle = '#fff';
      ctx.fillText(Math.max(0, Math.ceil(p.hp)), s.x, s.y + 1);
      if (p.cubes > 0) {
        ctx.fillStyle = '#2ecc71';
        ctx.fillRect(s.x + w / 2 + 5, s.y - 11, 20, 16);
        ctx.fillStyle = '#0b2a14';
        ctx.font = 'bold 12px system-ui';
        ctx.fillText(p.cubes, s.x + w / 2 + 15, s.y + 2);
      }
      if (p.em != null) this.bubbleAt(s.x, s.y - 36, EMOTES[p.em]);
      if (p.isMe && v.me) {
        const f = this.toScreen(null, p.x, p.y, 0);
        const seg = 18, gap = 3, total = MAX_AMMO * seg + (MAX_AMMO - 1) * gap;
        for (let i = 0; i < MAX_AMMO; i++) {
          const x = f.x - total / 2 + i * (seg + gap);
          ctx.fillStyle = 'rgba(0,0,0,0.6)';
          ctx.fillRect(x, f.y + 22, seg, 6);
          ctx.fillStyle = '#ff9f1a';
          ctx.fillRect(x, f.y + 22, seg * Math.max(0, Math.min(1, v.me.ammo - i)), 6);
        }
      }
    }
    for (const g of v.ghosts) {
      const s = this.toScreen(null, g.x, g.y, 1.7);
      ctx.font = '16px "Patrick Hand", system-ui';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.fillStyle = '#d9ccff';
      const label = g.isMe ? 'You (ghost)' : `${g.name} 👻`;
      ctx.strokeText(label, s.x, s.y);
      ctx.fillText(label, s.x, s.y);
      if (g.em != null) this.bubbleAt(s.x, s.y - 18, EMOTES[g.em]);
    }
    for (const c of this.crateObjs.values()) {
      if (c.h >= 1) continue;
      const s = this.toScreen(null, c.obj.position.x / U, c.obj.position.z / U, 1.2);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(s.x - 26, s.y - 4, 52, 8);
      ctx.fillStyle = '#ffd34d';
      ctx.fillRect(s.x - 25, s.y - 3, 50 * c.h, 6);
    }
    // Floating damage numbers
    this.floaters = this.floaters.filter((f) => (now - f.born) / 1000 < f.life);
    for (const f of this.floaters) {
      const k = (now - f.born) / 1000 / f.life;
      const s = this.toScreen(null, f.x, f.y, 2.0);
      const text = f.k === 'dmg' ? `-${f.a}` : '+1 ⚡';
      ctx.font = `900 ${f.k === 'dmg' ? 20 : 18}px system-ui`;
      ctx.globalAlpha = 1 - k * k;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.fillStyle = f.k === 'cube' ? '#6dff9c' : f.src === 'poison' ? '#9dffa8' : f.src === 'haunt' ? '#cdb6ff' : '#ffdf5d';
      const x = s.x + ((f.id ?? 1) % 3 - 1) * 14, y = s.y - 20 - k * 40;
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
      ctx.globalAlpha = 1;
    }
    this.drawArrows3D(v);
    this.drawHurt(now);
    if (v.sticks) this.drawSticks(v.sticks, v.me);
  }

  bubbleAt(x, y, text) {
    const { ctx } = this;
    ctx.font = '900 22px system-ui';
    const w = Math.max(40, ctx.measureText(text).width + 18);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x - w / 2, y - 34, w, 34, 12); else ctx.rect(x - w / 2, y - 34, w, 34);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 8); ctx.fill();
    ctx.fillStyle = '#1b1430';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y - 16);
    ctx.textBaseline = 'alphabetic';
  }

  drawArrows3D(v) {
    const { ctx } = this;
    const m = 34;
    for (const p of v.players) {
      if (p.isMe) continue;
      const s = this.toScreen(null, p.x, p.y, 0.8);
      if (s.x > 0 && s.x < this.w && s.y > 0 && s.y < this.h) continue;
      const cx = this.w / 2, cy = this.h / 2;
      const a = Math.atan2(s.y - cy, s.x - cx);
      const k = Math.min((cx - m) / Math.abs(Math.cos(a) || 1e-6), (cy - m) / Math.abs(Math.sin(a) || 1e-6));
      ctx.save();
      ctx.translate(cx + Math.cos(a) * k, cy + Math.sin(a) * k);
      ctx.rotate(a);
      ctx.fillStyle = 'rgba(255,77,79,0.85)';
      ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-8, -10); ctx.lineTo(-8, 10); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }
}

