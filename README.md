# Bushwhack

A real-time multiplayer battle royale for up to 6 players. Friends join from any phone or laptop with a 4-letter room code: no login, no install.

## How to play

- **Survive.** Last brawler alive wins the round.
- **Poison closes in** from the edges after 20 seconds. Stay inside the circle.
- **Bushes hide you** from anyone who isn't right next to you, until you shoot.
- **Power cubes** (green boxes) give +400 health and +10% damage. Knocked-out brawlers drop theirs.
- **Ammo** (3 bars under you) refills on its own. Health regenerates after 3 seconds out of combat.

| Brawler | Role | Attack |
|---|---|---|
| Brick | Tank | Short-range 5-pellet shotgun, 5800 HP |
| Vex | Sharpshooter | Long-range single shot, 3000 HP |
| Boom | Thrower | Bomb lobbed over walls with splash damage, 3400 HP |

**Laptop:** WASD / arrows to move · mouse to aim · click to shoot (hold for auto-fire) · Space to auto-aim
**Phone:** left thumb drags to move · right thumb drags to aim and releases to shoot · tap the right side to auto-aim

The host can add bots, so two people (or one) can start a match right away.

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
