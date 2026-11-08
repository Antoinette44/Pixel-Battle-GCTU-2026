'use strict';

const Raster = require('../public/raster.js');
const Board = require('../public/board.js');
const Config = require('./house-config.js');

const { AXIS_TOL, CORNER_TOL, ENDPOINT_SEGMENT_TOL } = Config;
const pointKey = (point) => `${point[0]},${point[1]}`;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const segmentSteps = (a, b) => Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
const isHorizontal = (a, b) => Math.abs(a[1] - b[1]) <= AXIS_TOL;
const isVertical = (a, b) => Math.abs(a[0] - b[0]) <= AXIS_TOL;
const isNearAxis = (a, b) => isHorizontal(a, b) || isVertical(a, b);

function pointSegmentDistance(point, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return distance(point, a);
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared));
  return distance(point, [a[0] + t * dx, a[1] + t * dy]);
}

function zoneFor(ctx, team) {
  const rect = typeof ctx.zoneRect === 'function'
    ? ctx.zoneRect(ctx.size, team)
    : Board.zoneRect(ctx.size, team);
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) {
    throw new TypeError('zoneRect must return [x0, y0, x1, y1]');
  }
  const [x0, y0, x1, y1] = rect;
  return { rect, x0, y0, x1, y1, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

function inside(zone, x, y) {
  return x >= zone.x0 && x <= zone.x1 && y >= zone.y0 && y <= zone.y1;
}

function makeActiveActions(ctx, team, zone) {
  const actions = [];
  for (let actionIndex = 0; actionIndex < ctx.log.length; actionIndex++) {
    const entry = ctx.log[actionIndex];
    if (!entry || entry.tool === 'undo' || entry.tool === 'redo' || entry.tm !== team) continue;
    const history = ctx.board.hist.get(actionIndex);
    if (!history || history.undone) continue;

    let footprint;
    if (entry.tool === 'fill') {
      footprint = (history.before || []).map(record => record[0]);
    } else {
      const raster = Raster.rasterize(ctx.board.fb, entry, true);
      if (raster.error) continue;
      footprint = raster.idx;
    }
    const localFootprint = [...new Set(footprint.filter(index => {
      const x = index % ctx.size, y = Math.floor(index / ctx.size);
      return inside(zone, x, y);
    }))];
    const action = {
      actionIndex,
      entry,
      history,
      footprint: localFootprint,
      coverage: coverage(ctx.board, team, localFootprint),
      segments: [],
    };
    const pts = entry.pts || [];
    if (entry.tool === 'line' || entry.tool === 'dda') {
      makeSegment(ctx, team, zone, action, 0, pts[0], pts[1], entry.tool);
    } else if (entry.tool === 'pen') {
      for (let i = 1; i < pts.length; i++) {
        makeSegment(ctx, team, zone, action, i - 1, pts[i - 1], pts[i], 'pen');
      }
    } else if (entry.tool === 'polygon') {
      for (let i = 0; i < pts.length; i++) {
        makeSegment(ctx, team, zone, action, i, pts[i], pts[(i + 1) % pts.length], 'polygon');
      }
    }
    actions.push(action);
  }
  return actions;
}

function coverage(board, team, indices) {
  if (!indices.length) return 0;
  let visible = 0;
  for (const index of indices) {
    if (board.teams[index] === team && board.fb.data[index] !== 0) visible++;
  }
  return visible / indices.length;
}

function makeSegment(ctx, team, zone, action, edgeIndex, from, to, tool) {
  const localA = [from[0] - zone.x0, from[1] - zone.y0];
  const localB = [to[0] - zone.x0, to[1] - zone.y0];
  const pixels = new Set();
  const plot = (x, y) => {
    if (!inside(zone, x, y)) return;
    pixels.add(y * ctx.size + x);
  };
  const raster = tool === 'dda' ? Raster.dda : Raster.bresenham;
  raster(from[0], from[1], to[0], to[1], plot);
  const indices = [...pixels];
  const segmentCoverage = coverage(ctx.board, team, indices);
  const segment = {
    id: `${action.actionIndex}:${edgeIndex}`,
    actionIndex: action.actionIndex,
    edgeIndex,
    tool,
    a: localA,
    b: localB,
    pixels: indices,
    coverage: segmentCoverage,
    verified: segmentCoverage >= Config.COVERAGE_MIN,
  };
  action.segments.push(segment);
  return segment;
}

function endpointsGraph(segments) {
  const endpoints = [];
  for (const segment of segments) {
    segment.endpointIndexes = [endpoints.length, endpoints.length + 1];
    endpoints.push({ point: segment.a, segment, side: 0 }, { point: segment.b, segment, side: 1 });
  }
  const parent = endpoints.map((_, index) => index);
  const find = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const buckets = new Map();
  for (let i = 0; i < endpoints.length; i++) {
    const point = endpoints[i].point;
    const bx = Math.floor(point[0] / CORNER_TOL), by = Math.floor(point[1] / CORNER_TOL);
    for (let x = bx - 1; x <= bx + 1; x++) {
      for (let y = by - 1; y <= by + 1; y++) {
        const bucket = buckets.get(`${x},${y}`) || [];
        for (const other of bucket) {
          if (distance(point, endpoints[other].point) <= CORNER_TOL) union(i, other);
        }
      }
    }
    const key = `${bx},${by}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(i);
  }

  const roots = [...new Set(endpoints.map((_, index) => find(index)))].sort((a, b) => a - b);
  const rootToNode = new Map(roots.map((root, index) => [root, index]));
  const pointsByNode = roots.map(() => []);
  endpoints.forEach((endpoint, index) => pointsByNode[rootToNode.get(find(index))].push(endpoint.point));
  const points = pointsByNode.map(group => group.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])[0]);
  const edges = segments.map((segment, id) => {
    const u = rootToNode.get(find(segment.endpointIndexes[0]));
    const v = rootToNode.get(find(segment.endpointIndexes[1]));
    segment.nodes = [u, v];
    return { id, u, v, segment };
  });
  const adjacency = points.map(() => []);
  for (const edge of edges) {
    if (edge.u === edge.v) continue;
    adjacency[edge.u].push(edge);
    adjacency[edge.v].push(edge);
  }
  return { points, edges, adjacency };
}

function enumerateCycles(graph, size) {
  const results = [];
  const seen = new Set();
  function walk(start, current, nodes, edges) {
    for (const edge of graph.adjacency[current]) {
      const next = edge.u === current ? edge.v : edge.u;
      if (next === start) {
        if (edges.length + 1 !== size) continue;
        const cycleEdges = [...edges, edge];
        const key = `${nodes.slice().sort((a, b) => a - b).join(',')}|${cycleEdges.map(e => e.id).sort((a, b) => a - b).join(',')}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ nodes: [...nodes], edges: cycleEdges });
        }
      } else if (next > start && !nodes.includes(next) && edges.length + 1 < size) {
        walk(start, next, [...nodes, next], [...edges, edge]);
      }
    }
  }
  for (let start = 0; start < graph.points.length; start++) walk(start, start, [start], []);
  return results;
}

