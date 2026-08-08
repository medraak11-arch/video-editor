/* ---------------------------------------------------------------------------
   graphic.ts — the two drawings on the start-up splash. docs/RELEASE.md §3.8.

   THIS FILE IS THE ONLY PLACE IN src/splash/ PERMITTED TO NAME --accent, and it
   spends it on exactly one thing: the 28 px application mark, which IS the
   taskbar icon the user just clicked. docs/ICON.md §2 fenced the accent budget
   away from the OS icons; DESIGN.md's Three Uses Rule and PLAN §7.4 extend that
   fence by one clause to cover the mark's reproduction at identity scale
   (≤ 32 px), and scripts/check-contract.mjs allows this path and no other. The
   rest of the splash still fails the build if it so much as mentions the accent.

   Everything else here is drawn in --surface-well, --border-structural and
   --text-on-well: lightness separations only, so the whole image survives
   desaturation and every colour-vision deficiency intact (§3.3).

   Both functions return SVG markup. No DOM, no React, no dependency.
--------------------------------------------------------------------------- */

/* ------------------------------------------------------------- the mark
   ICON.md §3, the 256 px row of the size ladder, expressed as a viewBox so it
   is resolution-independent: 28 px of vector is not 28 px of bitmap, and three
   lanes are the mark's full statement.

   Tile 12..244 (232 wide, r 46.4). Lane run starts at x 36 and is 183 wide.
   Lanes 47 / 108 / 169, each 40 tall, spans [0,0.78] [0.16,1.00] [0,0.62] of
   the run. The cut is 26 wide at x 97, painted OVER the clips in the tile
   colour, spanning the lane block's y-range and nothing more.               */

const MARK_LANES: ReadonlyArray<{ y: number; x: number; w: number }> = [
  { y: 47, x: 36, w: 143 },
  { y: 108, x: 65, w: 154 },
  { y: 169, x: 36, w: 113 },
];

export function appMarkSvg(size: number): string {
  const lanes = MARK_LANES.map(
    (l) => `<rect x="${l.x}" y="${l.y}" width="${l.w}" height="40" rx="3.6" fill="var(--accent)" />`,
  ).join('');
  return [
    `<svg class="ve-splash-mark" width="${size}" height="${size}" viewBox="0 0 256 256"`,
    ' xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">',
    '<rect x="12" y="12" width="232" height="232" rx="46.4" fill="var(--surface-well)" />',
    lanes,
    '<rect x="97" y="47" width="26" height="162" fill="var(--surface-well)" />',
    '</svg>',
  ].join('');
}

/* -------------------------------------------------------------- the bench
   Six lanes, forty-one clips, one cut, one lit clip — PRODUCT.md principle 1
   (the frame is the only lit thing) and principle 4 (forty clips across six
   tracks) in one static image, at the same clip count as the dev:web fixture.

   Authored and fixed, never randomised: a splash that differs between launches
   is decoration, and this one is a diagram.                                 */

/** `[x, width]` in viewBox px. Lane y values are LANE_Y, pitch 94, height 60. */
const BENCH_SPANS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [
    [-20, 96],
    [84, 72],
    [164, 48],
    [220, 64],
    [292, 148],
    [448, 64],
    [520, 96],
  ],
  [
    [-20, 56],
    [44, 160],
    [212, 88],
    [308, 52],
    [368, 112],
    [488, 76],
    [572, 48],
  ],
  [
    [-20, 140],
    [128, 64],
    [200, 148],
    [356, 72],
    [436, 56],
    [500, 64],
    [572, 48],
  ],
  [
    [-20, 72],
    [60, 100],
    [168, 120],
    [300, 88],
    [400, 56],
    [468, 64],
    [544, 72],
  ],
  [
    [-20, 108],
    [96, 56],
    [160, 128],
    [296, 68],
    [372, 96],
    [476, 52],
    [536, 80],
  ],
  [
    [-20, 84],
    [72, 136],
    [216, 60],
    [284, 92],
    [384, 120],
    [512, 104],
  ],
];

const LANE_Y = [-2, 92, 186, 280, 374, 468] as const;
const LANE_H = 60;
/** Lane 3's [200,148]: vertically central, left of centre, crossed by the cut. */
const LIT = { lane: 2, x: 200 } as const;

export function benchSvg(): string {
  const clips: string[] = [];
  BENCH_SPANS.forEach((lane, i) => {
    for (const [x, w] of lane) {
      const lit = i === LIT.lane && x === LIT.x;
      clips.push(
        `<rect x="${x}" y="${LANE_Y[i]}" width="${w}" height="${LANE_H}" rx="3" fill="${
          lit ? 'var(--text-on-well)' : 'var(--border-structural)'
        }" />`,
      );
    }
  });
  return [
    '<svg class="ve-splash-bench" viewBox="0 0 575 560" preserveAspectRatio="xMidYMid slice"',
    ' xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">',
    clips.join(''),
    // The cut: a --surface-well void painted over every lane, which is why it
    // reads at 18.3:1 through the lit clip and 4.80:1 through the dim ones.
    '<rect x="236" y="-2" width="26" height="564" fill="var(--surface-well)" />',
    '</svg>',
  ].join('');
}
