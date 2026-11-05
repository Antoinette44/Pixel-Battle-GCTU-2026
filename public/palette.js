/* palette.js - 16-colour palette designed in HSB + 4 team colours.
   Shared by the browser and the Node server (UMD).
   HSB -> RGB and RGB -> HSB are written by hand (Week 2, slide 22). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Palette = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // H in degrees 0-360, S and B in percent 0-100  ->  [R, G, B] 0-255
  function hsbToRgb(h, s, b) {
    s /= 100; b /= 100;
    const c = b * s;                                   // chroma
    const hp = (((h % 360) + 360) % 360) / 60;         // sector 0..6
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r = 0, g = 0, bl = 0;
    if (hp < 1)      { r = c; g = x; }
    else if (hp < 2) { r = x; g = c; }
    else if (hp < 3) { g = c; bl = x; }
    else if (hp < 4) { g = x; bl = c; }
    else if (hp < 5) { r = x; bl = c; }
    else             { r = c; bl = x; }
    const m = b - c;
    return [r + m, g + m, bl + m].map(v => Math.round(v * 255));
  }

  // [R, G, B] 0-255 -> {h, s, b}  (same formulas as the lecture)
  function rgbToHsb(r, g, b) {
    const R = r / 255, G = g / 255, B = b / 255;
    const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === R)      h = 60 * ((((G - B) / d) % 6 + 6) % 6);
      else if (max === G) h = 60 * ((B - R) / d + 2);
      else                h = 60 * ((R - G) / d + 4);
    }
    return { h: Math.round(h), s: Math.round((max === 0 ? 0 : d / max) * 100), b: Math.round(max * 100) };
  }

  const toHex = (rgb) => '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();

  // The 16 designed colours: [name, H, S, B]. Index 0 is the blank-canvas colour.
  const DESIGN = [
    ['Paper',   0,   0, 100],
    ['Fog',   220,   8,  75],
    ['Slate', 220,  18,  42],
    ['Ink',   240,  30,  12],
    ['Rose',  345,  60,  95],
    ['Orange', 25,  90,  98],
    ['Sun',    52,  85, 100],
    ['Lime',   85,  70,  85],
    ['Forest',150,  75,  55],
    ['Teal',  175,  80,  70],
    ['Sky',   200,  70,  98],
    ['Ocean', 222,  75,  80],
    ['Indigo',255,  65,  68],
    ['Violet',285,  60,  82],
    ['Magenta',320, 75,  90],
    ['Cocoa',  25,  60,  42],
  ];
  // Team colours (indices 16..19): saturated, easy to tell apart.
  const TEAM_DESIGN = [
    ['Red Rockets',  0, 95, 90],
    ['Blue Bolts', 215, 95, 90],
    ['Green Giants',130, 95, 72],
    ['Gold Griffins',42, 100, 100],
  ];

  const COLOURS = DESIGN.concat(TEAM_DESIGN).map(([name, h, s, b], i) => {
    const rgb = hsbToRgb(h, s, b);
    return { index: i, name, h, s, b, rgb, hex: toHex(rgb), team: i >= 16 ? i - 16 : -1 };
  });
  const TEAMS = TEAM_DESIGN.map((t, i) => ({ id: i, name: t[0], colour: 16 + i }));

  return { hsbToRgb, rgbToHsb, toHex, COLOURS, TEAMS, BG: 0, NUM: COLOURS.length };
});
