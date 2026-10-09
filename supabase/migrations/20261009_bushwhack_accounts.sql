-- Bushwhack: optional player accounts, trophies, stats and badges.
-- Tables are locked (RLS on, no policies); the game only reaches them through the security-definer functions below.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  username_lower text not null unique,
  pass_hash text not null,
  trophies integer not null default 0,
  stats jsonb not null default '{}'::jsonb,
  badges jsonb not null default '{}'::jsonb,
  failed_logins integer not null default 0,
  locked_until timestamptz,
  last_match_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.sessions (
  token text primary key,
  player_id uuid not null references public.players (id) on delete cascade,
  expires_at timestamptz not null
);

create index if not exists players_trophies_idx on public.players (trophies desc);
create index if not exists sessions_player_idx on public.sessions (player_id);

alter table public.players enable row level security;
alter table public.sessions enable row level security;
revoke all on public.players, public.sessions from anon, authenticated;

create or replace function public.bw_empty_stats() returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'matches', 0, 'wins', 0, 'losses', 0, 'kills', 0, 'deaths', 0, 'supers', 0, 'crates', 0, 'gems', 0,
    'stars', 0, 'hauntKOs', 0, 'streak', 0, 'bestStreak', 0,
    'byMode', jsonb_build_object(
      'showdown', jsonb_build_object('played', 0, 'wins', 0),
      'gemgrab', jsonb_build_object('played', 0, 'wins', 0),
      'bounty', jsonb_build_object('played', 0, 'wins', 0)),
    'byBrawler', jsonb_build_object(
      'brick', jsonb_build_object('played', 0, 'wins', 0, 'kills', 0),
      'vex', jsonb_build_object('played', 0, 'wins', 0, 'kills', 0),
      'boom', jsonb_build_object('played', 0, 'wins', 0, 'kills', 0)));
$$;

create or replace function public.bw_profile_json(p public.players) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('username', p.username, 'trophies', p.trophies, 'stats', public.bw_empty_stats() || p.stats,
                            'badges', p.badges, 'created_at', p.created_at);
$$;

create or replace function public.bw_new_session(pid uuid) returns text language plpgsql security definer set search_path = '' as $$
declare tok text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  insert into public.sessions (token, player_id, expires_at) values (tok, pid, now() + interval '60 days');
  return tok;
end $$;

create or replace function public.bw_session_player(p_token text) returns public.players language sql stable security definer set search_path = '' as $$
  select p.* from public.sessions s join public.players p on p.id = s.player_id
  where s.token = p_token and s.expires_at > now();
$$;

create or replace function public.bw_signup(p_username text, p_password text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.players;
begin
  p_username := trim(coalesce(p_username, ''));
  if p_username !~ '^[A-Za-z0-9_]{3,14}$' then raise exception 'Usernames are 3-14 letters, numbers or _.'; end if;
  if length(coalesce(p_password, '')) < 6 or length(p_password) > 72 then raise exception 'Passwords need at least 6 characters.'; end if;
  if exists (select 1 from public.players where username_lower = lower(p_username)) then raise exception 'That username is taken.'; end if;
  insert into public.players (username, username_lower, pass_hash, stats)
  values (p_username, lower(p_username), extensions.crypt(p_password, extensions.gen_salt('bf', 8)), public.bw_empty_stats())
  returning * into p;
  return jsonb_build_object('token', public.bw_new_session(p.id), 'profile', public.bw_profile_json(p));
end $$;

create or replace function public.bw_login(p_username text, p_password text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.players;
begin
  select * into p from public.players where username_lower = lower(trim(coalesce(p_username, '')));
  if p.id is not null and p.locked_until > now() then raise exception 'Too many tries. Wait a few minutes.'; end if;
  if p.id is null or extensions.crypt(coalesce(p_password, ''), p.pass_hash) <> p.pass_hash then
    if p.id is not null then
      update public.players set failed_logins = failed_logins + 1,
        locked_until = case when failed_logins + 1 >= 8 then now() + interval '5 minutes' else locked_until end
      where id = p.id;
    end if;
    raise exception 'Wrong username or password.';
  end if;
  update public.players set failed_logins = 0, locked_until = null where id = p.id;
  return jsonb_build_object('token', public.bw_new_session(p.id), 'profile', public.bw_profile_json(p));
end $$;

create or replace function public.bw_me(p_token text) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare p public.players := public.bw_session_player(p_token);
begin
  if p.id is null then raise exception 'Signed out.'; end if;
  return public.bw_profile_json(p);
end $$;

create or replace function public.bw_logout(p_token text) returns void language sql security definer set search_path = '' as $$
  delete from public.sessions where token = p_token;
$$;

create or replace function public.bw_leaderboard() returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('username', username, 'trophies', trophies, 'wins', coalesce((stats->>'wins')::int, 0))
                            order by trophies desc, created_at), '[]'::jsonb)
  from (select * from public.players order by trophies desc, created_at limit 20) t;
$$;

create or replace function public.bw_profile(p_username text) returns jsonb language sql stable security definer set search_path = '' as $$
  select public.bw_profile_json(p) from public.players p where username_lower = lower(p_username);
$$;

