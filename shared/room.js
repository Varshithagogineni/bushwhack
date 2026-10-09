import {
  TICK_RATE, DT, WORLD, CENTER, PLAYER_RADIUS, MAX_PLAYERS, MIN_PLAYERS, MAX_AMMO, SHOT_COOLDOWN,
  REGEN_DELAY, REGEN_RATE, REVEAL_TIME, BUSH_SEE_DIST, CUBE_HP, CUBE_DMG, CUBE_PICKUP, CRATE_R, CRATE_HP,
  COUNTDOWN, POISON, HAUNT, EMOTES, BRAWLERS, BRAWLER_IDS, MODES, RESPAWN_TIME, GEM, clamp, isWallAt, inBush,
  resolveWalls, resolveCircles, movePlayer, moveGhost, speedFactor, hasLineOfSight, poisonRadius, nearestFloor,
  spawnPoints, teamSpawn, teamBase, crateSpots, round2, KB, ITEM, SWAP_TIME, weaponOf, moveItem, itemSettled,
} from './game.js';

const RECONNECT_GRACE_MS = 30_000;
const RESULTS_MS = 15_000;
const MAX_QUEUED_INPUTS = 8;
const MAX_GEMS_ON_MAP = 20;
const BOT_NAMES = ['Rex', 'Pip', 'Juno', 'Mako', 'Tilly', 'Ozzy', 'Nova', 'Bolt'];

export class Room {
  constructor(code, onEmpty, onResults = () => {}) {
    this.code = code;
    this.onEmpty = onEmpty;
    this.onResults = onResults;
    this.players = new Map();
    this.nextId = 1;
    this.hostId = null;
    this.mode = 'showdown';
    this.state = 'lobby'; // lobby | countdown | playing | ended
    this.time = 0; // sim seconds since match start (incl. countdown)
    this.matchTime = 0; // seconds since the fight began
    this.projs = [];
    this.cubes = [];
    this.crates = [];
    this.haunts = [];
    this.gems = [];
    this.gemCountdown = null; // { team, endsAt }
    this.nextGemAt = 0;
    this.events = [];
    this.nextObjId = 1;
    this.results = null;
    this.winnerTeam = null;
    this.loop = null;
    this.resultsTimer = null;
  }

  get rules() { return MODES[this.mode]; }
  get humans() { return [...this.players.values()].filter((p) => !p.bot); }
  sameTeam(a, b) { return this.rules.teams && a && b && a !== b && a.team === b.team; }
  teamCount(t) { return [...this.players.values()].filter((p) => p.team === t).length; }

