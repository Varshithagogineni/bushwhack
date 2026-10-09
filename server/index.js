import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Room, send } from './room.js';
import { Accounts, UserError } from './accounts.js';
import { createStore } from './store.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'shared');
const THREE_DIR = path.join(ROOT, 'node_modules', 'three');
const PORT = Number(process.env.PORT) || 3000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O, so codes are easy to read aloud
const store = createStore(ROOT);
const accounts = new Accounts(store);
console.log(`Accounts stored in ${store.kind === 'supabase' ? 'Supabase' : 'data/accounts.json'}`);

// ---------- JSON API: optional accounts, profiles, leaderboard ----------

const attempts = new Map(); // ip -> { n, reset }: slow down password guessing
function rateLimited(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const now = Date.now();
  const a = attempts.get(ip) ?? { n: 0, reset: now + 5 * 60_000 };
  if (now > a.reset) { a.n = 0; a.reset = now + 5 * 60_000; }
  a.n++;
  attempts.set(ip, a);
  return a.n > 20;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 8192) { reject(new UserError('Request too large.')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new UserError('Bad request.')); } });
  });
}

const bearer = (req) => (req.headers.authorization ?? '').replace(/^Bearer /, '');

async function handleApi(req, res, pathname) {
  const reply = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  try {
    if (req.method === 'POST' && (pathname === '/api/signup' || pathname === '/api/login')) {
      if (rateLimited(req)) return reply(429, { error: 'Too many tries. Wait a few minutes.' });
      const { username, password } = await readJson(req);
      const result = pathname === '/api/signup' ? await accounts.signup(username, password) : await accounts.login(username, password);
      return reply(200, result);
    }
    if (req.method === 'POST' && pathname === '/api/logout') {
      await accounts.logout(bearer(req));
      return reply(200, { ok: true });
    }
    if (req.method === 'GET' && pathname === '/api/me') {
      const p = await accounts.resolve(bearer(req));
      return p ? reply(200, { profile: (await accounts.profile(p.username)) }) : reply(401, { error: 'Signed out.' });
    }
    if (req.method === 'GET' && pathname === '/api/leaderboard') return reply(200, { top: await accounts.leaderboard() });
    if (req.method === 'GET' && pathname.startsWith('/api/profile/')) {
      const prof = await accounts.profile(decodeURIComponent(pathname.slice('/api/profile/'.length)));
      return prof ? reply(200, { profile: prof }) : reply(404, { error: 'No such player.' });
    }
    return reply(404, { error: 'Not found.' });
  } catch (e) {
    if (e instanceof UserError) return reply(400, { error: e.message });
    console.error('API error', e);
    return reply(500, { error: 'Something went wrong. Try again.' });
  }
}

// After every match, signed-in players get trophies, stats and badges, and a summary of what changed.
async function onResults(records) {
  for (const { player, match } of records) {
    try {
      const progress = await accounts.recordMatch(player.account.id, match);
      if (!progress) continue;
      player.account.trophies = progress.trophies;
      send(player.ws, { t: 'progress', ...progress });
    } catch (e) {
      console.error('Could not save match for', player.account.username, e.message);
    }
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
};

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(`ok ${rooms.size} rooms`);
  }
  if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
  let file;
  try {
    const rel = decodeURIComponent(pathname);
    file = rel.startsWith('/shared/') ? path.join(ROOT, rel)
      : rel.startsWith('/vendor/three/') ? path.join(THREE_DIR, rel.slice('/vendor/three/'.length))
        : path.join(PUBLIC_DIR, rel === '/' ? 'index.html' : rel);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (![PUBLIC_DIR, SHARED_DIR, THREE_DIR].some((dir) => file.startsWith(dir + path.sep))) {
    res.writeHead(404);
    return res.end('Not found');
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': file.startsWith(THREE_DIR) ? 'public, max-age=604800' : 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

const rooms = new Map();

function newCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
}

const cleanName = (n) => String(n ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 14) || 'Brawler';
const cleanToken = (t) => String(t ?? '').slice(0, 64);

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let room = null;
  let player = null;

  const enter = (r, p) => {
    room = r;
    player = p;
    send(ws, { t: 'joined', you: p.id, code: r.code, token: p.token });
    r.broadcastRoom();
  };

  let joining = false;
  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'ping') return send(ws, { t: 'pong', ts: m.ts });

    if (m.t === 'create' || m.t === 'join') {
      if (room || joining) return;
      joining = true;
      // Signed-in players play under their username and earn trophies; guests just play.
      const account = await accounts.resolve(m.auth).catch(() => null);
      joining = false;
      let r;
      if (m.t === 'create') {
        r = new Room(newCode(), (dead) => rooms.delete(dead.code), onResults);
        rooms.set(r.code, r);
      } else {
        r = rooms.get(String(m.code ?? '').toUpperCase().trim());
        if (!r) return send(ws, { t: 'error', msg: 'No room with that code. Check the code or create a new room.', fatal: true });
      }
      const token = cleanToken(m.token) || Math.random().toString(36).slice(2);
      const p = r.addHuman(ws, account ? account.username : cleanName(m.name), token);
      if (!p) return send(ws, { t: 'error', msg: 'That room is full.', fatal: true });
      if (!p.token) p.token = Math.random().toString(36).slice(2) + Date.now().toString(36);
      p.account = account ? { id: account.id, username: account.username, trophies: account.trophies } : p.account ?? null;
      return enter(r, p);
    }

    if (room && player && room.players.get(player.id) === player && player.ws === ws) room.handle(player, m);
  });

  ws.on('close', () => {
    if (room && player && player.ws === ws && room.players.get(player.id) === player) room.disconnect(player);
  });
});

// Drop connections that stopped answering (phone locked, Wi-Fi lost) so their seat frees up.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 10_000);

server.listen(PORT, () => {
  console.log(`Bushwhack running on http://localhost:${PORT}`);
});
