/* server.js - Pixel Battle server (Node.js + ws).
   * Serves the web app from /public
   * Keeps the authoritative frame buffer, the action log and the scoreboard
   * Enforces the per-player cooldown and broadcasts every change in real time.
   Run:  npm ci && npm start      (default port 3000)                               */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const R = require('./public/raster.js');
const B = require('./public/board.js');
const P = require('./public/palette.js');

const PORT = process.env.PORT === undefined ? 4000 : Number(process.env.PORT);
const SIZE = process.env.CANVAS_SIZE === undefined ? 128 : Number(process.env.CANVAS_SIZE);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new RangeError('PORT must be an integer between 1 and 65535');
if (!Number.isSafeInteger(SIZE) || SIZE < 128) throw new RangeError('CANVAS_SIZE must be an integer of at least 128');
const COOLDOWN_MS = process.env.COOLDOWN_MS === undefined ? 5000 : Number(process.env.COOLDOWN_MS);
if (!Number.isSafeInteger(COOLDOWN_MS) || COOLDOWN_MS < 0) throw new RangeError('COOLDOWN_MS must be a non-negative integer');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ZONES = process.env.ZONES !== '0';                                  // players may only draw in their own team zone
const CHALLENGE_SECS = +process.env.CHALLENGE_SECS > 0 ? +process.env.CHALLENGE_SECS : 300;   // default 5 minutes
const MIN_CHALLENGE_SECS = 5, MAX_CHALLENGE_SECS = 3600;
const LOG_FILE = path.join(DATA_DIR, 'actions.ndjson');
const MAX_LOG_LINE_BYTES = 16 * 1024;

/* ---------------- state ---------------- */
let board = B.create(SIZE, SIZE, P.BG);          // frame buffer + pixel owners + undo/redo history (public/board.js)
let log = [];                                   // action log (used for the time-lapse); undo and redo are logged too
let scores = P.TEAMS.map(() => 0);              // pixels owned by each team, regardless of drawing colour
let mine = new Map();                           // player key -> log positions of that player's drawings (for undo)
let redone = new Map();                         // player key -> drawings currently available to redo
let storageError = null;

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

// changes = [[index, oldColour, newColour, oldTeam, newTeam], ...]
function countChanges(changes) {
  for (const [, , , oldTeam, newTeam] of changes) {
    if (oldTeam >= 0) scores[oldTeam]--;
    if (newTeam >= 0) scores[newTeam]++;
  }
}

// Track active drawings and redo history per player; a new drawing clears only that player's redo stack.
function track(entry, n) {
  if (!entry.u) return;
  const list = mine.get(entry.u) || [];
  const redo = redone.get(entry.u) || [];
  if (entry.tool === 'undo') {
    const k = list.indexOf(entry.ref);
    if (k >= 0) list.splice(k, 1);
    redo.push(entry.ref);
  } else if (entry.tool === 'redo') {
    const k = redo.lastIndexOf(entry.ref);
    if (k >= 0) redo.splice(k, 1);
    list.push(entry.ref);
  } else {
    list.push(n);
    redo.length = 0;
  }
  mine.set(entry.u, list);
  redone.set(entry.u, redo);
}
const undoable = (key) => (mine.get(key) || []).length;
const redoable = (key) => (redone.get(key) || []).length;