function triangleCandidates(graph) {
  const candidates = [];
  for (const cycle of enumerateCycles(graph, 3)) {
    const points = cycle.nodes.map(node => graph.points[node]);
    const edgeData = cycle.edges.map(edge => {
      const from = cycle.nodes[cycle.edges.indexOf(edge)];
      const to = cycle.nodes[(cycle.edges.indexOf(edge) + 1) % 3];
      return { segment: edge.segment, a: graph.points[from], b: graph.points[to] };
    });

    // Enumerated edges are not necessarily in traversal order; re-associate each edge with its endpoints.
    for (let i = 0; i < edgeData.length; i++) {
      const edge = cycle.edges[i];
      const from = cycle.nodes[i], to = cycle.nodes[(i + 1) % 3];
      if (!((edge.u === from && edge.v === to) || (edge.u === to && edge.v === from))) {
        const linked = cycle.edges.find(candidate => candidate.id === edge.id);
        edgeData[i] = { segment: linked.segment, a: graph.points[edge.u], b: graph.points[edge.v] };
      }
    }

    const horizontal = edgeData.filter(edge => isHorizontal(edge.a, edge.b));
    if (horizontal.length !== 1) continue;
    const base = horizontal[0];
    const sides = edgeData.filter(edge => edge !== base);
    if (sides.some(edge => isNearAxis(edge.a, edge.b))) continue;
    const baseV = (base.a[1] + base.b[1]) / 2;
    const minU = Math.min(base.a[0], base.b[0]), maxU = Math.max(base.a[0], base.b[0]);
    const apex = points.find(point => point !== base.a && point !== base.b &&
      point[1] <= baseV - Config.ROOF_APEX_MIN_RISE && point[0] >= minU && point[0] <= maxU);
    if (!apex) continue;
    const signature = points.map(pointKey).sort().join('|');
    candidates.push({ points, edges: edgeData, base, apex, signature });
  }
  return candidates;
}

