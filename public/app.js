/* app.js - Pixel Battle browser client.
   Pixels are only ever written with Raster.setPixel (our own code) into frame buffers.
   Canvas elements are used purely as a screen to blit the finished buffer (putImageData / drawImage);
   no lineTo / arc / fillRect / fill() calls are used anywhere.                                       */
(() => {
  'use strict';
  const { COLOURS, TEAMS, NUM, BG } = Palette;
  const $ = (id) => document.getElementById(id);
  const ICONS = {
    pen: '<path d="m16 4 4 4"/><path d="M4 20l4-.8L19 8a2.8 2.8 0 0 0-4-4L4 15z"/>',
    line: '<path d="M5 19 19 5"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="5" r="2"/>',
    circle: '<circle cx="12" cy="12" r="8"/>',
    polygon: '<path d="m12 3 8 5-2 10-11 2-3-10z"/>',
    fill: '<path d="m4 15 8-8 8 8"/><path d="M6 17h12l-2 4H8z"/><path d="m12 3 2 2"/>',
  };
  const icon = (name) => `<svg class="tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  const store = {
    get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch (_) { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} },
  };
  const storedTeam = store.get('pb_team', null);
  const parsedTeam = storedTeam === null ? NaN : Number(storedTeam);
  const hasSavedTeam = Number.isInteger(parsedTeam) && parsedTeam >= 0 && parsedTeam < TEAMS.length;

  /* ---------------- state ---------------- */
  let SIZE = 128;
  let fb = Raster.createFB(SIZE, SIZE, BG);
  let tool = 'pen', pts = [], colour = 16, myTeam = hasSavedTeam ? parsedTeam : 0;
  let readyAt = 0, cooldownMs = 5000, connected = false, seq = 0, ws = null, retry = 500, scores = TEAMS.map(() => 0);
  let zonesOn = true;                   // server tells us whether team-zone restriction is enforced
  let ch = { state: 'idle', dur: 300000, endAt: 0, final: null, winners: [] };   // challenge state; endAt is on THIS browser's monotonic clock
  let shownResult = false;
  let undoLeft = 0;                       // how many of MY drawings can still be undone (server tells us)
  let redoLeft = 0;                       // how many of MY undone drawings can be restored
  let pid = store.get('pb_id', '');
  if (!/^[\w-]{8,64}$/.test(pid)) {
    pid = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
    store.set('pb_id', pid);
  }

  const baseCtx = $('base').getContext('2d');
  const prevCtx = $('prev').getContext('2d');
  let baseImg = baseCtx.createImageData(SIZE, SIZE);
  let prevImg = prevCtx.createImageData(SIZE, SIZE);

  /* ---------------- screen-level pixel writing (RGBA) ---------------- */
  function plotRGBA(img, x, y, rgb, a) {
    const o = (y * img.width + x) * 4;
    img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = a;
  }
  function paintIndex(i, c) { plotRGBA(baseImg, i % SIZE, (i / SIZE) | 0, COLOURS[c].rgb, 255); }
  function renderAll() {
    for (let i = 0; i < fb.data.length; i++) paintIndex(i, fb.data[i]);
    baseCtx.putImageData(baseImg, 0, 0);
  }
  function setSize(n) {
    SIZE = n;
    for (const id of ['base', 'prev']) { $(id).width = n; $(id).height = n; $(id).style.width = n + 'px'; $(id).style.height = n + 'px'; }
    $('world').style.width = n + 'px'; $('world').style.height = n + 'px';
    fb = Raster.createFB(n, n, BG);
    baseImg = baseCtx.createImageData(n, n); prevImg = prevCtx.createImageData(n, n);
    buildZones();
    fitView();
  }

  /* ---------------- team zones (visual overlay on the ONE shared canvas) ----------------
     Four equal quadrants from Board.zoneRect - the same geometry the server uses to validate drawing. */
  function buildZones() {
    const zs = $('zones'); zs.innerHTML = '';
    TEAMS.forEach((t) => {
      const [x0, y0, x1, y1] = Board.zoneRect(SIZE, t.id), [r, g, b] = COLOURS[t.colour].rgb;
      const d = document.createElement('div');
      d.className = 'zone'; d.dataset.t = t.id;
      d.style.cssText = `left:${x0}px;top:${y0}px;width:${x1 - x0 + 1}px;height:${y1 - y0 + 1}px;--zc:${COLOURS[t.colour].hex};--zt:rgba(${r},${g},${b},.05);--zt2:rgba(${r},${g},${b},.11)`;
      d.innerHTML = `<span></span>`;
      zs.appendChild(d);
    });
    updateZones();
  }
  function updateZones() {
    for (const d of $('zones').children) {
      const t = +d.dataset.t, mine = t === myTeam;
      d.classList.toggle('mine', mine);
      d.firstChild.textContent = mine ? `${TEAMS[t].name} - your zone` : TEAMS[t].name;
    }
  }

  /* ---------------- pixel grid overlay ----------------
     A screen-space canvas above the board. Its pixels are written by our own code (Uint32 writes into an ImageData),
     one device pixel wide, so every line is crisp and equally thick at any zoom. It never touches the frame buffer
     and has pointer-events:none, so it cannot influence drawing or coordinate mapping.                          */
  const gridCv = $('gridc'), gridCtx = gridCv.getContext('2d');
  let gridImg = null, gridQueued = false;
  const LE = (r, g, b, a) => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;     // RGBA -> little-endian Uint32
  function drawGrid() {
    gridQueued = false;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(stage.clientWidth * dpr)), H = Math.max(1, Math.round(stage.clientHeight * dpr));
    if (gridCv.width !== W || gridCv.height !== H || !gridImg) { gridCv.width = W; gridCv.height = H; gridImg = gridCtx.createImageData(W, H); }
    const px = new Uint32Array(gridImg.data.buffer); px.fill(0);
    const sr = stage.getBoundingClientRect();
    const wr = world.getBoundingClientRect();
    const cell = z * dpr;
    const ox = (wr.left - sr.left - stage.clientLeft) * dpr;
    const oy = (wr.top - sr.top - stage.clientTop) * dpr;
    const span = SIZE * cell;
    const xa = Math.max(0, Math.round(ox)), xb = Math.min(W, Math.round(ox + span));
    const ya = Math.max(0, Math.round(oy)), yb = Math.min(H, Math.round(oy + span));
    const vline = (sx, w, col) => { for (let x = sx; x < sx + w; x++) if (x >= 0 && x < W) for (let y = ya; y < yb; y++) px[y * W + x] = col; };
    const hline = (sy, w, col) => { for (let y = sy; y < sy + w; y++) if (y >= 0 && y < H) for (let x = xa; x < xb; x++) px[y * W + x] = col; };
    if (cell >= 5) {                                                           // thin grid only when pixels are big enough to be useful
      const a = Math.round(Math.min(70, 26 + (cell - 5) * 2.5));
      const col = LE(70, 82, 100, a);
      for (let k = 0; k <= SIZE; k++) { vline(Math.round(ox + k * cell), 1, col); hline(Math.round(oy + k * cell), 1, col); }
    }
    const mid = Math.ceil(SIZE / 2), dark = LE(35, 45, 65, 170), tw = dpr >= 2 ? 3 : 2;   // zone dividers (always visible)
    vline(Math.round(ox + mid * cell) - 1, tw, dark); hline(Math.round(oy + mid * cell) - 1, tw, dark);
    gridCtx.putImageData(gridImg, 0, 0);
  }
  const requestGrid = () => { if (!gridQueued) { gridQueued = true; requestAnimationFrame(drawGrid); } };

  /* ---------------- viewport: zoom + pan ----------------
     #stage is the fixed-size viewport (overflow:hidden, so zooming never changes the page layout).
     #world is always SIZE x SIZE CSS px and is only ever moved/scaled with ONE uniform transform,
     so the board stays perfectly square and the SIZE x SIZE pixel data is never touched by zoom. */
  const stage = $('stage'), world = $('world');
  const MAX_Z = 48;                         // largest zoom: 1 board pixel = 48 screen px
  const PAN_SLACK = 40;                     // how far (px) a zoomed board may be dragged past the viewport edge
  let z = 4, tx = 0, ty = 0;
  let fitZ = 4, minZ = 1;                   // zoom that fits the whole board / smallest allowed zoom
  let fitted = true;                        // true while the user has not zoomed away from "Fit"
  const canvasScrollSpace = $('canvasScrollSpace');
  const viewSize = () => ({ w: stage.clientWidth, h: stage.clientHeight });

  function computeFit() {
    const { w, h } = viewSize();
    fitZ = Math.max(0.1, Math.min(w, h) / SIZE * 0.96);      // whole board visible, 2% margin each side
    minZ = Math.min(fitZ, Math.max(0.5, fitZ * 0.5));        // zoom out to half of Fit (never below 0.5)
  }
  // Keep the board centred when it is smaller than the viewport; when it is larger, stop it being dragged away.
  function clampView() {
    const { w, h } = viewSize(), bw = SIZE * z;
    canvasScrollSpace.style.width = `${Math.max(w, bw)}px`;
    canvasScrollSpace.style.height = `${Math.max(h, bw)}px`;
    const left = bw <= w ? (w - bw) / 2 : 0;
    const top = bw <= h ? (h - bw) / 2 : 0;
    world.style.left = `${left}px`;
    world.style.top = `${top}px`;
    tx = stage.scrollLeft;
    ty = stage.scrollTop;
  }
  const applyView = (focus = null) => {
    clampView();
    world.style.transform = `scale(${z})`;
    if (focus) {
      const bw = SIZE * z;
      const left = bw <= viewSize().w ? (viewSize().w - bw) / 2 : 0;
      const top = bw <= viewSize().h ? (viewSize().h - bw) / 2 : 0;
      stage.scrollLeft = left + focus.bx * z - focus.cx;
      stage.scrollTop = top + focus.by * z - focus.cy;
    }
    stage.classList.toggle('can-pan', z > fitZ + 1e-6);
    $('zones').style.setProperty('--zline', `${Math.max(0.12, 2 / z)}px`);
    requestGrid();
    $('zpct').textContent = Math.round(z / fitZ * 100) + '%';           // 100% = "Fit"
    $('zpct').title = '1 board pixel = ' + z.toFixed(2) + ' screen px';
    $('zin').disabled = z >= MAX_Z - 1e-6;
    $('zout').disabled = z <= minZ + 1e-6;
  };
  function fitView() {
    computeFit();
    z = fitZ; tx = 0; ty = 0; fitted = true;
    stage.scrollLeft = 0;
    stage.scrollTop = 0;
    applyView();                                                         // clampView() centres it
  }
  function zoomAt(cx, cy, factor) {
    const nz = Math.min(MAX_Z, Math.max(minZ, z * factor));
    if (nz === z) return;
    const r = world.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const clientX = sr.left + stage.clientLeft + cx;
    const clientY = sr.top + stage.clientTop + cy;
    const bx = r.width ? (clientX - r.left) / r.width * SIZE : 0;
    const by = r.height ? (clientY - r.top) / r.height * SIZE : 0;
    z = nz;                                                                  // keep the point under the pointer fixed
    const focus = { bx, by, cx, cy };
    fitted = Math.abs(z - fitZ) < 1e-6;
    applyView(focus);
  }
  // Screen position -> board pixel. Uses the board's REAL on-screen rectangle (after zoom + pan)
  // and its logical size, so it is correct at every zoom level, for mouse and touch alike.
  function toPixel(clientX, clientY) {
    const r = world.getBoundingClientRect();
    return [Math.floor((clientX - r.left) / r.width * SIZE), Math.floor((clientY - r.top) / r.height * SIZE)];
  }
  const zoomCentre = (factor) => { const { w, h } = viewSize(); zoomAt(w / 2, h / 2, factor); };
  $('zin').onclick = () => zoomCentre(1.5);
  $('zout').onclick = () => zoomCentre(1 / 1.5);
  $('zfit').onclick = fitView;
  function onViewportResize() {
    computeFit();
    if (fitted) fitView();
    else { z = Math.min(MAX_Z, Math.max(minZ, z)); applyView(); }
  }
  if (window.ResizeObserver) new ResizeObserver(onViewportResize).observe(stage);
  else window.addEventListener('resize', onViewportResize);
  stage.addEventListener('scroll', () => { tx = stage.scrollLeft; ty = stage.scrollTop; requestGrid(); }, { passive: true });
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    const cx = e.clientX - r.left - stage.clientLeft;
    const cy = e.clientY - r.top - stage.clientTop;
    if (e.ctrlKey || e.metaKey || z <= fitZ + 1e-6) {
      zoomAt(cx, cy, Math.exp(-e.deltaY * 0.0015));
    } else {
      stage.scrollLeft += e.deltaX || (e.shiftKey ? e.deltaY : 0);
      stage.scrollTop += e.shiftKey ? 0 : e.deltaY;
    }
  }, { passive: false });

  // Pen drags make a connected stroke; other one-finger drags pan. Two fingers pinch and pan.
  const ptrs = new Map();
  let moved = false, pinchLast = null;
  const pinchInfo = () => {
    const [a, b] = [...ptrs.values()];
    const r = stage.getBoundingClientRect();
    return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2 - r.left - stage.clientLeft, my: (a.y + b.y) / 2 - r.top - stage.clientTop };
  };
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    const [x, y] = toPixel(e.clientX, e.clientY);
    const drawing = e.pointerType !== 'mouse' && tool === 'pen' && connected && !cooling() && Raster.inBounds(fb, x, y);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, drawing, points: drawing ? [[x, y]] : [] });
    if (ptrs.size === 1) moved = false;
    else {
      for (const p of ptrs.values()) p.drawing = false;
      if (tool === 'pen') { pts = []; updatePreview(); }
      moved = true; pinchLast = pinchInfo();
    }
  });
  stage.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p) { hoverAt(e.clientX, e.clientY); return; }
    if (ptrs.size === 1) {
      if (p.drawing) {
        const [x, y] = toPixel(e.clientX, e.clientY);
        const last = p.points[p.points.length - 1];
        if (Raster.inBounds(fb, x, y) && (x !== last[0] || y !== last[1])) p.points.push([x, y]);
        p.x = e.clientX; p.y = e.clientY;
        return;
      }
      if (!moved && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 6) moved = true;
      if (moved) {
        stage.classList.add('panning');
        stage.scrollLeft -= e.clientX - p.x;
        stage.scrollTop -= e.clientY - p.y;
        tx = stage.scrollLeft; ty = stage.scrollTop;
        requestGrid();
      }
      p.x = e.clientX; p.y = e.clientY;
    } else if (ptrs.size === 2) {
      p.x = e.clientX; p.y = e.clientY;
      const cur = pinchInfo();
      zoomAt(cur.mx, cur.my, cur.d / pinchLast.d);
      stage.scrollLeft -= cur.mx - pinchLast.mx;
      stage.scrollTop -= cur.my - pinchLast.my;
      pinchLast = cur;
    }
  });
  const endPtr = (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    const penStroke = p.drawing && e.type === 'pointerup';
    const wasTap = !p.drawing && ptrs.size === 1 && !moved && e.type === 'pointerup';
    if (penStroke) {
      const [x, y] = toPixel(e.clientX, e.clientY);
      const last = p.points[p.points.length - 1];
      if (Raster.inBounds(fb, x, y) && (x !== last[0] || y !== last[1])) p.points.push([x, y]);
      pts = p.points;
      updatePreview();
    }
    ptrs.delete(e.pointerId);
    if (!ptrs.size) stage.classList.remove('panning');
    if (ptrs.size === 1) { moved = true; const q = [...ptrs.values()][0]; q.sx = q.x; q.sy = q.y; }
    if (wasTap) tap(...toPixel(e.clientX, e.clientY));
  };
  stage.addEventListener('pointerup', endPtr);
  stage.addEventListener('pointercancel', endPtr);
  stage.addEventListener('pointerleave', () => { $('hover').style.display = 'none'; });

  function hoverAt(cx, cy) {
    const [x, y] = toPixel(cx, cy);
    const h = $('hover');
    if (Raster.inBounds(fb, x, y)) {
      h.style.display = 'block'; h.style.left = x + 'px'; h.style.top = y + 'px';
      const c = COLOURS[fb.data[y * SIZE + x]];
      $('coords').textContent = `x ${x}  y ${y}  ${c.name}`;
    } else { h.style.display = 'none'; }
  }

  /* ---------------- tools ---------------- */
  const TOOLS = [
    { id: 'pen',     label: 'Pen',     need: 1, hint: 'Tap for one pixel or drag to draw a connected stroke.' },
    { id: 'line',    label: 'Line',    need: 2, hint: 'Tap the start, then the end (Bresenham).' },
    { id: 'circle',  label: 'Circle',  need: 2, hint: 'Tap the centre, then a point on the rim (midpoint circle).' },
    { id: 'polygon', label: 'Polygon', need: 3, hint: 'Tap 3 to 8 corners (scan-line fill).' },
    { id: 'fill',    label: 'Bucket',  need: 1, hint: 'Tap inside an area (queue flood fill).' },
  ];
  const toolDef = () => TOOLS.find(t => t.id === tool);
  function buildTools() {
    $('tools').innerHTML = '';
    TOOLS.forEach((t, k) => {
      const b = document.createElement('button');
      b.innerHTML = `${icon(t.id)}<span>${t.label}</span>`;
      b.title = `${t.label} (key ${k + 1})`; b.setAttribute('aria-label', t.label);
      b.onclick = () => selectTool(t.id);
      b.dataset.id = t.id;
      $('tools').appendChild(b);
    });
  }
  function selectTool(id) {
    tool = id; pts = [];
    for (const b of $('tools').children) b.classList.toggle('on', b.dataset.id === id);
    $('fillOpt').classList.toggle('hidden', id !== 'circle');
    $('undoPt').classList.toggle('hidden', id !== 'polygon');
    $('hint').textContent = toolDef().hint;
    updatePreview();
  }

  function tap(x, y) {
    if (!Raster.inBounds(fb, x, y)) return;
    if (tool === 'pen' || tool === 'fill') pts = [[x, y]];
    else if (tool === 'line' || tool === 'circle') { if (pts.length === 0) pts = [[x, y]]; else pts = [pts[0], [x, y]]; }
    else if (tool === 'polygon') { if (pts.length < Raster.LIMITS.maxPoly) pts.push([x, y]); else toast('A polygon can have at most ' + Raster.LIMITS.maxPoly + ' corners'); }
    updatePreview();
  }

  function buildAction() {
    if (pts.length < toolDef().need) return null;
    return { tool, pts: pts.map(p => [p[0], p[1]]), c: colour, f: $('filled').checked ? 1 : 0 };
  }

  let previewOK = false;
  function updatePreview() {
    prevImg.data.fill(0);
    const marks = $('marks'); marks.innerHTML = '';
    for (const p of pts) {
      const d = document.createElement('div'); d.className = 'mark';
      d.style.left = p[0] + 'px'; d.style.top = p[1] + 'px'; marks.appendChild(d);
    }
    previewOK = false;
    const a = buildAction();
    if (a && a.tool === 'fill' && zonesOn) a.clip = Board.zoneRect(SIZE, myTeam);      // same clip the server applies
    const rgb = COLOURS[colour].rgb;
    const plot = (x, y) => { if (Raster.inBounds(fb, x, y)) plotRGBA(prevImg, x, y, rgb, 210); };
    setMsg('');
    if (a) {
      const r = Raster.rasterize(fb, a);
      if (r.error) setMsg(r.error);
      else {
        let n = 0, outside = 0;
        for (const i of r.idx) if (fb.data[i] !== a.c) {
          plot(i % SIZE, (i / SIZE) | 0); n++;
          if (zonesOn && Board.zoneTeam(SIZE, i % SIZE, (i / SIZE) | 0) !== myTeam) outside++;
        }
        if (a.tool === 'fill' && zonesOn && !n && Board.zoneTeam(SIZE, a.pts[0][0], a.pts[0][1]) !== myTeam) setMsg('Tap inside your own team zone.');
        else if (outside) setMsg('Stay inside your team zone (' + TEAMS[myTeam].name + ').');
        else if (n === 0) setMsg('Nothing would change here.');
        else { previewOK = true; setMsg(n + ' pixel' + (n > 1 ? 's' : '') + ' will change', true); }
      }
    } else if (tool === 'polygon' && pts.length === 2) {
      Raster.bresenham(pts[0][0], pts[0][1], pts[1][0], pts[1][1], plot);
    }
    prevCtx.putImageData(prevImg, 0, 0);
    refreshButtons();
  }

  function setMsg(t, good) { $('msg').textContent = t; $('msg').className = 'msg' + (good ? ' good' : ''); }
  const cooling = () => Date.now() < readyAt;
  function refreshButtons() {
    const unavailable = !connected || cooling() || ch.state === 'ended';
    for (const b of $('tools').children) b.disabled = unavailable;
    for (const b of $('palette').children) b.disabled = unavailable;
    $('panel').classList.toggle('cooling', cooling());
    $('place').disabled = !(previewOK && connected && !cooling() && ch.state !== 'ended');
    $('undoAction').disabled = !(connected && undoLeft > 0 && ch.state !== 'ended');
    $('redoAction').disabled = !(connected && redoLeft > 0 && ch.state !== 'ended');
    $('undoAction').textContent = undoLeft > 0 ? `Undo (${undoLeft})` : 'Undo';
    $('redoAction').textContent = redoLeft > 0 ? `Redo (${redoLeft})` : 'Redo';
  }

  $('cancel').onclick = () => { pts = []; updatePreview(); };
  $('undoPt').onclick = () => { pts.pop(); updatePreview(); };
  $('undoAction').onclick = () => {
    if (!connected || undoLeft < 1) return;
    seq++; ws.send(JSON.stringify({ t: 'undo', seq }));
  };
  $('redoAction').onclick = () => {
    if (!connected || redoLeft < 1) return;
    seq++; ws.send(JSON.stringify({ t: 'redo', seq }));
  };
  $('filled').onchange = updatePreview;
  $('place').onclick = place;
  function place() {
    const a = buildAction();
    if (!a || !previewOK || !connected || cooling()) return;
    seq++;
    ws.send(JSON.stringify({ t: 'act', seq, tool: a.tool, pts: a.pts, c: a.c, f: a.f }));
    $('place').disabled = true;
  }

  window.addEventListener('keydown', (e) => {
    if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (e.key >= '1' && e.key <= '5') selectTool(TOOLS[+e.key - 1].id);
    else if (e.key === 'Enter') place();
    else if (e.key === 'Escape') $('cancel').onclick();
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) $('redoAction').onclick();
      else $('undoAction').onclick();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault(); $('redoAction').onclick();
    }
  });

  /* ---------------- palette ---------------- */
  function buildPalette() {
    const pal = $('palette'); pal.innerHTML = '';
    COLOURS.forEach((c) => {
      const b = document.createElement('button');
      b.className = 'sw' + (c.team >= 0 ? ' team' : '');
      b.style.background = c.hex; b.title = c.name + ' ' + c.hex;
      if (c.team >= 0) b.dataset.t = TEAMS[c.team].name[0];
      b.onclick = () => selectColour(c.index);
      b.dataset.i = c.index;
      pal.appendChild(b);
    });
    const t = $('palTable');
    t.innerHTML = '<tr><th>#</th><th>Name</th><th>H</th><th>S</th><th>B</th><th>R</th><th>G</th><th>B</th><th>HEX</th></tr>' +
      COLOURS.map(c => `<tr><td>${c.index}</td><td><span class="chip" style="background:${c.hex}"></span>${c.name}</td>` +
        `<td>${c.h}&deg;</td><td>${c.s}%</td><td>${c.b}%</td><td>${c.rgb[0]}</td><td>${c.rgb[1]}</td><td>${c.rgb[2]}</td><td>${c.hex}</td></tr>`).join('');
  }
  function selectColour(i) {
    colour = i;
    for (const b of $('palette').children) b.classList.toggle('on', +b.dataset.i === i);
    const c = COLOURS[i];
    $('swatchInfo').innerHTML = `<b>#${c.index} ${c.name}</b>${c.team >= 0 ? ' (team colour)' : ''}<br>` +
      `HSB: <b>H ${c.h}&deg; S ${c.s}% B ${c.b}%</b><br>RGB(${c.rgb.join(', ')}) &nbsp; <b>${c.hex}</b>`;
    updatePreview();
  }

  /* ---------------- scoreboard ---------------- */
  function buildScoreboard() {
    const s = $('score'); s.innerHTML = '';
    TEAMS.forEach((t) => {
      const d = document.createElement('div'); d.className = 'sc'; d.id = 'sc' + t.id;
      d.innerHTML = `<div class="bar" style="background:${COLOURS[t.colour].hex}"></div><div class="nm">${t.name}</div><div class="ct">0</div>`;
      s.appendChild(d);
    });
  }
  function renderScores() {
    const total = scores.reduce((a, b) => a + b, 0) || 1;
    TEAMS.forEach((t) => {
      const d = $('sc' + t.id);
      d.querySelector('.ct').textContent = scores[t.id] + (scores[t.id] ? '  (' + Math.round(scores[t.id] * 100 / total) + '%)' : '');
      d.querySelector('.bar').style.width = (scores[t.id] * 100 / total) + '%';
      d.classList.toggle('me', t.id === myTeam);
    });
  }

  /* ---------------- cooldown display ---------------- */
  setInterval(() => {
    const rem = readyAt - Date.now();
    if (rem > 0) {
      $('cdfill').style.width = (100 * (1 - rem / cooldownMs)) + '%'; $('cdfill').style.background = '#003366';
      $('cdtxt').textContent = (rem / 1000).toFixed(1) + ' s';
    } else { $('cdfill').style.width = '100%'; $('cdfill').style.background = '#01F9C6'; $('cdtxt').textContent = 'Ready'; }
    refreshButtons();
  }, 100);

  /* ---------------- networking ---------------- */
  function setStatus(on, txt) { connected = on; $('dot').className = 'dot' + (on ? '' : ' off'); $('statusTxt').textContent = txt; refreshButtons(); }
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => {
      retry = 500;
      ws.send(JSON.stringify({ t: 'hello', id: pid, name: store.get('pb_name', 'Player'), team: myTeam }));
    };
    ws.onclose = () => { setStatus(false, 'reconnecting...'); setTimeout(connect, retry); retry = Math.min(retry * 2, 5000); };
    ws.onerror = () => {};
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'init') {
        if (m.size !== SIZE) setSize(m.size);
        for (let i = 0; i < m.grid.length; i++) fb.data[i] = parseInt(m.grid[i], 36);
        renderAll(); scores = m.scores; renderScores();
        cooldownMs = m.cooldown; readyAt = Date.now() + m.wait;
        $('online').textContent = m.online; $('actions').textContent = m.actions; undoLeft = m.undo || 0; redoLeft = m.redo || 0;
        zonesOn = m.zones !== false;
        if (Number.isInteger(m.team)) setMyTeam(m.team);                       // the server remembers my team
        applyChallenge(m.ch);
        setStatus(true, 'live'); updatePreview(); maybeStartTour();
      } else if (m.t === 'px') {
        m.idx.forEach((i, k) => { const col = m.cols ? m.cols[k] : m.c; Raster.setPixel(fb, i % SIZE, (i / SIZE) | 0, col); paintIndex(i, col); });
        baseCtx.putImageData(baseImg, 0, 0);
        scores = m.sc; renderScores();
        $('actions').textContent = m.n + 1;
        if (pts.length) updatePreview();
      } else if (m.t === 'online') {
        $('online').textContent = m.n;
      } else if (m.t === 'reset') {
        // new battle: drop everything local that belonged to the old one (the 'init' that follows carries the blank canvas)
        pts = []; undoLeft = 0; redoLeft = 0;      // (seq is NOT reset: the server rejects out-of-order sequence numbers)
        rpStop(); rp.log = []; rpReset(); rpDraw();
        $('rpSeek').max = 0; $('rpSeek').disabled = true; $('rpPlay').disabled = true; $('rpRec').disabled = true;
        $('rpInfo').textContent = 'A new battle started - load the log to replay it.';
        toast('The battle was reset');
      } else if (m.t === 'ch') {
        applyChallenge(m);
      } else if (m.t === 'team') {
        if (m.ok) { setMyTeam(m.team); colour = TEAMS[myTeam].colour; selectColour(colour); } else { setMyTeam(m.team); toast(m.reason); }
      } else if (m.t === 'adm') {
        toast(m.msg);
      } else if (m.t === 'ok') {
        readyAt = Date.now() + m.wait; cooldownMs = m.wait;
        undoLeft = m.undo || 0; redoLeft = m.redo || 0; pts = []; updatePreview(); setMsg('Placed ' + m.pixels + ' pixels', true);
      } else if (m.t === 'undone') {
        undoLeft = m.undo || 0; redoLeft = m.redo || 0; refreshButtons(); setMsg('Undone: ' + m.pixels + ' pixel' + (m.pixels === 1 ? '' : 's') + ' removed', true);
      } else if (m.t === 'redone') {
        undoLeft = m.undo || 0; redoLeft = m.redo || 0; refreshButtons(); setMsg('Redone: ' + m.pixels + ' pixel' + (m.pixels === 1 ? '' : 's') + ' restored', true);
      } else if (m.t === 'rej') {
        if (m.wait) readyAt = Date.now() + m.wait;
        toast(m.reason); setMsg(m.reason); refreshButtons();
      }
    };
  }

  /* ---------------- team (session) ---------------- */
  function setMyTeam(t) {
    myTeam = t; store.set('pb_team', t);
    $('teamSel').value = t; renderScores(); updateZones(); updatePreview();
  }

  /* ---------------- challenge timer (display only: the SERVER owns the clock) ----------------
     The server sends the REMAINING time; we count down on performance.now(), which does not depend on the
     device's wall clock, so changing the browser/system clock cannot change the timer.                      */
  const fmt = (ms) => { const s = Math.ceil(ms / 1000); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  function applyChallenge(info) {
    if (!info) return;
    const prev = ch.state;
    ch = { state: info.state, dur: info.dur, endAt: performance.now() + (info.rem || 0), final: info.final, winners: info.winners || [] };
    if (ch.state !== 'ended') { shownResult = false; $('result').classList.add('hidden'); }
    else if (!shownResult) showResult();
    if (prev !== ch.state) refreshButtons();
    renderTimer();
  }
  function renderTimer() {
    const left = ch.state === 'running' ? Math.max(0, ch.endAt - performance.now()) : 0;
    const txt = ch.state === 'running' ? fmt(left) : ch.state === 'ended' ? '00:00' : '--:--';
    $('chTime').textContent = txt; $('timerHead').textContent = txt;
    $('chState').textContent = ch.state === 'running' ? 'Challenge running - most team-colour pixels wins' :
      ch.state === 'ended' ? 'Challenge over' : 'Waiting for the host to start the challenge (warm-up drawing is allowed)';
    const bar = $('chbar');
    bar.classList.toggle('running', ch.state === 'running'); bar.classList.toggle('ended', ch.state === 'ended');
    bar.classList.toggle('low', ch.state === 'running' && left <= 30000);
  }
  setInterval(renderTimer, 200);
  function showResult() {
    shownResult = true;
    const f = ch.final || scores, w = ch.winners;
    const draw = w.length !== 1;
    const hex = draw ? '#36454F' : COLOURS[TEAMS[w[0]].colour].hex;
    $('resBadge').style.background = hex; $('resBadge').textContent = draw ? '=' : TEAM_WORD[w[0]][0];
    $('resTitle').textContent = draw ? 'It is a draw!' : `${TEAMS[w[0]].name} win!`;
    $('resTitle').style.color = hex;
    $('resSub').textContent = draw ? `Tied: ${w.map(i => TEAMS[i].name).join(' & ')} with ${f[w[0]]} pixel${f[w[0]] === 1 ? '' : 's'} each.` : `${f[w[0]]} pixel${f[w[0]] === 1 ? '' : 's'} in their team colour.`;
    $('resScores').innerHTML = TEAMS.map((t) => `<div class="${w.includes(t.id) ? 'win' : ''}" style="border-color:${COLOURS[t.colour].hex}"><span>${t.name}</span><span>${f[t.id]}</span></div>`).join('');
    $('result').classList.remove('hidden');
  }
  $('resClose').onclick = () => $('result').classList.add('hidden');

  /* host controls: only shown with ?host in the address; the SERVER checks the host key (or localhost) */
  const qs = new URLSearchParams(location.search);
  if (qs.has('host')) {
    $('hostBox').classList.remove('hidden');
    $('hostKey').classList.remove('hidden');
  }
  const hostSend = (cmd) => {
    if (!connected) return toast('Not connected');
    ws.send(JSON.stringify({ t: 'admin', cmd, key: $('hostKey').value, secs: Math.round((+$('hostMin').value || 5) * 60) }));
  };
  $('hostStart').onclick = () => hostSend('start');
  $('hostReset').onclick = () => { if (confirm('Reset Battle?\n\nThis clears the canvas, sets all scores to 0 and starts a new action history for everyone. Teams are kept.')) hostSend('reset'); };

  /* ---------------- toast ---------------- */
  let toastTimer = 0;
  function toast(t) { const e = $('toast'); e.textContent = t; e.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => e.classList.remove('show'), 2200); }

  /* ---------------- export PNG (we fill the pixels ourselves) ---------------- */
  $('exportPng').onclick = () => {
    const S = 8, cv = document.createElement('canvas');
    cv.width = SIZE * S; cv.height = SIZE * S;
    const ctx = cv.getContext('2d'), img = ctx.createImageData(cv.width, cv.height);
    for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
      plotRGBA(img, x, y, COLOURS[fb.data[((y / S) | 0) * SIZE + ((x / S) | 0)]].rgb, 255);
    }
    ctx.putImageData(img, 0, 0);
    cv.toBlob((blob) => download(blob, 'pixel-battle.png'));
  };
  function download(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /* ---------------- time-lapse replay ---------------- */
  const rpView = $('rpView'), rpCtx = rpView.getContext('2d');
  const rpOff = document.createElement('canvas'), rpOffCtx = rpOff.getContext('2d');
  const rp = { log: [], board: null, img: null, n: 0, playing: false, ap: 0, last: 0, rec: null };

  function rpReset() {
    rpOff.width = SIZE; rpOff.height = SIZE;
    rp.board = Board.create(SIZE, SIZE, BG);      // same code as the server => same picture
    rp.img = rpOffCtx.createImageData(SIZE, SIZE);
    for (let i = 0; i < SIZE * SIZE; i++) plotRGBA(rp.img, i % SIZE, (i / SIZE) | 0, COLOURS[BG].rgb, 255);
    rp.n = 0;
  }
  function rpAdvance(target) {
    while (rp.n < target) {
      const e = rp.log[rp.n];
      const res = Board.apply(rp.board, e, rp.n);   // handles drawings AND undo entries
      if (!res.error) for (const [i, , col] of res.changes) plotRGBA(rp.img, i % SIZE, (i / SIZE) | 0, COLOURS[col].rgb, 255);
      rp.n++;
    }
  }
  function rpDraw() {
    rpOffCtx.putImageData(rp.img, 0, 0);
    rpCtx.imageSmoothingEnabled = false;
    rpCtx.drawImage(rpOff, 0, 0, rpView.width, rpView.height);
    const N = rp.log.length;
    $('rpSeek').value = rp.n;
    if (rp.n === 0) { $('rpInfo').textContent = `0 / ${N} actions`; return; }
    const e = rp.log[rp.n - 1], t0 = rp.log[0].ts, s = Math.round((e.ts - t0) / 1000);
    $('rpInfo').textContent = `${rp.n} / ${N} actions  |  battle time ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}  |  ${e.p} (${TEAMS[e.tm].name}) ${e.tool === 'undo' ? 'undid an action' : e.tool === 'redo' ? 'redid an action' : 'used ' + e.tool}`;
  }
  function rpSeekTo(n) { if (n < rp.n) rpReset(); rpAdvance(n); rpDraw(); }
  function rpRate() {
    const v = $('rpSpeed').value, N = rp.log.length;
    if (v === 'fit30') return Math.max(1, N / 30);
    if (v === 'fit60') return Math.max(1, N / 60);
    return +v;
  }
  function rpTick(now) {
    if (!rp.playing) return;
    const dt = Math.min(0.2, (now - rp.last) / 1000); rp.last = now;
    rp.ap += dt * rpRate();
    const target = Math.min(rp.log.length, Math.floor(rp.ap));
    if (target > rp.n) rpAdvance(target);
    rpDraw();
    if (rp.n >= rp.log.length) { rpStop(); return; }
    requestAnimationFrame(rpTick);
  }
  function rpPlay() {
    if (!rp.log.length) return;
    if (rp.n >= rp.log.length) { rpReset(); }
    rp.ap = rp.n; rp.playing = true; rp.last = performance.now();
    $('rpPlay').textContent = 'Pause';
    requestAnimationFrame(rpTick);
  }
  function rpStop() {
    rp.playing = false; $('rpPlay').textContent = 'Play';
    if (rp.rec) { const r = rp.rec; rp.rec = null; setTimeout(() => r.stop(), 500); }
  }
  $('rpLoad').onclick = async () => {
    try {
      const r = await fetch('/api/log', { cache: 'no-store' }); const j = await r.json();
      rp.log = j.log; rpReset(); rpDraw();
      $('rpSeek').max = rp.log.length; $('rpSeek').disabled = !rp.log.length;
      $('rpPlay').disabled = !rp.log.length; $('rpRec').disabled = !rp.log.length;
      if (!rp.log.length) $('rpInfo').textContent = 'No actions yet - paint something first!';
    } catch (_) { toast('Could not load the log'); }
  };
  $('rpPlay').onclick = () => { if (rp.playing) rpStop(); else rpPlay(); };
  $('rpSeek').oninput = () => { if (rp.playing) rpStop(); rpSeekTo(+$('rpSeek').value); };
  $('rpRec').onclick = () => {
    if (!window.MediaRecorder || !rpView.captureStream) return toast('Video recording is not supported in this browser');
    rpStop(); rpReset(); rpDraw();
    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mime = types.find(t => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(rpView.captureStream(30), mime ? { mimeType: mime, videoBitsPerSecond: 4e6 } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => download(new Blob(chunks, { type: 'video/webm' }), 'pixel-battle-replay.webm');
    rec.start(); rp.rec = rec; rpPlay();
    toast('Recording... it downloads when the replay ends');
  };

  /* ---------------- intro flow: welcome > rules > team > confirm > start ---------------- */
  const TEAM_WORD = ['Red', 'Blue', 'Green', 'Gold'];
  let teamPicked = hasSavedTeam;   // returning players keep their team
  function showStep(n) {
    document.querySelectorAll('#join .step').forEach((s) => s.classList.toggle('on', +s.dataset.step === n));
    document.querySelectorAll('#wizDots i').forEach((d, i) => d.classList.toggle('on', i <= n));
  }
  function fillConfirm() {
    const t = TEAMS[myTeam], hex = COLOURS[t.colour].hex;
    $('teamBadge').style.background = hex;
    $('teamBadge').textContent = TEAM_WORD[myTeam][0];
    $('teamMsg').textContent = `You are on the ${TEAM_WORD[myTeam]} team!`;
    $('teamMsg').style.color = hex;
    $('teamSub').textContent = `${t.name}, ${($('nameIn').value.trim() || 'Player')}. Paint with ${TEAM_WORD[myTeam].toLowerCase()} and grab as much canvas as you can.`;
  }
  function buildJoin() {
    const pick = $('teamPick'); pick.innerHTML = '';
    TEAMS.forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = t.name; b.dataset.t = t.id;
      b.style.borderColor = COLOURS[t.colour].hex;
      b.onclick = () => {
        myTeam = t.id; teamPicked = true; $('toConfirm').disabled = false;
        for (const x of pick.children) x.classList.toggle('on', +x.dataset.t === myTeam);
      };
      pick.appendChild(b);
    });
    if (teamPicked) { pick.children[myTeam].classList.add('on'); $('toConfirm').disabled = false; }
    $('nameIn').value = store.get('pb_name', '');
    document.querySelectorAll('#join [data-go]').forEach((b) => {
      b.onclick = () => { const n = +b.dataset.go; if (n === 3) fillConfirm(); showStep(n); };
    });
    const sel = $('teamSel');
    TEAMS.forEach((t) => { const o = document.createElement('option'); o.value = t.id; o.textContent = t.name; sel.appendChild(o); });
    sel.onchange = () => {
      if (connected) ws.send(JSON.stringify({ t: 'team', team: +sel.value }));      // the server validates and confirms the change
      else sel.value = myTeam;
    };
  }
  $('joinBtn').onclick = () => {
    store.set('pb_name', $('nameIn').value.trim() || 'Player');
    store.set('pb_team', myTeam);
    $('join').classList.add('hidden');
    $('teamSel').value = myTeam;
    colour = TEAMS[myTeam].colour; selectColour(colour); renderScores();
    fitView(); connect();
    toast(`You are on the ${TEAM_WORD[myTeam]} team. Good luck!`);
  };

  /* ---------------- first-time onboarding ---------------- */
  const TOUR_STEPS = [
    { target: '#stage', title: 'Shared drawing canvas', text: 'This is the shared canvas. Every pixel you place appears here for all players.' },
    { target: '#tools', title: 'Drawing tools', text: 'Choose Pen, Line, Circle, Polygon or Paint Bucket. The pen also supports connected drag strokes.' },
    { target: '#palette', title: '16-color palette', text: 'Select a color here. Its HSB, RGB and HEX values are shown just below the palette.' },
    { target: '#cooldown', title: 'Five-second cooldown', text: 'Each drawing action starts a five-second countdown. The bar and disabled controls show when you can draw again.' },
    { target: '#score', title: 'Live team scoreboard', text: 'Each score counts the pixels currently owned by that team color, including replacements.' },
  ];
  let tourStep = 0, tourTarget = null, autoTourOpened = false;
  function positionTour() {
    if (!tourTarget || $('tourCard').classList.contains('hidden')) return;
    const r = tourTarget.getBoundingClientRect(), card = $('tourCard');
    const margin = 12, width = card.offsetWidth, height = card.offsetHeight;
    const left = r.left + r.width / 2 - width / 2;
    let top = r.bottom + margin;
    if (top + height > window.innerHeight - margin) top = r.top - height - margin;
    top = Math.max(margin, Math.min(window.innerHeight - height - margin, top));
    card.style.setProperty('--tour-left', `${left}px`); card.style.top = `${top}px`;
  }
  function closeTour() {
    if (tourTarget) tourTarget.classList.remove('tour-spotlight');
    tourTarget = null;
    $('tourShade').classList.add('hidden');
    $('tourCard').classList.add('hidden');
    $('helpBtn').focus();
  }
  function renderTourStep(index, direction = 1) {
    const step = TOUR_STEPS[index];
    let target = document.querySelector(step.target);
    if (!target || !target.getClientRects().length || target.getBoundingClientRect().width === 0) {
      const next = index + direction;
      if (next >= 0 && next < TOUR_STEPS.length) return renderTourStep(next, direction);
      closeTour(); return;
    }
    if (tourTarget) tourTarget.classList.remove('tour-spotlight');
    tourStep = index;
    tourTarget = target;
    target.classList.add('tour-spotlight');
    $('tourCount').textContent = `Step ${index + 1} of ${TOUR_STEPS.length}`;
    $('tourTitle').textContent = step.title;
    $('tourText').textContent = step.text;
    $('tourBack').disabled = index === 0;
    $('tourNext').classList.toggle('hidden', index === TOUR_STEPS.length - 1);
    $('tourFinish').classList.toggle('hidden', index !== TOUR_STEPS.length - 1);
    $('tourShade').classList.remove('hidden');
    $('tourCard').classList.remove('hidden');
    positionTour();
    target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    positionTour();
    requestAnimationFrame(positionTour);
    setTimeout(positionTour, 250);
  }
  function startTour() {
    renderTourStep(0);
    $('tourSkip').focus();
  }
  $('tourNext').onclick = () => renderTourStep(Math.min(tourStep + 1, TOUR_STEPS.length - 1), 1);
  $('tourBack').onclick = () => renderTourStep(Math.max(tourStep - 1, 0), -1);
  $('tourSkip').onclick = closeTour;
  $('tourFinish').onclick = () => { store.set('pb_tour_done', '1'); closeTour(); };
  $('helpBtn').onclick = startTour;
  window.addEventListener('resize', positionTour);
  window.addEventListener('scroll', positionTour, true);
  function maybeStartTour() {
    if (autoTourOpened) return;
    autoTourOpened = true;
    if (store.get('pb_tour_done', '0') !== '1') startTour();
  }

  buildTools(); buildPalette(); buildScoreboard(); buildJoin();
  selectTool('pen'); selectColour(TEAMS[myTeam].colour); fitView(); renderScores();
  setSize(SIZE); renderAll(); setStatus(false, 'not joined');
})();