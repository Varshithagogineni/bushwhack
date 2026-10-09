import {
  TICK_RATE, DT, WORLD, CENTER, PLAYER_RADIUS, MAX_PLAYERS, MIN_PLAYERS, MAX_AMMO, SHOT_COOLDOWN,
  REGEN_DELAY, REGEN_RATE, REVEAL_TIME, BUSH_SEE_DIST, CUBE_HP, CUBE_DMG, CUBE_PICKUP, CRATE_R, CRATE_HP,
  COUNTDOWN, POISON, HAUNT, EMOTES, BRAWLERS, BRAWLER_IDS, clamp, isWallAt, inBush, resolveWalls, resolveCircles,
  movePlayer, moveGhost, speedFactor, hasLineOfSight, poisonRadius, nearestFloor, spawnPoints, crateSpots, round2,
} from '../shared/game.js';

const RECONNECT_GRACE_MS = 30_000;
const RESULTS_MS = 15_000;
const MAX_QUEUED_INPUTS = 8;
const BOT_NAMES = ['Rex', 'Pip', 'Juno', 'Mako', 'Tilly', 'Ozzy', 'Nova', 'Bolt'];

export class Room {
  constructor(code, onEmpty) {
    this.code = code;
    this.onEmpty = onEmpty;
    this.players = new Map();
    this.nextId = 1;
    this.hostId = null;
    this.state = 'lobby'; // lobby | countdown | playing | ended
    this.time = 0; // sim seconds since match start (incl. countdown)
    this.matchTime = 0; // seconds since the fight began
    this.projs = [];
    this.cubes = [];
    this.crates = [];
    this.haunts = [];
    this.events = [];
    this.nextObjId = 1;
    this.results = null;
    this.loop = null;
    this.resultsTimer = null;
  }

  // ---------- membership ----------

  get humans() { return [...this.players.values()].filter((p) => !p.bot); }

  addHuman(ws, name, token) {
    const existing = this.humans.find((p) => p.token === token);
    if (existing && !existing.connected) {
      existing.ws = ws;
      existing.connected = true;
      clearTimeout(existing.dropTimer);
      existing.name = name || existing.name;
      return existing;
    }
    if (this.players.size >= MAX_PLAYERS) {
      const bot = [...this.players.values()].reverse().find((p) => p.bot);
      if (!bot || this.state !== 'lobby') return null;
      this.players.delete(bot.id);
    }
    const p = this.makePlayer(name, false);
    p.ws = ws;
    p.connected = true;
    p.token = existing ? null : token; // a duplicated browser tab gets a fresh identity
    if (!this.hostId) this.hostId = p.id;
    return p;
  }

  makePlayer(name, bot) {
    const p = {
      id: this.nextId++, name, bot, brawler: BRAWLER_IDS[Math.floor(Math.random() * BRAWLER_IDS.length)],
      ws: null, connected: bot, token: null, dropTimer: null, wins: 0,
      inMatch: false, alive: false, ghost: false, x: 0, y: 0, hp: 0, maxHp: 0, ammo: MAX_AMMO, cooldown: 0,
      superCharge: 0, dash: null, hauntCd: 0, hauntAcc: 0, emote: -1, emoteUntil: 0, emoteCd: 0,
      cubes: 0, kills: 0, rank: 0, aim: 0, inputs: [], ack: 0, lastHurt: -99, lastAttack: -99,
      revealUntil: -99, poisonAcc: 0, ai: null,
    };
    this.players.set(p.id, p);
    return p;
  }

  disconnect(p) {
    p.connected = false;
    p.ws = null;
    p.inputs.length = 0;
    // Keep their seat for a while so a phone that dropped its connection can rejoin.
    p.dropTimer = setTimeout(() => this.removePlayer(p), RECONNECT_GRACE_MS);
    if (this.hostId === p.id) this.pickHost();
    this.broadcastRoom();
  }

