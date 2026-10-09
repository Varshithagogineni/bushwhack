// Runs the authoritative match for a room inside the host player's browser.
// A Web Worker keeps the 30 Hz simulation steady even while the host's tab is busy drawing.
// Connections are plain message pipes: the local player and every remote player look the same here.
import { Room } from '/shared/room.js';

let code = null;
let room = null;
const conns = new Map(); // connection id -> { ws, player }

const cleanName = (n) => String(n ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 14) || 'Brawler';
const cleanToken = (t) => String(t ?? '').slice(0, 64);
const randomToken = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

// Looks enough like a WebSocket for Room's send() helper.
function pipe(id) {
  return { readyState: 1, bufferedAmount: 0, send: (data) => postMessage({ type: 'send', id, data }) };
}

const reply = (c, msg) => c.ws.send(JSON.stringify(msg));

// Signed-in players' results go back to them; their own browser records the match with their session.
function onResults(records) {
  for (const { player, match } of records) player.ws?.send(JSON.stringify({ t: 'record', match }));
}

function handle(id, raw) {
  const c = conns.get(id);
  if (!c) return;
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m !== 'object') return;
  if (m.t === 'batch' && Array.isArray(m.m)) { for (const sub of m.m.slice(0, 8)) handle(id, JSON.stringify(sub)); return; }
  if (m.t === 'ping') return reply(c, { t: 'pong', ts: m.ts });

  if (m.t === 'create' || m.t === 'join') {
    if (c.player) return;
    if (!room) room = new Room(code, () => { room = null; postMessage({ type: 'empty' }); }, onResults);
    const acct = m.account && typeof m.account === 'object'
      ? { username: cleanName(m.account.username), trophies: Math.max(0, Number(m.account.trophies) | 0) } : null;
    const p = room.addHuman(c.ws, acct ? acct.username : cleanName(m.name), cleanToken(m.token) || randomToken());
    if (!p) return reply(c, { t: 'error', msg: 'That room is full.', fatal: true });
    if (!p.token) p.token = randomToken();
    if (acct) p.account = acct;
    c.player = p;
    reply(c, { t: 'joined', you: p.id, code, token: p.token });
    room.broadcastRoom();
    return;
  }
  const p = c.player;
  if (p && room && room.players.get(p.id) === p && p.ws === c.ws) room.handle(p, m);
}

self.onmessage = ({ data: e }) => {
  if (e.type === 'init') code = e.code;
  else if (e.type === 'open') conns.set(e.id, { ws: pipe(e.id), player: null });
  else if (e.type === 'msg') handle(e.id, e.data);
  else if (e.type === 'close') {
    const c = conns.get(e.id);
    if (!c) return;
    c.ws.readyState = 3;
    const p = c.player;
    if (p && room && room.players.get(p.id) === p && p.ws === c.ws) room.disconnect(p);
    conns.delete(e.id);
  }
};