function rectangleCandidate(graph, nodes, edges, complete) {
  const uniqueNodes = [...new Set(nodes)];
  if (uniqueNodes.length !== 4) return null;
  const points = uniqueNodes.map(node => graph.points[node]);
  const x0 = Math.min(...points.map(point => point[0]));
  const x1 = Math.max(...points.map(point => point[0]));
  const y0 = Math.min(...points.map(point => point[1]));
  const y1 = Math.max(...points.map(point => point[1]));
  if (x1 <= x0 || y1 <= y0) return null;

  const sides = {};
  for (const edge of edges) {
    const a = graph.points[edge.u], b = graph.points[edge.v];
    let side = null;
    if (isHorizontal(a, b)) {
      if (Math.abs(a[1] - y0) <= AXIS_TOL && Math.abs(b[1] - y0) <= AXIS_TOL) side = 'top';
      else if (Math.abs(a[1] - y1) <= AXIS_TOL && Math.abs(b[1] - y1) <= AXIS_TOL) side = 'bottom';
    } else if (isVertical(a, b)) {
      if (Math.abs(a[0] - x0) <= AXIS_TOL && Math.abs(b[0] - x0) <= AXIS_TOL) side = 'left';
      else if (Math.abs(a[0] - x1) <= AXIS_TOL && Math.abs(b[0] - x1) <= AXIS_TOL) side = 'right';
    }
    if (!side || sides[side]) return null;
    sides[side] = edge.segment;
  }
  if (complete ? Object.keys(sides).length !== 4 : !(sides.top && sides.left && sides.right && !sides.bottom)) return null;
  return {
    x0, x1, y0, y1,
    width: x1 - x0 + 1,
    height: y1 - y0 + 1,
    sides,
    complete,
    signature: `${x0},${y0},${x1},${y1}`,
  };
}

function rectangleCandidates(graph) {
  const candidates = [];
  for (const cycle of enumerateCycles(graph, 4)) {
    const candidate = rectangleCandidate(graph, cycle.nodes, cycle.edges, true);
    if (candidate) candidates.push(candidate);
  }

  for (const centerEdge of graph.edges) {
    if (centerEdge.u === centerEdge.v) continue;
    const atU = graph.adjacency[centerEdge.u].filter(edge => edge.id !== centerEdge.id);
    const atV = graph.adjacency[centerEdge.v].filter(edge => edge.id !== centerEdge.id);
    for (const first of atU) {
      for (const last of atV) {
        if (first.id === last.id) continue;
        const firstNode = first.u === centerEdge.u ? first.v : first.u;
        const lastNode = last.u === centerEdge.v ? last.v : last.u;
        if (new Set([centerEdge.u, centerEdge.v, firstNode, lastNode]).size !== 4) continue;
        const candidate = rectangleCandidate(
          graph,
          [firstNode, centerEdge.u, centerEdge.v, lastNode],
          [first, centerEdge, last],
          false,
        );
        if (candidate) candidates.push(candidate);
      }
    }
  }
  return candidates;
}

function segmentGroups(segments) {
  const parent = segments.map((_, index) => index);
  const find = (index) => {
    if (parent[index] !== index) parent[index] = find(parent[index]);
    return parent[index];
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const touches = (a, b) => {
    const endsA = [a.a, a.b], endsB = [b.a, b.b];
    if (endsA.some(p => endsB.some(q => distance(p, q) <= CORNER_TOL))) return true;
    return endsA.some(p => pointSegmentDistance(p, b.a, b.b) <= ENDPOINT_SEGMENT_TOL) ||
      endsB.some(p => pointSegmentDistance(p, a.a, a.b) <= ENDPOINT_SEGMENT_TOL);
  };
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) if (touches(segments[i], segments[j])) union(i, j);
  }
  const groups = new Map();
  segments.forEach((segment, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(segment);
  });
  return [...groups.values()];
}

function boundsForSegments(segments) {
  const points = segments.flatMap(segment => [segment.a, segment.b]);
  const x0 = Math.min(...points.map(point => point[0]));
  const x1 = Math.max(...points.map(point => point[0]));
  const y0 = Math.min(...points.map(point => point[1]));
  const y1 = Math.max(...points.map(point => point[1]));
  return { x0, x1, y0, y1, width: x1 - x0 + 1, height: y1 - y0 + 1, area: (x1 - x0 + 1) * (y1 - y0 + 1) };
}

function wallSide(segment, bounds) {
  if (isHorizontal(segment.a, segment.b)) {
    if (Math.abs(segment.a[1] - bounds.y0) <= AXIS_TOL && Math.abs(segment.b[1] - bounds.y0) <= AXIS_TOL) return 'top';
    if (Math.abs(segment.a[1] - bounds.y1) <= AXIS_TOL && Math.abs(segment.b[1] - bounds.y1) <= AXIS_TOL) return 'bottom';
  }
  if (isVertical(segment.a, segment.b)) {
    if (Math.abs(segment.a[0] - bounds.x0) <= AXIS_TOL && Math.abs(segment.b[0] - bounds.x0) <= AXIS_TOL) return 'left';
    if (Math.abs(segment.a[0] - bounds.x1) <= AXIS_TOL && Math.abs(segment.b[0] - bounds.x1) <= AXIS_TOL) return 'right';
  }
  return null;
}