  removePlayer(p) {
    if (!this.players.has(p.id)) return;
    if (p.alive && (this.state === 'playing' || this.state === 'countdown')) this.eliminate(p, null);
    this.players.delete(p.id);
    if (this.hostId === p.id) this.pickHost();
    if (!this.humans.length) return this.destroy();
    this.broadcastRoom();
  }

  destroy() {
    this.stopLoop();
    clearTimeout(this.resultsTimer);
    for (const p of this.players.values()) clearTimeout(p.dropTimer);
    this.players.clear();
    this.onEmpty(this);
  }

  pickHost() {
    const next = this.humans.find((h) => h.connected) || this.humans[0];
    this.hostId = next ? next.id : null;
  }

  // ---------- messages from clients ----------

  handle(p, m) {
    const isHost = p.id === this.hostId;
    switch (m.t) {
      case 'pick':
        if (this.state === 'lobby' && BRAWLERS[m.brawler]) { p.brawler = m.brawler; this.broadcastRoom(); }
        break;
      case 'addBot':
        if (isHost && this.state === 'lobby' && this.players.size < MAX_PLAYERS) {
          const used = new Set([...this.players.values()].map((x) => x.name));
          const name = BOT_NAMES.find((n) => !used.has(`${n} (bot)`)) || 'Bot';
          this.makePlayer(`${name} (bot)`, true);
          this.broadcastRoom();
        }
        break;
      case 'removeBot':
        if (isHost && this.state === 'lobby') {
          const bot = [...this.players.values()].reverse().find((x) => x.bot);
          if (bot) { this.players.delete(bot.id); this.broadcastRoom(); }
        }
        break;
      case 'start':
        if (isHost && this.state === 'lobby' && this.players.size >= MIN_PLAYERS) this.startMatch();
        break;
      case 'lobby':
        if (isHost && this.state === 'ended') this.backToLobby();
        break;
      case 'leave':
        clearTimeout(p.dropTimer);
        this.removePlayer(p);
        break;
      case 'i': {
        if (!(p.alive || p.ghost) || this.state !== 'playing') break;
        let mx = Number(m.x) || 0, my = Number(m.y) || 0;
        const len = Math.hypot(mx, my);
        if (len > 1) { mx /= len; my /= len; }
        p.inputs.push({ seq: m.s | 0, mx: round2(mx), my: round2(my) });
        if (p.inputs.length > MAX_QUEUED_INPUTS) p.ack = p.inputs.shift().seq;
        if (Number.isFinite(m.a)) p.aim = m.a;
        break;
      }
      case 'f':
        this.fire(p, Number(m.x) || 0, Number(m.y) || 0, Number(m.d) || 0);
        break;
      case 's':
        this.superFire(p, Number(m.x) || 0, Number(m.y) || 0, Number(m.d) || 0);
        break;
      case 'h':
        this.haunt(p);
        break;
      case 'e': {
        const n = m.n | 0;
        if (n < 0 || n >= EMOTES.length || !(p.alive || p.ghost) || this.time < p.emoteCd) break;
        if (this.state !== 'playing' && this.state !== 'countdown') break;
        p.emote = n;
        p.emoteUntil = this.time + 2.2;
        p.emoteCd = this.time + 1;
        break;
      }
    }
  }

  // ---------- match lifecycle ----------

