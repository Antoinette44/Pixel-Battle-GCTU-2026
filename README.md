# Pixel Battle (CSSD 315, Brief 1)

A live multiplayer pixel canvas for the GCTU open day. Everybody on the Wi-Fi opens one link on a phone or laptop,
joins one of four teams and paints on a shared **128 x 128** canvas. All shapes are rasterized by **our own code**
(`public/raster.js`): no canvas `lineTo / arc / fill` is used anywhere.

## Run it

```bash
npm ci               # installs the locked runtime dependency: ws
npm start            # http://localhost:3000   (also prints the Wi-Fi address, e.g. http://192.168.1.20:3000)
npm test             # raster, board, live WebSocket, reset and challenge tests
npm run test:server  # end-to-end test: starts the real server and real websocket clients
npm run test:reset   # reset, archive and replay behavior
npm run test:challenge # zone, scoring and server challenge timer behavior
npm run test:browser # real Chromium test (needs: pip install playwright && playwright install chromium)
npm run demo         # starts the server with a saved battle loaded, to show the replay any time
```

Phones on the same Wi-Fi open the "on the Wi-Fi" address printed in the terminal.
For the online class activity, deploy to Render / Railway (see below) and share the public link.

Options (environment variables): `PORT` (default 3000), `COOLDOWN_MS` (default 5000),
`CANVAS_SIZE` (default 128), `DATA_DIR` (default `./data`), and `ADMIN_KEY` (required for remote host controls).
The HTTP server binds to `0.0.0.0`; the browser chooses `ws://` or `wss://` from the page protocol.

**Team zones and challenge timer.** The canvas is split into four quadrants (Red top-left, Blue top-right, Green bottom-left, Gold bottom-right); the server only accepts drawing inside the player's own zone (`ZONES=0` turns this off). Open `/?host`, enter `ADMIN_KEY` in the host panel, set the minutes (default 5, or `CHALLENGE_SECS`) and press *Start challenge*. On a local server with no `ADMIN_KEY`, host controls are limited to local connections. Admin commands are authenticated over the WebSocket; HTTP GET reset/start endpoints are intentionally disabled so keys are not exposed in URLs. Starting archives the old log and clears the canvas. Tests: `npm run test:challenge`.

## How it meets the brief

| # | Requirement | Where |
|---|-------------|-------|
| 1 | Shared canvas >= 128x128, own `setPixel` only | `raster.js: setPixel`; the frame buffer is a `Uint8Array` of palette indices. Canvas elements only blit the finished buffer (`putImageData` / `drawImage`). |
| 2 | Pen, line (Bresenham), circle (midpoint), polygon (scan-line), bucket (queue flood fill) | `raster.js: bresenham, midpointCircle/circle, fillPolygon, floodFill`. Pen pointer strokes join sampled points with Bresenham; DDA is included too (Algorithm lab). |
| 3 | Real-time sync, new player gets the canvas | `server.js` broadcasts every action; the `init` message sends the whole grid on join and on reconnect. |
| 4 | 16-colour HSB palette + team colours | `palette.js` (hand-written HSB<->RGB). The UI shows H, S, B, RGB and HEX for the selected colour and in the "Palette sheet" table. Colours 16-19 are team colours. |
| 5 | Cooldown + live team scoreboard | Cooldown is enforced on the **server** per player id (5 s). The scoreboard counts pixels of each team colour, updated on every change. |
| 6 | Time-lapse replay from a stored action log | Every action is appended to `DATA_DIR/actions.ndjson` (`./data/actions.ndjson` by default). The Replay section loads `/api/log` and re-runs the same rasterizers; speed control, scrubber, video recording. |
| 7 | Touch + laptop, 15+ players tested | Pointer events: pen drag = connected stroke; other one-finger drags pan; pinch / wheel = zoom. `tools/loadtest.js` simulates N players. |
| + | Stretch | Zoom/pan viewport, export PNG, replay recorded as .webm video, **undo/redo your own actions** (buttons, Ctrl+Z and Ctrl+Shift+Z / Ctrl+Y). |

### How undo/redo works (public/board.js)
* The board remembers, for every pixel, **which action painted it last** and what was there before.
* "Undo" removes your last drawing that is still active. A pixel only goes back if it is **still yours**: if another player painted over it
  afterwards, their pixel stays (fair play). Redo restores only pixels that still have the state left behind by the undo, so it also
  preserves later multiplayer edits. New drawings clear that player's redo history. Undo/redo actions have a 0.5 s anti-spam gap and do
  not refund the drawing cooldown.
