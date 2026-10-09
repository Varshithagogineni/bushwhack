import {
  DT, BRAWLERS, BRAWLER_IDS, MAX_AMMO, MIN_PLAYERS, MAX_PLAYERS, CENTER, POISON, HAUNT, EMOTES, MODES, MODE_IDS,
  movePlayer, moveGhost, speedFactor, round2, inBush, isWallAt, clamp, PLAYER_RADIUS,
} from '/shared/game.js';
import { BADGES } from '/shared/badges.js';
import { Input } from './input.js';
import { Renderer, drawBrawler } from './render.js';
import { art, loadArt, drawPortrait } from './assets.js';
import { sfx, isMuted, setMuted } from './sfx.js';
import { hostRoom, joinRoom } from './net/p2p.js';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const INTERP_MS = 80; // render other players this far in the past so motion stays smooth
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
  snaps: [], offset: null, events: [], pending: [], seq: 0, pred: null, err: { x: 0, y: 0 }, localProjs: [], rtt: null,
  me: { alive: false, ghost: false, ammo: MAX_AMMO, cubes: 0, su: 0, hcd: 0 }, cooldown: 0, lastState: null,
  killedBy: null, cam: { x: CENTER, y: CENTER }, aimAngle: 0, fightShownAt: 0, view: null,
  lastBeep: null, resultSoundFor: null, wasGhost: false,
  reset() {
    this.snaps = []; this.events = []; this.pending = []; this.pred = null; this.err = { x: 0, y: 0 };
    this.killedBy = null; this.cooldown = 0; this.lastBeep = null; this.wasGhost = false; this.localProjs = [];
  },
};

// ---------- optional accounts ----------

const account = { token: local.get('bw_auth'), profile: null };

// Accounts live in Supabase; the browser may only call the bw_* database functions.
async function rpc(fn, args = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message || 'Something went wrong. Try again.');
  return data;
}

async function refreshAccount() {
  if (account.token) {
    try { account.profile = await rpc('bw_me', { p_token: account.token }); } catch { signOutLocally(); }
  }
  renderAccount();
}

function signOutLocally() {
  account.token = null;
  account.profile = null;
  local.del('bw_auth');
}

function renderAccount() {
  const p = account.profile;
  $('guestBar').classList.toggle('hidden', Boolean(p));
  $('userBar').classList.toggle('hidden', !p);
  $('nameField').classList.toggle('hidden', Boolean(p));
  if (p) $('userChip').textContent = `👤 ${p.username} · 🏆 ${p.trophies}`;
}

