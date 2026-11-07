/* server.js - Pixel Battle server (Node.js + ws).
   * Serves the web app from /public
   * Keeps the authoritative frame buffer, the action log and the scoreboard
   * Enforces the per-player cooldown and broadcasts every change in real time.
   Run:  npm install && npm start      (default http://localhost:3000)             */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const R = require('./public/raster.js');
const B = require('./public/board.js');
const P = require('./public/palette.js');

const PORT = +process.env.PORT || 3000;
const SIZE = process.env.CANVAS_SIZE === undefined ? 128 : Number(process.env.CANVAS_SIZE);
if (!Number.isSafeInteger(SIZE) || SIZE < 128) throw new RangeError('CANVAS_SIZE must be an integer of at least 128');
const COOLDOWN_MS = process.env.COOLDOWN_MS !== undefined ? +process.env.COOLDOWN_MS : 5000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ZONES = process.env.ZONES !== '0';                                  // players may only draw in their own team zone
const CHALLENGE_SECS = +process.env.CHALLENGE_SECS > 0 ? +process.env.CHALLENGE_SECS : 300;   // default 5 minutes
const MIN_CHALLENGE_SECS = 5, MAX_CHALLENGE_SECS = 3600;
const LOG_FILE = path.join(DATA_DIR, 'actions.ndjson');

/* ---------------- state ---------------- */
let board = B.create(SIZE, SIZE, P.BG);          // frame buffer + pixel owners + undo history (public/board.js)
let log = [];                                   // action log (used for the time-lapse); undo is logged too
let scores = P.TEAMS.map(() => 0);              // pixels per team colour
let mine = new Map();                           // player key -> log positions of that player's drawings (for undo)

const colourToTeam = new Map(P.TEAMS.map(t => [t.colour, t.id]));
const nextAllowed = new Map();                  // player id -> time the next action is allowed
const nextUndo = new Map();                     // player id -> time the next undo is allowed (anti-spam)
const UNDO_GAP_MS = 500;
const teamOf = new Map();                       // player id -> team (the team stays with the player's session)

/* ---------------- challenge timer (server-controlled) ----------------
   The server owns the clock. It uses a monotonic timer (not the wall clock) and sends clients only the REMAINING time,
   so a player's browser clock can never change the result.  state: 'idle' | 'running' | 'ended'                      */
const mono = () => Number(process.hrtime.bigint() / 1000000n);
let ch = { state: 'idle', durMs: CHALLENGE_SECS * 1000, endsAt: 0, final: null, winners: [] };
let chTimer = null, chTick = null;
const remainingMs = () => ch.state === 'running' ? Math.max(0, ch.endsAt - mono()) : 0;
const chOver = () => ch.state === 'ended' || (ch.state === 'running' && mono() >= ch.endsAt);
const chInfo = () => ({ t: 'ch', state: ch.state, dur: ch.durMs, rem: remainingMs(), final: ch.final, winners: ch.winners });

// A short one-way hash of the player id goes into the public log, so undo survives a server restart
// without revealing the secret id that the player uses to identify themselves.
const playerKey = (id) => crypto.createHash('sha256').update(id).digest('hex').slice(0, 12);

// changes = [[index, oldColour, newColour], ...]
function countChanges(changes) {
  for (const [, oldC, newC] of changes) {
    if (colourToTeam.has(oldC)) scores[colourToTeam.get(oldC)]--;
    if (colourToTeam.has(newC)) scores[colourToTeam.get(newC)]++;
  }
}

// Remember who made / undid an action so that "undo my last action" works.
function track(entry, n) {
  if (!entry.u) return;
  const list = mine.get(entry.u) || [];
  if (entry.tool === 'undo') { const k = list.indexOf(entry.ref); if (k >= 0) list.splice(k, 1); }
  else list.push(n);
  mine.set(entry.u, list);
}
const undoable = (key) => (mine.get(key) || []).length;

function loadLog() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LOG_FILE)) return;
  for (const line of fs.readFileSync(LOG_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      const n = log.length;
      const res = B.apply(board, e, n);          // same code path as live play => identical canvas
      if (res.error) continue;
      countChanges(res.changes);
      e.n = n;
      log.push(e);
      track(e, n);
    } catch (_) { /* skip a damaged line */ }
  }
  console.log(`Loaded ${log.length} actions from ${LOG_FILE}`);
}
loadLog();
let logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

const gridString = () => Array.from(board.fb.data, v => v.toString(36)).join('');

