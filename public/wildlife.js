// Island wildlife: Blender-built animals (tools/blender/animals.py) brought to life procedurally.
// Purely cosmetic and local to each player's screen: seagulls, rabbits, frogs, ducks, turtles, dolphins,
// butterflies and dragonflies, each reacting to brawlers nearby.
import * as THREE from 'three';
import { MAP, MAP_TILES, TILE } from '/shared/game.js';

const N = MAP_TILES;
const U = 1 / TILE;
const TAU = Math.PI * 2;
const rnd = (a, b) => a + Math.random() * (b - a);
const tileAt = (x, z) => MAP[Math.floor(z)]?.[Math.floor(x)];
const walkable = (x, z) => { const t = tileAt(x, z); return t === '.' || t === '*'; };
const angTo = (dx, dz) => Math.atan2(dx, dz); // model forward is +Z

export const ANIMAL_PIVOTS = ['wingL', 'wingR', 'legs', 'head', 'earL', 'earR', 'legsB', 'throat', 'tail', 'flipFL', 'flipFR', 'flipBL', 'flipBR', 'body'];

// A point on the beach ring (d tiles outside the arena edge), parameter u in [0, 1).
function beachPoint(u, d) {
  const t = ((u % 1) + 1) % 1 * 4, side = Math.floor(t), f = t - side;
  const along = -1 + f * (N + 2);
  return [[along, -d], [N + d, along], [N - along, N + d], [-d, N - along]][side];
}

export class Wildlife {
  constructor(r) {
    this.r = r;
    this.animals = [];
    this.scale = r.coarse ? 0.6 : 1; // fewer animals on phones
  }

