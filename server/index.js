import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Room, send } from './room.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'shared');
const THREE_DIR = path.join(ROOT, 'node_modules', 'three');
const PORT = Number(process.env.PORT) || 3000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O, so codes are easy to read aloud

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

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'ping') return send(ws, { t: 'pong', ts: m.ts });

    if (m.t === 'create' || m.t === 'join') {
      if (room) return;
      let r;
      if (m.t === 'create') {
        r = new Room(newCode(), (dead) => rooms.delete(dead.code));
        rooms.set(r.code, r);
      } else {
        r = rooms.get(String(m.code ?? '').toUpperCase().trim());
        if (!r) return send(ws, { t: 'error', msg: 'No room with that code. Check the code or create a new room.', fatal: true });
      }
      const token = cleanToken(m.token) || Math.random().toString(36).slice(2);
      const p = r.addHuman(ws, cleanName(m.name), token);
      if (!p) return send(ws, { t: 'error', msg: 'That room is full.', fatal: true });
      if (!p.token) p.token = Math.random().toString(36).slice(2) + Date.now().toString(36);
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
