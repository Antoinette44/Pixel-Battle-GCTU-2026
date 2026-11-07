/* End-to-end test: starts the real server, connects real websocket clients, checks sync, undo/redo,
   scoreboard and that a restart rebuilds the same canvas from the log.   Run with: npm run test:server */
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const WebSocket = require('ws');
const P = require('../public/palette.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-'));
const PORT = 3200 + Math.floor(Math.random() * 500);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const get = (p) => new Promise((resolve, reject) => {
  http.get(`http://localhost:${PORT}${p}`, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
  }).on('error', reject);
});

const tooSmall = spawnSync(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT, DATA_DIR: dir, CANVAS_SIZE: '64' }, encoding: 'utf8', timeout: 5000,
});
assert.notStrictEqual(tooSmall.status, 0);
assert.match(tooSmall.stderr, /CANVAS_SIZE must be an integer of at least 128/);
console.log('  ok  server rejects canvases smaller than 128x128');

function startServer() {
  const p = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: dir, COOLDOWN_MS: '300', ZONES: '0' }, stdio: 'ignore' });
  return p;
}
function client(name, team) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:' + PORT), c = { ws, msgs: [], grid: null, scores: null, teams: null };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', id: 'testid-' + name + '-' + Math.random().toString(16).slice(2), name, team })));
    ws.on('message', (d) => {
      const m = JSON.parse(d); c.msgs.push(m);
      if (m.t === 'init') {
        c.grid = m.grid; c.teams = Array.from(m.teams, v => parseInt(v, 36) - 1);
        c.scores = m.scores; c.undo = m.undo; c.redo = m.redo; resolve(c);
      }
      else if (m.t === 'px' && c.grid) {
        const grid = c.grid.split('');
        m.idx.forEach((i, k) => { grid[i] = (m.cols ? m.cols[k] : m.c).toString(36); });
        m.idx.forEach((i, k) => { c.teams[i] = m.teams[k]; });
        c.grid = grid.join(''); c.scores = m.sc;
      }
    });
    c.next = async (t) => { for (let i = 0; i < 100; i++) { const k = c.msgs.findIndex(m => m.t === t); if (k >= 0) return c.msgs.splice(k, 1)[0]; await sleep(20); } throw new Error('timeout waiting for ' + t); };
    c.send = (o) => ws.send(JSON.stringify(o));
  });
}
const recount = (owners) => P.TEAMS.map(t => owners.filter(team => team === t.id).length);

