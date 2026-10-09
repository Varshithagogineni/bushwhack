// Player accounts and login sessions.
// Uses Supabase (Postgres) when SUPABASE_URL and SUPABASE_SERVICE_KEY are set, so data survives restarts on
// hosts with throwaway disks; otherwise a JSON file in ./data for local play. See server/schema.sql.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export function createStore(root) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  return url && key ? supabaseStore(url.replace(/\/$/, ''), key) : fileStore(path.join(root, 'data', 'accounts.json'));
}

// ---------- local JSON file ----------

function fileStore(file) {
  let db = null;
  let saveTimer = null;
  const load = async () => {
    if (db) return db;
    try { db = JSON.parse(await readFile(file, 'utf8')); } catch { db = { players: {}, sessions: {} }; }
    return db;
  };
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(db));
      await rename(tmp, file);
    }, 300);
  };
  return {
    kind: 'file',
    async findByName(name) {
      const d = await load();
      return Object.values(d.players).find((p) => p.username_lower === name.toLowerCase()) ?? null;
    },
    async findById(id) { return (await load()).players[id] ?? null; },
    async create(player) {
      const d = await load();
      const p = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...player };
      d.players[p.id] = p;
      save();
      return p;
    },
    async update(id, fields) {
      const d = await load();
      Object.assign(d.players[id], fields);
      save();
    },
    async createSession(token, playerId, expiresAt) {
      (await load()).sessions[token] = { player_id: playerId, expires_at: expiresAt };
      save();
    },
    async getSession(token) { return (await load()).sessions[token] ?? null; },
    async deleteSession(token) { delete (await load()).sessions[token]; save(); },
    async top(limit) {
      return Object.values((await load()).players).sort((a, b) => b.trophies - a.trophies).slice(0, limit);
    },
  };
}

// ---------- Supabase (PostgREST over fetch, no extra dependencies) ----------

function supabaseStore(url, key) {
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const req = async (method, route, body, prefer) => {
    const res = await fetch(`${url}/rest/v1/${route}`, {
      method, headers: prefer ? { ...headers, Prefer: prefer } : headers, body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Supabase ${method} ${route.split('?')[0]}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
  const one = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);
  const enc = encodeURIComponent;
  return {
    kind: 'supabase',
    async findByName(name) { return one(await req('GET', `players?username_lower=eq.${enc(name.toLowerCase())}&select=*`)); },
    async findById(id) { return one(await req('GET', `players?id=eq.${enc(id)}&select=*`)); },
    async create(player) { return one(await req('POST', 'players', player, 'return=representation')); },
    async update(id, fields) { await req('PATCH', `players?id=eq.${enc(id)}`, fields, 'return=minimal'); },
    async createSession(token, playerId, expiresAt) {
      await req('POST', 'sessions', { token, player_id: playerId, expires_at: expiresAt }, 'return=minimal');
    },
    async getSession(token) { return one(await req('GET', `sessions?token=eq.${enc(token)}&select=player_id,expires_at`)); },
    async deleteSession(token) { await req('DELETE', `sessions?token=eq.${enc(token)}`, null, 'return=minimal'); },
    async top(limit) { return req('GET', `players?select=username,trophies,stats&order=trophies.desc&limit=${limit}`); },
  };
}
