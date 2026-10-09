// Shared rules, map and movement physics.
// Imported by the server (authoritative simulation) and the browser (client-side prediction),
// so both sides move players with exactly the same code.

export const TICK_RATE = 30;
export const DT = 1 / TICK_RATE;

export const TILE = 64;
export const MAP_TILES = 40;
export const WORLD = TILE * MAP_TILES;
export const CENTER = WORLD / 2;

export const PLAYER_RADIUS = 26;
export const MAX_PLAYERS = 6;
export const MIN_PLAYERS = 2;
export const MAX_AMMO = 3;
export const SHOT_COOLDOWN = 0.4;
export const REGEN_DELAY = 3;
export const REGEN_RATE = 0.12; // fraction of max HP per second
export const REVEAL_TIME = 1.0; // seconds you stay visible in a bush after shooting / being hit
export const BUSH_SEE_DIST = 150; // enemies this close can see you in a bush
export const CUBE_HP = 400;
export const CUBE_DMG = 0.1; // +10% damage per power cube
export const CUBE_PICKUP = 44;
export const START_CUBES = 6;
export const COUNTDOWN = 3;
export const POISON = { start: 30, end: 150, startR: 1880, endR: 220, dps: 900 };
export const CRATE_R = 28;
export const CRATE_HP = 2600;
export const GHOST_SPEED = 300;
// Ghost Mode: knocked-out players float through walls and drop haunts that slow and hurt survivors.
export const HAUNT = { radius: 85, life: 3, cooldown: 5, slow: 0.5, dps: 220 };
export const EMOTES = ['👍', '😂', '😡', 'GG'];
export const RESPAWN_TIME = 3;

// Knockback physics: impulses add velocity that decays each step; walls stop it (no bouncing players).
export const KB = { decay: 0.86, max: 1400, stop: 20, dashArmor: 0.25, showdownScale: 0.75 };
// Loose items (gems, power cubes) fly out, slow down and bounce off walls; they can only be picked up once settled.
export const ITEM = { decay: 0.9, bounce: 0.45, settled: 60, launchMin: 220, launchMax: 380 };
export const SWAP_TIME = 0.35;
export const GEM = { every: 6, toWin: 10, countdown: 15, pickup: 44 };

// Game modes, Brawl Stars style. Teams are 0 (blue) and 1 (red).
export const MODES = {
  showdown: {
    name: 'Showdown', icon: '☠', teams: false, respawn: false,
    blurb: 'Every brawler for themselves. Poison closes in. Last one standing wins.',
  },
  gemgrab: {
    name: 'Gem Grab', icon: '💎', teams: true, respawn: true, duration: 150,
    blurb: 'Two teams. Grab gems from the mine and hold 10 for 15 seconds to win.',
  },
  bounty: {
    name: 'Bounty', icon: '⭐', teams: false, respawn: true, duration: 120,
    blurb: 'Knock brawlers out to steal their stars. Respawn and keep hunting. Most stars wins.',
  },
};
export const MODE_IDS = Object.keys(MODES);

