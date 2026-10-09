import {
  DT, BRAWLERS, BRAWLER_IDS, MAX_AMMO, MIN_PLAYERS, MAX_PLAYERS, CENTER, POISON, HAUNT, EMOTES,
  movePlayer, moveGhost, speedFactor, round2, inBush,
} from '/shared/game.js';
import { Input } from './input.js';
import { Renderer, drawBrawler } from './render.js';
import { art, loadArt, drawPortrait } from './assets.js';
import { sfx, isMuted, setMuted } from './sfx.js';

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
  me: { alive: false, ghost: false, ammo: MAX_AMMO, cubes: 0, su: 0, hcd: 0 }, cooldown: 0, lastState: null,
  killedBy: null, cam: { x: CENTER, y: CENTER }, aimAngle: 0, fightShownAt: 0, view: null,
  lastBeep: null, resultSoundFor: null, wasGhost: false,
  reset() {
    this.snaps = []; this.events = []; this.pending = []; this.pred = null; this.err = { x: 0, y: 0 };
    this.killedBy = null; this.cooldown = 0; this.lastBeep = null; this.wasGhost = false;
  },
};

const canvas = $('canvas');
let renderer = new Renderer(canvas);
// Upgrade to the real-time 3D renderer when WebGL works; the 2D one stays as the fallback.
try {
  const probe = document.createElement('canvas');
  if (probe.getContext('webgl2') || probe.getContext('webgl')) {
    import('./render3d.js')
      .then(async ({ Renderer3D }) => {
        const r3 = new Renderer3D(canvas);
        await r3.load();
        renderer = r3;
      })
      .catch((e) => console.warn('3D renderer unavailable, using 2D.', e));
  }
} catch { /* no WebGL */ }
const input = new Input(canvas);
input.onFire = (intent) => tryFire(intent);
input.onSuper = (intent) => trySuper(intent);
input.onEmote = (n) => sendEmote(n);

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
const inviteUrl = () => `${location.origin}${location.pathname}?room=${app.code}`;

function onRoom(room) {
  const prev = app.room?.state;
  const prevCode = app.room?.code;
  app.room = room;
  if (room.state === 'lobby') {
    showScreen('lobby');
    renderLobby();
    if (prevCode !== room.code) renderQr();
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
    if (art.ready) drawPortrait(ictx, id, 112, 112);
    else { ictx.scale(2, 2); drawBrawler(ictx, 28, 30, id, 0.4); }
    const el = (cls, text) => Object.assign(document.createElement('div'), { className: cls, textContent: text });
    card.append(icon, el('name', b.name), el('role', b.role), el('desc', b.desc));
    for (const [label, val] of Object.entries(b.stats)) {
      const row = document.createElement('div');
      row.className = 'stat';
      row.innerHTML = `<span></span><div class="bar"><i style="width:${val * 20}%"></i></div>`;
      row.firstChild.textContent = label;
      card.append(row);
    }
    card.append(el('super', `⚡ ${b.super.name}`), el('desc super-desc', b.super.desc));
    card.addEventListener('click', () => {
      const me = playerById(app.myId);
      if (me) me.brawler = id;
      send({ t: 'pick', brawler: id });
      renderLobby();
    });
    wrap.append(card);
  }
}

function renderQr() {
  const box = $('qr');
  box.innerHTML = '';
  if (!app.code || typeof window.qrcode !== 'function') { box.classList.add('hidden'); return; }
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(inviteUrl());
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    box.classList.remove('hidden');
  } catch {
    box.classList.add('hidden');
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
    if (p.wins) tag(`🏆 ${p.wins}`, 'wins');
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
    const span = (cls, text) => Object.assign(document.createElement('span'), { className: cls, textContent: text });
    const dot = span('dot', '');
    dot.style.cssText = `width:18px;height:18px;border-radius:50%;flex:none;background:${BRAWLERS[r.brawler].color}`;
    li.append(
      span('rank', `#${r.rank}`), dot, span('who', r.id === app.myId ? `${r.name} (you)` : r.name),
      span('muted', `${r.kills} KO${r.kills === 1 ? '' : 's'}`), span('wins', `🏆 ${r.wins}`),
    );
    list.append(li);
  }
  const isHost = room.hostId === app.myId;
  $('againBtn').classList.toggle('hidden', !isHost);
  $('againHint').textContent = isHost ? '' : 'Waiting for the host… (back to lobby automatically in a few seconds)';
  if (net.resultSoundFor !== room.results) {
    net.resultSoundFor = room.results;
    if (mine) (mine.rank === 1 ? sfx.win : sfx.lose)();
  }
}

