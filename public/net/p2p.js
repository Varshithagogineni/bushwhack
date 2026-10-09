// Serverless multiplayer: the room creator's browser hosts the match (see host-worker.js) and every other
// player connects to it directly over WebRTC data channels. Supabase Realtime is only the "phone book":
// it carries the handshake behind a 4-letter room code, and relays traffic for the rare network that blocks
// direct connections. Every connection exposes a tiny WebSocket-like interface: send(), onmessage, onclose.
import { SUPABASE_URL, SUPABASE_KEY } from '/config.js';

const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O, so codes are easy to read aloud
const DIRECT_TIMEOUT_MS = 8000; // after this, fall back to the relay
const isSnap = (s) => s.startsWith('{"t":"snap"');
const isInput = (s) => s.startsWith('{"t":"i"');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const randomId = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 10)}`;

let clientPromise = null;
function supabase() {
  clientPromise ??= import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm')
    .then(({ createClient }) => createClient(SUPABASE_URL, SUPABASE_KEY, { realtime: { params: { eventsPerSecond: 40 } } }));
  return clientPromise;
}

// Opens the room's channel with its message handler attached before subscribing.
async function openChannel(code, onSignal) {
  const sb = await supabase();
  const channel = sb.channel(`bw-${code}`, { config: { broadcast: { self: false } } });
  channel.on('broadcast', { event: 'sig' }, ({ payload }) => onSignal(payload));
  await new Promise((resolve, reject) => {
    const fail = () => reject(new Error('Could not reach the matchmaking service. Check your connection.'));
    const t = setTimeout(fail, 10000);
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') { clearTimeout(t); resolve(); }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(t); fail(); }
    });
  });
  const send = (payload) => channel.send({ type: 'broadcast', event: 'sig', payload });
  return { send, close: () => sb.removeChannel(channel) };
}

class Conn {
  constructor() { this.readyState = 0; this.onmessage = null; this.onclose = null; }
  deliver(data) { this.onmessage?.({ data }); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
}

// ---------------------------------------------------------------- hosting

export async function hostRoom() {
  const peers = new Map(); // peer id -> peer
  let worker = null;
  let ch = null;
  let code = null;
  let probeId = null;
  let taken = false;

  const signal = (to, payload) => ch.send({ ...payload, to, from: 'host' });

  function dropPeer(id) {
    const peer = peers.get(id);
    if (!peer) return;
    peers.delete(id);
    clearTimeout(peer.timer);
    try { peer.pc?.close(); } catch { /* already closed */ }
    worker.postMessage({ type: 'close', id });
  }

  function openPeer(peer) {
    if (peer.open) return;
    peer.open = true;
    worker.postMessage({ type: 'open', id: peer.id });
  }

  async function newPeer(id) {
    dropPeer(id);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const rel = pc.createDataChannel('r', { ordered: true });
    const fast = pc.createDataChannel('u', { ordered: false, maxRetransmits: 0 });
    const peer = { id, pc, rel, fast, relay: false, open: false, snapSkip: 0 };
    peer.send = (data) => {
      if (peer.relay) {
        // The relay has a message budget: send every other snapshot (15 Hz) and everything else as-is.
        if (isSnap(data) && (peer.snapSkip++ % 2)) return;
        signal(id, { type: 'data', d: data });
        return;
      }
      if (isSnap(data) && fast.readyState === 'open') {
        if (fast.bufferedAmount < 64 * 1024) fast.send(data);
      } else if (rel.readyState === 'open') rel.send(data);
    };
    const onData = (ev) => worker.postMessage({ type: 'msg', id, data: ev.data });
    rel.onmessage = onData;
    fast.onmessage = onData;
    rel.onopen = () => { clearTimeout(peer.timer); openPeer(peer); };
    rel.onclose = () => { if (!peer.relay) dropPeer(id); };
    pc.onicecandidate = (ev) => { if (ev.candidate) signal(id, { type: 'ice', c: ev.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' && !peer.relay) dropPeer(id); };
    peers.set(id, peer);
    peer.timer = setTimeout(() => {
      // Direct connection didn't come up (strict firewall / mobile carrier): relay through Supabase instead.
      if (peer.open) return;
      peer.relay = true;
      try { pc.close(); } catch { /* ignore */ }
      signal(id, { type: 'relay' });
      openPeer(peer);
    }, DIRECT_TIMEOUT_MS);
    await pc.setLocalDescription(await pc.createOffer());
    signal(id, { type: 'offer', sdp: pc.localDescription.toJSON() });
  }

  async function onSignal(p) {
    if (p.type === 'probe' && p.from !== probeId && worker) return ch.send({ type: 'taken', to: p.from, from: 'host' });
    if (p.type === 'taken' && p.to === probeId) { taken = true; return; }
    if (p.to !== 'host' || !p.from || !worker) return;
    const peer = peers.get(p.from);
    try {
      if (p.type === 'hello') { if (!peer) await newPeer(p.from); }
      else if (p.type === 'answer' && peer?.pc) await peer.pc.setRemoteDescription(p.sdp);
      else if (p.type === 'ice' && peer?.pc && !peer.relay) await peer.pc.addIceCandidate(p.c);
      else if (p.type === 'data' && peer?.relay) worker.postMessage({ type: 'msg', id: p.from, data: p.d });
      else if (p.type === 'bye') dropPeer(p.from);
    } catch (err) {
      console.warn('signal error', err);
    }
  }

  // Pick a code nobody is hosting: ask "anyone here?" and wait briefly for an answer.
  for (let attempt = 0; attempt < 5; attempt++) {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
    probeId = randomId('probe');
    taken = false;
    ch = await openChannel(code, onSignal);
    ch.send({ type: 'probe', to: 'host', from: probeId });
    await wait(700);
    if (!taken) break;
    await ch.close();
  }

  worker = new Worker('/net/host-worker.js', { type: 'module' });
  worker.postMessage({ type: 'init', code });
  const local = new Conn();
  local.readyState = 1;
  local.send = (data) => worker.postMessage({ type: 'msg', id: 'local', data });
  worker.postMessage({ type: 'open', id: 'local' });
  worker.onmessage = ({ data: e }) => {
    if (e.type !== 'send') return;
    if (e.id === 'local') local.deliver(e.data);
    else peers.get(e.id)?.send(e.data);
  };

  const goodbye = () => { for (const id of peers.keys()) signal(id, { type: 'closed' }); };
  addEventListener('pagehide', goodbye);

  return {
    code,
    conn: local,
    close: async () => {
      goodbye();
      removeEventListener('pagehide', goodbye);
      for (const id of [...peers.keys()]) dropPeer(id);
      worker.terminate();
      local.close();
      await ch.close();
    },
  };
}

// ---------------------------------------------------------------- joining

export async function joinRoom(code) {
  const me = randomId('p');
  const conn = new Conn();
  let pc = null, rel = null, fast = null, relay = false, heardHost = false;
  let batch = [], batchTimer = null;
  let ch = null;

  const signal = (payload) => ch.send({ ...payload, to: 'host', from: me });
  const markOpen = () => {
    if (conn.readyState !== 0) return;
    conn.readyState = 1;
    conn.onopen?.();
  };

  async function onSignal(p) {
    if (p.to !== me) return;
    heardHost = true;
    try {
      if (p.type === 'offer') {
        if (pc) return;
        pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        pc.onicecandidate = (ev) => { if (ev.candidate) signal({ type: 'ice', c: ev.candidate.toJSON() }); };
        pc.ondatachannel = ({ channel: dc }) => {
          dc.onmessage = (ev) => conn.deliver(ev.data);
          if (dc.label === 'r') {
            rel = dc;
            dc.onopen = markOpen;
            dc.onclose = () => { if (!relay) conn.close(); };
          } else fast = dc;
        };
        pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' && !relay) conn.close(); };
        await pc.setRemoteDescription(p.sdp);
        await pc.setLocalDescription(await pc.createAnswer());
        signal({ type: 'answer', sdp: pc.localDescription.toJSON() });
      } else if (p.type === 'ice' && pc) await pc.addIceCandidate(p.c);
      else if (p.type === 'relay') {
        relay = true;
        try { pc?.close(); } catch { /* ignore */ }
        markOpen();
      } else if (p.type === 'data' && relay) conn.deliver(p.d);
      else if (p.type === 'closed') conn.close();
    } catch (err) {
      console.warn('signal error', err);
    }
  }

  ch = await openChannel(code, onSignal);

  conn.send = (data) => {
    if (conn.readyState !== 1) return;
    if (relay) {
      // Inputs are batched at 15 Hz to stay inside the relay's message budget.
      if (isInput(data)) {
        batch.push(JSON.parse(data));
        batchTimer ??= setTimeout(() => {
          signal({ type: 'data', d: JSON.stringify({ t: 'batch', m: batch }) });
          batch = [];
          batchTimer = null;
        }, 66);
      } else signal({ type: 'data', d: data });
      return;
    }
    if (isInput(data) && fast?.readyState === 'open') fast.send(data);
    else if (rel?.readyState === 'open') rel.send(data);
  };
  const baseClose = conn.close.bind(conn);
  conn.close = () => {
    if (conn.readyState === 3) return;
    try { signal({ type: 'bye' }); } catch { /* channel gone */ }
    try { pc?.close(); } catch { /* ignore */ }
    ch.close();
    baseClose();
  };

  // Say hello until the host answers; silence means there is no such room.
  for (let i = 0; i < 4 && !heardHost; i++) {
    signal({ type: 'hello' });
    await wait(1000);
  }
  if (!heardHost) {
    await ch.close();
    throw Object.assign(new Error('No room with that code. Check the code or ask your friend to create a room.'), { fatal: true });
  }

  // Wait for the direct link (or the relay) before handing the connection to the game.
  if (conn.readyState !== 1) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Could not connect to the room. Try again.')), DIRECT_TIMEOUT_MS + 6000);
      conn.onopen = () => { clearTimeout(t); resolve(); };
    });
  }
  return conn;
}
