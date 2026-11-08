/* Eraser raster, board ownership, and history tests. Run: node tests/eraser.test.js */
const assert = require('assert');
const Raster = require('../public/raster.js');
const Board = require('../public/board.js');
const Palette = require('../public/palette.js');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };
const pixel = (x, y, colour, team) => ({ tool: 'pen', pts: [[x, y]], c: colour, f: 0, tm: team });
const teamPixels = (board, team) => Array.from(board.teams).filter(owner => owner === team).length;

test('eraser raster uses a connected 5-pixel circular brush with bounded endpoints', () => {
  const fb = Raster.createFB(16, 16, Palette.BG);
  const action = { tool: 'eraser', pts: [[3, 5], [8, 5]], c: Palette.BG, f: 0 };
  const result = Raster.rasterize(fb, action);
  assert(!result.error, result.error);
  const points = new Set(result.idx);
  for (let x = 3; x <= 8; x++) assert(points.has(5 * fb.w + x));
  assert(points.has(4 * fb.w + 2));
  assert(!points.has(5 * fb.w + 0));
  assert.strictEqual(Raster.rasterize(fb, { ...action, pts: [[0, 0]] }).idx.length, 6);
  assert(Raster.normalise({ ...action, pts: [[16, 5]] }, fb, Palette.NUM).error);
  assert(Raster.normalise({ ...action, pts: [] }, fb, Palette.NUM).error);
});

test('eraser removes only its footprint and clears both colour and team ownership', () => {
  const board = Board.create(64, 64, Palette.BG);
  assert(!Board.apply(board, { tool: 'circle', pts: [[20, 12], [25, 12]], c: 4, f: 1, tm: 0 }, 0).error);
  const sun = Raster.rasterize(board.fb, { tool: 'circle', pts: [[20, 12], [25, 12]], c: 4, f: 1 }).idx;
  assert(!Board.apply(board, { tool: 'polygon', pts: [[10, 35], [38, 35], [24, 24]], c: 5, f: 1, tm: 0 }, 1).error);
  assert(!Board.apply(board, { tool: 'polygon', pts: [[12, 36], [36, 36], [36, 56], [12, 56]], c: 6, f: 1, tm: 0 }, 2).error);
  const houseBefore = [35 * 64 + 20, 30 * 64 + 24, 45 * 64 + 12].map(i => [board.fb.data[i], board.teams[i]]);
  const beforeScore = teamPixels(board, 0);

  const erased = Board.apply(board, {
    tool: 'eraser', pts: [[15, 8], [25, 8], [25, 12], [15, 12], [15, 16], [25, 16]],
    c: Palette.BG, f: 0, tm: 0,
  }, 3);
  assert(!erased.error, erased.error);
  assert(erased.changes.length > 0);
  for (const i of sun) {
    assert.strictEqual(board.fb.data[i], Palette.BG, 'sun colour remains at pixel ' + i);
    assert.strictEqual(board.teams[i], -1, 'sun owner remains at pixel ' + i);
  }
  assert.deepStrictEqual([35 * 64 + 20, 30 * 64 + 24, 45 * 64 + 12].map(i => [board.fb.data[i], board.teams[i]]), houseBefore);
  assert(teamPixels(board, 0) < beforeScore);
});

test('a short eraser tap removes only occupied pixels within the brush', () => {
  const board = Board.create(16, 16, Palette.BG);
  assert(!Board.apply(board, pixel(8, 8, 3, 0), 0).error);
  assert(!Board.apply(board, pixel(10, 8, 4, 1), 1).error);
  assert(!Board.apply(board, pixel(11, 8, 5, 0), 2).error); // outside the circular brush footprint
  const result = Board.apply(board, { tool: 'eraser', pts: [[8, 8]], c: Palette.BG, f: 0, tm: 0 }, 3);
  assert(!result.error, result.error);
  assert.strictEqual(board.fb.data[8 * 16 + 8], Palette.BG);
  assert.strictEqual(board.teams[8 * 16 + 8], -1);
  assert.strictEqual(board.fb.data[8 * 16 + 10], Palette.BG);
  assert.strictEqual(board.teams[8 * 16 + 10], -1);
  assert.strictEqual(board.fb.data[8 * 16 + 11], 5);
  assert.strictEqual(board.teams[8 * 16 + 11], 0);
});

test('eraser Undo and Redo restore and remove colours, owners, and scores', () => {
  const board = Board.create(24, 24, Palette.BG);
  assert(!Board.apply(board, { tool: 'line', pts: [[4, 8], [16, 8]], c: 3, f: 0, tm: 1 }, 0).error);
  const drawnScore = teamPixels(board, 1);
  const eraser = { tool: 'eraser', pts: [[10, 8]], c: Palette.BG, f: 0, tm: 0 };
  assert(!Board.apply(board, eraser, 1).error);
  const erasedScore = teamPixels(board, 1);
  assert(erasedScore < drawnScore);
  assert(!Board.apply(board, { tool: 'undo', ref: 1 }, 2).error);
  assert.strictEqual(teamPixels(board, 1), drawnScore);
  assert.strictEqual(board.fb.data[8 * 24 + 10], 3);
  assert.strictEqual(board.teams[8 * 24 + 10], 1);
  assert(!Board.apply(board, { tool: 'redo', ref: 1 }, 3).error);
  assert.strictEqual(teamPixels(board, 1), erasedScore);
  assert.strictEqual(board.fb.data[8 * 24 + 10], Palette.BG);
  assert.strictEqual(board.teams[8 * 24 + 10], -1);
});

console.log(`\n${passed} eraser tests passed`);