* Undo and redo are written to the action log as `{tool:'undo'|'redo', ref:n}`, and replay uses the same `board.js`, so the time-lapse
  always equals the live canvas. Score changes are calculated only for pixels that actually change.
* The log stores a short one-way hash of the player id (`u`), never the secret id, so undo/redo history survives a server restart.

### Design decisions you should be able to explain
* **The server is the authority.** Clients send an *action* (`tool + points + colour`), not pixels. The server runs the same
  `raster.js`, validates the resulting pixels and team-zone limits, and records the action. The same function replays the log, so replay = live result.
* **Limits keep the battle fair:** max 700 pixels per shape, circle radius <= 20, polygon <= 8 corners,
  bucket region <= 1500 pixels (one bucket cannot wipe the canvas). Change them in `LIMITS` at the top of `raster.js`.
* **Action ordering:** drawing, undo and redo messages require strictly increasing per-connection sequence numbers; duplicate and out-of-order requests are rejected.
* **First-time help:** a five-step tour starts for players who have not finished it. Finish persists in local storage; Skip does not. Help / Tutorial can restart the tour.
* **UI palette:** the interface uses navy `#003366`, slate `#36454F`, teal `#01F9C6`, and canvas beige `#E9E0C9`, with Montserrat / Open Sans web fonts and local fallbacks.
* **y = 0 is the top row** in memory (like image files). The lecture uses bottom-left; the algorithms are identical, the picture is flipped.
* **Flood fill is 4-connected and queue-based** (no recursion), as on slide 19.
* Wire format is JSON; the grid is a 16 384-character string of base-36 digits (1 char per pixel).

## Load test (requirement 7)

```bash
COOLDOWN_MS=1000 DATA_DIR=./data-test PORT=3111 npm start        # terminal 1
URL=ws://localhost:3111 npm run loadtest -- 25 30                # terminal 2: 25 bots for 30 s
```
It reports broadcast latency (p50/p95/max) and checks that every bot's canvas equals the snapshot a brand-new player receives.
Our run (25 bots, 20 s, same machine, ~20% of turns are undo): p95 latency 3 ms, 25/25 canvases identical.
**Repeat it on the real class Wi-Fi with real phones and put your own numbers in the report.**

## Deploy to Render

1. Push this repo to GitHub.
2. In Render, create a Blueprint from the repository. `render.yaml` creates **one** Node Web Service, runs `npm ci` / `npm start`, generates `ADMIN_KEY`, and mounts a 1 GB persistent disk at `/var/data`.
3. This disk-backed Blueprint uses Render's paid `starter` instance plan; persistent disks are not available on the free plan. If deploying manually, attach a persistent disk, set `DATA_DIR=/var/data`, and use the same path for its mount point. Do not treat Render's default filesystem as persistent.
4. Share the `https://....onrender.com` link. The frontend connects to the same service over `wss://` automatically. To operate host controls, open `https://....onrender.com/?host` and enter the generated `ADMIN_KEY` (available in the Render service's environment settings). Never put the key in a URL.

Locally, the action log remains in `data/actions.ndjson`. On Render, all active and archived logs are stored under the mounted disk. Reset archives the old battle and atomically replaces the active log, so a restart replays only the current battle. The `/health` endpoint reports a failing status if action-log storage becomes unavailable. Optional exports can still be downloaded with `URL=https://<your-app>.onrender.com npm run backup-log`.

## Files

```
server.js            Node + ws server: cooldown, scoreboard, action log, static files
public/index.html    game page          public/style.css   responsive styles
public/app.js        client: viewport, tools, palette, network, replay
public/raster.js     OUR rasterizers (shared by browser + server)
public/palette.js    HSB palette (shared)
public/board.js      frame buffer + pixel owners + undo/redo (shared by server, replay, tests)
public/lab.html      Algorithm lab: step tables for DDA / Bresenham / midpoint (use in your presentation)
tests/*.test.js      unit + server tests   tests/browser_test.py  real-browser test
tools/loadtest.js    load test             tools/backup-log.js, demo.js, make-demo-log.js   keep / replay a battle
samples/             saved battle logs (sample-small = test players, demo-battle = SYNTHETIC demo, add your real one)
render.yaml          single-service Render Blueprint with persistent action-log disk
```

## Git

```bash
git init && git add . && git commit -m "Initial project skeleton"
git remote add origin <your GitHub/GitLab URL> && git push -u origin main
```
Every member commits under their own name (`git config user.name` / `user.email`), in different weeks.
