// Optional player accounts: sign-up / sign-in, sessions, and turning match results into
// trophies, lifetime stats and badges. Guests can always play without one.
import crypto from 'node:crypto';
import { BADGES, emptyStats, trophyDelta, badgeEarned } from '../shared/badges.js';

const SESSION_DAYS = 60;
const USERNAME = /^[A-Za-z0-9_]{3,14}$/;

const hash = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');

function mergeStats(saved) {
  const s = emptyStats();
  if (!saved) return s;
  for (const [k, v] of Object.entries(saved)) {
    if (k === 'byMode' || k === 'byBrawler') for (const [kk, vv] of Object.entries(v)) s[k][kk] = { ...s[k][kk], ...vv };
    else s[k] = v;
  }
  return s;
}

export function publicProfile(p) {
  return { username: p.username, trophies: p.trophies, stats: mergeStats(p.stats), badges: p.badges ?? {}, created_at: p.created_at };
}

export class Accounts {
  constructor(store) {
    this.store = store;
  }

  async newSession(player) {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
    await this.store.createSession(token, player.id, expires);
    return { token, profile: publicProfile(player) };
  }

  async signup(username, password) {
    username = String(username ?? '').trim();
    password = String(password ?? '');
    if (!USERNAME.test(username)) throw new UserError('Usernames are 3-14 letters, numbers or _.');
    if (password.length < 6 || password.length > 72) throw new UserError('Passwords need at least 6 characters.');
    if (await this.store.findByName(username)) throw new UserError('That username is taken.');
    const salt = crypto.randomBytes(16).toString('hex');
    const player = await this.store.create({
      username, username_lower: username.toLowerCase(), pass_hash: hash(password, salt), salt,
      trophies: 0, stats: emptyStats(), badges: {},
    });
    return this.newSession(player);
  }

  async login(username, password) {
    const player = await this.store.findByName(String(username ?? '').trim());
    const ok = player && crypto.timingSafeEqual(Buffer.from(hash(String(password ?? ''), player.salt), 'hex'), Buffer.from(player.pass_hash, 'hex'));
    if (!ok) throw new UserError('Wrong username or password.');
    return this.newSession(player);
  }

  async logout(token) {
    if (token) await this.store.deleteSession(String(token));
  }

  // Returns the player for a session token, or null for guests / expired sessions.
  async resolve(token) {
    if (!token || typeof token !== 'string' || token.length > 128) return null;
    const s = await this.store.getSession(token);
    if (!s || new Date(s.expires_at) < new Date()) return null;
    return this.store.findById(s.player_id);
  }

  async profile(username) {
    const p = await this.store.findByName(String(username ?? ''));
    return p ? publicProfile(p) : null;
  }

  async leaderboard() {
    const rows = await this.store.top(20);
    return rows.map((p) => ({ username: p.username, trophies: p.trophies, wins: p.stats?.wins ?? 0 }));
  }

  // m: { mode, brawler, won, draw, rank, kills, deaths, supers, crates, gemsCollected, maxGemsHeld, starsStolen, bestSteal, hauntKOs, humans }
  async recordMatch(playerId, m) {
    const p = await this.store.findById(playerId);
    if (!p) return null;
    const s = mergeStats(p.stats);
    s.matches++;
    s[m.won ? 'wins' : 'losses']++;
    s.kills += m.kills;
    s.deaths += m.deaths;
    s.supers += m.supers;
    s.crates += m.crates;
    s.gems += m.gemsCollected;
    s.stars += m.starsStolen;
    s.hauntKOs += m.hauntKOs;
    s.streak = m.won ? s.streak + 1 : 0;
    s.bestStreak = Math.max(s.bestStreak, s.streak);
    s.byMode[m.mode].played++;
    if (m.won) s.byMode[m.mode].wins++;
    const bs = s.byBrawler[m.brawler];
    bs.played++;
    bs.kills += m.kills;
    if (m.won) bs.wins++;
    const before = p.trophies ?? 0;
    const trophies = Math.max(0, before + trophyDelta(m));
    const badges = { ...(p.badges ?? {}) };
    const fresh = [];
    for (const b of BADGES) {
      if (badges[b.id] || !badgeEarned(b, s, trophies, m)) continue;
      badges[b.id] = new Date().toISOString();
      fresh.push({ id: b.id, icon: b.icon, name: b.name });
    }
    await this.store.update(p.id, { stats: s, trophies, badges });
    return { delta: trophies - before, trophies, newBadges: fresh };
  }
}

export class UserError extends Error {}
