/* board.js - the battle state: frame buffer + WHO owns each pixel + undo/redo.
   Shared by the Node server (live game), the browser replay and the tests, so all three
   run exactly the same code and therefore always end with the same picture.

   A log entry is either a drawing   { tool:'pen'|'line'|..., pts, c, f, ... }
                  or an undo/redo    { tool:'undo'|'redo', ref: n }   (n = log position of the drawing it changes)

   Undo rule (fair to other players): a pixel's colour and team go back ONLY if it still belongs to the
   action being undone. If somebody painted over it later, their pixel stays.                           */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./raster.js'));
  else root.Board = factory(root.Raster);
})(typeof self !== 'undefined' ? self : this, function (Raster) {

  function create(w, h, bg) {
    return {
      fb: Raster.createFB(w, h, bg),
      bg,
      owner: new Int32Array(w * h).fill(-1),   // log position of the action that last painted the pixel (-1 = nobody)
      teams: new Int8Array(w * h).fill(-1),    // team that owns each pixel; independent of its drawing colour
      hist: new Map(),                         // log position -> { before: [[index, oldColour, oldOwner, oldTeam], ...], undone }
    };
  }

  // Applies one VALID log entry at log position n.
  // Returns { changes: [[index, oldColour, newColour, oldTeam, newTeam], ...] } or { error }.
  function apply(board, entry, n) {
    const { fb, owner, teams, hist } = board;
    if (entry.tool === 'undo') {
      const target = hist.get(entry.ref);
      if (!target) return { error: 'Nothing to undo' };
      if (target.undone) return { error: 'Already undone' };
      const changes = [], redo = [];
      for (const [i, oldColour, oldOwner, oldTeam] of target.before) {
        if (owner[i] !== entry.ref) continue;           // painted over by someone else: leave it
        let colour = oldColour, who = oldOwner, team = oldTeam;
        // the previous owner may itself have been undone meanwhile: look further back
        while (who >= 0 && hist.get(who) && hist.get(who).undone) {
          const rec = hist.get(who).before.find(b => b[0] === i);
          if (!rec) break;
          colour = rec[1]; who = rec[2]; team = rec[3];
        }
        changes.push([i, fb.data[i], colour, teams[i], team]);
        redo.push([i, colour, who, team]);
        Raster.setPixel(fb, i % fb.w, (i / fb.w) | 0, colour);
        owner[i] = who;
        teams[i] = team;
      }
      target.undone = true;
      target.redo = redo;
      return { changes };
    }
    if (entry.tool === 'redo') {
      const target = hist.get(entry.ref);
      if (!target) return { error: 'Nothing to redo' };
      if (!target.undone) return { error: 'Action is not undone' };
      const changes = [];
      for (const [i, oldColour, oldOwner, oldTeam] of target.redo || []) {
        if (owner[i] !== oldOwner || fb.data[i] !== oldColour || teams[i] !== oldTeam) continue;
        changes.push([i, fb.data[i], target.colour, teams[i], target.team]);
        Raster.setPixel(fb, i % fb.w, (i / fb.w) | 0, target.colour);
        owner[i] = entry.ref;
        teams[i] = target.team;
      }
      target.undone = false;
      target.redo = null;
      return { changes };
    }

    const res = Raster.rasterize(fb, entry, true);
    if (res.error) return res;
    const changes = [], before = [];
    const erasing = entry.tool === 'eraser';
    const colour = erasing ? board.bg : entry.c;
    const team = erasing ? -1 : Number.isInteger(entry.tm) && entry.tm >= 0 && entry.tm < 4 ? entry.tm : -1;
    for (const i of res.idx) {
      const old = fb.data[i], oldTeam = teams[i];
      if (old === colour && oldTeam === team) continue;
      before.push([i, old, owner[i], oldTeam]);
      changes.push([i, old, colour, oldTeam, team]);
      if (old !== colour) Raster.setPixel(fb, i % fb.w, (i / fb.w) | 0, colour);
      owner[i] = n;
      teams[i] = team;
    }
    if (before.length) hist.set(n, { before, undone: false, colour, team });
    return { changes };
  }

  /* ---- team zones: the canvas is split into 4 equal quadrants (purely geometry on the SAME frame buffer) ----
     team 0 = top-left, 1 = top-right, 2 = bottom-left, 3 = bottom-right.                                   */
  const zoneTeam = (size, x, y) => (x * 2 >= size ? 1 : 0) + (y * 2 >= size ? 2 : 0);
  function zoneRect(size, team) {                        // inclusive [x0, y0, x1, y1]
    const half = Math.ceil(size / 2), cx = team & 1, cy = team >> 1;
    return [cx ? half : 0, cy ? half : 0, cx ? size - 1 : half - 1, cy ? size - 1 : half - 1];
  }

  return { create, apply, zoneTeam, zoneRect };
});
