import {
  DT, BRAWLERS, BRAWLER_IDS, MAX_AMMO, MIN_PLAYERS, MAX_PLAYERS, CENTER, POISON, movePlayer, round2, inBush,
} from '/shared/game.js';
import { Input } from './input.js';
import { Renderer, drawBrawler } from './render.js';

const INTERP_MS = 100; // render other players this far in the past so motion stays smooth
const CLIENT_COOLDOWN = 0.45;

const $ = (id) => document.getElementById(id);
const safe = (storage) => ({
  get: (k) => { try { return storage().getItem(k); } catch { return null; } },
  set: (k, v) => { try { storage().setItem(k, v); } catch { /* private mode */ } },
  del: (k) => { try { storage().removeItem(k); } catch { /* private mode */ } },
});
const local = safe(() => localStorage);
const session = safe(() => sessionStorage);

// ---------- app state ----------

const app = {
  ws: null,
  retry: 0,
  pending: null,
  myId: null,
  code: null,
  token: session.get('bw_token'),
  room: null,
};

const net = {
  snaps: [], offset: null, events: [], pending: [], seq: 0, pred: null, err: { x: 0, y: 0 },
  me: { alive: false, ammo: MAX_AMMO, cubes: 0 }, cooldown: 0, lastState: null,
  killedBy: null, cam: { x: CENTER, y: CENTER }, aimAngle: 0, fightShownAt: 0, view: null,
  reset() {
    this.snaps = []; this.events = []; this.pending = []; this.pred = null; this.err = { x: 0, y: 0 };
    this.killedBy = null; this.cooldown = 0;
  },
};

const canvas = $('canvas');
const renderer = new Renderer(canvas);
const input = new Input(canvas);
input.onFire = (intent) => tryFire(intent);

// ---------- networking ----------

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  app.ws = ws;
  ws.onopen = () => {
    app.retry = 0;
    $('net').classList.add('hidden');
    if (app.code) send({ t: 'join', code: app.code, name: myName(), token: app.token });
    else if (app.pending) send(app.pending);
    app.pending = null;
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    onMessage(m);
  };
  ws.onclose = () => {
    if (app.ws !== ws) return;
    if (app.code) $('net').classList.remove('hidden');
    setTimeout(connect, Math.min(4000, 400 * 2 ** app.retry++));
  };
}

function send(m) {
  if (app.ws?.readyState === 1) app.ws.send(JSON.stringify(m));
}

function request(m) {
  if (app.ws?.readyState === 1) send(m);
  else app.pending = m;
}

function onMessage(m) {
  switch (m.t) {
    case 'joined':
      app.myId = m.you;
      app.code = m.code;
      app.token = m.token;
      session.set('bw_token', m.token);
      session.set('bw_room', m.code);
      history.replaceState(null, '', `?room=${m.code}`);
      break;
    case 'room':
      onRoom(m);
      break;
    case 'snap':
      onSnap(m);
      break;
    case 'error':
      toast(m.msg);
      if (m.fatal) {
        app.code = null;
        session.del('bw_room');
        $('net').classList.add('hidden');
        showScreen('home');
      }
      break;
  }
}

// ---------- screens & lobby ----------

function showScreen(name) {
  $('home').classList.toggle('hidden', name !== 'home');
  $('lobby').classList.toggle('hidden', name !== 'lobby');
  $('game').classList.toggle('hidden', name !== 'game');
  document.body.style.overflow = name === 'game' ? 'hidden' : '';
}

const playerById = (id) => app.room?.players.find((p) => p.id === id);
const nameOf = (id) => (id === app.myId ? 'You' : playerById(id)?.name ?? '???');
const myBrawler = () => playerById(app.myId)?.brawler ?? BRAWLER_IDS[0];
const myName = () => ($('nameInput').value.trim() || local.get('bw_name') || 'Brawler').slice(0, 14);

function onRoom(room) {
  const prev = app.room?.state;
  app.room = room;
  if (room.state === 'lobby') {
    showScreen('lobby');
    renderLobby();
  } else {
    if (prev === 'lobby' || prev == null) { net.reset(); input.reset(); }
    showScreen('game');
    if (room.state === 'playing' && prev === 'countdown') net.fightShownAt = performance.now();
  }
  renderResults();
}