function compareCoverageThenIndex(a, b) {
  return b.coverage - a.coverage || a.actionIndex - b.actionIndex || a.edgeIndex - b.edgeIndex;
}

function getWalls(segments, reserved) {
  const candidates = segments.filter(segment => !reserved.has(segment.id) &&
    segment.verified && isNearAxis(segment.a, segment.b) &&
    segmentSteps(segment.a, segment.b) >= Config.WALL_MIN_SIDE);
  const groups = segmentGroups(candidates).map(segments => ({ segments, bounds: boundsForSegments(segments) }))
    .filter(group => group.bounds.width >= Config.WALL_MIN_WIDTH && group.bounds.height >= Config.WALL_MIN_HEIGHT)
    .sort((a, b) => b.bounds.area - a.bounds.area || a.bounds.x0 - b.bounds.x0 ||
      a.bounds.y0 - b.bounds.y0 || a.bounds.x1 - b.bounds.x1 || a.bounds.y1 - b.bounds.y1);
  if (!groups.length) return { bounds: null, sides: {}, claims: [], segments: [] };
  const { bounds, segments: frameSegments } = groups[0];
  const sides = {};
  for (const segment of frameSegments) {
    const side = wallSide(segment, bounds);
    if (side && (!sides[side] || compareWallSide(segment, sides[side]) < 0)) sides[side] = segment;
  }
  const claims = Object.entries(sides).map(([side, segment]) => ({ role: 'walls', actionIndex: segment.actionIndex, edge: side }));
  return { bounds, sides, claims, segments: frameSegments };
}

function compareWallSide(a, b) {
  return b.coverage - a.coverage || segmentSteps(b.a, b.b) - segmentSteps(a.a, a.b) ||
    a.actionIndex - b.actionIndex || a.edgeIndex - b.edgeIndex;
}

