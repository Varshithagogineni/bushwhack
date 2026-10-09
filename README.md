# Bushwhack

A real-time multiplayer battle royale for up to 6 players. Friends join from any phone or laptop with a 4-letter room code: no login, no install.

## How to play

- **Survive.** Last brawler alive wins the round.
- **Poison closes in** from the edges after 20 seconds. Stay inside the circle.
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

## How it stays in sync

- One Node.js server runs the authoritative simulation at 30 ticks/second and sends each player a snapshot every tick (about 400 bytes).
- Your own brawler is predicted locally with the same movement code as the server (`shared/game.js`), then reconciled against the server, so controls feel instant.
- Everyone else is drawn 100 ms in the past, interpolated between snapshots, so motion is smooth even on shaky connections.
- The server decides who can see whom (bushes), so hidden players are never sent to opponents.
- Dropped phones can rejoin the same seat within 30 seconds (refresh-safe).

## Run locally

```bash
npm install
npm start          # http://localhost:3000
```

Phones on the same Wi-Fi can join via `http://<your-computer-ip>:3000`.

## Deploy

Any host that runs a long-lived Node process with WebSockets works. `render.yaml` deploys it to Render's free tier.
`.github/workflows/keep-awake.yml` pings the server every 10 minutes so the free instance never goes to sleep; set the repo variable `GAME_URL` to your Render URL to turn it on.