function finishChallenge() {
  if (ch.state !== 'running') return;
  clearTimeout(chTimer); clearInterval(chTick);
  ch.state = 'ended';
  ch.final = scores.slice();                                     // frozen: nothing can be drawn any more
  const best = Math.max(...ch.final);
  ch.winners = ch.final.map((s, i) => [s, i]).filter(([s]) => s === best).map(([, i]) => i);   // 2+ winners = draw
  broadcast(chInfo());
}
function startChallenge(secs) {
  secs = Math.min(MAX_CHALLENGE_SECS, Math.max(MIN_CHALLENGE_SECS, Math.round(Number(secs) || CHALLENGE_SECS)));
  resetBattle();                                                 // fair start: empty canvas, scores 0 (old log is archived)
  ch = { state: 'running', durMs: secs * 1000, endsAt: mono() + secs * 1000, final: null, winners: [] };
  chTimer = setTimeout(finishChallenge, secs * 1000);
  chTick = setInterval(() => broadcast(chInfo()), 5000);         // periodic re-sync of the remaining time
  broadcast(chInfo());
}
function isAdmin(key, req) {
  if (ADMIN_KEY) {
    const h = (s) => crypto.createHash('sha256').update(String(s || '')).digest();
    return crypto.timingSafeEqual(h(key), h(ADMIN_KEY));
  }
  const a = req && req.socket && req.socket.remoteAddress;       // no key configured: only the host machine itself
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

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
  if (url.pathname === '/admin/start') {
    if (!isAdmin(url.searchParams.get('key'), req)) { res.writeHead(403); return res.end('forbidden'); }
    startChallenge(url.searchParams.get('secs'));
    res.writeHead(200); return res.end('challenge started');
  }
  if (url.pathname === '/admin/reset') {
    if (!ADMIN_KEY || url.searchParams.get('key') !== ADMIN_KEY) { res.writeHead(403); return res.end('forbidden'); }
    resetBattle();
    res.writeHead(200); return res.end('battle reset');
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  const relativePath = path.relative(PUBLIC, file);
  if (
    relativePath.startsWith('..') ||
    path.isAbsolute(relativePath)
  ) {
    res.writeHead(403);
    return res.end('forbidden');
  }
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
  send(ws, { t: 'init', size: SIZE, grid: gridString(), scores, online: onlineCount(), cooldown: COOLDOWN_MS, wait, actions: log.length, undo: undoable(playerKey(ws.player.id)), team: ws.player.team, zones: ZONES, ch: chInfo() });
}

function resetBattle() {
  try { logStream.end(); fs.renameSync(LOG_FILE, path.join(DATA_DIR, `actions-${Date.now()}.ndjson`)); } catch (_) {}
  logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  board = B.create(SIZE, SIZE, P.BG);
  log = [];
  scores = P.TEAMS.map(() => 0);
  mine = new Map();
  nextAllowed.clear();
  nextUndo.clear();
  clearTimeout(chTimer); clearInterval(chTick);
  ch = { state: 'idle', durMs: ch.durMs, endsAt: 0, final: null, winners: [] };
  for (const c of wss.clients) if (c.player) sendInit(c);
}

const cleanName = (s) => String(s || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16) || 'Player';

wss.on('connection', (ws, req) => {
  ws.player = null;
  ws.alive = true;
  ws.lastSeq = 0;
  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data); } catch (_) { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'hello') {
      if (typeof m.id !== 'string' || !/^[\w-]{8,64}$/.test(m.id)) return;
      const asked = Number.isInteger(m.team) && m.team >= 0 && m.team < P.TEAMS.length ? m.team : 0;
      const team = teamOf.has(m.id) ? teamOf.get(m.id) : asked;   // a returning player keeps the team the server knows
      teamOf.set(m.id, team);
      ws.player = { id: m.id, name: cleanName(m.name), team };
      sendInit(ws);
      broadcast({ t: 'online', n: onlineCount() });
      return;
    }
    if (!ws.player) return;

    if (m.t === 'admin') {
      if (!isAdmin(m.key, req)) return send(ws, { t: 'adm', ok: false, msg: 'Host key required' });
      if (m.cmd === 'start') { startChallenge(m.secs); return send(ws, { t: 'adm', ok: true, msg: 'Challenge started' }); }
      if (m.cmd === 'reset') { resetBattle(); return send(ws, { t: 'adm', ok: true, msg: 'Battle reset' }); }
      return;
    }

    if ((m.t === 'act' || m.t === 'undo') && chOver()) {
      finishChallenge();                                                      // make sure the end is announced
      return send(ws, { t: 'rej', seq: m.seq, reason: 'The challenge is over', wait: 0 });
    }

    if (m.t === 'act' || m.t === 'undo') {
      if (!Number.isSafeInteger(m.seq) || m.seq < 1 || m.seq <= ws.lastSeq) {
        return send(ws, { t: 'rej', seq: m.seq, reason: 'Invalid or out-of-order action sequence', wait: 0 });
      }
      ws.lastSeq = m.seq;
    }

    if (m.t === 'team') {
      const ok = Number.isInteger(m.team) && m.team >= 0 && m.team < P.TEAMS.length;
      if (ch.state === 'running') return send(ws, { t: 'team', ok: false, team: ws.player.team, reason: 'You cannot change team during a challenge' });
      if (!ok) return send(ws, { t: 'team', ok: false, team: ws.player.team, reason: 'Unknown team' });
      ws.player.team = m.team; teamOf.set(ws.player.id, m.team);
      return send(ws, { t: 'team', ok: true, team: m.team });
    }

    if (m.t === 'act') {
      const now = Date.now();
      const allowedAt = nextAllowed.get(ws.player.id) || 0;
      if (now < allowedAt) return send(ws, { t: 'rej', seq: m.seq, reason: 'Cooldown: wait a moment', wait: allowedAt - now });
      const v = R.normalise(m, board.fb, P.NUM);
      if (v.error) return send(ws, { t: 'rej', seq: m.seq, reason: v.error, wait: 0 });
      const a = v.action;
      const team = ws.player.team;
      if (ZONES) {
        // The bucket fill is CLIPPED to the player's zone (and must start inside it); every other tool must stay inside.
        if (a.tool === 'fill') {
          if (B.zoneTeam(SIZE, a.pts[0][0], a.pts[0][1]) !== team) return send(ws, { t: 'rej', seq: m.seq, reason: 'Tap inside your own team zone', wait: 0 });
          a.clip = B.zoneRect(SIZE, team);
        }
      }
      // Dry run: rasterize() only works out WHICH pixels would change (it writes nothing), so we can refuse first.
      const dry = R.rasterize(board.fb, a);
      if (dry.error) return send(ws, { t: 'rej', seq: m.seq, reason: dry.error, wait: 0 });
      if (ZONES && a.tool !== 'fill' && dry.idx.some(i => B.zoneTeam(SIZE, i % SIZE, (i / SIZE) | 0) !== team))
        return send(ws, { t: 'rej', seq: m.seq, reason: 'You can only draw inside your own team zone', wait: 0 });
      if (!dry.idx.some(i => board.fb.data[i] !== a.c)) return send(ws, { t: 'rej', seq: m.seq, reason: 'Nothing would change', wait: 0 });

      const n = log.length, key = playerKey(ws.player.id);
      const entry = { n, ts: now, p: ws.player.name, u: key, tm: ws.player.team, tool: a.tool, pts: a.pts, c: a.c, f: a.f };
      if (a.clip) entry.clip = a.clip;                 // logged so the replay fills exactly the same pixels
      const res = B.apply(board, entry, n);
      if (res.error) return send(ws, { t: 'rej', seq: m.seq, reason: res.error, wait: 0 });

      nextAllowed.set(ws.player.id, now + COOLDOWN_MS);
      countChanges(res.changes);
      log.push(entry); track(entry, n);
      logStream.write(JSON.stringify(entry) + '\n');

      broadcast({ t: 'px', n, ts: now, p: entry.p, tm: entry.tm, tool: a.tool, c: a.c,
                  idx: res.changes.map(ch => ch[0]), sc: scores });
      send(ws, { t: 'ok', seq: m.seq, wait: COOLDOWN_MS, pixels: res.changes.length, undo: undoable(key) });
      return;
    }

    if (m.t === 'undo') {
      const now = Date.now(), key = playerKey(ws.player.id);
      if (now < (nextUndo.get(ws.player.id) || 0)) return send(ws, { t: 'rej', seq: m.seq, reason: 'Slow down a little', wait: 0 });
      const list = mine.get(key) || [];
      if (!list.length) return send(ws, { t: 'rej', seq: m.seq, reason: 'You have nothing to undo', wait: 0 });
      nextUndo.set(ws.player.id, now + UNDO_GAP_MS);

      const n = log.length;
      const entry = { n, ts: now, p: ws.player.name, u: key, tm: ws.player.team, tool: 'undo', ref: list[list.length - 1] };
      const res = B.apply(board, entry, n);
      if (res.error) return send(ws, { t: 'rej', seq: m.seq, reason: res.error, wait: 0 });

      countChanges(res.changes);
      log.push(entry); track(entry, n);
      logStream.write(JSON.stringify(entry) + '\n');

      // every restored pixel can have a different colour, so send one colour per pixel
      broadcast({ t: 'px', n, ts: now, p: entry.p, tm: entry.tm, tool: 'undo',
                  idx: res.changes.map(ch => ch[0]), cols: res.changes.map(ch => ch[2]), sc: scores });
      send(ws, { t: 'undone', seq: m.seq, pixels: res.changes.length, undo: undoable(key) });
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
