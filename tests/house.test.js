/* House evaluator tests use real Board.apply and the shared rasterizers. */
const assert = require('assert');
const Board = require('../public/board.js');
const Config = require('../lib/house-config.js');
const { evaluateAll, evaluateTeam } = require('../lib/house-evaluator.js');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

function context(board, log, debug = false) {
  return { size: board.fb.w, board, log, zoneRect: Board.zoneRect, debug };
}

function point(zone, u, v) {
  return [zone[0] + u, zone[1] + v];
}

function action(tool, pts, zone, options = {}) {
  return {
    tool,
    pts: pts.map(([u, v]) => point(zone, u, v)),
    c: options.c === undefined ? 2 : options.c,
    f: options.f || 0,
    tm: options.team === undefined ? 0 : options.team,
    ...(tool === 'fill' ? { clip: zone } : {}),
  };
}

function recipe(team) {
  const zone = Board.zoneRect(128, team);
  return [
    { id: 'wall-top', ...action('line', [[16, 32], [47, 32]], zone, { team, c: 2 }) },
    { id: 'wall-right', ...action('line', [[47, 32], [47, 55]], zone, { team, c: 3 }) },
    { id: 'wall-bottom', ...action('line', [[47, 55], [16, 55]], zone, { team, c: 4 }) },
    { id: 'wall-left', ...action('line', [[16, 55], [16, 32]], zone, { team, c: 5 }) },
    { id: 'roof-left', ...action('dda', [[12, 32], [32, 14]], zone, { team, c: 6 }) },
    { id: 'roof-right', ...action('line', [[51, 32], [32, 14]], zone, { team, c: 7 }) },
    { id: 'roof-base', ...action('line', [[12, 32], [51, 32]], zone, { team, c: 8 }) },
    { id: 'roof-polygon', ...action('polygon', [[12, 32], [51, 32], [32, 14]], zone, { team, c: 9 }) },
    { id: 'door', ...action('polygon', [[28, 44], [35, 44], [35, 55], [28, 55]], zone, { team, c: 10 }) },
    { id: 'window-left', ...action('polygon', [[20, 38], [25, 38], [25, 43], [20, 43]], zone, { team, c: 11 }) },
    { id: 'window-right', ...action('polygon', [[38, 38], [43, 38], [43, 43], [38, 43]], zone, { team, c: 12 }) },
    { id: 'sun', ...action('circle', [[54, 8], [59, 8]], zone, { team, c: 13, f: 1 }) },
    { id: 'bucket', ...action('fill', [[20, 50]], zone, { team, c: 5 }) },
  ];
}

function applyEntries(entries, team = 0) {
  const board = Board.create(128, 128, 0);
  const log = [];
  const results = new Map();
  for (const raw of entries) {
    const entry = { ...raw, tm: team };
    const result = Board.apply(board, entry, log.length);
    results.set(raw.id, result);
    if (!result.error) log.push(entry);
  }
  return { board, log, results };
}

function score(entries, team = 0, debug = false) {
  const state = applyEntries(entries, team);
  return { ...state, result: evaluateTeam(context(state.board, state.log, debug), team) };
}

function marksLoss(before, after) {
  return before.marks - after.marks;
}

function normalizedClaims(result, log) {
  return result.debug.claims.map(claim => {
    const entry = log[claim.actionIndex];
    let points = entry.pts;
    if (entry.tool === 'polygon') {
      const edges = claim.role === 'roof'
        ? { base: 0, right: 1, left: 2 }
        : { top: 0, right: 1, bottom: 2, left: 3 };
      const edgeIndex = edges[claim.edge];
      points = [entry.pts[edgeIndex], entry.pts[(edgeIndex + 1) % entry.pts.length]];
    }
    return `${claim.role}|${claim.edge}|${points.map(point => point.join(',')).sort().join(';')}`;
  }).sort();
}

