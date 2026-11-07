/* Reset Battle: real server, real websocket clients.  Run: npm run test:reset */
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const WebSocket = require('ws');
const P = require('../public/palette.js'), B = require('../public/board.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbr-'));
const PORT = 4200 + Math.floor(Math.random() * 400), KEY = 'test-host-key-123';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const start = () => spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: dir, COOLDOWN_MS: '150', ADMIN_KEY: KEY }, stdio: 'ignore' });
const get = (p) => new Promise(res => http.get(`http://localhost:${PORT}${p}`, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => res({ status: r.statusCode, body: s })); }));
function client(name, team, id) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:' + PORT), c = { ws, msgs: [], seq: 0 };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', id: id || 'cid-' + name + '-' + Math.random().toString(16).slice(2), name, team })));
    ws.on('message', (d) => { const m = JSON.parse(d); c.msgs.push(m); if (m.t === 'init' && !c.init) { c.init = m; resolve(c); } });
    c.next = async (t, pred = () => true) => { for (let i = 0; i < 150; i++) { const k = c.msgs.findIndex(m => m.t === t && pred(m)); if (k >= 0) return c.msgs.splice(k, 1)[0]; await sleep(20); } throw new Error('timeout waiting for ' + t); };
    c.act = (o) => ws.send(JSON.stringify({ t: 'act', seq: ++c.seq, ...o }));
    c.undo = () => ws.send(JSON.stringify({ t: 'undo', seq: ++c.seq }));
    c.admin = (cmd, key) => ws.send(JSON.stringify({ t: 'admin', cmd, key }));
  });
}
const ok = (s) => console.log('  ok  ' + s);
const BLANK = '0'.repeat(128 * 128);
const readLog = () => fs.readFileSync(path.join(dir, 'actions.ndjson'), 'utf8').split('\n').filter(Boolean);
(async () => {
  let srv = start();
  try {
    await sleep(700);
    const red = P.TEAMS[0].colour, blue = P.TEAMS[1].colour;
    const a = await client('Ann', 0, 'id-ann-reset01'), b = await client('Ben', 1, 'id-ben-reset01');
    a.act({ tool: 'circle', pts: [[30, 30], [35, 30]], c: red, f: 1 }); await a.next('ok'); await sleep(200);
    a.act({ tool: 'line', pts: [[5, 5], [40, 5]], c: 4, f: 0 }); await a.next('ok');
    b.act({ tool: 'polygon', pts: [[80, 10], [100, 10], [90, 30]], c: blue, f: 0 }); await b.next('ok');
    assert(readLog().length === 3);
    const before = await client('Before', 2); assert.notStrictEqual(before.init.grid, BLANK); assert(before.init.scores[0] > 0 && before.init.scores[1] > 0);

    // 12. unauthorised player cannot reset
    a.admin('reset'); assert.strictEqual((await a.next('adm')).ok, false);
    a.admin('reset', 'wrong-key'); assert.strictEqual((await a.next('adm')).ok, false);
    assert.strictEqual((await get('/admin/reset')).status, 403); assert.strictEqual((await get('/admin/reset?key=nope')).status, 403);
    assert.strictEqual(readLog().length, 3); assert.notStrictEqual((await client('Chk', 0)).init.grid, BLANK);
    ok('12. players with no/wrong key (websocket and HTTP) cannot reset; canvas and log untouched');

    // reset by the admin
    for (const c of [a, b, before]) c.msgs.length = 0;
    b.admin('reset', KEY); const adm = await b.next('adm'); assert.strictEqual(adm.ok, true);
    // 5. every client gets the event + a blank init
    for (const c of [a, b, before]) {
      await c.next('reset'); const i = await c.next('init');
      assert.strictEqual(i.grid, BLANK); assert.deepStrictEqual(i.scores, [0, 0, 0, 0]); assert.strictEqual(i.actions, 0); assert.strictEqual(i.undo, 0);
    }
    ok('1,2,5. every connected client got reset + a fully blank canvas + scores [0,0,0,0]');

    // 3. log cleared (active file empty; old one archived, not active)
    assert.strictEqual(readLog().length, 0);
    assert.strictEqual(JSON.parse((await get('/api/log')).body).log.length, 0);
    assert(fs.readdirSync(dir).some(f => /^actions-\d+\.ndjson$/.test(f)));
    ok('3,10. active action log and /api/log (replay source) are empty; old log archived');

    // 7. teams unchanged
    const a2 = await client('Ann', 3, 'id-ann-reset01'); assert.strictEqual(a2.init.team, 0);
    const b2 = await client('Ben', 0, 'id-ben-reset01'); assert.strictEqual(b2.init.team, 1);
    ok('7. team assignments survive the reset');

    // 6. new player sees blank canvas
    const fresh = await client('Fresh', 2); assert.strictEqual(fresh.init.grid, BLANK); assert.deepStrictEqual(fresh.init.scores, [0, 0, 0, 0]);
    ok('6. a newly connected player receives the blank canvas');

    // 11. undo cannot bring old drawings back
    a2.undo(); assert.match((await a2.next('rej')).reason, /nothing to undo/i);
    ok('11. undo after reset does nothing (old actions are gone)');

    // 8. zones intact + 9. drawing works (and the zone rule is still enforced)
    await sleep(200);
    a2.act({ tool: 'fill', pts: [[10, 10]], c: red, f: 0 }); const rj = await a2.next('rej'); assert(/too big/i.test(rj.reason));
    a2.act({ tool: 'pen', pts: [[100, 100]], c: red, f: 0 }); assert.match((await a2.next('rej')).reason, /own team zone/);
    assert.deepStrictEqual(B.zoneRect(128, 0), [0, 0, 63, 63]); assert.deepStrictEqual(B.zoneRect(128, 3), [64, 64, 127, 127]);
    await sleep(200);
    a2.act({ tool: 'line', pts: [[10, 10], [20, 10]], c: red, f: 0 }); const ok1 = await a2.next('ok'); assert.strictEqual(ok1.pixels, 11);
    ok('8,9. zones unchanged and enforced; tools work after the reset (line = 11 px)');
    const sc = (await fresh.next('px', m => m.tool === 'line')).sc; assert.deepStrictEqual(sc, [11, 0, 0, 0]);
    ok('   scoring restarted from 0 (red = 11)');

    // 4. restart: old drawings must not return, new ones must
    const gridNow = (await client('Now', 1)).init.grid;
    for (const c of [a, b, before, a2, b2, fresh]) c.ws.close();
    srv.kill(); await sleep(500); srv = start(); await sleep(700);
    const after = await client('After', 2);
    assert.strictEqual(after.init.grid, gridNow); assert.deepStrictEqual(after.init.scores, [11, 0, 0, 0]); assert.strictEqual(after.init.actions, 1);
    ok('4. after a server restart only the NEW battle (1 action) is rebuilt; old drawings do not return');

    // 10. replay source starts with the new battle
    const lg = JSON.parse((await get('/api/log')).body).log; assert.strictEqual(lg.length, 1); assert.strictEqual(lg[0].tool, 'line'); assert.strictEqual(lg[0].n, 0);
    const rb = B.create(128, 128, 0); lg.forEach((e, n) => assert(!B.apply(rb, e, n).error));
    assert.strictEqual(Array.from(rb.fb.data, v => v.toString(36)).join(''), after.init.grid);
    ok('10. replaying /api/log gives exactly the new battle starting at action 0');
    console.log('\nreset tests passed'); srv.kill(); process.exit(0);
  } catch (e) { console.error('FAIL', e); srv.kill(); process.exit(1); }
})();