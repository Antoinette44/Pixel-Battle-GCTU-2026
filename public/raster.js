/* raster.js - OUR OWN rasterizers (CSSD 315 Week 2). No canvas lineTo/arc/fill is used.
   Shared by the browser (previews, replay) and the Node server (authoritative copy).
   The frame buffer is  fb = { w, h, data: Uint8Array(w*h) }  holding palette indices.
   Storage is row-major with y = 0 at the TOP (like image files); (x, y) -> data[y*w + x]. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Raster = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const LIMITS = { maxPixels: 700, maxFill: 1500, maxPoly: 8, maxRadius: 20, maxPathPoints: 700 };

  /* ---------------- frame buffer ---------------- */
  function createFB(w, h, fillValue) {
    const data = new Uint8Array(w * h);
    if (fillValue) data.fill(fillValue);
    return { w, h, data };
  }
  const inBounds = (fb, x, y) => x >= 0 && y >= 0 && x < fb.w && y < fb.h;
  function getPixel(fb, x, y) { return inBounds(fb, x, y) ? fb.data[y * fb.w + x] : -1; }
  // THE setPixel: the only place that writes into the frame buffer.
  function setPixel(fb, x, y, c) {
    if (!inBounds(fb, x, y)) return false;
    fb.data[y * fb.w + x] = c;
    return true;
  }

  /* ---------------- DDA line (slide 10) ---------------- */
  function dda(x0, y0, x1, y1, plot, trace) {
    const dx = x1 - x0, dy = y1 - y0;
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    if (steps === 0) { plot(x0, y0); return; }
    const xInc = dx / steps, yInc = dy / steps;
    let x = x0, y = y0;
    for (let k = 0; k <= steps; k++) {
      if (trace) trace({ k, x, y });
      plot(Math.floor(x + 0.5), Math.floor(y + 0.5));
      x += xInc; y += yInc;
    }
  }

  /* ---------------- Bresenham line, all octants (slides 12-14) ---------------- */
  // Integer only: add, subtract, compare. The sign of p picks E (stay) or NE (step both).
  function bresenham(x0, y0, x1, y1, plot, trace) {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let x = x0, y = y0;
    if (dx >= dy) {                       // x is the driving axis
      let p = 2 * dy - dx;
      for (let k = 0; k <= dx; k++) {
        plot(x, y);
        const diag = p >= 0;
        if (trace && k < dx) trace({ k, p, choice: diag ? 'NE' : 'E', x: x + sx, y: diag ? y + sy : y });
        x += sx;
        if (diag) { y += sy; p += 2 * dy - 2 * dx; } else { p += 2 * dy; }
      }
    } else {                              // y is the driving axis (swap roles)
      let p = 2 * dx - dy;
      for (let k = 0; k <= dy; k++) {
        plot(x, y);
        const diag = p >= 0;
        if (trace && k < dy) trace({ k, p, choice: diag ? 'NE' : 'E', x: diag ? x + sx : x, y: y + sy });
        y += sy;
        if (diag) { x += sx; p += 2 * dx - 2 * dy; } else { p += 2 * dx; }
      }
    }
  }

  /* ---------------- Midpoint circle (slide 17) ---------------- */
  // Emits the points of the FIRST OCTANT only: (0,r) ... until x >= y.
  function midpointCircle(r, emit, trace) {
    let x = 0, y = r, p = 1 - r;
    emit(x, y);
    while (x < y) {
      const pk = p;
      x++;
      if (p < 0) { p += 2 * x + 1; } else { y--; p += 2 * x + 1 - 2 * y; }
      if (trace) trace({ p: pk, x, y, next: p });
      emit(x, y);
    }
  }
  // 8-way symmetry. filled=true draws horizontal spans instead of 8 dots.
  function circle(cx, cy, r, plot, filled) {
    const span = (xa, xb, y) => { for (let x = xa; x <= xb; x++) plot(x, y); };
    midpointCircle(r, (x, y) => {
      if (filled) {
        span(cx - x, cx + x, cy + y); span(cx - x, cx + x, cy - y);
        span(cx - y, cx + y, cy + x); span(cx - y, cx + y, cy - x);
      } else {
        plot(cx + x, cy + y); plot(cx - x, cy + y); plot(cx + x, cy - y); plot(cx - x, cy - y);
        plot(cx + y, cy + x); plot(cx - y, cy + x); plot(cx + y, cy - x); plot(cx - y, cy - x);
      }
    });
  }

  /* ---------------- Scan-line polygon fill, even-odd rule (slide 18) ---------------- */
  function fillPolygon(pts, plot) {
    let ymin = Infinity, ymax = -Infinity;
    for (const p of pts) { ymin = Math.min(ymin, p[1]); ymax = Math.max(ymax, p[1]); }
    const n = pts.length;
    for (let y = ymin; y <= ymax; y++) {
      const xs = [];
      for (let i = 0; i < n; i++) {
        const xa = pts[i][0], ya = pts[i][1];
        const xb = pts[(i + 1) % n][0], yb = pts[(i + 1) % n][1];
        if (ya === yb) continue;                              // horizontal edge: skip
        const lo = Math.min(ya, yb), hi = Math.max(ya, yb);
        if (y >= lo && y < hi) xs.push(xa + (y - ya) * (xb - xa) / (yb - ya)); // half-open: no double count at vertices
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.ceil(xs[k]); x <= Math.floor(xs[k + 1]); x++) plot(x, y);
      }
    }
  }

  /* ---------------- Queue-based flood fill, 4-connected (slide 19) ---------------- */
  // Returns an array of pixel indices, [] if nothing to do, or null if the region is bigger than `limit`.
  // Optional clip = [x0, y0, x1, y1] (inclusive): the fill may not enter pixels outside it (used for team zones).
  function floodFill(fb, sx, sy, newColour, limit, clip, includeSameColour = false) {
    if (!inBounds(fb, sx, sy)) return [];
    const w = fb.w, h = fb.h;
    const cx0 = clip ? clip[0] : 0, cy0 = clip ? clip[1] : 0, cx1 = clip ? clip[2] : w - 1, cy1 = clip ? clip[3] : h - 1;
    if (sx < cx0 || sx > cx1 || sy < cy0 || sy > cy1) return [];
    const old = fb.data[sy * w + sx];
    if (old === newColour && !includeSameColour) return [];
    const queue = new Int32Array(w * h);
    const seen = new Uint8Array(w * h);
    let head = 0, tail = 0;
    const start = sy * w + sx;
    queue[tail++] = start; seen[start] = 1;
    const out = [];
    while (head < tail) {
      const i = queue[head++];
      out.push(i);
      if (out.length > limit) return null;
      const x = i % w, y = (i / w) | 0;
      if (x > cx0   && !seen[i - 1] && fb.data[i - 1] === old) { seen[i - 1] = 1; queue[tail++] = i - 1; }
      if (x < cx1   && !seen[i + 1] && fb.data[i + 1] === old) { seen[i + 1] = 1; queue[tail++] = i + 1; }
      if (y > cy0   && !seen[i - w] && fb.data[i - w] === old) { seen[i - w] = 1; queue[tail++] = i - w; }
      if (y < cy1   && !seen[i + w] && fb.data[i + w] === old) { seen[i + w] = 1; queue[tail++] = i + w; }
    }
    return out;
  }

  /* ---------------- Actions ----------------
     action = { tool: 'pen'|'line'|'circle'|'polygon'|'fill', pts: [[x,y],...], c: colourIndex, f: 0|1 }
       pen     1..700 points (connected with Bresenham)
       line    2 points (start, end)
       circle  2 points (centre, a point on the rim) ; f = 1 -> filled disc
       polygon 3..8 points (scan-line filled + Bresenham outline)
       fill    1 point (seed)                                                               */
  const NEED = { pen: [1, LIMITS.maxPathPoints], line: [2, 2], circle: [2, 2], polygon: [3, LIMITS.maxPoly], fill: [1, 1] };

  // Checks a raw (untrusted) action and returns a clean copy, or { error }.
  function normalise(a, fb, numColours) {
    if (!a || typeof a !== 'object' || !NEED[a.tool]) return { error: 'Unknown tool' };
    if (!Number.isInteger(a.c) || a.c < 0 || a.c >= numColours) return { error: 'Bad colour' };
    if (a.f !== undefined && ![0, 1, false, true].includes(a.f)) return { error: 'Bad fill option' };
    if (!Array.isArray(a.pts)) return { error: 'No points' };
    const [lo, hi] = NEED[a.tool];
    if (a.pts.length < lo || a.pts.length > hi) return { error: 'Wrong number of points' };
    const pts = [];
    for (const p of a.pts) {
      if (!Array.isArray(p) || p.length !== 2 || !Number.isInteger(p[0]) || !Number.isInteger(p[1])) return { error: 'Bad point' };
      if (!inBounds(fb, p[0], p[1])) return { error: 'Point outside the canvas' };
      pts.push([p[0], p[1]]);
    }
    return { action: { tool: a.tool, pts, c: a.c, f: a.f ? 1 : 0 } };
  }

  // Works out WHICH pixels an action touches (does not write). Returns { idx } or { error }.
  function rasterize(fb, a, includeSameColour = false) {
    const w = fb.w;
    const marks = new Uint8Array(fb.w * fb.h);
    const idx = [];
    const plot = (x, y) => {
      if (!inBounds(fb, x, y)) return;
      const i = y * w + x;
      if (!marks[i]) { marks[i] = 1; idx.push(i); }
    };
    const p = a.pts;
    switch (a.tool) {
      case 'pen':
        if (p.length === 1) plot(p[0][0], p[0][1]);
        else for (let i = 1; i < p.length; i++) bresenham(p[i - 1][0], p[i - 1][1], p[i][0], p[i][1], plot);
        break;
      case 'line':
        bresenham(p[0][0], p[0][1], p[1][0], p[1][1], plot); break;
      case 'circle': {
        const r = Math.round(Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]));
        if (r < 1) return { error: 'Circle radius must be at least 1' };
        if (r > LIMITS.maxRadius) return { error: 'Circle radius max is ' + LIMITS.maxRadius };
        circle(p[0][0], p[0][1], r, plot, !!a.f); break;
      }
      case 'polygon':
        fillPolygon(p, plot);
        for (let i = 0; i < p.length; i++) {
          const q = p[(i + 1) % p.length];
          bresenham(p[i][0], p[i][1], q[0], q[1], plot);
        }
        break;
      case 'fill': {
        const region = floodFill(fb, p[0][0], p[0][1], a.c, LIMITS.maxFill, a.clip, includeSameColour);
        if (region === null) return { error: 'Area too big for one bucket (max ' + LIMITS.maxFill + ' pixels)' };
        return { idx: region };
      }
      default: return { error: 'Unknown tool' };
    }
    if (idx.length > LIMITS.maxPixels) return { error: 'Too big: ' + idx.length + ' pixels (max ' + LIMITS.maxPixels + ')' };
    return { idx };
  }

  // Applies an action to the frame buffer. Returns { changes: [[index, oldColour], ...] } or { error }.
  function applyAction(fb, a) {
    const r = rasterize(fb, a);
    if (r.error) return r;
    const changes = [];
    for (const i of r.idx) {
      const old = fb.data[i];
      if (old !== a.c) {
        changes.push([i, old]);
        setPixel(fb, i % fb.w, (i / fb.w) | 0, a.c);
      }
    }
    return { changes };
  }

  return { LIMITS, createFB, getPixel, setPixel, inBounds, dda, bresenham, midpointCircle, circle,
           fillPolygon, floodFill, normalise, rasterize, applyAction };
});
