// Daily Vercel Cron: a tiny read keeps the free Supabase project from pausing after a week without traffic.
import { SUPABASE_URL, SUPABASE_KEY } from '../public/config.js';

export default async function handler(req, res) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/bw_leaderboard`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: '{}',
  });
  res.status(r.ok ? 200 : 502).json({ ok: r.ok });
}