  startMatch() {
    clearTimeout(this.resultsTimer);
    const roster = [...this.players.values()];
    const spawns = spawnPoints(roster.length);
    this.crates = crateSpots().map((s) => ({ id: this.nextObjId++, x: s.x, y: s.y, hp: CRATE_HP }));
    roster.sort(() => Math.random() - 0.5).forEach((p, i) => {
      const b = BRAWLERS[p.brawler];
      Object.assign(p, {
        inMatch: true, alive: true, ghost: false, x: spawns[i].x, y: spawns[i].y, hp: b.hp, maxHp: b.hp,
        ammo: MAX_AMMO, cooldown: 0, superCharge: 0, dash: null, hauntCd: 0, hauntAcc: 0, emote: -1, emoteUntil: 0,
        cubes: 0, kills: 0, rank: 0, inputs: [], ack: 0, lastHurt: -99, lastAttack: -99, revealUntil: -99, poisonAcc: 0,
        aim: Math.atan2(CENTER - spawns[i].y, CENTER - spawns[i].x),
        ai: p.bot ? { strafe: 1, strafeT: 0, target: null, reactAt: 0, wp: null, wpT: 0, unstuckT: 0, ux: 0, uy: 0, lx: 0, ly: 0 } : null,
      });
      resolveCircles(p, PLAYER_RADIUS, this.crates);
    });
    this.projs = [];
    this.cubes = [];
    this.haunts = [];
    this.events = [];
    this.time = 0;
    this.matchTime = 0;
    this.results = null;
    this.state = 'countdown';
    this.broadcastRoom();
    this.stopLoop();
    this.loop = setInterval(() => this.tick(), 1000 / TICK_RATE);
  }

  endMatch() {
    const alive = [...this.players.values()].filter((p) => p.inMatch && p.alive);
    for (const p of alive) p.rank = 1;
    if (alive.length === 1) alive[0].wins++;
    this.state = 'ended';
    this.results = [...this.players.values()]
      .filter((p) => p.inMatch)
      .sort((a, b) => a.rank - b.rank)
      .map((p) => ({ id: p.id, name: p.name, brawler: p.brawler, rank: p.rank, kills: p.kills, bot: p.bot, wins: p.wins }));
    this.sendSnapshots();
    this.stopLoop();
    this.broadcastRoom();
    this.resultsTimer = setTimeout(() => this.backToLobby(), RESULTS_MS);
  }

  backToLobby() {
    clearTimeout(this.resultsTimer);
    if (this.state !== 'ended') return;
    this.state = 'lobby';
    for (const p of this.players.values()) { p.inMatch = false; p.alive = false; p.ghost = false; }
    this.projs = [];
    this.cubes = [];
    this.crates = [];
    this.haunts = [];
    this.broadcastRoom();
  }

  stopLoop() {
    clearInterval(this.loop);
    this.loop = null;
  }

  // ---------- simulation ----------

