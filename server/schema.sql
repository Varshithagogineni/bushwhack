-- Bushwhack accounts schema for Supabase (run once in the SQL editor).
-- The game server talks to these tables with the service key; nothing is exposed to browsers directly.

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  username_lower text not null unique,
  pass_hash text not null,
  salt text not null,
  trophies integer not null default 0,
  stats jsonb not null default '{}'::jsonb,
  badges jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.sessions (
  token text primary key,
  player_id uuid not null references public.players (id) on delete cascade,
  expires_at timestamptz not null
);

create index if not exists players_trophies_idx on public.players (trophies desc);
create index if not exists sessions_player_idx on public.sessions (player_id);

-- Only the server (service role) may read or write; browsers never get table access.
alter table public.players enable row level security;
alter table public.sessions enable row level security;