function seededShuffle(items, seed) {
  const out = items.slice();
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function withFillAfterWalls(entries) {
  const walls = entries.filter(entry => entry.id.startsWith('wall-'));
  const other = entries.filter(entry => !entry.id.startsWith('wall-') && entry.id !== 'bucket');
  const fill = entries.find(entry => entry.id === 'bucket');
  return [...walls, ...other, fill];
}

test('T-REF: reference house scores 100 marks with the exact breakdown in every zone', () => {
  const expectedClaims = [
    ['walls', 0, 'top'], ['walls', 1, 'right'], ['walls', 2, 'bottom'], ['walls', 3, 'left'],
    ['roof', 4, 'left'], ['roof', 5, 'right'], ['roof', 6, 'base'],
    ['door', 8, 'top'], ['door', 8, 'right'], ['door', 8, 'bottom'], ['door', 8, 'left'],
    ['windows', 9, 'top'], ['windows', 9, 'right'], ['windows', 9, 'bottom'], ['windows', 9, 'left'],
    ['windows', 10, 'top'], ['windows', 10, 'right'], ['windows', 10, 'bottom'], ['windows', 10, 'left'],
    ['sun', 11, 'circle'],
  ].map(([role, actionIndex, edge]) => ({ role, actionIndex, edge }));

  const breakdowns = [];
  for (let team = 0; team < 4; team++) {
    const { board, log, results } = applyEntries(recipe(team), team);
    const fillResult = results.get('bucket');
    assert(!fillResult.error, fillResult.error);
    assert.strictEqual(fillResult.changes.length, 500);
    const result = evaluateTeam(context(board, log, true), team);
    assert.strictEqual(result.units, 400);
    assert.strictEqual(result.marks, 100);
    assert.deepStrictEqual(result.house, { walls: 15, roof: 15, door: 10, windows: 10, sun: 10 });
    assert.deepStrictEqual(result.algo, { dda: 10, bresenham: 10, midpoint: 10, scanline: 5, flood: 5 });
    assert.deepStrictEqual(result.debug.frame, { x0: 16, y0: 32, x1: 47, y1: 55, width: 32, height: 24 });
    assert.deepStrictEqual(result.debug.claims, expectedClaims);
    const rolesByAction = new Map();
    for (const claim of result.debug.claims) {
      if (['dda', 'bresenham', 'midpoint', 'scanline', 'flood'].includes(claim.role)) continue;
      const key = `${claim.actionIndex}:${claim.edge}`;
      assert(!rolesByAction.has(key), `segment claimed twice: ${key}`);
      rolesByAction.set(key, claim.role);
    }
    const overlaps = [
      ['dda', 4], ['bresenham', 5], ['midpoint', 11],
    ].filter(([, actionIndex]) => result.debug.claims.some(claim => claim.actionIndex === actionIndex) &&
      result.items.some(item => item.evidence.includes(actionIndex) &&
        ['dda', 'bresenham', 'midpoint'].includes(item.id))).sort();
    assert.deepStrictEqual(overlaps, [['bresenham', 5], ['dda', 4], ['midpoint', 11]]);
    for (const [id, evidence] of Object.entries({
      dda: [4], bresenham: [5], midpoint: [11], scanline: [7], flood: [12],
    })) assert.deepStrictEqual(result.items.find(value => value.id === id).evidence, evidence);
    for (const item of result.items) assert.strictEqual(item.status, 'full', item.id);
    const flood = log[12];
    assert.strictEqual(board.hist.get(12).before.length, 500);
    assert(board.hist.get(12).before.every(change => change[1] === 0));
    assert(board.hist.get(12).before.every(([index]) => {
      const x = index % 128 - Board.zoneRect(128, team)[0];
      const y = Math.floor(index / 128) - Board.zoneRect(128, team)[1];
      return x > 0 && y > 0 && x < 63 && y < 63;
    }));
    assert.strictEqual(flood.tool, 'fill');
    breakdowns.push({ house: result.house, algo: result.algo });
  }
  assert.deepStrictEqual(breakdowns[1], breakdowns[0]);
  assert.deepStrictEqual(breakdowns[2], breakdowns[0]);
  assert.deepStrictEqual(breakdowns[3], breakdowns[0]);
});

test('T-ORD: recipe order, reverse, walls-last, roof-first, and 20 fixed shuffles are equivalent', () => {
  const base = recipe(0);
  const orderedRecipes = [
    base,
    base.slice().reverse(),
    [...base.filter(entry => !entry.id.startsWith('wall-')), ...base.filter(entry => entry.id.startsWith('wall-'))],
    [...base.filter(entry => entry.id.startsWith('roof-')), ...base.filter(entry => !entry.id.startsWith('roof-'))],
    [base[7], ...base.slice(0, 7), ...base.slice(8)],
    [...base.filter(entry => entry.id.startsWith('door') || entry.id.startsWith('window')), ...base.filter(entry => !entry.id.startsWith('door') && !entry.id.startsWith('window'))],
    [base[11], ...base.filter(entry => entry.id !== 'sun')],
  ];
  for (let seed = 0; seed < 20; seed++) orderedRecipes.push(seededShuffle(base, seed + 100));

  const reference = score(base, 0, true).result;
  const referenceClaims = normalizedClaims(reference, score(base, 0, true).log);
  for (const [orderIndex, recipeOrder] of orderedRecipes.entries()) {
    const orderedEntries = withFillAfterWalls(recipeOrder);
    const { result, log } = score(orderedEntries, 0, true);
    assert.strictEqual(result.units, reference.units,
      `order ${orderIndex}: ${JSON.stringify({ house: result.house, algo: result.algo, items: result.items.map(value => [value.id, value.units, value.status]) })}`);
    assert.deepStrictEqual(result.house, reference.house);
    assert.deepStrictEqual(result.algo, reference.algo);
    assert.deepStrictEqual(result.debug.frame, reference.debug.frame);
    assert.deepStrictEqual(normalizedClaims(result, log), referenceClaims);
  }
});

test('dependent items wait for three credited wall sides and update automatically', () => {
  const zone = Board.zoneRect(128, 0);
  const entries = recipe(0).filter(entry => entry.id === 'roof-left' || entry.id === 'roof-right' ||
    entry.id === 'roof-base' || entry.id === 'roof-polygon' || entry.id === 'sun');
  let state = score(entries, 0);
  for (const dependent of ['roof', 'door', 'windows', 'sun']) {
    const item = state.result.items.find(value => value.id === dependent);
    assert.strictEqual(item.status, 'waiting');
    assert.strictEqual(item.hint, 'draw the walls: 3 sides needed');
  }

  const walls = recipe(0).filter(entry => entry.id === 'wall-top' || entry.id === 'wall-right');
  state = score([...entries, ...walls], 0);
  assert.strictEqual(state.result.items.find(value => value.id === 'walls').units, 30);
  assert(state.result.items.filter(value => ['roof', 'door', 'windows', 'sun'].includes(value.id))
    .every(value => value.status === 'waiting'));

  const thirdWall = action('line', [[16, 55], [47, 55]], zone, { team: 0 });
  state = score([...entries, ...walls, thirdWall], 0);
  assert.strictEqual(state.result.items.find(value => value.id === 'walls').units, 45);
  assert(state.result.items.filter(value => ['roof', 'door', 'windows', 'sun'].includes(value.id))
    .every(value => value.status !== 'waiting'));
});

test('three-sided door is credited and does not take the bottom-wall claim', () => {
  const zone = Board.zoneRect(128, 0);
  const walls = recipe(0).filter(entry => entry.id.startsWith('wall-'));
  const doorSides = [
    action('line', [[28, 44], [35, 44]], zone),
    action('line', [[28, 44], [28, 55]], zone),
    action('line', [[35, 44], [35, 55]], zone),
  ];
  const { result } = score([...walls, ...doorSides], 0, true);
  assert.strictEqual(result.house.door, 10);
  const doorClaims = result.debug.claims.filter(claim => claim.role === 'door');
  assert.strictEqual(doorClaims.length, 3);
  assert(!doorClaims.some(claim => claim.edge === 'bottom'));
  assert(result.debug.claims.some(claim => claim.role === 'walls' && claim.edge === 'bottom'));
});

test('wall and roof scores support honest partial credit after pixels are overpainted', () => {
  const entries = recipe(0);
  const board = Board.create(128, 128, 0), log = [];
  for (const raw of entries.filter(entry => entry.id.startsWith('wall-') || entry.id === 'roof-polygon')) {
    const entry = { ...raw, tm: 0 };
    assert(!Board.apply(board, entry, log.length).error);
    log.push(entry);
  }
  const zone = Board.zoneRect(128, 0);
  const overpaint = action('line', [[16, 32], [22, 32]], zone, { team: 1, c: 14 });
  overpaint.tm = 1;
  assert(!Board.apply(board, overpaint, log.length).error);
  log.push(overpaint);
  let result = evaluateTeam(context(board, log), 0);
  assert.strictEqual(result.house.walls, 11.25);
  assert.strictEqual(result.items.find(value => value.id === 'walls').status, 'partial');
  assert.strictEqual(result.house.roof, 10);
  assert.strictEqual(result.items.find(value => value.id === 'roof').status, 'partial');
});

test('axis alignment uses two pixels; corner and roof-base tolerances are three pixels', () => {
  assert.strictEqual(Config.AXIS_TOL, 2);
  assert.strictEqual(Config.CORNER_TOL, 3);
  assert.strictEqual(Config.ROOF_BASE_TOL, 3);
  const zone = Board.zoneRect(128, 0);
  function wallTopWithDeviation(deviation) {
    const wallEntries = [
      action('line', [[16, 32], [47, 32 + deviation]], zone),
      action('line', [[47, 32], [47, 55]], zone),
      action('line', [[47, 55], [16, 55]], zone),
      action('line', [[16, 55], [16, 32]], zone),
    ];
    return score(wallEntries, 0).result.house.walls;
  }
  assert.strictEqual(wallTopWithDeviation(2), 15);
  assert.strictEqual(wallTopWithDeviation(3), 11.25);
  assert.strictEqual(wallTopWithDeviation(4), 11.25);

  function roofWithCornerGap(gap) {
    const roofEntries = recipe(0).filter(entry => entry.id.startsWith('wall-') || entry.id === 'roof-left' ||
      entry.id === 'roof-base');
    roofEntries.push(action('line', [[51 + gap, 32], [32, 14]], zone));
    const { result } = score(roofEntries, 0);
    return result.house.roof;
  }
  assert.strictEqual(roofWithCornerGap(3), 15);
  assert.strictEqual(roofWithCornerGap(4), 0);

  function roofWithBaseOffset(offset) {
    const roofEntries = recipe(0).filter(entry => entry.id.startsWith('wall-'));
    roofEntries.push(action('dda', [[12, 32 + offset], [32, 14 + offset]], zone));
    roofEntries.push(action('line', [[51, 32 + offset], [32, 14 + offset]], zone));
    roofEntries.push(action('line', [[12, 32 + offset], [51, 32 + offset]], zone));
    return score(roofEntries, 0).result.house.roof;
  }
  assert.strictEqual(roofWithBaseOffset(3), 15);
  assert.strictEqual(roofWithBaseOffset(4), 0);
});

test('equal totals remain tied even when teams have different house and algorithm breakdowns', () => {
  const board = Board.create(128, 128, 0);
  const log = [];
  function add(entry) {
    const result = Board.apply(board, entry, log.length);
    assert(!result.error, result.error);
    log.push(entry);
  }
  const redZone = Board.zoneRect(128, 0), blueZone = Board.zoneRect(128, 1);
  for (const [a, b] of [
    [[16, 32], [47, 32]], [[47, 32], [47, 55]], [[47, 55], [16, 55]],
  ]) add({ ...action('line', [a, b], redZone, { team: 0 }), tm: 0 });
  add({ ...action('polygon', [[28, 44], [35, 44], [35, 55], [28, 55]], redZone, { team: 0, c: 10 }), tm: 0 });
  for (const [a, b] of [
    [[16, 32], [47, 32]], [[47, 32], [47, 55]], [[47, 55], [16, 55]],
  ]) add({ ...action('line', [a, b], blueZone, { team: 1 }), tm: 1 });
  add({ ...action('dda', [[16, 10], [28, 16]], blueZone, { team: 1 }), tm: 1 });
  add({ ...action('polygon', [[2, 2], [10, 2], [10, 10], [2, 10]], blueZone, { team: 1, c: 11 }), tm: 1 });

  const scores = evaluateAll(context(board, log));
  assert.deepStrictEqual(scores.map(result => result.team), [0, 1, 2, 3]);
  assert.strictEqual(scores[0].house.door, 10);
  assert.strictEqual(scores[0].algo.dda, 0);
  assert.strictEqual(scores[1].house.door, 0);
  assert.strictEqual(scores[1].algo.dda, 10);
  assert.strictEqual(scores[0].marks, scores[1].marks);
  const best = Math.max(...scores.map(result => result.marks));
  assert.deepStrictEqual(scores.filter(result => result.marks === best).map(result => result.team), [0, 1]);
});

test('approved leave-one-out cases lose exactly the specified marks', () => {
  const full = score(recipe(0), 0).result;
  const expectedLoss = new Map([
    ['wall-right', 8.75], ['wall-bottom', 8.75], ['wall-left', 8.75],
    ['wall-top', 3.75],
    ['roof-left', 10], ['roof-right', 10], ['roof-base', 0],
    // Per the selected literal §6.2 tie-break, another eligible polygon can replace the roof polygon.
    ['roof-polygon', 0],
    ['door', 10], ['window-left', 5], ['window-right', 5], ['sun', 20], ['bucket', 5],
  ]);
  for (const [id, loss] of expectedLoss) {
    const result = score(recipe(0).filter(entry => entry.id !== id), 0).result;
    assert.strictEqual(marksLoss(full, result), loss, `${id} removed`);
  }
});

test('undo removes and redo restores DDA marks from active-action state', () => {
  const board = Board.create(128, 128, 0), log = [];
  const zone = Board.zoneRect(128, 0);
  const entry = { ...action('dda', [[10, 10], [22, 16]], zone), tm: 0 };
  assert(!Board.apply(board, entry, 0).error);
  log.push(entry);
  assert.strictEqual(evaluateTeam(context(board, log), 0).algo.dda, 10);
  const undo = { tool: 'undo', ref: 0, tm: 0 };
  assert(!Board.apply(board, undo, 1).error);
  log.push(undo);
  assert.strictEqual(evaluateTeam(context(board, log), 0).algo.dda, 0);
  const redo = { tool: 'redo', ref: 0, tm: 0 };
  assert(!Board.apply(board, redo, 2).error);
  log.push(redo);
  assert.strictEqual(evaluateTeam(context(board, log), 0).algo.dda, 10);
});

test('flood marks require untouched background, visible ownership, and no zone-edge pixels', () => {
  const zone = Board.zoneRect(128, 0);
  const enclosure = [
    action('line', [[10, 10], [20, 10]], zone),
    action('line', [[20, 10], [20, 20]], zone),
    action('line', [[20, 20], [10, 20]], zone),
    action('line', [[10, 20], [10, 10]], zone),
  ];
  const initialFill = action('fill', [[15, 15]], zone, { c: 3 });
  let state = score([...enclosure, initialFill], 0);
  assert.strictEqual(state.result.algo.flood, 5);
  const colouredRegion = action('polygon', [[10, 10], [20, 10], [20, 20], [10, 20]], zone, { c: 3 });
  const recolour = action('fill', [[15, 15]], zone, { c: 4 });
  state = score([colouredRegion, recolour], 0);
  assert.strictEqual(state.result.algo.flood, 0);

  const edgeEnclosure = [
    action('line', [[0, 5], [10, 5]], zone),
    action('line', [[10, 5], [10, 15]], zone),
    action('line', [[10, 15], [0, 15]], zone),
  ];
  const edgeFill = action('fill', [[5, 10]], zone, { c: 6 });
  state = score([...edgeEnclosure, edgeFill], 0);
  assert.strictEqual(state.result.algo.flood, 0);
});

test('colour-zero drawing is invisible and never receives marks', () => {
  const zone = Board.zoneRect(128, 0);
  const invisible = action('dda', [[10, 10], [22, 16]], zone, { c: 0 });
  const { result } = score([invisible], 0);
  assert.strictEqual(result.algo.dda, 0);
  assert.strictEqual(result.marks, 0);
});

test('evaluator rejects invalid team and malformed context explicitly', () => {
  const board = Board.create(128, 128, 0);
  assert.throws(() => evaluateTeam(context(board, []), 4), /team must be an integer/);
  assert.throws(() => evaluateTeam({}, 0), /ctx must include board and log/);
});

assert.strictEqual(Config.MARKS.walls, 15);
console.log(`\n${passed} house evaluator tests passed`);