function rectangleCoverage(rectangle) {
  const values = Object.values(rectangle.sides).map(segment => segment.coverage);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function compareRectangleCandidates(a, b) {
  const aActions = Object.values(a.sides).map(segment => segment.actionIndex);
  const bActions = Object.values(b.sides).map(segment => segment.actionIndex);
  return b.coverage - a.coverage ||
    b.claimedSides.length - a.claimedSides.length ||
    compareActionSequences(aActions, bActions) ||
    a.signature.localeCompare(b.signature);
}

function withinWall(rectangle, bounds) {
  return rectangle.x0 >= bounds.x0 + Config.SHAPE_MARGIN &&
    rectangle.x1 <= bounds.x1 - Config.SHAPE_MARGIN &&
    rectangle.y0 >= bounds.y0 + Config.SHAPE_MARGIN &&
    rectangle.y1 <= bounds.y1;
}

function intersects(a, b) {
  return a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
}

function segmentIntersectsRect(segment, rectangle) {
  const minX = Math.min(segment.a[0], segment.b[0]);
  const maxX = Math.max(segment.a[0], segment.b[0]);
  const minY = Math.min(segment.a[1], segment.b[1]);
  const maxY = Math.max(segment.a[1], segment.b[1]);
  return minX <= rectangle.x1 && maxX >= rectangle.x0 &&
    minY <= rectangle.y1 && maxY >= rectangle.y0;
}

function rectangleCandidateList(rectangles, bounds) {
  const unique = new Map();
  for (const rectangle of rectangles) {
    const old = unique.get(rectangle.signature);
    if (!old || rectangleCoverage(rectangle) > rectangleCoverage(old) ||
        (rectangleCoverage(rectangle) === rectangleCoverage(old) &&
         Math.min(...Object.values(rectangle.sides).map(side => side.actionIndex)) <
         Math.min(...Object.values(old.sides).map(side => side.actionIndex)))) {
      unique.set(rectangle.signature, rectangle);
    }
  }
  return [...unique.values()].filter(rectangle => rectangle.x0 >= 0 && rectangle.y0 >= 0 &&
    rectangle.width <= Config.SMALL_RECT_MAX_WIDTH && rectangle.height <= Config.SMALL_RECT_MAX_HEIGHT &&
    (!bounds || withinWall(rectangle, bounds)));
}

function buildRectangleItems(rectangles, bounds, walls) {
  const possibleDoors = [];
  const possibleWindows = [];
  for (const rectangle of rectangles) {
    const doorSize = rectangle.width >= Config.DOOR_MIN_WIDTH && rectangle.width <= Config.DOOR_MAX_WIDTH &&
      rectangle.height >= Config.DOOR_MIN_HEIGHT && rectangle.height <= Config.DOOR_MAX_HEIGHT;
    const windowSize = rectangle.width >= Config.WINDOW_MIN_WIDTH && rectangle.width <= Config.WINDOW_MAX_WIDTH &&
      rectangle.height >= Config.WINDOW_MIN_HEIGHT && rectangle.height <= Config.WINDOW_MAX_HEIGHT;
    if (!doorSize && !windowSize) continue;
    if (rectangle.x0 < bounds.x0 + Config.SHAPE_MARGIN || rectangle.x1 > bounds.x1 - Config.SHAPE_MARGIN ||
        rectangle.y0 < bounds.y0 + Config.SHAPE_MARGIN || rectangle.y1 > bounds.y1) continue;

    const bottomWithinTolerance = Math.abs(rectangle.y1 - bounds.y1) <= Config.DOOR_BOTTOM_TOL;
    const missingBottomDoor = !rectangle.complete && bottomWithinTolerance &&
      rectangle.sides.top && rectangle.sides.left && rectangle.sides.right;
    const completeDoor = rectangle.complete && bottomWithinTolerance;
    if (doorSize && (missingBottomDoor || completeDoor)) {
      const required = missingBottomDoor ? ['top', 'left', 'right'] : ['top', 'left', 'right', 'bottom'];
      const verified = required.every(side => rectangle.sides[side] && rectangle.sides[side].verified);
      const feetSupported = missingBottomDoor && walls.sides.bottom &&
        [rectangle.x0, rectangle.x1].every(x =>
          pointSegmentDistance([x, rectangle.y1], walls.sides.bottom.a, walls.sides.bottom.b) <= CORNER_TOL);
      if (verified && (!missingBottomDoor || feetSupported)) {
        possibleDoors.push({
          ...rectangle,
          claimedSides: missingBottomDoor ? ['top', 'left', 'right'] : ['top', 'right', 'bottom', 'left'],
          coverage: required.reduce((sum, side) => sum + rectangle.sides[side].coverage, 0) / required.length,
        });
      }
    }

    const windowValid = windowSize && rectangle.complete &&
      rectangle.y1 <= bounds.y1 - Config.WINDOW_BOTTOM_CLEARANCE &&
      !walls.segments.some(segment => segmentIntersectsRect(segment, rectangle)) &&
      ['top', 'right', 'bottom', 'left'].every(side =>
        rectangle.sides[side] && rectangle.sides[side].verified);
    if (windowValid) {
      possibleWindows.push({
        ...rectangle,
        claimedSides: ['top', 'right', 'bottom', 'left'],
        coverage: rectangleCoverage(rectangle),
      });
    }
  }
  const nonOverlappingDoors = possibleDoors.filter(candidate =>
    !possibleWindows.some(window => intersects(candidate, window)));
  nonOverlappingDoors.sort(compareRectangleCandidates);
  const door = nonOverlappingDoors[0] || null;
  const windows = possibleWindows.filter(candidate =>
    !door || !intersects(candidate, door))
    .sort(compareRectangleCandidates)
    .filter((candidate, index, list) =>
      !list.slice(0, index).some(previous => intersects(candidate, previous)))
    .slice(0, 2);

  return { door, windows };
}

function roofCandidates(triangles, bounds) {
  const valid = [];
  for (const triangle of triangles) {
    const baseV = (triangle.base.a[1] + triangle.base.b[1]) / 2;
    const baseWidth = Math.abs(triangle.base.a[0] - triangle.base.b[0]);
    const minU = Math.min(triangle.base.a[0], triangle.base.b[0]);
    const maxU = Math.max(triangle.base.a[0], triangle.base.b[0]);
    const apex = triangle.apex;
    if (Math.abs(baseV - bounds.y0) > Config.ROOF_BASE_TOL ||
        baseWidth < Config.ROOF_BASE_MIN_WIDTH_RATIO * bounds.width ||
        baseWidth > Config.ROOF_BASE_MAX_WIDTH_RATIO * bounds.width ||
        apex[1] > bounds.y0 - Config.ROOF_APEX_MIN_RISE ||
        apex[0] < bounds.x0 || apex[0] > bounds.x1) continue;
    const verifiedEdges = triangle.edges.filter(edge => edge.segment.verified);
    const totalCoverage = triangle.edges.reduce((sum, edge) => sum + edge.segment.coverage, 0) / triangle.edges.length;
    const edgeLabels = new Map();
    for (const edge of triangle.edges) {
      if (edge === triangle.base) edgeLabels.set(edge, 'base');
      else edgeLabels.set(edge, (edge.a[0] + edge.b[0]) / 2 < apex[0] ? 'left' : 'right');
    }
    valid.push({
      ...triangle,
      verifiedEdges,
      units: verifiedEdges.length * Config.MARKS.roofEdge * 4,
      coverage: totalCoverage,
      edgeLabels,
    });
  }
  valid.sort((a, b) => b.units - a.units || b.coverage - a.coverage ||
    compareActionSequences(
      a.edges.map(edge => edge.segment.actionIndex),
      b.edges.map(edge => edge.segment.actionIndex),
    ) ||
    a.signature.localeCompare(b.signature));
  return valid;
}

function compareActionSequences(a, b) {
  const left = a.slice().sort((x, y) => x - y);
  const right = b.slice().sort((x, y) => x - y);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

function polygonInteriorCount(action, ctx, zone) {
  const outline = new Set();
  const pts = action.entry.pts;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    Raster.bresenham(a[0], a[1], b[0], b[1], (x, y) => {
      if (inside(zone, x, y)) outline.add(y * ctx.size + x);
    });
  }
  return action.footprint.filter(index => !outline.has(index)).length;
}

function algorithmCandidates(actions, ctx, zone) {
  const candidates = { dda: [], bresenham: [], midpoint: [], scanline: [], flood: [] };
  for (const action of actions) {
    const entry = action.entry;
    if (action.coverage < Config.COVERAGE_MIN) continue;
    const pts = entry.pts || [];
    if ((entry.tool === 'dda' || entry.tool === 'line') && pts.length === 2) {
      const dx = Math.abs(pts[1][0] - pts[0][0]);
      const dy = Math.abs(pts[1][1] - pts[0][1]);
      const steps = Math.max(dx, dy);
      if (entry.tool === 'dda' && steps >= Config.DDA_MIN_STEPS && dx !== 0 && dy !== 0) candidates.dda.push(action);
      if (entry.tool === 'line' && steps >= Config.BRESENHAM_MIN_STEPS && dx !== 0 && dy !== 0) candidates.bresenham.push(action);
    }
    if (entry.tool === 'circle' && pts.length === 2) {
      const radius = Math.round(Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]));
      if (radius >= Config.SUN_MIN_R) candidates.midpoint.push(action);
    }
    if (entry.tool === 'polygon' && pts.length >= 3 &&
        polygonInteriorCount(action, ctx, zone) >= Config.SCANLINE_MIN_INTERIOR) candidates.scanline.push(action);
    if (entry.tool === 'fill' && action.footprint.length >= Config.FLOOD_MIN_PIXELS &&
        action.footprint.length <= Config.FLOOD_MAX_PIXELS &&
        entry.c !== 0 && (action.history.before || []).length === action.footprint.length &&
        action.history.before.every(record => record[1] === 0) &&
        action.footprint.every(index => {
          const x = index % ctx.size - zone.x0, y = Math.floor(index / ctx.size) - zone.y0;
          return x > 0 && y > 0 && x < zone.width - 1 && y < zone.height - 1;
        })) candidates.flood.push(action);
  }
  return candidates;
}