  tick() {
    this.time += DT;
    if (this.state === 'countdown') {
      if (this.time >= COUNTDOWN) { this.state = 'playing'; this.broadcastRoom(); }
      this.sendSnapshots();
      return;
    }
    if (this.state !== 'playing') return;
    this.matchTime += DT;
    const safeR = poisonRadius(this.matchTime);
    this.haunts = this.haunts.filter((h) => h.until > this.time);
    const fighters = [...this.players.values()].filter((p) => p.alive);

    for (const p of this.players.values()) {
      if (p.ghost) {
        const n = Math.min(p.inputs.length, 3);
        for (let i = 0; i < n; i++) {
          const inp = p.inputs.shift();
          moveGhost(p, inp.mx, inp.my);
          p.ack = inp.seq;
        }
        p.hauntCd = Math.max(0, p.hauntCd - DT);
        continue;
      }
      if (!p.alive) continue;
      const b = BRAWLERS[p.brawler];
      if (p.dash) {
        // Mid-charge: inputs are consumed but don't steer.
        while (p.inputs.length) p.ack = p.inputs.shift().seq;
        this.updateDash(p);
      } else if (p.bot) {
        const { mx, my } = this.botThink(p, fighters, safeR);
        movePlayer(p, mx, my, b.speed * speedFactor(p.x, p.y, this.haunts), this.crates);
      } else {
        // Process this client's queued inputs; a couple extra per tick absorbs network jitter.
        const n = Math.min(p.inputs.length, 3);
        for (let i = 0; i < n; i++) {
          const inp = p.inputs.shift();
          movePlayer(p, inp.mx, inp.my, b.speed * speedFactor(p.x, p.y, this.haunts), this.crates);
          p.ack = inp.seq;
        }
      }
      p.ammo = Math.min(MAX_AMMO, p.ammo + DT / b.reload);
      p.cooldown = Math.max(0, p.cooldown - DT);
      if (this.time - p.lastHurt > REGEN_DELAY && this.time - p.lastAttack > REGEN_DELAY && p.hp < p.maxHp) {
        p.hp = Math.min(p.maxHp, p.hp + p.maxHp * REGEN_RATE * DT);
      }
    }

    // Poison and haunts
    for (const p of fighters) {
      if (!p.alive) continue;
      if (Math.hypot(p.x - CENTER, p.y - CENTER) > safeR) {
        p.poisonAcc += POISON.dps * DT;
        if (p.poisonAcc >= POISON.dps / 2) { const a = p.poisonAcc; p.poisonAcc = 0; this.damage(p, a, null); }
      } else p.poisonAcc = 0;
      const h = this.haunts.find((hh) => Math.hypot(p.x - hh.x, p.y - hh.y) < hh.r);
      if (h && p.alive) {
        p.revealUntil = Math.max(p.revealUntil, this.time + 0.3);
        p.hauntAcc += HAUNT.dps * DT;
        if (p.hauntAcc >= HAUNT.dps / 2) {
          const a = p.hauntAcc;
          p.hauntAcc = 0;
          this.damage(p, a, this.players.get(h.owner) ?? null, true);
        }
      }
    }

    this.updateProjectiles();

    // Power cubes
    for (const p of fighters) {
      if (!p.alive) continue;
      this.cubes = this.cubes.filter((c) => {
        if (Math.hypot(c.x - p.x, c.y - p.y) > CUBE_PICKUP) return true;
        p.cubes++;
        p.maxHp += CUBE_HP;
        p.hp += CUBE_HP;
        this.events.push({ k: 'cube', id: p.id, x: Math.round(c.x), y: Math.round(c.y) });
        return false;
      });
    }

    this.sendSnapshots();
    const left = [...this.players.values()].filter((p) => p.alive).length;
    if (left <= 1) this.endMatch();
  }

  attackStart(p, ax, ay) {
    p.lastAttack = this.time;
    p.revealUntil = this.time + REVEAL_TIME;
    p.aim = Math.atan2(ay, ax);
  }

  fire(p, ax, ay, dist) {
    if (p.ghost) return this.haunt(p);
    if (this.state !== 'playing' || !p.alive || p.dash || p.ammo < 1 || p.cooldown > 0) return;
    const len = Math.hypot(ax, ay);
    if (len < 0.01) return;
    ax /= len; ay /= len;
    const b = BRAWLERS[p.brawler];
    p.ammo -= 1;
    p.cooldown = SHOT_COOLDOWN;
    this.attackStart(p, ax, ay);
    const dmg = b.damage * (1 + CUBE_DMG * p.cubes);
    this.events.push({ k: 'shot', id: p.id, w: b.attack, x: Math.round(p.x), y: Math.round(p.y) });

    if (b.attack === 'lob') {
      this.spawnLob(p, ax, ay, clamp(dist, 80, b.range), dmg, b.blast, b.flight, false);
      return;
    }
    const shots = b.attack === 'shotgun' ? b.pellets : 1;
    for (let i = 0; i < shots; i++) {
      const a = p.aim + (shots > 1 ? (i / (shots - 1) - 0.5) * b.spread : 0);
      this.spawnBullet(p, a, b.attack === 'shotgun' ? 'pellet' : 'bullet', dmg, b.projSpeed, b.range, false);
    }
  }