function loadLog() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '');
  for (const line of fs.readFileSync(LOG_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      if (Buffer.byteLength(line) > MAX_LOG_LINE_BYTES) throw new Error('line exceeds the size limit');
      const raw = JSON.parse(line);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('entry must be an object');
      if (raw.n !== undefined && raw.n !== log.length) throw new Error('unexpected action index');
      const e = { n: log.length, ts: Number.isFinite(raw.ts) ? raw.ts : Date.now(),
        p: typeof raw.p === 'string' ? raw.p.slice(0, 16) : 'Player',
        u: typeof raw.u === 'string' ? raw.u.slice(0, 64) : '',
        tm: Number.isInteger(raw.tm) && raw.tm >= 0 && raw.tm < P.TEAMS.length ? raw.tm : 0,
        tool: raw.tool };
      if (raw.tool === 'undo' || raw.tool === 'redo') {
        if (!Number.isSafeInteger(raw.ref) || raw.ref < 0 || raw.ref >= log.length) throw new Error(`invalid ${raw.tool} reference`);
        e.ref = raw.ref;
      } else {
        const v = R.normalise(raw, board.fb, P.NUM);
        if (v.error) throw new Error(v.error);
        Object.assign(e, v.action);
        if (raw.clip !== undefined) {
          if (raw.tool !== 'fill' || !Array.isArray(raw.clip) || raw.clip.length !== 4 ||
              !raw.clip.every(Number.isInteger) || raw.clip[0] < 0 || raw.clip[1] < 0 ||
              raw.clip[2] >= SIZE || raw.clip[3] >= SIZE || raw.clip[0] > raw.clip[2] || raw.clip[1] > raw.clip[3])
            throw new Error('invalid fill clip');
          e.clip = raw.clip;
        }
      }
      const n = log.length;
      const res = B.apply(board, e, n);          // same code path as live play => identical canvas
      if (res.error) throw new Error(res.error);
      countChanges(res.changes);
      log.push(e);
      track(e, n);
    } catch (e) {
      storageError = e;
      console.error(`Action log is invalid at entry ${log.length}: ${e.message}; drawing is paused until the host resets the battle`);
      break;
    }
  }
  console.log(`Loaded ${log.length} actions from ${LOG_FILE}`);
}
loadLog();
// Log lines are appended synchronously. A failed write is truncated to its starting offset and pauses play.
function appendEntry(entry) {
  let offset;
  try {
    offset = fs.statSync(LOG_FILE).size;
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
    return { offset };
  } catch (error) {
    if (Number.isSafeInteger(offset)) {
      try { fs.truncateSync(LOG_FILE, offset); }
      catch (truncateError) { console.error('Could not roll back a partial action-log write:', truncateError.message); }
    }
    storageError = error;
    console.error('Action-log write failed; drawing and undo are paused:', error.message);
    return { error };
  }
}
function rollbackEntry(offset) {
  try { fs.truncateSync(LOG_FILE, offset); }
  catch (error) {
    storageError = error;
    console.error('Could not roll back an invalid action-log entry:', error.message);
  }
}

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
  const r = resetBattle();                                       // fair start: empty canvas, scores 0 (old log is archived)
  if (!r.ok) return r;
  ch = { state: 'running', durMs: secs * 1000, endsAt: mono() + secs * 1000, final: null, winners: [] };
  chTimer = setTimeout(finishChallenge, secs * 1000);
  chTick = setInterval(() => broadcast(chInfo()), 5000);         // periodic re-sync of the remaining time
  broadcast(chInfo());
  return { ok: true };
}
function isAdmin(key, req) {
  if (ADMIN_KEY) {
    const h = (s) => crypto.createHash('sha256').update(String(s || '')).digest();
    return crypto.timingSafeEqual(h(key), h(ADMIN_KEY));
  }
  if (req && req.headers && (req.headers['x-forwarded-for'] || req.headers['forwarded'])) return false;   // came through a proxy: not local
  const a = req && req.socket && req.socket.remoteAddress;       // no key configured: only the host machine itself
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/* ---------------- HTTP (static files + small API) ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
               '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const PUBLIC = path.join(__dirname, 'public');

const securityHeaders = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); }
  catch (_) {
    res.writeHead(400, securityHeaders);
    return res.end('bad request');
  }
  const headers = { ...securityHeaders };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...headers, Allow: 'GET, HEAD' });
    return res.end('method not allowed');
  }
  if (url.pathname === '/api/log') {
    res.writeHead(200, { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ size: SIZE, log }));
  }
  if (url.pathname === '/health') {
    res.writeHead(storageError ? 503 : 200, headers);
    return res.end(req.method === 'HEAD' ? undefined : storageError ? 'storage unavailable' : 'ok');
  }
  if (url.pathname === '/admin/start' || url.pathname === '/admin/reset') {
    res.writeHead(404, headers);
    return res.end('not found');
  }
  let rel;
  try { rel = decodeURIComponent(url.pathname); }
  catch (_) {
    res.writeHead(400, headers);
    return res.end('bad request');
  }
  if (rel === '/') rel = '/index.html';
  const file = path.resolve(PUBLIC, `.${rel}`);
  const relativePath = path.relative(PUBLIC, file);
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    res.writeHead(403, headers);
    return res.end('forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, headers); return res.end('not found'); }
    res.writeHead(200, { ...headers, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
});

/* ---------------- WebSocket ---------------- */
const wss = new WebSocketServer({
  server,
  maxPayload: 8192,
  verifyClient: ({ origin, req }) => {
    if (!origin) return true; // Non-browser clients (tests and tools) do not send Origin.
    try { return new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase(); }
    catch (_) { return false; }
  },
});

wss.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Cannot start Pixel Battle: port ${PORT} is already in use.`);
    console.error(`Stop the existing server or set PORT to a different port.`);
  } else {
    console.error('WebSocket server error:', error.message);
  }
});

const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const broadcast = (obj) => {
  const s = JSON.stringify(obj);
  for (const c of wss.clients) if (c.readyState === 1 && c.player) {
    if (c.bufferedAmount > 1024 * 1024) c.terminate();
    else c.send(s);
  }
};
const onlineCount = () => { let n = 0; for (const c of wss.clients) if (c.player && c.readyState === 1) n++; return n; };

function sendInit(ws) {
  const wait = Math.max(0, (nextAllowed.get(ws.player.id) || 0) - Date.now());
  const key = playerKey(ws.player.id);
  const teams = Array.from(board.teams, team => (team + 1).toString(36)).join('');
  send(ws, { t: 'init', size: SIZE, grid: gridString(), teams, scores, online: onlineCount(), cooldown: COOLDOWN_MS, wait, actions: log.length, undo: undoable(key), redo: redoable(key), team: ws.player.team, zones: ZONES, ch: chInfo() });
}

let resetting = false;                           // guard: two resets can never overlap
// Returns { ok:true } or { ok:false, error }. The FILE is changed first; if that fails nothing in memory is touched,
// so the server stays consistent (old canvas, old log, old scores) and the admin is told the reset failed.
function resetBattle() {
  if (resetting) return { ok: false, error: 'A reset is already in progress' };
  resetting = true;
  let tempFile;
  try {
    try {
      if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 0) {
        let stamp = Date.now();
        let archive = path.join(DATA_DIR, `actions-${stamp}.ndjson`);
        while (fs.existsSync(archive)) archive = path.join(DATA_DIR, `actions-${++stamp}.ndjson`);
        fs.copyFileSync(LOG_FILE, archive, fs.constants.COPYFILE_EXCL);
      }
      tempFile = path.join(DATA_DIR, `actions-reset-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
      fs.writeFileSync(tempFile, '', { flag: 'wx' });
      fs.renameSync(tempFile, LOG_FILE);                                      // atomically replace the active battle history
      tempFile = null;
    } catch (e) {
      console.error('Reset failed (log file):', e.message);
      return { ok: false, error: 'Could not clear the action log: ' + e.message };
    }
    storageError = null;
    doReset();
    return { ok: true };
  } finally {
    if (tempFile) {
      try { fs.unlinkSync(tempFile); }
      catch (error) { if (error.code !== 'ENOENT') console.error('Could not remove reset temp file:', error.message); }
    }
    resetting = false;
  }
}
function doReset() {
  board = B.create(SIZE, SIZE, P.BG);
  log = [];
  scores = P.TEAMS.map(() => 0);
  mine = new Map();
  redone = new Map();
  nextAllowed.clear();
  nextUndo.clear();
  clearTimeout(chTimer); clearInterval(chTick);
  ch = { state: 'idle', durMs: ch.durMs, endsAt: 0, final: null, winners: [] };
  broadcast({ t: 'reset' });                       // tell every browser to drop its local battle state ...
  for (const c of wss.clients) if (c.player) sendInit(c);   // ... then send the blank canvas, zero scores, own team + cooldown
}