function buildCards() {
  const wrap = $('brawlerCards');
  wrap.innerHTML = '';
  for (const id of BRAWLER_IDS) {
    const b = BRAWLERS[id];
    const card = document.createElement('button');
    card.className = 'card';
    card.dataset.id = id;
    const icon = document.createElement('canvas');
    icon.width = icon.height = 112;
    const ictx = icon.getContext('2d');
    ictx.scale(2, 2);
    drawBrawler(ictx, 28, 30, id, 0.4);
    const name = Object.assign(document.createElement('div'), { className: 'name', textContent: b.name });
    const role = Object.assign(document.createElement('div'), { className: 'role', textContent: b.role });
    const desc = Object.assign(document.createElement('div'), { className: 'desc', textContent: b.desc });
    card.append(icon, name, role, desc);
    for (const [label, val] of Object.entries(b.stats)) {
      const row = document.createElement('div');
      row.className = 'stat';
      row.innerHTML = `<span></span><div class="bar"><i style="width:${val * 20}%"></i></div>`;
      row.firstChild.textContent = label;
      card.append(row);
    }
    card.addEventListener('click', () => {
      const me = playerById(app.myId);
      if (me) me.brawler = id;
      send({ t: 'pick', brawler: id });
      renderLobby();
    });
    wrap.append(card);
  }
}

function renderLobby() {
  const room = app.room;
  if (!room) return;
  $('roomCode').textContent = room.code;
  const mine = myBrawler();
  for (const card of $('brawlerCards').children) card.classList.toggle('selected', card.dataset.id === mine);

  const list = $('playerList');
  list.innerHTML = '';
  for (const p of room.players) {
    const li = document.createElement('li');
    if (!p.connected) li.classList.add('offline');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = BRAWLERS[p.brawler].color;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = `${p.name} · ${BRAWLERS[p.brawler].name}`;
    li.append(dot, who);
    const tag = (text, cls) => li.append(Object.assign(document.createElement('span'), { className: `tag ${cls}`, textContent: text }));
    if (p.id === app.myId) tag('YOU', 'you');
    if (p.id === room.hostId) tag('HOST', 'host');
    if (!p.connected && !p.bot) tag('offline', '');
    list.append(li);
  }
  $('playerCount').textContent = `${room.players.length}/${MAX_PLAYERS}`;

  const isHost = room.hostId === app.myId;
  $('hostControls').classList.toggle('hidden', !isHost);
  $('startBtn').disabled = room.players.length < MIN_PLAYERS;
  $('addBotBtn').disabled = room.players.length >= MAX_PLAYERS;
  $('removeBotBtn').disabled = !room.players.some((p) => p.bot);
  const host = playerById(room.hostId);
  $('lobbyStatus').textContent = isHost
    ? room.players.length < MIN_PLAYERS ? 'Share the code, or add a bot to play right away.' : 'Everyone ready? Hit Start.'
    : `Waiting for ${host?.name ?? 'the host'} to start the match…`;
}

function renderResults() {
  const room = app.room;
  const show = room?.state === 'ended' && room.results;
  $('results').classList.toggle('hidden', !show);
  if (!show) return;
  const mine = room.results.find((r) => r.id === app.myId);
  const winner = room.results.find((r) => r.rank === 1);
  $('resultTitle').textContent = !mine ? 'Match over' : mine.rank === 1 ? '🏆 Victory!' : `#${mine.rank} place`;
  $('resultSub').textContent = winner ? `${winner.id === app.myId ? 'You' : winner.name} won as ${BRAWLERS[winner.brawler].name}` : 'Nobody survived!';
  const list = $('resultList');
  list.innerHTML = '';
  for (const r of room.results) {
    const li = document.createElement('li');
    if (r.id === app.myId) li.classList.add('me');
    const rank = Object.assign(document.createElement('span'), { className: 'rank', textContent: `#${r.rank}` });
    const dot = Object.assign(document.createElement('span'), { className: 'dot' });
    dot.style.cssText = `width:18px;height:18px;border-radius:50%;background:${BRAWLERS[r.brawler].color}`;
    const who = Object.assign(document.createElement('span'), { className: 'who', textContent: r.id === app.myId ? `${r.name} (you)` : r.name });
    const kills = Object.assign(document.createElement('span'), { className: 'muted', textContent: `${r.kills} KO${r.kills === 1 ? '' : 's'}` });
    li.append(rank, dot, who, kills);
    list.append(li);
  }
  const isHost = room.hostId === app.myId;
  $('againBtn').classList.toggle('hidden', !isHost);
  $('againHint').textContent = isHost ? '' : 'Waiting for the host… (back to lobby automatically in a few seconds)';
}

