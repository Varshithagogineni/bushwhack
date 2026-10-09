# Supabase setup

The game's accounts (trophies, stats, badges, leaderboard) live in a free Supabase project.
The browser can only call the `bw_*` database functions; both tables have row level security on with no policies,
and internal helpers are not executable by `anon`/`authenticated`.

To recreate the project, run the migrations in `migrations/` in order (SQL editor or `supabase db push`), then put the
project URL and publishable key in `public/config.js`.

Realtime (public broadcast + presence channels named `bw-<ROOM CODE>`) is used only as the matchmaking "phone book"
for the peer-to-peer connections and as a low-rate relay when a direct connection is blocked.