  superFire(p, ax, ay, dist) {
    if (this.state !== 'playing' || !p.alive || p.dash || p.superCharge < 1) return;
    const len = Math.hypot(ax, ay);
    if (len < 0.01) return;
    ax /= len; ay /= len;
    const s = BRAWLERS[p.brawler].super;
    p.superCharge = 0;
    this.attackStart(p, ax, ay);
    const dmg = s.damage * (1 + CUBE_DMG * p.cubes);
    this.events.push({ k: 'super', id: p.id, w: s.kind, x: Math.round(p.x), y: Math.round(p.y) });
    if (s.kind === 'charge') {
      p.dash = { vx: ax * s.speed, vy: ay * s.speed, left: s.range, dmg, hit: new Set() };
    } else if (s.kind === 'volley') {
      for (let i = 0; i < s.shots; i++) {
        this.spawnBullet(p, p.aim + (i / (s.shots - 1) - 0.5) * s.spread, 'volley', dmg, s.projSpeed, s.range, true);
      }
    } else {
      this.spawnLob(p, ax, ay, clamp(dist, 100, s.range), dmg, s.blast, s.flight, true);
    }
  }

  spawnBullet(p, a, kind, dmg, speed, range, pierce) {
    this.projs.push({
      id: this.nextObjId++, kind, owner: p.id, dmg,
      x: p.x + Math.cos(a) * (PLAYER_RADIUS + 4), y: p.y + Math.sin(a) * (PLAYER_RADIUS + 4),
      vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, travelled: 0, range, hit: pierce ? new Set() : null,
    });
  }

  spawnLob(p, ax, ay, d, dmg, blast, flight, big) {
    this.projs.push({
      id: this.nextObjId++, kind: 'lob', owner: p.id, dmg, sx: p.x, sy: p.y, big,
      tx: clamp(p.x + ax * d, 0, WORLD), ty: clamp(p.y + ay * d, 0, WORLD), t: 0, flight, blast,
    });
  }

  updateDash(p) {
    const d = p.dash;
    const step = Math.hypot(d.vx, d.vy) * DT;
    const ox = p.x, oy = p.y;
    for (let s = 0; s < 3; s++) {
      p.x += (d.vx * DT) / 3;
      p.y += (d.vy * DT) / 3;
      resolveWalls(p, PLAYER_RADIUS);
      for (const c of [...this.crates]) {
        if (Math.hypot(c.x - p.x, c.y - p.y) < PLAYER_RADIUS + CRATE_R + 4) this.hitCrate(c, d.dmg);
      }
      resolveCircles(p, PLAYER_RADIUS, this.crates);
      for (const o of this.players.values()) {
        if (!o.alive || o === p || d.hit.has(o.id)) continue;
        const dx = o.x - p.x, dy = o.y - p.y, dist = Math.hypot(dx, dy);
        if (dist < PLAYER_RADIUS * 2 + 6) {
          d.hit.add(o.id);
          this.damage(o, d.dmg, p);
          // Knock them aside.
          const k = 70 / Math.max(1, dist);
          o.x += dx * k; o.y += dy * k;
          resolveWalls(o, PLAYER_RADIUS);
          resolveCircles(o, PLAYER_RADIUS, this.crates);
        }
      }
    }
    d.left -= step;
    const moved = Math.hypot(p.x - ox, p.y - oy);
    if (d.left <= 0 || moved < step * 0.3) p.dash = null;
  }

  hitCrate(c, dmg) {
    if (!this.crates.includes(c)) return;
    c.hp -= dmg;
    this.events.push({ k: 'crate', x: Math.round(c.x), y: Math.round(c.y) });
    if (c.hp > 0) return;
    this.crates = this.crates.filter((x) => x !== c);
    this.cubes.push({ id: this.nextObjId++, x: c.x, y: c.y });
    this.events.push({ k: 'crateBreak', x: Math.round(c.x), y: Math.round(c.y) });
  }