export const BRAWLERS = {
  brick: {
    name: 'Brick', role: 'Tank', color: '#b4553a', dark: '#7a3624',
    desc: 'Straw-caped bruiser with a brass blunderbuss. Huge health.',
    hp: 5800, speed: 225, reload: 1.5,
    weapon: 'Blunderbuss', icon: '💥',
    attack: 'shotgun', range: 320, pellets: 5, spread: 0.55, damage: 360, projSpeed: 1150, knock: 40,
    alt: { weapon: 'Haymaker', icon: '👊', attack: 'melee', range: 136, arc: 0.87, damage: 2000, windup: 0.12, knock: 420, reload: 1.1 },
    super: { kind: 'charge', name: 'Bulldoze', desc: 'Charge forward, smashing enemies and crates', range: 380, speed: 1150, damage: 1500, charge: 2600 },
    stats: { health: 5, range: 1, damage: 4 },
  },
  vex: {
    name: 'Vex', role: 'Sharpshooter', color: '#3f7f8c', dark: '#24525b',
    desc: 'Bamboo long-rifle. Deadly at range, fragile up close.',
    hp: 3000, speed: 255, reload: 1.35,
    weapon: 'Bamboo Rifle', icon: '🎯',
    attack: 'bullet', range: 760, damage: 1150, projSpeed: 1500, knock: 120,
    alt: { weapon: 'Fan Bolts', icon: '🪶', attack: 'shotgun', pellets: 3, spread: 0.3, range: 400, damage: 560, projSpeed: 1300, knock: 60 },
    super: { kind: 'volley', name: 'Piercing Volley', desc: 'Five shots that pierce through enemies', shots: 5, spread: 0.32, range: 860, damage: 950, projSpeed: 1700, charge: 3000 },
    stats: { health: 2, range: 5, damage: 3 },
  },
  boom: {
    name: 'Boom', role: 'Thrower', color: '#7a4f7a', dark: '#4e304e',
    desc: 'Lobs clay-pot bombs over rocks. Splash damage.',
    hp: 3400, speed: 245, reload: 1.75,
    weapon: 'Clay Bomb', icon: '💣',
    attack: 'lob', range: 560, damage: 1300, blast: 85, flight: 0.65, knock: 500,
    alt: { weapon: 'Bowler', icon: '🎳', attack: 'bullet', range: 420, damage: 950, projSpeed: 650, hitR: 30, pierce: true, knock: 200, reload: 1.49 },
    super: { kind: 'mega', name: 'Mega Bomb', desc: 'A huge bomb with a massive blast', range: 640, damage: 2300, blast: 150, flight: 0.9, charge: 2800 },
    stats: { health: 3, range: 4, damage: 4 },
  },
};
export const BRAWLER_IDS = Object.keys(BRAWLERS);

// The stats of the weapon a brawler currently holds (0 = main, 1 = alt). Health, speed and Super never change.
export function weaponOf(id, slot) {
  const b = BRAWLERS[id];
  return slot ? { ...b, ...b.alt } : b;
}

// '.' floor, '#' wall, '*' bush, 'w' water (blocks walking, not shots).
// One 20x20 quadrant, mirrored four ways so the map is fair from every spawn and for both teams.
const QUADRANT = [
  '....................',
  '.**.....##......**..',
  '.**...........#.**..',
  '......###.....#.....',
  '..#...........#..##.',
  '..#...**..........#.',
  '..#...**..###.....#.',
  '...............*....',
  '.###...ww.....***...',
  '.......ww......*....',
  '...**.......#.......',
  '...**...#...#...###.',
  '........#...........',
  '.##.....#...**......',
  '.............**..#..',
  '..***...##.......#..',
  '..***...........##..',
  '.......#............',
  '...#...#.....**.....',
  '...#.........**.....',
];

export const MAP = (() => {
  const half = MAP_TILES / 2;
  if (QUADRANT.length !== half || QUADRANT.some((row) => row.length !== half)) {
    throw new Error(`Map quadrant must be ${half}x${half}`);
  }
  const rows = [];
  for (let r = 0; r < MAP_TILES; r++) {
    let row = '';
    for (let c = 0; c < MAP_TILES; c++) {
      row += QUADRANT[r < half ? r : MAP_TILES - 1 - r][c < half ? c : MAP_TILES - 1 - c];
    }
    rows.push(row);
  }
  return rows;
})();

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function tileAt(x, y) {
  const c = Math.floor(x / TILE);
  const r = Math.floor(y / TILE);
  if (r < 0 || c < 0 || r >= MAP_TILES || c >= MAP_TILES) return '#';
  return MAP[r][c];
}
export const isWallAt = (x, y) => tileAt(x, y) === '#';
const SOLID = new Set(['#', 'w']);
export const inBush = (x, y) => tileAt(x, y) === '*';

