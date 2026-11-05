/* board.js - the battle state: frame buffer + WHO owns each pixel + undo.
   Shared by the Node server (live game), the browser replay and the tests, so all three
   run exactly the same code and therefore always end with the same picture.

   A log entry is either a drawing   { tool:'pen'|'line'|..., pts, c, f, ... }
                  or an undo         { tool:'undo', ref: n }   (n = log position of the drawing it removes)

   Undo rule (fair to other players): a pixel goes back to its old colour ONLY if it still belongs to the
   action being undone. If somebody painted over it later, their pixel stays.                          */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./raster.js'));
  else root.Board = factory(root.Raster);
})(typeof self !== 'undefined' ? self : this, function (Raster) {

  function create(w, h, bg) {
    return {
      fb: Raster.createFB(w, h, bg),
      owner: new Int32Array(w * h).fill(-1),   // log position of the action that last painted the pixel (-1 = nobody)
      hist: new Map(),                         // log position -> { before: [[index, oldColour, oldOwner], ...], undone }
    };
  }

  // Applies one VALID log entry at log position n.
  // Returns { changes: [[index, oldColour, newColour], ...] } or { error }.
  function apply(board, entry, n) {
    const { fb, owner, hist } = board;
    if (entry.tool === 'undo') {
      const target = hist.get(entry.ref);
      if (!target) return { error: 'Nothing to undo' };
      if (target.undone) return { error: 'Already undone' };
      const changes = [];
      for (const [i, oldColour, oldOwner] of target.before) {
        if (owner[i] !== entry.ref) continue;           // painted over by someone else: leave it
        let colour = oldColour, who = oldOwner;
        // the previous owner may itself have been undone meanwhile: look further back
        while (who >= 0 && hist.get(who) && hist.get(who).undone) {
          const rec = hist.get(who).before.find(b => b[0] === i);
          if (!rec) break;
          colour = rec[1]; who = rec[2];
        }
        changes.push([i, fb.data[i], colour]);
        Raster.setPixel(fb, i % fb.w, (i / fb.w) | 0, colour);
        owner[i] = who;
      }
      target.undone = true;
      return { changes };
    }

    const res = Raster.applyAction(fb, entry);          // writes the pixels with setPixel
    if (res.error) return res;
    const changes = [], before = [];
    for (const [i, old] of res.changes) {
      before.push([i, old, owner[i]]);
      changes.push([i, old, entry.c]);
      owner[i] = n;
    }
    if (before.length) hist.set(n, { before, undone: false });
    return { changes };
  }

  return { create, apply };
});