// ---------- snapshots, prediction, interpolation ----------

function onSnap(m) {
  if (m.state === 'countdown' && net.lastState !== 'countdown') net.reset();
  net.lastState = m.state;
  m.pmap = new Map(m.players.map((p) => [p.i, p]));
  m.prmap = new Map(m.projs.map((p) => [p.i, p]));
  net.snaps.push(m);
  if (net.snaps.length > 40) net.snaps.shift();

  const est = m.time * 1000 - performance.now();
  if (net.offset === null || Math.abs(est - net.offset) > 400) net.offset = est;
  else net.offset += (est - net.offset) * 0.06;

  net.me = m.me;
  const self = m.pmap.get(app.myId);
  if (self) {
    // Server says where we were after input #ack; replay the inputs it hasn't seen yet.
    const shown = net.pred ? { x: net.pred.x + net.err.x, y: net.pred.y + net.err.y } : null;
    net.pending = net.pending.filter((i) => i.seq > m.me.ack);
    const p = { x: self.x, y: self.y };
    const speed = BRAWLERS[myBrawler()].speed;
    for (const i of net.pending) movePlayer(p, i.mx, i.my, speed);
    net.pred = p;
    if (shown) {
      net.err.x = shown.x - p.x;
      net.err.y = shown.y - p.y;
      if (Math.hypot(net.err.x, net.err.y) > 150) net.err = { x: 0, y: 0 };
    }
  } else {
    net.pred = null;
  }
  for (const e of m.ev) net.events.push({ ...e, at: m.time * 1000 });
}

function stepInput() {
  net.cooldown = Math.max(0, net.cooldown - DT);
  if (app.room?.state !== 'playing' || net.lastState !== 'playing' || !net.me.alive || !net.pred) return;
  const { mx: rx, my: ry } = input.move();
  const mx = round2(rx), my = round2(ry);
  updateAim(mx, my);
  net.seq++;
  send({ t: 'i', s: net.seq, x: mx, y: my, a: round2(net.aimAngle) });
  net.pending.push({ seq: net.seq, mx, my });
  if (net.pending.length > 120) net.pending.shift();
  movePlayer(net.pred, mx, my, BRAWLERS[myBrawler()].speed);
  if (input.mouse.down && !input.touchMode) tryFire({ mouse: true });
}

function selfScreenPos() {
  if (!net.pred) return null;
  return renderer.toScreen(net.cam, net.pred.x + net.err.x, net.pred.y + net.err.y);
}

function updateAim(mx, my) {
  const ta = input.touchAim();
  if (ta.active) net.aimAngle = ta.angle;
  else if (!input.touchMode) {
    const s = selfScreenPos();
    if (s) net.aimAngle = Math.atan2(input.mouse.y - s.y, input.mouse.x - s.x);
  } else if (Math.hypot(mx, my) > 0.2) net.aimAngle = Math.atan2(my, mx);
}

function tryFire(intent) {
  if (app.room?.state !== 'playing' || !net.me.alive || !net.pred) return;
  if (net.cooldown > 0 || net.me.ammo < 1) return;
  const b = BRAWLERS[myBrawler()];
  const me = { x: net.pred.x, y: net.pred.y };
  let angle = net.aimAngle, dist = b.range;
  if (intent.auto) {
    let best = null, bd = b.range * 1.1;
    for (const p of net.view?.players ?? []) {
      if (p.isMe) continue;
      const d = Math.hypot(p.x - me.x, p.y - me.y);
      if (d < bd) { bd = d; best = p; }
    }
    if (best) { angle = Math.atan2(best.y - me.y, best.x - me.x); dist = bd; }
  } else if (intent.angle != null) {
    angle = intent.angle;
    dist = intent.frac * b.range;
  } else if (intent.mouse) {
    const s = selfScreenPos();
    if (!s) return;
    angle = Math.atan2(input.mouse.y - s.y, input.mouse.x - s.x);
    dist = Math.hypot(input.mouse.x - s.x, input.mouse.y - s.y) / renderer.scale;
  }
  net.aimAngle = angle;
  net.cooldown = CLIENT_COOLDOWN;
  net.me.ammo -= 1;
  send({ t: 'f', x: round2(Math.cos(angle)), y: round2(Math.sin(angle)), d: Math.round(dist) });
}

