# Rumble Reef

A real-time multiplayer brawler for up to 6 players, with three Brawl Stars-style modes. Friends join from any phone or laptop with a 4-letter room code: no login, no install.

## Modes

- **☠ Showdown:** every brawler for themselves. Poison closes in from the edges after 30 seconds; last one standing wins. Knocked-out players come back as ghosts (Ghost Mode).
- **💎 Gem Grab:** two teams. Gems spawn from the mine in the middle; a team holding 10+ gems (and more than the other team) for 15 seconds wins. Knocked-out players drop their gems and respawn at their base.
- **⭐ Bounty:** free-for-all with respawns. Knocking someone out steals their stars (2 to 7, growing with your streak). Most stars after 2 minutes wins.

The host picks the mode in the lobby; in Gem Grab, players can switch teams. The arena is a 40×40-tile island with stone walls, bushes, crates and ponds (ponds block walking but not shots).

## How to play

- **Bushes hide you** from anyone who isn't right next to you, until you shoot.
- **Break crates** for power cubes: +400 health and +10% damage each. Knocked-out brawlers drop theirs too.
- **Land hits to charge your Super** (the yellow ring under you), then unleash it.
- **Ghost Mode:** knocked out? You come back as a ghost, float through walls and drop haunts that slow and hurt the survivors. Nobody sits out the rest of the round.
- **Ammo** (3 bars under you) refills on its own. Health regenerates after 3 seconds out of combat.
- **Wins carry over** between rounds in the same room, so friends can play a best-of-5.

| Brawler | Role | Attack | Super |
|---|---|---|---|
| Brick | Tank | Short-range 5-pellet shotgun, 5800 HP | **Bulldoze:** charge forward, smashing enemies and crates |
| Vex | Sharpshooter | Long-range single shot, 3000 HP | **Piercing Volley:** five shots that pass through enemies |
| Boom | Thrower | Bomb lobbed over walls with splash damage, 3400 HP | **Mega Bomb:** a huge bomb with a massive blast |

**Laptop:** WASD / arrows to move · mouse to aim · click to shoot (hold for auto-fire) · Space to auto-aim · E or right-click for Super · 1–4 for emotes
**Phone:** left thumb drags to move · right thumb drags to aim and releases to shoot · tap the right side to auto-aim · SUPER button when charged · 😀 button for emotes

Friends join by scanning the lobby QR code, opening the invite link, or typing the 4-letter code.

The host can add bots, so two people (or one) can start a match right away.

## Art pipeline

Everything you see is modelled in code with Blender and rendered live in the browser with Three.js:

- `tools/blender/build_assets.py` builds the brawlers, props and island (and renders 2D sprite fallbacks).
- `tools/blender/export_models.py` exports them as glTF models with generated textures, plus the island's colour map and water mask.
- `public/render3d.js` draws the real-time scene: sun and soft shadows, animated water with caustics and surf, swaying grass, poison gas, 3D projectiles and explosions. Devices without WebGL fall back to the sprite renderer.

```bash
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/blender/export_models.py -- public/models
```

## Accounts, trophies and badges (optional)

Guests can always play straight away. Signing in (username + password, bcrypt-hashed in Postgres) saves trophies
(Brawl Stars-style: up for wins and high placements, down for losses), wins/losses, knockouts and streaks per mode and
per brawler, and 20 badges, shown on the Profile page with a leaderboard. Accounts live in Supabase; the browser can
only call the `bw_*` database functions (see `supabase/`).

## How it works (100% free tier: Vercel + Supabase)

- **No game server.** The room creator's browser runs the authoritative match (`shared/room.js`) in a Web Worker at
  30 ticks/second. Everyone else connects **directly** to it over WebRTC data channels: an unreliable lane for
  snapshots and inputs (no head-of-line stalls) and a reliable lane for everything else.
- **Supabase Realtime is only the phone book:** the 4-letter room code is a channel used for the WebRTC handshake.
  If a network blocks direct connections, traffic falls back to a 15 Hz relay through the same channel.
- **Vercel** serves the static game (`npm run build` → `dist/`) and runs a daily cron that keeps the free Supabase
  project awake.
- Your own movement is predicted locally with the same physics as the host (`shared/game.js`) and reconciled;
  everyone else is drawn 80 ms in the past, interpolated between snapshots. Your shots appear instantly and the host
  fast-forwards them by your measured lag, so what you saw hit is what counts. The host decides who can see whom
  (bushes), so hidden players are never sent to opponents.

The host's tab must stay open: if the host leaves, the room closes and everyone returns to the home screen.

## Run locally

```bash
npm install
npm start          # http://localhost:3000  (static dev server; multiplayer still uses Supabase for the handshake)
npm run build      # what Vercel deploys, in dist/
```

Live: https://rumblereef.vercel.app (also https://bushwhack.vercel.app)

