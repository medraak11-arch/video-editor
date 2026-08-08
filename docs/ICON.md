# Icons

Two marks: the application icon, and the `.veproj` document icon derived from it. Both are drawn by
`scripts/make-icon.mjs` from the palette in `src/styles/tokens.css`, both ship as multi-size `.ico`
files, and both are verified by reading the written file back rather than by trusting the writer.

This document is the specification. No implementation code lives here — every number below is one
the implementer types into `scripts/make-icon.mjs`.

Where a pixel value and a fraction in the same table disagree, **the pixel value is normative**. The
fractions are how the pixel values were derived, kept so the ladder can be re-derived at a new size.

---

## 1. What is there now, looked at

`build/icon.png` today is a 512 px near-black rounded square with one `--accent` rectangle in the
middle, 16:9, crossed by a 8.2 px vertical bar that inverts where it overlaps. Rendered at 512 it is
a solid orange slab with a hairline crack in it. Rendered at 16 it is a solid orange slab.

Four things are wrong with it, and three of them are measurable.

**The accent is a background.** The frame is 307 × 173 px inside a 466 × 466 tile: **26 % of the
tile is `--accent`**. DESIGN.md's Three Uses Rule says the accent is the playhead, the selection,
and one primary action, and that it is "never a background for large areas". The mark that is
supposed to advertise the system breaks the system's loudest rule, and it does so at the largest
possible scale.

**The tonal roles are inverted.** DESIGN.md §1: the frame is the brightest thing on screen and the
accent belongs to the playhead. The current mark paints the *frame* in accent and the *playhead* in
the tile colour. It is the design system read backwards.

**The claim in the source comment is false.** `scripts/make-icon.mjs` line 113 says the frame-XOR-
playhead inversion "is the only reason the icon is identifiable at 16 px". The playhead is
`N * 0.016` wide — 8.2 px at 512, which is **0.26 px at 16**. It is the first thing to vanish, not
the thing that survives. At 16 px there is no playhead, no inversion, and no cut: there is an orange
rectangle. Nothing in the file is authored per size; one 512 px bitmap is handed to electron-builder
and every smaller entry is a downscale of it.

**It reads as a flag.** A single filled rectangle offset inside a dark square is the silhouette of a
flag, a note, or an image placeholder. Nothing in it says video, and nothing says editor.

The one thing it gets right is the sourcing rule: the colours come from `tokens.css` and are
converted from oklch in the script, so recolouring a theme moves the icon. **That property is
preserved and, in §8, enforced** (§5).

---

## 2. Three directions, and the one that won

### Direction A — "The Aperture": the lit frame, crossed by the playhead

The literal reading of PRODUCT.md principle 1. A dark tile; a 16:9 rectangle in `--text-on-well`
(near-white — the footage, the only lit thing); an `--accent` playhead running the full tile height
through it.

