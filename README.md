# Pixel Battle (CSSD 315)

Pixel Battle is a real-time multiplayer pixel-art application for the GCTU open day. Players join one of four teams and draw together on a shared raster canvas. The server validates and applies drawing actions, tracks each pixel's colour separately from its owning team, and synchronizes board changes over WebSockets.

The normal canvas is 128 x 128 pixels. The server accepts larger square canvases through configuration, but the currently inspected browser and course tests are centered on 128 x 128.

## Modes

### Normal Battle

Players compete for team-owned pixels. A pixel's team ownership is independent of its drawing colour; overwriting a pixel transfers ownership and updates the pixel scoreboard. When the challenge timer ends, the team with the most owned pixels wins; equal scores are announced as a draw. Normal Battle retains the regular toolset and pixel-based scoreboard.

### Build a House Challenge

Build a House is a timed, server-scored challenge. All four teams receive the same challenge duration and are evaluated only in their assigned zones. The host can choose this mode in the host panel; selecting it sets the duration field to 10 minutes, which remains editable. The server controls the actual timer and refuses to start this mode if team zones are disabled.

The 100-mark rubric is:

| Category | Marks |
|---|---:|
| House: four walls | 15 |
| House: triangular roof | 15 |
| House: door | 10 |
| House: two windows | 10 |
| House: circular sun | 10 |
| Algorithms: DDA | 10 |
| Algorithms: Bresenham | 10 |
| Algorithms: Midpoint Circle | 10 |
| Algorithms: Scan-Line Polygon Fill | 5 |
| Algorithms: Flood Fill | 5 |

The server evaluates accepted drawing actions and their surviving pixels, not just the selected tool. Players see their own team's live mark total, checklist, item status, and hints. An authorized host can see all four live scores. At completion, everyone receives the final team breakdowns and rankings; equal top scores are shown as a draw. Undo and Redo change the board and cause the evaluator to recalculate.

## Install and run locally

Requirements: Node.js 18 or later and npm.

```sh
npm ci
npm start
```

By default, the server listens on port **4000** and prints its Wi-Fi address. Open `http://localhost:4000` on the host machine, or use the printed address from another device on the same network. The browser uses WebSocket or secure WebSocket according to the page protocol.

### Host panel and authorization

Open the application with `/?host` (for example `http://localhost:4000/?host`) to reveal the host controls. This URL parameter only reveals the interface; it does not authorize host actions or score access.

Enter the configured `ADMIN_KEY` in the host panel. Use **Authorize live scores** to send the key in the server's WebSocket `watch` message. The server authorizes the socket and rechecks authorization when sending all-team House scores. Starting either mode also sends the selected mode and key in the authenticated `admin` message. Without `ADMIN_KEY`, the server permits host operations only for direct loopback connections; remote clients must use a configured key.

Choose **Normal Battle** or **Build a House** from the mode selector, set the duration in minutes, and select **Start challenge**. The host panel defaults to Normal Battle for five minutes; selecting Build a House sets the duration to ten minutes. The server accepts durations from 5 seconds to 60 minutes and runs the timer authoritatively. Starting a challenge resets the active board and archives the preceding action log. The host's Reset Battle control clears the current battle and returns the mode to idle.

Never put the host key in a URL or commit it to source control.

## Drawing tools, algorithms, and controls

| Tool | Raster algorithm | Availability |
|---|---|---|
| Pen | Connected pointer samples joined with Bresenham | Normal Battle and House |
| Line | Bresenham line | Normal Battle and House |
| DDA | Digital Differential Analyzer line | Running House Challenge only; shortcut `6` |
| Circle | Midpoint Circle; optional filled disc | Normal Battle and House |
| Polygon | Scan-Line fill and Bresenham outline | Normal Battle and House |
| Bucket | Queue-based, 4-connected Flood Fill | Normal Battle and House |
| Eraser | Fixed 5-pixel circular brush stroke | Normal Battle and House |

DDA is hidden in the normal interface and is also implemented in the Algorithm Lab. The server rejects DDA drawing outside a running House Challenge. Drawing limits are enforced by the rasterizer, including a 700-pixel shape limit, a circle radius limit of 20, a maximum of 8 polygon points, and a 1,500-pixel fill limit.

No drawing tool is selected on join. With no tool active, users can navigate the board without placing pixels. Shortcuts `1`–`5` select Pen, Line, Circle, Polygon, and Bucket respectively; `6` selects DDA only during a running House Challenge, and `E` selects Eraser. Erasing is submitted as a shared action, clears pixel ownership, and can be undone or redone. Use the palette to choose among 16 colours and four team colours. Undo and Redo affect your own actions (`Ctrl+Z`, `Ctrl+Shift+Z` or `Ctrl+Y`); they preserve later multiplayer edits. Drag/pan, pinch, wheel zoom, Fit, Export PNG, the in-game team selector, and the time-lapse replay are also available.

The 128 x 128 canvas is divided into four equal quadrants: Red top-left, Blue top-right, Green bottom-left, and Yellow (Gold in the palette) bottom-right. When zones are enabled, the server enforces each player's assigned zone; bucket fill is clipped to that zone. House Challenge requires zones to be enabled.

## Configuration

These are the configuration variables read by `server.js`:

