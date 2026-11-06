# Pixel Battle (CSSD 315, Brief 1)

A live multiplayer pixel canvas for the GCTU open day. Everybody on the Wi-Fi opens one link on a phone or laptop,
joins one of four teams and paints on a shared **128 x 128** canvas. All shapes are rasterized by **our own code**
(`public/raster.js`): no canvas `lineTo / arc / fill` is used anywhere.

## Run it

```bash
npm install          # installs the only dependency: ws
npm start            # http://localhost:3000   (also prints the Wi-Fi address, e.g. http://192.168.1.20:3000)
npm test             # unit tests: Week 2 worked examples + undo (public/board.js)
npm run test:server  # end-to-end test: starts the real server and real websocket clients
npm run test:browser # real Chromium test (needs: pip install playwright && playwright install chromium)
npm run demo         # starts the server with a saved battle loaded, to show the replay any time
```

Phones on the same Wi-Fi open the "on the Wi-Fi" address printed in the terminal.
For the online class activity, deploy to Render / Railway (see below) and share the public link.

Options (environment variables): `PORT`, `COOLDOWN_MS` (default 5000), `CANVAS_SIZE` (default 128),
`DATA_DIR` (action log folder), `ADMIN_KEY` (enables `/admin/reset?key=...` to wipe the battle before the show).

## How it meets the brief

| # | Requirement | Where |
|---|-------------|-------|
| 1 | Shared canvas >= 128x128, own `setPixel` only | `raster.js: setPixel`; the frame buffer is a `Uint8Array` of palette indices. Canvas elements only blit the finished buffer (`putImageData` / `drawImage`). |
| 2 | Pen, line (Bresenham), circle (midpoint), polygon (scan-line), bucket (queue flood fill) | `raster.js: bresenham, midpointCircle/circle, fillPolygon, floodFill`. Pen pointer strokes join sampled points with Bresenham; DDA is included too (Algorithm lab). |
| 3 | Real-time sync, new player gets the canvas | `server.js` broadcasts every action; the `init` message sends the whole grid on join and on reconnect. |
| 4 | 16-colour HSB palette + team colours | `palette.js` (hand-written HSB<->RGB). The UI shows H, S, B, RGB and HEX for the selected colour and in the "Palette sheet" table. Colours 16-19 are team colours. |
| 5 | Cooldown + live team scoreboard | Cooldown is enforced on the **server** per player id (5 s). The scoreboard counts pixels of each team colour, updated on every change. |
| 6 | Time-lapse replay from a stored action log | Every action is appended to `data/actions.ndjson`. The Replay section loads `/api/log` and re-runs the same rasterizers; speed control, scrubber, video recording. |
| 7 | Touch + laptop, 15+ players tested | Pointer events: pen drag = connected stroke; other one-finger drags pan; pinch / wheel = zoom. `tools/loadtest.js` simulates N players. |
| + | Stretch | Zoom/pan viewport, export PNG, replay recorded as .webm video, **undo your own actions** (button or Ctrl+Z). |

### How undo works (public/board.js)
* The board remembers, for every pixel, **which action painted it last** and what was there before.
* "Undo" removes your last drawing that is still active. A pixel only goes back if it is **still yours**: if another player painted over it
  afterwards, their pixel stays (fair play). Undoing is not allowed twice, and has a 0.5 s anti-spam gap. It does **not** refund the cooldown.
* An undo is written to the action log as `{tool:'undo', ref:n}`, and the replay uses the same `board.js`, so the time-lapse always equals the live canvas
  (checked by a randomized test and by the browser test, which compares every pixel).
* The log stores a short one-way hash of the player id (`u`), never the secret id, so undo still works after a server restart.

### Design decisions you should be able to explain
* **The server is the authority.** Clients send an *action* (`tool + points + colour`), not pixels. The server runs the same
  `raster.js`, so cheating is impossible and the log is tiny. The same function replays the log, so replay = live result.
* **Limits keep the battle fair:** max 700 pixels per shape, circle radius <= 20, polygon <= 8 corners,
  bucket region <= 1500 pixels (one bucket cannot wipe the canvas). Change them in `LIMITS` at the top of `raster.js`.
* **Action ordering:** drawing and undo messages require strictly increasing per-connection sequence numbers; duplicate and out-of-order requests are rejected.
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

## Deploy for the online class activity (free)

1. Push this repo to GitHub.
2. Render.com -> New -> Blueprint -> pick the repo (`render.yaml` is included), or New -> Web Service with Build `npm install`, Start `npm start`.
3. Share the `https://....onrender.com` link (WebSockets work over `wss://` automatically).
Free hosts sleep when idle (open the link a minute before class) and may erase `data/` on restart.
**Keep the real battle:** `URL=https://<your-app>.onrender.com npm run backup-log` saves the log to `samples/`; commit it to Git.

## Files

```
server.js            Node + ws server: cooldown, scoreboard, action log, static files
public/index.html    game page          public/style.css   responsive styles
public/app.js        client: viewport, tools, palette, network, replay
public/raster.js     OUR rasterizers (shared by browser + server)
public/palette.js    HSB palette (shared)
public/board.js      frame buffer + pixel owners + undo (shared by server, replay, tests)
public/lab.html      Algorithm lab: step tables for DDA / Bresenham / midpoint (use in your presentation)
tests/*.test.js      unit + server tests   tests/browser_test.py  real-browser test
tools/loadtest.js    load test             tools/backup-log.js, demo.js, make-demo-log.js   keep / replay a battle
samples/             saved battle logs (sample-small = test players, demo-battle = SYNTHETIC demo, add your real one)
render.yaml          free deploy on Render     docs/  GIT_PLAN, TEST_SHEET, REPORT_DRAFT, DIARY, screenshots/
docs/DELIVERABLES.md templates: report outline, build diary, contribution table, AI declaration, video script
```

## Git

```bash
git init && git add . && git commit -m "Initial project skeleton"
git remote add origin <your GitHub/GitLab URL> && git push -u origin main
```
Every member commits under their own name (`git config user.name` / `user.email`), in different weeks.