const lerp = (a, b, k) => a + (b - a) * k;

function buildView(now) {
  const snaps = net.snaps;
  if (!snaps.length) return null;
  const rt = now + net.offset - INTERP_MS;
  let a = snaps[0], b = snaps[snaps.length - 1];
  if (rt >= b.time * 1000) a = b;
  else if (rt <= a.time * 1000) b = a;
  else {
    for (let i = snaps.length - 1; i > 0; i--) {
      if (snaps[i - 1].time * 1000 <= rt) { a = snaps[i - 1]; b = snaps[i]; break; }
    }
  }
  const span = (b.time - a.time) * 1000;
  const k = span > 0 ? Math.min(1, Math.max(0, (rt - a.time * 1000) / span)) : 1;
  const latest = snaps[snaps.length - 1];

  const players = [];
  for (const pb of b.players) {
    if (pb.i === app.myId) continue;
    const pa = a.pmap.get(pb.i) ?? pb;
    const info = playerById(pb.i);
    players.push({
      id: pb.i, x: lerp(pa.x, pb.x, k), y: lerp(pa.y, pb.y, k), hp: pb.h, maxHp: pb.m, aim: pb.a, cubes: pb.c,
      bush: pb.bush, brawler: info?.brawler ?? 'brick', name: info?.name ?? '', isMe: false,
    });
  }
  const selfSnap = latest.pmap.get(app.myId);
  if (selfSnap && net.pred) {
    const x = net.pred.x + net.err.x, y = net.pred.y + net.err.y;
    players.push({
      id: app.myId, x, y, hp: selfSnap.h, maxHp: selfSnap.m, aim: net.aimAngle, cubes: selfSnap.c,
      bush: inBush(x, y) ? 1 : 0, brawler: myBrawler(), name: 'You', isMe: true,
    });
  }

  const projs = b.projs.map((pb) => {
    const pa = a.prmap.get(pb.i);
    if (!pa) return pb;
    return pb.k === 'l' ? { ...pb, p: lerp(pa.p, pb.p, k) } : { ...pb, x: lerp(pa.x, pb.x, k), y: lerp(pa.y, pb.y, k) };
  });

  // Fire events (damage numbers, explosions, KOs) when the interpolated time reaches them.
  while (net.events.length && net.events[0].at <= rt) {
    const e = net.events.shift();
    renderer.addEvent(e, now);
    if (e.k === 'ko') onKnockout(e);
  }

  return {
    players, projs, cubes: b.cubes, poison: lerp(a.poison, b.poison, k), latest,
    me: net.me, cam: net.cam,
  };
}

function onKnockout(e) {
  const feed = document.createElement('div');
  feed.textContent = e.by ? `${nameOf(e.by)} knocked out ${nameOf(e.id)}` : `${nameOf(e.id)} fell to the poison`;
  $('killFeed').append(feed);
  setTimeout(() => feed.remove(), 4000);
  while ($('killFeed').children.length > 4) $('killFeed').firstChild.remove();
  if (e.id === app.myId) net.killedBy = e.by || null;
}

// ---------- main loop ----------