| Variable | Default | Effect |
|---|---:|---|
| `PORT` | `4000` | HTTP and WebSocket listen port |
| `CANVAS_SIZE` | `128` | Square canvas size; must be an integer of at least 128 |
| `COOLDOWN_MS` | `5000` | Per-player drawing cooldown in milliseconds; must be non-negative |
| `DATA_DIR` | `./data` | Action log and House result storage directory |
| `ADMIN_KEY` | unset | Required for remote host controls; without it, only direct loopback host requests are authorized |
| `ZONES` | enabled | Set exactly to `0` to disable team zones; House Challenge will then be refused |
| `CHALLENGE_SECS` | `300` | Default challenge duration in seconds when no duration is supplied |

The active action log is `DATA_DIR/actions.ndjson`; resets archive the previous log. Completed House Challenges are written best-effort to `DATA_DIR/challenge-result-<timestamp>.json`. A write failure does not prevent the in-memory challenge result from being finalized or broadcast.

## Deploy to Render

The repository's `render.yaml` defines a Render Node web service using `npm ci` and `npm start`, sets `NODE_ENV=production` and `DATA_DIR=/var/data`, generates `ADMIN_KEY`, and mounts a 1 GB persistent disk at `/var/data`. The Blueprint specifies Render's `starter` plan. A persistent disk is needed if action logs and House result files must survive service restarts; verify current Render pricing and plan availability before deployment.

After deployment, open the service's public HTTPS URL. The client uses secure WebSockets automatically. To operate the host panel, open `<service-url>/?host` and enter the generated `ADMIN_KEY` from the service environment settings. Do not expose the key in the URL or in screenshots.

## Testing

Run these commands from the repository root:

| Command | What it verifies |
|---|---|
| `npm test` | The five original suites: rasterizer, board/history, real-server WebSocket behavior, reset/archive behavior, and Normal Battle challenge behavior |
| `node tests/dda.test.js` | DDA rasterization inputs, endpoints, line directions/slopes, zero-length lines, limits, and invalid input |
| `node tests/house.test.js` | House evaluator reference score, all four zones, ordering determinism, rubric details, partial/waiting states, ties, tolerances, flood fill, and Undo/Redo |
| `node tests/house-server.test.js` | Real-server House protocol, DDA restrictions, score visibility, host-watch authorization, timer/finalization, result writing/failure, and House DDA log replay |
| `node tests/eraser.test.js` | Eraser brush rasterization, local pixel clearing, team ownership, and Undo/Redo |
| `node tests/eraser-server.test.js` | Real-WebSocket erasing, multiplayer synchronization, team scoring/zones, Undo/Redo, and House score recalculation |
| `node tests/normal_battle_golden.test.js` | Deterministic real-WebSocket Normal Battle transcript against its fixture |
| `npm run test:server` | Existing standalone real-server WebSocket tests |
| `npm run test:reset` | Existing reset and archive tests |
| `npm run test:challenge` | Existing team-zone, pixel scoring, and server challenge timer tests |
| `npm run test:browser` | Browser interaction test in Chromium; requires Python 3, Playwright for Python, and its Chromium browser installation |

`npm test` intentionally does not include the separate DDA, House evaluator/server, eraser, or golden transcript tests; run those explicitly as shown.

### Optional simulated load test

The load-test tool simulates WebSocket clients, reports message latency, and checks that their final canvases match a late joiner's snapshot. This is not a substitute for testing 15 real simultaneous participants on the class network.

Start the server with a low test cooldown in one terminal:

```sh
COOLDOWN_MS=1000 DATA_DIR=./data-test PORT=4001 npm start
```

In another terminal:

```sh
URL=ws://localhost:4001 npm run loadtest -- 15 30
```

On PowerShell, set the variable with `$env:URL = "ws://localhost:4001"` before running the load test. Record the actual output; no load-test result is claimed here.

## Course evidence still required

The application features and automated tests above do not establish that the course's presentation and evidence requirements have been completed. The team still needs to gather and submit:

- **At least 15 simultaneous players:** run and document a live test with the required number of actual participants. The simulated load test is supplementary evidence, not proof of 15 human players.
- **Mobile and laptop testing:** test the deployed or local application on actual phones and laptops, including drawing, pan/zoom, Undo/Redo, host actions, and House Challenge behavior. Record device/browser details and results.
- **Screenshots and demo video:** capture the finished application, both modes, relevant controls, and a complete challenge/result flow. Avoid including host keys or other secrets.
- **Weekly build diary:** add dated entries describing work, decisions, testing, blockers, and progress for each project week.
- **Member contribution table:** have the project team document each member's actual contributions and supporting evidence. No member assignments are inferred in this README.
- **AI-use declaration:** disclose the AI assistance actually used, its scope, and how the team reviewed and validated generated work, according to course policy. The team should review and complete the declaration.

Do not mark these items complete until the evidence has been gathered and reviewed by the team.

## Project files

```text
server.js                 Node.js HTTP/WebSocket server and authoritative game state
public/index.html         Game page and interface structure
public/app.js             Browser UI, drawing controls, networking, and replay
public/style.css          Responsive interface styles
public/raster.js          Shared rasterizers and action validation
public/board.js            Shared board ownership and Undo/Redo history
public/palette.js          Shared palette and team definitions
lib/house-config.js        House rubric and evaluator thresholds
lib/house-evaluator.js     Server-side Build a House scoring
tests/                    Raster, board, server, reset, challenge, DDA, House, and golden transcript tests
tools/loadtest.js          Simulated WebSocket load test
render.yaml               Render service and persistent disk configuration
```
