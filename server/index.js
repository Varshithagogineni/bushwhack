// Local development server: serves the same files Vercel does (public/, shared/, Three.js).
// Multiplayer runs peer-to-peer in the browser and accounts live in Supabase, so there is no game server.
import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'shared');
const THREE_DIR = path.join(ROOT, 'node_modules', 'three');
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
};

http.createServer(async (req, res) => {
  let file;
  try {
    const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(PORT, () => console.log(`Rumble Reef dev server on http://localhost:${PORT}`));