let last = performance.now();
let acc = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dtf = Math.min(0.1, (now - last) / 1000);
  last = now;
  acc += dtf;
  while (acc >= DT) { acc -= DT; stepInput(); }
  if ($('game').classList.contains('hidden')) return;

  const decay = Math.exp(-dtf * 10);
  net.err.x *= decay;
  net.err.y *= decay;

  const view = buildView(now);
  net.view = view;
  if (!view) return;

  const me = view.players.find((p) => p.isMe);
  let target = me;
  if (!target) target = view.players.find((p) => p.id === net.killedBy) ?? view.players[0];
  if (me) { net.cam.x = me.x; net.cam.y = me.y; }
  else if (target) {
    const k = Math.min(1, dtf * 6);
    net.cam.x = lerp(net.cam.x, target.x, k);
    net.cam.y = lerp(net.cam.y, target.y, k);
  }

  if (me && app.room?.state === 'playing') {
    const ta = input.touchAim();
    const showAim = input.touchMode ? ta.active : true;
    if (showAim) {
      let dist = BRAWLERS[me.brawler].range;
      if (input.touchMode) dist *= ta.frac;
      else {
        const s = renderer.toScreen(net.cam, me.x, me.y);
        dist = Math.hypot(input.mouse.x - s.x, input.mouse.y - s.y) / renderer.scale;
      }
      view.aim = { x: me.x, y: me.y, angle: net.aimAngle, dist, brawler: me.brawler };
    }
  }
  if (input.touchMode && me) view.sticks = { left: input.left, right: input.right, hint: app.room?.state === 'playing' && view.latest.mt < 8 };

  renderer.draw(view, now);
  updateHud(view, me, target, now);
}

function updateHud(view, me, target, now) {
  const snap = view.latest;
  $('aliveCount').textContent = `👥 ${snap.alive} left`;
  const untilPoison = Math.ceil(POISON.start - snap.mt);
  const outside = me && Math.hypot(me.x - CENTER, me.y - CENTER) > view.poison;
  const poison = $('poisonInfo');
  poison.classList.toggle('danger', !!outside);
  poison.textContent = outside ? '☠ Get out of the poison!' : untilPoison > 0 ? `☠ Poison in ${untilPoison}s` : '☠ Poison closing in';

  let center = '';
  if (snap.state === 'countdown') center = String(Math.max(1, Math.ceil(snap.cd)));
  else if (now - net.fightShownAt < 900) center = 'FIGHT!';
  $('centerMsg').textContent = center;

  let spec = '';
  if (!me && app.room?.state === 'playing') {
    const inMatch = playerById(app.myId)?.inMatch;
    spec = !inMatch
      ? 'Match in progress. You\'ll join the next round.'
      : `Knocked out${net.killedBy ? ` by ${nameOf(net.killedBy)}` : ''}. Spectating ${target ? nameOf(target.id) : ''}`;
  }
  const specEl = $('spectateMsg');
  if (specEl.dataset.text !== spec) {
    specEl.dataset.text = spec;
    specEl.innerHTML = '';
    if (spec) specEl.append(Object.assign(document.createElement('span'), { textContent: spec }));
  }
}

// ---------- UI wiring ----------

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add('hidden'), 3000);
}

function saveName() {
  local.set('bw_name', myName());
}

$('nameInput').value = local.get('bw_name') || '';
$('createBtn').addEventListener('click', () => {
  saveName();
  request({ t: 'create', name: myName(), token: app.token });
});
$('joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('codeInput').value.trim().toUpperCase();
  if (code.length !== 4) return toast('Room codes are 4 letters.');
  saveName();
  request({ t: 'join', code, name: myName(), token: app.token });
});
$('codeInput').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });
$('addBotBtn').addEventListener('click', () => send({ t: 'addBot' }));
$('removeBotBtn').addEventListener('click', () => send({ t: 'removeBot' }));
$('startBtn').addEventListener('click', () => send({ t: 'start' }));
$('againBtn').addEventListener('click', () => send({ t: 'lobby' }));
$('leaveBtn').addEventListener('click', () => {
  send({ t: 'leave' });
  session.del('bw_room');
  location.href = location.pathname;
});
$('copyBtn').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}?room=${app.code}`;
  if (navigator.share && input.touchMode) {
    try { await navigator.share({ title: 'Bushwhack', text: `Join my Bushwhack room: ${app.code}`, url }); return; } catch { /* fall through */ }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied!');
  } catch {
    prompt('Copy this link:', url);
  }
});

buildCards();

// Opened an invite link? Prefill the code. Refreshed mid-game? Rejoin the same seat.
const params = new URLSearchParams(location.search);
const linkCode = (params.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
if (linkCode) {
  $('codeInput').value = linkCode;
  if (session.get('bw_room') === linkCode && app.token) app.code = linkCode;
  else setTimeout(() => ($('nameInput').value ? $('codeInput') : $('nameInput')).focus(), 50);
}
showScreen('home');
connect();
requestAnimationFrame(frame);
