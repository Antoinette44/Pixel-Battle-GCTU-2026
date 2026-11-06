/* Unit tests: our rasterizers must reproduce the worked examples from the Week 2 lecture. */
const assert = require('assert');
const R = require('../public/raster.js');
const P = require('../public/palette.js');
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };
const collect = (fn) => { const out = []; fn((x, y) => out.push([x, y])); return out; };

test('DDA (1,1)->(8,5) matches slide 11', () => {
  assert.deepStrictEqual(collect(p => R.dda(1, 1, 8, 5, p)),
    [[1,1],[2,2],[3,2],[4,3],[5,3],[6,4],[7,4],[8,5]]);
});
test('Bresenham (2,2)->(12,8) matches slide 14', () => {
  assert.deepStrictEqual(collect(p => R.bresenham(2, 2, 12, 8, p)),
    [[2,2],[3,3],[4,3],[5,4],[6,4],[7,5],[8,6],[9,6],[10,7],[11,7],[12,8]]);
});
test('Bresenham works in every direction and ends exactly on the end point', () => {
  for (const [x1, y1] of [[10,3],[-10,3],[10,-3],[-10,-3],[3,10],[-3,10],[3,-10],[-3,-10],[0,0],[7,7],[5,0],[0,5]]) {
    const pts = collect(p => R.bresenham(0, 0, x1, y1, p));
    assert.deepStrictEqual(pts[0], [0, 0]);
    assert.deepStrictEqual(pts[pts.length - 1], [x1, y1]);
    assert.strictEqual(pts.length, Math.max(Math.abs(x1), Math.abs(y1)) + 1);
    for (let i = 1; i < pts.length; i++) assert(Math.abs(pts[i][0]-pts[i-1][0]) <= 1 && Math.abs(pts[i][1]-pts[i-1][1]) <= 1, 'gap');
  }
});
test('Pen connects sampled pointer positions without gaps', () => {
  const fb = R.createFB(16, 16, 0);
  const action = { tool: 'pen', pts: [[1, 1], [6, 4], [9, 10]], c: 2, f: 0 };
  const result = R.applyAction(fb, action);
  assert(!result.error);
  for (let i = 1; i < result.changes.length; i++) {
    const [a, b] = [result.changes[i - 1][0], result.changes[i][0]];
    const ax = a % fb.w, ay = (a / fb.w) | 0, bx = b % fb.w, by = (b / fb.w) | 0;
    assert(Math.max(Math.abs(ax - bx), Math.abs(ay - by)) <= 1, 'stroke contains a gap');
  }
  assert.strictEqual(R.normalise({ ...action, pts: new Array(R.LIMITS.maxPathPoints + 1).fill([0, 0]) }, fb, P.NUM).error, 'Wrong number of points');
});
test('setPixel leaves out-of-bounds coordinates unchanged', () => {
  const fb = R.createFB(3, 3, 0);
  assert.strictEqual(R.setPixel(fb, 0, 0, 4), true);
  assert.strictEqual(R.setPixel(fb, -1, 0, 2), false);
  assert.strictEqual(R.setPixel(fb, 3, 2, 2), false);
  assert.strictEqual(R.setPixel(fb, 0, 3, 2), false);
  assert.deepStrictEqual(Array.from(fb.data), [4, 0, 0, 0, 0, 0, 0, 0, 0]);
});
test('Midpoint circle r=10 first octant matches slide 17', () => {
  const o = []; R.midpointCircle(10, (x, y) => o.push([x, y]));
  assert.deepStrictEqual(o, [[0,10],[1,10],[2,10],[3,10],[4,9],[5,9],[6,8],[7,7]]);
});
test('Circle is symmetric and a filled disc has the right area (approx pi r^2)', () => {
  const ring = new Set(collect(p => R.circle(20, 20, 8, p, false)).map(q => q.join(',')));
  for (const k of ring) { const [x, y] = k.split(',').map(Number); assert(ring.has((40 - x) + ',' + y)); assert(ring.has(x + ',' + (40 - y))); }
  const disc = new Set(collect(p => R.circle(20, 20, 8, p, true)).map(q => q.join(',')));
  assert(Math.abs(disc.size - Math.PI * 64) < 20, 'area ' + disc.size);
});
test('Scan-line fill: square and concave shape (even-odd rule)', () => {
  const fb = R.createFB(16, 16, 0);
  const r = R.rasterize(fb, { tool: 'polygon', pts: [[2,2],[6,2],[6,6],[2,6]], c: 1, f: 0 });
  assert.strictEqual(r.idx.length, 25);
  // a "U" shape: the notch must stay empty at y = 5
  const u = R.rasterize(fb, { tool: 'polygon', pts: [[1,1],[3,1],[3,5],[7,5],[7,1],[9,1],[9,9],[1,9]], c: 1, f: 0 });
  const row3 = new Set(u.idx.filter(i => ((i / 16) | 0) === 3).map(i => i % 16));
  assert(row3.has(2) && row3.has(3) && !row3.has(5) && row3.has(7) && row3.has(8));
});
test('Flood fill is 4-connected, stops at walls, respects the size limit', () => {
  const fb = R.createFB(5, 5, 0);
  for (let y = 0; y < 5; y++) R.setPixel(fb, 2, y, 3);                 // vertical wall
  assert.strictEqual(R.floodFill(fb, 0, 0, 1, 100).length, 10);
  assert.strictEqual(R.floodFill(fb, 0, 0, 0, 100).length, 0);        // same colour: nothing to do
  assert.strictEqual(R.floodFill(fb, 0, 0, 1, 5), null);              // too big
  const d = R.createFB(4, 4, 0);                                       // diagonal wall: 4-connected must not leak through
  for (let i = 0; i < 4; i++) R.setPixel(d, i, i, 3);
  assert.strictEqual(R.floodFill(d, 3, 0, 1, 100).length, 6);
});
test('normalise rejects bad input', () => {
  const fb = R.createFB(128, 128, 0);
  for (const bad of [null, {}, { tool: 'x' }, { tool: 'pen', c: 99, pts: [[1,1]] }, { tool: 'pen', c: 1, pts: [[200,1]] },
                     { tool: 'line', c: 1, pts: [[1,1]] }, { tool: 'pen', c: 1, pts: [[1.5,1]] }, { tool: 'polygon', c: 1, pts: new Array(9).fill([1,1]) }])
    assert(R.normalise(bad, fb, P.NUM).error, JSON.stringify(bad));
  assert(R.normalise({ tool: 'pen', c: 1, pts: [[1, 1]] }, fb, P.NUM).action);
});
test('size limits: huge line/polygon rejected', () => {
  const fb = R.createFB(128, 128, 0);
  assert(R.applyAction(fb, { tool: 'polygon', pts: [[0,0],[120,0],[120,120],[0,120]], c: 1, f: 0 }).error);
  assert(R.applyAction(fb, { tool: 'circle', pts: [[60,60],[100,60]], c: 1, f: 0 }).error);
  assert(R.applyAction(fb, { tool: 'fill', pts: [[5,5]], c: 1, f: 0 }).error);
});
test('Palette: HSB<->RGB round trip and lecture example (224,103,66)', () => {
  assert.deepStrictEqual(P.rgbToHsb(224, 103, 66), { h: 14, s: 71, b: 88 });
  for (const c of P.COLOURS) { const back = P.hsbToRgb(c.h, c.s, c.b); assert.deepStrictEqual(back, c.rgb); }
  assert.strictEqual(P.COLOURS.length, 20); assert.strictEqual(P.hsbToRgb(0, 100, 100).join(), '255,0,0');
  assert.strictEqual(P.toHex([224, 103, 66]), '#E06742');
});
console.log(`\n${passed} tests passed`);
