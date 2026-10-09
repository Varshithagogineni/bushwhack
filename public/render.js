import { MAP, MAP_TILES, TILE, WORLD, CENTER, PLAYER_RADIUS, BRAWLERS, MAX_AMMO } from '/shared/game.js';
import { STICK_R } from './input.js';

const R = PLAYER_RADIUS;

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

// ---------- brawler sprite (also used on lobby cards) ----------

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

  // Weapon, behind the body when pointing up.
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
  if (b.attack === 'shotgun') roundRect(ctx, -R, -R, R * 2, R * 2, 12, true);
  else { ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
  // Character details
  if (b.attack === 'bullet') {
    ctx.fillStyle = b.dark;
    ctx.beginPath(); ctx.arc(0, -R * 0.15, R, Math.PI * 1.1, Math.PI * 1.9); ctx.fill();
  } else if (b.attack === 'lob') {
    ctx.strokeStyle = b.dark; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, -R); ctx.quadraticCurveTo(8, -R - 14, 14, -R - 8); ctx.stroke();
  }

  // Eyes look where you aim.
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
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r, stroke = false) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
  ctx.fill();
  if (stroke) ctx.stroke();
}

// ---------- renderer ----------

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.layers = buildLayers();
    this.effects = [];
    this.resize();
    addEventListener('resize', () => this.resize());
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

  addEvent(e, now) {
    const kinds = { boom: 0.45, spark: 0.25, ko: 0.8, dmg: 0.9, cube: 0.9 };
    if (kinds[e.k]) this.effects.push({ ...e, born: now, life: kinds[e.k] });
  }

  draw(v, now) {
    const { ctx, scale } = this;
    const t = now / 1000;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#2b1d12';
    ctx.fillRect(0, 0, this.w, this.h);

    // World space
    ctx.save();
    ctx.translate(this.w / 2, this.h / 2);
    ctx.scale(scale, scale);
    ctx.translate(-v.cam.x, -v.cam.y);
    ctx.drawImage(this.layers.ground, 0, 0);

    // Power cubes
    for (const c of v.cubes) {
      const bob = Math.sin(t * 3 + c.i) * 3;
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
    }

    // Lob landing zones
    for (const p of v.projs) {
      if (p.k !== 'l') continue;
      ctx.strokeStyle = 'rgba(220,40,40,0.75)';
      ctx.fillStyle = 'rgba(220,40,40,0.15)';
      ctx.lineWidth = 3;
      ctx.setLineDash([10, 8]);
      ctx.beginPath(); ctx.arc(p.tx, p.ty, p.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Aim guide (under players)
    if (v.aim) this.drawAim(v.aim);

    // Brawlers
    const sorted = [...v.players].sort((a, b) => a.y - b.y);
    for (const p of sorted) drawBrawler(ctx, p.x, p.y, p.brawler, p.aim, { ring: p.isMe ? '#3ccf6e' : '#ff4d4f' });

    // Bullets
    for (const p of v.projs) {
      if (p.k === 'l') continue;
      const big = p.k === 'b';
      ctx.fillStyle = big ? '#fff3a8' : '#ffb347';
      ctx.shadowColor = big ? '#ffe14d' : '#ff8a00';
      ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(p.x, p.y, big ? 9 : 7, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Bushes cover everyone; players inside one are drawn faintly on top so you can still find yourself.
    ctx.drawImage(this.layers.bush, 0, 0);
    for (const p of sorted) {
      if (p.bush) drawBrawler(ctx, p.x, p.y, p.brawler, p.aim, { alpha: p.isMe ? 0.6 : 0.4, ring: p.isMe ? '#3ccf6e' : '#ff4d4f' });
    }

    // Bombs in the air
    for (const p of v.projs) {
      if (p.k !== 'l') continue;
      const gx = p.sx + (p.tx - p.sx) * p.p, gy = p.sy + (p.ty - p.sy) * p.p;
      const hgt = Math.sin(Math.PI * p.p) * 140;
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.ellipse(gx, gy, 12, 5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#222';
      ctx.beginPath(); ctx.arc(gx, gy - hgt, 12, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ff6b00';
      ctx.beginPath(); ctx.arc(gx + 6, gy - hgt - 12, 4 + Math.sin(t * 30) * 1.5, 0, Math.PI * 2); ctx.fill();
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

    // Name tags and health bars, above everything
    for (const p of sorted) this.drawTag(p, v.me);
    this.drawEffects(now, false);
    ctx.restore();

    if (v.sticks) this.drawSticks(v.sticks);
  }

  drawAim(a) {
    const { ctx } = this;
    const b = BRAWLERS[a.brawler];
    ctx.save();
    ctx.translate(a.x, a.y);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    if (b.attack === 'shotgun') {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, b.range, a.angle - b.spread / 2, a.angle + b.spread / 2);
      ctx.closePath();
      ctx.fill();
    } else if (b.attack === 'bullet') {
      ctx.rotate(a.angle);
      ctx.fillRect(R, -9, b.range - R, 18);
    } else {
      const d = Math.min(b.range, Math.max(80, a.dist));
      const tx = Math.cos(a.angle) * d, ty = Math.sin(a.angle) * d;
      ctx.setLineDash([6, 10]);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(tx / 2, ty / 2 - 120, tx, ty); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(tx, ty, b.blast, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  drawTag(p, me) {
    const { ctx } = this;
    const y = p.y - R - 20;
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
    ctx.fillStyle = p.isMe ? '#3ccf6e' : '#ff4d4f';
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
        const x = p.x - total / 2 + i * (seg + gap), yy = p.y + R + 14;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(x, yy, seg, 6);
        ctx.fillStyle = '#ff9f1a';
        ctx.fillRect(x, yy, seg * Math.max(0, Math.min(1, me.ammo - i)), 6);
      }
    }
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
        } else if (e.k === 'ko') {
          for (let i = 0; i < 10; i++) {
            const a = (i / 10) * Math.PI * 2;
            ctx.fillStyle = `rgba(255,255,255,${0.8 * (1 - k)})`;
            ctx.beginPath(); ctx.arc(e.x + Math.cos(a) * 60 * k, e.y + Math.sin(a) * 60 * k, 10 * (1 - k) + 2, 0, Math.PI * 2); ctx.fill();
          }
        }
      } else if (e.k === 'dmg' || e.k === 'cube') {
        const text = e.k === 'dmg' ? `-${e.a}` : '+1 ⚡';
        ctx.font = `900 ${e.k === 'dmg' ? 20 : 18}px system-ui`;
        ctx.textAlign = 'center';
        ctx.globalAlpha = 1 - k * k;
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.fillStyle = e.k === 'cube' ? '#6dff9c' : e.poison ? '#9dffa8' : '#ffdf5d';
        const yy = e.y - R - 50 - k * 40;
        ctx.strokeText(text, e.x + (e.id % 3 - 1) * 14, yy);
        ctx.fillText(text, e.x + (e.id % 3 - 1) * 14, yy);
        ctx.globalAlpha = 1;
      }
    }
  }

  drawSticks({ left, right, hint }) {
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
    if (right) stick(right, 'rgba(255,190,60,0.85)');
    if (hint) {
      ctx.font = 'bold 13px system-ui';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      if (!left) ctx.fillText('drag to move', this.w * 0.2, this.h - 40);
      if (!right) ctx.fillText('drag to aim · tap to auto-shoot', this.w * 0.8, this.h - 40);
    }
  }
}