  updateProjectiles() {
    const keep = [];
    for (const pr of this.projs) {
      const owner = this.players.get(pr.owner);
      if (pr.kind === 'lob') {
        pr.t += DT;
        if (pr.t < pr.flight) { keep.push(pr); continue; }
        this.events.push({ k: 'boom', x: Math.round(pr.tx), y: Math.round(pr.ty), r: pr.blast, big: pr.big ? 1 : 0 });
        for (const p of this.players.values()) {
          if (p.alive && p.id !== pr.owner && Math.hypot(p.x - pr.tx, p.y - pr.ty) <= pr.blast + PLAYER_RADIUS) {
            this.damage(p, pr.dmg, owner);
          }
        }
        for (const c of [...this.crates]) {
          if (Math.hypot(c.x - pr.tx, c.y - pr.ty) <= pr.blast + CRATE_R) this.hitCrate(c, pr.dmg);
        }
        continue;
      }
      const speed = Math.hypot(pr.vx, pr.vy);
      const steps = Math.ceil((speed * DT) / 14);
      let dead = false;
      for (let s = 0; s < steps && !dead; s++) {
        pr.x += (pr.vx * DT) / steps;
        pr.y += (pr.vy * DT) / steps;
        pr.travelled += (speed * DT) / steps;
        if (pr.travelled > pr.range) { dead = true; break; }
        if (isWallAt(pr.x, pr.y) || pr.x < 0 || pr.y < 0 || pr.x > WORLD || pr.y > WORLD) {
          this.events.push({ k: 'spark', x: Math.round(pr.x), y: Math.round(pr.y) });
          dead = true;
          break;
        }
        const crate = this.crates.find((c) => Math.hypot(c.x - pr.x, c.y - pr.y) < CRATE_R + 6);
        if (crate) { this.hitCrate(crate, pr.dmg); dead = true; break; }
        for (const p of this.players.values()) {
          if (!p.alive || p.id === pr.owner || pr.hit?.has(p.id)) continue;
          if (Math.hypot(p.x - pr.x, p.y - pr.y) <= PLAYER_RADIUS + 8) {
            this.damage(p, pr.dmg, owner);
            if (pr.hit) pr.hit.add(p.id); // piercing shots keep going
            else { dead = true; break; }
          }
        }
      }
      if (!dead) keep.push(pr);
    }
    this.projs = keep;
  }

  damage(p, amount, attacker, haunted = false) {
    if (!p.alive) return;
    p.hp -= amount;
    p.lastHurt = this.time;
    if (attacker) p.revealUntil = Math.max(p.revealUntil, this.time + REVEAL_TIME);
    if (attacker && attacker.alive && attacker !== p) {
      attacker.superCharge = Math.min(1, attacker.superCharge + amount / BRAWLERS[attacker.brawler].super.charge);
    }
    this.events.push({
      k: 'dmg', id: p.id, x: Math.round(p.x), y: Math.round(p.y), a: Math.round(amount),
      src: haunted ? 'haunt' : attacker ? 'hit' : 'poison', by: attacker ? attacker.id : 0,
    });
    if (p.hp <= 0) this.eliminate(p, attacker, haunted);
  }

  eliminate(p, attacker, haunted = false) {
    if (!p.alive) return;
    p.alive = false;
    p.hp = 0;
    p.dash = null;
    p.inputs.length = 0;
    p.rank = [...this.players.values()].filter((x) => x.alive).length + 1;
    if (attacker && attacker !== p) attacker.kills++;
    // Humans come back as ghosts so nobody sits out the rest of the round.
    if (!p.bot && this.state !== 'countdown') { p.ghost = true; p.hauntCd = 2; }
    // Drop power cubes: everything they carried plus one.
    const drops = p.cubes + 1;
    for (let i = 0; i < drops; i++) {
      const a = (i / drops) * Math.PI * 2;
      const spot = { x: p.x + Math.cos(a) * (drops > 1 ? 34 : 0), y: p.y + Math.sin(a) * (drops > 1 ? 34 : 0) };
      resolveWalls(spot, 16);
      this.cubes.push({ id: this.nextObjId++, x: spot.x, y: spot.y });
    }
    this.events.push({ k: 'ko', id: p.id, by: attacker ? attacker.id : 0, haunt: haunted ? 1 : 0, x: Math.round(p.x), y: Math.round(p.y) });
  }