// ---------- snapshots, prediction, interpolation ----------

const latestSnap = () => net.snaps[net.snaps.length - 1];

// Move our own predicted position one tick, exactly as the server will.
function predictStep(p, mx, my, snap) {
  if (net.me.ghost) moveGhost(p, mx, my);
  else movePlayer(p, mx, my, BRAWLERS[myBrawler()].speed * speedFactor(p.x, p.y, snap?.haunts ?? []), snap?.crates ?? []);
}

function onSnap(m) {
  if (m.state === 'countdown' && net.lastState !== 'countdown') net.reset();
  net.lastState = m.state;
  m.pmap = new Map(m.players.map((p) => [p.i, p]));
  m.prmap = new Map(m.projs.map((p) => [p.i, p]));
  m.gmap = new Map(m.ghosts.map((g) => [g.i, g]));
  net.snaps.push(m);
  if (net.snaps.length > 40) net.snaps.shift();

  const est = m.time * 1000 - performance.now();
  if (net.offset === null || Math.abs(est - net.offset) > 400) net.offset = est;
  else net.offset += (est - net.offset) * 0.06;

  const prevSu = net.me.su ?? 0;
  net.me = m.me;
  if (m.me.alive && prevSu < 1 && m.me.su >= 1) sfx.superReady();
  if (m.me.ghost !== net.wasGhost) { net.wasGhost = m.me.ghost; net.pred = null; net.pending = []; }

  const self = m.me.ghost ? m.gmap.get(app.myId) : m.pmap.get(app.myId);
  if (self && !(m.players.find((p) => p.i === app.myId)?.d)) {
    // Server says where we were after input #ack; replay the inputs it hasn't seen yet.
    const shown = net.pred ? { x: net.pred.x + net.err.x, y: net.pred.y + net.err.y } : null;
    net.pending = net.pending.filter((i) => i.seq > m.me.ack);
    const p = { x: self.x, y: self.y };
    for (const i of net.pending) predictStep(p, i.mx, i.my, m);
    net.pred = p;
    if (shown) {
      net.err.x = shown.x - p.x;
      net.err.y = shown.y - p.y;
      if (Math.hypot(net.err.x, net.err.y) > 150) net.err = { x: 0, y: 0 };
    }
  } else if (self) {
    // Mid-charge: just follow the server.
    net.pred = { x: self.x, y: self.y };
    net.pending = [];
    net.err = { x: 0, y: 0 };
  } else {
    net.pred = null;
  }
  for (const e of m.ev) net.events.push({ ...e, at: m.time * 1000 });
}

function canAct() {
  return app.room?.state === 'playing' && net.lastState === 'playing' && (net.me.alive || net.me.ghost) && net.pred;
}

function stepInput() {
  net.cooldown = Math.max(0, net.cooldown - DT);
  if (!canAct()) return;
  const { mx: rx, my: ry } = input.move();
  const mx = round2(rx), my = round2(ry);
  updateAim(mx, my);
  net.seq++;
  send({ t: 'i', s: net.seq, x: mx, y: my, a: round2(net.aimAngle) });
  net.pending.push({ seq: net.seq, mx, my });
  if (net.pending.length > 120) net.pending.shift();
  predictStep(net.pred, mx, my, latestSnap());
  if (input.mouse.down && !input.touchMode && net.me.alive) tryFire({ mouse: true });
}