const cleanName = (s) => (typeof s === 'string' ? s : '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16) || 'Player';

wss.on('connection', (ws, req) => {
  ws.player = null;
  ws.alive = true;
  ws.lastSeq = 0;
  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data); }
    catch (_) { ws.close(1003, 'Messages must be valid JSON'); return; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) { ws.close(1008, 'Invalid message'); return; }

    if (m.t === 'hello') {
      if (ws.player) { ws.close(1008, 'Player identity is already established'); return; }
      if (typeof m.id !== 'string' || !/^[\w-]{8,64}$/.test(m.id)) { ws.close(1008, 'Invalid player identity'); return; }
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
      if (m.cmd === 'start') { const r = startChallenge(m.secs); return send(ws, { t: 'adm', ok: r.ok, msg: r.ok ? 'Challenge started' : r.error }); }
      if (m.cmd === 'reset') { const r = resetBattle(); return send(ws, { t: 'adm', ok: r.ok, msg: r.ok ? 'Battle reset' : r.error }); }
      return;
    }

    if ((m.t === 'act' || m.t === 'undo' || m.t === 'redo') && chOver()) {
      finishChallenge();                                                      // make sure the end is announced
      return send(ws, { t: 'rej', seq: m.seq, reason: 'The challenge is over', wait: 0 });
    }

    if (m.t === 'act' || m.t === 'undo' || m.t === 'redo') {
      if (!Number.isSafeInteger(m.seq) || m.seq < 1 || m.seq <= ws.lastSeq) {
        return send(ws, { t: 'rej', seq: m.seq, reason: 'Invalid or out-of-order action sequence', wait: 0 });
      }
      ws.lastSeq = m.seq;
    }
    if ((m.t === 'act' || m.t === 'undo' || m.t === 'redo') && storageError)
      return send(ws, { t: 'rej', seq: m.seq, reason: 'Action storage is unavailable; ask the host to reset or restart the service', wait: 0 });

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
      const dry = R.rasterize(board.fb, a, true);
      if (dry.error) return send(ws, { t: 'rej', seq: m.seq, reason: dry.error, wait: 0 });
      if (ZONES && a.tool !== 'fill' && dry.idx.some(i => B.zoneTeam(SIZE, i % SIZE, (i / SIZE) | 0) !== team))
        return send(ws, { t: 'rej', seq: m.seq, reason: 'You can only draw inside your own team zone', wait: 0 });
      if (!dry.idx.some(i => board.fb.data[i] !== a.c || board.teams[i] !== team)) return send(ws, { t: 'rej', seq: m.seq, reason: 'Nothing would change', wait: 0 });

      const n = log.length, key = playerKey(ws.player.id);
      const entry = { n, ts: now, p: ws.player.name, u: key, tm: ws.player.team, tool: a.tool, pts: a.pts, c: a.c, f: a.f };
      if (a.clip) entry.clip = a.clip;                 // logged so the replay fills exactly the same pixels
      const saved = appendEntry(entry);
      if (saved.error) return send(ws, { t: 'rej', seq: m.seq, reason: 'Could not save this action; drawing is paused until storage is repaired', wait: 0 });
      const res = B.apply(board, entry, n);
      if (res.error) {
        rollbackEntry(saved.offset);
        return send(ws, { t: 'rej', seq: m.seq, reason: res.error, wait: 0 });
      }

      nextAllowed.set(ws.player.id, now + COOLDOWN_MS);
      countChanges(res.changes);
      log.push(entry); track(entry, n);

      broadcast({ t: 'px', n, ts: now, p: entry.p, tm: entry.tm, tool: a.tool, c: a.c,
                  idx: res.changes.map(ch => ch[0]), teams: res.changes.map(ch => ch[4]), sc: scores });
      send(ws, { t: 'ok', seq: m.seq, wait: COOLDOWN_MS, pixels: res.changes.length, undo: undoable(key), redo: redoable(key) });
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
      const saved = appendEntry(entry);
      if (saved.error) return send(ws, { t: 'rej', seq: m.seq, reason: 'Could not save this undo; drawing is paused until storage is repaired', wait: 0 });
      const res = B.apply(board, entry, n);
      if (res.error) {
        rollbackEntry(saved.offset);
        return send(ws, { t: 'rej', seq: m.seq, reason: res.error, wait: 0 });
      }

      countChanges(res.changes);
      log.push(entry); track(entry, n);

      // every restored pixel can have a different colour, so send one colour per pixel
      broadcast({ t: 'px', n, ts: now, p: entry.p, tm: entry.tm, tool: 'undo',
                  idx: res.changes.map(ch => ch[0]), cols: res.changes.map(ch => ch[2]), teams: res.changes.map(ch => ch[4]), sc: scores });
      send(ws, { t: 'undone', seq: m.seq, pixels: res.changes.length, undo: undoable(key), redo: redoable(key) });
      return;
    }

    if (m.t === 'redo') {
      const now = Date.now(), key = playerKey(ws.player.id);
      if (now < (nextUndo.get(ws.player.id) || 0)) return send(ws, { t: 'rej', seq: m.seq, reason: 'Slow down a little', wait: 0 });
      const list = redone.get(key) || [];
      if (!list.length) return send(ws, { t: 'rej', seq: m.seq, reason: 'You have nothing to redo', wait: 0 });
      nextUndo.set(ws.player.id, now + UNDO_GAP_MS);

      const n = log.length;
      const entry = { n, ts: now, p: ws.player.name, u: key, tm: ws.player.team, tool: 'redo', ref: list[list.length - 1] };
      const saved = appendEntry(entry);
      if (saved.error) return send(ws, { t: 'rej', seq: m.seq, reason: 'Could not save this redo; drawing is paused until storage is repaired', wait: 0 });
      const res = B.apply(board, entry, n);
      if (res.error) {
        rollbackEntry(saved.offset);
        return send(ws, { t: 'rej', seq: m.seq, reason: res.error, wait: 0 });
      }

      countChanges(res.changes);
      log.push(entry); track(entry, n);
      broadcast({ t: 'px', n, ts: now, p: entry.p, tm: entry.tm, tool: 'redo',
                  idx: res.changes.map(ch => ch[0]), cols: res.changes.map(ch => ch[2]), teams: res.changes.map(ch => ch[4]), sc: scores });
      send(ws, { t: 'redone', seq: m.seq, pixels: res.changes.length, undo: undoable(key), redo: redoable(key) });
    }
  });

  ws.on('close', () => { if (ws.player) broadcast({ t: 'online', n: onlineCount() }); });
  ws.on('error', (error) => console.warn('WebSocket error:', error.message));
});

// drop dead connections (phones that left the Wi-Fi)
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; ws.ping();
  }
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Pixel Battle listening on port ${PORT}  (canvas ${SIZE}x${SIZE}, cooldown ${COOLDOWN_MS} ms)`);
  console.log(`Action log directory: ${DATA_DIR}`);
  if (process.env.NODE_ENV !== 'production') {
    const nets = require('os').networkInterfaces();
    for (const list of Object.values(nets)) for (const n of list) if (n.family === 'IPv4' && !n.internal) console.log(`  on the Wi-Fi:  http://${n.address}:${PORT}`);
  }
});