(async () => {
  let srv = startServer(); await sleep(700);
  try {
    const home = await get('/');
    assert.strictEqual(home.status, 200);
    assert.match(home.body, /src="app\.js"/);
    assert.match(home.body, /id="redoAction"/);
    assert.strictEqual((await get('/raster.js')).status, 200);
    assert.strictEqual((await get('/health')).status, 200);
    assert.strictEqual((await get('/admin/reset')).status, 404);
    console.log('  ok  frontend assets and health endpoint are served; HTTP reset is disabled');

    const originRejected = await new Promise((resolve) => {
      const ws = new WebSocket('ws://localhost:' + PORT, { origin: 'https://other.example' });
      ws.once('open', () => resolve(false));
      ws.once('error', () => resolve(true));
    });
    assert.strictEqual(originRejected, true, 'cross-origin browser WebSocket requests must be refused');
    console.log('  ok  cross-origin browser WebSocket requests are refused');

    const duplicateHelloCode = await new Promise((resolve) => {
      const ws = new WebSocket('ws://localhost:' + PORT);
      const timeout = setTimeout(() => { ws.terminate(); resolve(null); }, 2000);
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', id: 'first-player-id-123', name: 'First', team: 0 })));
      ws.on('message', (d) => {
        if (JSON.parse(d).t === 'init') ws.send(JSON.stringify({ t: 'hello', id: 'second-player-id-123', name: 'Second', team: 1 }));
      });
      ws.once('close', (code) => { clearTimeout(timeout); resolve(code); });
    });
    assert.strictEqual(duplicateHelloCode, 1008, 'a connection cannot change its player identity after hello');
    console.log('  ok  repeated hello cannot switch player identities');

    const closeCodeForMessage = (payload) => new Promise((resolve) => {
      const ws = new WebSocket('ws://localhost:' + PORT);
      const timeout = setTimeout(() => { ws.terminate(); resolve(null); }, 2000);
      ws.once('open', () => ws.send(payload));
      ws.once('close', (code) => { clearTimeout(timeout); resolve(code); });
      ws.on('error', () => {});
    });
    assert.strictEqual(await closeCodeForMessage('{'), 1003, 'invalid JSON must be rejected');
    assert.strictEqual(await closeCodeForMessage('x'.repeat(8193)), 1009, 'oversized messages must be rejected');
    console.log('  ok  malformed and oversized WebSocket messages are closed');

    const a = await client('Ann', 0), b = await client('Ben', 1);
    const paletteColour = 3;

    a.send({ t: 'act', seq: 1, tool: 'line', pts: [[10, 10], [30, 10]], c: paletteColour, f: 0 });
    const okA = await a.next('ok'); assert.strictEqual(okA.pixels, 21); assert.strictEqual(okA.undo, 1);
    const pxB = await b.next('px'); assert.strictEqual(pxB.idx.length, 21);
    assert.deepStrictEqual(pxB.sc, [21, 0, 0, 0]);
    console.log('  ok  a line drawn by Ann reaches Ben');

    a.send({ t: 'act', seq: 1, tool: 'pen', pts: [[11, 11]], c: paletteColour, f: 0 });
    assert.match((await a.next('rej')).reason, /sequence/i);
    console.log('  ok  duplicate action sequences are rejected');

    a.send({ t: 'act', seq: 2, tool: 'pen', pts: [[11, 11]], c: paletteColour, f: 0 });
    assert.match((await a.next('rej')).reason, /Cooldown/);
    console.log('  ok  cooldown is enforced by the server');

    b.send({ t: 'act', seq: 1, tool: 'pen', pts: [[20, 10]], c: paletteColour, f: 0 }); // Ben takes ownership without changing the visible colour.
    await b.next('ok');
    const takeover = await b.next('px');
    assert.strictEqual(takeover.idx.length, 1);
    assert.deepStrictEqual(takeover.sc, [20, 1, 0, 0]);
    assert.strictEqual(b.grid[10 * 128 + 20], paletteColour.toString(36), 'ownership changes while drawing colour stays the same');
    await sleep(350);
    a.send({ t: 'undo', seq: 3 });
    const und = await a.next('undone'); assert.strictEqual(und.pixels, 20, 'Ben\'s pixel must survive');
    assert.strictEqual(und.undo, 0); assert.strictEqual(und.redo, 1);
    const pxU = await b.next('px'); while (pxU.tool !== 'undo') Object.assign(pxU, await b.next('px'));
    assert(Array.isArray(pxU.cols) && pxU.cols.length === 20);
    assert.deepStrictEqual(pxU.sc, [0, 1, 0, 0]);
    assert.deepStrictEqual(pxU.sc, recount(b.teams), 'undo must restore team ownership and scoring');
    console.log('  ok  undo removes only my pixels and everybody sees it');

    await sleep(550);
    a.send({ t: 'redo', seq: 4 });
    const redoAck = await a.next('redone'); assert.strictEqual(redoAck.pixels, 20);
    assert.strictEqual(redoAck.undo, 1); assert.strictEqual(redoAck.redo, 0);
    const pxR = await b.next('px'); while (pxR.tool !== 'redo') Object.assign(pxR, await b.next('px'));
    assert.strictEqual(pxR.idx.length, 20, 'redo must leave Ben\'s overwritten pixel untouched');
    assert.deepStrictEqual(pxR.sc, recount(b.teams), 'redo scores must match pixel team ownership');
    console.log('  ok  redo is broadcast to other players without overwriting pixels or inflating scores');

    b.send({ t: 'undo', seq: 4 }); await b.next('undone');
    await sleep(550);
    a.send({ t: 'undo', seq: 5 }); assert.strictEqual((await a.next('undone')).pixels, 21);
    await sleep(550);
    a.send({ t: 'undo', seq: 6 }); assert.match((await a.next('rej')).reason, /nothing to undo/i);
    console.log('  ok  nothing-to-undo is refused; Ben can undo his own pixel');

    const late = await client('Late', 2);
    assert.strictEqual(late.grid, '0'.repeat(128 * 128), 'everything undone: canvas should be blank');
    assert.deepStrictEqual(late.scores, [0, 0, 0, 0]);
    console.log('  ok  a new player receives the current canvas (blank after full undo) and scores are 0');

    // draw something that stays, then restart the server
    await sleep(350);
    a.send({ t: 'act', seq: 7, tool: 'circle', pts: [[60, 60], [66, 60]], c: P.TEAMS[0].colour, f: 1 }); await a.next('ok');
    await sleep(350);
    a.send({ t: 'act', seq: 8, tool: 'polygon', pts: [[90, 90], [100, 90], [95, 100]], c: P.TEAMS[1].colour, f: 0 }); await a.next('ok');
    await sleep(350);
    a.send({ t: 'undo', seq: 9 }); await a.next('undone');                        // undo the polygon
    const before = await client('Check1', 3);
    assert.deepStrictEqual(before.scores, recount(before.teams), 'scoreboard must equal a recount of pixel team ownership');
    console.log('  ok  scoreboard equals a recount of the canvas');
    for (const c of [a, b, late, before]) c.ws.close();
    srv.kill(); await sleep(400);

    srv = startServer(); await sleep(700);
    const after = await client('Check2', 3);
    assert.strictEqual(after.grid, before.grid, 'restart must rebuild the identical canvas from the log');
    assert.deepStrictEqual(after.scores, before.scores);
    console.log('  ok  after a restart the canvas and scores are rebuilt identically (undo/redo included)');

    // the logged undo entries must replay to the same picture in the browser code
    const B = require('../public/board.js');
    const log = JSON.parse((await get('/api/log')).body).log;
    const rb = B.create(128, 128, 0); log.forEach((e, n) => assert(!B.apply(rb, e, n).error));
    assert.strictEqual(Array.from(rb.fb.data, v => v.toString(36)).join(''), after.grid);
    assert(log.some(e => e.tool === 'undo'));
    assert(log.every(e => !('id' in e)), 'the secret player id must not be in the public log');
    assert(log.some(e => e.tool === 'redo'));
    console.log('  ok  replaying /api/log (with undo/redo entries) equals the live canvas; no secret ids leak');
    console.log('\nserver tests passed');
    after.ws.close(); srv.kill(); process.exit(0);
  } catch (e) { console.error('FAIL', e); srv.kill(); process.exit(1); }
})();