create or replace function public.bw_inc(j jsonb, path text[], amount int) returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_set(j, path, to_jsonb(coalesce((j #>> path)::int, 0) + amount));
$$;

-- Records one finished match for the signed-in player: lifetime stats, Brawl Stars-style trophies, new badges.
-- Mirrors shared/badges.js. Values are clamped and a 25 s cooldown stops replays.
create or replace function public.bw_record_match(p_token text, m jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p public.players := public.bw_session_player(p_token);
  s jsonb;
  mode text := m->>'mode';
  brawler text := m->>'brawler';
  won boolean := coalesce((m->>'won')::boolean, false);
  draw boolean := coalesce((m->>'draw')::boolean, false);
  rnk int := greatest(1, least(6, coalesce((m->>'rank')::int, 6)));
  kills int := greatest(0, least(50, coalesce((m->>'kills')::int, 0)));
  deaths int := greatest(0, least(50, coalesce((m->>'deaths')::int, 0)));
  supers int := greatest(0, least(50, coalesce((m->>'supers')::int, 0)));
  crates int := greatest(0, least(20, coalesce((m->>'crates')::int, 0)));
  gems int := greatest(0, least(100, coalesce((m->>'gemsCollected')::int, 0)));
  max_gems int := greatest(0, least(100, coalesce((m->>'maxGemsHeld')::int, 0)));
  stars int := greatest(0, least(200, coalesce((m->>'starsStolen')::int, 0)));
  best_steal int := greatest(0, least(7, coalesce((m->>'bestSteal')::int, 0)));
  haunts int := greatest(0, least(10, coalesce((m->>'hauntKOs')::int, 0)));
  humans int := greatest(1, least(6, coalesce((m->>'humans')::int, 1)));
  delta int;
  before int;
  after int;
  new_badges jsonb := '[]'::jsonb;
  b record;
begin
  if p.id is null then raise exception 'Signed out.'; end if;
  if mode not in ('showdown', 'gemgrab', 'bounty') or brawler not in ('brick', 'vex', 'boom') then raise exception 'Bad match.'; end if;
  if p.last_match_at > now() - interval '25 seconds' then raise exception 'Match already recorded.'; end if;

  s := public.bw_empty_stats() || p.stats;
  s := public.bw_inc(s, '{matches}', 1);
  s := public.bw_inc(s, case when won then '{wins}'::text[] else '{losses}'::text[] end, 1);
  s := public.bw_inc(s, '{kills}', kills);
  s := public.bw_inc(s, '{deaths}', deaths);
  s := public.bw_inc(s, '{supers}', supers);
  s := public.bw_inc(s, '{crates}', crates);
  s := public.bw_inc(s, '{gems}', gems);
  s := public.bw_inc(s, '{stars}', stars);
  s := public.bw_inc(s, '{hauntKOs}', haunts);
  s := jsonb_set(s, '{streak}', to_jsonb(case when won then coalesce((s->>'streak')::int, 0) + 1 else 0 end));
  s := jsonb_set(s, '{bestStreak}', to_jsonb(greatest(coalesce((s->>'bestStreak')::int, 0), (s->>'streak')::int)));
  s := public.bw_inc(s, array['byMode', mode, 'played'], 1);
  s := public.bw_inc(s, array['byMode', mode, 'wins'], case when won then 1 else 0 end);
  s := public.bw_inc(s, array['byBrawler', brawler, 'played'], 1);
  s := public.bw_inc(s, array['byBrawler', brawler, 'wins'], case when won then 1 else 0 end);
  s := public.bw_inc(s, array['byBrawler', brawler, 'kills'], kills);

  delta := case
    when mode = 'showdown' then (array[10, 7, 4, 1, -2, -4])[rnk]
    when mode = 'bounty' then (array[8, 5, 2, 0, -2, -3])[rnk]
    when won then 8 when draw then 0 else -3 end;
  before := p.trophies;
  after := greatest(0, before + delta);

  for b in select * from (values
    ('first_ko', (s->>'kills')::int >= 1),
    ('first_win', (s->>'wins')::int >= 1),
    ('survivor', (s#>>'{byMode,showdown,wins}')::int >= 1),
    ('gem_champ', (s#>>'{byMode,gemgrab,wins}')::int >= 1),
    ('bounty_hunter', (s#>>'{byMode,bounty,wins}')::int >= 1),
    ('hat_trick', kills >= 3),
    ('rampage', kills >= 5),
    ('gem_hoarder', max_gems >= 10),
    ('big_score', best_steal >= 5),
    ('spooky', (s->>'hauntKOs')::int >= 1),
    ('smasher', (s->>'crates')::int >= 25),
    ('super_user', (s->>'supers')::int >= 25),
    ('on_fire', (s->>'bestStreak')::int >= 3),
    ('veteran', (s->>'matches')::int >= 25),
    ('brick_master', (s#>>'{byBrawler,brick,wins}')::int >= 5),
    ('vex_master', (s#>>'{byBrawler,vex,wins}')::int >= 5),
    ('boom_master', (s#>>'{byBrawler,boom,wins}')::int >= 5),
    ('party', humans >= 4),
    ('rising_star', after >= 100),
    ('legend', after >= 500)
  ) as t(id, earned) loop
    if b.earned and not (p.badges ? b.id) then
      p.badges := p.badges || jsonb_build_object(b.id, now());
      new_badges := new_badges || jsonb_build_array(jsonb_build_object('id', b.id));
    end if;
  end loop;

  update public.players set stats = s, trophies = after, badges = p.badges, last_match_at = now() where id = p.id;
  return jsonb_build_object('delta', after - before, 'trophies', after, 'newBadges', new_badges);
end $$;

-- Only the public functions are callable from the browser; internal helpers are locked down.
revoke execute on all functions in schema public from public;
revoke execute on function public.bw_new_session(uuid), public.bw_session_player(text), public.bw_empty_stats(),
  public.bw_profile_json(public.players), public.bw_inc(jsonb, text[], int) from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from anon, authenticated, public;
grant execute on function public.bw_signup(text, text), public.bw_login(text, text), public.bw_me(text), public.bw_logout(text),
  public.bw_leaderboard(), public.bw_profile(text), public.bw_record_match(text, jsonb) to anon, authenticated;