  haunt(p) {
    if (this.state !== 'playing' || !p.ghost || p.hauntCd > 0) return;
    p.hauntCd = HAUNT.cooldown;
    this.haunts.push({ id: this.nextObjId++, owner: p.id, x: p.x, y: p.y, r: HAUNT.radius, until: this.time + HAUNT.life });
    this.events.push({ k: 'haunt', id: p.id, x: Math.round(p.x), y: Math.round(p.y) });
  }

  canSee(viewer, p) {
    if (viewer.id === p.id || !viewer.alive) return true;
    if (!inBush(p.x, p.y) || this.time < p.revealUntil) return true;
    return Math.hypot(viewer.x - p.x, viewer.y - p.y) < BUSH_SEE_DIST;
  }

  // ---------- bots ----------

  botThink(p, fighters, safeR) {
    const ai = p.ai;
    const b = BRAWLERS[p.brawler];
    let mx = 0, my = 0;

    // Stuck on a wall? Walk a random direction for a moment.
    if (ai.unstuckT > 0) {
      ai.unstuckT -= DT;
      ai.lx = p.x; ai.ly = p.y;
      return { mx: ai.ux, my: ai.uy };
    }

    let target = null, td = Infinity;
    for (const o of fighters) {
      if (o === p || !o.alive || !this.canSee(p, o)) continue;
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      if (d < td && d < 720) { td = d; target = o; }
    }
    // Early on, bots loot crates and only fight what gets in their face.
    if (target && this.matchTime < 15 && td > 300) { target = null; td = Infinity; }
    if (target !== ai.target) { ai.target = target; ai.reactAt = this.time + 0.45 + Math.random() * 0.3; }

    const dc = Math.hypot(p.x - CENTER, p.y - CENTER);
    if (dc > safeR - 160) {
      mx = (CENTER - p.x) / dc; my = (CENTER - p.y) / dc;
    } else if (target) {
      const dx = target.x - p.x, dy = target.y - p.y, d = Math.max(1, td);
      const want = b.attack === 'shotgun' ? 140 : b.range * 0.65;
      const hurt = p.hp < p.maxHp * 0.35;
      const dir = hurt ? -1 : d > want ? 1 : -0.8; // low on health: back off and let regen kick in
      ai.strafeT -= DT;
      if (ai.strafeT <= 0) { ai.strafe = Math.random() < 0.5 ? -1 : 1; ai.strafeT = 0.6 + Math.random(); }
      mx = (dx / d) * dir + (-dy / d) * 0.7 * ai.strafe;
      my = (dy / d) * dir + (dx / d) * 0.7 * ai.strafe;
      const clear = b.attack === 'lob' || hasLineOfSight(p.x, p.y, target.x, target.y);
      if (clear && this.time > ai.reactAt) {
        const a = Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.4;
        if (p.superCharge >= 1 && d < b.super.range * 0.85 && Math.random() < 0.05) {
          this.superFire(p, Math.cos(a), Math.sin(a), d);
        } else if (d < b.range * 0.92 && p.ammo >= 1 && Math.random() < 0.045) {
          this.fire(p, Math.cos(a), Math.sin(a), d);
        }
      }
    } else {
      // Nobody around: go break the nearest crate, otherwise wander.
      let crate = null, cd = 900;
      for (const c of this.crates) {
        const d = Math.hypot(c.x - p.x, c.y - p.y);
        if (d < cd && Math.hypot(c.x - CENTER, c.y - CENTER) < safeR - 100) { cd = d; crate = c; }
      }
      const goal = crate ?? ai.wp;
      ai.wpT -= DT;
      if (!crate && (!ai.wp || ai.wpT <= 0 || Math.hypot(ai.wp.x - p.x, ai.wp.y - p.y) < 40)) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * Math.min(safeR * 0.6, 600);
        ai.wp = nearestFloor(CENTER + Math.cos(a) * r, CENTER + Math.sin(a) * r);
        ai.wpT = 4;
      }
      const g = goal ?? ai.wp;
      const dx = g.x - p.x, dy = g.y - p.y, d = Math.max(1, Math.hypot(dx, dy));
      if (crate && d < Math.min(b.range * 0.8, 300)) {
        if (p.ammo >= 1.5 && Math.random() < 0.06 && (b.attack === 'lob' || hasLineOfSight(p.x, p.y, crate.x, crate.y))) {
          this.fire(p, dx / d, dy / d, d);
        }
      } else { mx = dx / d; my = dy / d; }
    }