  // ---------- membership ----------

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
      team: this.teamCount(0) <= this.teamCount(1) ? 0 : 1,
      ws: null, connected: bot, token: null, dropTimer: null, wins: 0,
      inMatch: false, alive: false, ghost: false, x: 0, y: 0, hp: 0, maxHp: 0, ammo: MAX_AMMO, cooldown: 0,
      superCharge: 0, dash: null, hauntCd: 0, hauntAcc: 0, emote: -1, emoteUntil: 0, emoteCd: 0,
      cubes: 0, kills: 0, rank: 0, aim: 0, inputs: [], ack: 0, lastHurt: -99, lastAttack: -99,
      revealUntil: -99, poisonAcc: 0, ai: null, gems: 0, stars: 2, score: 0, respawnAt: 0, account: null,
      kvx: 0, kvy: 0, weapon: 0, swapUntil: 0, melee: null,
      deaths: 0, supersUsed: 0, cratesBroken: 0, gemsCollected: 0, maxGemsHeld: 0, starsStolen: 0, bestSteal: 0, hauntKOs: 0,
    };
    this.players.set(p.id, p);
    return p;
  }

  // Keep teams within one player of each other, moving bots before people.
  balanceTeams() {
    const all = [...this.players.values()];
    for (;;) {
      const a = all.filter((p) => p.team === 0), b = all.filter((p) => p.team === 1);
      const [big, team] = a.length > b.length + 1 ? [a, 1] : b.length > a.length + 1 ? [b, 0] : [null];
      if (!big) return;
      const mover = [...big].reverse().find((p) => p.bot) ?? big[big.length - 1];
      mover.team = team;
    }
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
      case 'mode':
        if (isHost && this.state === 'lobby' && MODES[m.mode]) {
          this.mode = m.mode;
          if (this.rules.teams) this.balanceTeams();
          this.broadcastRoom();
        }
        break;
      case 'team':
        if (this.state === 'lobby' && this.rules.teams && (m.team === 0 || m.team === 1) && this.teamCount(m.team) < MAX_PLAYERS / 2) {
          p.team = m.team;
          this.broadcastRoom();
        }
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
      case 'forfeit':
        // Leave the current match (it keeps going) and wait in the lobby for the next one.
        if ((this.state === 'playing' || this.state === 'countdown') && p.inMatch && !p.forfeit) {
          p.forfeit = true;
          if (p.alive) this.eliminate(p, null);
          p.ghost = false;
          p.respawnAt = 0;
          this.broadcastRoom();
        }
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
        this.fire(p, Number(m.x) || 0, Number(m.y) || 0, Number(m.d) || 0, leadOf(m));
        break;
      case 's':
        this.superFire(p, Number(m.x) || 0, Number(m.y) || 0, Number(m.d) || 0, leadOf(m));
        break;
      case 'h':
        this.haunt(p);
        break;
      case 'w':
        this.swapWeapon(p);
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
    if (this.rules.teams) this.balanceTeams();
    const roster = [...this.players.values()].sort(() => Math.random() - 0.5);
    const ring = spawnPoints(roster.length);
    const teamIndex = [0, 0];
    this.crates = this.mode === 'showdown' ? crateSpots().map((s) => ({ id: this.nextObjId++, x: s.x, y: s.y, hp: CRATE_HP })) : [];
    roster.forEach((p, i) => {
      const b = BRAWLERS[p.brawler];
      const spot = this.rules.teams ? teamSpawn(p.team, teamIndex[p.team]++) : ring[i];
      Object.assign(p, {
        inMatch: true, alive: true, ghost: false, x: spot.x, y: spot.y, hp: b.hp, maxHp: b.hp,
        ammo: MAX_AMMO, cooldown: 0, superCharge: 0, dash: null, hauntCd: 0, hauntAcc: 0, emote: -1, emoteUntil: 0,
        cubes: 0, kills: 0, rank: 0, inputs: [], ack: 0, lastHurt: -99, lastAttack: -99, revealUntil: -99, poisonAcc: 0,
        gems: 0, stars: 2, score: 0, respawnAt: 0, forfeit: false, kvx: 0, kvy: 0, weapon: 0, swapUntil: 0, melee: null,
        deaths: 0, supersUsed: 0, cratesBroken: 0, gemsCollected: 0, maxGemsHeld: 0, starsStolen: 0, bestSteal: 0, hauntKOs: 0,
        aim: Math.atan2(CENTER - spot.y, CENTER - spot.x),
        ai: p.bot ? { strafe: 1, strafeT: 0, target: null, reactAt: 0, wp: null, wpT: 0, unstuckT: 0, ux: 0, uy: 0, lx: 0, ly: 0, swapCd: 0, pickT: 0 } : null,
      });
      resolveCircles(p, PLAYER_RADIUS, this.crates);
    });
    this.projs = [];
    this.cubes = [];
    this.haunts = [];
    this.gems = [];
    this.gemCountdown = null;
    this.nextGemAt = 4;
    this.events = [];
    this.time = 0;
    this.matchTime = 0;
    this.results = null;
    this.winnerTeam = null;
    this.state = 'countdown';
    this.broadcastRoom();
    this.stopLoop();
    this.loop = setInterval(() => this.tick(), 1000 / TICK_RATE);
  }

  // winners: list of players who won (may be empty for a draw).
  endMatch(winners, winnerTeam = null) {
    const all = [...this.players.values()].filter((p) => p.inMatch);
    for (const p of winners) { p.rank = 1; p.wins++; }
    this.winnerTeam = winnerTeam;
    if (this.mode !== 'showdown') {
      // Respawn modes rank by score, winners first.
      const key = (p) => (this.mode === 'bounty' ? p.score : p.kills * 10 + p.gems);
      all.sort((a, b) => (winners.includes(b) - winners.includes(a)) || key(b) - key(a));
      all.forEach((p, i) => { p.rank = i + 1; });
    }
    this.state = 'ended';
    this.results = all
      .sort((a, b) => a.rank - b.rank)
      .map((p) => ({
        id: p.id, name: p.name, brawler: p.brawler, rank: p.rank, kills: p.kills, bot: p.bot, wins: p.wins,
        team: p.team, score: p.score, won: winners.includes(p),
      }));
    this.sendSnapshots();
    this.stopLoop();
    this.broadcastRoom();
    this.resultsTimer = setTimeout(() => this.backToLobby(), RESULTS_MS);
    // Hand signed-in players' results to the account system (trophies, stats, badges).
    const humans = all.filter((p) => !p.bot).length;
    const records = all.filter((p) => p.account && !p.bot).map((p) => ({
      player: p,
      match: {
        mode: this.mode, brawler: p.brawler, won: winners.includes(p), draw: this.rules.teams && winnerTeam === null,
        rank: p.rank, kills: p.kills, deaths: p.deaths, supers: p.supersUsed, crates: p.cratesBroken,
        gemsCollected: p.gemsCollected, maxGemsHeld: p.maxGemsHeld, starsStolen: p.starsStolen, bestSteal: p.bestSteal,
        hauntKOs: p.hauntKOs, humans,
      },
    }));
    if (records.length) this.onResults(records);
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
    this.gems = [];
    this.broadcastRoom();
  }

  stopLoop() {
    clearInterval(this.loop);
    this.loop = null;
  }

  teamGems() {
    const t = [0, 0];
    for (const p of this.players.values()) if (p.inMatch && p.alive) t[p.team] += p.gems;
    return t;
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
    const showdown = this.mode === 'showdown';
    const safeR = showdown ? poisonRadius(this.matchTime) : Infinity;
    this.haunts = this.haunts.filter((h) => h.until > this.time);

    if (this.rules.respawn) {
      for (const p of this.players.values()) {
        if (p.inMatch && !p.alive && !p.forfeit && p.respawnAt && this.time >= p.respawnAt) this.respawn(p);
      }
    }
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
        p.kvx = 0; p.kvy = 0; // a charging brawler ignores knockback
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
      p.ammo = Math.min(MAX_AMMO, p.ammo + DT / weaponOf(p.brawler, p.weapon).reload);
      if (p.melee && this.time >= p.melee.at) this.resolveMelee(p);
      p.cooldown = Math.max(0, p.cooldown - DT);
      if (this.time - p.lastHurt > REGEN_DELAY && this.time - p.lastAttack > REGEN_DELAY && p.hp < p.maxHp) {
        p.hp = Math.min(p.maxHp, p.hp + p.maxHp * REGEN_RATE * DT);
      }
    }

    // Poison (Showdown) and haunts
    for (const p of fighters) {
      if (!p.alive) continue;
      if (showdown && Math.hypot(p.x - CENTER, p.y - CENTER) > safeR) {
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

    // Loose items fly and bounce before they settle
    for (const it of this.cubes) moveItem(it);
    for (const it of this.gems) moveItem(it);

    // Power cubes (Showdown)
    for (const p of fighters) {
      if (!p.alive) continue;
      this.cubes = this.cubes.filter((c) => {
        if (!itemSettled(c) || Math.hypot(c.x - p.x, c.y - p.y) > CUBE_PICKUP) return true;
        p.cubes++;
        p.maxHp += CUBE_HP;
        p.hp += CUBE_HP;
        this.events.push({ k: 'cube', id: p.id, x: Math.round(c.x), y: Math.round(c.y) });
        return false;
      });
    }

    if (this.mode === 'gemgrab') this.updateGems(fighters);

    this.sendSnapshots();
    this.checkEnd();
  }

  updateGems(fighters) {
    if (this.matchTime >= this.nextGemAt) {
      this.nextGemAt = this.matchTime + GEM.every;
      if (this.gems.length < MAX_GEMS_ON_MAP) {
        const a = Math.random() * Math.PI * 2;
        const v = ITEM.launchMin + Math.random() * (ITEM.launchMax - ITEM.launchMin);
        this.gems.push({ id: this.nextObjId++, x: CENTER + Math.cos(a) * 30, y: CENTER + Math.sin(a) * 30, vx: Math.cos(a) * v, vy: Math.sin(a) * v, born: this.time });
        this.events.push({ k: 'gemspawn', x: CENTER, y: CENTER });
      }
    }
    for (const p of fighters) {
      if (!p.alive) continue;
      this.gems = this.gems.filter((g) => {
        if (!itemSettled(g) || Math.hypot(g.x - p.x, g.y - p.y) > GEM.pickup) return true;
        p.gems++;
        p.gemsCollected++;
        p.maxGemsHeld = Math.max(p.maxGemsHeld, p.gems);
        this.events.push({ k: 'gem', id: p.id, x: Math.round(g.x), y: Math.round(g.y) });
        return false;
      });
    }
    // A team holding 10+ gems, and more than the other team, starts the 15 s countdown.
    const [a, b] = this.teamGems();
    const leader = a >= GEM.toWin && a > b ? 0 : b >= GEM.toWin && b > a ? 1 : null;
    if (leader === null) this.gemCountdown = null;
    else if (!this.gemCountdown || this.gemCountdown.team !== leader) this.gemCountdown = { team: leader, endsAt: this.time + GEM.countdown };
  }

  checkEnd() {
    if (this.state !== 'playing') return;
    const inMatch = [...this.players.values()].filter((p) => p.inMatch);
    if (this.mode === 'showdown') {
      const alive = inMatch.filter((p) => p.alive);
      if (alive.length <= 1) this.endMatch(alive);
      return;
    }
    if (this.mode === 'gemgrab') {
      if (this.gemCountdown && this.time >= this.gemCountdown.endsAt) {
        const t = this.gemCountdown.team;
        return this.endMatch(inMatch.filter((p) => p.team === t), t);
      }
      if (this.matchTime >= this.rules.duration) {
        const [a, b] = this.teamGems();
        const t = a > b ? 0 : b > a ? 1 : null;
        return this.endMatch(t === null ? [] : inMatch.filter((p) => p.team === t), t);
      }
      // Everyone on one team left the room: the other team wins.
      for (const t of [0, 1]) if (!inMatch.some((p) => p.team === t)) return this.endMatch(inMatch, 1 - t);
      return;
    }
    if (this.mode === 'bounty' && this.matchTime >= this.rules.duration) {
      const best = Math.max(...inMatch.map((p) => p.score));
      this.endMatch(best > 0 ? inMatch.filter((p) => p.score === best) : []);
    }
  }

  respawn(p) {
    const b = BRAWLERS[p.brawler];
    let spot;
    if (this.rules.teams) spot = teamSpawn(p.team, Math.floor(Math.random() * 3));
    else {
      // Pick the spawn point furthest from everyone still fighting.
      const others = [...this.players.values()].filter((o) => o.alive && o !== p);
      spot = spawnPoints(8).reduce((best, s) => {
        const d = Math.min(...others.map((o) => Math.hypot(o.x - s.x, o.y - s.y)), 1e9);
        return d > best.d ? { ...s, d } : best;
      }, { d: -1 }) ;
    }
    Object.assign(p, {
      alive: true, x: spot.x, y: spot.y, hp: b.hp, maxHp: b.hp, ammo: MAX_AMMO, cooldown: 0, dash: null,
      inputs: [], respawnAt: 0, lastHurt: -99, revealUntil: this.time + 1.5, kvx: 0, kvy: 0, melee: null,
    });
    this.events.push({ k: 'spawn', id: p.id, x: Math.round(p.x), y: Math.round(p.y) });
  }

  attackStart(p, ax, ay) {
    p.lastAttack = this.time;
    p.revealUntil = this.time + REVEAL_TIME;
    p.aim = Math.atan2(ay, ax);
  }

  fire(p, ax, ay, dist, lead = 0) {
    if (p.ghost) return this.haunt(p);
    if (this.state !== 'playing' || !p.alive || p.dash || p.melee || p.ammo < 1 || p.cooldown > 0 || this.time < p.swapUntil) return;
    const len = Math.hypot(ax, ay);
    if (len < 0.01) return;
    ax /= len; ay /= len;
    const w = weaponOf(p.brawler, p.weapon);
    p.ammo -= 1;
    p.cooldown = SHOT_COOLDOWN;
    this.attackStart(p, ax, ay);
    const dmg = w.damage * (1 + CUBE_DMG * p.cubes);
    this.events.push({ k: 'shot', id: p.id, w: w.attack, x: Math.round(p.x), y: Math.round(p.y) });

    if (w.attack === 'melee') {
      // A short windup, then the blow lands (see resolveMelee): dodgeable, but devastating up close.
      p.melee = { at: this.time + w.windup, ax, ay, dmg, w };
      this.events.push({ k: 'melee', id: p.id, x: Math.round(p.x), y: Math.round(p.y), a: round2(p.aim) });
      return;
    }
    if (w.attack === 'lob') {
      this.spawnLob(p, ax, ay, clamp(dist, 80, w.range), dmg, w.blast, w.flight, false, lead, w.knock);
      return;
    }
    const shots = w.attack === 'shotgun' ? w.pellets : 1;
    const kind = w.attack === 'shotgun' ? 'pellet' : w.hitR ? 'orb' : 'bullet';
    for (let i = 0; i < shots; i++) {
      const a = p.aim + (shots > 1 ? (i / (shots - 1) - 0.5) * w.spread : 0);
      this.spawnBullet(p, a, kind, dmg, w.projSpeed, w.range, Boolean(w.pierce), lead, { knock: w.knock, hitR: w.hitR });
    }
  }

  // Swap between main and alt weapon: 0.35 s during which you can move but not attack. Ammo is shared.
  swapWeapon(p) {
    if (this.state !== 'playing' || !p.alive || p.dash || p.melee || this.time < p.swapUntil) return;
    p.weapon ^= 1;
    p.swapUntil = this.time + SWAP_TIME;
    this.events.push({ k: 'swap', id: p.id, w: p.weapon, x: Math.round(p.x), y: Math.round(p.y) });
  }

  resolveMelee(p) {
    const { ax, ay, dmg, w } = p.melee;
    p.melee = null;
    if (!p.alive) return;
    for (const o of this.players.values()) {
      if (!o.alive || o === p || this.sameTeam(p, o)) continue;
      const dx = o.x - p.x, dy = o.y - p.y, d = Math.hypot(dx, dy);
      if (d > w.range + PLAYER_RADIUS * 0.5) continue;
      if (d > 1 && (dx * ax + dy * ay) / d < Math.cos(w.arc)) continue;
      this.damage(o, dmg, p);
      this.impulse(o, ax * w.knock, ay * w.knock);
    }
    for (const c of [...this.crates]) {
      const dx = c.x - p.x, dy = c.y - p.y, d = Math.hypot(dx, dy);
      if (d <= w.range + CRATE_R && (d < 1 || (dx * ax + dy * ay) / d >= Math.cos(w.arc))) this.hitCrate(c, dmg, p);
    }
  }

  // Knockback: adds velocity (scaled down in Showdown and against charging brawlers), capped.
  impulse(p, ix, iy) {
    if (!p.alive) return;
    let k = this.mode === 'showdown' ? KB.showdownScale : 1;
    if (p.dash) k *= KB.dashArmor;
    p.kvx += ix * k;
    p.kvy += iy * k;
    const v = Math.hypot(p.kvx, p.kvy);
    if (v > KB.max) { p.kvx *= KB.max / v; p.kvy *= KB.max / v; }
  }

  superFire(p, ax, ay, dist, lead = 0) {
    if (this.state !== 'playing' || !p.alive || p.dash || p.superCharge < 1) return;
    const len = Math.hypot(ax, ay);
    if (len < 0.01) return;
    ax /= len; ay /= len;
    const s = BRAWLERS[p.brawler].super;
    p.superCharge = 0;
    p.supersUsed++;
    this.attackStart(p, ax, ay);
    const dmg = s.damage * (1 + CUBE_DMG * p.cubes);
    this.events.push({ k: 'super', id: p.id, w: s.kind, x: Math.round(p.x), y: Math.round(p.y) });
    if (s.kind === 'charge') {
      p.dash = { vx: ax * s.speed, vy: ay * s.speed, left: s.range, dmg, hit: new Set() };
    } else if (s.kind === 'volley') {
      for (let i = 0; i < s.shots; i++) {
        this.spawnBullet(p, p.aim + (i / (s.shots - 1) - 0.5) * s.spread, 'volley', dmg, s.projSpeed, s.range, true, lead, { knock: 120 });
      }
    } else {
      this.spawnLob(p, ax, ay, clamp(dist, 100, s.range), dmg, s.blast, s.flight, true, lead, 900);
    }
  }

  // `lead` (seconds) fast-forwards the shot by the shooter's network delay, so what they saw is what hits.
  spawnBullet(p, a, kind, dmg, speed, range, pierce, lead = 0, { knock = 0, hitR = 0 } = {}) {
    const pr = {
      id: this.nextObjId++, kind, owner: p.id, dmg, knock, hitR: PLAYER_RADIUS + (hitR || 10),
      x: p.x + Math.cos(a) * (PLAYER_RADIUS + 4), y: p.y + Math.sin(a) * (PLAYER_RADIUS + 4),
      vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, travelled: 0, range, hit: pierce ? new Set() : null,
    };
    if (lead <= 0 || !this.stepBullet(pr, lead)) this.projs.push(pr);
  }

  spawnLob(p, ax, ay, d, dmg, blast, flight, big, lead = 0, knock = 500) {
    this.projs.push({
      id: this.nextObjId++, kind: 'lob', owner: p.id, dmg, sx: p.x, sy: p.y, big, knock,
      tx: clamp(p.x + ax * d, 0, WORLD), ty: clamp(p.y + ay * d, 0, WORLD), t: Math.min(lead, flight * 0.5), flight, blast,
    });
  }

  // Moves a bullet for `dt` seconds in small steps; returns true once it has hit something or run out of range.
  stepBullet(pr, dt) {
    const owner = this.players.get(pr.owner);
    const speed = Math.hypot(pr.vx, pr.vy);
    const steps = Math.max(1, Math.ceil((speed * dt) / 14));
    for (let s = 0; s < steps; s++) {
      pr.x += (pr.vx * dt) / steps;
      pr.y += (pr.vy * dt) / steps;
      pr.travelled += (speed * dt) / steps;
      if (pr.travelled > pr.range) return true;
      if (isWallAt(pr.x, pr.y) || pr.x < 0 || pr.y < 0 || pr.x > WORLD || pr.y > WORLD) {
        this.events.push({ k: 'spark', x: Math.round(pr.x), y: Math.round(pr.y) });
        return true;
      }
      const crate = this.crates.find((c) => Math.hypot(c.x - pr.x, c.y - pr.y) < CRATE_R + 6);
      if (crate) { this.hitCrate(crate, pr.dmg, owner); return true; }
      for (const p of this.players.values()) {
        if (!p.alive || p.id === pr.owner || pr.hit?.has(p.id) || this.sameTeam(owner, p)) continue;
        if (Math.hypot(p.x - pr.x, p.y - pr.y) <= pr.hitR) {
          this.damage(p, pr.dmg, owner);
          if (pr.knock) this.impulse(p, (pr.vx / speed) * pr.knock, (pr.vy / speed) * pr.knock);
          if (pr.hit) pr.hit.add(p.id); // piercing shots keep going
          else return true;
        }
      }
    }
    return false;
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
        if (Math.hypot(c.x - p.x, c.y - p.y) < PLAYER_RADIUS + CRATE_R + 4) this.hitCrate(c, d.dmg, p);
      }
      resolveCircles(p, PLAYER_RADIUS, this.crates);
      for (const o of this.players.values()) {
        if (!o.alive || o === p || d.hit.has(o.id) || this.sameTeam(p, o)) continue;
        const dx = o.x - p.x, dy = o.y - p.y, dist = Math.hypot(dx, dy);
        if (dist < PLAYER_RADIUS * 2 + 6) {
          d.hit.add(o.id);
          this.damage(o, d.dmg, p);
          // Toss them aside: sideways toward whichever side they were on, plus some forward carry.
          const sp = Math.hypot(d.vx, d.vy), fx = d.vx / sp, fy = d.vy / sp;
          const side = Math.sign(-fy * dx + fx * dy) || 1;
          this.impulse(o, -fy * 320 * side + fx * 150, fx * 320 * side + fy * 150);
        }
      }
    }
    d.left -= step;
    const moved = Math.hypot(p.x - ox, p.y - oy);
    if (d.left <= 0 || moved < step * 0.3) p.dash = null;
  }

  hitCrate(c, dmg, by = null) {
    if (!this.crates.includes(c)) return;
    c.hp -= dmg;
    this.events.push({ k: 'crate', x: Math.round(c.x), y: Math.round(c.y) });
    if (c.hp > 0) return;
    this.crates = this.crates.filter((x) => x !== c);
    if (by) by.cratesBroken++;
    const a = Math.random() * Math.PI * 2, v = ITEM.launchMin + Math.random() * (ITEM.launchMax - ITEM.launchMin);
    this.cubes.push({ id: this.nextObjId++, x: c.x, y: c.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v });
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
          const d = Math.hypot(p.x - pr.tx, p.y - pr.ty);
          if (p.alive && p.id !== pr.owner && !this.sameTeam(owner, p) && d <= pr.blast + PLAYER_RADIUS) {
            this.damage(p, pr.dmg, owner);
            const a = d > 1 ? Math.atan2(p.y - pr.ty, p.x - pr.tx) : Math.random() * Math.PI * 2;
            const mag = pr.knock * (1 - 0.5 * Math.min(1, d / pr.blast));
            this.impulse(p, Math.cos(a) * mag, Math.sin(a) * mag);
          }
        }
        for (const it of [...this.cubes, ...this.gems]) {
          const d = Math.hypot(it.x - pr.tx, it.y - pr.ty);
          if (d > pr.blast + 20) continue;
          const a = d > 1 ? Math.atan2(it.y - pr.ty, it.x - pr.tx) : Math.random() * Math.PI * 2;
          it.vx = (it.vx || 0) + Math.cos(a) * pr.knock * 0.7;
          it.vy = (it.vy || 0) + Math.sin(a) * pr.knock * 0.7;
        }
        for (const c of [...this.crates]) {
          if (Math.hypot(c.x - pr.tx, c.y - pr.ty) <= pr.blast + CRATE_R) this.hitCrate(c, pr.dmg, owner);
        }
        continue;
      }
      if (!this.stepBullet(pr, DT)) keep.push(pr);
    }
    this.projs = keep;
  }

  damage(p, amount, attacker, haunted = false) {
    if (!p.alive || this.sameTeam(attacker, p)) return;
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

  // Throws `count` items out evenly around (x, y); they fly, bounce and settle (see moveItem).
  scatter(x, y, count, make) {
    const offset = Math.random() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      const a = offset + (i / count) * Math.PI * 2;
      const v = ITEM.launchMin + Math.random() * (ITEM.launchMax - ITEM.launchMin);
      make({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v });
    }
  }

  eliminate(p, attacker, haunted = false) {
    if (!p.alive) return;
    p.alive = false;
    p.hp = 0;
    p.dash = null;
    p.melee = null;
    p.kvx = 0;
    p.kvy = 0;
    p.inputs.length = 0;
    p.deaths++;
    if (attacker && attacker !== p) attacker.kills++;
    if (attacker && haunted) attacker.hauntKOs++;
    let bounty = 0;
    if (this.mode === 'showdown') {
      p.rank = [...this.players.values()].filter((x) => x.alive).length + 1;
      // Humans come back as ghosts so nobody sits out the rest of the round.
      if (!p.bot && this.state !== 'countdown') { p.ghost = true; p.hauntCd = 2; }
      // Drop power cubes: everything they carried plus one.
      this.scatter(p.x, p.y, p.cubes + 1, (s) => this.cubes.push({ id: this.nextObjId++, ...s }));
    } else {
      p.respawnAt = this.time + RESPAWN_TIME;
      if (this.mode === 'bounty') {
        bounty = p.stars;
        if (attacker && attacker !== p) {
          attacker.score += p.stars;
          attacker.starsStolen += p.stars;
          attacker.bestSteal = Math.max(attacker.bestSteal, p.stars);
          attacker.stars = Math.min(7, attacker.stars + 1);
        }
        p.stars = 2;
      }
      if (this.mode === 'gemgrab' && p.gems) {
        this.scatter(p.x, p.y, p.gems, (s) => this.gems.push({ id: this.nextObjId++, ...s, born: this.time }));
        p.gems = 0;
      }
    }
    const left = p.forfeit || !p.connected ? 1 : 0; // walked out or dropped, rather than knocked out
    this.events.push({ k: 'ko', id: p.id, by: attacker ? attacker.id : 0, haunt: haunted ? 1 : 0, bounty, left, x: Math.round(p.x), y: Math.round(p.y) });
  }

  haunt(p) {
    if (this.state !== 'playing' || !p.ghost || p.hauntCd > 0) return;
    p.hauntCd = HAUNT.cooldown;
    this.haunts.push({ id: this.nextObjId++, owner: p.id, x: p.x, y: p.y, r: HAUNT.radius, until: this.time + HAUNT.life });
    this.events.push({ k: 'haunt', id: p.id, x: Math.round(p.x), y: Math.round(p.y) });
  }

  canSee(viewer, p) {
    if (viewer.id === p.id || !viewer.alive || this.sameTeam(viewer, p)) return true;
    if (!inBush(p.x, p.y) || this.time < p.revealUntil) return true;
    return Math.hypot(viewer.x - p.x, viewer.y - p.y) < BUSH_SEE_DIST;
  }

  // ---------- bots ----------

  botThink(p, fighters, safeR) {
    const ai = p.ai;
    let b = weaponOf(p.brawler, p.weapon);
    let mx = 0, my = 0;

    // Stuck on a wall? Walk a random direction for a moment.
    if (ai.unstuckT > 0) {
      ai.unstuckT -= DT;
      ai.lx = p.x; ai.ly = p.y;
      return { mx: ai.ux, my: ai.uy };
    }

    let target = null, td = Infinity;
    for (const o of fighters) {
      if (o === p || !o.alive || this.sameTeam(p, o) || !this.canSee(p, o)) continue;
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      if (d < td && d < 720) { td = d; target = o; }
    }
    // Early in Showdown, bots loot crates and only fight what gets in their face.
    if (target && this.mode === 'showdown' && this.matchTime < 25 && td > 300) { target = null; td = Infinity; }
    // Gem Grab: grab nearby gems first; carry them home when hurt.
    let goal = null;
    if (this.mode === 'gemgrab') {
      const gem = this.gems.reduce((best, g) => {
        const d = Math.hypot(g.x - p.x, g.y - p.y);
        return d < (best?.d ?? Infinity) ? { ...g, d } : best;
      }, null);
      if (p.gems >= 3 && p.hp < p.maxHp * 0.6) goal = teamBase(p.team);
      else if (gem && (!target || gem.d < td * 0.8)) goal = gem;
      if (goal && target && td > 260) target = null;
    }
    if (target !== ai.target) { ai.target = target; ai.reactAt = this.time + 0.45 + Math.random() * 0.3; }
    // Weapon choice: the shortest-range weapon that still reaches the target (else the longest), at most every 3 s.
    ai.pickT -= DT;
    if (target && ai.pickT <= 0) {
      ai.pickT = 1;
      const opts = [0, 1].map((slot) => ({ slot, range: weaponOf(p.brawler, slot).range }));
      const reach = opts.filter((o) => o.range >= td).sort((x, y) => x.range - y.range);
      const pick = (reach[0] ?? opts.sort((x, y) => y.range - x.range)[0]).slot;
      if (pick !== p.weapon && this.time > ai.swapCd) { this.swapWeapon(p); ai.swapCd = this.time + 3; b = weaponOf(p.brawler, p.weapon); }
    }

    const dc = Math.hypot(p.x - CENTER, p.y - CENTER);
    if (dc > safeR - 160) {
      mx = (CENTER - p.x) / dc; my = (CENTER - p.y) / dc;
    } else if (target) {
      const dx = target.x - p.x, dy = target.y - p.y, d = Math.max(1, td);
      const want = b.attack === 'melee' ? 80 : b.attack === 'shotgun' ? 140 : b.range * 0.65;
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
    } else if (goal) {
      const dx = goal.x - p.x, dy = goal.y - p.y, d = Math.max(1, Math.hypot(dx, dy));
      if (d > 20) { mx = dx / d; my = dy / d; }
    } else {
      // Nobody around: go break the nearest crate, otherwise wander.
      let crate = null, cd = 900;
      for (const c of this.crates) {
        const d = Math.hypot(c.x - p.x, c.y - p.y);
        if (d < cd && Math.hypot(c.x - CENTER, c.y - CENTER) < safeR - 100) { cd = d; crate = c; }
      }
      ai.wpT -= DT;
      if (!crate && (!ai.wp || ai.wpT <= 0 || Math.hypot(ai.wp.x - p.x, ai.wp.y - p.y) < 40)) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * Math.min(safeR * 0.6, WORLD * 0.3);
        ai.wp = nearestFloor(CENTER + Math.cos(a) * r, CENTER + Math.sin(a) * r);
        ai.wpT = 4;
      }
      const g = crate ?? ai.wp;
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
      mode: this.mode,
      hostId: this.hostId,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, brawler: p.brawler, bot: p.bot, connected: p.connected, inMatch: p.inMatch, wins: p.wins, team: p.team,
        out: Boolean(p.forfeit),
        trophies: p.account?.trophies ?? null,
      })),
      results: this.results,
      winnerTeam: this.winnerTeam,
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
      ? { i: pr.id, o: pr.owner, k: 'l', sx: Math.round(pr.sx), sy: Math.round(pr.sy), tx: Math.round(pr.tx), ty: Math.round(pr.ty), p: round2(pr.t / pr.flight), r: pr.blast, big: pr.big ? 1 : 0 }
      : { i: pr.id, o: pr.owner, k: { pellet: 'p', volley: 'v', orb: 'o' }[pr.kind] ?? 'b', x: Math.round(pr.x), y: Math.round(pr.y) });
    const base = {
      t: 'snap', time: round2(this.time), state: this.state, mode: this.mode, cd: Math.max(0, COUNTDOWN - this.time),
      poison: Math.round(this.mode === 'showdown' ? poisonRadius(this.matchTime) : 99999), mt: Math.round(this.matchTime), alive: fighters.length,
      left: this.rules.duration ? Math.max(0, Math.ceil(this.rules.duration - this.matchTime)) : null,
      projs,
      cubes: this.cubes.map((c) => ({ i: c.id, x: Math.round(c.x), y: Math.round(c.y) })),
      crates: this.crates.map((c) => ({ i: c.id, x: c.x, y: c.y, h: round2(Math.max(0, c.hp) / CRATE_HP) })),
      haunts: this.haunts.map((h) => ({ i: h.id, x: Math.round(h.x), y: Math.round(h.y), r: h.r, l: round2(h.until - this.time) })),
      ghosts: all.filter((p) => p.ghost).map((p) => ({ i: p.id, x: Math.round(p.x), y: Math.round(p.y), em: emoteOf(p) })),
      gems: this.gems.map((g) => ({ i: g.id, x: Math.round(g.x), y: Math.round(g.y) })),
      tg: this.mode === 'gemgrab' ? this.teamGems() : null,
      gcd: this.gemCountdown ? { team: this.gemCountdown.team, left: Math.max(0, Math.ceil(this.gemCountdown.endsAt - this.time)) } : null,
      scores: this.mode === 'bounty' ? all.filter((p) => p.inMatch).map((p) => [p.id, p.score]) : null,
      ev: this.events,
    };
    for (const viewer of this.humans) {
      if (!viewer.connected || !viewer.ws || viewer.ws.bufferedAmount > 256 * 1024) continue;
      const players = fighters.filter((p) => this.canSee(viewer, p)).map((p) => ({
        i: p.id, x: Math.round(p.x), y: Math.round(p.y), h: Math.round(p.hp), m: p.maxHp, a: round2(p.aim),
        c: p.cubes, bush: inBush(p.x, p.y) ? 1 : 0, em: emoteOf(p), d: p.dash ? 1 : 0, t: p.team, g: p.gems, st: p.stars,
        wp: p.weapon, kx: Math.round(p.kvx), ky: Math.round(p.kvy),
      }));
      const me = {
        alive: viewer.alive, ghost: viewer.ghost, ack: viewer.ack, ammo: round2(viewer.ammo), cubes: viewer.cubes,
        su: round2(viewer.superCharge), hcd: round2(viewer.hauntCd), team: viewer.team, score: viewer.score,
        respawn: viewer.respawnAt ? Math.max(0, Math.ceil(viewer.respawnAt - this.time)) : 0,
        kvx: round2(viewer.kvx), kvy: round2(viewer.kvy), weapon: viewer.weapon, swap: round2(Math.max(0, viewer.swapUntil - this.time)),
      };
      send(viewer.ws, JSON.stringify({ ...base, players, me }));
    }
    this.events = [];
  }
}

// Clients report their one-way delay (ms) with each shot; cap it so nobody can shoot from the future.
const leadOf = (m) => clamp((Number(m.l) || 0) / 1000, 0, 0.15);

export function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}
