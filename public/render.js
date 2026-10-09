import { MAP, MAP_TILES, TILE, WORLD, CENTER, PLAYER_RADIUS, CRATE_R, BRAWLERS, MAX_AMMO, EMOTES, HAUNT } from '/shared/game.js';
import { STICK_R, superButton } from './input.js';
import { art, drawChar, drawProp, drawGround } from './assets.js';

const R = PLAYER_RADIUS;
const ME = '#3ccf6e';
const FOE = '#ff4d4f';

// ---------- static layers (drawn once) ----------

function buildLayers() {
  const ground = document.createElement('canvas');
  ground.width = ground.height = WORLD;
  const g = ground.getContext('2d');
  for (let r = 0; r < MAP_TILES; r++) {
    for (let c = 0; c < MAP_TILES; c++) {
      g.fillStyle = (r + c) % 2 ? '#e2c995' : '#dcc18b';
      g.fillRect(c * TILE, r * TILE, TILE, TILE);
    }
  }
  // Walls: a darker front face under a lighter top, so they read as raised blocks.
  for (let r = 0; r < MAP_TILES; r++) {
    for (let c = 0; c < MAP_TILES; c++) {
      if (MAP[r][c] !== '#') continue;
      const x = c * TILE, y = r * TILE;
      g.fillStyle = '#6b4128';
      g.fillRect(x, y + 8, TILE, TILE - 8);
      g.fillStyle = '#a8704a';
      g.fillRect(x, y - 6, TILE, TILE - 4);
      g.strokeStyle = 'rgba(0,0,0,0.18)';
      g.lineWidth = 2;
      g.strokeRect(x + 6, y, TILE - 12, TILE - 18);
    }
  }
  g.strokeStyle = '#3d2716';
  g.lineWidth = 10;
  g.strokeRect(5, 5, WORLD - 10, WORLD - 10);

  const bush = document.createElement('canvas');
  bush.width = bush.height = WORLD;
  const b = bush.getContext('2d');
  let seed = 7;
  const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  for (let r = 0; r < MAP_TILES; r++) {
    for (let c = 0; c < MAP_TILES; c++) {
      if (MAP[r][c] !== '*') continue;
      const cx = c * TILE + TILE / 2, cy = r * TILE + TILE / 2;
      b.fillStyle = '#1f7a35';
      b.beginPath();
      b.arc(cx, cy + 4, TILE * 0.62, 0, Math.PI * 2);
      b.fill();
      for (let i = 0; i < 4; i++) {
        b.fillStyle = i % 2 ? '#2f9e44' : '#38b24f';
        b.beginPath();
        b.arc(cx + (rand() - 0.5) * 30, cy + (rand() - 0.5) * 30, 18 + rand() * 10, 0, Math.PI * 2);
        b.fill();
      }
    }
  }
  return { ground, bush };
}

// ---------- sprites ----------

