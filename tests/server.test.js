/* End-to-end test: starts the real server, connects real websocket clients, checks sync, undo,
   scoreboard and that a restart rebuilds the same canvas from the log.   Run with: npm run test:server */
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const WebSocket = require('ws');
const P = require('../public/palette.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-'));
const PORT = 3200 + Math.floor(Math.random() * 500);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function startServer() {
  const p = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: dir, COOLDOWN_MS: '300' }, stdio: 'ignore' });
  return p;
}
function client(name, team) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:' + PORT), c = { ws, msgs: [], grid: null, scores: null };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', id: 'testid-' + name + '-' + Math.random().toString(16).slice(2), name, team })));
    ws.on('message', (d) => {
      const m = JSON.parse(d); c.msgs.push(m);
      if (m.t === 'init') { c.grid = m.grid; c.scores = m.scores; c.undo = m.undo; resolve(c); }
    });
    c.next = async (t) => { for (let i = 0; i < 100; i++) { const k = c.msgs.findIndex(m => m.t === t); if (k >= 0) return c.msgs.splice(k, 1)[0]; await sleep(20); } throw new Error('timeout waiting for ' + t); };
    c.send = (o) => ws.send(JSON.stringify(o));
  });
}
const recount = (grid) => P.TEAMS.map(t => [...grid].filter(ch => parseInt(ch, 36) === t.colour).length);

(async () => {
  let srv = startServer(); await sleep(700);
  try {
    const a = await client('Ann', 0), b = await client('Ben', 1);
    const red = P.TEAMS[0].colour, blue = P.TEAMS[1].colour;

    a.send({ t: 'act', seq: 1, tool: 'line', pts: [[10, 10], [30, 10]], c: red, f: 0 });
    const okA = await a.next('ok'); assert.strictEqual(okA.pixels, 21); assert.strictEqual(okA.undo, 1);
    const pxB = await b.next('px'); assert.strictEqual(pxB.idx.length, 21);
    console.log('  ok  a line drawn by Ann reaches Ben');

    a.send({ t: 'act', seq: 2, tool: 'pen', pts: [[11, 11]], c: red, f: 0 });
    assert.match((await a.next('rej')).reason, /Cooldown/);
    console.log('  ok  cooldown is enforced by the server');

    b.send({ t: 'act', seq: 1, tool: 'pen', pts: [[20, 10]], c: blue, f: 0 });   // Ben paints over one of Ann's pixels
    await b.next('ok');
    await sleep(350);
    a.send({ t: 'undo', seq: 3 });
    const und = await a.next('undone'); assert.strictEqual(und.pixels, 20, 'Ben\'s pixel must survive');
    assert.strictEqual(und.undo, 0);
    const pxU = await b.next('px'); while (pxU.tool !== 'undo') Object.assign(pxU, await b.next('px'));
    assert(Array.isArray(pxU.cols) && pxU.cols.length === 20);
    console.log('  ok  undo removes only my pixels and everybody sees it');

    b.send({ t: 'undo', seq: 4 }); await b.next('undone');
    await sleep(550);
    a.send({ t: 'undo', seq: 5 }); assert.match((await a.next('rej')).reason, /nothing to undo/i);
    console.log('  ok  nothing-to-undo is refused; Ben can undo his own pixel');

    const late = await client('Late', 2);
    assert.strictEqual(late.grid, '0'.repeat(128 * 128), 'everything undone: canvas should be blank');
    assert.deepStrictEqual(late.scores, [0, 0, 0, 0]);
    console.log('  ok  a new player receives the current canvas (blank after full undo) and scores are 0');

    // draw something that stays, then restart the server
    await sleep(350);
    a.send({ t: 'act', seq: 6, tool: 'circle', pts: [[60, 60], [66, 60]], c: red, f: 1 }); await a.next('ok');
    await sleep(350);
    a.send({ t: 'act', seq: 7, tool: 'polygon', pts: [[90, 90], [100, 90], [95, 100]], c: blue, f: 0 }); await a.next('ok');
    await sleep(350);
    a.send({ t: 'undo', seq: 8 }); await a.next('undone');                        // undo the polygon
    const before = await client('Check1', 3);
    assert.deepStrictEqual(before.scores, recount(before.grid), 'scoreboard must equal a recount of the canvas');
    console.log('  ok  scoreboard equals a recount of the canvas');
    for (const c of [a, b, late, before]) c.ws.close();
    srv.kill(); await sleep(400);

    srv = startServer(); await sleep(700);
    const after = await client('Check2', 3);
    assert.strictEqual(after.grid, before.grid, 'restart must rebuild the identical canvas from the log');
    assert.deepStrictEqual(after.scores, before.scores);
    console.log('  ok  after a restart the canvas and scores are rebuilt identically (undo included)');

    // the logged undo entries must replay to the same picture in the browser code
    const B = require('../public/board.js');
    const log = JSON.parse(await new Promise((res) => require('http').get(`http://localhost:${PORT}/api/log`, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => res(s)); }))).log;
    const rb = B.create(128, 128, 0); log.forEach((e, n) => assert(!B.apply(rb, e, n).error));
    assert.strictEqual(Array.from(rb.fb.data, v => v.toString(36)).join(''), after.grid);
    assert(log.some(e => e.tool === 'undo'));
    assert(log.every(e => !('id' in e)), 'the secret player id must not be in the public log');
    console.log('  ok  replaying /api/log (with undo entries) equals the live canvas; no secret ids leak');
    console.log('\nserver tests passed');
    after.ws.close(); srv.kill(); process.exit(0);
  } catch (e) { console.error('FAIL', e); srv.kill(); process.exit(1); }
})();