function selfScreenPos() {
  if (!net.pred) return null;
  return renderer.toScreen(net.cam, net.pred.x + net.err.x, net.pred.y + net.err.y);
}

// Angle and distance from your brawler to the mouse, measured on the ground.
function mouseAim() {
  if (!net.pred) return null;
  const me = { x: net.pred.x + net.err.x, y: net.pred.y + net.err.y };
  if (renderer.groundPoint) {
    const g = renderer.groundPoint(input.mouse.x, input.mouse.y);
    if (!g) return null;
    return { angle: Math.atan2(g.y - me.y, g.x - me.x), dist: Math.hypot(g.x - me.x, g.y - me.y) };
  }
  const s = selfScreenPos();
  return { angle: Math.atan2(input.mouse.y - s.y, input.mouse.x - s.x), dist: Math.hypot(input.mouse.x - s.x, input.mouse.y - s.y) / renderer.scale };
}

function updateAim(mx, my) {
  const ta = input.superAim().active ? input.superAim() : input.touchAim();
  if (ta.active) net.aimAngle = ta.angle;
  else if (!input.touchMode) {
    const m = mouseAim();
    if (m) net.aimAngle = m.angle;
  } else if (Math.hypot(mx, my) > 0.2) net.aimAngle = Math.atan2(my, mx);
}

// Turn a fire intent (mouse, drag, or auto-aim tap) into an angle and distance.
function aimFor(intent, range) {
  const me = { x: net.pred.x, y: net.pred.y };
  let angle = net.aimAngle, dist = range;
  if (intent.auto) {
    let best = null, bd = range * 1.1;
    for (const p of net.view?.players ?? []) {
      if (p.isMe) continue;
      const d = Math.hypot(p.x - me.x, p.y - me.y);
      if (d < bd) { bd = d; best = p; }
    }
    if (best) { angle = Math.atan2(best.y - me.y, best.x - me.x); dist = bd; }
  } else if (intent.angle != null) {
    angle = intent.angle;
    dist = intent.frac * range;
  } else if (intent.mouse) {
    const m = mouseAim();
    if (!m) return null;
    angle = m.angle;
    dist = m.dist;
  }
  return { angle, dist };
}

function tryFire(intent) {
  if (!canAct()) return;
  if (net.me.ghost) {
    if (net.me.hcd > 0) return;
    net.me.hcd = HAUNT.cooldown;
    send({ t: 'h' });
    return;
  }
  if (net.cooldown > 0 || net.me.ammo < 1) return;
  const aim = aimFor(intent, BRAWLERS[myBrawler()].range);
  if (!aim) return;
  net.aimAngle = aim.angle;
  net.cooldown = CLIENT_COOLDOWN;
  net.me.ammo -= 1;
  send({ t: 'f', x: round2(Math.cos(aim.angle)), y: round2(Math.sin(aim.angle)), d: Math.round(aim.dist) });
}

function trySuper(intent) {
  if (!canAct() || !net.me.alive || net.me.su < 1) return;
  const aim = aimFor(intent, BRAWLERS[myBrawler()].super.range);
  if (!aim) return;
  net.aimAngle = aim.angle;
  net.me.su = 0;
  send({ t: 's', x: round2(Math.cos(aim.angle)), y: round2(Math.sin(aim.angle)), d: Math.round(aim.dist) });
}

