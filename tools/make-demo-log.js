/* Makes a SYNTHETIC demo battle (clearly NOT a real one) so you can show the time-lapse replay before the real event.
   Four teams grab territory, fight over it, and some players undo.  Output: samples/demo-battle.ndjson
   Usage: node tools/make-demo-log.js [actions=400]                                                               */
const fs = require('fs'), path = require('path');
const R = require('../public/raster.js'), B = require('../public/board.js'), P = require('../public/palette.js');
let seed = 2026; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >> 10) % n; };
const N = +process.argv[2] || 400, SIZE = 128;
const board = B.create(SIZE, SIZE, P.BG), log = [], names = ['Ama', 'Kofi', 'Yaw', 'Esi', 'Kwame', 'Akua', 'Nana', 'Efua'];
const home = [[30, 30], [98, 30], [30, 98], [98, 98]];       // each team starts in its own corner
const mine = names.map(() => []);
let t = Date.now() - N * 4000;
const clamp = (v) => Math.max(0, Math.min(SIZE - 1, v));
while (log.length < N) {
  const who = rnd(names.length), team = who % 4;
  t += 1500 + rnd(5000);
  let e;
  const open = mine[who].filter(i => !log.some(y => y.tool === 'undo' && y.ref === i));
  if (open.length && rnd(8) === 0) e = { tool: 'undo', ref: open[open.length - 1] };
  else {
    // drift from the team's corner towards the middle as the battle goes on
    const prog = log.length / N, [hx, hy] = home[team];
    const cx = clamp(Math.round(hx + (64 - hx) * prog * (0.3 + rnd(60) / 100)) + rnd(31) - 15);
    const cy = clamp(Math.round(hy + (64 - hy) * prog * (0.3 + rnd(60) / 100)) + rnd(31) - 15);
    const tool = ['pen', 'line', 'circle', 'polygon', 'pen', 'line'][rnd(6)];
    const near = () => [clamp(cx + rnd(25) - 12), clamp(cy + rnd(25) - 12)];
    const c = rnd(3) === 0 ? rnd(16) : 16 + team;
    e = tool === 'pen' ? { tool, pts: [[cx, cy]], c, f: 0 }
      : tool === 'line' ? { tool, pts: [[cx, cy], near()], c, f: 0 }
      : tool === 'circle' ? { tool, pts: [[cx, cy], [clamp(cx + 2 + rnd(6)), cy]], c, f: rnd(2) }
      : { tool, pts: [[cx, cy], near(), near()], c, f: 0 };
  }
  const n = log.length;
  const full = { n, ts: t, p: names[who], u: 'demo' + who, tm: team, ...e };
  const res = B.apply(board, full, n);
  if (res.error || (e.tool !== 'undo' && !res.changes.length)) continue;
  log.push(full);
  if (e.tool === 'undo') mine[who].splice(mine[who].indexOf(e.ref), 1); else mine[who].push(n);
}
const out = path.join(__dirname, '..', 'samples', 'demo-battle.ndjson');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, log.map(e => JSON.stringify(e)).join('\n') + '\n');
console.log(`Wrote ${log.length} actions (${log.filter(e => e.tool === 'undo').length} undos) to ${out}`);
