/* server.js - Pixel Battle server (Node.js + ws).
   * Serves the web app from /public
   * Keeps the authoritative frame buffer, the action log and the scoreboard
   * Enforces the per-player cooldown and broadcasts every change in real time.
   Run:  npm install && npm start      (default http://localhost:3000)             */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const R = require('./public/raster.js');
const P = require('./public/palette.js');

const PORT = +process.env.PORT || 3000;
const SIZE = +process.env.CANVAS_SIZE || 128;
const COOLDOWN_MS = process.env.COOLDOWN_MS !== undefined ? +process.env.COOLDOWN_MS : 5000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const LOG_FILE = path.join(DATA_DIR, 'actions.ndjson');

/* ---------------- state ---------------- */
let fb = R.createFB(SIZE, SIZE, P.BG);
let log = [];                                   // action log (used for the time-lapse)
let scores = P.TEAMS.map(() => 0);              // pixels per team colour
const colourToTeam = new Map(P.TEAMS.map(t => [t.colour, t.id]));
const nextAllowed = new Map();                  // player id -> time the next action is allowed

function countChanges(changes, newColour) {
  for (const [, old] of changes) {
    if (colourToTeam.has(old)) scores[colourToTeam.get(old)]--;
    if (colourToTeam.has(newColour)) scores[colourToTeam.get(newColour)]++;
  }
}

function loadLog() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LOG_FILE)) return;
  for (const line of fs.readFileSync(LOG_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      const res = R.applyAction(fb, e);          // same code path => identical canvas
      if (res.error) continue;
      countChanges(res.changes, e.c);
      log.push(e);
    } catch (_) { /* skip a damaged line */ }
  }
  console.log(`Loaded ${log.length} actions from ${LOG_FILE}`);
}
loadLog();
let logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

const gridString = () => Array.from(fb.data, v => v.toString(36)).join('');

/* ---------------- HTTP (static files + small API) ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
               '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const PUBLIC = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/log') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ size: SIZE, log }));
  }
  if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
  if (url.pathname === '/admin/reset') {
    if (!ADMIN_KEY || url.searchParams.get('key') !== ADMIN_KEY) { res.writeHead(403); return res.end('forbidden'); }
    resetBattle();
    res.writeHead(200); return res.end('battle reset');
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

/* ---------------- WebSocket ---------------- */
const wss = new WebSocketServer({ server, maxPayload: 8192 });

const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const broadcast = (obj) => { const s = JSON.stringify(obj); for (const c of wss.clients) if (c.readyState === 1 && c.player) c.send(s); };
const onlineCount = () => { let n = 0; for (const c of wss.clients) if (c.player && c.readyState === 1) n++; return n; };

function sendInit(ws) {
  const wait = Math.max(0, (nextAllowed.get(ws.player.id) || 0) - Date.now());
  send(ws, { t: 'init', size: SIZE, grid: gridString(), scores, online: onlineCount(), cooldown: COOLDOWN_MS, wait, actions: log.length });
}

function resetBattle() {
  try { logStream.end(); fs.renameSync(LOG_FILE, path.join(DATA_DIR, `actions-${Date.now()}.ndjson`)); } catch (_) {}
  logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  fb = R.createFB(SIZE, SIZE, P.BG);
  log = [];
  scores = P.TEAMS.map(() => 0);
  nextAllowed.clear();
  for (const c of wss.clients) if (c.player) sendInit(c);
}

const cleanName = (s) => String(s || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16) || 'Player';

wss.on('connection', (ws) => {
  ws.player = null;
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data); } catch (_) { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'hello') {
      if (typeof m.id !== 'string' || !/^[\w-]{8,64}$/.test(m.id)) return;
      const team = Number.isInteger(m.team) && m.team >= 0 && m.team < P.TEAMS.length ? m.team : 0;
      ws.player = { id: m.id, name: cleanName(m.name), team };
      sendInit(ws);
      broadcast({ t: 'online', n: onlineCount() });
      return;
    }
    if (!ws.player) return;

    if (m.t === 'team') {
      if (Number.isInteger(m.team) && m.team >= 0 && m.team < P.TEAMS.length) ws.player.team = m.team;
      return;
    }

    if (m.t === 'act') {
      const now = Date.now();
      const allowedAt = nextAllowed.get(ws.player.id) || 0;
      if (now < allowedAt) return send(ws, { t: 'rej', seq: m.seq, reason: 'Cooldown: wait a moment', wait: allowedAt - now });
      const v = R.normalise(m, fb, P.NUM);
      if (v.error) return send(ws, { t: 'rej', seq: m.seq, reason: v.error, wait: 0 });
      const a = v.action;
      const res = R.applyAction(fb, a);
      if (res.error) return send(ws, { t: 'rej', seq: m.seq, reason: res.error, wait: 0 });
      if (res.changes.length === 0) return send(ws, { t: 'rej', seq: m.seq, reason: 'Nothing would change', wait: 0 });

      nextAllowed.set(ws.player.id, now + COOLDOWN_MS);
      countChanges(res.changes, a.c);
      const entry = { n: log.length, ts: now, p: ws.player.name, tm: ws.player.team, tool: a.tool, pts: a.pts, c: a.c, f: a.f };
      log.push(entry);
      logStream.write(JSON.stringify(entry) + '\n');

      broadcast({ t: 'px', n: entry.n, ts: now, p: entry.p, tm: entry.tm, tool: a.tool, c: a.c,
                  idx: res.changes.map(ch => ch[0]), sc: scores });
      send(ws, { t: 'ok', seq: m.seq, wait: COOLDOWN_MS, pixels: res.changes.length });
    }
  });

  ws.on('close', () => { if (ws.player) broadcast({ t: 'online', n: onlineCount() }); });
  ws.on('error', () => {});
});

// drop dead connections (phones that left the Wi-Fi)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; ws.ping();
  }
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Pixel Battle running on http://localhost:${PORT}  (canvas ${SIZE}x${SIZE}, cooldown ${COOLDOWN_MS} ms)`);
  const nets = require('os').networkInterfaces();
  for (const list of Object.values(nets)) for (const n of list) if (n.family === 'IPv4' && !n.internal) console.log(`  on the Wi-Fi:  http://${n.address}:${PORT}`);
});
