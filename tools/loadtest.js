/* Load test: N simulated players on the websocket. Measures broadcast latency (server timestamp ->
   arrival at each bot), checks that every bot's canvas ends up IDENTICAL to a fresh joiner's snapshot.
   Usage:  node tools/loadtest.js [players=20] [seconds=30]
   Env:    URL=ws://localhost:3000   (start the server first, e.g.  COOLDOWN_MS=1000 DATA_DIR=./data-test npm start)
   Latency uses the server's clock, so run this on the same machine as the server for exact numbers.  */
const WebSocket = require('ws');
const R = require('../public/raster.js');
const P = require('../public/palette.js');
const N = +process.argv[2] || 20, SECONDS = +process.argv[3] || 30;
const URL_ = process.env.URL || 'ws://localhost:3000';
const rnd = (n) => Math.floor(Math.random() * n);
const lat = [], rtt = [];
let sent = 0, ok = 0, rej = 0, undos = 0, stop = false;

function bot(i) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL_);
    const b = { i, grid: null, id: 'loadbot-' + i + '-' + Date.now().toString(36), t0: 0, ws };
    const fb = R.createFB(128, 128, 0); b.fb = fb;
    const act = () => {
      if (stop || ws.readyState !== 1) return;
      if (b.canUndo && rnd(5) === 0) { sent++; ws.send(JSON.stringify({ t: 'undo', seq: sent })); return; }   // ~20% of turns: undo
      const t = ['pen', 'line', 'circle', 'polygon', 'fill'][rnd(5)];
      const x = 8 + rnd(110), y = 8 + rnd(110), c = rnd(P.NUM);
      const near = () => [Math.max(0, Math.min(127, x + rnd(21) - 10)), Math.max(0, Math.min(127, y + rnd(21) - 10))];
      const pts = t === 'pen' || t === 'fill' ? [[x, y]] : t === 'line' ? [[x, y], near()] : t === 'circle' ? [[x, y], [x + 1 + rnd(8), y]] : [[x, y], near(), near()];
      b.t0 = Date.now(); sent++;
      ws.send(JSON.stringify({ t: 'act', seq: sent, tool: t, pts, c, f: rnd(2) }));
    };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', id: b.id, name: 'bot' + i, team: i % 4 })));
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.t === 'init') { for (let k = 0; k < m.grid.length; k++) fb.data[k] = parseInt(m.grid[k], 36); setTimeout(act, rnd(2000)); resolve(b); }
      else if (m.t === 'px') { lat.push(Date.now() - m.ts); m.idx.forEach((k, j) => R.setPixel(fb, k % 128, (k / 128) | 0, m.cols ? m.cols[j] : m.c)); }
      else if (m.t === 'undone') { undos++; setTimeout(act, 100 + rnd(300)); }
      else if (m.t === 'ok') { ok++; b.canUndo = true; rtt.push(Date.now() - b.t0); setTimeout(act, m.wait + 20 + rnd(300)); }
      else if (m.t === 'rej') { rej++; setTimeout(act, (m.wait || 0) + 50 + rnd(300)); }
    });
    ws.on('error', (e) => { console.error('bot', i, e.message); resolve(b); });
  });
}
const pct = (a, p) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
const sum = (fb) => { let h = 0; for (let k = 0; k < fb.data.length; k++) h = (h * 31 + fb.data[k]) >>> 0; return h; };

(async () => {
  console.log(`Starting ${N} bots for ${SECONDS}s against ${URL_} ...`);
  const bots = await Promise.all(Array.from({ length: N }, (_, i) => bot(i)));
  await new Promise(r => setTimeout(r, SECONDS * 1000));
  stop = true;
  await new Promise(r => setTimeout(r, 2000));
  const late = await bot(9999);                        // a brand-new player must receive the current canvas
  const ref = sum(late.fb);
  const bad = bots.filter(b => sum(b.fb) !== ref).length;
  console.log('\n=== Load test result ===');
  console.log(`players: ${N}   actions sent: ${sent}   accepted: ${ok}   undone: ${undos}   rejected: ${rej}`);
  console.log(`broadcast latency ms  p50: ${pct(lat, .5)}  p95: ${pct(lat, .95)}  max: ${Math.max(0, ...lat)}   (target: < 1000)`);
  console.log(`action round-trip ms  p50: ${pct(rtt, .5)}  p95: ${pct(rtt, .95)}`);
  console.log(`canvases identical to a late joiner's snapshot: ${N - bad}/${N}`);
  const pass = bad === 0 && pct(lat, .95) < 1000 && ok > 0;
  console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(pass ? 0 : 1);
})();