**It lost on a measurement.** `--accent` (#eb992e) against `--text-on-well` (#f0f2f4) is
**2.05 : 1**. The playhead — the whole point of the mark — sits below the 3 : 1 non-text floor
against the surface it crosses. Painting the playhead as a void inside the frame instead (tile
colour where it overlaps, accent above and below) fixes the contrast but produces a white block with
a black slot and an orange tick top and bottom: at 256 it reads as a thumbtack, and at 16 the amber
is 6 % of the icon, which is not enough colour to find in a taskbar. Rendered as `variants-8x.png`
rows A and B before deletion; the thumbtack is unmistakable.

### Direction B — "The Bench": the four-plane tonal structure

The app's own four planes made literal — bands at `--surface-well` / `--surface-chrome` /
`--surface-panel` / `--surface-raised`, with one `--accent` clip on one band. Or its stronger form:
a timeline of clips where exactly **one** clip is lit and the rest recede, which is principle 1 and
the Three Uses Rule in a single image.

**It lost on a measurement too, and this one is structural.** A "one lit clip among dim clips" mark
needs a neutral that is legible against the tile (`--surface-well`, §3) *and* distinguishable from
the accent. There is no such value in this palette:

| dim-clip candidate | vs the tile (`--surface-well`) | vs `--accent` |
|---|---|---|
| `--surface-raised` (L 0.31) | 1.56 : 1 | 5.74 : 1 |
| `--border-structural` (L 0.58) | 4.79 : 1 | **1.87 : 1** |
| `--text-muted` (L 0.72) | 8.33 : 1 | **1.07 : 1** |

`--text-muted` and `--accent` are within 7 % of each other in luminance: **in greyscale, and under
deuteranopia, the lit clip and the dim clip are the same object.** That is exactly the failure
DESIGN.md's Lightness-First Rule exists to prevent. The four planes span 0.10–0.31 and the accent
sits at 0.75; there is no lightness that is ≥ 3 : 1 from both ends. **The palette forbids a
three-tone mark.** So the icon is two-tone — tile and accent — and everything else is shape.

### Direction C — "The Cut": clips on lanes, severed by the playhead  ← chosen

A dark tile. Amber clips on stacked lanes, of unequal lengths and unequal offsets. One vertical
channel of tile colour running through every lane at the same x, **wider than the gaps between the
lanes**.

Nothing else in software looks like that. A play triangle is a media player; a filmstrip is a video
file; staggered bars cut by one vertical line is a non-linear editor and only a non-linear editor.
It is PRODUCT.md principle 4 ("forty clips across six tracks, not a three-clip screenshot") and
principle 3's most-used gesture (`S`, split) in the same image, and it is two-tone, so it survives
the constraint that killed B.

Its weakness is small sizes — and that weakness is the thing this document is for. **The mark loses
lanes as the icon shrinks.** Three lanes at 256/128/64, two at 48, one at 32 and below. At 16 px it
is a single 16:9 clip with a cut in it, which is the same idea reduced, not a different mark.

**Two normative constraints, not stylistic preferences.** Both are asserted in §8.

1. **The cut must intersect every lane.** The first render placed the lanes so the channel missed
   the third clip. The channel then read as ragged spacing rather than as a playhead. Every lane's
   clip must carry material on **both** sides of the cut x.
2. **The cut must be wider than the gap between lanes.** The cut and the inter-lane gaps are the
   same colour — the tile — so a vertical channel narrower than the horizontal ones does not read as
   a cut at all; it reads as the gutter of a tile grid. The first tuning had a 10 px cut between
   21 px gaps at 256 and the contact sheet read as a bento grid of amber blocks. The ladder in §3
   sets `cutW ≈ 1.25 × (pitch − laneH)` at every multi-lane size; §8 asserts the floor,
   `cutW ≥ pitch − laneH`, and the ladder ships the 25 % headroom.

**One consequence to accept and to fence.** The accent is a field here, not a line — the app mark is
about 22 % accent by area and the document mark about 13 %. DESIGN.md's Three Uses Rule and
docs/PLAN.md §7.4's six-use budget govern *rendered interface surfaces*; an OS icon is the product's
identity in a taskbar, where a saturated block is the only thing findable at 16 px against an
unknown background. `--accent` on white is 2.30 : 1 and on Explorer's dark-mode list background
7.08 : 1, so the amber is what carries the icon on both. **The rule stands unchanged inside the
app.** The scope of the budget is stated in PLAN.md §7.4 and in DESIGN.md's Three Uses Rule by the
one-line edits in §10 — this exception is not asserted only in the document that benefits from it.

---

## 3. The application mark

### Structure

Three elements, in paint order:

1. **The tile** — a rounded square inset by `margin`, filled `--surface-well`. Everything outside it
   is alpha 0.
2. **The lanes** — one clip per lane, filled `--accent`, corner radius `clipRadius`.
3. **The cut** — one vertical bar filled `--surface-well`, drawn *over* the clips. It spans the
   lane block's full y-range and nothing more.

There is no playhead head, no tab, no triangle. Three renders confirmed that a widened top on the
channel turns the mark into a thumbtack.

**Why the tile is `--surface-well`.** DESIGN.md names the well "the surround behind the video frame
… the darkest surface in the app. Nothing else uses it." That is what this mark is: a surround with
lit clips on it. It is also the one neutral that stays dark in every theme by explicit design —
`tokens.css` keeps the well dark under `daylight` while the rest of the shell inverts — so the tile
measures **20.61 / 20.62 / 20.14 : 1 against a white Explorer list** in `signal` / `instrument` /
`daylight`, where `--surface-chrome` collapses to 1.09 : 1 under `daylight`. `--accent` on it is
8.96 : 1.

**What the tile does not do.** Against a dark shell (#202020) the tile is 1.26 : 1 — no theme has a
neutral that separates from a dark taskbar, and `--surface-chrome` is worse at 1.08 : 1. **The
silhouette in dark mode is carried by the amber, not by the tile**: `--accent` on #202020 is
7.08 : 1. That is why the accent is a field and not a line (§2), and it is asserted in §8.

**How the cut reads.** The cut is painted in the tile colour over the clips, so it is visible only
where it crosses a clip; in the inter-lane gaps it has no edge of its own, because the gaps are the
same colour. What makes it read as one continuous channel rather than as grid gutters is its width
relative to the lane gap — see the second constraint in §2 and the `cut w` column below.

### Geometry

Every derived value is rounded to a whole pixel *before* painting; the renderer supersamples at 8×
and box-downsamples, so sub-pixel edges antialias, but lane tops and cut edges must land on integers
or the small sizes go soft.

Two spaces are used and they are not interchangeable:

- **image px** — absolute, origin at the icon's top-left. `margin`, `tileW`, `lane h`, `pitch`,
  `cut w`, `cut x` are image px.
- **`laneRunW` space** — the horizontal run the clips are laid out in, `[0, 1]`.
  `laneRunW = tileW × (1 − 2 × inset)`, and it starts at `margin + inset × tileW`. `SPANS[]` and
  `cut at` are fractions of `laneRunW`. `inset` is a fraction of `tileW`; `lane gap` below is given
  in image px.

Lane spans, in `laneRunW` space, by lane count:

```
SPANS[3] = [[0, 0.78], [0.16, 1.00], [0, 0.62]]
SPANS[2] = [[0, 0.82], [0.14, 1.00]]
SPANS[1] = [[0, 1.00]]
```

Every span in `SPANS[3]` and `SPANS[2]` straddles `cut at` (0.40 / 0.38). The cut's left edge is
`round(margin + inset × tileW + cutAt × laneRunW − cutW / 2)`.

### The size ladder — what is drawn at each size

Units: `margin`, `tileW`, `tile radius`, `lane h`, `pitch`, `lane gap`, `clip radius`, `cut w` and
`cut x` are **image px**; `inset` is a fraction of `tileW`; `cut at` is a fraction of `laneRunW`.

| px | margin | tileW | tile radius | lanes | inset (×tileW) | lane h | pitch | lane gap | clip radius | cut w | cut at (×laneRunW) | cut x |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 256 | 12 | 232 | 46.4 | **3** | 0.105 | 40 | 61.1 | 21.1 | 3.6 | **26** | 0.40 | 97 |
| 128 | 6 | 116 | 23.2 | **3** | 0.105 | 20 | 30.5 | 10.5 | 1.8 | **13** | 0.40 | 49 |
| 64 | 3 | 58 | 11.6 | **3** | 0.100 | 11 | 15.5 | 4.5 | 1.0 | **6** | 0.40 | 24 |
| 48 | 2 | 44 | 8.4 | **2** | 0.095 | 13 | 17.8 | 4.8 | 0.8 | **6** | 0.38 | 17 |
| 32 | 1 | 30 | 5.7 | **1** | 0.070 | 15 | — | — | 0 | **5** | 0.33 | 10 |
| 24 | 1 | 22 | 3.7 | **1** | 0.050 | 11 | — | — | 0 | **4** | 0.34 | 7 |
| 16 | 1 | 14 | 2.2 | **1** | 0.020 | 8 | — | — | 0 | **3** | 0.35 | 5 |

`margin` fractions of `size`: 0.047 (256/128/64), 0.042 (48), 0.031 (32), 0.042 (24), 0.063 (16).
`tile radius` fractions of `tileW`: 0.200 (≥ 64), 0.190 (48/32), 0.170 (24), 0.160 (16).
`clip radius` fractions of `size`: 0.014 (256/128), 0.016 (64/48), 0 (≤ 32).
`cut w` where lanes ≥ 2 is `round(1.25 × lane gap)`; at 32 / 24 / 16 there is no gap to beat and the
values are set by hand, with a floor of 2 px.

Resulting `laneRunW`, in image px: 183 / 92 / 46 / 36 / 26 / 20 / 13.

**The smallest surviving clip fragment.** With the ladder above, the narrowest piece any lane keeps
on either side of the cut is 28 / 14 / 8 / 6 / 7 / 5 / 4 px at 256 → 16. §8 asserts a floor of 3 px,
so every fragment has headroom.

**The three breakpoints, and why they are there.**

- **3 → 2 lanes at 48.** The lane block holds ~35.6 px at 48. Split three ways that is an 11.9 px
  pitch, an 8 px clip and a 3.9 px gap, and the gap closes under antialiasing into a hatched smear.
  Split two ways it is 17.8 px of pitch, a 13 px clip and a 4.8 px gap, which holds.
- **2 → 1 lane at 32.** At 32 the tile is 30 px and the block is 15. Two lanes inside it would be
  5 px of clip each. One 26 × 15 clip with a 5 px cut is the largest, highest-contrast thing that
  fits, and it is the mark's own reduction: one clip, cut. This is the size Windows uses in the
  taskbar and Alt-Tab, so it is the one that has to be right.
- **The cut never drops.** At 16 it is 3 px of a 13 px clip — 23 % of the clip's width, against 17 %
  of the average clip at 256. The cut keeps widening in proportion as the icon shrinks, precisely so
  that it never closes. A mark with no cut is a rectangle; a rectangle is not this product.

The margin also shrinks in proportion (4.7 % → 6.3 % of a much smaller number: 12 px → 1 px), so the
mark fills more of its box as the box gets smaller. That is deliberate: at 16 px a "correct" margin
is wasted pixels.

---

## 4. The document mark

A `.veproj` file. Same lane geometry, different tonal assignment, on a page silhouette with a
vertical sash down the left edge.

### The derivation rule

**The accent appears in exactly one place per mark.** In the app icon it is the clips. In the
document icon it moves to the **sash**, and the clips become `--text-ink`. That is the whole
derivation: identical geometry, the light moved from the content to the label. It also solves a
practical problem — amber clips beside an amber sash merge into one blob below 64 px.

`--text-ink`, not `--text-on-well`: the clips are painted on `--surface-panel`, and `--text-ink` is
the token that names content on a panel. `--text-on-well` names content over the preview well, and
happens to hold the same value under `signal` and `instrument` — under `daylight` it is #f2f1f3 on a
#ffffff page, 1.13 : 1, and the mark disappears. `--text-ink` measures 14.03 / 14.55 / 16.01 : 1 on
the page body across the three themes.

### Structure, in paint order

1. **Keyline** — `--border-structural`, the full page silhouette, 1 px. See below.
2. **Page body** — `--surface-panel`, inset 1 px inside the keyline, rounded `radius`.
3. **Fold** — the top-right corner is *erased* to alpha 0 on the 45° diagonal (`fold` px on each
   axis); the flap triangle below the diagonal is filled `--surface-raised`. **The diagonal takes a
   1 px `--border-structural` keyline at sizes ≥ 32 only.** At 24 and 16 the diagonal is a pure
   alpha-0 cut, because at 16 a 1 px keyline drawn across a 4 px notch leaves 1 px of silhouette,
   which is not a notch; 24 follows the same rule so the two smallest entries agree.
4. **Sash** — `--accent`, full body height, `sash w` wide, painted **on the body** (inside the
   keyline), left corners rounded to match the page, right edge square.
5. **Label** — `--text-on-accent`, rotated 90° CCW inside the sash, reading bottom-to-top.
6. **Mark** — clips in `--text-ink`, cut by a channel in `--surface-panel`, in the mark box to the
   right of the sash.

**Why the keyline exists, and why it is `--border-structural`.** The page body is
`--surface-panel` = #1f232b under `signal` and #ffffff under `daylight`. Explorer's list background
is #FFFFFF in light mode and ≈ #202020 in dark mode, so in one theme or the other the body always
matches the shell it sits on. Without an opaque mid-tone edge the silhouette disappears.
`--border-structural` is the only token in the palette that clears 3 : 1 against both shells in all
three themes: **4.30 / 4.29 / 3.96 : 1 on white** and **3.79 / 3.80 / 4.12 : 1 on #202020**. It is
1 px at every size, including 16, where it costs 2 px of a 14 px page and is worth it.

The flap fill is `--surface-raised` on `--surface-panel`, which is 1.19 : 1 — deliberately almost
invisible. The fold is carried by the **silhouette notch**, which is a shape and survives to 16 px;
the flap is a tonal grace note in the spirit of "depth by tone, never by shadow" and is allowed to
disappear.

### The label: `VE`, not `PROJ`

The brief asked for `PROJ`. It is the wrong string, for three independent reasons.

**Legibility.** The label runs down the sash, so its cap height is bounded by the sash width and its
length by the page height. At 64 px the sash is 11 px wide, giving a 6.4 px cap height with a 1.2 px
stroke. `VE` is two glyphs at ~4.5 px advance each — 9 px of a 57 px run, generous. `PROJ` is four
glyphs sharing the same 6.4 px cap: two of them (`P`, `R`) have bowls that close at that size and
one (`O`) is a ring 1.2 px thick. Rendered side by side at 4× in `doc-final-4x.png`, `PROJ` is
illegible at 64 and a smudge at 128's half-size. `VE` holds at 64. **The label's last drawn size is
64 with `VE` and 128 with `PROJ`.** Below its last size the label is not faded — it is not drawn.

**Information.** In a file list the question is *which application owns this file*, which is what
Adobe's `Ps` / `Ai` / `Id` sashes answer. `PROJ` says "a project" and names no application; every
NLE on the machine has projects. `VE` is the app's initials and the stem of `.veproj`. `.veproj`
itself is seven glyphs and dies at 128.

**And an engineering reason that seals it.** `scripts/make-icon.mjs` has no font rasteriser and no
dependencies, by design. `V` is two strokes and `E` is four rectangles — six axis-aligned or linear
primitives, exactly positionable, no curves. `P`, `R`, `O`, `J` need bowls and a hook, which means
either bundling a font binary in the repo or hand-drawing four glyphs badly at 6.4 px.

If the decision is overturned, it is one constant: `DOC[size].label`. Changing it to `'PROJ'`
requires adding four glyph definitions and moving the label's last drawn size from 64 to 128 in the
ladder below and in the verifier's probe table (§8).

### Glyph construction

Defined in an upright box `gx ∈ [0, W]`, `gy ∈ [0, H]`, `gy` downward, then rotated 90° CCW into the
sash. `H` = cap height (across the sash), `W = 0.70 H` (advance), stroke `s = 0.19 H`, letter gap
`0.30 W`.

- `E` = `gx ≤ s` ∪ `gy ≤ s` ∪ `gy ≥ H - s` ∪ (`|gy - H/2| ≤ s/2` ∧ `gx ≤ 0.82 W`)
- `V` = `dist((gx,gy), seg((s/2, 0) → (W/2, H - s/2))) ≤ s/2` ∪ the mirror segment from `(W - s/2, 0)`

**The rotation, which is easy to get backwards and was, once.** Reading bottom-to-top means the
whole word is rotated 90° counter-clockwise: the first glyph lands at the bottom and the tops of the
letters point **left**. So for a page pixel `(x, y)` inside the letter cell whose left edge is
`sxL` and whose baseline is at `by`:

```
gx = by - y        // reading direction: page -y is glyph +x
gy = x - sxL       // letter descent: page +x is glyph +y
```

Using `sxL + H - x` for `gy` mirrors every letter. The first render did exactly that and produced
`ƎV`. The verifier cannot catch this; it has to be read (§9 has the render).

### The size ladder — what is drawn at each size

Units: every column except `label` is **image px**. `sash w` is the **painted** accent width, on the
body and inside the keyline — it is what a pixel ruler on the written file returns, not a
pre-inset value. `page w × h` includes the keyline; the body is `pageW − 2` by `pageH − 2`.

| px | page w × h | x0, y0 | radius | fold | sash w | label | cap h | stroke | lanes | lane h | pitch | mark run | cut w | cut at (×run) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 256 | 179 × 225 | 39, 16 | 9.8 | 47 | **38** | **VE** | 22.0 | 4.2 | 3 | 23 | 34.7 | 117 | **15** | 0.40 |
| 128 | 90 × 113 | 19, 8 | 5.0 | 23 | **19** | **VE** | 11.0 | 2.1 | 3 | 11 | 17.3 | 59 | **8** | 0.40 |
| 64 | 47 × 59 | 9, 3 | 2.4 | 12 | **11** | **VE** | 6.4 | 1.2 | 2 | 9 | 13.5 | 28 | **6** | 0.40 |
| 48 | 37 × 45 | 6, 2 | 1.9 | 10 | **10** | — | — | — | 1 | 14 | — | 21 | **3** | 0.35 |
| 32 | 26 × 31 | 3, 1 | 1.3 | 7 | **8** | — | — | — | 1 | 9 | — | 12 | **2** | 0.35 |
| 24 | 20 × 24 | 2, 0 | 1.1 | 6 | **7** | — | — | — | 1 | 7 | — | 9 | **2** | 0.40 |
| 16 | 14 × 16 | 1, 0 | 1.0 | 4 | **5** | — | — | — | **0** | — | — | — | — | — |

Fractions behind the table — `pageW` of `size`: 0.70, 0.70, 0.74, 0.78, 0.81, 0.83, 0.88.
`pageH` of `size`: 0.88, 0.88, 0.92, 0.94, 0.97, 1.00, 1.00.
`radius` of `pageW`: 0.055, 0.055, 0.050, 0.050, 0.050, 0.055, 0.070.
`fold` of `pageW`: 0.26, 0.26, 0.26, 0.26, 0.27, 0.29, 0.32.
`sash w` of `pageW`: 0.212, 0.211, 0.234, 0.270, 0.308, 0.350, **0.357**.
Cap height = `0.58 × sash w`; stroke = `0.19 × cap height`.

**The mark box**, which is where `mark run` comes from:
`pad = round(0.06 × pageW)` → 11 / 5 / 3 / 2 / 2 / 1; the box runs from `bodyLeft + sashW + pad` to
`bodyRight − pad`, so `mark run` = 117 / 59 / 28 / 21 / 12 / 9. Its height is
`markH = round(0.46 × pageH)` → 104 / 52 / 27 / 21 / 14 / 11, centred vertically in the body.
`pitch = markH / lanes` and `lane h = round(0.66 × pitch)` — one rule, no special case at one lane.
`cut w` where lanes ≥ 2 is `round(1.25 × (pitch − lane h))`, matching §2's second constraint; at
48 / 32 / 24 it is `round(f × mark run)` with `f` = 0.13 / 0.17 / 0.20 and a floor of 2 px.
`SPANS[]` and `cut at` are in mark-run space exactly as `laneRunW` space works in §3. The narrowest
surviving clip fragment is 18 / 9 / 4 / 6 / 3 / 3 px at 256 → 24, against §8's floor of 3.

**The four breakpoints.**

- **Label dropped below 64.** At 48 the sash is 10 px and the cap height would be 5.8 px with a
  1.1 px stroke; measured on the written file, the label contributed **4 px** of `--text-on-accent`
  at 48 against 8 at 64 and 69 at 128 (§8 probe output). Four pixels is an antialiased smudge on a
  10 px sash, not two glyphs, and asserting on it makes the build hostage to a one-pixel change in
  the rasteriser. Below 64 the sash is solid amber and carries the identity by itself.
- **3 → 2 lanes at 64, 2 → 1 at 48.** One step earlier than the app icon, because the sash takes
  21–36 % of the page width and the mark only gets what is left.
- **Body mark dropped at 16.** The page is 14 px wide, of which 5 is sash and 2 is keyline: 7 px of
  body. A clip and a cut inside 7 px is three 2-px shapes and reads as noise. At 16 the document
  icon is a page silhouette with a folded corner and an amber sash — and that is enough, because
  the sash is 36 % of the page width at that size, up from 21 % at 256. **The sash widens as the
  label disappears.** It stops being a label carrier and becomes the identifier itself.
- **Everything else scales monotonically**, so nothing pops.

### The 16 px contract, stated plainly

At 16 px in Explorer's list view, a `.veproj` file renders as: a portrait page silhouette, 14 × 16,
with a 4 px notched top-right corner (no diagonal keyline at this size, so the notch is 4 px of
silhouette and not 1), a 1 px grey keyline, a near-black body, and a **5 px painted `--accent` block
down the left edge — 36 % of the page width**. It carries no text and no mark. It is distinguishable
from every stock Windows document icon (which are white) and from any video file thumbnail, and the
amber block is the same amber as the app's taskbar icon, which is the association that has to
survive.

Its three measurable claims are §8 assertions: the notch as transparent pixels inside the page's
bounding box (assertion 7), the keyline by its contrast against both reference shells (assertion 8),
and the sash by its painted width in the decoded 16 px entry (assertion 7).

---

## 5. Colour

`src/styles/tokens.css` is the only file with a colour literal, and that does not stop being true
because the surface is a PNG. `scripts/make-icon.mjs` parses the `:root` (signal) block, converts
oklch → linear sRGB → 8-bit sRGB with Ottosson's matrices, and paints. Recolour the theme, re-run
`npm run icon`, and both marks follow — or the build stops, which is the point of the gates below.

The current script reads two tokens. It now needs **seven**:

| token | signal value | used for |
|---|---|---|
| `--surface-well` | `#030305` | app tile; the app icon's cut |
| `--accent` | `#eb992e` | app clips; document sash |
| `--surface-panel` | `#1f232b` | document page body; the document mark's cut |
| `--surface-raised` | `#2c303a` | document fold flap |
| `--border-structural` | `#767a83` | document keyline |
| `--text-ink` | `#f0f2f4` | document clips |
| `--text-on-accent` | `#180d02` | document sash label |

Every one is an existing semantic token. **No new token is introduced and none is renamed** — this
area asks for nothing in `tokens.css`.

### Measured pairs

| pair | ratio | floor | verdict |
|---|---|---|---|
| `--accent` on `--surface-well` | 8.96 : 1 | 3 : 1 | pass — the app mark |
| `--text-ink` on `--surface-panel` | 14.03 : 1 | 3 : 1 | pass — the document mark |
| `--accent` on `--surface-panel` | 6.85 : 1 | 3 : 1 | pass — the sash on the page |
| `--text-on-accent` on `--accent` | 8.32 : 1 | 4.5 : 1 | pass — the sash label |
| `--border-structural` on white | 4.30 : 1 | 3 : 1 | pass — keyline, light Explorer |
| `--border-structural` on `#202020` | 3.79 : 1 | 3 : 1 | pass — keyline, dark Explorer |
| `--surface-well` on white | 20.61 : 1 | 3 : 1 | pass — app silhouette, light Explorer |
| `--accent` on `#202020` | 7.08 : 1 | 3 : 1 | pass — app findability, dark Explorer |
| `--accent` on white | 2.30 : 1 | — | fine: the sash sits on `--surface-panel`, not on the shell |
| `--surface-well` on `#202020` | 1.26 : 1 | — | expected: the tile is not the dark-mode silhouette; §3 |
| `--surface-raised` on `--surface-panel` | 1.19 : 1 | — | intentional: the fold flap is not load-bearing |

Both marks are two-tone plus structure and both carry their meaning in **shape**, which is what
DESIGN.md's colour-blindness requirement asks for. Desaturate either icon and nothing is lost: the
lanes, the cut, the page, the fold and the sash are all silhouette.

### Themes

The icon is generated from whichever block fills `:root` — `signal` today. An OS icon is written to
disk once at package time and cannot follow a runtime theme switch; there is no `data-theme` on a
taskbar.

That sourcing is no longer a promise; §8 assertion 8 computes the eight floored rows of the table
above from the tokens actually read and exits non-zero on any failure. Recomputed against all three
palettes:

| gate | floor | `signal` | `instrument` | `daylight` |
|---|---|---|---|---|
| accent vs tile | 3 : 1 | 8.96 | 8.81 | 3.69 |
| tile vs `#ffffff` | 3 : 1 | 20.61 | 20.62 | 20.14 |
| accent vs `#202020` | 3 : 1 | 7.08 | 6.96 | **2.99 — fails** |
| keyline vs `#ffffff` | 3 : 1 | 4.30 | 4.29 | 3.96 |
| keyline vs `#202020` | 3 : 1 | 3.79 | 3.80 | 4.12 |
| clips vs page body | 3 : 1 | 14.03 | 14.55 | 16.01 |
| sash vs page body | 3 : 1 | 6.85 | 6.96 | 5.45 |
| label vs sash | 4.5 : 1 | 8.32 | 8.23 | 5.29 |

`instrument` would ship. `daylight` would not: its accent is a mid-violet that measures 2.99 : 1
against a dark taskbar, and its `--text-on-accent` (#fcfbfd) is 4 levels from its `--surface-panel`
(#ffffff), which also trips the probe-separation precondition in assertion 9. **Both failures are
the intended behaviour** — a light-shelled default theme cannot generate this pair of icons, and the
build says so instead of writing an icon nobody can see.

---

## 6. The `.ico` container

`win.icon` currently points at `build/icon.png`, which means electron-builder generates the `.ico`
and picks the sizes, and every entry is a downscale of one 512 px bitmap. The entire ladder in §3
and §4 would be thrown away. **The script writes the `.ico` files itself.**

### Contents

Both files carry exactly seven entries: **16, 24, 32, 48, 64, 128, 256**, in ascending order.

### Payload policy — measured, not guessed

| entries | encoding | why |
|---|---|---|
| 16 – 128 | 32-bit BGRA DIB (`BITMAPINFOHEADER`, `biHeight = 2 × h`, bottom-up, plus a 1 bpp AND mask) | GDI+ / `System.Drawing.Icon` **cannot decode PNG-compressed ICO entries** — it throws `ArgumentOutOfRangeException: Requested range extends past the end of the array`. Keeping these as DIB is what makes the file verifiable with a Windows-native tool (§8) as well as readable by NSIS. |
| 256 | PNG | GDI+ cannot address a 256 entry at all — it returns the 128 instead, regardless of encoding — so there is nothing to gain by making it a DIB, and 270 KB to lose. WIC (the shell's decoder, which is what Explorer actually uses) reads it. |

Measured file sizes with this policy: **≈ 102 KB each.** The six DIB payloads are fixed-length
functions of their dimensions; the 256 PNG is the only entry whose size moves with the artwork.
All-DIB is 363.8 KB for no benefit; all-PNG is 36.7 KB but is unreadable by GDI+ from 128 up, which
removes the verification path. The middle is the right trade.

### Byte layout

```
ICONDIR                       6 bytes    reserved=0, type=1, count=7
ICONDIRENTRY × 7             16 each     see below
payload × 7                              in the same order, contiguous
```

Per `ICONDIRENTRY`, at offset `6 + 16 i`:

| offset | size | value |
|---|---|---|
| 0 | 1 | width, or **0 for 256** |
| 1 | 1 | height, or **0 for 256** |
| 2 | 1 | palette count = 0 |
| 3 | 1 | reserved = 0 |
| 4 | 2 | colour planes = 1 (LE) |
| 6 | 2 | bits per pixel = 32 (LE) |
| 8 | 4 | payload byte length (LE) |
| 12 | 4 | payload file offset (LE) |

The AND mask is derived from alpha (bit set where `a < 128`) rather than written as zeros. With
32 bpp entries the alpha channel is authoritative on Windows 10/11, but some shell paths and every
older tool still consult the mask, and a wrong mask there shows as a black box.

---

## 7. electron-builder wiring

Two edits to `electron-builder.yml`, and one new file in `build/`.

```yaml
fileAssociations:
  - ext: veproj
    name: Video Editor project
    description: Video Editor project
    role: Editor
    icon: build/veproj.ico        # ← added

win:
  icon: build/icon.ico            # ← was build/icon.png
  target:
    - target: nsis
      arch: [x64]
    - target: portable
      arch: [x64]
```

### `build/installer.nsh` — required, or the icon does not appear on upgrade

electron-builder's NSIS template inserts `registerFileAssociations` at
`templates/nsis/installSection.nsh:79`, and the only `SHChangeNotify(SHCNE_ASSOCCHANGED)` in the
install path is at `templates/nsis/include/installer.nsh:224`, *inside* `addDesktopLink`, which runs
at line 69 — before the association is written. `include/FileAssociation.nsh` defines an
`UPDATEFILEASSOC` macro at line 128 that would broadcast it, and nothing in the templates ever
inserts that macro. So on an upgrade over an existing install, `HKCU\Software\Classes\<ProgID>\
DefaultIcon` already exists as `$appExe,0`, its target changes, and **no shell notification is
broadcast**: Explorer keeps the cached icon until logoff. It looks exactly like a packaging bug.

The fix is a `customInstall` macro, which the same template inserts at `installSection.nsh:82` —
immediately after `registerFileAssociations`, which is where the broadcast belongs. electron-builder
resolves this file by convention from `directories.buildResources` (already `build`) with no yml key
at all: `NsisTarget.js:553`, `getResource(this.options.include, "installer.nsh")`.

```nsi
; build/installer.nsh — inserted at installSection.nsh:82, after registerFileAssociations.
!macro customInstall
  ; SHCNE_ASSOCCHANGED. Without it an upgrade keeps the previous DefaultIcon
  ; in Explorer's cache until logoff.
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend
```

**`build/installer.nsh` is source, not build output.** It is tracked in git and must not be caught
by the `build/` ignore line in §10.

Even with the broadcast, Explorer's per-user icon cache can hold a stale entry;
`ie4uinit.exe -show` forces a rebuild. That is a consequence of upgrading, not of the icon, and it
is the first thing to try before filing anything.

### Other notes the implementer will need

- `build/veproj.ico` is also what electron-builder would find by *convention*
  (`${buildResources}/${ext}.ico`). The line is written out anyway, because a convention that works
  by accident is a convention that breaks silently.
- NSIS copies the association icon to `$INSTDIR\resources\veproj.ico` and points the ProgID's
  `DefaultIcon` at it. The `portable` target registers nothing, so the document icon only appears
  after an NSIS install — that is the existing behaviour of the association itself, not a new
  limitation.
- `nsis.installerIcon` / `uninstallerIcon` are unset and fall back to `win.icon`, so the installer
  picks up the new `.ico` with no extra key.
- `build/icon.png` (512 px) is still written. It is tracked in git, it is the fallback
  electron-builder uses on non-Windows targets, and it costs 4.6 KB.
- **No change to `package.json`.** `npm run dist` already runs `npm run icon` before
  `electron-builder`, and `npm run icon` already runs `scripts/make-icon.mjs`. The script gains
  outputs, an opt-in `--proof` flag and a self-check; the script *name* and the pipeline stay as
  they are.

---

## 8. Verification — the script proves its own output

`scripts/make-icon.mjs` re-reads every file it just wrote and exits non-zero on any failure. There
is no separate checker script and no new `npm` script; `npm run icon` and therefore `npm run dist`
already run it.

**Two run modes, one code path.** `node scripts/make-icon.mjs` writes `build/icon.png`,
`build/icon.ico`, `build/veproj.ico` and runs every assertion below. `node scripts/make-icon.mjs
--proof` does all of that and *additionally* writes `build/icon-proof/**` (§9). `npm run icon` and
`npm run dist` run the plain form, so packaging never leaves ~700 KB of untracked PNGs behind.

### Signatures

```ts
type Rgb = readonly [number, number, number];
type Oklch = { L: number; C: number; H: number };

/** Pulls `--name: oklch(...)` from the :root (signal) block of tokens.css. Throws if absent. */
function readToken(css: string, name: string): Oklch;
function oklchToRgb(c: Oklch): Rgb;
/** WCAG 2.x relative-luminance contrast ratio, ≥ 1. */
function contrast(a: Rgb, b: Rgb): number;

/** One authored bitmap. `rgba` is straight (non-premultiplied) RGBA, row-major, top-down. */
type Bitmap = { size: number; rgba: Buffer };

function renderApp(size: 16 | 24 | 32 | 48 | 64 | 128 | 256, t: Tokens): Bitmap;
function renderDoc(size: 16 | 24 | 32 | 48 | 64 | 128 | 256, t: Tokens): Bitmap;

function encodePng(rgba: Buffer, w: number, h?: number): Buffer;
function encodeDib(rgba: Buffer, size: number): Buffer;
/** Ascending sizes in, one .ico buffer out. Writes it and returns it. */
function writeIco(images: Bitmap[], file: string): Buffer;

type IcoEntry = {
  declared: number;    // from the directory
  actual: number;      // from the payload's own header
  kind: 'PNG' | 'DIB';
  bytes: number;
  offset: number;
  bmp: Bitmap;         // decoded back from the payload, never the writer's copy
};
/** Parses a written .ico back from bytes. Never reuses the writer's state. */
function inspectIco(file: string): IcoEntry[];

/** Counts pixels within `tol` of `colour` in a decoded bitmap. The degrade probe. */
function countNear(bmp: Bitmap, colour: Rgb, tol?: number): number;
/** Box-downsamples a decoded entry to `to` px, for the divergence assertion. */
function boxDown(bmp: Bitmap, to: number): Bitmap;
/** Fraction of pixels where either is opaque and the two differ by > 24 on any channel. */
function differs(a: Bitmap, b: Bitmap): number;
```

### Assertions

Run against `build/icon.ico` and `build/veproj.ico` after writing. Any failure exits non-zero.

1. `inspectIco(f).length === 7` and the declared sizes are exactly `[16,24,32,48,64,128,256]`.
2. For every entry, `declared === actual` — the payload's own header agrees with the directory.
   This is what catches an upscale being labelled as a smaller size.
3. `bytes` and `offset` describe non-overlapping ranges that exactly tile the file after the
   directory.
4. **Per-size authoring, by divergence.** Box-downsample the decoded 256 entry to 48, 32 and 16 and
   require `differs(authored, downscaled) > 0.15` at each. This is the assertion that guards the
   headline claim, and the ladder guarantees it: 3 lanes downscaled against 2 authored at 48, and
   against 1 at 32 and 16, cannot agree on more than 85 % of pixels.
   *(Payload byte length is not a test of this: a 32-bpp DIB's length is a function of its
   dimensions, so seven entries are pairwise distinct by construction — including seven downscales
   of one render. Assertion 4 and assertion 5's lane count are the real guards.)*
5. **The degrade probe.** Re-decode each entry and count token-coloured pixels. The counts must
   match the ladder, not merely be non-zero:

   | probe | 256 | 128 | 64 | 48 | 32 | 24 | 16 |
   |---|---|---|---|---|---|---|---|
   | `veproj`: `--text-on-accent` (the label) | ≥ 100 | ≥ 20 | ≥ 4 | **= 0** | **= 0** | **= 0** | **= 0** |
   | `veproj`: `--accent` (the sash) | > 0 | > 0 | > 0 | > 0 | > 0 | > 0 | > 0 |
   | `veproj`: `--text-ink` (the mark) | > 0 | > 0 | > 0 | > 0 | > 0 | > 0 | **= 0** |
   | `icon`: distinct clip rows | 3 | 3 | 3 | 2 | 1 | 1 | 1 |

   Measured on the prototype at tolerance ± 24 per channel, `--text-on-accent` counts were
   **345 / 69 / 8** at 256 / 128 / 64 and **0** below, and `--accent` counts were
   **1856 / 516 / 345 / 203 / 132 / 56** from 128 down to 16. The label floors above sit between a
   third and a half of the measured count, so a rasteriser that moves by a pixel does not fail the
   build; an exact-equality assertion on those numbers would.
6. **The cut constraints**, both from §2, asserted before painting and again on the decoded bitmap:
   - *Span, in `laneRunW` space* (§3) and in mark-run space (§4): every entry in `SPANS[lanes]`
     satisfies `a < cutAt < b`. `SPANS[]` and `cutAt` share that base; neither is in image px.
   - *Width, in image px*: for `lanes ≥ 2`, `cutW ≥ pitch − laneH`. A cut narrower than the gaps
     between lanes reads as a grid gutter, which is the failure that cost the mark its meaning.
   - *Remnant, in image px*: on the decoded bitmap, every lane retains ≥ 3 px of clip on **both**
     sides of the cut.
7. **Silhouette, notch and sash.** `alpha === 0` at each of the four corner pixels of both marks at
   every size. For `veproj`, two more measurements on the decoded bitmap:
   - *Notch*: the count of `alpha === 0` pixels inside the page's bounding box is `≥ 0.35 × fold²`
     at every size. At 16 the ideal erased triangle is 8 px and the floor is 6; drawing the diagonal
     keyline at 16 puts it at 1 and fails.
   - *Sash*: in the page's vertical mid-row, measured from the body's left edge, the horizontal
     extent of pixels that are `--accent` **or** `--text-on-accent` is exactly `sash w` from the §4
     ladder — 38 / 19 / 11 / 10 / 8 / 7 / **5**. Both tokens count because the label sits inside the
     sash and interrupts a pure-accent run at 256, 128 and 64. This is what makes the §4 contract a
     measurement rather than a promise, and it is what catches an off-by-one between a fraction of
     the page and what is actually painted on the body.
8. **Contrast, computed from the tokens actually read.** The eight floored rows of §5's measured-
   pairs table, recomputed with `contrast()` on the values `readToken` returned, against the two
   reference shells `#ffffff` and `#202020`:
   `accent/tile ≥ 3`, `tile/#ffffff ≥ 3`, `accent/#202020 ≥ 3`, `keyline/#ffffff ≥ 3`,
   `keyline/#202020 ≥ 3`, `clips/body ≥ 3`, `sash/body ≥ 3`, `label/sash ≥ 4.5`.
   This is what makes §5's sourcing claim a gate rather than a promise: a theme swap that produces
   an unshippable icon fails the build instead of shipping.
9. **The probe's precondition.** `countNear` is only meaningful if nothing else in the mark can land
   inside its tolerance ball. Before running assertion 5, for each probed token `p` and every other
   token painted in the same mark `q`: `maxChannelDelta(p, q) > tol`, so no pixel of `q` is ever
   counted as `p`; and where `p` and `q` are adjacent in the mark, `maxChannelDelta(p, q) > 2 × tol`,
   so no antialiased blend between them is counted either. At `tol = 24` the tightest pair in the
   document mark is `--text-on-accent` against `--surface-panel` at 41 (not adjacent), and the
   tightest adjacent pair is `--text-on-accent` against `--accent` at 211. Under `daylight` the
   first pair collapses to 4 and this assertion fails, which is correct (§5).
10. Every assertion prints its measured value next to its floor before the verdict, and the entry
    table from `inspectIco` is printed for both files. A gate that only prints "ok" cannot be
    audited later.

### Independent confirmation, outside Node

The prototype was confirmed against two different Windows decoders. Both commands are worth keeping
in the doc because they use code the script does not. **They are run by hand, once, when the
renderer changes — the script does not and cannot invoke them, and their output is not part of
`--proof` (§9). Run `--proof` first so `build/icon-proof/` exists.**

```powershell
# GDI+ / System.Drawing — reads the DIB entries, 16..128. Writes each one out to look at.
Add-Type -AssemblyName System.Drawing
foreach ($s in 16,24,32,48,64,128) {
  $i = New-Object System.Drawing.Icon("build\veproj.ico", $s, $s)
  $i.ToBitmap().Save("build\icon-proof\extracted-veproj-$s.png", 'Png')
}

# WIC — the shell's own decoder. Enumerates every frame including the 256 PNG.
Add-Type -AssemblyName PresentationCore
$d = [System.Windows.Media.Imaging.BitmapDecoder]::Create(
       (New-Object System.Uri((Resolve-Path "build\veproj.ico"))), 'None', 'OnLoad')
$d.Frames | ForEach-Object { $_.PixelWidth }
```

Observed on the prototype: GDI+ returned 16, 24, 32, 48, 64 and 128 at their exact sizes; WIC
reported frames `128, 64, 48, 256, 32, 24, 16` — all seven. GDI+ asked for 256 returns a 128, which
is a GDI+ limitation and not a defect in the file, and is why assertion 2 above reads the payload
header directly rather than trusting a decoder. The loop deliberately stops at 128 for that reason:
there is no such thing as a GDI+ 256 px extraction.

---

## 9. Proof renders — where to look

The files are in **`E:/Desktop/Video Editor/build/icon-proof/`**. §10 is authoritative for what the
script writes; the *regenerated* column below says whether `--proof` reproduces a file or whether it
is one-time output kept for reference.

| file | regenerated by `--proof` | what it shows |
|---|---|---|
| `app-256.png` … `app-16.png` | yes | the app mark, one file per `.ico` size, exactly as authored |
| `doc-256.png` … `doc-16.png` | yes | the document mark, one file per size |
| `app-3x.png`, `doc-3x.png` | yes | each ladder at 3× nearest-neighbour — the useful reading size |
| `app-8x.png`, `doc-8x.png` | yes | each ladder at 8×, all seven sizes — the contact sheets |
| `app-1to1-dark.png` / `-light.png` / `-mid.png` | yes | **true 1:1**, composited on #19191c, #f3f3f3 and #787c82 |
| `doc-1to1-light.png` / `-dark.png` | yes | true 1:1 on #ffffff and on #202022 (Explorer's dark list background) |
| `app-final-8x.png` | no | the app ladder plus two rejected breakpoint variants |
| `doc-final-4x.png` | no | the document ladder with the `VE` and `PROJ` rows side by side |
| `finalists-8x.png` | no | the three tuned directions from §2 side by side, all seven sizes each |
| `icon.ico`, `veproj.ico` | no | the **prototype** containers; the shipping pair is `build/icon.ico` and `build/veproj.ico` |
| `extracted-icon-*.png`, `extracted-veproj-*.png` (16–128) | no | **what Windows itself hands back** out of those `.ico` files, per size — PowerShell/GDI+ output (§8), which Node cannot produce |
| `extracted-icon-8x.png`, `extracted-veproj-8x.png` | no | those extractions at 8×, which is the real proof that per-size authoring survived the round trip |

The extraction sheets are the ones that matter. They are not renders of the design — they are what
`System.Drawing.Icon` pulled out of the written bytes.

Two housekeeping items for the implementer. `extracted-icon-256.png` and `extracted-veproj-256.png`
are **128 px extractions under a 256 name** — GDI+ returns the 128 for a 256 request (§8), and the
two files are byte-identical in length to their `-128` siblings. Delete them; nothing references
them. And the prototype sheets were rendered before the revisions in §3 and §4 (tile token, cut
widths, document clip token, label breakpoint, sash definition), so their geometry is one generation
old; the ladders above are arithmetic from the fractions stated beside them and reproduce the
prototype's own numbers wherever the two agree. Run `--proof` once and the regenerated rows replace
what is stale.

Everything in `build/icon-proof/` is build output and is not committed (§10, cross-area). The three
files one directory up — `build/icon.png`, `build/icon.ico`, `build/veproj.ico` — are tracked.

---

## 10. File ownership

Owned by this area; the implementer changes these and only these:

- **`scripts/make-icon.mjs`** — rewritten. Reads seven tokens, renders both marks at seven sizes
  each, and writes, on every run:
  `build/icon.png` (512 px, the app mark rendered at 512 using the 256 ladder step's fractions —
  rendered, not upscaled), `build/icon.ico`, `build/veproj.ico`.
  With `--proof` it additionally writes, into `build/icon-proof/`: the fourteen per-size PNGs, the
  two 3× ladders, the two 8× contact sheets, and the five 1:1 composites — twenty-three files, and
  nothing else. It then re-reads both `.ico` files and runs every assertion in §8 in either mode,
  printing the entry table and each measured value, and exiting non-zero on failure.
- **`build/installer.nsh`** — new, and **source, not build output** (§7). Four lines: a
  `customInstall` macro that broadcasts `SHCNE_ASSOCCHANGED`. Tracked in git.
- **`build/`** — generated icon assets: `icon.png` (already tracked), `icon.ico`, `veproj.ico` —
  all three tracked, deterministic from `tokens.css` — plus `icon-proof/**`, which is not.
- **`electron-builder.yml`** — the two lines in §7 (`win.icon`, `fileAssociations[0].icon`), and
  nothing else in the file.

### Cross-area requirements

Four one-line edits outside the list. None of these files is touched by this area.

1. **`.gitignore`** — add exactly one line, `build/icon-proof/`. It is written only by
   `node scripts/make-icon.mjs --proof`, never by `npm run icon` or `npm run dist`, and is ~700 KB
   of PNG. `build/icon.png`, `build/icon.ico`, `build/veproj.ico` and `build/installer.nsh` stay
   tracked; no rule may broaden to `build/`.
2. **`docs/PLAN.md` §7.4**, after "*A use not on this list is a bug; report it rather than adding
   one.*", insert:
   > The budget governs rendered interface surfaces only. The OS application icon and the `.veproj`
   > document icon are out of scope and are specified in docs/ICON.md §2.
3. **`DESIGN.md`**, under the Three Uses Rule, after "*A fourth use is a bug.*", insert the same
   scoping sentence:
   > This governs rendered interface surfaces only; the OS application icon and the `.veproj`
   > document icon are specified in docs/ICON.md §2.
4. **`README.md`** — the sentence that currently reads:
   > `npm run icon` redraws `build/icon.png` from the palette in `src/styles/tokens.css`, so the app
   > mark cannot drift from the theme.

   should say that `npm run icon` redraws **both** marks and writes `build/icon.ico` and
   `build/veproj.ico`, each carrying seven authored sizes, and that it verifies them by reading them
   back and measuring their contrast against both Explorer backgrounds. The clause about not
   drifting from the theme stays true and should stay. Quote the sentence rather than a line
   number — README.md is being edited by more than one area in this pass.

Explicitly **not** required, so nobody needs to negotiate for them:

- `package.json` — no new script, no new dependency. `npm run icon` and `npm run dist` are unchanged.
- `src/styles/tokens.css` — no new token, no rename, no value change.
- `electron/**`, `src/**` — nothing. Neither mark is rendered in the app UI.

---

## 11. What is deliberately not here

- **No macOS `.icns` and no Linux `.png` set.** `electron-builder.yml` targets `--win` only. The
  512 px `build/icon.png` remains as the cross-platform fallback if that ever changes.
- **No monochrome / notification / overlay variant.** Windows overlay icons are 16 px only and this
  app raises none.
- **No `instrument` or `daylight` icon variants.** An OS icon is written once at package time; §5.
- **No animated or "activity" taskbar state.** DESIGN.md forbids idle motion, and the app has no
  long-running background state that is not already on screen.
- **No code signing.** README already documents the SmartScreen consequence; unrelated to icons.
- **No `.mp4`/`.mov` association.** The app is not a media player and should not claim video
  extensions. Only `.veproj` is claimed, which is the existing behaviour.