    const len = Math.hypot(mx, my);
    if (len > 0.1 && Math.hypot(p.x - ai.lx, p.y - ai.ly) < b.speed * DT * 0.2) {
      const a = Math.random() * Math.PI * 2;
      ai.ux = Math.cos(a); ai.uy = Math.sin(a); ai.unstuckT = 0.4;
    }
    ai.lx = p.x; ai.ly = p.y;
    if (len > 0.1) p.aim = target ? Math.atan2(target.y - p.y, target.x - p.x) : Math.atan2(my, mx);
    return { mx, my };
  }

  // ---------- networking ----------

  roomPayload() {
    return {
      t: 'room',
      code: this.code,
      state: this.state,
      hostId: this.hostId,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, brawler: p.brawler, bot: p.bot, connected: p.connected, inMatch: p.inMatch, wins: p.wins,
      })),
      results: this.results,
    };
  }

  broadcastRoom() {
    const msg = JSON.stringify(this.roomPayload());
    for (const p of this.humans) send(p.ws, msg);
  }

  sendSnapshots() {
    const all = [...this.players.values()];
    const fighters = all.filter((p) => p.alive);
    const emoteOf = (p) => (this.time < p.emoteUntil ? p.emote : undefined);
    const projs = this.projs.map((pr) => pr.kind === 'lob'
      ? { i: pr.id, k: 'l', sx: Math.round(pr.sx), sy: Math.round(pr.sy), tx: Math.round(pr.tx), ty: Math.round(pr.ty), p: round2(pr.t / pr.flight), r: pr.blast, big: pr.big ? 1 : 0 }
      : { i: pr.id, k: pr.kind === 'pellet' ? 'p' : pr.kind === 'volley' ? 'v' : 'b', x: Math.round(pr.x), y: Math.round(pr.y) });
    const base = {
      t: 'snap', time: round2(this.time), state: this.state, cd: Math.max(0, COUNTDOWN - this.time),
      poison: Math.round(poisonRadius(this.matchTime)), mt: Math.round(this.matchTime), alive: fighters.length,
      projs,
      cubes: this.cubes.map((c) => ({ i: c.id, x: Math.round(c.x), y: Math.round(c.y) })),
      crates: this.crates.map((c) => ({ i: c.id, x: c.x, y: c.y, h: round2(Math.max(0, c.hp) / CRATE_HP) })),
      haunts: this.haunts.map((h) => ({ i: h.id, x: Math.round(h.x), y: Math.round(h.y), r: h.r, l: round2(h.until - this.time) })),
      ghosts: all.filter((p) => p.ghost).map((p) => ({ i: p.id, x: Math.round(p.x), y: Math.round(p.y), em: emoteOf(p) })),
      ev: this.events,
    };
    for (const viewer of this.humans) {
      if (!viewer.connected || !viewer.ws || viewer.ws.bufferedAmount > 256 * 1024) continue;
      const players = fighters.filter((p) => this.canSee(viewer, p)).map((p) => ({
        i: p.id, x: Math.round(p.x), y: Math.round(p.y), h: Math.round(p.hp), m: p.maxHp, a: round2(p.aim),
        c: p.cubes, bush: inBush(p.x, p.y) ? 1 : 0, em: emoteOf(p), d: p.dash ? 1 : 0,
      }));
      const me = {
        alive: viewer.alive, ghost: viewer.ghost, ack: viewer.ack, ammo: round2(viewer.ammo), cubes: viewer.cubes,
        su: round2(viewer.superCharge), hcd: round2(viewer.hauntCd),
      };
      send(viewer.ws, JSON.stringify({ ...base, players, me }));
    }
    this.events = [];
  }
}

export function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}
