// Real-time 3D renderer (Three.js). Same interface as the 2D Renderer it extends, which it reuses for
// the HUD overlay (joysticks, hurt vignette). Models come from tools/blender/export_models.py.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { MAP, MAP_TILES, TILE, CENTER, BRAWLERS, MAX_AMMO, EMOTES, HAUNT, POISON, MODES, weaponOf, tileAt, JUMP_PADS, JUMP, GADGET } from '/shared/game.js';
import { Renderer } from './render.js';

const U = 1 / TILE; // game pixels -> world units (1 unit = 1 tile)
const CHAR_SCALE = 1.25;
const PIVOTS = ['legL', 'legR', 'upper', 'armLpiv'];
const ME = '#3ccf6e';
const FOE = '#ff4d4f';
const ALLY = '#4aa3ff';
const N = MAP_TILES;
const C = N / 2;

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
    this.swaps = new Map(); // player id -> { at, w }: recent weapon swaps (spin + icon)
    this.zoneObjs = new Map();
    this.gadgetPops = new Map(); // player id -> { at, g }: gadget icon over their head
    this.padObjs = [];
    this.koBodies = new Map(); // player id -> knocked-out body still tumbling (don't redraw them)
    this.kick = new THREE.Vector2(); // camera shake as a damped spring (world units)
    this.kickV = new THREE.Vector2();
    this.coarse = matchMedia('(pointer: coarse)').matches;
    this.camTarget = new THREE.Vector3(CENTER * U, 0, CENTER * U);
    this.uniforms = { time: { value: 0 } };
    this.tmpM = new THREE.Matrix4();
    this.tmpV = new THREE.Vector3();
    this.tmpS = new THREE.Vector3();
    this.tmpQ = new THREE.Quaternion();
    this.tmpColor = new THREE.Color();
    this.up = new THREE.Vector3(0, 1, 0);
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
    this.camDist = visibleW / 2 / Math.tan(hfov / 2) * 0.96;
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setPixelRatio(this.gl.getPixelRatio());
      this.composer.setSize(this.w, this.h);
      const px = this.gl.getPixelRatio();
      for (const pass of [this.tiltH, this.tiltV]) {
        pass.uniforms.texel.value.set(1 / (this.w * px), 1 / (this.h * px));
        pass.uniforms.amount.value = 1.8 * Math.min(1, this.h / 850); // gentler on short phone screens
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
    this.boomLights = [];
    if (!matchMedia('(pointer: coarse)').matches) {
      for (let i = 0; i < 2; i++) {
        const l = new THREE.PointLight('#ffb060', 0, 7, 2);
        this.scene.add(l);
        this.boomLights.push({ light: l, born: -1, peak: 0 });
      }
    }
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
    this.buildGemMine();
    this.buildPads();
    this.buildPuffs();
    this.buildScorch();
    this.buildPollen();
    this.setupPost();
    this.resize();
    this.ready = true;
  }

  setupPost() {
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: this.coarse ? 2 : 4 });
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
    const sorted = this.frameTimes.slice(30).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    this.frameTimes = null;
    if (median > 1 / 45) {
      this.lowPower = true;
      this.composer?.renderTarget1?.dispose();
      this.composer?.renderTarget2?.dispose();
      this.composer = null;
      for (const b of this.boomLights) this.scene.remove(b.light);
      this.boomLights = [];
      if (this.pollen) this.pollen.visible = false;
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
    const mesh = new THREE.Mesh(geo, this.decorate(new THREE.MeshStandardMaterial({ map: albedo, roughness: 0.95, metalness: 0 }), { key: 'ground' }));
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

  // Soft cloud shadows drift over the island (one texture fetch per pixel).
  cloudTexture() {
    if (this.cloudTex) return this.cloudTex;
    const S = 128, c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const img = g.createImageData(S, S);
    const rnd = rand(77);
    const grid = (n) => Array.from({ length: n * n }, () => rnd());
    const octs = [[4, grid(4), 0.55], [8, grid(8), 0.3], [16, grid(16), 0.15]];
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      let v = 0;
      for (const [n, gr, w] of octs) {
        const fx = x / S * n, fy = y / S * n, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
        const at = (i, j) => gr[((j % n + n) % n) * n + ((i % n + n) % n)];
        const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        v += w * ((at(ix, iy) * (1 - sx) + at(ix + 1, iy) * sx) * (1 - sy) + (at(ix, iy + 1) * (1 - sx) + at(ix + 1, iy + 1) * sx) * sy);
      }
      const k = (y * S + x) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = Math.round(v * 255);
      img.data[k + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    this.cloudTex = new THREE.CanvasTexture(c);
    this.cloudTex.wrapS = this.cloudTex.wrapT = THREE.RepeatWrapping;
    return this.cloudTex;
  }

  // Adds cloud shadows and (optionally) wind sway to a material. sway = { amp, height, rustle }.
  decorate(mat, { sway = null, clouds = true, key = '' } = {}) {
    const cloudTex = this.cloudTexture();
    const time = this.uniforms.time;
    mat.customProgramCacheKey = () => `deco:${key}:${sway ? `${sway.amp}/${sway.height}/${sway.rustle ? 1 : 0}` : ''}:${clouds ? 1 : 0}`;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.time = time;
      shader.uniforms.cloudTex = { value: cloudTex };
      let vs = shader.vertexShader.replace('#include <common>', `#include <common>
        uniform float time;
        varying vec3 vDecoW;
        ${sway?.rustle ? '#ifdef USE_INSTANCING\nattribute float rustle;\n#endif' : ''}`);
      vs = vs.replace('#include <project_vertex>', `
        vec4 mvPosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
        #endif
        vec4 decoW = modelMatrix * mvPosition;
        ${sway ? `
        {
          #ifdef USE_INSTANCING
            vec2 ip = floor(instanceMatrix[3].xz);
          #else
            vec2 ip = floor(modelMatrix[3].xz);
          #endif
          float h = clamp((decoW.y - (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).y) / ${sway.height.toFixed(2)}, 0.0, 1.0);
          h *= h;
          vec2 wind = vec2(sin(time * 1.6 + ip.x * 0.9 + ip.y * 0.4), cos(time * 1.1 + ip.y * 0.7) * 0.6) * ${sway.amp.toFixed(3)};
          ${sway.rustle ? `
          #ifdef USE_INSTANCING
            wind += vec2(sin(time * 26.0 + decoW.y * 7.0), cos(time * 23.0 + decoW.x * 5.0)) * 0.07 * rustle;
          #endif` : ''}
          decoW.xz += wind * h;
        }` : ''}
        vDecoW = decoW.xyz;
        mvPosition = viewMatrix * decoW;
        gl_Position = projectionMatrix * mvPosition;`);
      shader.vertexShader = vs;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float time;\nuniform sampler2D cloudTex;\nvarying vec3 vDecoW;')
        .replace('#include <map_fragment>', `#include <map_fragment>
          ${clouds ? `{
            float cl = smoothstep(0.42, 0.72, texture2D(cloudTex, vDecoW.xz * 0.035 + time * vec2(0.012, 0.007)).r);
            diffuseColor.rgb *= mix(1.0, 0.8, cl);
          }` : ''}`);
    };
    mat.needsUpdate = true;
    return mat;
  }

  // Walls and bushes never move: draw each variant as one instanced mesh.
  // `sway` makes foliage move in the wind; `rustle` is a per-instance shake array (bushes).
  instanced(name, transforms, { cast = true, sway = null, rustle = null, clouds = false } = {}) {
    const group = new THREE.Group();
    const src = this.models[name];
    src.updateMatrixWorld(true);
    const rustleAttr = rustle ? new THREE.InstancedBufferAttribute(rustle, 1) : null;
    if (rustleAttr) rustleAttr.setUsage(THREE.DynamicDrawUsage);
    this.decoMats ??= new Map();
    src.traverse((o) => {
      if (!o.isMesh) return;
      let material = o.material, geometry = o.geometry;
      if (sway || clouds) {
        const k = `${name}|${material.uuid}`;
        if (!this.decoMats.has(k)) {
          // Foliage outlines need their own copy so they sway with the leaves (characters share outlineMat).
          const m = material.clone();
          this.decorate(m, { sway: sway && { ...sway, rustle: Boolean(rustle) }, clouds: clouds && material !== this.outlineMat, key: name });
          this.decoMats.set(k, m);
        }
        material = this.decoMats.get(k);
      }
      if (rustleAttr) { geometry = geometry.clone(); geometry.setAttribute('rustle', rustleAttr); }
      const im = new THREE.InstancedMesh(geometry, material, transforms.length);
      const local = o.matrixWorld.clone();
      transforms.forEach((m, i) => im.setMatrixAt(i, new THREE.Matrix4().multiplyMatrices(m, local)));
      im.castShadow = cast && o.material !== this.outlineMat;
      im.receiveShadow = true;
      group.add(im);
    });
    group.userData.rustle = rustleAttr;
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
    walls.forEach((list, v) => list.length && this.instanced(`wall${v}`, list, { clouds: true }));
    this.bushRustle = bushes.map((list) => new Float32Array(Math.max(1, list.length)));
    this.bushGroups = bushes.map((list, v) => (list.length
      ? this.instanced(`bush${v}`, list, { sway: { amp: 0.035, height: 0.9 }, rustle: this.bushRustle[v], clouds: true }) : null));
    this.bushByTile = new Map(this.bushTiles.map((b) => [`${b.r},${b.c}`, b]));
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
    this.groundAt = at;

    // Grass tufts that sway in the wind.
    const tuft = this.makeTuft();
    const tufts = [];
    for (let i = 0; tufts.length < 6000 && i < 50000; i++) {
      const x = rnd() * N, z = rnd() * N;
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
    for (let i = 0; flowers.length < 1200 && i < 40000; i++) {
      const x = rnd() * N, z = rnd() * N;
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
      const along = -1.5 + f * (N + 3) + (rnd() - 0.5) * jitter;
      const off = d + (rnd() - 0.5) * jitter * 0.3;
      return [[along, -off], [N + off, along], [N - along, N + off], [-off, N - along]][side];
    });
    const place = (name, pts, scale = 1, yaw = true) => this.instanced(name, pts.map(([x, z]) => new THREE.Matrix4().compose(
      new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw ? rnd() * Math.PI * 2 : 0),
      new THREE.Vector3().setScalar(scale * (0.85 + rnd() * 0.35)))));
    // Palms lean out toward the sea so their crowns never hide the arena.
    // None on the south beach: the camera looks north, so they'd block the bottom of the screen.
    const palms = ring(0.5, 44, 1.0).filter(([, z]) => z < N - 1);
    for (const v of [0, 1]) {
      this.instanced(`palm${v}`, palms.filter((_, i) => i % 2 === v).map(([x, z]) => new THREE.Matrix4().compose(
        new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-(z - C), x - C) + (rnd() - 0.5) * 0.6),
        new THREE.Vector3().setScalar(0.85 + rnd() * 0.3))), { sway: { amp: 0.09, height: 3.0 }, clouds: true });
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
    this.fishData = ring(2.1, 50, 3.5).map(([x, z]) => ({ x, z, r: 0.35 + rnd() * 0.8, w: (0.4 + rnd() * 0.6) * (rnd() < 0.5 ? -1 : 1), ph: rnd() * 6.28, s: 0.7 + rnd() * 0.6 }));
    this.scene.add(this.fish);
    // Crabs scuttling sideways along the beach.
    this.crabs = this.dynamicInstanced('crab', 10);
    this.crabData = ring(0.32, 10, 4).map(([x, z]) => {
      const out = Math.atan2(z - C, x - C);
      return { x, z, tx: -Math.sin(out), tz: Math.cos(out), yaw: -out + Math.PI / 2, ph: rnd() * 6.28, sp: 0.5 + rnd() * 0.6 };
    });
  }

  // One pooled, instanced particle system for dust, smoke, leaves and chips: 1 draw call.
  softDisc() {
    if (this.discTex) return this.discTex;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.5, 'rgba(255,255,255,0.6)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    this.discTex = new THREE.CanvasTexture(c);
    return this.discTex;
  }

  // An instanced mesh whose instances each carry an alpha.
  alphaPool(geo, mat, n) {
    const alpha = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    alpha.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('alpha', alpha);
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute float alpha;\nvarying float vAlpha;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAlpha = alpha;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vAlpha;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vAlpha;');
    };
    mat.customProgramCacheKey = () => 'alphaPool';
    const im = new THREE.InstancedMesh(geo, mat, n);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false;
    const hide = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < n; i++) { im.setMatrixAt(i, hide); im.setColorAt(i, new THREE.Color('#ffffff')); }
    this.scene.add(im);
    return { im, alpha };
  }

  buildPuffs() {
    const N = 160;
    const { im, alpha } = this.alphaPool(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: this.softDisc(), transparent: true, depthWrite: false }), N);
    im.renderOrder = 6;
    this.puffs = { im, alpha, n: N, next: 0, live: 0, p: Array.from({ length: N }, () => ({ life: 0, age: 1 })) };
  }

  // Spawn one particle (world units). Recycles the oldest slot when the pool is full.
  puff(x, y, z, o = {}) {
    const P = this.puffs;
    if (!P || (this.lowPower && P.live > 60)) return;
    const q = P.p[P.next];
    const i = P.next;
    P.next = (P.next + 1) % P.n;
    Object.assign(q, {
      x, y, z, vx: o.vx ?? 0, vy: o.vy ?? 0, vz: o.vz ?? 0, age: 0, life: o.life ?? 0.5,
      s0: o.size ?? 0.15, s1: o.size1 ?? (o.size ?? 0.15) * 2, a0: o.alpha ?? 0.5, g: o.gravity ?? 0, drag: o.drag ?? 0.92,
      flutter: o.flutter ?? 0, floor: o.floor ?? 0.02, ph: Math.random() * 6.28,
    });
    P.im.setColorAt(i, this.tmpColor.set(o.color ?? '#ffffff'));
    P.im.instanceColor.needsUpdate = true;
  }

  stepPuffs(dt) {
    const P = this.puffs;
    if (!P) return;
    const m = this.tmpM, pos = this.tmpV, sc = this.tmpS, q = this.camera.quaternion;
    let live = 0;
    for (let i = 0; i < P.n; i++) {
      const u = P.p[i];
      if (u.age >= u.life) {
        if (u.life) { P.alpha.array[i] = 0; P.im.setMatrixAt(i, m.makeScale(0, 0, 0)); u.life = 0; }
        continue;
      }
      live++;
      u.age += dt;
      const k = Math.min(1, u.age / u.life);
      const d = Math.pow(u.drag, dt * 60);
      u.vx *= d; u.vz *= d; u.vy = u.vy * d - u.g * dt;
      u.x += (u.vx + Math.sin(u.age * 9 + u.ph) * u.flutter) * dt;
      u.y = Math.max(u.floor, u.y + u.vy * dt);
      u.z += (u.vz + Math.cos(u.age * 7 + u.ph) * u.flutter * 0.6) * dt;
      const size = u.s0 + (u.s1 - u.s0) * k;
      P.im.setMatrixAt(i, m.compose(pos.set(u.x, u.y, u.z), q, sc.set(size, size, size)));
      P.alpha.array[i] = u.a0 * (1 - k) * Math.min(1, u.age / 0.06);
    }
    P.live = live;
    P.im.instanceMatrix.needsUpdate = true;
    P.alpha.needsUpdate = true;
  }

  // Scorch marks from explosions, fading over 8 s.
  buildScorch() {
    // White soft disc tinted per instance (same recipe as the puffs, so colours come out right).
    const { im, alpha } = this.alphaPool(new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: this.softDisc(), transparent: true, depthWrite: false }), 16);
    const soot = new THREE.Color('#2a2018');
    for (let i = 0; i < 16; i++) im.setColorAt(i, soot);
    im.renderOrder = 1;
    this.scorch = { im, alpha, next: 0, born: new Float32Array(16).fill(-1e9) };
  }

  addScorch(x, z, r, now) {
    const S = this.scorch;
    if (!S) return;
    const i = S.next;
    S.next = (S.next + 1) % 16;
    S.born[i] = now;
    S.im.setMatrixAt(i, this.tmpM.compose(this.tmpV.set(x, 0.045, z), this.tmpQ.setFromAxisAngle(this.up, Math.random() * 6.28), this.tmpS.set(r, 1, r)));
    S.im.instanceMatrix.needsUpdate = true;
  }

  stepScorch(now) {
    const S = this.scorch;
    if (!S) return;
    for (let i = 0; i < 16; i++) S.alpha.array[i] = Math.min(0.7, Math.max(0, 0.7 * (1 - (now - S.born[i]) / 8000)));
    S.alpha.needsUpdate = true;
  }

  // Pollen and seeds drifting in the sunlight around the camera.
  buildPollen() {
    const n = 110, pos = new Float32Array(n * 3);
    const rnd = rand(9);
    this.pollenSeed = Array.from({ length: n }, () => ({ x: (rnd() - 0.5) * 18, y: 0.3 + rnd() * 2.2, z: (rnd() - 0.5) * 14, s: 0.2 + rnd() * 0.5, ph: rnd() * 6.28 }));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.pollen = new THREE.Points(geo, new THREE.PointsMaterial({ map: this.softDisc(), color: '#fff6d0', size: 0.07, transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.pollen.frustumCulled = false;
    this.scene.add(this.pollen);
  }

  stepPollen(t) {
    if (!this.pollen?.visible) return;
    const a = this.pollen.geometry.attributes.position.array, cx = this.camTarget.x, cz = this.camTarget.z;
    const wrap = (v, span) => ((v % span) + span * 1.5) % span - span / 2;
    this.pollenSeed.forEach((p, i) => {
      a[i * 3] = cx + wrap(p.x + t * p.s * 0.6 - cx, 18) + Math.sin(t * 0.7 + p.ph) * 0.3;
      a[i * 3 + 1] = p.y + Math.sin(t * 1.3 + p.ph) * 0.25;
      a[i * 3 + 2] = cz + wrap(p.z + t * p.s * 0.25 - cz, 14);
    });
    this.pollen.geometry.attributes.position.needsUpdate = true;
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

  buildGemMine() {
    this.gemObjs = new Map();
    this.gemGeo = new THREE.OctahedronGeometry(0.2, 0).scale(0.8, 1.25, 0.8);
    this.gemMat = new THREE.MeshStandardMaterial({ color: '#b56cf0', emissive: '#7a2fd0', emissiveIntensity: 0.9, roughness: 0.15, metalness: 0.1 });
    const mine = new THREE.Group();
    const stone = new THREE.MeshStandardMaterial({ color: '#8f8a80', roughness: 0.9 });
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.22 + (i % 3) * 0.04, 0), stone);
      rock.position.set(Math.cos(a) * 0.85, 0.12, Math.sin(a) * 0.85);
      rock.rotation.set(i, i * 2, 0);
      rock.castShadow = true;
      mine.add(rock);
    }
    const pit = new THREE.Mesh(new THREE.CircleGeometry(0.75, 32).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#3b2f40', roughness: 1 }));
    pit.position.y = 0.02;
    const crystal = new THREE.Group();
    for (let i = 0; i < 5; i++) {
      const c = new THREE.Mesh(this.gemGeo, this.gemMat);
      const a = (i / 5) * Math.PI * 2;
      c.position.set(Math.cos(a) * 0.25, 0.25 + (i % 2) * 0.1, Math.sin(a) * 0.25);
      c.rotation.set(Math.cos(a) * 0.5, 0, Math.sin(a) * 0.5);
      c.scale.setScalar(1.2 + (i % 3) * 0.3);
      crystal.add(c);
    }
    mine.add(pit, crystal);
    mine.userData.crystal = crystal;
    mine.position.set(C, 0, C);
    mine.visible = false;
    this.gemMine = mine;
    this.scene.add(mine);
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
      obj.rotation.order = 'ZXY'; // yaw first, then lean about world axes
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
      const boost = new THREE.Sprite(this.glowMat('drink'));
      boost.scale.setScalar(2.2);
      boost.position.y = 0.5;
      boost.visible = false;
      const holder = new THREE.Group();
      holder.add(obj, ring, boost);
      this.scene.add(holder);
      e = { obj: holder, model: obj, ring, boost, mats: [...mats.values()], piv, vel: new THREE.Vector2(), lean: new THREE.Vector2(), leanV: new THREE.Vector2(), sq: 0, sqv: 0, step: 0, brawler: p.brawler, phase: 0, last: null, yaw: Math.PI / 2 - p.aim, superRing: null, su: -1 };
      this.players.set(p.id, e);
    }
    e.seen = true;
    return e;
  }

  colorOf(p) {
    if (p.isMe) return ME;
    return this.teams && p.team === this.myTeam ? ALLY : FOE;
  }

  updatePlayer(p, now, dt, flash) {
    const e = this.charObj(p);
    e.ring.material.color.set(this.colorOf(p));
    const x = p.x * U, z = p.y * U;
    const moved = e.last ? Math.hypot(x - e.last.x, z - e.last.z) : 0;
    const vx = e.last && dt > 0 ? (x - e.last.x) / dt : 0, vz = e.last && dt > 0 ? (z - e.last.z) / dt : 0;
    e.last = { x, z };
    const speed = dt > 0 ? moved / dt : 0;
    // Body lags behind changes of speed: spring-damped lean into acceleration (purely visual).
    if (dt > 0 && dt < 0.1 && speed < 30) {
      const ax = THREE.MathUtils.clamp((vx - e.vel.x) / dt, -40, 40), az = THREE.MathUtils.clamp((vz - e.vel.y) / dt, -40, 40);
      let tx = ax * 0.02 + vx * 0.012, tz = az * 0.02 + vz * 0.012;
      if (p.dash === 1) { tx += vx * 0.03; tz += vz * 0.03; }
      const tl = Math.hypot(tx, tz);
      if (tl > 0.25) { tx *= 0.25 / tl; tz *= 0.25 / tl; }
      e.leanV.x += (140 * (tx - e.lean.x) - 14 * e.leanV.x) * dt;
      e.leanV.y += (140 * (tz - e.lean.y) - 14 * e.leanV.y) * dt;
      e.lean.x += e.leanV.x * dt;
      e.lean.y += e.leanV.y * dt;
      // Landing / launch squash spring.
      e.sqv += (-260 * e.sq - 16 * e.sqv) * dt;
      e.sq += e.sqv * dt;
    }
    e.vel.set(vx, vz);
    e.walk = THREE.MathUtils.lerp(e.walk ?? 0, speed > 0.5 ? 1 : 0, Math.min(1, dt * 10));
    e.phase += dt * 11 * e.walk;
    e.obj.position.set(x, 0, z);
    // Turn smoothly toward the aim.
    const target = Math.PI / 2 - p.aim;
    let d = ((target - e.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    e.yaw += d * Math.min(1, dt * 18);
    const sw = this.swaps.get(p.id);
    const spin = sw && now - sw.at < 350 ? ((now - sw.at) / 350) * Math.PI * 2 : 0;
    e.model.rotation.y = e.yaw + spin;
    const kv = Math.hypot(p.kx || 0, p.ky || 0);
    const lean = Math.min(1, kv / 1400) * 0.44;
    e.model.rotation.x = (kv ? lean * ((p.ky || 0) / kv) : 0) + e.lean.y;
    e.model.rotation.z = (kv ? -lean * ((p.kx || 0) / kv) : 0) - e.lean.x;
    const sq = THREE.MathUtils.clamp(e.sq, -0.3, 0.4);
    const sy = 1 - 0.15 * flash - 0.28 * sq, sxz = 1 + 0.15 * flash + 0.18 * sq;
    e.model.scale.set(CHAR_SCALE * sxz, CHAR_SCALE * sy, CHAR_SCALE * sxz);
    // Footsteps kick up dust (sand-coloured on paths, faint green-grey on grass).
    const stepN = Math.floor(e.phase / Math.PI);
    if (stepN !== e.step && e.walk > 0.5 && !p.fly) {
      e.step = stepN;
      const side = stepN % 2 ? 0.15 : -0.15, yaw = e.yaw;
      const fx = x + Math.cos(yaw) * side, fz = z - Math.sin(yaw) * side;
      const [r, gg] = this.groundAt ? this.groundAt(fx, fz) : [200, 180];
      const sand = r > gg * 1.05;
      this.puff(fx, 0.06, fz, { vx: -vx * 0.08 + (Math.random() - 0.5) * 0.4, vy: 0.5, vz: -vz * 0.08 + (Math.random() - 0.5) * 0.4, size: 0.14, size1: 0.32, life: 0.45, alpha: sand ? 0.45 : 0.28, color: sand ? '#d8c39a' : '#a9b27a', drag: 0.9 });
    } else if (stepN !== e.step) e.step = stepN;
    if (p.dash === 1 && now - (e.dustAt ?? 0) > 40) {
      e.dustAt = now;
      this.puff(x, 0.08, z, { vx: (Math.random() - 0.5) * 1.2, vy: 0.7, vz: (Math.random() - 0.5) * 1.2, size: 0.2, size1: 0.5, life: 0.55, alpha: 0.45, color: '#cdb892' });
    }
    // Pushing through a bush: it shakes and sheds a few leaves.
    const bkey = p.bush ? `${Math.floor(p.y / TILE)},${Math.floor(p.x / TILE)}` : null;
    if (bkey) {
      const b = this.bushByTile?.get(bkey);
      if (b && speed > 0.5) this.rustleBush(b, 1);
      if (b && bkey !== e.bushKey) this.leafBurst(b.c + 0.5, b.r + 0.5, 6);
    }
    e.bushKey = bkey;
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
    // Jump pad arc; the winner hops for joy.
    const lift = p.fly ? Math.sin(Math.PI * p.fly) * 2.2 : 0;
    const hop = this.champ === p.id ? Math.abs(Math.sin(now / 180)) * 0.45 : 0;
    e.model.position.y = lift + hop + (p.dash && !p.fly ? 0.08 : 0);
    e.boost.visible = Boolean(p.boost);
    if (p.boost) e.boost.material.opacity = 0.65 + 0.35 * Math.sin(now / 90);
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

  rustleBush(b, amount) {
    const arr = this.bushRustle?.[b.v];
    if (!arr) return;
    arr[b.index] = Math.max(arr[b.index], amount);
    this.rustling = true;
  }

  leafBurst(x, z, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = 0.6 + Math.random() * 0.9;
      this.puff(x + Math.cos(a) * 0.2, 0.7 + Math.random() * 0.2, z + Math.sin(a) * 0.2, {
        vx: Math.cos(a) * v, vy: 1.2 + Math.random(), vz: Math.sin(a) * v, gravity: 4, drag: 0.97, flutter: 0.5,
        size: 0.09, size1: 0.07, life: 0.9, alpha: 0.95, color: Math.random() < 0.5 ? '#3f8f3a' : '#6fbf4a',
      });
    }
  }

  // Camera shake as a damped spring pushed away from the source (world game coords), not white noise.
  shake(amount, fromX = null, fromY = null) {
    let dx = Math.random() - 0.5, dz = Math.random() - 0.5;
    if (fromX != null) { dx = this.camTarget.x - fromX * U; dz = this.camTarget.z - fromY * U; }
    const d = Math.hypot(dx, dz) || 1;
    this.kickV.x += (dx / d) * amount * 0.12;
    this.kickV.y += (dz / d) * amount * 0.12;
  }

  flashLight(x, z, big, now) {
    const b = this.boomLights.reduce((o, l) => (!o || l.born < o.born ? l : o), null);
    if (!b) return;
    b.born = now;
    b.peak = big ? 110 : 60;
    b.light.position.set(x, 0.8, z);
  }

  disposeObj(obj) {
    obj.traverse((o) => {
      if (!o.isMesh) return;
      if (!o.geometry.userData.shared) o.geometry.dispose();
      if (!o.material.userData?.shared) o.material.dispose?.();
    });
  }

  // Knocked out: the body is flung along the killing blow, tumbles, bounces once, then poofs.
  tumble(e, ev, now) {
    const ent = this.players.get(ev.id);
    if (!ent) return;
    this.players.delete(ev.id);
    this.koBodies.set(ev.id, now + 1100);
    ent.ring.visible = false;
    ent.boost.visible = false;
    if (ent.superRing) ent.superRing.visible = false;
    for (const m of ent.mats) { m.opacity = 1; m.transparent = false; m.emissive?.setScalar(0); }
    const pos = ent.obj.position.clone();
    const killer = ev.by ? (this.players.get(ev.by)?.obj.position ?? null) : null;
    let dx = killer ? pos.x - killer.x : Math.random() - 0.5, dz = killer ? pos.z - killer.z : Math.random() - 0.5;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d; dz /= d;
    const vel = new THREE.Vector3(dx * 4.5, 5.5, dz * 4.5);
    const axis = new THREE.Vector3(dz, 0, -dx).normalize();
    let spin = 9, bounces = 0, last = 0, poofed = false;
    const body = ent.model;
    this.scene.remove(ent.obj);
    const holder = new THREE.Group();
    holder.position.copy(pos);
    holder.add(body);
    body.position.set(0, 0, 0);
    this.fx.push({ obj: holder, born: now, life: 1.1, keep: true, update: (k) => {
      const t = k * 1.1, dt = Math.max(0, t - last);
      last = t;
      vel.y -= 16 * dt;
      holder.position.addScaledVector(vel, dt);
      if (holder.position.y < 0) {
        holder.position.y = 0;
        if (bounces++ === 0) { vel.y = -vel.y * 0.35; vel.x *= 0.6; vel.z *= 0.6; spin *= 0.5; } else { vel.set(0, 0, 0); spin = 0; }
        this.puff(holder.position.x, 0.08, holder.position.z, { vy: 0.6, size: 0.3, size1: 0.7, life: 0.5, alpha: 0.5, color: '#d8c39a' });
      }
      holder.rotateOnWorldAxis(axis, spin * dt);
      if (k > 0.8) holder.scale.setScalar(Math.max(0.001, (1 - k) / 0.2));
      if (k > 0.8 && !poofed) {
        poofed = true;
        for (let i = 0; i < 10; i++) {
          const a = Math.random() * 6.28;
          this.puff(holder.position.x, holder.position.y + 0.4, holder.position.z, { vx: Math.cos(a) * 1.5, vy: 1 + Math.random(), vz: Math.sin(a) * 1.5, size: 0.25, size1: 0.6, life: 0.6, alpha: 0.8, color: '#ffffff' });
        }
      }
    } });
    this.scene.add(holder);
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
      if (!o.seen) { this.scene.remove(o.obj); if (o.disposable) this.disposeObj(o.obj); map.delete(k); }
    }
  }

  // ------------------------------------------------------------ effects

  addEvent(e, now) {
    if (e.k === 'dmg') {
      this.flashes.set(e.id, now);
      this.floaters.push({ ...e, born: now, life: 0.9 });
      return;
    }
    if (e.k === 'cube' || e.k === 'gem') { this.floaters.push({ ...e, born: now, life: 0.9 }); return; }
    if (!this.ready) return;
    const at = new THREE.Vector3(e.x * U, 0, e.y * U);
    const add = (obj, life, update) => { this.scene.add(obj); this.fx.push({ obj, born: now, life, update }); };
    // Debris with real-ish physics: gravity, one bounce off the ground, spin, then fade.
    const burst = (n, color, speed, size, upward, life, plank = false) => {
      const g = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color, transparent: true, roughness: 0.8 });
      this.burstGeos ??= new Map();
      const gk = `${plank}:${size}`;
      if (!this.burstGeos.has(gk)) {
        const ng = plank ? new THREE.BoxGeometry(size * 2.6, size * 0.6, size) : new THREE.IcosahedronGeometry(size, 0);
        ng.userData.shared = true;
        this.burstGeos.set(gk, ng);
      }
      const geo = this.burstGeos.get(gk);
      const parts = Array.from({ length: n }, () => {
        const m = new THREE.Mesh(geo, mat);
        const a = Math.random() * Math.PI * 2;
        const v = speed * (0.5 + Math.random());
        m.userData = { v: new THREE.Vector3(Math.cos(a) * v, upward * (0.6 + Math.random() * 0.6), Math.sin(a) * v), bounced: false, spin: (Math.random() - 0.5) * 14 };
        m.castShadow = plank;
        g.add(m);
        return m;
      });
      g.position.copy(at).setY(0.35);
      let last = 0;
      add(g, life, (k) => {
        const dt = Math.max(0, k * life - last);
        last = k * life;
        for (const m of parts) {
          const u = m.userData;
          u.v.y -= 14 * dt;
          m.position.addScaledVector(u.v, dt);
          if (m.position.y < -0.33) {
            m.position.y = -0.33;
            if (!u.bounced) { u.v.y = -u.v.y * 0.3; u.v.x *= 0.5; u.v.z *= 0.5; u.bounced = true; } else { u.v.set(0, 0, 0); u.spin = 0; }
          }
          m.rotation.x += u.spin * dt;
          m.rotation.z += u.spin * 0.7 * dt;
        }
        mat.opacity = Math.min(1, (1 - k) * 2.5);
      });
    };
    if (e.k === 'shot') {
      // Muzzle flash + a little smoke from the barrel (lobs and punches get none).
      const kind = { shotgun: 'p', bullet: 'b' }[e.w];
      const ent = this.players.get(e.id);
      if (!kind || !ent) return;
      const a = e.a ?? (Math.PI / 2 - ent.yaw), c = Math.cos(a), sn = Math.sin(a);
      const fx = ent.obj.position.x + c * 0.55, fz = ent.obj.position.z + sn * 0.55;
      const flash = new THREE.Sprite(this.glowMat(kind));
      flash.position.set(fx, 0.75, fz);
      add(flash, 0.08, (k) => flash.scale.setScalar(1.1 - 0.7 * k));
      for (let i = 0; i < 2; i++) this.puff(fx, 0.75, fz, { vx: c * 0.8 + (Math.random() - 0.5) * 0.4, vy: 0.6, vz: sn * 0.8 + (Math.random() - 0.5) * 0.4, size: 0.18, size1: 0.42, life: 0.5, alpha: 0.35, color: '#d9d4c8' });
      return;
    }
    if (e.k === 'boom' || e.k === 'meteor') {
      this.addScorch(at.x, at.z, e.r * U * 0.8, now);
      this.flashLight(at.x, at.z, e.big || e.k === 'meteor', now);
      if (tileAt(e.x, e.y) === 'w') this.splash(e.x, e.y, now);
      for (let i = 0; i < (e.big || e.k === 'meteor' ? 10 : 6); i++) {
        const a = Math.random() * 6.28, v = 1 + Math.random() * 1.5;
        this.puff(at.x + Math.cos(a) * 0.2, 0.2, at.z + Math.sin(a) * 0.2, { vx: Math.cos(a) * v, vy: 0.8 + Math.random(), vz: Math.sin(a) * v, size: 0.35, size1: 0.9, life: 0.9, alpha: 0.45, color: '#8a7d6c', drag: 0.9 });
      }
      // Nearby bushes get shaken by the blast.
      for (const b of this.bushTiles ?? []) if (Math.hypot(b.c + 0.5 - at.x, b.r + 0.5 - at.z) < e.r * U + 1) this.rustleBush(b, 1);
    }
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
      // Stone chips knocked off the wall.
      for (let i = 0; i < 3; i++) {
        const a = Math.random() * 6.28;
        this.puff(at.x, 0.7, at.z, { vx: Math.cos(a) * 1.4, vy: 1.5, vz: Math.sin(a) * 1.4, gravity: 12, drag: 0.98, size: 0.06, size1: 0.05, life: 0.4, alpha: 0.95, color: '#7a7368' });
      }
      this.puff(at.x, 0.7, at.z, { vy: 0.3, size: 0.2, size1: 0.45, life: 0.4, alpha: 0.35, color: '#cfc6b4' });
    } else if (e.k === 'ko') {
      if (!e.left && this.players.has(e.id)) this.tumble(this.players.get(e.id), e, now);
      else burst(16, '#ffffff', 2.5, 0.09, 3, 0.8);
    } else if (e.k === 'crateBreak') {
      burst(8, '#9a7046', 2.4, 0.09, 4.5, 1.2, true);
    } else if (e.k === 'crate') {
      const c = [...this.crateObjs.values()].find((o) => Math.hypot(o.obj.position.x - at.x, o.obj.position.z - at.z) < 0.3);
      if (c) c.hitAt = now;
    } else if (e.k === 'melee') {
      // Haymaker swoosh: a bright arc sweeping in front of the brawler.
      const b = BRAWLERS.brick.alt;
      const arc = new THREE.Mesh(new THREE.RingGeometry(0.35, b.range * U, 28, 1, -b.arc, b.arc * 2).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: '#fff3d0', transparent: true, depthWrite: false, side: THREE.DoubleSide }));
      arc.position.copy(at).setY(0.5);
      arc.rotation.y = -e.a;
      add(arc, 0.28, (k) => { arc.material.opacity = 0.7 * (1 - k); arc.scale.setScalar(0.7 + 0.4 * k); });
    } else if (e.k === 'swap') {
      this.swaps.set(e.id, { at: now, w: e.w });
    } else if (e.k === 'meteor') {
      const r = e.r * U;
      const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), new THREE.MeshBasicMaterial({ color: '#ffb347', transparent: true }));
      ball.position.copy(at).setY(0.2);
      add(ball, 0.6, (k) => {
        ball.scale.setScalar(r * (0.5 + 0.9 * k));
        ball.material.opacity = 0.9 * (1 - k);
        ball.material.color.lerpColors(new THREE.Color('#fff6c0'), new THREE.Color('#ff3b10'), k);
      });
      const wave = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#fff0d0', transparent: true, depthWrite: false }));
      wave.position.copy(at).setY(0.07);
      add(wave, 0.5, (k) => { wave.scale.setScalar(r * (0.6 + 1.6 * k)); wave.material.opacity = 0.9 * (1 - k); });
      burst(14, '#3d2f26', 3.5, 0.11, 5, 1.1, false);
      burst(10, '#ff7a2a', 2.5, 0.06, 4, 0.6, false);
    } else if (e.k === 'drink' || e.k === 'gadget' || e.k === 'shroom' || e.k === 'jump' || e.k === 'land') {
      const color = { drink: '#ff9a2a', gadget: '#7fe9d0', shroom: '#5fe0a4', jump: '#ffe08a', land: '#d8c39a' }[e.k];
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false }));
      ring.position.copy(at).setY(0.07);
      const R = e.k === 'shroom' ? 1.4 : e.k === 'land' ? 0.8 : 1;
      add(ring, 0.5, (k) => { ring.scale.setScalar(R * (0.3 + k)); ring.material.opacity = 1 - k; });
      if (e.k === 'land') {
        burst(8, '#c9b38a', 1.8, 0.07, 1.6, 0.6);
        const ent = this.players.get(e.id);
        if (ent) ent.sqv += 9;
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * 6.28;
          this.puff(at.x + Math.cos(a) * 0.3, 0.06, at.z + Math.sin(a) * 0.3, { vx: Math.cos(a) * 1.6, vy: 0.3, vz: Math.sin(a) * 1.6, size: 0.2, size1: 0.45, life: 0.5, alpha: 0.4, color: '#d8c39a', drag: 0.88 });
        }
      }
      if (e.k === 'jump') { const ent = this.players.get(e.id); if (ent) ent.sqv -= 7; }
      if (e.k === 'drink') burst(10, '#ffb347', 2, 0.05, 3, 0.6);
      if (e.k === 'gadget') this.gadgetPops.set(e.id, { at: now, g: e.g });
    } else if (e.k === 'heal') {
      this.floaters.push({ ...e, born: now, life: 1.1 });
    } else if (e.k === 'win') {
      const champ = this.players.get(e.id);
      if (champ) {
        const p = champ.obj.position;
        at.set(p.x, 0, p.z);
        burst(40, '#ffd34d', 3, 0.07, 6, 1.6);
        const glow = new THREE.Sprite(this.glowMat('gold'));
        glow.position.copy(at).setY(0.8);
        add(glow, 1.8, (k) => { glow.scale.setScalar(2 + 3 * Math.sin(Math.PI * k)); glow.material.opacity = 1 - k; });
      }
    } else if (e.k === 'haunt' || e.k === 'super' || e.k === 'spawn' || e.k === 'gemspawn') {
      if (e.k === 'super' && e.w === 'charge') burst(10, '#c9b38a', 2, 0.08, 1.5, 0.7); // dust kicked up by Bulldoze
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: { haunt: '#be96ff', super: '#ffd63c', spawn: '#7fe3c0', gemspawn: '#c97bff' }[e.k], transparent: true, depthWrite: false }));
      ring.position.copy(at).setY(0.06);
      const R = e.k === 'haunt' ? HAUNT.radius * U : 0.9;
      add(ring, 0.55, (k) => { ring.scale.setScalar(R * (0.3 + k)); ring.material.opacity = 1 - k; });
    }
  }

  // ------------------------------------------------------------ lobby stage: your brawler on a little island

  createStage(canvas) {
    const gl = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFSoftShadowMap;
    gl.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight('#cfe3ec', '#8c7a52', 1.1));
    const sun = new THREE.DirectionalLight('#ffd9a0', 2.8);
    sun.position.set(-3, 5, 4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3 });
    scene.add(sun);
    const island = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.4, 0.4, 48),
      new THREE.MeshStandardMaterial({ color: '#7b9a4c', roughness: 0.95 }));
    island.position.y = -0.2;
    island.receiveShadow = true;
    const sand = new THREE.Mesh(new THREE.CylinderGeometry(2.45, 2.6, 0.3, 48), new THREE.MeshStandardMaterial({ color: '#dcc7a0', roughness: 1 }));
    sand.position.y = -0.3;
    scene.add(island, sand);
    const prop = (name, x, z, sc, rot = 0) => {
      const o = this.models[name].clone(true);
      o.position.set(x, 0, z);
      o.scale.setScalar(sc);
      o.rotation.y = rot;
      scene.add(o);
    };
    prop('bush0', -1.45, -0.9, 1.1);
    prop('bush2', 1.5, -1.0, 1.0, 1);
    prop('wall0', 0.2, -1.6, 0.9);
    prop('palm1', 1.9, -1.7, 0.7, 2.2);
    prop('crate', -1.5, 0.6, 0.6, 0.4);
    const tuft = this.makeTuft();
    const tufts = new THREE.InstancedMesh(tuft.geometry, tuft.material, 90);
    const rnd = rand(77);
    for (let i = 0; i < 90; i++) {
      const a = rnd() * Math.PI * 2, r = 0.7 + rnd() * 1.4;
      tufts.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6), new THREE.Vector3().setScalar(1 + rnd())));
    }
    scene.add(tufts);
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    camera.position.set(0, 2.1, 5.4);
    camera.lookAt(0, 0.75, 0);
    let hero = null, piv = {}, current = null, running = false;
    const stage = {
      setBrawler: (id) => {
        if (id === current || !this.models[id]) return;
        current = id;
        if (hero) scene.remove(hero);
        hero = this.models[id].clone(true);
        hero.scale.setScalar(CHAR_SCALE * 1.15);
        piv = {};
        hero.traverse((o) => { if (PIVOTS.includes(o.name)) piv[o.name] = o; if (o.isMesh) o.castShadow = true; });
        scene.add(hero);
      },
      start: () => {
        if (running) return;
        running = true;
        const loop = (now) => {
          if (!running) return;
          requestAnimationFrame(loop);
          const w = canvas.clientWidth, h = canvas.clientHeight;
          if (!w || !h) return;
          if (canvas.width !== Math.round(w * gl.getPixelRatio())) { gl.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
          const t = now / 1000;
          this.uniforms.time.value = t;
          if (hero) {
            hero.rotation.y = 0.35 * Math.sin(t * 0.5);
            const s2 = Math.sin(t * 2.2);
            if (piv.upper) piv.upper.position.y = 0.015 * s2;
            if (piv.armLpiv) piv.armLpiv.rotation.x = 0.15 * s2;
          }
          gl.render(scene, camera);
        };
        requestAnimationFrame(loop);
      },
      stop: () => { running = false; },
    };
    return stage;
  }

  splash(x, y, now) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.16, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false }));
    ring.position.set(x * U, 0.05, y * U);
    this.scene.add(ring);
    this.fx.push({ obj: ring, born: now, life: 0.5, update: (k) => { ring.scale.setScalar(1 + k * 4); ring.material.opacity = 0.8 * (1 - k); } });
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
    this.teams = MODES[v.mode]?.teams;
    this.myTeam = v.me?.team;
    const t = now / 1000;
    this.uniforms.time.value = t;
    const flashOf = (id) => { const at = this.flashes.get(id); return at ? Math.max(0, 1 - (now - at) / 140) : 0; };

    // Camera follows the view's camera point, high and tilted like a diorama.
    // Camera kick: a damped spring that translates camera and target together (aim stays exact).
    if (dt > 0 && dt < 0.1) {
      this.kickV.x += (-220 * this.kick.x - 20 * this.kickV.x) * dt;
      this.kickV.y += (-220 * this.kick.y - 20 * this.kickV.y) * dt;
      this.kick.x += this.kickV.x * dt;
      this.kick.y += this.kickV.y * dt;
    }
    this.camTarget.set(v.cam.x * U + this.kick.x, 0, v.cam.y * U + this.kick.y);
    const pitch = THREE.MathUtils.degToRad(53);
    this.camera.position.set(this.camTarget.x, this.camDist * Math.sin(pitch), this.camTarget.z + this.camDist * Math.cos(pitch));
    this.camera.lookAt(this.camTarget);
    // Sun and its shadow box follow the camera.
    this.sun.target.position.copy(this.camTarget);
    this.sun.position.copy(this.camTarget).add(this.sunOffset);
    this.poisonMat.uniforms.radius.value = v.poison * U;
    this.poisonMesh.visible = v.poison < POISON.startR - 1;

    // Players
    for (const e of this.players.values()) e.seen = false;
    for (const [id, until] of this.koBodies) if (now > until) this.koBodies.delete(id);
    for (const p of v.players) if (!this.koBodies.has(p.id)) this.updatePlayer(p, now, dt, flashOf(p.id));
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
          if (o.isMesh) {
            const src = this.decoMats?.get(`bush${tile.v}|${o.material.uuid}`) ?? o.material;
            o.material = src.clone();
            o.material.onBeforeCompile = src.onBeforeCompile;
            o.material.customProgramCacheKey = src.customProgramCacheKey;
            o.material.transparent = true; o.material.opacity = 0.35; o.material.depthWrite = false; o.castShadow = false;
          }
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
    this.syncMap(this.cubeObjs, v.cubes, (c) => {
      let obj;
      if (c.k === 'drink') {
        // Energy Drink: a glowing can.
        obj = new THREE.Group();
        const can = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.42, 20), new THREE.MeshStandardMaterial({ color: '#ff8a1f', roughness: 0.35, metalness: 0.4, emissive: '#7a2c00' }));
        const band = new THREE.Mesh(new THREE.CylinderGeometry(0.165, 0.165, 0.12, 20), new THREE.MeshStandardMaterial({ color: '#fff1b0', roughness: 0.4 }));
        const top = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 0.05, 20), new THREE.MeshStandardMaterial({ color: '#c9c9c9', metalness: 0.8, roughness: 0.3 }));
        top.position.y = 0.235;
        can.castShadow = true;
        const glow = new THREE.Sprite(this.glowMat('drink'));
        glow.scale.setScalar(1.6);
        obj.add(can, band, top, glow);
      } else obj = this.models.cube.clone(true);
      this.scene.add(obj);
      return { obj, drink: c.k === 'drink' };
    }, (o, c) => {
      o.obj.position.set(c.x * U, (o.drink ? 0.35 : 0.1) + Math.sin(t * 3 + c.i) * 0.08, c.y * U);
      o.obj.rotation.y = t * 1.5 + c.i;
      if (o.drink) o.obj.rotation.z = Math.sin(t * 2) * 0.2;
    });

    // Projectiles
    const bulletMats = this.bulletMats ??= {
      b: new THREE.MeshBasicMaterial({ color: '#fff3a8' }),
      p: new THREE.MeshBasicMaterial({ color: '#ffb347' }),
      v: new THREE.MeshBasicMaterial({ color: '#7fe9ff' }),
      o: new THREE.MeshStandardMaterial({ color: '#b5653a', roughness: 0.7 }),
      bomb: new THREE.MeshStandardMaterial({ color: '#222228', roughness: 0.3 }),
      bigbomb: new THREE.MeshStandardMaterial({ color: '#7a1010', roughness: 0.3 }),
      zone: new THREE.MeshBasicMaterial({ color: '#ff3b3b', transparent: true, opacity: 0.22, depthWrite: false }),
    };
    for (const m of Object.values(bulletMats)) m.userData.shared = true;
    this.syncMap(this.projObjs, v.projs, (p) => {
      const obj = new THREE.Group();
      if (p.k === 'l') {
        const r = p.big ? 0.32 : 0.2;
        const bomb = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 10), p.big ? bulletMats.bigbomb : bulletMats.bomb);
        bomb.castShadow = true;
        const zone = new THREE.Mesh(new THREE.CircleGeometry(p.r * U, 40).rotateX(-Math.PI / 2), bulletMats.zone.clone());
        zone.position.set(p.tx * U, 0.05, p.ty * U);
        // Closing ring: shrinks from twice the blast to the blast edge as the bomb comes down.
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 40).rotateX(-Math.PI / 2),
          new THREE.MeshBasicMaterial({ color: '#ff5a3b', transparent: true, opacity: 0.85, depthWrite: false }));
        ring.position.set(p.tx * U, 0.06, p.ty * U);
        obj.add(bomb, zone, ring);
        bomb.geometry.userData.lob = true;
        obj.userData = { bomb, zone, ring, peak: 0.9 + 2.4 * Math.hypot(p.tx - p.sx, p.ty - p.sy) / 500 + (p.big ? 0.6 : 0) };
        this.scene.add(obj);
        return { obj, lob: true, disposable: true };
      }
      const r = p.k === 'p' ? 0.09 : p.k === 'o' ? 0.24 : 0.12;
      this.coreGeos ??= {};
      this.coreGeos[p.k] ??= Object.assign(new THREE.SphereGeometry(r, 10, 8), { userData: { shared: true } });
      const core = new THREE.Mesh(this.coreGeos[p.k], bulletMats[p.k]);
      const glow = new THREE.Sprite(this.glowMat(p.k));
      glow.scale.setScalar(r * 6);
      obj.add(core, glow);
      let streak = null;
      if (p.k !== 'o') {
        // A bright tracer streak trailing the shot.
        streak = new THREE.Mesh(this.streakGeo(), this.streakMat(p.k));
        streak.visible = false;
        obj.add(streak);
      }
      this.scene.add(obj);
      return { obj, streak };
    }, (o, p) => {
      if (o.lob) {
        const gx = p.sx + (p.tx - p.sx) * p.p, gy = p.sy + (p.ty - p.sy) * p.p;
        const u = o.obj.userData;
        const h = Math.sin(Math.PI * p.p) * u.peak + 0.3;
        u.bomb.position.set(gx * U, h, gy * U);
        u.zone.material.opacity = 0.35 * (0.75 + 0.25 * Math.sin(now / 60));
        u.ring.scale.setScalar(p.r * U * (2 - Math.min(1, p.p)));
        const flash = p.p > 0.9;
        u.ring.material.color.set(flash ? '#ffffff' : '#ff5a3b');
        u.zone.material.color.set(flash ? '#ffd0c0' : '#ff3b3b');
        return;
      }
      if (o.streak && o.px != null && (p.x !== o.px || p.y !== o.py)) {
        o.streak.visible = true;
        o.streak.rotation.y = -Math.atan2(p.y - o.py, p.x - o.px);
      }
      o.px = p.x; o.py = p.y;
      o.obj.position.set(p.x * U, p.k === 'o' ? 0.26 : 0.75, p.y * U);
      if (p.k === 'o') o.obj.rotation.x += 0.4; // the Bowler rolls
      if (tileAt(p.x, p.y) === '*') {
        const b = this.bushByTile?.get(`${Math.floor(p.y / TILE)},${Math.floor(p.x / TILE)}`);
        if (b) { this.rustleBush(b, 0.6); if (!o.inBush) this.leafBurst(p.x * U, p.y * U, 2); }
        o.inBush = true;
      } else o.inBush = false;
      // Splash where shots cross a pond (once per crossing).
      const wet = tileAt(p.x, p.y) === 'w';
      if (wet && !o.wet) this.splash(p.x, p.y, now);
      o.wet = wet;
    });

    // Gems and the mine they come from
    this.gemMine.visible = v.mode === 'gemgrab';
    if (this.gemMine.visible) this.gemMine.userData.crystal.rotation.y = t * 0.6;
    this.syncMap(this.gemObjs, v.gems ?? [], () => {
      const obj = new THREE.Group();
      const gem = new THREE.Mesh(this.gemGeo, this.gemMat);
      gem.castShadow = true;
      const glow = new THREE.Sprite(this.glowMat('g'));
      glow.scale.setScalar(0.9);
      obj.add(gem, glow);
      obj.userData.gem = gem;
      this.scene.add(obj);
      return { obj };
    }, (o, g) => {
      o.obj.position.set(g.x * U, 0.35 + Math.sin(t * 3 + g.i) * 0.08, g.y * U);
      o.obj.userData.gem.rotation.y = t * 2 + g.i;
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

    // Match Twist zones: meteor warnings and healing mushroom rings
    this.syncMap(this.zoneObjs, v.zones ?? [], (z) => this.makeZone(z), (o, z) => {
      if (z.k === 'm') {
        const k = Math.max(0, Math.min(1, z.l / 1.6)); // 1 -> 0 as impact nears
        o.ring.scale.setScalar(z.r * U * (1 + k));
        o.disc.material.opacity = 0.18 + 0.22 * (1 - k) + 0.1 * Math.sin(now / (40 + 80 * k));
        o.rock.visible = z.l < 0.5;
        o.rock.position.y = 0.3 + 9 * Math.max(0, z.l) / 0.5;
        o.rock.rotation.x += 0.2;
      } else {
        o.disc.material.opacity = 0.28 * Math.min(1, z.l / 1.5) * (0.85 + 0.15 * Math.sin(now / 300));
        o.obj.rotation.y = t * 0.2;
      }
    });
    for (const pad of this.padObjs) pad.userData.arrow.position.y = 0.09 + Math.abs(Math.sin(t * 4 + pad.position.x)) * 0.08;
    this.champ = v.champ;

    // Aim guide on the ground
    this.updateAim(v.aim);

    // Effects
    this.fx = this.fx.filter((f) => {
      const k = (now - f.born) / 1000 / f.life;
      if (k >= 1) { this.scene.remove(f.obj); if (!f.keep) this.disposeObj(f.obj); return false; }
      f.update(k);
      return true;
    });
    this.stepPuffs(Math.min(dt, 0.05));
    this.stepScorch(now);
    this.stepPollen(t);
    for (const b of this.boomLights) {
      const k = (now - b.born) / 300;
      b.light.intensity = k >= 0 && k < 1 ? b.peak * (1 - k) * (1 - k) : 0;
    }
    if (this.rustling) {
      this.rustling = false;
      const decay = Math.exp(-6 * dt);
      this.bushRustle.forEach((arr, vi) => {
        let any = false;
        for (let i = 0; i < arr.length; i++) { if (arr[i] > 0.01) { arr[i] *= decay; any = true; } else arr[i] = 0; }
        if (any) this.rustling = true;
        const attr = this.bushGroups[vi]?.userData.rustle;
        if (attr) attr.needsUpdate = true;
      });
    }

    this.animateWildlife(t);
    if (this.composer) this.composer.render(dt);
    else this.gl.render(this.scene, this.camera);
    this.watchPerf(dt);
    this.drawOverlay(v, now);
  }

  makeZone(z) {
    const obj = new THREE.Group();
    obj.position.set(z.x * U, 0, z.y * U);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(z.r * U, 44).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: z.k === 'm' ? '#ff2a1a' : '#5fe0a4', transparent: true, opacity: 0.25, depthWrite: false }));
    disc.position.y = 0.055;
    obj.add(disc);
    const out = { obj, disc };
    if (z.k === 'm') {
      out.ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 44).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: '#ff2a1a', transparent: true, opacity: 0.9, depthWrite: false }));
      out.ring.position.y = 0.06;
      out.rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.42, 0), new THREE.MeshStandardMaterial({ color: '#4a3528', emissive: '#ff4a10', emissiveIntensity: 0.6, roughness: 0.9 }));
      out.rock.castShadow = true;
      const tail = new THREE.Sprite(this.glowMat('meteor'));
      tail.scale.setScalar(1.8);
      out.rock.add(tail);
      obj.add(out.ring, out.rock);
      out.disposable = true;
    } else {
      // A little fairy ring of mushrooms.
      const stem = new THREE.MeshStandardMaterial({ color: '#f3ead2', roughness: 0.8 });
      const cap = new THREE.MeshStandardMaterial({ color: '#4fc28b', roughness: 0.6, emissive: '#1d5c3c' });
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2, r = z.r * U * (0.75 + 0.1 * Math.sin(i * 3));
        const m = new THREE.Group();
        const st = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.16, 8), stem);
        st.position.y = 0.08;
        const cp = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), cap);
        cp.position.y = 0.15;
        m.add(st, cp);
        m.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
        m.scale.setScalar(0.8 + 0.5 * ((i * 37) % 10) / 10);
        obj.add(m);
      }
      const glow = new THREE.Sprite(this.glowMat('heal'));
      glow.scale.setScalar(z.r * U * 1.6);
      out.disposable = true;
      glow.position.y = 0.2;
      glow.material.opacity = 0.4;
      obj.add(glow);
    }
    this.scene.add(obj);
    return out;
  }

  buildPads() {
    const padMat = new THREE.MeshStandardMaterial({ color: '#d9a441', roughness: 0.5, metalness: 0.3 });
    const rimMat = new THREE.MeshStandardMaterial({ color: '#7a5a2e', roughness: 0.7 });
    const arrowMat = new THREE.MeshBasicMaterial({ color: '#fff3c4' });
    const arrowShape = new THREE.Shape();
    arrowShape.moveTo(0.16, 0); arrowShape.lineTo(-0.08, -0.13); arrowShape.lineTo(-0.02, 0); arrowShape.lineTo(-0.08, 0.13); arrowShape.closePath();
    const arrowGeo = new THREE.ShapeGeometry(arrowShape).rotateX(-Math.PI / 2);
    for (const pad of JUMP_PADS) {
      const g = new THREE.Group();
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(JUMP.radius * U * 1.25, JUMP.radius * U * 1.35, 0.08, 28), rimMat);
      const top = new THREE.Mesh(new THREE.CylinderGeometry(JUMP.radius * U * 1.05, JUMP.radius * U * 1.05, 0.1, 28), padMat);
      rim.receiveShadow = top.receiveShadow = true;
      const arrow = new THREE.Group();
      for (const off of [-0.1, 0.1]) {
        const a = new THREE.Mesh(arrowGeo, arrowMat);
        a.position.x = off;
        arrow.add(a);
      }
      arrow.rotation.y = -Math.atan2(pad.dy, pad.dx);
      arrow.position.y = 0.09;
      g.add(rim, top, arrow);
      g.userData.arrow = arrow;
      g.position.set(pad.x * U, 0, pad.y * U);
      this.scene.add(g);
      this.padObjs.push(g);
    }
  }

  streakGeo() {
    if (!this.streakG) {
      // Flat quad from the head (x = 0) back to the tail (x = -0.9).
      this.streakG = new THREE.PlaneGeometry(0.9, 0.16).rotateX(-Math.PI / 2).translate(-0.45, 0, 0);
      this.streakG.userData.shared = true;
    }
    return this.streakG;
  }

  streakMat(kind) {
    this.streakMats ??= {};
    if (this.streakMats[kind]) return this.streakMats[kind];
    if (!this.streakTex) {
      const c = document.createElement('canvas');
      c.width = 64; c.height = 8;
      const g = c.getContext('2d');
      const grd = g.createLinearGradient(0, 0, 64, 0);
      grd.addColorStop(0, 'rgba(255,255,255,0)');
      grd.addColorStop(1, 'rgba(255,255,255,0.9)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 64, 8);
      this.streakTex = new THREE.CanvasTexture(c);
    }
    const col = { b: '#fff3a8', p: '#ffb347', v: '#7fe9ff' }[kind] ?? '#ffffff';
    const m = new THREE.MeshBasicMaterial({ map: this.streakTex, color: col, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    m.userData.shared = true;
    this.streakMats[kind] = m;
    return m;
  }

  glowMat(kind) {
    this.glowMats ??= {};
    if (this.glowMats[kind]) return this.glowMats[kind];
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const col = { b: '255,225,77', p: '255,138,0', v: '40,200,255', g: '190,110,255', o: '255,150,80', drink: '255,150,30', meteor: '255,110,30', heal: '110,240,170', gold: '255,210,80' }[kind];
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, `rgba(${col},0.9)`);
    grd.addColorStop(1, `rgba(${col},0)`);
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.glowMats[kind] = new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false });
    this.glowMats[kind].userData.shared = true;
    return this.glowMats[kind];
  }

  updateAim(a) {
    if (!a) { if (this.aimObj) this.aimObj.visible = false; return; }
    const b = weaponOf(a.brawler, a.super ? 0 : a.weapon || 0);
    const kind = a.super ? b.super.kind : b.attack;
    const key = `${a.brawler}:${a.super}:${a.weapon || 0}`;
    if (this.aimKey !== key) {
      if (this.aimObj) this.scene.remove(this.aimObj);
      const mat = new THREE.MeshBasicMaterial({ color: a.super ? '#ffd63c' : '#ffffff', transparent: true, opacity: 0.28, depthWrite: false });
      const range = (a.super ? b.super.range : b.range) * U;
      const g = new THREE.Group();
      if (kind === 'shotgun' || kind === 'volley' || kind === 'melee') {
        const spread = kind === 'volley' ? b.super.spread : kind === 'melee' ? b.arc * 2 : b.spread;
        g.add(new THREE.Mesh(new THREE.CircleGeometry(range, 32, -spread / 2, spread).rotateX(-Math.PI / 2), mat));
      } else if (kind === 'bullet' || kind === 'charge') {
        const w = (kind === 'charge' ? 52 : 18) * U;
        const geo = new THREE.PlaneGeometry(range, w).rotateX(-Math.PI / 2).translate(range / 2, 0, 0);
        g.add(new THREE.Mesh(geo, mat));
      } else {
        // Thrower: exactly where it lands (full damage inside, half at the rim), plus a dotted path.
        const blast = (a.super ? b.super.blast : b.blast) * U;
        const land = new THREE.Group();
        land.add(new THREE.Mesh(new THREE.CircleGeometry(blast, 40).rotateX(-Math.PI / 2), mat));
        land.add(new THREE.Mesh(new THREE.CircleGeometry(blast * 0.5, 32).rotateX(-Math.PI / 2),
          new THREE.MeshBasicMaterial({ color: a.super ? '#ffd63c' : '#ffffff', transparent: true, opacity: 0.25, depthWrite: false })));
        land.add(new THREE.Mesh(new THREE.RingGeometry(blast, blast + 13 * U, 40).rotateX(-Math.PI / 2),
          new THREE.MeshBasicMaterial({ color: a.super ? '#ffd63c' : '#ffffff', transparent: true, opacity: 0.8, depthWrite: false })));
        land.name = 'land';
        g.add(land);
        const dotMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.7, depthWrite: false });
        const dotGeo = new THREE.CircleGeometry(0.08, 12).rotateX(-Math.PI / 2);
        const dots = Array.from({ length: 10 }, () => new THREE.Mesh(dotGeo, dotMat));
        g.add(...dots);
        g.userData = { land, dots, min: ((a.super ? b.super.minRange : b.minRange) ?? 80) * U };
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
      const { land, dots, min } = this.aimObj.userData;
      const d = Math.min(this.aimRange, Math.max(min, a.dist * U));
      const c = Math.cos(a.angle), sn = Math.sin(a.angle);
      this.aimObj.position.set(x, 0.07, z);
      this.aimObj.rotation.y = 0;
      land.position.set(c * d, 0, sn * d);
      dots.forEach((dot, i) => {
        const k = (i + 1) / (dots.length + 1);
        dot.position.set(c * d * k, 0.01, sn * d * k);
      });
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
      const s = this.toScreen(null, p.x, p.y, 2.25 + (p.fly ? Math.sin(Math.PI * p.fly) * 2.2 : 0));
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
      ctx.fillStyle = this.colorOf(p);
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
      const badge = v.mode === 'gemgrab' && p.gems > 0 ? `💎 ${p.gems}` : v.mode === 'bounty' ? `⭐ ${p.stars ?? 2}` : '';
      if (badge) {
        ctx.font = '18px "Patrick Hand", system-ui';
        ctx.strokeText(badge, s.x, s.y - 36);
        ctx.fillStyle = v.mode === 'bounty' ? '#ffd56a' : '#e3b8ff';
        ctx.fillText(badge, s.x, s.y - 36);
      }
      if (p.em != null) this.bubbleAt(s.x, s.y - (badge ? 56 : 36), EMOTES[p.em]);
      const sw = this.swaps.get(p.id);
      if (sw && now - sw.at < 1000) {
        ctx.font = '26px system-ui';
        ctx.globalAlpha = 1 - (now - sw.at) / 1000;
        ctx.fillText(weaponOf(p.brawler, sw.w).icon, s.x, s.y - (badge ? 80 : 58));
        ctx.globalAlpha = 1;
      }
      const gp = this.gadgetPops.get(p.id);
      if (gp && now - gp.at < 1000) {
        ctx.font = '28px system-ui';
        ctx.globalAlpha = 1 - (now - gp.at) / 1000;
        ctx.fillText(BRAWLERS[gp.g].gadget.icon, s.x, s.y - (badge ? 80 : 58) - (now - gp.at) / 40);
        ctx.globalAlpha = 1;
      }
      if (p.isMe && v.me) {
        const f = this.toScreen(null, p.x, p.y, 0);
        const w = weaponOf(p.brawler, p.weapon || 0);
        ctx.font = '15px "Patrick Hand", system-ui';
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(40,28,18,0.85)';
        ctx.fillStyle = p.weapon ? '#ffcf7a' : '#f6eedb';
        const label = `${w.icon} ${w.weapon}${this.touch ? '' : ' · Q'}`;
        ctx.strokeText(label, f.x, f.y + 46);
        ctx.fillText(label, f.x, f.y + 46);
        if (!this.touch && v.me.gd != null) {
          const g = BRAWLERS[p.brawler].gadget;
          const ready = v.me.gd > 0 && !(v.me.gcd > 0);
          ctx.fillStyle = ready ? '#bff3e3' : 'rgba(246,238,219,0.55)';
          const gl = `${g.icon} ${g.name} · F · ${v.me.gd > 0 ? `${v.me.gd} left` : 'used up'}${v.me.gcd > 0 && v.me.gd > 0 ? ` (${Math.ceil(v.me.gcd)}s)` : ''}`;
          ctx.strokeText(gl, f.x, f.y + 64);
          ctx.fillText(gl, f.x, f.y + 64);
        }
        const seg = 18, gap = 3, total = MAX_AMMO * seg + (MAX_AMMO - 1) * gap;
        for (let i = 0; i < MAX_AMMO; i++) {
          const x = f.x - total / 2 + i * (seg + gap);
          ctx.fillStyle = 'rgba(0,0,0,0.6)';
          ctx.fillRect(x, f.y + 22, seg, 6);
          ctx.fillStyle = p.weapon ? '#ffcf7a' : '#ff9f1a';
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
      const text = f.k === 'dmg' ? `-${f.a}` : f.k === 'heal' ? `+${f.a}` : f.k === 'gem' ? '+1 💎' : '+1 ⚡';
      ctx.font = `900 ${f.k === 'dmg' ? 20 : 18}px system-ui`;
      ctx.globalAlpha = 1 - k * k;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.fillStyle = f.k === 'heal' ? '#7dffb0' : f.k === 'gem' ? '#e3b8ff' : f.k === 'cube' ? '#6dff9c' : f.src === 'poison' ? '#9dffa8' : f.src === 'haunt' ? '#cdb6ff' : '#ffdf5d';
      const x = s.x + ((f.id ?? 1) % 3 - 1) * 14, y = s.y - 20 - k * 40;
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
      ctx.globalAlpha = 1;
    }
    this.touch = Boolean(v.sticks);
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