let authMode = 'login';
function openAuth(mode = 'login') {
  authMode = mode;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('selected', t.dataset.tab === mode);
  $('authSubmit').textContent = mode === 'login' ? 'Sign in' : 'Create account';
  $('authPass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('authError').classList.add('hidden');
  $('authModal').classList.remove('hidden');
  setTimeout(() => $('authUser').focus(), 30);
}

let profileReturn = 'home';
async function openProfile() {
  if (!account.profile) return openAuth('login');
  profileReturn = !$('lobby').classList.contains('hidden') ? 'lobby' : 'home';
  await refreshAccount();
  renderProfile(account.profile);
  showScreen('profile');
  try { renderLeaderboard(await rpc('bw_leaderboard')); } catch { /* offline: skip */ }
}

function tile(label, value) {
  const d = document.createElement('div');
  d.className = 'stat-tile';
  d.append(Object.assign(document.createElement('b'), { textContent: value }), Object.assign(document.createElement('span'), { textContent: label }));
  return d;
}

function renderProfile(p) {
  if (!p) return;
  const s = p.stats;
  $('pName').textContent = p.username;
  $('pTrophies').textContent = p.trophies;
  const rate = s.matches ? Math.round((s.wins / s.matches) * 100) : 0;
  $('pStats').replaceChildren(
    tile('Matches', s.matches), tile('Wins', s.wins), tile('Losses', s.losses), tile('Win rate', `${rate}%`),
    tile('Knockouts', s.kills), tile('Best streak', s.bestStreak),
    tile(`${MODES.showdown.icon} Showdown wins`, s.byMode.showdown.wins), tile(`${MODES.gemgrab.icon} Gem Grab wins`, s.byMode.gemgrab.wins),
    tile(`${MODES.bounty.icon} Bounty wins`, s.byMode.bounty.wins), tile('Gems carried', s.gems), tile('Stars stolen', s.stars), tile('Supers used', s.supers),
  );
  $('pBrawlers').replaceChildren(...BRAWLER_IDS.map((id) => {
    const b = s.byBrawler[id];
    const d = document.createElement('div');
    d.className = 'brawler-stat';
    d.style.boxShadow = `inset 0 4px 0 ${BRAWLERS[id].color}`;
    d.append(
      Object.assign(document.createElement('div'), { className: 'bname', textContent: BRAWLERS[id].name }),
      Object.assign(document.createElement('div'), { className: 'bline', textContent: `${b.wins} wins · ${b.played} played · ${b.kills} KOs` }),
    );
    return d;
  }));
  const earned = BADGES.filter((b) => p.badges[b.id]).length;
  $('pBadgeCount').textContent = `${earned}/${BADGES.length} secured`;
  $('pBadges').replaceChildren(...BADGES.map((b) => {
    const got = Boolean(p.badges[b.id]);
    const d = document.createElement('div');
    d.className = `badge ${got ? 'earned' : 'locked'}`;
    d.append(
      Object.assign(document.createElement('div'), { className: 'bicon', textContent: b.icon }),
      Object.assign(document.createElement('div'), { className: 'bname', textContent: b.name }),
      Object.assign(document.createElement('div'), { className: 'bdesc', textContent: got ? `Secured ${new Date(p.badges[b.id]).toLocaleDateString()}` : b.desc }),
    );
    if (!got && b.goal > 1) {
      const v = Math.min(b.goal, b.value(s, p.trophies));
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.innerHTML = `<i style="width:${(v / b.goal) * 100}%"></i>`;
      d.append(bar, Object.assign(document.createElement('div'), { className: 'bdesc', textContent: `${v} / ${b.goal}` }));
    }
    return d;
  }));
}

function renderLeaderboard(top) {
  $('leaderboard').replaceChildren(...top.map((row, i) => {
    const li = document.createElement('li');
    if (row.username === account.profile?.username) li.classList.add('me');
    li.append(
      Object.assign(document.createElement('span'), { className: 'pos', textContent: `#${i + 1}` }),
      Object.assign(document.createElement('span'), { className: 'who', textContent: row.username }),
      Object.assign(document.createElement('span'), { textContent: `🏆 ${row.trophies}` }),
    );
    return li;
  }));
}

function renderProgress() {
  const box = $('progress');
  const pr = app.progress;
  box.classList.toggle('hidden', !pr);
  if (!pr) return;
  const delta = Object.assign(document.createElement('div'), {
    className: `delta ${pr.delta > 0 ? 'up' : pr.delta < 0 ? 'down' : ''}`,
    textContent: `${pr.delta > 0 ? '+' : ''}${pr.delta} 🏆 · ${pr.trophies} total`,
  });
  box.replaceChildren(delta, ...pr.newBadges.map((b) => Object.assign(document.createElement('div'), {
    className: 'newbadge', textContent: `New badge secured: ${b.icon} ${b.name}`,
  })));
}

const canvas = $('canvas');
let renderer = new Renderer(canvas);
let stage = null; // 3D brawler preview in the lobby
// Upgrade to the real-time 3D renderer when WebGL works; the 2D one stays as the fallback.
try {
  const probe = document.createElement('canvas');
  if (probe.getContext('webgl2') || probe.getContext('webgl')) {
    import('./render3d.js')
      .then(async ({ Renderer3D }) => {
        const r3 = new Renderer3D(canvas);
        await r3.load();
        renderer = r3;
        stage = r3.createStage($('stage'));
        stage.setBrawler(myBrawler());
        if (!$('lobby').classList.contains('hidden')) stage.start();
      })
      .catch((e) => console.warn('3D renderer unavailable, using 2D.', e));
  }
} catch { /* no WebGL */ }
const input = new Input(canvas);
input.onFire = (intent) => tryFire(intent);
input.onSuper = (intent) => trySuper(intent);
input.onEmote = (n) => sendEmote(n);

// ---------- networking ----------

let hosting = null; // our hosted room, when we created it
let connecting = false;
let leaving = false;

function showNet(text) {
  $('net').textContent = text;
  $('net').classList.toggle('hidden', !text);
}

function attach(conn, kind, code) {
  app.ws = conn;
  conn.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    onMessage(m);
  };
  conn.onclose = () => {
    if (app.ws !== conn) return;
    app.ws = null;
    onConnectionLost();
  };
  const signedIn = account.profile ? { username: account.profile.username, trophies: account.profile.trophies } : null;
  conn.send(JSON.stringify({ t: kind, code, name: myName(), token: app.token, account: signedIn }));
}