// Push a circle out of any wall tiles it overlaps, and keep it inside the world.
export function resolveWalls(p, radius) {
  p.x = clamp(p.x, radius, WORLD - radius);
  p.y = clamp(p.y, radius, WORLD - radius);
  const c0 = Math.floor((p.x - radius) / TILE);
  const c1 = Math.floor((p.x + radius) / TILE);
  const r0 = Math.floor((p.y - radius) / TILE);
  const r1 = Math.floor((p.y + radius) / TILE);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (!SOLID.has(MAP[r]?.[c])) continue;
      const left = c * TILE, top = r * TILE, right = left + TILE, bottom = top + TILE;
      const nx = clamp(p.x, left, right);
      const ny = clamp(p.y, top, bottom);
      const dx = p.x - nx, dy = p.y - ny;
      const d2 = dx * dx + dy * dy;
      if (d2 >= radius * radius) continue;
      if (d2 > 1e-6) {
        const d = Math.sqrt(d2);
        p.x = nx + (dx / d) * radius;
        p.y = ny + (dy / d) * radius;
      } else {
        // Centre is inside the tile: push out through the nearest edge.
        const pushes = [
          [p.x - left + radius, -1, 0],
          [right - p.x + radius, 1, 0],
          [p.y - top + radius, 0, -1],
          [bottom - p.y + radius, 0, 1],
        ].sort((a, b) => a[0] - b[0]);
        p.x += pushes[0][1] * pushes[0][0];
        p.y += pushes[0][2] * pushes[0][0];
      }
    }
  }
}

// Push a circle out of round solids (crates).
export function resolveCircles(p, radius, solids) {
  for (const s of solids) {
    const dx = p.x - s.x, dy = p.y - s.y;
    const min = radius + CRATE_R;
    const d2 = dx * dx + dy * dy;
    if (d2 >= min * min) continue;
    const d = Math.sqrt(d2);
    if (d < 1e-6) { p.x += min; continue; }
    p.x = s.x + (dx / d) * min;
    p.y = s.y + (dy / d) * min;
  }
}

// Move one fixed tick. (mx, my) is the joystick vector, length <= 1. `solids` are crates.
// Knockback velocity (p.kvx, p.kvy) is integrated in the same step, so host and client predict identically.
export function movePlayer(p, mx, my, speed, solids = []) {
  const len = Math.hypot(mx, my);
  if (len >= 0.05) {
    if (len > 1) { mx /= len; my /= len; }
    p.x += mx * speed * DT;
    resolveWalls(p, PLAYER_RADIUS);
    resolveCircles(p, PLAYER_RADIUS, solids);
    p.y += my * speed * DT;
    resolveWalls(p, PLAYER_RADIUS);
    resolveCircles(p, PLAYER_RADIUS, solids);
    resolveWalls(p, PLAYER_RADIUS);
  }
  applyKnockback(p, solids);
}

// Slide along walls: a blocked axis loses its velocity, the other keeps sliding.
export function applyKnockback(p, solids = []) {
  if (!p.kvx && !p.kvy) return;
  const x0 = p.x;
  p.x += p.kvx * DT;
  resolveWalls(p, PLAYER_RADIUS);
  resolveCircles(p, PLAYER_RADIUS, solids);
  if (Math.abs(p.x - (x0 + p.kvx * DT)) > 0.5) p.kvx = 0;
  const y0 = p.y;
  p.y += p.kvy * DT;
  resolveWalls(p, PLAYER_RADIUS);
  resolveCircles(p, PLAYER_RADIUS, solids);
  if (Math.abs(p.y - (y0 + p.kvy * DT)) > 0.5) p.kvy = 0;
  p.kvx *= KB.decay;
  p.kvy *= KB.decay;
  if (Math.hypot(p.kvx, p.kvy) < KB.stop) { p.kvx = 0; p.kvy = 0; }
}