function bestAction(actions) {
  return actions.slice().sort(compareCoverageThenIndex)[0] || null;
}

function item(id, label, units, maxUnits, evidence, status, hint = '') {
  return { id, label, units, maxUnits, status, hint, evidence: [...new Set(evidence)].sort((a, b) => a - b) };
}

function statusFor(units, maxUnits) {
  if (units >= maxUnits) return 'full';
  return units > 0 ? 'partial' : 'missing';
}

function marksFromUnits(units) {
  return units / 4;
}

function evaluateTeam(ctx, team) {
  if (!ctx || !ctx.board || !ctx.board.fb || !Array.isArray(ctx.log)) {
    throw new TypeError('ctx must include board and log');
  }
  if (!Number.isInteger(team) || team < 0 || team >= Config.TEAM_COUNT) {
    throw new RangeError('team must be an integer from 0 to 3');
  }
  const zone = zoneFor(ctx, team);
  const actions = makeActiveActions(ctx, team, zone);
  const segments = actions.flatMap(action => action.segments);
  const graph = endpointsGraph(segments);
  const triangles = triangleCandidates(graph);
  const rectangles = rectangleCandidateList(rectangleCandidates(graph), null);
  const reserved = new Set();
  for (const triangle of triangles) reserved.add(triangle.base.segment.id);
  for (const rectangle of rectangles) {
    for (const segment of Object.values(rectangle.sides)) reserved.add(segment.id);
  }
  const threeSideDoors = rectanglesFromThreeSides(graph).filter(rectangle =>
    rectangle.width >= Config.DOOR_MIN_WIDTH && rectangle.width <= Config.DOOR_MAX_WIDTH &&
    rectangle.height >= Config.DOOR_MIN_HEIGHT && rectangle.height <= Config.DOOR_MAX_HEIGHT);
  for (const rectangle of threeSideDoors) {
    for (const segment of Object.values(rectangle.sides)) reserved.add(segment.id);
  }

  const walls = getWalls(segments, reserved);
  const wallCount = Object.keys(walls.sides).length;
  const hasFrame = walls.bounds && wallCount >= Config.REQUIRE_WALL_SIDES;
  const wallUnits = wallCount * Config.MARKS.wallSide * 4;
  let roof = null, door = null, windows = [], sun = null;
  const houseClaims = [...walls.claims];
  let roofUnits = 0, doorUnits = 0, windowUnits = 0, sunUnits = 0;
  let roofBounds = null;

  if (hasFrame) {
    const candidates = roofCandidates(triangles, walls.bounds);
    roof = candidates[0] || null;
    if (roof) {
      roofUnits = roof.units;
      const edgeOrder = { left: 0, right: 1, base: 2 };
      for (const edge of roof.verifiedEdges.slice().sort((a, b) =>
        edgeOrder[roof.edgeLabels.get(a)] - edgeOrder[roof.edgeLabels.get(b)])) {
        houseClaims.push({
          role: 'roof',
          actionIndex: edge.segment.actionIndex,
          edge: roof.edgeLabels.get(edge),
        });
      }
      const points = roof.points;
      if (roofUnits > 0) roofBounds = {
        x0: Math.min(...points.map(point => point[0])),
        x1: Math.max(...points.map(point => point[0])),
        y0: Math.min(...points.map(point => point[1])),
        y1: Math.max(...points.map(point => point[1])),
      };
    }
    const rects = [...rectangles, ...threeSideDoors].filter(rectangle =>
      rectangle.width <= Config.SMALL_RECT_MAX_WIDTH && rectangle.height <= Config.SMALL_RECT_MAX_HEIGHT);
    const selected = buildRectangleItems(rects, walls.bounds, walls);
    door = selected.door;
    windows = selected.windows;
    if (door) {
      doorUnits = Config.MARKS.door * 4;
      for (const side of door.claimedSides) {
        const segment = door.sides[side];
        houseClaims.push({ role: 'door', actionIndex: segment.actionIndex, edge: side });
      }
    }
    windowUnits = windows.length * Config.MARKS.window * 4;
    for (const window of windows) {
      for (const side of window.claimedSides) {
        const segment = window.sides[side];
        houseClaims.push({ role: 'windows', actionIndex: segment.actionIndex, edge: side });
      }
    }

    const houseBox = {
      x0: Math.min(walls.bounds.x0, roofBounds ? roofBounds.x0 : walls.bounds.x0),
      x1: Math.max(walls.bounds.x1, roofBounds ? roofBounds.x1 : walls.bounds.x1),
      y0: Math.min(walls.bounds.y0, roofBounds ? roofBounds.y0 : walls.bounds.y0),
      y1: Math.max(walls.bounds.y1, roofBounds ? roofBounds.y1 : walls.bounds.y1),
    };
    const circleActions = actions.filter(action => action.entry.tool === 'circle' && action.coverage >= Config.COVERAGE_MIN);
    const suns = circleActions.filter(action => {
      const [cx, cy] = action.entry.pts[0];
      const [rx, ry] = action.entry.pts[1];
      const radius = Math.round(Math.hypot(rx - cx, ry - cy));
      const u = cx - zone.x0, v = cy - zone.y0;
      const box = { x0: u - radius, x1: u + radius, y0: v - radius, y1: v + radius };
      return radius >= Config.SUN_MIN_R && v < walls.bounds.y0 &&
        !intersects(box, houseBox);
    }).sort(compareCoverageThenIndex);
    sun = suns[0] || null;
    if (sun) {
      sunUnits = Config.MARKS.sun * 4;
      houseClaims.push({ role: 'sun', actionIndex: sun.actionIndex, edge: 'circle' });
    }
  }

  const algoCandidates = algorithmCandidates(actions, ctx, zone);
  const algo = {};
  for (const id of ['dda', 'bresenham', 'midpoint', 'scanline', 'flood']) {
    const winner = bestAction(algoCandidates[id]);
    algo[id] = winner ? Config.MARKS[id] : 0;
  }

  const waiting = !hasFrame;
  const houseItems = [
    item('walls', 'Walls', wallUnits, Config.MARKS.walls * 4, Object.values(walls.sides).map(side => side.actionIndex),
      statusFor(wallUnits, Config.MARKS.walls * 4), `${wallCount} of 4 sides`),
    item('roof', 'Roof', roofUnits, Config.MARKS.roof * 4, roof ? roof.verifiedEdges.map(edge => edge.segment.actionIndex) : [],
      waiting ? 'waiting' : statusFor(roofUnits, Config.MARKS.roof * 4), waiting ? 'draw the walls: 3 sides needed' : roofUnits ? '' : 'Draw a triangular roof above the walls'),
    item('door', 'Door', doorUnits, Config.MARKS.door * 4, door ? door.claimedSides.map(side => door.sides[side].actionIndex) : [],
      waiting ? 'waiting' : statusFor(doorUnits, Config.MARKS.door * 4), waiting ? 'draw the walls: 3 sides needed' : doorUnits ? '' : 'Draw a door on the bottom wall'),
    item('windows', 'Windows', windowUnits, Config.MARKS.window * 2 * 4, windows.flatMap(window => window.claimedSides.map(side => window.sides[side].actionIndex)),
      waiting ? 'waiting' : statusFor(windowUnits, Config.MARKS.window * 2 * 4), waiting ? 'draw the walls: 3 sides needed' : `${windows.length} of 2 windows`),
    item('sun', 'Sun', sunUnits, Config.MARKS.sun * 4, sun ? [sun.actionIndex] : [],
      waiting ? 'waiting' : statusFor(sunUnits, Config.MARKS.sun * 4), waiting ? 'draw the walls: 3 sides needed' : sunUnits ? '' : 'Draw a circle above the house'),
  ];
  const algoItems = [
    ['dda', 'DDA'],
    ['bresenham', 'Bresenham'],
    ['midpoint', 'Midpoint circle'],
    ['scanline', 'Scan-line polygon fill'],
    ['flood', 'Flood fill'],
  ].map(([id, label]) => {
    const winner = bestAction(algoCandidates[id]);
    const units = winner ? Config.MARKS[id] * 4 : 0;
    return item(id, label, units, Config.MARKS[id] * 4, winner ? [winner.actionIndex] : [],
      statusFor(units, Config.MARKS[id] * 4), winner ? '' : `Demonstrate ${label}`);
  });

  const house = {
    walls: marksFromUnits(wallUnits),
    roof: marksFromUnits(roofUnits),
    door: marksFromUnits(doorUnits),
    windows: marksFromUnits(windowUnits),
    sun: marksFromUnits(sunUnits),
  };
  const algoMarks = Object.fromEntries(Object.entries(algo).map(([key, units]) => [key, marksFromUnits(units * 4)]));
  const units = wallUnits + roofUnits + doorUnits + windowUnits + sunUnits +
    Object.values(algo).reduce((sum, marks) => sum + marks * 4, 0);
  const result = {
    team,
    units,
    marks: marksFromUnits(units),
    house,
    algo: algoMarks,
    items: [...houseItems, ...algoItems],
  };
  if (ctx.debug) {
    result.debug = {
      frame: hasFrame ? { x0: walls.bounds.x0, y0: walls.bounds.y0, x1: walls.bounds.x1, y1: walls.bounds.y1, width: walls.bounds.width, height: walls.bounds.height } : null,
      claims: houseClaims,
    };
  }
  return result;
}