// Create = host the room in this browser; join = connect straight to the host's browser.
async function enterRoom(kind, code) {
  if (connecting) return;
  connecting = true;
  showNet(kind === 'create' ? 'Creating your room…' : 'Joining room…');
  try {
    if (kind === 'create') {
      hosting = await hostRoom();
      attach(hosting.conn, 'create', hosting.code);
    } else {
      attach(await joinRoom(code), 'join', code);
    }
    showNet('');
  } catch (e) {
    showNet('');
    toast(e.message);
    if (e.fatal) { app.code = null; session.del('bw_room'); showScreen('home'); }
  } finally {
    connecting = false;
  }
}

function backHome(msg) {
  app.code = null;
  app.room = null;
  session.del('bw_room');
  showNet('');
  if (msg) toast(msg);
  history.replaceState(null, '', location.pathname);
  showScreen('home');
}

// A joined player lost the host: try to get back into the same seat, then give up gracefully.
async function onConnectionLost() {
  if (leaving || !app.code || hosting) return;
  showNet('Reconnecting…');
  for (let tries = 0; tries < 3 && app.code; tries++) {
    try {
      attach(await joinRoom(app.code), 'join', app.code);
      showNet('');
      return;
    } catch (e) {
      if (e.fatal) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  backHome('The host closed the room.');
}

function send(m) {
  if (app.ws?.readyState === 1) app.ws.send(JSON.stringify(m));
}

async function recordMatch(match) {
  if (!account.token) return;
  try {
    const pr = await rpc('bw_record_match', { p_token: account.token, m: match });
    app.progress = { ...pr, newBadges: pr.newBadges.map((b) => BADGES.find((x) => x.id === b.id)).filter(Boolean) };
    if (account.profile) { account.profile.trophies = pr.trophies; renderAccount(); }
    renderProgress();
    if (app.progress.newBadges.length) sfx.superReady();
  } catch (e) {
    console.warn('Could not save match', e.message);
  }
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
    case 'record':
      recordMatch(m.match);
      break;
    case 'pong':
      net.rtt = net.rtt == null ? performance.now() - m.ts : net.rtt * 0.8 + (performance.now() - m.ts) * 0.2;
      break;
    case 'error':
      toast(m.msg);
      if (m.fatal) backHome();
      break;
  }
}

// ---------- screens & lobby ----------

function showScreen(name) {
  $('home').classList.toggle('hidden', name !== 'home');
  $('lobby').classList.toggle('hidden', name !== 'lobby');
  $('game').classList.toggle('hidden', name !== 'game');
  $('profile').classList.toggle('hidden', name !== 'profile');
  document.body.style.overflow = name === 'game' ? 'hidden' : '';
  if (stage) (name === 'lobby' ? stage.start : stage.stop)();
}

const playerById = (id) => app.room?.players.find((p) => p.id === id);
const nameOf = (id) => (id === app.myId ? 'You' : playerById(id)?.name ?? '???');
const myBrawler = () => playerById(app.myId)?.brawler ?? BRAWLER_IDS[0];
const myName = () => ($('nameInput').value.trim() || local.get('bw_name') || 'Brawler').slice(0, 14);
const inviteUrl = () => `${location.origin}${location.pathname}?room=${app.code}`;

// Which screen you see depends on the room *and* on you: you can sit out a match in the lobby,
// and results stay up until you tap Continue (like Brawl Stars), even if the room has moved on.
function onRoom(room) {
  const prev = app.room?.state;
  const prevCode = app.room?.code;
  app.room = room;
  if (prevCode !== room.code) renderQr();
  const me = playerById(app.myId);
  const inPlay = room.state === 'countdown' || room.state === 'playing';
  if (inPlay && (prev === 'lobby' || prev === 'ended' || prev == null)) {
    net.reset();
    input.reset();
    app.progress = null;
    renderProgress();
    app.viewingResults = false;
    app.sittingOut = Boolean(me?.out);
    hideKo();
  }
  if (room.state === 'ended' && prev !== 'ended' && me?.inMatch && !me.out && !app.sittingOut) {
    app.viewingResults = true;
    app.sittingOut = false;
    hideKo();
  }
  if (room.state === 'playing' && prev === 'countdown') net.fightShownAt = performance.now();
  if (me?.out && inPlay) app.sittingOut = true;
  showScreen(app.viewingResults || (inPlay && !app.sittingOut) ? 'game' : 'lobby');
  renderLobby();
  renderResults();
}

function hideKo() { $('koCard').classList.add('hidden'); }

// Leave the current match (it keeps going) and wait in the lobby for the next one.
function exitToLobby() {
  $('leaveModal').classList.add('hidden');
  hideKo();
  const state = app.room?.state;
  if (state === 'playing' || state === 'countdown') send({ t: 'forfeit' });
  app.sittingOut = true;
  app.viewingResults = false;
  input.reset();
  if (app.room) onRoom(app.room);
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

function buildModeCards() {
  const wrap = $('modeCards');
  wrap.innerHTML = '';
  for (const id of MODE_IDS) {
    const m = MODES[id];
    const card = document.createElement('button');
    card.className = 'mode';
    card.dataset.id = id;
    const el = (cls, text) => Object.assign(document.createElement('div'), { className: cls, textContent: text });
    card.append(el('icon', m.icon), el('name', m.name), el('blurb', m.blurb));
    card.addEventListener('click', () => send({ t: 'mode', mode: id }));
    wrap.append(card);
  }
}

function playerRow(p, room) {
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
  if (p.trophies != null) tag(`🏆 ${p.trophies}`, 'wins');
  if (p.wins) tag(`${p.wins}W`, '');
  if (p.id === app.myId) tag('YOU', 'you');
  if (p.id === room.hostId) tag('HOST', 'host');
  if (!p.connected && !p.bot) tag('offline', '');
  return li;
}

function renderLobby() {
  const room = app.room;
  if (!room) return;
  $('roomCode').textContent = room.code;
  const mine = myBrawler();
  const b = BRAWLERS[mine];
  for (const card of $('brawlerCards').children) card.classList.toggle('selected', card.dataset.id === mine);
  $('stageName').textContent = b.name;
  $('stageRole').textContent = b.role;
  $('stageDesc').textContent = b.desc;
  $('stageSuper').textContent = `⚡ ${b.super.name}: ${b.super.desc}`;
  stage?.setBrawler(mine);

  const isHost = room.hostId === app.myId;
  const mode = MODES[room.mode] ?? MODES.showdown;
  for (const card of $('modeCards').children) {
    card.classList.toggle('selected', card.dataset.id === room.mode);
    card.disabled = !isHost;
  }
  $('modeHint').textContent = isHost ? 'You\'re the host: pick the mode.' : `The host picks the mode. Now playing: ${mode.icon} ${mode.name}`;

  const list = $('playerList');
  list.innerHTML = '';
  if (mode.teams) {
    const teams = document.createElement('div');
    teams.className = 'teams';
    for (const [t, label, cls] of [[0, 'Blue team', 'blue'], [1, 'Red team', 'red']]) {
      const col = document.createElement('div');
      col.className = `team ${cls}`;
      const h = document.createElement('h3');
      h.textContent = label;
      if (playerById(app.myId)?.team !== t) {
        const join = Object.assign(document.createElement('button'), { className: 'btn small ghost', textContent: 'Join' });
        join.addEventListener('click', () => send({ t: 'team', team: t }));
        h.append(join);
      }
      const ul = document.createElement('ul');
      ul.className = 'players';
      for (const p of room.players.filter((x) => x.team === t)) ul.append(playerRow(p, room));
      col.append(h, ul);
      teams.append(col);
    }
    list.append(teams);
  } else {
    const ul = document.createElement('ul');
    ul.className = 'players';
    for (const p of room.players) ul.append(playerRow(p, room));
    list.append(ul);
  }
  $('playerCount').textContent = `${room.players.length}/${MAX_PLAYERS}`;

  const inPlay = room.state === 'countdown' || room.state === 'playing';
  const banner = inPlay ? `${mode.icon} A ${mode.name} match is in progress. You'll join the next one.`
    : room.state === 'ended' ? `Match finished. ${isHost ? 'Hit Play to start the next one.' : 'Waiting for the host to start the next match…'}` : '';
  $('matchBanner').textContent = banner;
  $('matchBanner').classList.toggle('hidden', !banner);
  $('hostControls').classList.toggle('hidden', !isHost);
  $('startBtn').disabled = inPlay || room.players.length < MIN_PLAYERS;
  $('startBtn').textContent = `Play ${mode.name}`;
  $('addBotBtn').disabled = room.players.length >= MAX_PLAYERS;
  $('removeBotBtn').disabled = !room.players.some((p) => p.bot);
  const host = playerById(room.hostId);
  $('lobbyStatus').textContent = isHost
    ? room.players.length < MIN_PLAYERS ? 'Share the code, or add a bot to play right away.' : 'Everyone ready? Hit Play.'
    : `Waiting for ${host?.name ?? 'the host'} to start the match…`;
}

function renderResults() {
  const room = app.room;
  const show = Boolean(app.viewingResults && room?.results);
  $('results').classList.toggle('hidden', !show);
  if (!show) return;
  const mine = room.results.find((r) => r.id === app.myId);
  const winner = room.results.find((r) => r.won);
  const teamName = (t) => (t === 0 ? 'Blue team' : 'Red team');
  if (MODES[room.mode]?.teams) {
    $('resultTitle').textContent = room.winnerTeam == null ? 'Draw!' : mine?.won ? '🏆 Victory!' : 'Defeat';
    $('resultSub').textContent = room.winnerTeam == null ? 'Both teams held the same number of gems.' : `${teamName(room.winnerTeam)} wins Gem Grab`;
  } else {
    $('resultTitle').textContent = !mine ? 'Match over' : mine.won ? '🏆 Victory!' : `#${mine.rank} place`;
    $('resultSub').textContent = !winner ? 'Nobody won this one!'
      : room.mode === 'bounty' ? `${winner.id === app.myId ? 'You' : winner.name} collected the most stars (${winner.score}⭐)`
        : `${winner.id === app.myId ? 'You' : winner.name} won as ${BRAWLERS[winner.brawler].name}`;
  }
  const list = $('resultList');
  list.innerHTML = '';
  for (const r of room.results) {
    const li = document.createElement('li');
    if (r.id === app.myId) li.classList.add('me');
    const span = (cls, text) => Object.assign(document.createElement('span'), { className: cls, textContent: text });
    const dot = span('dot', '');
    const teams = MODES[room.mode]?.teams;
    dot.style.cssText = `width:18px;height:18px;border-radius:50%;flex:none;background:${BRAWLERS[r.brawler].color};${teams ? `box-shadow:0 0 0 3px ${r.team === 0 ? '#4aa3ff' : '#ff4d4f'}` : ''}`;
    li.append(
      span('rank', `#${r.rank}`), dot, span('who', r.id === app.myId ? `${r.name} (you)` : r.name),
      span('muted', room.mode === 'bounty' ? `${r.score}⭐` : `${r.kills} KO${r.kills === 1 ? '' : 's'}`), span('wins', `🏆 ${r.wins}`),
    );
    list.append(li);
  }
  const isHost = room.hostId === app.myId;
  $('againHint').textContent = isHost ? 'Continue to the lobby to start the next match.' : 'The host starts the next match from the lobby.';
  if (net.resultSoundFor !== room.results) {
    net.resultSoundFor = room.results;
    if (mine) (mine.won ? sfx.win : sfx.lose)();
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
  send({ t: 'f', x: round2(Math.cos(aim.angle)), y: round2(Math.sin(aim.angle)), d: Math.round(aim.dist), l: lead() });
  spawnLocalShots(aim.angle, aim.dist, false);
}

function trySuper(intent) {
  if (!canAct() || !net.me.alive || net.me.su < 1) return;
  const aim = aimFor(intent, BRAWLERS[myBrawler()].super.range);
  if (!aim) return;
  net.aimAngle = aim.angle;
  net.me.su = 0;
  send({ t: 's', x: round2(Math.cos(aim.angle)), y: round2(Math.sin(aim.angle)), d: Math.round(aim.dist), l: lead() });
  spawnLocalShots(aim.angle, aim.dist, true);
}

// One-way delay to the server; it fast-forwards our shots by this much.
const lead = () => Math.round(Math.min(150, (net.rtt ?? 0) / 2));

// Your own shots are drawn the instant you fire (the server's copies of them are hidden),
// so attacking feels immediate even on a slow connection. The server still decides every hit.
let localShotId = 0;
function spawnLocalShots(angle, dist, isSuper) {
  if (!net.pred) return;
  const b = BRAWLERS[myBrawler()];
  const spec = isSuper ? b.super : b;
  const kind = isSuper ? b.super.kind : b.attack;
  const { x, y } = net.pred;
  if (kind === 'charge') return;
  if (kind === 'lob' || kind === 'mega') {
    const d = clamp(dist, isSuper ? 100 : 80, spec.range);
    net.localProjs.push({ i: `L${++localShotId}`, k: 'l', sx: x, sy: y, tx: x + Math.cos(angle) * d, ty: y + Math.sin(angle) * d, p: 0, flight: spec.flight, r: spec.blast, big: isSuper ? 1 : 0 });
    return;
  }
  const shots = kind === 'shotgun' ? b.pellets : kind === 'volley' ? b.super.shots : 1;
  const spread = kind === 'shotgun' ? b.spread : kind === 'volley' ? b.super.spread : 0;
  for (let i = 0; i < shots; i++) {
    const a = angle + (shots > 1 ? (i / (shots - 1) - 0.5) * spread : 0);
    net.localProjs.push({
      i: `L${++localShotId}`, k: kind === 'shotgun' ? 'p' : kind === 'volley' ? 'v' : 'b',
      x: x + Math.cos(a) * (PLAYER_RADIUS + 4), y: y + Math.sin(a) * (PLAYER_RADIUS + 4),
      vx: Math.cos(a) * spec.projSpeed, vy: Math.sin(a) * spec.projSpeed, travelled: 0, range: spec.range, pierce: kind === 'volley',
    });
  }
}

function stepLocalShots(dt, now) {
  const players = net.view?.players ?? [];
  const teams = MODES[net.view?.mode]?.teams;
  net.localProjs = net.localProjs.filter((pr) => {
    if (pr.k === 'l') { pr.p += dt / pr.flight; return pr.p < 1; }
    const speed = Math.hypot(pr.vx, pr.vy);
    const steps = Math.max(1, Math.ceil((speed * dt) / 14));
    for (let s = 0; s < steps; s++) {
      pr.x += (pr.vx * dt) / steps;
      pr.y += (pr.vy * dt) / steps;
      pr.travelled += (speed * dt) / steps;
      if (pr.travelled > pr.range) return false;
      if (isWallAt(pr.x, pr.y)) { renderer.addEvent({ k: 'spark', x: pr.x, y: pr.y }, now); return false; }
      for (const p of players) {
        if (p.isMe || (teams && p.team === net.me.team)) continue;
        if (!pr.pierce && Math.hypot(p.x - pr.x, p.y - pr.y) <= PLAYER_RADIUS + 10) return false;
      }
    }
    return true;
  });
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
      team: pb.t, gems: pb.g, stars: pb.st,
    });
  }
  const selfSnap = latest.pmap.get(app.myId);
  if (selfSnap && selfShown && !net.me.ghost) {
    players.push({
      id: app.myId, ...selfShown, hp: selfSnap.h, maxHp: selfSnap.m, aim: net.aimAngle, cubes: selfSnap.c,
      bush: inBush(selfShown.x, selfShown.y) ? 1 : 0, em: selfSnap.em, dash: selfSnap.d, brawler: myBrawler(), name: 'You', isMe: true,
      team: selfSnap.t, gems: selfSnap.g, stars: selfSnap.st,
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

  const projs = b.projs.filter((pb) => pb.o !== app.myId).map((pb) => {
    const pa = a.prmap.get(pb.i);
    if (!pa) return pb;
    return pb.k === 'l' ? { ...pb, p: lerp(pa.p, pb.p, k) } : { ...pb, x: lerp(pa.x, pb.x, k), y: lerp(pa.y, pb.y, k) };
  }).concat(net.localProjs);

  // Fire events (damage numbers, explosions, KOs, sounds) when the interpolated time reaches them.
  while (net.events.length && net.events[0].at <= rt) handleEvent(net.events.shift(), now);

  return {
    players, ghosts, projs, cubes: b.cubes, crates: b.crates, haunts: b.haunts, gems: b.gems ?? [],
    poison: lerp(a.poison, b.poison, k), latest, me: net.me, cam: net.cam, mode: latest.mode ?? 'showdown',
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
    case 'cube': case 'gem': if (e.id === app.myId) sfx.cube(); break;
    case 'crate': if (vol > 0) sfx.crate(vol); break;
    case 'crateBreak': if (vol > 0) sfx.crateBreak(vol); break;
    case 'super': if (vol > 0) { sfx.super(vol); renderer.shake(6 * vol); } break;
    case 'haunt': if (vol > 0) sfx.haunt(vol); break;
  }
}

function onKnockout(e) {
  const feed = document.createElement('div');
  feed.textContent = e.left ? `${nameOf(e.id)} left the match`
    : e.bounty && e.by ? `${nameOf(e.by)} took ${e.bounty}⭐ from ${nameOf(e.id)}`
    : !e.by ? `${nameOf(e.id)} fell to the poison`
    : e.haunt ? `👻 ${nameOf(e.by)} haunted out ${nameOf(e.id)}`
      : `${nameOf(e.by)} knocked out ${nameOf(e.id)}`;
  $('killFeed').append(feed);
  setTimeout(() => feed.remove(), 4000);
  while ($('killFeed').children.length > 4) $('killFeed').firstChild.remove();
  if (e.id === app.myId) {
    net.killedBy = e.by || null;
    if (net.view?.mode === 'showdown' && app.room?.state === 'playing') {
      const rank = (net.snaps[net.snaps.length - 1]?.alive ?? 0) + 1;
      $('koTitle').textContent = `#${rank} · Knocked out!`;
      $('koSub').textContent = e.by ? `by ${nameOf(e.by)}` : 'by the poison';
      $('koCard').classList.remove('hidden');
    }
  }
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

  stepLocalShots(dtf, now);
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
  const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const left = $('aliveCount'), right = $('poisonInfo');
  right.classList.remove('danger');
  if (view.mode === 'gemgrab') {
    const [blue, red] = snap.tg ?? [0, 0];
    const mine = net.me.team ?? 0;
    left.textContent = `💎 Blue${mine === 0 ? ' (you)' : ''} ${blue} · ${red} Red${mine === 1 ? ' (you)' : ''}`;
    right.textContent = snap.gcd ? `${snap.gcd.team === mine ? '🏆 Your team' : '⚠ Enemy'} wins in ${snap.gcd.left}` : `⏱ ${clock(snap.left ?? 0)}`;
    right.classList.toggle('danger', Boolean(snap.gcd && snap.gcd.team !== mine));
  } else if (view.mode === 'bounty') {
    const scores = snap.scores ?? [];
    const best = scores.reduce((a, s) => (s[1] > (a?.[1] ?? -1) ? s : a), null);
    const mineScore = scores.find((s) => s[0] === app.myId)?.[1] ?? 0;
    left.textContent = `⭐ You ${mineScore}${best && best[0] !== app.myId ? ` · ${nameOf(best[0])} ${best[1]}` : ' · leading!'}`;
    right.textContent = `⏱ ${clock(snap.left ?? 0)}`;
  } else {
    left.textContent = `👥 ${snap.alive} left`;
    const untilPoison = Math.ceil(POISON.start - snap.mt);
    const outside = me && Math.hypot(me.x - CENTER, me.y - CENTER) > view.poison;
    right.classList.toggle('danger', !!outside);
    right.textContent = outside ? '☠ Get out of the poison!' : untilPoison > 0 ? `☠ Poison in ${untilPoison}s` : '☠ Poison closing in';
  }

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
  } else if (!me && app.room?.state === 'playing' && MODES[view.mode]?.respawn && net.me.respawn > 0) {
    spec = `Knocked out${net.killedBy ? ` by ${nameOf(net.killedBy)}` : ''}. Respawning in ${net.me.respawn}…`;
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
  enterRoom('create');
});
$('joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('codeInput').value.trim().toUpperCase();
  if (code.length !== 4) return toast('Room codes are 4 letters.');
  saveName();
  enterRoom('join', code);
});
$('codeInput').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });
$('addBotBtn').addEventListener('click', () => send({ t: 'addBot' }));
$('removeBotBtn').addEventListener('click', () => send({ t: 'removeBot' }));
$('startBtn').addEventListener('click', () => {
  if (app.room?.state === 'ended') send({ t: 'lobby' }); // skip the rest of the results screen
  send({ t: 'start' });
});
$('againBtn').addEventListener('click', () => {
  app.viewingResults = false;
  if (app.room?.hostId === app.myId && app.room.state === 'ended') send({ t: 'lobby' });
  if (app.room) onRoom(app.room);
});
$('exitBtn').addEventListener('click', () => {
  const showdownAlive = net.view?.mode === 'showdown' && net.me.alive;
  $('leaveText').textContent = `${showdownAlive ? 'You\'ll be counted as knocked out. ' : ''}The match keeps going for everyone else; you'll wait in the lobby and join the next one.`;
  $('leaveModal').classList.remove('hidden');
});
$('leaveMatchBtn').addEventListener('click', exitToLobby);
$('leaveCancel').addEventListener('click', () => $('leaveModal').classList.add('hidden'));
$('koStay').addEventListener('click', hideKo);
$('koExit').addEventListener('click', exitToLobby);
$('leaveBtn').addEventListener('click', async () => {
  leaving = true;
  send({ t: 'leave' });
  app.ws?.close?.();
  if (hosting) await hosting.close();
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

$('signInBtn').addEventListener('click', () => openAuth('login'));
$('profileBtn').addEventListener('click', openProfile);
$('profileBack').addEventListener('click', () => showScreen(profileReturn));
$('authClose').addEventListener('click', () => $('authModal').classList.add('hidden'));
$('authModal').addEventListener('click', (e) => { if (e.target === $('authModal')) $('authModal').classList.add('hidden'); });
for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => openAuth(t.dataset.tab));
$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('authSubmit').disabled = true;
  try {
    const res = await rpc(authMode === 'login' ? 'bw_login' : 'bw_signup', { p_username: $('authUser').value, p_password: $('authPass').value });
    account.token = res.token;
    account.profile = res.profile;
    local.set('bw_auth', res.token);
    $('authModal').classList.add('hidden');
    $('authPass').value = '';
    renderAccount();
    toast(authMode === 'signup' ? `Welcome, ${res.profile.username}! Your trophies and badges will be saved.` : `Welcome back, ${res.profile.username}!`);
  } catch (err) {
    $('authError').textContent = err.message;
    $('authError').classList.remove('hidden');
  } finally {
    $('authSubmit').disabled = false;
  }
});
$('signOutBtn').addEventListener('click', async () => {
  try { await rpc('bw_logout', { p_token: account.token }); } catch { /* already signed out */ }
  signOutLocally();
  renderAccount();
  toast('Signed out. You can keep playing as a guest.');
});
// Measure round-trip time so shots can be lag-compensated.
setInterval(() => send({ t: 'ping', ts: performance.now() }), 2000);

renderMute();
buildCards();
buildModeCards();
refreshAccount();
loadArt().then((ok) => { if (ok) { buildCards(); renderLobby(); } });

// Opened an invite link? Prefill the code. Refreshed mid-game? Rejoin the same seat.
const params = new URLSearchParams(location.search);
const linkCode = (params.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
if (linkCode) {
  $('codeInput').value = linkCode;
  if (session.get('bw_room') === linkCode && app.token) { app.code = linkCode; enterRoom('join', linkCode); }
  else setTimeout(() => ($('nameInput').value ? $('codeInput') : $('nameInput')).focus(), 50);
}
showScreen('home');
requestAnimationFrame(frame);