function sendEmote(n) {
  if (!canAct() && net.lastState !== 'countdown') return;
  send({ t: 'e', n });
  sfx.emote();
  $('emoteTray').classList.add('hidden');
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
  const selfShown = net.pred ? { x: net.pred.x + net.err.x, y: net.pred.y + net.err.y } : null;

  const players = [];
  for (const pb of b.players) {
    if (pb.i === app.myId) continue;
    const pa = a.pmap.get(pb.i) ?? pb;
    const info = playerById(pb.i);
    players.push({
      id: pb.i, x: lerp(pa.x, pb.x, k), y: lerp(pa.y, pb.y, k), hp: pb.h, maxHp: pb.m, aim: pb.a, cubes: pb.c,
      bush: pb.bush, em: pb.em, dash: pb.d, brawler: info?.brawler ?? 'brick', name: info?.name ?? '', isMe: false,
    });
  }
  const selfSnap = latest.pmap.get(app.myId);
  if (selfSnap && selfShown && !net.me.ghost) {
    players.push({
      id: app.myId, ...selfShown, hp: selfSnap.h, maxHp: selfSnap.m, aim: net.aimAngle, cubes: selfSnap.c,
      bush: inBush(selfShown.x, selfShown.y) ? 1 : 0, em: selfSnap.em, dash: selfSnap.d, brawler: myBrawler(), name: 'You', isMe: true,
    });
  }

  const ghosts = [];
  for (const gb of b.ghosts) {
    if (gb.i === app.myId) continue;
    const ga = a.gmap.get(gb.i) ?? gb;
    ghosts.push({ id: gb.i, x: lerp(ga.x, gb.x, k), y: lerp(ga.y, gb.y, k), em: gb.em, name: nameOf(gb.i), isMe: false });
  }
  const selfGhost = latest.gmap.get(app.myId);
  if (net.me.ghost && selfGhost && selfShown) ghosts.push({ id: app.myId, ...selfShown, em: selfGhost.em, name: 'You', isMe: true });

  const projs = b.projs.map((pb) => {
    const pa = a.prmap.get(pb.i);
    if (!pa) return pb;
    return pb.k === 'l' ? { ...pb, p: lerp(pa.p, pb.p, k) } : { ...pb, x: lerp(pa.x, pb.x, k), y: lerp(pa.y, pb.y, k) };
  });

  // Fire events (damage numbers, explosions, KOs, sounds) when the interpolated time reaches them.
  while (net.events.length && net.events[0].at <= rt) handleEvent(net.events.shift(), now);

  return {
    players, ghosts, projs, cubes: b.cubes, crates: b.crates, haunts: b.haunts,
    poison: lerp(a.poison, b.poison, k), latest, me: net.me, cam: net.cam,
  };
}

function handleEvent(e, now) {
  renderer.addEvent(e, now);
  const vol = e.x != null ? Math.max(0, 1 - Math.hypot(e.x - net.cam.x, e.y - net.cam.y) / 1100) : 1;
  switch (e.k) {
    case 'dmg':
      if (e.id === app.myId) { renderer.hurt(now); renderer.shake(e.src === 'hit' ? 12 : 5); sfx.hurt(); }
      else if (e.by === app.myId) sfx.hit();
      break;
    case 'shot': if (vol > 0) sfx.shot(e.w, vol); break;
    case 'boom': if (vol > 0) { sfx.boom(e.big, vol); renderer.shake((e.big ? 16 : 8) * vol); } break;
    case 'ko': sfx.ko(Math.max(vol, 0.3)); onKnockout(e); break;
    case 'cube': if (e.id === app.myId) sfx.cube(); break;
    case 'crate': if (vol > 0) sfx.crate(vol); break;
    case 'crateBreak': if (vol > 0) sfx.crateBreak(vol); break;
    case 'super': if (vol > 0) { sfx.super(vol); renderer.shake(6 * vol); } break;
    case 'haunt': if (vol > 0) sfx.haunt(vol); break;
  }
}

