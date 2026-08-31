# Blob Arena

Pair one or more phones to a desktop browser via QR code, stream each phone's
tilt (`DeviceOrientationEvent`) over a WebSocket relay, and drive a growing
gelatin **blob** per player on the desktop.

## Gameplay (desktop, `public/host.html`)

Each phone controls a wobbly, translucent blob. The goal: grow the most and be
the **first to burst** — the first blob to reach 62.5× its starting area explodes
and **wins** the round.

- **Grow by bumping.** When two player blobs collide, **both** grow 35% (by area,
  each only if it was actually moving — idle blobs don't grow). Confetti flies in
  a mix of both blobs' colors and both phones buzz. Player blobs only ever grow —
  they never shrink from bumping each other.
- **Eat the lime NPCs.** ~20 lime-green NPC blobs roam and bounce around (more on
  larger screens, scaling with screen area up to 50). Bump one **while you're
  moving** and it **pops** (you grow 25%); it respawns 5 seconds later. An idle
  blob can't pop NPCs (or win a bump) — you just bounce off.
- **Watch for bombs.** Every other time an NPC is popped it respawns as a **dark-red
  bomb** (starting with the first pop) that **slowly chases the nearest player**,
  blinking bright red. It **explodes after 3 seconds** — or the instant a player
  enters its blast radius (a bomb that spawns on top of a player won't trigger until
  they leave and re-enter). Any player caught in the blast is cut to half its size
  (never below its starting size). Then it returns as a normal lime NPC.
- **Sound.** The desktop plays a bump sound when players collide, a pop when a
  player eats an NPC, and a bang when a bomb goes off (from `public/sound/*.mp3`).
- **Obstacles.** Blobs bounce off the walls and off the QR panel. Squash on
  impact, jiggle at rest, stretch when fast.
- The bottom-left **Leaderboard** ranks players by rounds won and shows each
  player's name (truncated past 12 characters) and progress bar toward bursting
  (log-scaled so it advances evenly per hit). Once the first round finishes, a
  **win ratio** — wins over the total
  rounds played this session (same denominator for everyone, e.g. `1/2`) — appears
  to the right of each bar. Each blob is also labelled with its player's name on
  the field.
- **Personalize on the phone.** The controller (styled "JELLYBUMP") shows a tilt
  guide, your color, your name, and your own growth bar.
  Tap the color circle to pick a color (lime is reserved for NPCs); tap the name
  or pencil to rename yourself (default "Player 1", "Player 2", …). Both update
  live on the desktop.
- **Sleep-proof.** The phone keeps the screen awake (Screen Wake Lock) so it
  doesn't lock mid-game. If it drops anyway (manual lock, a call, a network blip),
  it silently **reconnects into the same blob** — growth, name, and color intact,
  no QR rescan. The desktop holds a disconnected player's blob (dimmed, 💤) for a
  60s grace window before giving up; a phone that returns after that rejoins as a
  fresh blob (still no rescan). Uses a per-room session token in `localStorage`,
  so even a full page reload lands you back in your blob.
- **Winning.** When someone bursts, every phone leaves the play screen: the winner
  sees a congratulations message + a big **Play Again** button; everyone else sees
  a large circle in the winner's color and who won. The desktop shows the same
  announcement with its own **Play Again** button — either one starts a fresh round
  for all.

Rendering is plain Canvas 2D (shaded, translucent blobs with a consistent
top-left light and soft glow); gameplay constants (`GROW_COLLISION`, `MAX_SCALE`,
`NPC_COUNT`, `BOMB_POPS`, …) are a tunable block near the top of the host script.

**Hold the phone sideways, right edge up.** The controller UI is forced to
landscape (it rotates itself when the device viewport is portrait), so players
turn the phone so its right edge is the top.

**Controls (per phone):** tilt steers your blob like a marble on a tray —
**tip forward → up, back → down, left/right → left/right**. Holding a steady
direction slowly builds speed; changing direction bleeds it off, and a flat
phone coasts to a stop. No calibration needed. Collisions drop confetti (desktop
+ the involved phones) and buzz those phones (Android only — iOS Safari has no
web Vibration API). Each connected phone gets its own color, shown on the phone
and on its blob.

Because a phone held sideways swaps the pitch/roll axes, the controller remaps
them: steering comes from device `beta`, speed from device `gamma`. If a control
feels reversed on your device, flip `STEER_SIGN` / `SPEED_SIGN` at the top of the
controller script. (If you hold the phone left-edge-up instead, or your phone
auto-rotates to the other landscape, controls may invert — hold right-edge-up.)

## Run

```bash
npm install
npm start
```

Server listens on `http://localhost:3000` (override with `PORT`).

- Desktop / host page: `/`
- Phone / controller page: `/controller?room=<code>` (opened by scanning the QR)

## Testing on a phone (HTTPS required)

Motion sensor APIs are blocked on insecure origins, so a phone **cannot** use
`http://localhost` (nor a plain `http://` LAN IP). Expose the server over HTTPS
with a tunnel and open that URL for **both** pages. Cloudflare's `cloudflared`
needs no account:

```bash
cloudflared tunnel --url http://localhost:3000
```

It prints a `https://<random>.trycloudflare.com` URL. (ngrok also works:
`ngrok http 3000`, but it now requires a free account + authtoken.)

1. Open the tunnel's **https** URL's `/` on your desktop. The QR encodes that
   same tunnel host (the server builds it from the request's `Host` header), so
   it's reachable from your phone.
2. Scan the QR with your phone. The QR stays on the desktop (shrunk into the
   corner) so more players can join at any time — or use **Copy Room URL** (appears
   under the QR once someone joins) to share the join link directly.
3. On the phone: **Tap to Start** → grant motion access.
4. Tilt to drive your blob like a marble: tip forward → up, back → down,
   left/right → left/right. Personalize your color/name and watch your growth
   bar; the desktop shows every blob with its name and progress.

> The tunnel URL is regenerated each time you restart `cloudflared`. If you
> restart it, reopen the new URL on the desktop and re-scan.

### Device notes
- **iOS Safari**: motion access requires a user gesture — the "Tap to Start"
  button calls `DeviceOrientationEvent.requestPermission()`. You must be on
  HTTPS or the prompt never appears.
- **Android Chrome**: no permission prompt exists; the code feature-detects
  `requestPermission` and skips it, so the flow still works.

## How it works

- `server.js` — HTTP static server + `ws` WebSocket relay. In-memory room map,
  4-char codes. A room has one host and any number of controllers; the server
  assigns each controller a stable id + color on join and tags relayed `tilt`
  messages with that id. QR is generated server-side with `qrcode`.
- `public/host.html` — desktop: persistent (shrinking) QR card + a full-screen
  canvas running the whole game (blob physics, growth, NPCs, bombs, win/reset).
  Tunable constants (`BASE_SPEED`, `STEER_GAIN`, `GROW_COLLISION`, `MAX_SCALE`,
  `NPC_COUNT`, `BOMB_POPS`, …) live in a block near the top of the script.
- `public/controller.html` — phone (JELLYBUMP): permission gesture, forced-
  landscape UI, throttled (~25 msg/s) tilt streaming (`tx`/`ty`), color picker,
  name editing, growth bar, and win/lose screens, with a `devicemotion`
  gravity-vector fallback if orientation events don't arrive.

## Non-goals
No accounts or persistence, no reconnect-with-state, no production hosting. All
game state lives in the desktop tab; reloading it starts a fresh room and round.
