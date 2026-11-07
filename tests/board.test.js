/* Unit tests for undo (public/board.js). Run with:  npm test */
const assert = require('assert');
const B = require('../public/board.js');
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };
const px = (x, y, c) => ({ tool: 'pen', pts: [[x, y]], c, f: 0 });
const at = (b, x, y) => b.fb.data[y * b.fb.w + x];

test('undo restores the old colour', () => {
  const b = B.create(16, 16, 0);
  B.apply(b, px(3, 3, 5), 0);
  assert.strictEqual(at(b, 3, 3), 5);
  const r = B.apply(b, { tool: 'undo', ref: 0 }, 1);
  assert.deepStrictEqual(r.changes, [[3 * 16 + 3, 5, 0]]);
  assert.strictEqual(at(b, 3, 3), 0);
});

test('redo restores only pixels that still match the state left by undo', () => {
  const b = B.create(16, 16, 0);
  B.apply(b, { tool: 'line', pts: [[1, 1], [3, 1]], c: 5, f: 0 }, 0);
  B.apply(b, px(2, 1, 9), 1);                    // another player overwrites the middle pixel
  const undone = B.apply(b, { tool: 'undo', ref: 0 }, 2);
  assert.strictEqual(undone.changes.length, 2);
  const redone = B.apply(b, { tool: 'redo', ref: 0 }, 3);
  assert.deepStrictEqual(redone.changes, [[17, 0, 5], [19, 0, 5]]);
  assert.strictEqual(at(b, 1, 1), 5);
  assert.strictEqual(at(b, 2, 1), 9);
  assert.strictEqual(at(b, 3, 1), 5);
  assert(B.apply(b, { tool: 'redo', ref: 0 }, 4).error, 'the same drawing cannot be redone twice');
});

test('redo does not overwrite pixels drawn after undo and can be replayed', () => {
  const live = B.create(16, 16, 0), log = [
    px(4, 4, 5),
    { tool: 'undo', ref: 0 },
    px(4, 4, 9),
    { tool: 'redo', ref: 0 },
  ];
  log.forEach((entry, n) => assert(!B.apply(live, entry, n).error));
  assert.strictEqual(at(live, 4, 4), 9);
  assert.deepStrictEqual(B.apply(live, { tool: 'undo', ref: 0 }, 4).changes, []);
  const replay = B.create(16, 16, 0);
  log.forEach((entry, n) => assert(!B.apply(replay, entry, n).error));
  assert.deepStrictEqual(Array.from(replay.fb.data), Array.from(live.fb.data));
});

test('undo of a line removes the whole line', () => {
  const b = B.create(16, 16, 0);
  B.apply(b, { tool: 'line', pts: [[0, 0], [10, 4]], c: 7, f: 0 }, 0);
  assert(b.fb.data.some(v => v === 7));
  B.apply(b, { tool: 'undo', ref: 0 }, 1);
  assert(b.fb.data.every(v => v === 0));
});

test('a pixel somebody painted over later is NOT touched by my undo', () => {
  const b = B.create(16, 16, 0);
  B.apply(b, px(2, 2, 5), 0);                        // me
  B.apply(b, px(2, 2, 9), 1);                        // someone else paints over me
  const r = B.apply(b, { tool: 'undo', ref: 0 }, 2);
  assert.strictEqual(r.changes.length, 0);
  assert.strictEqual(at(b, 2, 2), 9);                // their colour stays
});

test('undoing the top action reveals the colour under it', () => {
  const b = B.create(16, 16, 0);
  B.apply(b, px(1, 1, 5), 0);
  B.apply(b, px(1, 1, 9), 1);
  B.apply(b, { tool: 'undo', ref: 1 }, 2);
  assert.strictEqual(at(b, 1, 1), 5);
});

test('undo order A, B on top, undo A first then B: pixel ends blank', () => {
  const b = B.create(16, 16, 0);
  B.apply(b, px(1, 1, 5), 0);                        // A
  B.apply(b, px(1, 1, 9), 1);                        // B on top
  B.apply(b, { tool: 'undo', ref: 0 }, 2);           // undo A (pixel belongs to B: unchanged)
  assert.strictEqual(at(b, 1, 1), 9);
  B.apply(b, { tool: 'undo', ref: 1 }, 3);           // undo B: must skip the undone A and go to blank
  assert.strictEqual(at(b, 1, 1), 0);
});

test('cannot undo twice, cannot undo something that never happened', () => {
  const b = B.create(16, 16, 0);
  B.apply(b, px(1, 1, 5), 0);
  assert(!B.apply(b, { tool: 'undo', ref: 0 }, 1).error);
  assert(B.apply(b, { tool: 'undo', ref: 0 }, 2).error);
  assert(B.apply(b, { tool: 'undo', ref: 42 }, 3).error);
});

test('bucket fill can be undone', () => {
  const b = B.create(16, 16, 0);
  B.apply(b, { tool: 'fill', pts: [[5, 5]], c: 4, f: 0 }, 0);
  assert(b.fb.data.every(v => v === 4));
  B.apply(b, { tool: 'undo', ref: 0 }, 1);
  assert(b.fb.data.every(v => v === 0));
});

test('RANDOM: replaying the log gives exactly the live canvas (500 runs x 60 entries)', () => {
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let run = 0; run < 500; run++) {
    const live = B.create(24, 24, 0), log = [];
    for (let k = 0; k < 60; k++) {
      let e;
      const undoable = log.map((x, i) => [x, i]).filter(([x, i]) => x.tool !== 'undo' && !log.some(y => y.tool === 'undo' && y.ref === i));
      if (rnd(4) === 0 && undoable.length) e = { tool: 'undo', ref: undoable[rnd(undoable.length)][1] };
      else {
        const t = ['pen', 'line', 'circle', 'polygon', 'fill'][rnd(5)], c = 1 + rnd(6), p = () => [rnd(24), rnd(24)];
        e = { tool: t, c, f: rnd(2), pts: t === 'pen' || t === 'fill' ? [p()] : t === 'polygon' ? [p(), p(), p()] : [p(), p()] };
      }
      const r = B.apply(live, e, log.length);
      if (!r.error) log.push(e);
    }
    const replay = B.create(24, 24, 0);
    log.forEach((e, n) => { assert(!B.apply(replay, e, n).error); });
    assert.deepStrictEqual(Array.from(replay.fb.data), Array.from(live.fb.data), 'run ' + run);
  }
});

console.log(`\n${passed} board tests passed`);
