/* Focused tests for DDA action validation and rasterization. */
const assert = require('assert');
const R = require('../public/raster.js');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

function rasterizedLine(start, end, size = 32) {
  const fb = R.createFB(size, size, 0);
  const action = { tool: 'dda', pts: [start, end], c: 1, f: 0 };
  const result = R.rasterize(fb, action);
  assert(!result.error, result.error);
  return { fb, action, idx: result.idx };
}

function expectedIndices(start, end, width) {
  const points = [];
  R.dda(start[0], start[1], end[0], end[1], (x, y) => points.push([x, y]));
  return points.map(([x, y]) => y * width + x);
}

for (const [description, start, end] of [
  ['horizontal line', [2, 3], [8, 3]],
  ['vertical line', [4, 1], [4, 7]],
  ['diagonal line', [1, 1], [6, 6]],
  ['shallow slope', [1, 2], [9, 5]],
  ['steep slope', [2, 1], [5, 9]],
  ['reversed endpoints', [9, 5], [1, 2]],
]) {
  test(`DDA rasterizes ${description} using its coordinate sequence`, () => {
    const { idx, action, fb } = rasterizedLine(start, end);
    assert.deepStrictEqual(idx, expectedIndices(start, end, fb.w));
    assert.strictEqual(idx[0], start[1] * fb.w + start[0]);
    assert.strictEqual(idx[idx.length - 1], end[1] * fb.w + end[0]);
    assert.strictEqual(new Set(idx).size, idx.length);
    assert.strictEqual(R.normalise(action, fb, 20).action.tool, 'dda');
  });
}

test('DDA includes the one pixel of a zero-length line', () => {
  const { idx } = rasterizedLine([5, 5], [5, 5]);
  assert.deepStrictEqual(idx, [5 * 32 + 5]);
});

test('DDA rasterization accepts the 700-pixel limit and rejects 701 pixels', () => {
  const fb = R.createFB(701, 2, 0);
  const atLimit = R.rasterize(fb, { tool: 'dda', pts: [[0, 0], [699, 0]], c: 1, f: 0 });
  assert.strictEqual(atLimit.idx.length, R.LIMITS.maxPixels);
  const overLimit = R.rasterize(fb, { tool: 'dda', pts: [[0, 0], [700, 0]], c: 1, f: 0 });
  assert.strictEqual(overLimit.error, 'Too big: 701 pixels (max 700)');
});

test('DDA validation rejects wrong point counts, invalid coordinates, and invalid colours', () => {
  const fb = R.createFB(8, 8, 0);
  const base = { tool: 'dda', c: 1, f: 0 };
  for (const action of [
    { ...base, pts: [[1, 1]] },
    { ...base, pts: [[1, 1], [2, 2], [3, 3]] },
    { ...base, pts: [[1.5, 1], [2, 2]] },
    { ...base, pts: [[1, 1], [8, 2]] },
    { ...base, c: 20, pts: [[1, 1], [2, 2]] },
  ]) {
    assert(R.normalise(action, fb, 20).error, JSON.stringify(action));
  }
});

console.log(`\n${passed} DDA tests passed`);