// Loose items: fly, slow down, bounce off walls and ponds.
export function moveItem(it) {
  if (!it.vx && !it.vy) return;
  const solid = (x, y) => tileAt(x, y) === '#' || tileAt(x, y) === 'w';
  const nx = it.x + it.vx * DT;
  if (solid(nx, it.y) || nx < 16 || nx > WORLD - 16) it.vx = -it.vx * ITEM.bounce; else it.x = nx;
  const ny = it.y + it.vy * DT;
  if (solid(it.x, ny) || ny < 16 || ny > WORLD - 16) it.vy = -it.vy * ITEM.bounce; else it.y = ny;
  it.vx *= ITEM.decay;
  it.vy *= ITEM.decay;
  if (Math.hypot(it.vx, it.vy) < 8) { it.vx = 0; it.vy = 0; }
}
export const itemSettled = (it) => Math.hypot(it.vx || 0, it.vy || 0) < ITEM.settled;

// Ghosts drift through walls and crates; only the arena edge stops them.
export function moveGhost(p, mx, my) {
  const len = Math.hypot(mx, my);
  if (len < 0.05) return;
  if (len > 1) { mx /= len; my /= len; }
  p.x = clamp(p.x + mx * GHOST_SPEED * DT, PLAYER_RADIUS, WORLD - PLAYER_RADIUS);
  p.y = clamp(p.y + my * GHOST_SPEED * DT, PLAYER_RADIUS, WORLD - PLAYER_RADIUS);
}

// Haunts slow anyone standing in them.
export function speedFactor(x, y, haunts) {
  for (const h of haunts) {
    if (Math.hypot(x - h.x, y - h.y) < h.r) return HAUNT.slow;
  }
  return 1;
}

// Inputs travel as 2-decimal numbers; both sides must predict with the identical rounded values.
export const round2 = (v) => Math.round(v * 100) / 100;

export function hasLineOfSight(x0, y0, x1, y1) {
  const d = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.ceil(d / 16);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (isWallAt(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false;
  }
  return true;
}

export function poisonRadius(matchTime) {
  const { start, end, startR, endR } = POISON;
  if (matchTime <= start) return startR;
  const t = Math.min(1, (matchTime - start) / (end - start));
  return startR + (endR - startR) * t;
}

// Nearest open floor tile centre to (x, y).
export function nearestFloor(x, y) {
  const c0 = clamp(Math.floor(x / TILE), 0, MAP_TILES - 1);
  const r0 = clamp(Math.floor(y / TILE), 0, MAP_TILES - 1);
  for (let ring = 0; ring < MAP_TILES; ring++) {
    for (let r = r0 - ring; r <= r0 + ring; r++) {
      for (let c = c0 - ring; c <= c0 + ring; c++) {
        if (Math.max(Math.abs(r - r0), Math.abs(c - c0)) !== ring) continue;
        if (MAP[r]?.[c] === '.') return { x: c * TILE + TILE / 2, y: r * TILE + TILE / 2 };
      }
    }
  }
  return { x: CENTER, y: CENTER };
}

// Crate spots in one quadrant (row, col), mirrored four ways like the map.
const CRATE_TILES = [[5, 12], [10, 7], [14, 4], [3, 17]];
export function crateSpots() {
  const spots = [];
  for (const [r, c] of CRATE_TILES) {
    for (const [rr, cc] of [[r, c], [r, MAP_TILES - 1 - c], [MAP_TILES - 1 - r, c], [MAP_TILES - 1 - r, MAP_TILES - 1 - c]]) {
      spots.push({ x: cc * TILE + TILE / 2, y: rr * TILE + TILE / 2 });
    }
  }
  return spots;
}

export function spawnPoints(n) {
  const pts = [];
  const offset = Math.random() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = offset + (i / n) * Math.PI * 2;
    pts.push(nearestFloor(CENTER + Math.cos(a) * WORLD * 0.37, CENTER + Math.sin(a) * WORLD * 0.37));
  }
  return pts;
}

// Team bases: blue along the south edge, red along the north edge.
export function teamBase(team) {
  return { x: CENTER, y: team === 0 ? WORLD - TILE * 2.5 : TILE * 2.5 };
}

export function teamSpawn(team, index) {
  const b = teamBase(team);
  const offset = (index % 2 ? 1 : -1) * Math.ceil(index / 2) * TILE * 2.2;
  return nearestFloor(b.x + offset, b.y);
}
