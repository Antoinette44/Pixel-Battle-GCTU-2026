/* Zones + team scoring + server-controlled challenge timer, tested against the real server.  Run: npm run test:challenge */
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const WebSocket = require('ws');
const P = require('../public/palette.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbc-'));
const PORT = 3800 + Math.floor(Math.random() * 400);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: dir, COOLDOWN_MS: '200' }, stdio: 'ignore' });
let seq = 0;
function client(name, team, id) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:' + PORT), c = { ws, msgs: [], seq: 0 };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', id: id || 'cid-' + name + '-' + Math.random().toString(16).slice(2), name, team })));
    ws.on('message', (d) => {
      const m = JSON.parse(d); c.msgs.push(m);
      if (m.t === 'init') {
        c.init = m; c.owners = Array.from(m.teams, v => parseInt(v, 36) - 1); resolve(c);
      } else if (m.t === 'px' && c.owners) {
        m.idx.forEach((i, k) => { c.owners[i] = m.teams[k]; });
      }
    });
    c.next = async (t, pred = () => true) => { for (let i = 0; i < 150; i++) { const k = c.msgs.findIndex(m => m.t === t && pred(m)); if (k >= 0) return c.msgs.splice(k, 1)[0]; await sleep(20); } throw new Error('timeout waiting for ' + t); };
    c.act = (o) => ws.send(JSON.stringify({ t: 'act', seq: ++c.seq, ...o }));
    c.admin = (cmd, secs) => ws.send(JSON.stringify({ t: 'admin', cmd, secs }));
  });
}
const ok = (s) => console.log('  ok  ' + s);
const recount = (owners) => P.TEAMS.map(t => owners.filter(team => team === t.id).length);
(async () => {
  try {
    const red = P.TEAMS[0].colour, blue = P.TEAMS[1].colour;
    await sleep(700);
    const a = await client('Ann', 0, 'id-ann-0001'), b = await client('Ben', 1);
    assert.strictEqual(a.init.ch.state, 'idle'); assert.strictEqual(a.init.zones, true);
    // ---- zones ----
    a.act({ tool: 'pen', pts: [[10, 10]], c: red, f: 0 }); await a.next('ok'); ok('Red draws in the top-left zone');
    await sleep(250);
    a.act({ tool: 'pen', pts: [[100, 10]], c: red, f: 0 }); assert.match((await a.next('rej')).reason, /own team zone/); ok('Red is refused in the top-right (Blue) zone - server side');
    await sleep(250);
    a.act({ tool: 'line', pts: [[60, 20], [70, 20]], c: red, f: 0 }); assert.match((await a.next('rej')).reason, /own team zone/); ok('a line crossing the zone border is refused');
    // ---- team stays with the session ----
    const a2 = await client('Ann', 3, 'id-ann-0001');
    assert.strictEqual(a2.init.team, 0); ok('a reconnecting player keeps the team the server stored (client asked for 3)');
    // ---- bucket fill is clipped to the zone ----
    await sleep(250);
    a2.act({ tool: 'fill', pts: [[5, 5]], c: red, f: 0 });
    const rej = await a2.next('rej', () => true).catch(() => null);
    // region is the whole empty zone (64*64-1 > 1500 limit) -> too big; use a tiny enclosed region instead
    assert(rej && /too big/i.test(rej.reason)); ok('bucket seed inside the zone: huge region refused by the normal fill limit');
    await sleep(250);
    // wall of red around a small pocket spanning the zone corner, then fill inside
    const wall = [[[20, 20], [30, 20]], [[30, 20], [30, 30]], [[30, 30], [20, 30]], [[20, 30], [20, 20]]];
    for (const [p, q] of wall) { a2.act({ tool: 'line', pts: [p, q], c: red, f: 0 }); await a2.next('ok'); await sleep(250); }
    a2.act({ tool: 'fill', pts: [[25, 25]], c: P.TEAMS[0].colour - 1, f: 0 });   // paint pocket with a normal palette colour
    const f = await a2.next('ok'); assert.strictEqual(f.pixels, 81 - 0); ok('queue flood fill still works inside the zone (81-pixel pocket)');
    // ---- scoring: every pixel counts for its team, independent of palette colour ----
    const s1 = (await a2.next('px', m => m.tool === 'fill')).sc;
    assert.deepStrictEqual(s1, [122, 0, 0, 0]);
    assert.deepStrictEqual(recount(a2.owners), s1);
    ok('palette-colour pen, walls and bucket pixels all count for the drawing team');
    // ---- timer ----
    b.msgs.length = 0;
    b.admin('start', 5);
    assert.strictEqual((await b.next('adm')).ok, true); // localhost host, no ADMIN_KEY
    const start = await b.next('ch', m => m.state === 'running'); assert(start.rem > 4000 && start.rem <= 5000); ok('host (localhost) started a 5 s challenge; every client got the same server time: ' + start.rem + ' ms');
    const a3 = await client('Late', 2);
    assert(a3.init.ch.state === 'running' && a3.init.ch.rem <= start.rem); ok('a late joiner gets the remaining time and a blank canvas');
    assert.strictEqual(a3.init.grid, '0'.repeat(128 * 128));
    b.act({ tool: 'pen', pts: [[80, 10]], c: blue, f: 0 }); await b.next('ok'); await b.next('px');
    await sleep(250);
    b.act({ tool: 'pen', pts: [[81, 10]], c: blue, f: 0 }); await b.next('ok'); await b.next('px');
    // A non-team palette colour still belongs to Blue and must not reduce its score.
    await sleep(250);
    b.act({ tool: 'pen', pts: [[81, 10]], c: 4, f: 0 }); const px = await b.next('px', m => m.idx && m.sc); await b.next('ok');
    assert.deepStrictEqual(px.sc, [0, 2, 0, 0]);
    const g = await client('Check', 1); const count = recount(g.owners);
    assert.deepStrictEqual(g.init.scores, count); assert.deepStrictEqual(count, [0, 2, 0, 0]);
    ok('Blue palette-colour pixels remain Blue-owned; scoreboard matches an ownership recount');
    await sleep(5200);
    const end = await a.next('ch', m => m.state === 'ended'); assert.deepStrictEqual(end.final, [0, 2, 0, 0]); assert.deepStrictEqual(end.winners, [1]);
    ok('timer ended on the server; final ownership scores ' + end.final + ', winner = team ' + end.winners[0] + ' (Blue)');
    await sleep(250);
    b.act({ tool: 'pen', pts: [[90, 10]], c: blue, f: 0 }); assert.match((await b.next('rej')).reason, /over/); ok('drawing is refused after the end');
    b.ws.send(JSON.stringify({ t: 'undo', seq: 99 })); assert.match((await b.next('rej')).reason, /over/); ok('undo is refused after the end');
    b.ws.send(JSON.stringify({ t: 'redo', seq: 100 })); assert.match((await b.next('rej')).reason, /over/); ok('redo is refused after the end');
    // ---- draw ----
    b.msgs.length = 0;
    b.admin('start', 5);
    assert.strictEqual((await b.next('adm')).ok, true);
    const e2 = await b.next('ch', m => m.state === 'running'); assert(e2.rem > 0);
    await sleep(5300);
    const e3 = await b.next('ch', m => m.state === 'ended'); assert.strictEqual(e3.winners.length, 4); ok('0-0-0-0 is announced as a draw (all 4 teams tied)');
    console.log('\nchallenge tests passed'); srv.kill(); process.exit(0);
  } catch (e) { console.error('FAIL', e); srv.kill(); process.exit(1); }
})();