function rectanglesFromThreeSides(graph) {
  const candidates = [];
  for (const centerEdge of graph.edges) {
    if (centerEdge.u === centerEdge.v) continue;
    const atU = graph.adjacency[centerEdge.u].filter(edge => edge.id !== centerEdge.id);
    const atV = graph.adjacency[centerEdge.v].filter(edge => edge.id !== centerEdge.id);
    for (const first of atU) {
      for (const last of atV) {
        if (first.id === last.id) continue;
        const firstNode = first.u === centerEdge.u ? first.v : first.u;
        const lastNode = last.u === centerEdge.v ? last.v : last.u;
        if (new Set([centerEdge.u, centerEdge.v, firstNode, lastNode]).size !== 4) continue;
        const candidate = rectangleCandidate(
          graph,
          [firstNode, centerEdge.u, centerEdge.v, lastNode],
          [first, centerEdge, last],
          false,
        );
        if (candidate) candidates.push(candidate);
      }
    }
  }
  const unique = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.signature}|${Object.keys(candidate.sides).sort().join(',')}`;
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return [...unique.values()];
}

function evaluateAll(ctx) {
  return Array.from({ length: Config.TEAM_COUNT }, (_, team) => evaluateTeam(ctx, team));
}

module.exports = { evaluateTeam, evaluateAll };