export function drawBrawler(ctx, x, y, id, aim, opts = {}) {
  const b = BRAWLERS[id];
  const ring = opts.ring;
  ctx.save();
  ctx.translate(x, y);
  if (opts.alpha != null) ctx.globalAlpha = opts.alpha;

  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(0, R * 0.75, R * 0.95, R * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();
  if (ring) {
    ctx.strokeStyle = ring;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.ellipse(0, R * 0.75, R * 1.05, R * 0.45, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  const weapon = () => {
    ctx.save();
    ctx.rotate(aim);
    ctx.fillStyle = '#333';
    if (b.attack === 'shotgun') roundRect(ctx, R * 0.4, -8, R * 1.0, 16, 4);
    else if (b.attack === 'bullet') roundRect(ctx, R * 0.4, -4, R * 1.5, 8, 3);
    else {
      ctx.fillStyle = '#222';
      ctx.beginPath(); ctx.arc(R * 1.05, 0, 10, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#ffb02e'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(R * 1.05, -9); ctx.lineTo(R * 1.25, -16); ctx.stroke();
    }
    ctx.restore();
  };
  const pointingUp = Math.sin(aim) < -0.2;
  if (pointingUp) weapon();

  ctx.fillStyle = b.color;
  ctx.strokeStyle = b.dark;
  ctx.lineWidth = 4;
  const body = () => {
    if (b.attack === 'shotgun') roundRect(ctx, -R, -R, R * 2, R * 2, 12, true);
    else { ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
  };
  body();
  if (b.attack === 'bullet') {
    ctx.fillStyle = b.dark;
    ctx.beginPath(); ctx.arc(0, -R * 0.15, R, Math.PI * 1.1, Math.PI * 1.9); ctx.fill();
  } else if (b.attack === 'lob') {
    ctx.strokeStyle = b.dark; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, -R); ctx.quadraticCurveTo(8, -R - 14, 14, -R - 8); ctx.stroke();
  }

  const ex = Math.cos(aim) * 7, ey = Math.sin(aim) * 5;
  for (const side of [-1, 1]) {
    const px = ex + Math.cos(aim + Math.PI / 2) * side * 9;
    const py = ey - 3 + Math.sin(aim + Math.PI / 2) * side * 5;
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(px, py, 6.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#111';
    ctx.beginPath(); ctx.arc(px + Math.cos(aim) * 2.5, py + Math.sin(aim) * 2.5, 3.2, 0, Math.PI * 2); ctx.fill();
  }
  if (!pointingUp) weapon();

  // White flash when hit
  if (opts.flash > 0) {
    ctx.globalAlpha = (opts.alpha ?? 1) * opts.flash;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    body();
  }
  ctx.restore();
}

function drawGhost(ctx, x, y, t, isMe) {
  ctx.save();
  ctx.translate(x, y + Math.sin(t * 3 + x) * 4);
  ctx.globalAlpha = isMe ? 0.75 : 0.55;
  ctx.fillStyle = '#eef0ff';
  ctx.strokeStyle = isMe ? ME : '#b9a3ff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, -4, R * 0.9, Math.PI, 0);
  const w = R * 0.9;
  for (let i = 0; i <= 4; i++) {
    const px = w - (i * 2 * w) / 4;
    ctx.lineTo(px, R * 0.75 + (i % 2 ? -6 : 0) + Math.sin(t * 6 + i) * 2);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#3a2a6a';
  for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(s * 8, -6, 4, 6, 0, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}

function drawCrate(ctx, c) {
  const s = CRATE_R * 1.8;
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(c.x - s / 2 + 4, c.y - s / 2 + 8, s, s);
  ctx.fillStyle = '#b77a3d';
  ctx.strokeStyle = '#6e4319';
  ctx.lineWidth = 4;
  roundRect(ctx, c.x - s / 2, c.y - s / 2, s, s, 6, true);
  ctx.beginPath();
  ctx.moveTo(c.x - s / 2 + 4, c.y - s / 2 + 4); ctx.lineTo(c.x + s / 2 - 4, c.y + s / 2 - 4);
  ctx.moveTo(c.x + s / 2 - 4, c.y - s / 2 + 4); ctx.lineTo(c.x - s / 2 + 4, c.y + s / 2 - 4);
  ctx.stroke();
  ctx.fillStyle = '#2ecc71';
  ctx.beginPath(); ctx.arc(c.x, c.y, 9, 0, Math.PI * 2); ctx.fill();
  if (c.h < 1) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(c.x - 26, c.y - s / 2 - 14, 52, 8);
    ctx.fillStyle = '#ffd34d';
    ctx.fillRect(c.x - 25, c.y - s / 2 - 13, 50 * c.h, 6);
  }
}

function roundRect(ctx, x, y, w, h, r, stroke = false) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
  ctx.fill();
  if (stroke) ctx.stroke();
}

function bubble(ctx, x, y, text) {
  ctx.font = '900 22px system-ui';
  const w = Math.max(40, ctx.measureText(text).width + 18);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 2;
  roundRect(ctx, x - w / 2, y - 34, w, 34, 12, true);
  ctx.beginPath(); ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 8); ctx.fill();
  ctx.fillStyle = '#1b1430';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y - 16);
  ctx.textBaseline = 'alphabetic';
}

// ---------- renderer ----------

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.effects = [];
    this.flashes = new Map(); // player id -> time hit
    this.motion = new Map(); // player id -> last position, for walk cycles
    this.shakeAmt = 0;
    this.hurtAt = -1e9;
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  // Vector fallback layers are only built if the sprite art and 3D renderer are both unavailable.
  get layers() {
    this._layers ??= buildLayers();
    return this._layers;
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = innerWidth;
    this.h = innerHeight;
    this.dpr = dpr;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    // Show about the same play area on every screen shape.
    this.scale = Math.min(1.3, Math.max(0.42, Math.sqrt((this.w * this.h) / (1350 * 820))));
  }

  toScreen(cam, x, y) {
    return { x: (x - cam.x) * this.scale + this.w / 2, y: (y - cam.y) * this.scale + this.h / 2 };
  }

  shake(amount) { this.shakeAmt = Math.max(this.shakeAmt, amount); }
  hurt(now) { this.hurtAt = now; }

  addEvent(e, now) {
    const kinds = { boom: e.big ? 0.6 : 0.45, spark: 0.25, ko: 0.8, dmg: 0.9, cube: 0.9, crateBreak: 0.5, haunt: 0.6, super: 0.5 };
    if (kinds[e.k]) this.effects.push({ ...e, born: now, life: kinds[e.k] });
    if (e.k === 'dmg') this.flashes.set(e.id, now);
  }

  // Track who is moving so their walk cycle plays.
  walkFrame(p, now) {
    const m = this.motion.get(p.id);
    if (!m) { this.motion.set(p.id, { x: p.x, y: p.y, t: now, until: 0 }); return 0; }
    if (Math.hypot(p.x - m.x, p.y - m.y) > 0.6) m.until = now + 120;
    m.x = p.x; m.y = p.y; m.t = now;
    return now < m.until ? Math.floor(now / 110) % 4 : 0;
  }

  drawPlayer(p, now, opts = {}) {
    const { ctx } = this;
    if (!art.ready) {
      drawBrawler(ctx, p.x, p.y, p.brawler, p.aim, { ring: p.isMe ? ME : FOE, ...opts });
      return;
    }
    const alpha = opts.alpha ?? 1;
    ctx.save();
    ctx.globalAlpha = alpha * 0.3;
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.ellipse(p.x, p.y + 2, R * 0.9, R * 0.42, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = alpha;
    if (opts.ring !== false) {
      ctx.strokeStyle = p.isMe ? ME : FOE;
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.ellipse(p.x, p.y + 2, R * 1.05, R * 0.5, 0, 0, Math.PI * 2); ctx.stroke();
    }
    const frame = opts.frame ?? this.walkFrame(p, now);
    drawChar(ctx, p.brawler, p.x, p.y, p.aim, frame);
    if (opts.flash > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = alpha * opts.flash * 0.85;
      drawChar(ctx, p.brawler, p.x, p.y, p.aim, frame);
    }
    ctx.restore();
  }

  draw(v, now) {
    const { ctx, scale } = this;
    const t = now / 1000;
    const A = art.ready;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = A ? art.sea : '#2b1d12';
    ctx.fillRect(0, 0, this.w, this.h);

    this.shakeAmt *= 0.88;
    const sx = (Math.random() - 0.5) * this.shakeAmt, sy = (Math.random() - 0.5) * this.shakeAmt;
    const flashOf = (id) => { const at = this.flashes.get(id); return at ? Math.max(0, 1 - (now - at) / 120) : 0; };

    // World space
    ctx.save();
    ctx.translate(this.w / 2 + sx, this.h / 2 + sy);
    ctx.scale(scale, scale);
    ctx.translate(-v.cam.x, -v.cam.y);
    if (A) drawGround(ctx);
    else ctx.drawImage(this.layers.ground, 0, 0);

    // Haunts (on the ground)
    for (const h of v.haunts) {
      const a = Math.min(1, h.l / 0.5);
      ctx.fillStyle = `rgba(140, 70, 255, ${0.28 * a})`;
      ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(190, 150, 255, ${0.9 * a})`;
      ctx.lineWidth = 4;
      ctx.setLineDash([14, 10]);
      ctx.lineDashOffset = -t * 40;
      ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '28px system-ui';
      ctx.textAlign = 'center';
      ctx.globalAlpha = a;
      ctx.fillText('👻', h.x, h.y + 10);
      ctx.globalAlpha = 1;
    }

    // Lob landing zones
    for (const p of v.projs) {
      if (p.k !== 'l') continue;
      ctx.strokeStyle = 'rgba(220,40,40,0.75)';
      ctx.fillStyle = p.big ? 'rgba(220,40,40,0.25)' : 'rgba(220,40,40,0.15)';
      ctx.lineWidth = p.big ? 5 : 3;
      ctx.setLineDash([10, 8]);
      ctx.beginPath(); ctx.arc(p.tx, p.ty, p.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.setLineDash([]);
    }

    if (v.aim) this.drawAim(v.aim);

    // Everything with height is depth-sorted by where it touches the ground,
    // so you can walk behind a wall and in front of it.
    const halfW = this.w / 2 / scale + 160, halfH = this.h / 2 / scale + 200;
    const onScreen = (x, y) => Math.abs(x - v.cam.x) < halfW && Math.abs(y - v.cam.y) < halfH;
    const me = v.players.find((p) => p.isMe);
    const items = [];
    if (A) {
      for (const w of art.walls) if (onScreen(w.x, w.y)) items.push([w.key, () => drawProp(ctx, `wall${w.v}`, w.x, w.y)]);
      for (const b of art.bushes) {
        if (!onScreen(b.x, b.y)) continue;
        const mine = me && Math.floor(me.x / 64) === b.c && Math.floor(me.y / 64) === b.r;
        items.push([b.key - 1, () => {
          if (mine) ctx.globalAlpha = 0.55;
          drawProp(ctx, `bush${b.v}`, b.x, b.y);
          ctx.globalAlpha = 1;
        }]);
      }
    }
    for (const c of v.cubes) {
      const bob = Math.sin(t * 3 + c.i) * 3;
      items.push([c.y, () => {
        if (A) {
          ctx.fillStyle = 'rgba(46,232,122,0.25)';
          ctx.beginPath(); ctx.ellipse(c.x, c.y + 4, 16, 7, 0, 0, Math.PI * 2); ctx.fill();
          drawProp(ctx, 'cube', c.x, c.y + bob);
          return;
        }
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.beginPath(); ctx.ellipse(c.x, c.y + 14, 14, 5, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#2ecc71';
        ctx.strokeStyle = '#167a3f';
        ctx.lineWidth = 3;
        roundRect(ctx, c.x - 13, c.y - 15 + bob, 26, 26, 5, true);
        ctx.fillStyle = '#eaffdf';
        ctx.font = 'bold 18px system-ui';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('⚡', c.x, c.y - 1 + bob);
        ctx.textBaseline = 'alphabetic';
      }]);
    }
    for (const c of v.crates) {
      items.push([c.y + CRATE_R, () => {
        if (!A) return drawCrate(ctx, c);
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.beginPath(); ctx.ellipse(c.x + 6, c.y + 10, 34, 16, 0, 0, Math.PI * 2); ctx.fill();
        drawProp(ctx, 'crate', c.x, c.y);
        if (c.h < 1) {
          ctx.fillStyle = 'rgba(0,0,0,0.6)';
          ctx.fillRect(c.x - 26, c.y - 72, 52, 8);
          ctx.fillStyle = '#ffd34d';
          ctx.fillRect(c.x - 25, c.y - 71, 50 * c.h, 6);
        }
      }]);
    }
    for (const p of v.players) {
      items.push([p.y, () => {
        if (p.dash) {
          for (let i = 3; i >= 1; i--) {
            this.drawPlayer({ ...p, x: p.x - Math.cos(p.aim) * i * 22, y: p.y - Math.sin(p.aim) * i * 22 }, now, { alpha: 0.25 / i, ring: false, frame: 1 });
          }
        }
        this.drawPlayer(p, now, { flash: flashOf(p.id) });
      }]);
    }
    items.sort((a, b) => a[0] - b[0]);
    for (const [, drawIt] of items) drawIt();

    // Bullets
    for (const p of v.projs) {
      if (p.k === 'l') continue;
      const style = { b: ['#fff3a8', '#ffe14d', 9], p: ['#ffb347', '#ff8a00', 7], v: ['#c9f6ff', '#28c8ff', 10] }[p.k];
      ctx.fillStyle = style[0];
      ctx.shadowColor = style[1];
      ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.arc(p.x, p.y - (A ? 22 : 0), style[2], 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Players inside a bush are drawn faintly on top so you can still find yourself.
    if (!A) ctx.drawImage(this.layers.bush, 0, 0);
    for (const p of v.players) {
      if (p.bush) this.drawPlayer(p, now, { alpha: p.isMe ? 0.6 : 0.4 });
    }

    // Bombs in the air
    for (const p of v.projs) {
      if (p.k !== 'l') continue;
      const gx = p.sx + (p.tx - p.sx) * p.p, gy = p.sy + (p.ty - p.sy) * p.p;
      const hgt = Math.sin(Math.PI * p.p) * (p.big ? 200 : 140);
      const r = p.big ? 20 : 12;
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.ellipse(gx, gy, r, r * 0.4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = p.big ? '#7a1010' : '#222';
      ctx.beginPath(); ctx.arc(gx, gy - hgt, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ff6b00';
      ctx.beginPath(); ctx.arc(gx + r * 0.5, gy - hgt - r, 4 + Math.sin(t * 30) * 1.5, 0, Math.PI * 2); ctx.fill();
    }

    // Ghosts float above everything on the ground
    for (const g of v.ghosts) {
      if (A) {
        ctx.globalAlpha = g.isMe ? 0.8 : 0.6;
        drawProp(ctx, 'ghost', g.x, g.y + Math.sin(t * 3 + g.x) * 5);
        ctx.globalAlpha = 1;
      } else drawGhost(ctx, g.x, g.y, t, g.isMe);
    }

    this.drawEffects(now, true);

    // Poison: everything outside the safe circle.
    ctx.fillStyle = 'rgba(60, 200, 80, 0.33)';
    ctx.beginPath();
    ctx.rect(-2000, -2000, WORLD + 4000, WORLD + 4000);
    ctx.arc(CENTER, CENTER, v.poison, 0, Math.PI * 2);
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(80, 255, 110, 0.85)';
    ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(CENTER, CENTER, v.poison, 0, Math.PI * 2); ctx.stroke();

    // Name tags, health bars and emotes, above everything
    for (const p of v.players) this.drawTag(p, v.me, t);
    for (const g of v.ghosts) {
      const gy = g.y - (A ? 64 : R + 12);
      ctx.font = 'bold 14px system-ui';
      ctx.textAlign = 'center';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.fillStyle = '#d9ccff';
      const label = g.isMe ? 'You (ghost)' : `${g.name} 👻`;
      ctx.strokeText(label, g.x, gy);
      ctx.fillText(label, g.x, gy);
      if (g.em != null) bubble(ctx, g.x, gy - 18, EMOTES[g.em]);
    }
    this.drawEffects(now, false);
    ctx.restore();

    this.drawArrows(v);
    this.drawHurt(now);
    if (v.sticks) this.drawSticks(v.sticks, v.me);
  }

  drawAim(a) {
    const { ctx } = this;
    const b = BRAWLERS[a.brawler];
    ctx.save();
    ctx.translate(a.x, a.y);
    ctx.fillStyle = a.super ? 'rgba(255,214,60,0.3)' : 'rgba(255,255,255,0.22)';
    ctx.strokeStyle = a.super ? 'rgba(255,214,60,0.8)' : 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    const kind = a.super ? b.super.kind : b.attack;
    const range = a.super ? b.super.range : b.range;
    if (kind === 'shotgun' || kind === 'volley') {
      const spread = kind === 'volley' ? b.super.spread : b.spread;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, range, a.angle - spread / 2, a.angle + spread / 2);
      ctx.closePath();
      ctx.fill();
    } else if (kind === 'bullet' || kind === 'charge') {
      ctx.rotate(a.angle);
      const w = kind === 'charge' ? 26 : 9;
      ctx.fillRect(R, -w, range - R, w * 2);
    } else {
      const blast = a.super ? b.super.blast : b.blast;
      const d = Math.min(range, Math.max(80, a.dist));
      const tx = Math.cos(a.angle) * d, ty = Math.sin(a.angle) * d;
      ctx.setLineDash([6, 10]);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(tx / 2, ty / 2 - 120, tx, ty); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(tx, ty, blast, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  drawTag(p, me, t) {
    const { ctx } = this;
    const y = p.y - (art.ready ? 82 : R + 20);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = 'bold 15px system-ui';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.fillStyle = p.isMe ? '#9dffbf' : '#fff';
    const label = p.isMe ? 'You' : p.name;
    ctx.strokeText(label, p.x, y - 14);
    ctx.fillText(label, p.x, y - 14);

    const w = 64, h = 10;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    roundRect(ctx, p.x - w / 2 - 2, y - 8, w + 4, h + 4, 4);
    ctx.fillStyle = p.isMe ? ME : FOE;
    roundRect(ctx, p.x - w / 2, y - 6, Math.max(0, w * (p.hp / p.maxHp)), h, 3);
    ctx.font = 'bold 11px system-ui';
    ctx.fillStyle = '#fff';
    ctx.fillText(Math.max(0, Math.ceil(p.hp)), p.x, y + 3);

    if (p.cubes > 0) {
      ctx.fillStyle = '#2ecc71';
      roundRect(ctx, p.x + w / 2 + 5, y - 9, 20, 16, 4);
      ctx.fillStyle = '#0b2a14';
      ctx.font = 'bold 12px system-ui';
      ctx.fillText(p.cubes, p.x + w / 2 + 15, y + 4);
    }

    if (p.isMe && me) {
      const seg = 18, gap = 3, total = MAX_AMMO * seg + (MAX_AMMO - 1) * gap;
      for (let i = 0; i < MAX_AMMO; i++) {
        const x = p.x - total / 2 + i * (seg + gap), yy = p.y + (art.ready ? 18 : R + 14);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(x, yy, seg, 6);
        ctx.fillStyle = '#ff9f1a';
        ctx.fillRect(x, yy, seg * Math.max(0, Math.min(1, me.ammo - i)), 6);
      }
      // Super charge: a yellow arc around your feet, glowing when ready.
      const su = me.su ?? 0;
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.ellipse(p.x, p.y + (art.ready ? 2 : R * 0.75), R * 1.3, R * 0.6, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = su >= 1 ? `rgba(255,214,60,${0.7 + 0.3 * Math.sin(t * 10)})` : '#ffd23c';
      ctx.beginPath(); ctx.ellipse(p.x, p.y + (art.ready ? 2 : R * 0.75), R * 1.3, R * 0.6, 0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * su); ctx.stroke();
    }
    if (p.em != null) bubble(ctx, p.x, y - 34, EMOTES[p.em]);
  }

  drawEffects(now, ground) {
    const { ctx } = this;
    this.effects = this.effects.filter((e) => (now - e.born) / 1000 < e.life);
    for (const e of this.effects) {
      const k = (now - e.born) / 1000 / e.life;
      if (ground) {
        if (e.k === 'boom') {
          ctx.fillStyle = `rgba(255,140,30,${0.6 * (1 - k)})`;
          ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (0.6 + 0.5 * k), 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = `rgba(255,230,120,${1 - k})`;
          ctx.lineWidth = 5;
          ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (0.4 + 0.8 * k), 0, Math.PI * 2); ctx.stroke();
        } else if (e.k === 'spark') {
          ctx.fillStyle = `rgba(255,240,180,${1 - k})`;
          ctx.beginPath(); ctx.arc(e.x, e.y, 4 + 10 * k, 0, Math.PI * 2); ctx.fill();
        } else if (e.k === 'ko' || e.k === 'crateBreak') {
          const n = e.k === 'ko' ? 10 : 8;
          for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2;
            ctx.fillStyle = e.k === 'ko' ? `rgba(255,255,255,${0.8 * (1 - k)})` : `rgba(183,122,61,${1 - k})`;
            ctx.beginPath(); ctx.arc(e.x + Math.cos(a) * 60 * k, e.y + Math.sin(a) * 60 * k, 10 * (1 - k) + 2, 0, Math.PI * 2); ctx.fill();
          }
        } else if (e.k === 'haunt' || e.k === 'super') {
          ctx.strokeStyle = e.k === 'haunt' ? `rgba(190,150,255,${1 - k})` : `rgba(255,214,60,${1 - k})`;
          ctx.lineWidth = 6;
          ctx.beginPath(); ctx.arc(e.x, e.y, (e.k === 'haunt' ? HAUNT.radius : 50) * (0.3 + k), 0, Math.PI * 2); ctx.stroke();
        }
      } else if (e.k === 'dmg' || e.k === 'cube') {
        const text = e.k === 'dmg' ? `-${e.a}` : '+1 ⚡';
        ctx.font = `900 ${e.k === 'dmg' ? 20 : 18}px system-ui`;
        ctx.textAlign = 'center';
        ctx.globalAlpha = 1 - k * k;
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.fillStyle = e.k === 'cube' ? '#6dff9c' : e.src === 'poison' ? '#9dffa8' : e.src === 'haunt' ? '#cdb6ff' : '#ffdf5d';
        const yy = e.y - R - 50 - k * 40;
        ctx.strokeText(text, e.x + ((e.id ?? 1) % 3 - 1) * 14, yy);
        ctx.fillText(text, e.x + ((e.id ?? 1) % 3 - 1) * 14, yy);
        ctx.globalAlpha = 1;
      }
    }
  }

  // Red arrows at the screen edge pointing at enemies you can see but who are off screen.
  drawArrows(v) {
    const { ctx } = this;
    const m = 34;
    for (const p of v.players) {
      if (p.isMe) continue;
      const s = this.toScreen(v.cam, p.x, p.y);
      if (s.x > 0 && s.x < this.w && s.y > 0 && s.y < this.h) continue;
      const cx = this.w / 2, cy = this.h / 2;
      const a = Math.atan2(s.y - cy, s.x - cx);
      const k = Math.min((cx - m) / Math.abs(Math.cos(a) || 1e-6), (cy - m) / Math.abs(Math.sin(a) || 1e-6));
      const x = cx + Math.cos(a) * k, y = cy + Math.sin(a) * k;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a);
      ctx.fillStyle = 'rgba(255,77,79,0.85)';
      ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-8, -10); ctx.lineTo(-8, 10); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }

  drawHurt(now) {
    const k = 1 - (now - this.hurtAt) / 350;
    if (k <= 0) return;
    const { ctx } = this;
    const g = ctx.createRadialGradient(this.w / 2, this.h / 2, Math.min(this.w, this.h) * 0.3, this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.7);
    g.addColorStop(0, 'rgba(255,0,0,0)');
    g.addColorStop(1, `rgba(255,0,0,${0.45 * k})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  drawSticks({ left, right, superStick, hint, ghost }, me) {
    const { ctx } = this;
    const stick = (s, color) => {
      const dx = s.x - s.ox, dy = s.y - s.oy, d = Math.hypot(dx, dy) || 1;
      const k = Math.min(d, STICK_R) / d;
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(s.ox, s.oy, STICK_R, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(s.ox + dx * k, s.oy + dy * k, 26, 0, Math.PI * 2); ctx.fill();
    };
    if (left) stick(left, 'rgba(120,200,255,0.8)');
    if (right) stick(right, ghost ? 'rgba(190,150,255,0.85)' : 'rgba(255,190,60,0.85)');

    if (!ghost && me) {
      const sb = superButton();
      const su = me.su ?? 0;
      if (superStick) stick(superStick, 'rgba(255,214,60,0.95)');
      else {
        ctx.fillStyle = su >= 1 ? 'rgba(255,205,60,0.95)' : 'rgba(0,0,0,0.45)';
        ctx.beginPath(); ctx.arc(sb.x, sb.y, sb.r, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#ffd23c';
        ctx.lineWidth = 5;
        ctx.beginPath(); ctx.arc(sb.x, sb.y, sb.r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * su); ctx.stroke();
        ctx.fillStyle = su >= 1 ? '#1b1430' : 'rgba(255,255,255,0.7)';
        ctx.font = '900 13px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('SUPER', sb.x, sb.y + 5);
      }
    }
    if (hint) {
      ctx.font = 'bold 13px system-ui';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      if (!left) ctx.fillText(ghost ? 'drag to float' : 'drag to move', this.w * 0.2, this.h - 40);
      if (!right) ctx.fillText(ghost ? 'tap to haunt' : 'drag to aim · tap to auto-shoot', this.w * 0.75, this.h - 40);
    }
  }
}