  spawn(name, scale) {
    const src = this.r.models[name];
    if (!src) return null;
    const obj = src.clone(true);
    obj.scale.setScalar(scale);
    const piv = {};
    obj.traverse((o) => { if (ANIMAL_PIVOTS.includes(o.name)) piv[o.name] = o; if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.r.scene.add(obj);
    return { obj, piv };
  }

  count(n) { return Math.max(1, Math.round(n * this.scale)); }

  build() {
    // Ponds: connected groups of water tiles.
    const seen = new Set();
    this.ponds = [];
    MAP.forEach((row, r) => [...row].forEach((ch, c) => {
      if (ch !== 'w' || seen.has(`${r},${c}`)) return;
      const tiles = [], stack = [[r, c]];
      while (stack.length) {
        const [rr, cc] = stack.pop();
        const k = `${rr},${cc}`;
        if (seen.has(k) || MAP[rr]?.[cc] !== 'w') continue;
        seen.add(k);
        tiles.push([rr, cc]);
        stack.push([rr + 1, cc], [rr - 1, cc], [rr, cc + 1], [rr, cc - 1]);
      }
      const x = tiles.reduce((s, t) => s + t[1] + 0.5, 0) / tiles.length, z = tiles.reduce((s, t) => s + t[0] + 0.5, 0) / tiles.length;
      this.ponds.push({ x, z, r: Math.sqrt(tiles.length) / 2 });
    }));
    // Open grass for rabbits and butterflies.
    this.grass = [];
    for (let i = 0; i < 4000 && this.grass.length < 400; i++) {
      const x = rnd(1, N - 1), z = rnd(1, N - 1);
      if (tileAt(x, z) === '.') this.grass.push([x, z]);
    }

    for (let i = 0; i < this.count(5); i++) this.addGull(true);
    for (let i = 0; i < this.count(4); i++) this.addGull(false);
    for (let i = 0; i < this.count(8); i++) this.addRabbit();
    for (const p of this.ponds) {
      for (let i = 0; i < (this.scale < 1 ? 1 : 2); i++) this.addDuck(p, i);
      this.addFrog(p);
    }
    for (let i = 0; i < this.count(3); i++) this.addTurtle(i);
    for (let i = 0; i < this.count(3); i++) this.addDolphin(i);
    this.buildButterflies(this.count(22));
    this.buildDragonflies(this.count(8));
  }

  // ---------------------------------------------------------------- seagulls

  addGull(flying) {
    const a = this.spawn('seagull', 1.2);
    if (!a) return;
    const g = { kind: 'gull', ...a, state: flying ? 'orbit' : 'stand', t: rnd(0, 10), flap: 0 };
    g.cx = rnd(6, N - 6); g.cz = rnd(6, N - 6); g.rad = rnd(4, 9); g.alt = rnd(3.5, 5.5); g.w = rnd(0.12, 0.22) * (Math.random() < 0.5 ? -1 : 1);
    g.home = beachPoint(Math.random(), rnd(0.5, 0.9));
    if (!flying) { g.x = g.home[0]; g.z = g.home[1]; g.y = 0.24; g.yaw = rnd(0, TAU); }
    this.animals.push(g);
  }

  updateGull(g, dt, t, near) {
    const { obj, piv } = g;
    g.t += dt;
    let flapAmp = 0, legsUp = 1, bank = 0;
    if (g.state === 'stand') {
      // Head bob and the odd stretch; takes off when someone comes close.
      piv.head && (piv.head.rotation.x = Math.sin(g.t * 3) * 0.1);
      if (near(g.x, g.z, 2.6)) { g.state = 'takeoff'; g.t = 0; g.yaw = rnd(0, TAU); }
      obj.position.set(g.x, g.y, g.z);
      legsUp = 0;
      this.foldWings(piv, 1);
    } else if (g.state === 'takeoff' || g.state === 'land') {
      // Rise (or settle) on a curve while flapping hard.
      const k = Math.min(1, g.t / 2.2);
      const from = g.state === 'takeoff' ? 0.24 : g.alt, to = g.state === 'takeoff' ? g.alt : 0.24;
      const e = g.state === 'takeoff' ? 1 - (1 - k) * (1 - k) : k * k;
      g.y = from + (to - from) * e;
      const spd = g.state === 'takeoff' ? 2.5 : 1.2 * (1 - k);
      g.x += Math.sin(g.yaw) * spd * dt; g.z += Math.cos(g.yaw) * spd * dt;
      flapAmp = g.state === 'takeoff' ? 0.75 : 0.45;
      legsUp = g.state === 'takeoff' ? k : 1 - k;
      obj.position.set(g.x, g.y, g.z);
      this.foldWings(piv, 0);
      if (k >= 1) {
        if (g.state === 'takeoff') { g.state = 'roam'; g.t = 0; g.cx = g.x - Math.cos(0) * 0; }
        else { g.state = 'stand'; g.t = 0; }
      }
    } else {
      // Soaring: big circles with flap-and-glide rhythm, banking into the turn.
      if (g.state === 'roam' && g.t > 12) { g.state = 'return'; g.t = 0; g.home = beachPoint(Math.random(), rnd(0.5, 0.9)); }
      let tx, tz;
      if (g.state === 'return') {
        tx = g.home[0]; tz = g.home[1];
        const d = Math.hypot(tx - g.x, tz - g.z);
        if (d < 1.2) { g.state = 'land'; g.t = 0; g.alt = g.y; }
      } else {
        const ang = g.t * g.w + (g.ph ??= rnd(0, TAU));
        tx = g.cx + Math.cos(ang) * g.rad; tz = g.cz + Math.sin(ang) * g.rad;
      }
      const want = angTo(tx - (g.x ?? tx), tz - (g.z ?? tz));
      g.x ??= tx; g.z ??= tz; g.y ??= g.alt; g.yaw ??= want;
      const dy = ((want - g.yaw + Math.PI) % TAU + TAU) % TAU - Math.PI;
      g.yaw += dy * Math.min(1, dt * 1.2);
      bank = THREE.MathUtils.clamp(-dy * 1.2, -0.6, 0.6);
      const spd = 2.6;
      g.x += Math.sin(g.yaw) * spd * dt; g.z += Math.cos(g.yaw) * spd * dt;
      g.y += ((g.state === 'return' ? 1.5 : g.alt + Math.sin(g.t * 0.4) * 0.5) - g.y) * dt * 0.6;
      flapAmp = (g.t % 5) < 1.6 ? 0.55 : 0.05; // flap, then glide
      obj.position.set(g.x, g.y, g.z);
      this.foldWings(piv, 0);
    }
    g.ph2 ??= rnd(0, TAU);
    const flap = Math.sin(t * 11 + g.ph2) * flapAmp + (flapAmp < 0.1 ? 0.12 : 0);
    if (g.state !== 'stand') {
      if (piv.wingL) piv.wingL.rotation.z = flap;
      if (piv.wingR) piv.wingR.rotation.z = -flap;
    }
    if (piv.legs) piv.legs.rotation.x = -1.3 * legsUp;
    obj.rotation.set(0, g.yaw, 0);
    obj.rotateZ(bank);
  }

  foldWings(piv, k) {
    // k = 1: folded back along the body (standing); 0: spread.
    // Folded: swept a little past parallel so the wings hug the body, rolled down, and the hand tucked in (shorter).
    for (const [w, sx] of [[piv.wingL, 1], [piv.wingR, -1]]) {
      if (!w) continue;
      w.rotation.y = sx * 1.62 * k;
      w.rotation.x = 0.04 * k;
      if (k) w.rotation.z = -sx * 0.35;
      w.scale.x = 1 - 0.32 * k;
    }
  }

  // ---------------------------------------------------------------- rabbits

  addRabbit() {
    const a = this.spawn('rabbit', 1.1);
    if (!a) return;
    const [x, z] = this.grass[Math.floor(Math.random() * this.grass.length)] ?? [N / 2, N / 2];
    this.animals.push({ kind: 'rabbit', ...a, x, z, yaw: rnd(0, TAU), state: 'idle', t: 0, wait: rnd(1, 4), hop: null, sq: 0 });
  }

  updateRabbit(b, dt, t, near, nearest) {
    const { obj, piv } = b;
    b.t += dt;
    const threat = nearest(b.x, b.z);
    if (threat && threat.d < 3.2 && b.state !== 'flee') { b.state = 'flee'; b.fleeT = 0; }
    if (!b.hop) {
      if (b.state === 'flee') {
        b.fleeT += dt;
        if (!threat || threat.d > 5 || b.fleeT > 4) { b.state = 'idle'; b.wait = rnd(1, 3); b.t = 0; }
        else this.startHop(b, Math.atan2(b.x - threat.x, b.z - threat.z) + rnd(-0.5, 0.5), 0.75, 0.24);
      } else if (b.state === 'idle' && b.t > b.wait) {
        b.state = 'wander'; b.hops = Math.floor(rnd(2, 6)); b.dir = rnd(0, TAU);
      } else if (b.state === 'wander') {
        if (b.hops-- <= 0) { b.state = 'idle'; b.t = 0; b.wait = rnd(1.5, 5); }
        else this.startHop(b, b.dir + rnd(-0.4, 0.4), 0.42, 0.34);
      }
    }
    let y = 0;
    if (b.hop) {
      // Ballistic hop with a squash on landing.
      const h = b.hop;
      h.k += dt / h.dur;
      const k = Math.min(1, h.k);
      b.x = h.x0 + (h.x1 - h.x0) * k; b.z = h.z0 + (h.z1 - h.z0) * k;
      y = Math.sin(Math.PI * k) * h.height;
      if (piv.legsB) piv.legsB.rotation.x = -0.9 * Math.sin(Math.PI * k);
      if (k >= 1) { b.hop = null; b.sq = 1; }
    } else if (piv.legsB) piv.legsB.rotation.x *= 0.8;
    b.sq = Math.max(0, b.sq - dt * 6);
    // Ears: back while hopping, twitching while idle; head nibbles.
    const twitch = b.state === 'idle' && Math.sin(t * 1.7 + b.x) > 0.95 ? 0.35 : 0;
    if (piv.earL) piv.earL.rotation.x = b.hop ? 0.6 : twitch;
    if (piv.earR) piv.earR.rotation.x = b.hop ? 0.6 : twitch * 0.5;
    if (piv.head) piv.head.rotation.x = b.state === 'idle' ? Math.max(0, Math.sin(t * 2 + b.z)) * 0.35 : 0;
    obj.position.set(b.x, y, b.z);
    obj.rotation.set(b.hop ? -0.15 * Math.cos(Math.PI * b.hop.k) : 0, b.yaw, 0);
    obj.scale.set(1.1 * (1 + 0.15 * b.sq), 1.1 * (1 - 0.2 * b.sq), 1.1 * (1 + 0.1 * b.sq));
  }

  startHop(b, dir, dist, dur) {
    let x1 = b.x + Math.sin(dir) * dist, z1 = b.z + Math.cos(dir) * dist;
    if (!walkable(x1, z1)) {
      // Blocked: try the other way round.
      dir += Math.PI * rnd(0.5, 1.5);
      x1 = b.x + Math.sin(dir) * dist; z1 = b.z + Math.cos(dir) * dist;
      if (!walkable(x1, z1)) return;
      if (b.state === 'wander') b.dir = dir;
    }
    b.yaw = dir;
    b.hop = { x0: b.x, z0: b.z, x1, z1, k: 0, dur, height: dist * 0.45 };
  }

  // ---------------------------------------------------------------- frogs

  addFrog(p) {
    const a = this.spawn('frog', 1.3);
    if (!a) return;
    const f = { kind: 'frog', ...a, pond: p, state: 'sit', t: 0 };
    this.placeFrog(f);
    this.animals.push(f);
  }

  placeFrog(f) {
    const p = f.pond;
    for (let i = 0; i < 30; i++) {
      const a = rnd(0, TAU), r = p.r + rnd(0.15, 0.45);
      const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
      if (walkable(x, z)) { f.x = x; f.z = z; f.yaw = angTo(p.x - x, p.z - z) + Math.PI; return; }
    }
    f.x = p.x + p.r + 0.3; f.z = p.z; f.yaw = 0;
  }

  updateFrog(f, dt, t, near, nearest, now) {
    const { obj, piv } = f;
    f.t += dt;
    if (f.state === 'sit') {
      // Croak: the throat sac swells.
      const croak = Math.max(0, Math.sin(t * 5 + f.x * 3)) * (Math.sin(t * 0.7 + f.z) > 0.6 ? 1 : 0);
      if (piv.throat) piv.throat.scale.setScalar(1 + croak * 0.9);
      obj.position.set(f.x, 0, f.z);
      obj.rotation.set(0, f.yaw, 0);
      if (near(f.x, f.z, 2.2)) {
        f.state = 'leap'; f.t = 0; f.x0 = f.x; f.z0 = f.z;
        f.yaw = angTo(f.pond.x - f.x, f.pond.z - f.z);
      }
    } else if (f.state === 'leap') {
      const k = Math.min(1, f.t / 0.45);
      const x = f.x0 + (f.pond.x - f.x0) * k * 0.8, z = f.z0 + (f.pond.z - f.z0) * k * 0.8;
      obj.position.set(x, Math.sin(Math.PI * k) * 0.35 - k * 0.15, z);
      obj.rotation.set(-0.6 * Math.cos(Math.PI * k), f.yaw, 0);
      if (piv.legsB) piv.legsB.rotation.x = -1.0 * Math.sin(Math.PI * Math.min(1, k * 1.5));
      if (k >= 1) {
        this.r.splash(x / U, z / U, now);
        for (let i = 0; i < 6; i++) this.r.puff(x, 0.05, z, { vx: rnd(-1, 1), vy: rnd(1.2, 2), vz: rnd(-1, 1), gravity: 9, size: 0.06, size1: 0.04, life: 0.45, alpha: 0.9, color: '#e8fbff' });
        f.state = 'under'; f.t = 0; f.wait = rnd(5, 10);
        obj.visible = false;
      }
    } else if (f.state === 'under' && f.t > f.wait && !near(f.pond.x, f.pond.z, f.pond.r + 2.5)) {
      this.placeFrog(f);
      obj.visible = true;
      f.state = 'sit'; f.t = 0;
    }
  }

  // ---------------------------------------------------------------- ducks

  addDuck(p, i) {
    const a = this.spawn('duck', 1.15);
    if (!a) return;
    this.animals.push({ kind: 'duck', ...a, pond: p, ang: rnd(0, TAU), w: (i ? 1 : -1) * rnd(0.35, 0.55), rr: p.r * rnd(0.35, 0.55), ripple: 0 });
  }

  updateDuck(d, dt, t, near, nearest, now) {
    const { obj, piv } = d;
    const p = d.pond;
    const threat = nearest(p.x, p.z);
    const scared = threat && threat.d < p.r + 2.2;
    // Paddle round the pond; when someone comes close, flee to the far side.
    if (scared) {
      const away = Math.atan2(p.z - threat.z, p.x - threat.x);
      const diff = ((away - d.ang + Math.PI) % TAU + TAU) % TAU - Math.PI;
      d.ang += THREE.MathUtils.clamp(diff, -2 * dt, 2 * dt);
    } else d.ang += d.w * dt;
    const x = p.x + Math.cos(d.ang) * d.rr, z = p.z + Math.sin(d.ang) * d.rr;
    const vx = x - (d.px ?? x), vz = z - (d.pz ?? z);
    d.px = x; d.pz = z;
    if (Math.hypot(vx, vz) > 1e-5) d.yaw = angTo(vx, vz);
    obj.position.set(x, -0.03 + Math.sin(t * 2.4 + d.ang) * 0.012, z);
    obj.rotation.set(Math.sin(t * 2.4 + d.ang) * 0.04, d.yaw ?? 0, 0);
    if (piv.head) piv.head.rotation.y = Math.sin(t * 0.9 + d.ang * 3) * 0.5;
    if (piv.tail) piv.tail.rotation.y = Math.sin(t * 6) * 0.15;
    d.ripple -= dt;
    if (d.ripple <= 0) { d.ripple = scared ? 0.25 : 0.9; this.r.splash(x / U, z / U, now); }
  }

  // ---------------------------------------------------------------- turtles

  addTurtle(i) {
    const a = this.spawn('turtle', 1.2);
    if (!a) return;
    this.animals.push({ kind: 'turtle', ...a, u: rnd(0, 1), d: rnd(0.7, 1.1), dir: Math.random() < 0.5 ? 1 : -1, hide: 0 });
  }

  updateTurtle(tu, dt, t, near) {
    const { obj, piv } = tu;
    const [x, z] = beachPoint(tu.u, tu.d);
    const scared = near(x, z, 2.5);
    tu.hide = THREE.MathUtils.clamp(tu.hide + (scared ? dt * 4 : -dt * 0.7), 0, 1);
    const crawl = tu.hide > 0.05 ? 0 : 1;
    tu.u += tu.dir * dt * 0.0016 * crawl;
    const [x2, z2] = beachPoint(tu.u + tu.dir * 0.001, tu.d);
    obj.position.set(x, 0.0, z);
    obj.rotation.set(0, angTo(x2 - x, z2 - z), 0);
    // Flippers paddle in a slow crawl; head pulls into the shell when scared.
    const s = Math.sin(t * 3) * 0.5 * crawl;
    if (piv.flipFL) piv.flipFL.rotation.y = s;
    if (piv.flipFR) piv.flipFR.rotation.y = s;
    if (piv.flipBL) piv.flipBL.rotation.y = -s * 0.6;
    if (piv.flipBR) piv.flipBR.rotation.y = -s * 0.6;
    if (piv.head) { piv.head.scale.setScalar(1 - 0.5 * tu.hide); piv.head.position.z = (piv.head.userData.z0 ??= piv.head.position.z) - 0.12 * tu.hide; }
  }

  // ---------------------------------------------------------------- dolphins

  addDolphin(i) {
    const a = this.spawn('dolphin', 1.1);
    if (!a) return;
    a.obj.visible = false;
    this.animals.push({ kind: 'dolphin', ...a, wait: rnd(2, 8), t: 0, jumping: false });
  }

  updateDolphin(d, dt, t, near, nearest, now) {
    const { obj, piv } = d;
    d.t += dt;
    if (!d.jumping) {
      if (d.t > d.wait) {
        // Pick a stretch of open sea in view-ish distance and leap along it.
        const u = rnd(0, 1), off = rnd(3, 6);
        d.p0 = beachPoint(u, off); d.p1 = beachPoint(u + 0.012 * (Math.random() < 0.5 ? 1 : -1), off + rnd(-0.5, 0.5));
        d.jumping = true; d.t = 0; d.dur = rnd(1.1, 1.5);
        obj.visible = true;
        this.r.splash(d.p0[0] / U, d.p0[1] / U, now);
      }
      return;
    }
    const k = Math.min(1, d.t / d.dur);
    const x = d.p0[0] + (d.p1[0] - d.p0[0]) * k, z = d.p0[1] + (d.p1[1] - d.p0[1]) * k;
    const y = -0.35 + Math.sin(Math.PI * k) * 1.5;
    obj.position.set(x, y, z);
    // Body pitches with the arc (nose up out of the water, nose down on the way back).
    obj.rotation.set(0, angTo(d.p1[0] - d.p0[0], d.p1[1] - d.p0[1]), 0);
    obj.rotateX(-Math.cos(Math.PI * k) * 0.9);
    if (piv.tail) piv.tail.rotation.x = Math.sin(t * 14) * 0.35;
    if (k >= 1) {
      d.jumping = false; d.t = 0; d.wait = rnd(5, 12);
      obj.visible = false;
      this.r.splash(x / U, z / U, now);
      for (let i = 0; i < 10; i++) this.r.puff(x, 0.1, z, { vx: rnd(-1.5, 1.5), vy: rnd(2, 3.5), vz: rnd(-1.5, 1.5), gravity: 9, size: 0.1, size1: 0.06, life: 0.6, alpha: 0.9, color: '#ffffff' });
    }
  }

  // ---------------------------------------------------------------- butterflies & dragonflies (instanced)

  wingTexture(kind) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    if (kind === 'butterfly') {
      // One forewing + hindwing, white so it can be tinted per instance, with dark veins and edge.
      g.fillStyle = '#ffffff';
      g.beginPath(); g.ellipse(26, 22, 24, 17, -0.5, 0, TAU); g.fill();
      g.beginPath(); g.ellipse(20, 46, 15, 13, 0.4, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(30,20,10,0.9)'; g.lineWidth = 3;
      g.beginPath(); g.ellipse(26, 22, 24, 17, -0.5, 0, TAU); g.stroke();
      g.beginPath(); g.ellipse(20, 46, 15, 13, 0.4, 0, TAU); g.stroke();
      g.fillStyle = 'rgba(30,20,10,0.85)';
      for (const [x, y] of [[38, 12], [44, 20], [30, 9]]) { g.beginPath(); g.arc(x, y, 2.5, 0, TAU); g.fill(); }
    } else {
      g.fillStyle = 'rgba(220,240,255,0.55)';
      g.beginPath(); g.ellipse(32, 32, 30, 7, 0, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(120,150,170,0.6)'; g.lineWidth = 1;
      for (let i = 0; i < 6; i++) { g.beginPath(); g.moveTo(4 + i * 10, 28); g.lineTo(8 + i * 10, 36); g.stroke(); }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  buildButterflies(n) {
    const geo = new THREE.PlaneGeometry(0.16, 0.16).translate(0.08, 0, 0).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshLambertMaterial({ map: this.wingTexture('butterfly'), transparent: true, alphaTest: 0.3, side: THREE.DoubleSide });
    this.bf = { L: new THREE.InstancedMesh(geo, mat, n), R: new THREE.InstancedMesh(geo, mat, n), list: [] };
    const palette = ['#ff9a2a', '#f6e05a', '#7ab8ff', '#ffffff', '#ff7aa8', '#b58cff'].map((c) => new THREE.Color(c));
    for (let i = 0; i < n; i++) {
      const [x, z] = this.grass[Math.floor(Math.random() * this.grass.length)] ?? [N / 2, N / 2];
      const col = palette[i % palette.length];
      this.bf.L.setColorAt(i, col); this.bf.R.setColorAt(i, col);
      this.bf.list.push({ x, z, y: rnd(0.3, 0.8), hx: x, hz: z, ph: rnd(0, TAU), vx: 0, vz: 0, scare: 0 });
    }
    for (const m of [this.bf.L, this.bf.R]) { m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.frustumCulled = false; this.r.scene.add(m); }
  }

  buildDragonflies(n) {
    const wings = new THREE.PlaneGeometry(0.34, 0.07).rotateX(-Math.PI / 2);
    const both = new THREE.BufferGeometry().copy(wings);
    this.df = {
      body: new THREE.InstancedMesh(new THREE.CylinderGeometry(0.012, 0.008, 0.26, 6).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#2a8fa8', metalness: 0.4, roughness: 0.3 }), n),
      wings: new THREE.InstancedMesh(both, new THREE.MeshBasicMaterial({ map: this.wingTexture('dragonfly'), transparent: true, depthWrite: false, side: THREE.DoubleSide }), n * 2),
      list: [],
    };
    for (let i = 0; i < n; i++) {
      const p = this.ponds[i % this.ponds.length] ?? { x: N / 2, z: N / 2, r: 1 };
      this.df.list.push({ p, x: p.x, z: p.z, y: 0.6, tx: p.x, tz: p.z, t: rnd(0, 2), ph: rnd(0, TAU) });
    }
    for (const m of [this.df.body, this.df.wings]) { m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.frustumCulled = false; this.r.scene.add(m); }
  }

  updateInsects(dt, t, nearest) {
    const m = this.m4 ??= new THREE.Matrix4(), q = this.q4 ??= new THREE.Quaternion(), pos = this.v4 ??= new THREE.Vector3(), one = this.one ??= new THREE.Vector3(1, 1, 1);
    const e = this.e4 ??= new THREE.Euler();
    if (this.bf) {
      this.bf.list.forEach((b, i) => {
        // Flutter around home flowers; scatter upward from brawlers.
        const th = nearest(b.x, b.z);
        if (th && th.d < 1.8) { b.scare = 1.5; b.vx += (b.x - th.x) * 4 * dt; b.vz += (b.z - th.z) * 4 * dt; }
        b.scare = Math.max(0, b.scare - dt);
        b.vx += (Math.sin(t * 1.3 + b.ph) * 0.8 + (b.hx - b.x) * 0.3) * dt;
        b.vz += (Math.cos(t * 1.1 + b.ph * 2) * 0.8 + (b.hz - b.z) * 0.3) * dt;
        b.vx *= 0.97; b.vz *= 0.97;
        b.x += b.vx * dt; b.z += b.vz * dt;
        b.y += ((b.scare ? 1.6 : 0.45 + Math.sin(t * 2 + b.ph) * 0.2) - b.y) * dt * 2;
        const flap = Math.sin(t * 22 + b.ph) * 1.1;
        const yaw = Math.atan2(b.vx, b.vz);
        pos.set(b.x, b.y, b.z);
        this.bf.L.setMatrixAt(i, m.compose(pos, q.setFromEuler(e.set(0, yaw - Math.PI / 2, flap, 'YXZ')), one));
        this.bf.R.setMatrixAt(i, m.compose(pos, q.setFromEuler(e.set(0, yaw + Math.PI / 2, -flap, 'YXZ')), one));
      });
      this.bf.L.instanceMatrix.needsUpdate = true;
      this.bf.R.instanceMatrix.needsUpdate = true;
    }
    if (this.df) {
      this.df.list.forEach((d, i) => {
        // Hover, then dart to a new spot over the pond.
        d.t -= dt;
        if (d.t <= 0) {
          d.t = rnd(0.8, 2.2);
          const a = rnd(0, TAU), r = rnd(0, d.p.r + 0.6);
          d.tx = d.p.x + Math.cos(a) * r; d.tz = d.p.z + Math.sin(a) * r;
        }
        const k = Math.min(1, dt * 5);
        const ox = d.x, oz = d.z;
        d.x += (d.tx - d.x) * k; d.z += (d.tz - d.z) * k;
        d.yaw = Math.hypot(d.x - ox, d.z - oz) > 1e-4 ? Math.atan2(d.x - ox, d.z - oz) : d.yaw ?? 0;
        const y = 0.55 + Math.sin(t * 3 + d.ph) * 0.08;
        pos.set(d.x, y, d.z);
        q.setFromEuler(e.set(0, d.yaw, 0, 'YXZ'));
        this.df.body.setMatrixAt(i, m.compose(pos, q, one));
        const buzz = Math.sin(t * 60 + d.ph) * 0.25;
        for (const [j, off] of [[0, 0.04], [1, -0.03]]) {
          const wp = pos.clone().add(new THREE.Vector3(Math.sin(d.yaw) * off, 0.015, Math.cos(d.yaw) * off));
          this.df.wings.setMatrixAt(i * 2 + j, m.compose(wp, q.clone().multiply(new THREE.Quaternion().setFromEuler(e.set(0, Math.PI / 2, buzz * (j ? -1 : 1)))), one));
        }
      });
      this.df.body.instanceMatrix.needsUpdate = true;
      this.df.wings.instanceMatrix.needsUpdate = true;
    }
  }

  // ---------------------------------------------------------------- per frame

  update(dt, t, players, now) {
    dt = Math.min(dt, 0.05);
    const ps = players.map((p) => ({ x: p.x * U, z: p.y * U }));
    const near = (x, z, r) => ps.some((p) => Math.hypot(p.x - x, p.z - z) < r);
    const nearest = (x, z) => {
      let best = null;
      for (const p of ps) { const d = Math.hypot(p.x - x, p.z - z); if (!best || d < best.d) best = { x: p.x, z: p.z, d }; }
      return best;
    };
    for (const a of this.animals) {
      if (a.kind === 'gull') this.updateGull(a, dt, t, near);
      else if (a.kind === 'rabbit') this.updateRabbit(a, dt, t, near, nearest);
      else if (a.kind === 'frog') this.updateFrog(a, dt, t, near, nearest, now);
      else if (a.kind === 'duck') this.updateDuck(a, dt, t, near, nearest, now);
      else if (a.kind === 'turtle') this.updateTurtle(a, dt, t, near);
      else if (a.kind === 'dolphin') this.updateDolphin(a, dt, t, near, nearest, now);
    }
    this.updateInsects(dt, t, nearest);
  }
}
