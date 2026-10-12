-- Three new brawlers (Melo, Kit, Tink): accept their matches and track their stats.
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
      'boom', jsonb_build_object('played', 0, 'wins', 0, 'kills', 0),
      'melo', jsonb_build_object('played', 0, 'wins', 0, 'kills', 0),
      'kit', jsonb_build_object('played', 0, 'wins', 0, 'kills', 0),
      'tink', jsonb_build_object('played', 0, 'wins', 0, 'kills', 0)));
$$;

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
  if mode not in ('showdown', 'gemgrab', 'bounty') or brawler not in ('brick', 'vex', 'boom', 'melo', 'kit', 'tink') then raise exception 'Bad match.'; end if;
  if p.last_match_at > now() - interval '25 seconds' then raise exception 'Match already recorded.'; end if;

  s := public.bw_empty_stats() || p.stats;
  -- Older profiles predate some brawlers: make sure this brawler's entry exists before counting.
  s := jsonb_set(s, array['byBrawler', brawler], coalesce(s #> array['byBrawler', brawler], '{"played":0,"wins":0,"kills":0}'::jsonb));
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

revoke execute on function public.bw_empty_stats() from public, anon, authenticated;
grant execute on function public.bw_record_match(text, jsonb) to anon, authenticated;
