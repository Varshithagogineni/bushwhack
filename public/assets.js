// Loads the Blender-rendered art (see tools/blender/build_assets.py) and draws sprites from it.
// If anything fails to load, `art.ready` stays false and the renderer falls back to vector shapes.
import { MAP, TILE } from '/shared/game.js';

export const art = { ready: false, manifest: null, images: {}, walls: [], bushes: [], sea: '#2a86cf' };

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error(`failed to load ${src}`));
  img.src = src;
});

export async function loadArt() {
  try {
    const m = await (await fetch('/assets/manifest.json', { cache: 'no-cache' })).json();
    const files = new Set([m.ground?.file, m.props?.file, ...Object.values(m.characters ?? {}).map((c) => c.file)].filter(Boolean));
    const loaded = await Promise.all([...files].map((f) => loadImage(`/assets/${f}`).then((img) => [f, img])));
    art.images = Object.fromEntries(loaded);
    art.manifest = m;
    // Same variant formula as the Blender script, so baked shadows match the sprites.
    MAP.forEach((row, r) => [...row].forEach((ch, c) => {
      const tile = { x: c * TILE + TILE / 2, y: r * TILE + TILE / 2, v: (r * 7 + c * 13) % 3, key: (r + 1) * TILE, r, c };
      if (ch === '#') art.walls.push(tile);
      else if (ch === '*') art.bushes.push(tile);
    }));
    art.sea = sampleEdgeColor(art.images[m.ground.file]) ?? art.sea;
    art.ready = Boolean(m.ground && m.props && m.characters?.brick && m.characters?.vex && m.characters?.boom);
  } catch (e) {
    console.warn('Art not available, using simple shapes.', e);
  }
  return art.ready;
}

// The deep-water colour at the image's corner, so the sea blends into the page background.
function sampleEdgeColor(img) {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, 8, 8, 0, 0, 8, 8);
    const d = g.getImageData(0, 0, 8, 8).data;
    let r = 0, gr = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gr += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4;
    return `rgb(${Math.round(r / n)}, ${Math.round(gr / n)}, ${Math.round(b / n)})`;
  } catch {
    return null;
  }
}

const TAU = Math.PI * 2;

// Character sprite: picks the facing (16 directions) and walk frame from the atlas.
export function drawChar(ctx, id, x, y, aim, frame) {
  const c = art.manifest.characters[id];
  const img = art.images[c.file];
  const d = Math.round((((aim % TAU) + TAU) % TAU) / TAU * c.dirs) % c.dirs;
  const s = c.scale;
  ctx.drawImage(img, frame * c.cell, d * c.cell, c.cell, c.cell, x - c.ax * s, y - c.ay * s, c.cell * s, c.cell * s);
}

export function drawProp(ctx, name, x, y) {
  const p = art.manifest.props;
  const sp = p.sprites[name];
  if (!sp) return;
  const s = p.scale;
  ctx.drawImage(art.images[p.file], sp.x, sp.y, sp.w, sp.h, x - sp.ax * s, y - sp.ay * s, sp.w * s, sp.h * s);
}

export function drawGround(ctx) {
  const g = art.manifest.ground;
  ctx.drawImage(art.images[g.file], g.x, g.y, g.size, g.size);
}

// Portrait for lobby cards: the character's 3/4 front view, cropped around the body.
export function drawPortrait(ctx, id, w, h) {
  const c = art.manifest.characters[id];
  const crop = c.cell * 0.66;
  ctx.drawImage(art.images[c.file], (c.cell - crop) / 2, 3 * c.cell + c.cell * 0.04, crop, crop, 0, 0, w, h);
}