function onKnockout(e) {
  const feed = document.createElement('div');
  feed.textContent = !e.by ? `${nameOf(e.id)} fell to the poison`
    : e.haunt ? `👻 ${nameOf(e.by)} haunted out ${nameOf(e.id)}`
      : `${nameOf(e.by)} knocked out ${nameOf(e.id)}`;
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
  const meGhost = view.ghosts.find((g) => g.isMe);
  let target = me ?? meGhost;
  if (!target) target = view.players.find((p) => p.id === net.killedBy) ?? view.players[0];
  if (me || meGhost) { net.cam.x = target.x; net.cam.y = target.y; }
  else if (target) {
    const k = Math.min(1, dtf * 6);
    net.cam.x = lerp(net.cam.x, target.x, k);
    net.cam.y = lerp(net.cam.y, target.y, k);
  }

  if (me && app.room?.state === 'playing') {
    const sa = input.superAim();
    const ta = input.touchAim();
    const stick = sa.active ? sa : ta;
    const showAim = input.touchMode ? stick.active : true;
    if (showAim) {
      const b = BRAWLERS[me.brawler];
      let dist = sa.active ? b.super.range : b.range;
      if (input.touchMode) dist *= stick.frac;
      else dist = mouseAim()?.dist ?? dist;
      view.aim = { x: me.x, y: me.y, angle: net.aimAngle, dist, brawler: me.brawler, super: sa.active };
    }
  }
  if (input.touchMode && (me || meGhost)) {
    view.sticks = {
      left: input.left, right: input.right, superStick: input.superStick, ghost: !!meGhost,
      hint: app.room?.state === 'playing' && (view.latest.mt < 8 || (meGhost && !input.left)),
    };
  }

  renderer.draw(view, now);
  updateHud(view, me, meGhost, target, now);
}

function updateHud(view, me, meGhost, target, now) {
  const snap = view.latest;
  $('aliveCount').textContent = `👥 ${snap.alive} left`;
  const untilPoison = Math.ceil(POISON.start - snap.mt);
  const outside = me && Math.hypot(me.x - CENTER, me.y - CENTER) > view.poison;
  const poison = $('poisonInfo');
  poison.classList.toggle('danger', !!outside);
  poison.textContent = outside ? '☠ Get out of the poison!' : untilPoison > 0 ? `☠ Poison in ${untilPoison}s` : '☠ Poison closing in';

  let center = '';
  if (snap.state === 'countdown') {
    const n = Math.max(1, Math.ceil(snap.cd));
    center = String(n);
    if (net.lastBeep !== n) { net.lastBeep = n; sfx.beep(false); }
  } else if (now - net.fightShownAt < 900) {
    center = 'FIGHT!';
    if (net.lastBeep !== 0) { net.lastBeep = 0; sfx.beep(true); }
  }
  $('centerMsg').textContent = center;

  let spec = '';
  if (meGhost && app.room?.state === 'playing') {
    const ready = net.me.hcd <= 0;
    const how = input.touchMode ? 'Tap right side' : 'Click or Space';
    spec = `👻 You're a ghost! ${how} to haunt survivors · ${ready ? 'READY' : `${Math.ceil(net.me.hcd)}s`}`;
  } else if (!me && app.room?.state === 'playing') {
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

  const hint = me && net.me.su >= 1 && !input.touchMode && app.room?.state === 'playing'
    ? `⚡ ${BRAWLERS[me.brawler].super.name} ready! Press E or right-click` : '';
  if ($('superHint').textContent !== hint) $('superHint').textContent = hint;
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

function renderMute() {
  $('muteBtn').textContent = isMuted() ? '🔇' : '🔊';
  $('muteBtn').setAttribute('aria-label', isMuted() ? 'Unmute sound' : 'Mute sound');
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
  const url = inviteUrl();
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
$('muteBtn').addEventListener('click', () => { setMuted(!isMuted()); renderMute(); });
$('emoteBtn').addEventListener('click', () => $('emoteTray').classList.toggle('hidden'));
EMOTES.forEach((em, n) => {
  const b = Object.assign(document.createElement('button'), { textContent: em, title: `Emote (key ${n + 1})` });
  b.addEventListener('click', () => sendEmote(n));
  $('emoteTray').append(b);
});

renderMute();
buildCards();
loadArt().then((ok) => { if (ok) { buildCards(); renderLobby(); } });

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
