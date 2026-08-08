# Format — named resolutions and project shape

**Status:** normative for the `format` area. Where this document and `docs/PLAN.md` disagree on a
*name, type or channel*, PLAN wins and the disagreement is reported — except at the two points
listed in §7.5, which are PLAN amendments this work requires and which are stated there in full.
Where it and `DESIGN.md` disagree on *visual behaviour*, DESIGN wins except at §5.4, which invokes
PLAN §7.5's already-resolved precedence of `PRODUCT.md`'s 3:1 non-text floor over DESIGN's Audit
Test.

Read order: `PRODUCT.md` → `DESIGN.md` → `docs/PLAN.md` → `docs/EXPORT.md` → this file.

**File ownership for this area is absolute.** The implementer touches only:

```
src/state/playbackSlice.ts
src/components/preview/**
src/components/export/**
src/components/inspector/ProjectProperties.tsx
electron/export/graph.ts
electron/ipc/export.ts
src/lib/constants.ts
docs/FORMAT.md   docs/EXPORT.md

# Narrowly scoped additions — the exact edit is spelled out and nothing else in
# these files is touched. Each is load-bearing: without it the change does not land.
src/styles/tokens.css              ONE added declaration (§10.1). Without it `npm run check` fails.
src/state/mediaSlice.ts            TWO changed lines (§7.4): one guard condition in `applyProbe`
                                   and one argument in `importBrowserFile`. Each is a single line,
                                   each is spelled out before and after, and without either the
                                   adoption contract §7.3 defines is unreachable on one of its two
                                   paths (§11.29, §11.30).
scripts/check-export-graph.mjs     NEW file (§10.6). The gate §11.25 declares non-optional.
package.json                       ONE string: the new script appended to `check` (§10.6).
```

Everything above the comment is this area's outright. The four below it are **narrow exceptions, and
they are part of this change rather than requests to another owner** — the brief for this run states
nothing else is running, so a nominated owner would never apply them and the feature would be
unlandable rather than merely degraded. Each is spelled out as literal text at the section named
beside it; three are pure additions and the fourth changes two lines, plus the comment above each.

Everything else — including `src/types/api.ts`, `src/state/timelineSlice.ts`, `src/lib/project.ts`,
`docs/PLAN.md`, `README.md` and `src/components/inspector/Inspector.tsx` — is somebody else's. §10
lists everything this work needs from outside the list above. Code against those declarations; never
edit those files.

---

## 0. The two decisions, stated once

**Resolutions are named by their short edge, and the pixel pair is always shown beside the name.**
`4K UHD · 3840 × 2160`. The name is what you look for; the pixels are what you verify. One tier
ladder — `2160, 1440, 1080, 720, 480` — generates every resolution in the app, for every shape. A
shape emits the tiers it can carry: a preset emits all five at its canonical ratio, a custom shape
emits the ones it reaches at *exactly* its own ratio and skips the rest (§2.5), and every shape's own
size is always in its own list. No row of any Resolution list is ever a different shape from the
project it belongs to.

**A project has a shape, the shape is chosen in the inspector, and it is derived from
`width`/`height` rather than stored beside them.** `9:16` is not a new field in the project file; it
is what `1080 × 1920` *means*. That is what keeps every existing `.veproj` loading unchanged and
keeps `ProjectFile.version` at `1`.

Everything below follows from those two, plus one rule that already governs every audio decision in
this codebase and now governs this one: **what the user sees and what they ship must match.**

---

## 1. What already works, measured before designing

Three things were checked in the shipping code before any of this was specified, because two of
them turned out to be already correct and designing around a wrong assumption would have been the
expensive mistake.

| Claim | Verdict | Evidence |
|---|---|---|
| The preview well letterboxes to the **project** aspect, not the source aspect | **Already true** | `VideoSurface.tsx` computes `aspect = projectWidth / projectHeight` and sizes `.ve-video-stage` from it; `preview.css` gives `.ve-video-el` `object-fit: contain` inside that stage |
| The export graph letterboxes a mismatched source rather than cropping it | **Already true** | `graph.ts` emits `scale=<tw>:<th>:force_original_aspect_ratio=decrease`, then centres with `overlay=x=(W-w)/2…`; `EXPORT.md §1.5` states "Letterbox and pillarbox are transparent, not black … the base shows through" |
| Preview and export agree on the composited result | **Almost** | **Four** real gaps, listed largest first: §5.5 (the preview renders one clip; the export composites the whole video stack, so a lower track shows through an upper clip's bars in the file and not on screen), §6.2 (position offset drifts when export resolution ≠ project resolution), §5.4 (matte colour), §4.3 (rotation, already an EXPORT §7 omission) |

Two of the four are closed here: §6.2 and §5.4. Two are **recorded, measured and corrected in the
README, not closed**: §5.5 needs a multi-layer preview compositor, which is a different feature with
its own document; §4.3 needs `rotation` to export, which is likewise its own decision. Both were
invisible in a 16:9-in-16:9 project — §5.5 because an upper clip filled the frame and had no bars to
reveal anything through — and this feature is what makes them ordinary. A gap that this work makes
common is this work's to *state*, whether or not it is this work's to fix.

So the substantial half of this work is **not** implementing letterboxing. It is: giving the user a
way to *choose* the shape, making the frame boundary visible now that bars are the normal case,
closing the two disagreements that can be closed inside this area, and putting the two that cannot
where a user will read them.

---

## 2. Named resolutions

### 2.1 The tier rule

> **A resolution tier is named by its SHORT edge. Outside 16:9 the orientation word is mandatory.**

This is not a convention invented here; it is what `1080p` already means — 1080 *lines*, the short
edge of a 1920 × 1080 frame. Extending it is what makes one ladder serve every shape:

- `4K` names tier 2160. In 16:9 that is the 3840-wide frame the whole industry calls 4K.
- `1080p` names tier 1080. In 16:9 that is 1920 × 1080.
- In 9:16, tier 1080 is 1080 × 1920 — and it is called **`1080 vertical`**, never `1080p`, because
  `1080p` is a landscape frame and a user who reads `1080p` on a vertical project has been lied to.
  The orientation word is the whole point of the rule.

### 2.2 The ladder

`RESOLUTION_TIERS = [2160, 1440, 1080, 720, 480]`, descending. Every entry in every list in the app
is generated from it (§2.5) and rounded up to even, because 4:2:0 and 4:2:2 both require even
dimensions and an odd one is an `libx264` hard failure, not a rounding nicety.

**16:9 — landscape**

| Tier | Label | Pixels |
|---|---|---|
| 2160 | 4K UHD | 3840 × 2160 |
| 1440 | 2K QHD | 2560 × 1440 |
| 1080 | 1080p | 1920 × 1080 |
| 720 | 720p | 1280 × 720 |
| 480 | 480p | 854 × 480 |

854 is the conventional even value; exact 16:9 at tier 480 is 853.33. The generator produces 854 by
rounding up to even, so the table and the code cannot disagree.

`2K QHD` carries both names deliberately. Pedantically, "2K" is DCI's ~2048-wide format and
2560 × 1440 is QHD / 1440p; in practice editors say "2K" and monitor boxes say "QHD", and the label
is the only place the two can be reconciled without picking a fight.

**9:16 — vertical (TikTok, Reels, Shorts)**

| Tier | Label | Pixels |
|---|---|---|
| 2160 | 4K vertical | 2160 × 3840 |
| 1440 | 2K vertical | 1440 × 2560 |
| 1080 | 1080 vertical | 1080 × 1920 |
| 720 | 720 vertical | 720 × 1280 |
| 480 | 480 vertical | 480 × 854 |

**1:1 — square**

| Tier | Label | Pixels |
|---|---|---|
| 2160 | 4K square | 2160 × 2160 |
| 1440 | 2K square | 1440 × 1440 |
| 1080 | 1080 square | 1080 × 1080 |
| 720 | 720 square | 720 × 720 |
| 480 | 480 square | 480 × 480 |

**4:5 — portrait (Instagram feed)**

| Tier | Label | Pixels |
|---|---|---|
| 2160 | 4K portrait | 2160 × 2700 |
| 1440 | 2K portrait | 1440 × 1800 |
| 1080 | 1080 portrait | 1080 × 1350 |
| 720 | 720 portrait | 720 × 900 |
| 480 | 480 portrait | 480 × 600 |

A shape with no preset (§3.2) still gets a ladder — the tiers it reaches at *exactly* that aspect,
which is usually two or more of the five and occasionally none (§2.5) — and no tier names, so its
options render as the pixel pair alone. Its own size is always in the list. Nothing is unreachable
for want of a name.

### 2.3 DCI 4K does not earn its place

**Cut.** 4096 × 2160 is not in any list.

1. **It is a delivery spec this app cannot deliver.** DCI 4K means a Digital Cinema Package —
   17:9, JPEG 2000 in MXF, usually 24 fps, with a colour pipeline to match. This app exports H.264,
   H.265 and ProRes into `mp4` and `mov`. A 4096 × 2160 `.mp4` is not a DCP. It is a 4K UHD file
   with 256 extra pixels of width that every consumer player, and every upload target the user
   actually posts to, will scale or pillarbox back off.
2. **It is the only candidate that would break the rule this document exists to enforce.** 17:9 is
   not 16:9. Putting it in a 16:9 project's ladder would make it the one entry that changes the
   shape of the output relative to the preview — precisely the see-one-thing-ship-another failure
   §6.3 closes.
3. **Cutting it removes nothing, and the escape hatch is stable rather than single-use.** A user who
   genuinely needs 4096 × 2160 types it into the Width and Height fields in the inspector. The
   project becomes a custom-shape project at 256:135, the preview letterboxes to it, and its own
   ladder is `4096 × 2160` and `2048 × 1080` — the two tiers that shape reaches *exactly* (§2.5).
   Selecting `2048 × 1080` regenerates that same two-row ladder, so `4096 × 2160` is one selection
   away for the life of the project. The capability survives an ordinary round trip through the
   control, not just its first use; only the misleading menu entry is gone. §11.4 measures this
   against the custom shape and not only against the presets, because a ladder that ratcheted would
   make this point false while every preset assertion still passed.

The same reasoning cuts `2048 × 1080` (DCI 2K).

Both cuts are cuts from the **generator's tables**, not from the app's reachable sizes — which is
what makes point 3 true rather than a consolation. A 4096 × 2160 project's own ladder does contain
`2048 × 1080` at its 1080 tier, unnamed, because that is genuinely that shape's 1080 tier. §11.7 is
therefore phrased against `ASPECT_PRESETS` and `RESOLUTION_TIERS` rather than against every rendered
label: an assertion that no label anywhere contains `4096` would fail the instant point 3's escape
hatch is used, and "fixing" it by suppressing that row would delete the capability point 3 promises
survives.

### 2.4 Label format and typography

```
<name> · <W> × <H>          4K UHD · 3840 × 2160
<W> × <H>                    1778 × 1000        (no named tier)
```

- Separator is `·` (U+00B7) with a space on each side. `×` is U+00D7 with a space on each side,
  matching the existing dialog's `${w} × ${h}` exactly, so no string in the app changes shape.
- **Sentence case throughout** (DESIGN §3, the Sentence Case Rule). `4K`, `2K`, `UHD`, `QHD` are
  names, not styling, in the same category as the `V1` / `A2` track identifiers PLAN §2.4 exempts.
- The Resolution control is a `Select` with **`numeric` set**, so the closed face renders in
  `--font-mono` with tabular figures. That satisfies DESIGN §3's Tabular Rule for the pixel pair,
  which changes while the interface is live.

  The consequence is that the tier name renders in mono too. A native `<select>` cannot mix
  typefaces inside an `<option>`, and PLAN §5 forbids a slice hand-rolling a listbox to get around
  it. Mono is the right side of that trade: at the 12px numeric step `4K UHD` is perfectly legible,
  and tabular figures make every `3840 × 2160` occupy the same width, so the open popup reads as an
  aligned column of numbers rather than ragged text. **Do not add a twelfth UI primitive for this.**

### 2.5 The generator

Tables live in `src/lib/constants.ts`; the pure functions live in `src/state/playbackSlice.ts`,
following the precedent already set there by `KNOWN_FPS` and `snapKnownFps` ("exported so media can
report honestly"). Both files are owned by this area. Nothing here belongs in `src/lib/**` beyond
`constants.ts`, which is the only `lib` file on the ownership list.

```ts
// src/lib/constants.ts

/** Project shape presets. `'custom'` is a DISPLAY value only — never a target (§3.5). */
export type AspectId = '16:9' | '9:16' | '1:1' | '4:5' | 'custom';

export interface AspectPreset {
  id: Exclude<AspectId, 'custom'>;
  /** Sentence case. No product names — see §3.2. */
  label: string;
  /** width / height, exact. */
  ratio: number;
  /** Tier name by SHORT edge. A tier with no entry renders as its pixel pair alone. */
  tierNames: Readonly<Record<number, string>>;
}

/** The ONE ladder. Short edges, descending. Every list in the app is generated from it. */
export const RESOLUTION_TIERS: readonly number[] = [2160, 1440, 1080, 720, 480];

export const ASPECT_PRESETS: readonly AspectPreset[] = [
  {
    id: '16:9',
    label: 'Landscape 16:9',
    ratio: 16 / 9,
    tierNames: { 2160: '4K UHD', 1440: '2K QHD', 1080: '1080p', 720: '720p', 480: '480p' },
  },
  {
    id: '9:16',
    label: 'Vertical 9:16',
    ratio: 9 / 16,
    tierNames: {
      2160: '4K vertical', 1440: '2K vertical', 1080: '1080 vertical',
      720: '720 vertical', 480: '480 vertical',
    },
  },
  {
    id: '1:1',
    label: 'Square 1:1',
    ratio: 1,
    tierNames: {
      2160: '4K square', 1440: '2K square', 1080: '1080 square',
      720: '720 square', 480: '480 square',
    },
  },
  {
    id: '4:5',
    label: 'Portrait 4:5',
    ratio: 4 / 5,
    tierNames: {
      2160: '4K portrait', 1440: '2K portrait', 1080: '1080 portrait',
      720: '720 portrait', 480: '480 portrait',
    },
  },
];

/** Label for the derived 'custom' value. Never an option the user can select INTO. */
export const ASPECT_CUSTOM_LABEL = 'Custom';

/**
 * |a - b| within this counts as the same shape. Chosen against the two nearest real
 * collisions: 16:9 (1.7778) vs 17:9 (1.8889) is 0.111 away, and 854 × 480 (1.77917)
 * differs from exact 16:9 by 0.0014. 0.01 separates them by two orders of magnitude.
 */
export const ASPECT_EPSILON = 0.01;
```

```ts
// src/state/playbackSlice.ts — pure, exported, no store access.
// The existing `import { PLAYHEAD_TAIL_FRAMES } from '../lib/constants'` widens to also
// take ASPECT_PRESETS, ASPECT_EPSILON, RESOLUTION_TIERS and the types AspectId and
// AspectPreset. One import line changes; the tables stay in constants.ts.

export interface ProjectSize {
  width: number;
  height: number;
}

/**
 * The bounds a project dimension is clamped to. Already present in this file as
 * module-private consts; this work only adds `export` to both. Exported because the
 * ladder must not generate a size the store would refuse, and because no other file may
 * restate the numbers — `ProjectProperties.tsx`'s field `min`/`max` (16 / 8192) are a
 * separate, narrower input affordance and are left exactly as they ship.
 */
export const SIZE_MIN = 2;
export const SIZE_MAX = 16384;

/** Even and at least 2. 4:2:0 and 4:2:2 both require it; odd is an encoder hard failure. */
export function evenUp(n: number): number {
  const r = Math.max(2, Math.round(n));
  return r % 2 === 0 ? r : r + 1;
}

/** The resolution of `ratio` at short-edge `tier`. Total for every finite input. */
export function sizeForTier(ratio: number, tier: number): ProjectSize {
  if (!(ratio > 0) || !(tier > 0)) return { width: 1920, height: 1080 };
  return ratio >= 1
    ? { width: evenUp(tier * ratio), height: evenUp(tier) }
    : { width: evenUp(tier), height: evenUp(tier / ratio) };
}

/** Which preset this size IS. Never guesses, never throws. */
export function resolveAspectId(width: number, height: number): AspectId {
  if (!(width > 0) || !(height > 0)) return 'custom';
  const ratio = width / height;
  for (const p of ASPECT_PRESETS) {
    if (Math.abs(ratio - p.ratio) <= ASPECT_EPSILON) return p.id;
  }
  return 'custom';
}

/** The short edge — the tier this size sits on. Deliberately NOT snapped; see §3.5. */
export const sizeTier = (width: number, height: number): number => Math.min(width, height);

/** The preset this size IS, as the object. `undefined` means 'custom'. Module-private. */
function presetFor(width: number, height: number): AspectPreset | undefined {
  const id = resolveAspectId(width, height);
  return ASPECT_PRESETS.find((p) => p.id === id);
}

/**
 * '4K UHD · 3840 × 2160', or '1920 × 1084' when there is no name to give.
 *
 * A tier name is attached ONLY when the size IS the canonical size for that tier at that
 * preset's EXACT ratio. Being merely inside `ASPECT_EPSILON` is not enough: 1920 × 1084
 * is inside the 16:9 epsilon and is not 1080p, and calling it 1080p is precisely the
 * see-one-thing-ship-another failure this document exists to prevent. A near-preset size
 * renders as its pixel pair alone, which is the whole truth about it.
 */
export function resolutionLabel(width: number, height: number): string {
  const pixels = `${width} × ${height}`;
  const preset = presetFor(width, height);
  if (!preset) return pixels;
  const tier = sizeTier(width, height);
  const canon = sizeForTier(preset.ratio, tier);
  if (canon.width !== width || canon.height !== height) return pixels;
  const name = preset.tierNames[tier];
  return name ? `${name} · ${pixels}` : pixels;
}

export interface ResolutionOption {
  /** `${width}x${height}` — the Select value, unchanged from the shipping dialog's encoding. */
  value: string;
  label: string;
  width: number;
  height: number;
}

/**
 * The Select `value` for a project size. ALWAYS even, therefore always present in
 * `resolutionLadder(width, height)`, whose passthrough row is evened for the same reason.
 *
 * This is the ONE normaliser. The inspector's Resolution row, the export dialog's
 * Resolution row and the ladder's own passthrough row all derive their string here, so no
 * `<select>` in the app can ever hold a value absent from its options — a native select
 * with an unmatched value silently displays its FIRST option, which would make the control
 * report a size the settings do not hold (§6.3).
 */
export const projectResolutionValue = (width: number, height: number): string =>
  `${evenUp(width)}x${evenUp(height)}`;

/**
 * `tier` expressed at the EXACT shape of `width × height`, or null when that shape
 * cannot reach that tier without changing shape. Custom shapes only.
 *
 * The test is integer, not float: `long * tier` is at most 16384 × 2160 ≈ 3.5e7, exact
 * in a double, and `%` on exact integers is exact. A quotient that is not a whole
 * number misses by at least `1 / short` ≥ 1/16384, four orders of magnitude above
 * double error at this magnitude, so `Number.isInteger` would agree — the modulo is
 * used because it says what is meant rather than because it is safer.
 */
function exactTierSize(width: number, height: number, tier: number): ProjectSize | null {
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  if (!(short > 0) || tier % 2 !== 0) return null;
  const scaled = long * tier;
  if (scaled % short !== 0) return null;
  const other = scaled / short;
  if (other % 2 !== 0) return null; // an odd axis is an libx264 hard failure (§2.2)
  return width >= height ? { width: other, height: tier } : { width: tier, height: other };
}

/**
 * The resolution ladder for a shape. EVERY entry carries the aspect of the size passed
 * in, so nothing in this list can change the shape of the output (§6.3). Descending by
 * short edge, including the passthrough row (§11.6).
 *
 * **A preset shape** is generated from the MATCHED PRESET'S EXACT RATIO, never from the
 * live `width / height`. That is the difference between a stable ladder and one that
 * ratchets: `sizeForTier` rounds up to even, so 854 × 480 is a ratio of 1.779167 rather
 * than 1.777778, and generating from the live ratio would make tier 2160 emit
 * 3844 × 2160 — still inside `ASPECT_EPSILON`, therefore still labelled `4K UHD`, with
 * real 3840 × 2160 no longer reachable from that project at all. One ordinary selection
 * would destroy the named ladder, and §6.3 feeds this same list to the export dialog.
 *
 * **A custom shape** has no canonical ratio to resolve to, so it emits only the tiers it
 * reaches EXACTLY — `exactTierSize` above — and skips the rest. Rounding a custom tier
 * to even is what made the same ratchet unreachable-by-construction for presets and wide
 * open for custom shapes: a 4096 × 2160 project asked for tier 1440 gets 2730.67 rounded
 * to 2732, whose ratio is 1.897222 rather than 1.896296, so selecting that row moves the
 * ladder to 4098 × 2160 and 2050 × 1080 and **4096 × 2160 is gone from that project for
 * good**. §2.3 point 3 sends every user who needs a non-preset size down exactly that
 * path, so the ratchet had to close there too and not only for presets.
 *
 * Emitting only exact tiers closes it completely, and the proof is one line: every
 * emitted row is `(t · long/short, t)`, whose own ratio is `long/short` — the ratio it
 * was generated from, exactly — and whose own short edge is `t`. Regenerating from any
 * row therefore runs the identical exactness test against the identical ratio and yields
 * the identical set. The ladder is a fixed point (§11.4). It is also the only rule under
 * which §6.3's "every entry carries the project's aspect" is literally true of a custom
 * shape rather than true to within 0.1%.
 *
 * The price is stated rather than hidden: a shape whose ratio reaches no tier exactly —
 * 1920 × 1000, say — gets a one-row ladder, its own size. That is honest. Every row it
 * would otherwise have offered was a *different* shape by up to two pixels, and this
 * document's whole premise is that a menu row which changes the shape of the output is
 * the failure, not the feature. Such a project changes size through Width and Height,
 * which is where a custom shape's information lives anyway (§3.4), and §2.2's precedent
 * for a one-row ladder already exists at `resolutionLadder(16, 8192)`.
 *
 * Tiers exceeding SIZE_MAX on either axis are skipped for a separate reason: the store
 * would clamp them, and offering `2160 × 1105920` in a menu whose premise is that every
 * row is shippable would hand ffmpeg a 2.4-gigapixel frame. The passthrough row is never
 * skipped, so the project's own size is always reachable.
 */
export function resolutionLadder(width: number, height: number): ResolutionOption[] {
  const option = (w: number, h: number): ResolutionOption => ({
    value: `${w}x${h}`,
    label: resolutionLabel(w, h),
    width: w,
    height: h,
  });
  if (!(width > 0) || !(height > 0)) return [option(1920, 1080)];

  const preset = presetFor(width, height);
  const rows: ResolutionOption[] = [];
  const seen = new Set<string>();
  for (const tier of RESOLUTION_TIERS) {
    const size = preset ? sizeForTier(preset.ratio, tier) : exactTierSize(width, height, tier);
    if (size === null) continue;
    if (size.width > SIZE_MAX || size.height > SIZE_MAX) continue;
    const value = `${size.width}x${size.height}`;
    if (seen.has(value)) continue;
    seen.add(value);
    rows.push(option(size.width, size.height));
  }

  // The passthrough row, EVENED — and the membership test uses the evened string too. A
  // saved 1920 × 1081 project must not lead its own export ladder with an odd height that
  // dies in libx264 minutes into a render (§8). The store keeps 1081; the ladder offers
  // 1082; `projectResolutionValue` selects it; the Height field still reads 1081 until the
  // user touches a control.
  const own = projectResolutionValue(width, height);
  if (seen.has(own)) return rows;

  // Inserted in DESCENDING short-edge order, not prepended. The rest of the list is
  // strictly descending and the passthrough row is usually the SMALLEST size in it — a
  // 1000 × 1000 project led its own ladder with 1000 × 1000 sitting above 2160 × 2160,
  // so the row the select opens on read as the largest option while being the smallest.
  // A list that is descending except at the one row the user is looking at teaches the
  // wrong thing about every other row.
  const row = option(evenUp(width), evenUp(height));
  const shortEdge = sizeTier(row.width, row.height);
  const at = rows.findIndex((o) => sizeTier(o.width, o.height) < shortEdge);
  if (at < 0) rows.push(row);
  else rows.splice(at, 0, row);
  return rows;
}

/**
 * Where the aspect control moves the project. The TIER is preserved: the short edge is
 * the pixel budget the user already chose, and swapping shape must never silently
 * change it. 'custom' is not a target and returns the size unchanged (§3.5).
 */
export function sizeForAspect(width: number, height: number, next: AspectId): ProjectSize {
  const preset = ASPECT_PRESETS.find((p) => p.id === next);
  if (!preset) return { width, height };
  return sizeForTier(preset.ratio, sizeTier(width, height));
}
```

Worked, so the tables above are checkable rather than asserted:

| Call | Result |
|---|---|
| `sizeForTier(16/9, 480)` | `854 × 480` (853.33 → round 853 → up to even 854) |
| `sizeForTier(9/16, 1080)` | `1080 × 1920` |
| `sizeForTier(4/5, 720)` | `720 × 900` |
| `sizeForAspect(1920, 1080, '9:16')` | `1080 × 1920` |
| `sizeForAspect(3840, 2160, '1:1')` | `2160 × 2160` |
| `sizeForAspect(1000, 1000, '16:9')` | `1778 × 1000` — LANDSCAPE, and the 1000-px budget is kept rather than snapped. `sizeForTier` puts the tier on the SHORT edge, so a ratio ≥ 1 makes it the height. |
| `resolveAspectId(4096, 2160)` | `'custom'` — 4096/2160 is 256:135 = 1.8963, which is 0.119 outside 16:9 and further still from every other preset |
| `resolveAspectId(854, 480)` | `'16:9'` (0.0014 inside) |
| `resolutionLabel(1920, 1084)` | `'1920 × 1084'` — inside the 16:9 epsilon, but `sizeForTier(16/9, 1084)` is `1928 × 1084`, so no name is borrowed |
| `resolutionLadder(854, 480).map(o => o.value)` | `['3840x2160','2560x1440','1920x1080','1280x720','854x480']` — regenerated from 16/9, **not** from 854/480 = 1.779167, which would have produced `3844x2160` labelled `4K UHD` |
| `resolutionLadder(1920, 1081)[2]` | `1920 × 1082`, unnamed, **between** `2560 × 1440` and `1920 × 1080` — its short edge is 1082, so that is where a descending list puts it. The store still holds 1081. |
| `resolutionLadder(1000, 1000).map(o => o.label)` | `['4K square · 2160 × 2160', '2K square · 1440 × 1440', '1080 square · 1080 × 1080', '1000 × 1000', '720 square · 720 × 720', '480 square · 480 × 480']` — the passthrough row in its size order, not at the head |
| `resolutionLadder(16, 8192)` | `[{ label: '16 × 8192' }]` — every tier exceeds `SIZE_MAX` (tier 480 alone wants 245760 px of height) and is skipped; the project's own size survives |
| `resolutionLadder(4096, 2160).map(o => o.value)` | `['4096x2160','2048x1080']` — the two tiers 256:135 reaches exactly. §2.3's escape hatch, intact |
| `resolutionLadder(2048, 1080).map(o => o.value)` | `['4096x2160','2048x1080']` — **the same list**. The escape hatch survives a round trip through the control, which is what §2.3 point 3 promises |
| `resolutionLadder(2560, 1080)` | `['5120x2160','2560x1080']` — the Custom 21:9 §3.2 sends users to, likewise a fixed point |
| `resolutionLadder(1920, 1000)` | `['1920x1000']` — 1.92 reaches no tier exactly, so the ladder is the project's own size alone. Stated in §2.5 as the price of the exactness rule |
| `projectResolutionValue(1920, 1081)` | `'1920x1082'` — present in that project's ladder by construction |

**Where idempotence bites and where it does not.** The fixed-point guarantee is over a ladder's
**tier rows**: selecting any tier row regenerates the identical ladder, for presets and for custom
shapes alike. The **passthrough row** is excluded from the claim by construction — it is the
project's own size, so leaving it means the project is no longer that size. For an even project size
the passthrough row is absent (the shape's own tier already emits it) or is a size the ladder never
claimed to preserve; for an odd one — reachable only by opening a legacy `.veproj` (§8) — selecting
it is the normalisation 1081 → 1082, after which the ladder is a fixed point again.

---

## 3. Project format

### 3.1 Where it lives

**In the inspector, in the existing `project` group, in `ProjectProperties.tsx`.** Not a start-up
dialog, not a modal, not a first-run wizard.

`PRODUCT.md` names **modal-first flows** as a hard anti-reference — "a dialog asking for project
settings, resolution, or frame rate before the first frame is on screen. Sensible defaults, inferred
from the first clip imported, corrected inline later." That surface already exists, is already
reached with nothing selected, is already how frame rate is corrected, and already carries the exact
two numbers this feature is about. Adding shape to it is the "corrected inline later" half of that
sentence being honoured, not extended.

It also satisfies **depth on demand**: the control is invisible during ordinary editing, because
ordinary editing means a clip is selected and the inspector is showing that clip. It appears exactly
when the user has deselected everything, which is the gesture that already means "talk to me about
the project".

`uiSlice.inspectorPinned` already exists for precisely this — PLAN §3.1 documents it as "keeps the
inspector mounted with an empty selection so project format can be corrected". Nothing new is needed
to reach the control; it was designed for.

### 3.2 The preset set

**Five values ship: `16:9`, `9:16`, `1:1`, `4:5`, and the derived `custom`.**

| Preset | Why it ships |
|---|---|
| Landscape 16:9 | The default and the shape of essentially all camera footage. Non-negotiable. |
| Vertical 9:16 | The requirement. TikTok, Reels and Shorts are one shape and it is this one. Without it a vertical edit is impossible. |
| Square 1:1 | Still the safest single shape for a feed that crops unpredictably, and the cheapest possible entry — tier 1080 is literally `1080 × 1080`. |
| Portrait 4:5 | The Instagram feed maximum. It is the one shape a user cannot derive by transposing another, and getting it wrong means the platform crops the edit rather than the editor doing it. |

**21:9 is cut.** It is a *look*, not a project shape. Every real 21:9 delivery is a 16:9 or DCI
master with the bars baked in or an anamorphic flag; a genuine 2560 × 1080 file gets letterboxed
again by every player it meets, so the user ends up with bars on bars. Making it a preset would ship
a whole named ladder for an output that is worse than the one the user can already produce by
scaling a clip inside a 16:9 project. Reachable as Custom `2560 × 1080` if wanted.

**4:3 is cut.** It is a *source* shape, not a delivery shape. The entire point of §4 is that a 4:3
source lands in a 16:9 project pillarboxed and correct without anyone choosing anything — a 4:3
*project* is only useful for deliberate nostalgia. Reachable as Custom `1440 × 1080`.

Both are recorded here rather than silently omitted, with their exact numbers, so "how do I get
4:3" has an answer that is one paragraph away.

**No product names appear in the control.** The options say `Vertical 9:16`, not
`Vertical 9:16 (TikTok, Reels, Shorts)`. `PRODUCT.md` §Brand Personality: "no personality in
microcopy — the user is not a customer being onboarded, they are an operator who already knows the
domain." Anyone editing for TikTok knows what 9:16 is, third-party brand names date within a
release cycle, and a select box is not a place to advertise. The mapping lives in this document and
in the README.

### 3.3 Aspect is derived, never stored

`PlaybackState` gains **no aspect field**. `resolveAspectId(width, height)` computes it on demand.

This is the decision that makes backward compatibility free rather than a migration:

- `ProjectFile` already carries `width` and `height`. It gains nothing. `version` stays `1`.
- `serializeProject` in `src/lib/project.ts` — a file this area does **not** own — needs no edit,
  because there is no new field for it to serialise.
- Every existing `.veproj` loads unchanged and immediately reports the correct aspect: a saved
  `1920 × 1080` project reads as `16:9` the moment it is opened, with no migration step and no
  default-value guessing.
- Two fields cannot drift out of sync, because there is only one.

It follows the `Clip.streams?:` precedent from `AUDIO-FEATURES.md §1.1` exactly: the feature is
expressed in terms the file format already contains, so a file written before the feature is a valid
file rather than a migration.

### 3.4 The control

`ProjectProperties.tsx` renders five `PropertyRow`s, in this order:

| # | Row | Control | Writes |
|---|---|---|---|
| 1 | Aspect | `Select` (5 options, `custom` present only when current) | `const n = sizeForAspect(w, h, next); readStore().setProjectSize(n.width, n.height);` |
| 2 | Resolution | `Select`, `numeric`, `value={projectResolutionValue(w, h)}`, options `resolutionLadder(w, h)` | `const [nw, nh] = next.split('x').map(Number); readStore().setProjectSize(nw, nh);` |
| 3 | Width | `NumericField` (existing) | `setProjectSize(next, height)` |
| 4 | Height | `NumericField` (existing) | `setProjectSize(width, next)` |
| 5 | Frame rate | `NumericField` (existing, unchanged) | `setProjectFps(next)` |

`setProjectSize` is declared `(width: number, height: number): void` — two positional numbers, not
an object. Both new rows are spelled out in two steps above because that is the line an implementer
copies, and `setProjectSize(sizeForAspect(…))` does not compile.

The Resolution row's `value` comes from `projectResolutionValue`, never from a raw
`` `${width}x${height}` ``. A project saved with an odd dimension would otherwise produce a value
absent from its own options, and a native `<select>` with an unmatched value displays its first
option — the control would claim a resolution the project does not have. §2.5 makes the ladder's
passthrough row even and this helper agree on the same string.

**Frame rate moves from first to last.** The four size controls now have a relationship — aspect
picks a shape, resolution picks a tier within it, width and height are the truth underneath both —
and that relationship is unreadable if a frame-rate field is wedged above it. Frame rate is an
independent axis and belongs at the end of the group. This is the only change to a shipped row.

**Width and Height stay visible and stay editable.** They are not hidden behind the Selects and
they are never disabled. The user's brief is explicit that "the number is what actually matters",
PLAN's S4 resolution forbids opacity-based disabling and requires a `disabledReason` for any
disabled control, and the honest arrangement is: the Selects are the fast path, the fields are the
truth, and typing into a field is always allowed. Typing `4096` then `2160` moves Aspect to
`Custom` and regenerates the Resolution ladder at 17:9 — no error, no refusal, no modal.

**`Custom` is a display value, never a target.** It appears in the Aspect options only while
`resolveAspectId(width, height) === 'custom'`, which means it is always the currently selected
option when present, which means a native `<select>` can never fire `onChange` for it. There is no
dead option in the list. The way to reach a custom shape is Width and Height, which is where a
custom shape's actual information lives.

**Commit semantics.** Both `Select`s write on the native `change` event, which is already a commit
— there is no scrub to guard against. The two `NumericField`s keep the existing `onChange={noop}` /
`onCommit={…}` split for the same reason the file's header already gives: a project dimension is not
something to drag through.

**Seven states are free.** Both new controls are the shared `Select` primitive, which ships default,
hover, focus-visible, active, disabled, loading and error already, plus its `disabledReason`
invariant and its `AlertCircle` error slot. This area implements no state styling and defines no new
control — PLAN §5 closes that door and §2.4 above declines to open it.

### 3.5 Picking an aspect preserves the tier

Selecting `Vertical 9:16` on a `1920 × 1080` project gives `1080 × 1920`, not `720 × 1280` and not
`2160 × 3840`. `sizeTier` reads the short edge — 1080 — and `sizeForTier` rebuilds it at the new
ratio.

The short edge is **not snapped to a ladder tier first.** A user sitting on a custom `1000 × 1000`
who picks `Landscape 16:9` gets `1778 × 1000` — landscape, short edge 1000 — and the Resolution
select then shows that size as its own row, in size order between `1080p · 1920 × 1080` and
`720p · 1280 × 720` (§2.5). Snapping would silently change a number the user typed on purpose, and
this area does not do that to anyone.

### 3.6 Changing the format mid-edit

> **It mutates nothing. No clip is re-fitted, moved, rescaled or touched. It is a `width`/`height`
> write and nothing else.**

Three reasons, in descending order of force:

1. **Nothing needs re-fitting.** A clip with default properties — `scale: 1`, `positionX: 0`,
   `positionY: 0` — is already correct in *every* project shape, because both engines fit by
   containment at render time (§4.1). Change a project from 16:9 to 9:16 and a default clip
   re-letterboxes itself on the next frame, in the preview and in the export, with no stored value
   changing. The common case is already handled by the fit rule.

2. **There is no correct transform for the uncommon case.** A clip the user reframed to
   `positionX: 200` was reframed *for the old shape*. 200px is 10.4% of a 1920-wide frame and 18.5%
   of a 1080-wide one. Rescaling it preserves the percentage and destroys the pixel value the user
   typed; not rescaling it preserves the pixel value and changes the composition. Neither is "what
   they meant", and silently rewriting a hand-placed number is the worse of the two failures. So:
   the stored properties are left exactly as the user set them, and the frame around them changes.
   The user re-checks their reframed clips, which they were going to do anyway, because they
   changed the shape of the film.

3. **It is not in the undo document, structurally.** `TimelineDoc` — the unit `undo`/`redo` push and
   pop — is `{ tracks, trackOrder, clips, clipsByTrack, markers }`. It does not contain `fps`,
   `width` or `height`, and `timelineSlice.ts` is not on this area's ownership list. Putting project
   format into the history stack would mean redefining another area's snapshot type. Since format
   change mutates nothing, there is nothing for history to hold.

**Consequently `Ctrl+Z` does not revert a format change.** That is stated plainly rather than
hidden, and it is acceptable because the operation is *idempotent and visible*: the control shows
the current value, changing it back is one selection, and no other state moved while it was wrong.
This is the same standing the existing `setProjectFps` has, and a strictly better one — `setProjectFps`
can shorten clips (`clampClipsToSource`) and *still* is not undoable.

**No notice fires — for a *size* change, and only for a size change.** `setProjectFps` raises a
`Notice` only because it silently shortened clips. Nothing is silent about a shape change: the
preview well changes shape in the same frame, at the size the user just chose. That reasoning is
scoped deliberately, and §7.3 shows where it stops: a *rate* change can shorten a clip on a track
below the fold, which is exactly silent — which is why `setProjectFps` keeps its notice, and why
`adoptSourceFormat` is forbidden from adopting a rate onto a non-empty timeline at all rather than
being allowed to do it and then report it.
`markDirty()` fires **when a dimension actually moved** — which `setProjectSize` already does — and
not when it did not (§7.3's equal-value branch). The autosave subscription in
`src/keyboard/projectActions.ts` already watches `s.width` and `s.height`, so a shape change is
captured by the crash net with no edit to a file this area does not own, and re-confirming the shape
you already have does not arm the unsaved-changes prompt.

**The change is instant.** The stage re-measures through its existing `ResizeObserver` path; there
is no transition on the stage's width or height and none is added, so there is nothing for
`prefers-reduced-motion` to have an alternative to. `DESIGN.md`'s motion rules are satisfied by
having no motion here, which is also the right answer: a frame changing shape is a statement of
fact, not a state transition.

---

## 4. Clips that do not match the project shape

### 4.1 The default fit is containment, and it is already implemented

> **A clip is scaled to fit entirely inside the project frame, preserving its own aspect ratio, and
> centred. Whatever is left over is a bar. Nothing is ever cropped by default.**

A 16:9 source in a 9:16 project letterboxes: full width, bars top and bottom. A 9:16 source in a
16:9 project pillarboxes: full height, bars left and right. A 4:3 source in a 16:9 project
pillarboxes. This is the rule in both engines today:

- **Preview:** `.ve-video-el { object-fit: contain }` inside a stage sized to the project aspect.
- **Export:** `scale=<tw>:<th>:force_original_aspect_ratio=decrease` then `overlay=x=(W-w)/2:…`.

For **one clip** they are the same operation expressed twice, and §6 verifies they produce the same
pixels. They are *not* the same operation for a stack: the preview renders the topmost video clip at
the playhead and nothing beneath it, while the export chains one `overlay` per video contributor, so
what fills an upper clip's bars differs between the two. §5.5 states that gap in full, measures it,
and says why this feature does not close it.

Containment is the right default because it is the only fit that **loses nothing**. A crop-to-fill
default would silently discard 68% of a 16:9 frame's width the moment the user chose a vertical
project — a destructive default applied to material the user never looked at. Bars are ugly and
obvious; a silent crop is invisible until it is on the internet.

### 4.2 Reframing: `scale` and `positionX` / `positionY`, and nothing else

The user reframes with the three fields that already exist in the inspector's Transform group. No
new property, no new store field, no new gesture, no crop tool.

To **fill** the frame from a source of aspect `a` in a project of aspect `p`, the scale is
`Math.max(a / p, p / a)`. That is the whole rule: arithmetic on two aspect ratios, with no content
analysis, no subject detection, and never either.

**No `fillScale` function is added to `playbackSlice.ts`.** Its only consumer would be §10.3's
"Fill frame" button, which lives in `Inspector.tsx` — a file this area does not own and is not
taking on. An exported helper with zero call sites, in the file that holds the app's most
load-bearing state, is dead API surface; the one line above is not worth a slice export until the
button that calls it has an owner. **The table is the deliverable**, because the table is the part
a user needs:

| Source | Project | Scale to fill | What is lost |
|---|---|---|---|
| 16:9 | 9:16 | **316%** | 68% of the source width |
| 16:9 | 4:5 | **222%** | 55% of the source width |
| 16:9 | 1:1 | **178%** | 44% of the source width |
| 4:3 | 9:16 | **237%** | 58% of the source width |
| 9:16 | 16:9 | **316%** | 68% of the source height |
| 9:16 | 1:1 | **178%** | 44% of the source height |

The inspector's Scale field runs `1`–`1000` %, so 316% is typeable today with no widening. Having
scaled to fill, the user pans with Position X / Position Y — which are drag-scrubbable numeric
fields in project-resolution px, and which §6.2 makes agree with the export for the first time.

All six rows are `Math.max(a / p, p / a)` evaluated by hand: 16:9 into 9:16 is
`(16/9) / (9/16) = 3.1605` → 316%, and `1 − 1/3.1605 = 68.4%` of the width falls outside the frame.

### 4.3 What this deliberately does not do

- **No auto-crop, no smart crop, no content-aware anything, no face or subject tracking, no
  pan-and-scan keyframes.** Not deferred — declined. `scale` and `position` are sufficient, they are
  already in the data model, they already export, and they leave the framing decision with the
  person who shot the footage.
- **No per-clip "fit mode" property.** Adding `fit: 'contain' | 'cover'` to `ClipProperties` would
  put a second, competing scaling authority next to `scale`, require a `ProjectFile` migration, and
  give the user two controls that fight. Filling writes the existing `scale` instead — one
  authority, one number, fully adjustable afterwards.
- **`rotation` still does not export.** `EXPORT.md §7` already states this and it is unchanged here.
  It matters more now, because reframing is a newly common activity and rotation sits in the same
  inspector group as the two fields that *do* work. Reframe with scale and position only. Making
  rotation export is its own decision with its own document; this one does not take it.

---

## 5. The preview well

### 5.1 It already letterboxes to the project, and that must not regress

`VideoSurface.tsx` derives `aspect` from `projectWidth / projectHeight`, sizes `.ve-video-stage` to
it, and maps clip position onto it with `scaleToStage = stageWidth / projectWidth`. Because the
stage is *exactly* the project aspect, `stageHeight / projectHeight === stageWidth / projectWidth`,
so applying the single `scaleToStage` factor to both axes is correct for any shape. No change.

This is the single most important consequence of the whole feature and it costs nothing, because
whoever wrote `VideoSurface` got it right the first time. **The implementer's job here is to not
break it**, and §11 pins it with a measurement.

### 5.2 Geometry under a vertical project

A 9:16 stage in a wide preview region is limited by height, not width — the existing
`if (stageHeight > box.height)` branch already handles that and produces a tall narrow stage centred
in a wide well, with `--space-xxl` (24px) of air on every side. That is correct and the padding
stays: cutting it to "reclaim" width would put the frame's edge against the panel boundary, which
is the one thing `.ve-video-surface`'s generous padding exists to prevent.

At `timelineHeightPct` = 0.65 (`TIMELINE_MAX_PCT`) the preview region is short and a 9:16 stage
becomes genuinely small. That is honest geometry, not a defect — the user drags the timeline
divider back. No minimum size is imposed and no scroll is introduced.

### 5.3 The frame boundary must be visible — a defect vertical exposes

`.ve-video-stage` paints `--surface-well`. So does `.ve-video-surface` around it. In a 16:9 project
with 16:9 footage this never showed, because the picture filled the stage edge to edge and the
picture *was* the boundary.

In a 9:16 project with a 16:9 source, the picture is a horizontal band floating in a uniform dark
field, and **the boundary of the frame the user is about to ship is invisible.** They cannot see
where the top of their video is. Over a gap, or over an empty timeline, the project frame does not
exist on screen at all.

`PRODUCT.md` requires non-text UI — "track boundaries, clip edges, focus rings, control borders" —
to clear 3:1. `--surface-well` against `--surface-well` is 1:1. This is an accessibility failure,
not a taste question.

**Fix, in `preview.css`:**

```css
.ve-video-stage {
  position: relative;
  flex: 0 0 auto;
  overflow: hidden;
  /* No fallback, and there must not be one. `npm run check`'s rule 2 captures only the
     FIRST token in a `var()` expression, so `var(--frame-matte, var(--surface-well))`
     fails `undefined-token` exactly as loudly as the bare form while looking safe — the
     fallback is never examined. §10.1's declaration therefore lands in THIS change; it is
     on the ownership list for that one line. */
  background: var(--frame-matte);
  /* OUTLINE, never border: a border is inset into the content box and would shift
     stageWidth, which scaleToStage and every clip position depend on. An outline is
     drawn outside the box and changes no geometry. Not a shadow — the stage is
     in-flow (DESIGN §4, The No-Shadow-In-Flow Rule). Not the accent — the accent
     budget is closed at six uses (PLAN §7.4) and a frame boundary is structure, not
     state. --border-structural is the token PLAN §7.5 established for exactly this
     3:1 non-text floor. */
  outline: 1px solid var(--border-structural);
  outline-offset: 0;
}
```

Always drawn, including over an empty timeline: the shape you are editing is information whether or
not there is a frame in it. It carries no hue and no state, so there is nothing for deuteranopia to
collapse. There is no animation, so there is nothing for `prefers-reduced-motion` to alternate.

### 5.4 The matte must be the colour the export writes where the export writes a matte

The export's base canvas is `color=c=black` (`EXPORT.md §1.2`), so **where no lower video track has
content, bars in the delivered file are black.** The preview's bars are `--surface-well`, which is
`oklch(0.10 0.008 265)` in `signal`, `oklch(0.10 0 0)` in `instrument` and `oklch(0.13 0 0)` in
`daylight`. **Three different bar colours, none of them the shipped one.**

The scope of that first sentence is exact and §5.5 is the reason it has to be: where a lower video
track *does* have content under an upper clip's bars, the export shows that content and the base
canvas is never seen there. `--frame-matte` is what the export writes into an *unoccupied* bar,
which is every bar in a single-layer edit and the great majority of bars in any edit. Under a stack
the preview under-reports the composite, and no matte colour could fix that — the preview would have
to composite the stack. §5.5.

In a 16:9 project this was invisible because there were no bars. In a 9:16 project with landscape
sources the bars are more than half the frame, and the user is judging their edit against a matte
that is not the matte.

Fix: `--frame-matte`, one theme-invariant declaration equal to what ffmpeg writes. The exact text is
in §10.1 and **it is applied in this change** — `src/styles/tokens.css` is on the §0 ownership list
for that single line and nothing else.

**Why a theme-invariant token does not break the Palette-Only Rule.** `--frame-matte` is not a
plane. It is *content* — it is what the delivered file contains, in the same category as a black
frame of footage, and a theme has no business changing it any more than it has changing the
footage's colours. DESIGN's four-plane ramp and its "the well is the darkest surface in the
application" both describe *chrome*; the matte is inside the frame, which is the one region of the
screen the chrome rules explicitly yield to (`PRODUCT.md` principle 1). In `daylight` this means a
black matte inside a `0.13` well, i.e. the frame is darker than its surround, which is exactly right:
that is the film, not the bench.

**There is no fallback path, because there is no shippable state without the token.**
`scripts/check-contract.mjs` rule 2 walks every `.ts` / `.tsx` / `.css` file under `src/` and fails
on any `var(--token)` whose token is declared neither in `tokens.css` nor in the same file. Its
regex — `/var\(\s*(--[\w-]+)/g` — captures only the **first** token in the expression, so
`var(--frame-matte, var(--surface-well))` fails `undefined-token` just as hard as the bare form: the
fallback is never even examined. Shipping §5.3's CSS without §10.1 fails `npm run check`, i.e. gate
§11.33, i.e. the whole change is unlandable. So the token is declared in this change and the CSS
reads `var(--frame-matte)` flat. Declaring the value locally in `preview.css` instead is not an
option: it would need a colour literal, which rule 1 fails.

### 5.5 The preview shows one layer; the export composites the stack

> **The preview renders the topmost video clip at the playhead and nothing beneath it. The export
> overlays every video contributor in track order. Where an upper clip does not fill the frame, the
> delivered file shows the track underneath and the preview shows the matte.**

`VideoSurface.tsx` selects a single `ClipId` — `selectVideoClipIdAtFrame(s, s.playhead)` — and
renders it through a two-element `<video>` pool. `graph.ts` walks its full video contributor list and
chains one `overlay=` per clip onto the running composite. Concretely: a 9:16 project, a vertical
clip on V1 and a landscape clip on V2 at the same frame. On screen the landscape clip is a band with
black above and below. In the file, V1's picture is above and below.

**This is the fourth gap of §1's table and it is the largest, and it is not closed here.** Three
things follow from that, in order:

1. **It is not new.** Stacking has always composited in the export and never in the preview. What is
   new is that it is now *ordinary*: before this feature, an upper clip in a matched project filled
   the frame and had no bars to reveal anything through, so the divergence had nowhere to appear.
   A feature that turns a latent gap into a common one owes the statement even when it does not owe
   the fix.
2. **Closing it is a different feature.** The preview would have to composite N video layers —
   stacked elements or a canvas, per-layer opacity, per-layer transform, and a redefinition of which
   element the playback clock reads `currentTime` from. That last one is the brief's ONE playhead
   writer / ONE rAF loop invariant, which is verified by measurement and must stay true. It is not a
   change this area can make behind a resolution menu, and pretending otherwise would be the worse
   failure.
3. **So it is recorded where a user reads it, and measured.** §10.5 replaces the README's current
   claim — which says the export shows only the topmost clip, and is simply wrong about the export —
   with the true one. §11.27 exports the two-clip case and asserts the disagreement, so the day
   someone builds the multi-layer preview, the gate that proves it landed already exists.

Until then the honest guidance is in the README: an upper clip that does not fill the frame reveals
the track beneath it in the delivered file. Scale it to fill (§4.2), or keep the frame clear
underneath.

---

## 6. The export graph

### 6.1 What it does with a mismatched source today

Traced by hand through `buildExportGraph`, for a `1920 × 1080` source in a `1080 × 1920` project
exported at `1080 × 1920`, clip at `scale: 1`:

```
tw = max(2, round(1080 * 1))  = 1080
th = max(2, round(1920 * 1))  = 1920
scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2
    -> fits 1920x1080 inside the 1080x1920 box preserving aspect -> 1080x606
overlay=x=(W-w)/2+0:y=(H-h)/2+0
    -> centred on the 1080x1920 black base -> 606px band, 657px of black above and below
```

That is a correct letterbox, and it matches `object-fit: contain` in the preview to within the
`force_divisible_by=2` rounding (607.5 → 606, i.e. 1.5px on a 1920px axis). **The engines already
agree on the default fit.** No change is required for §4.1.

### 6.2 The position offset drifts when export resolution ≠ project resolution — required fix

`ClipProperties.positionX/positionY` are documented in `src/types/model.ts` as "px in
project-resolution space". The preview honours that: it multiplies by
`scaleToStage = stageWidth / projectWidth`. The export **does not**: it passes the raw value into an
overlay expression evaluated on a frame of `req.width × req.height`.

So a clip at `positionX: 100` in a `1080 × 1920` project:

- **preview** — 100 / 1080 = **9.3%** of the frame width
- **export at 1080 × 1920** — 100 / 1080 = 9.3% ✔
- **export at 2160 × 3840** — 100 / 2160 = **4.6%** ✘

This is a pre-existing defect. It is not created by this work, and it is exposed by it: reframing a
mismatched source is the whole point of §4.2, reframing means non-zero positions, and exporting at
a higher tier than the project is an ordinary thing to do. Left alone, this feature would ship a
reframe control whose result moves when you pick a different export size.

**Fix, in `graph.ts`.** The document already carries the project resolution as `doc.width` /
`doc.height`; the request carries the output resolution. Compute the ratio once and apply it where
the offset is stored on the `Contributor`:

```ts
// Placement is in PROJECT-resolution px (model.ts, ClipProperties.positionX), but the
// overlay runs on the OUTPUT grid. When the two differ the offset must be rescaled, or
// a clip the user reframed in the preview lands somewhere else in the file. Both
// ratios are computed rather than one shared factor: §6.3 locks the export aspect to
// the project aspect, but force_divisible_by rounding can still leave them a fraction
// of a percent apart, and two exact ratios are free.
const rx = doc.width > 0 ? req.width / doc.width : 1;
const ry = doc.height > 0 ? req.height / doc.height : 1;
```

Add to `interface Contributor`:

```ts
  /** Overlay offset, converted from PROJECT-resolution px onto the OUTPUT grid. */
  px: number;
  py: number;
```

Populate in the `collected.push({ … })` call:

```ts
  px: props.positionX * rx,
  py: props.positionY * ry,
```

And in the §1.6 overlay emission, replace `offset(p.positionX)` / `offset(p.positionY)`:

```ts
`[${composite}][v${c.input}]overlay=` +
  `x=(W-w)/2${offset(c.px)}:y=(H-h)/2${offset(c.py)}:` +
```

`offset()` already formats a non-integer to three decimals, so a fractional result needs no new
formatter.

**`tw`/`th` need no ratio.** They are already computed from `req.width`/`req.height`, so they are
already in output space, and the containment fit is scale-invariant. Only the additive offset was
wrong.

**This is a no-op on every verified transcript.** `EXPORT.md §1.8`'s three worked examples are all
1920 × 1080 projects exported at 1920 × 1080, where `rx === ry === 1` and `offset(c.px) ===
offset(p.positionX)` byte for byte. The acceptance test that pins the builder does not move.

### 6.3 The export resolution is locked to the project aspect

The shipping dialog's `PRESET_SIZES` is a hardcoded landscape list:
`[3840,2160], [1920,1080], [1280,720], [854,480]`. In a `1080 × 1920` project the Resolution select
therefore offers four landscape options, and picking one ships a landscape file from a vertical
edit — the preview letterboxes to 9:16 and the encoder writes 16:9. That is the exact failure this
document exists to prevent, and it is live today.

**Rule: every entry in the export Resolution list carries the project's aspect.** The export chooses
a *tier*, never a *shape*. Changing the shape is done in the inspector, where the preview follows.

`ExportDialog.tsx`:

```ts
// DELETE PRESET_SIZES entirely.

const projectWidth = useEditorStore((s) => s.width);
const projectHeight = useEditorStore((s) => s.height);

// Keyed on the PROJECT size, never on settings.width/height: the list must not change
// shape when the user picks from it, and the project size is always in the ladder.
const sizeOptions = useMemo(
  () => resolutionLadder(projectWidth, projectHeight),
  [projectWidth, projectHeight],
);
```

`onResolution` is unchanged — the `${w}x${h}` value encoding is preserved exactly, so the parse
already in the file still works. The `numeric` prop on that `Select` is already set and stays set.

**The `<select>`'s value comes from `projectResolutionValue`, and the invariant is enforced rather
than asserted.** Three edits carry it:

```tsx
// The Resolution Select. Even by construction, so it always names a real option.
value={projectResolutionValue(settings.width, settings.height)}
```

```ts
// The `open` effect's reset (existing) writes EVEN dimensions. A project saved with an odd
// height would otherwise be exported odd — electron/ipc/export.ts validates isPositiveInt
// and nothing else, and libx264 dies on it minutes into the render. The store keeps 1081;
// the export request carries 1082; §8's "loading rewrites nothing" is untouched.
width: evenUp(s.width),
height: evenUp(s.height),
```

```ts
// The project size can move WHILE the dialog is open. The reachable path is not the
// inspector — it is inert behind the modal <dialog> — but `adoptSourceFormat`: a probe from
// an import begun before the dialog opened lands inside its lifetime (mediaSlice pools 3, so
// a multi-file import spans seconds), and hydrateMedia's re-probe-on-open does the same. The
// `open` effect runs on [open] only, so without this the select's value has no matching
// option, a native select then displays its FIRST option, and the dialog would read
// "4K vertical · 2160 × 3840" while settings still said 1920 × 1080 — the UI lying and
// Export writing a landscape file from a vertical project. That is the exact failure §6.3
// exists to prevent, so it is closed with an effect and not with a comment.
useEffect(() => {
  if (!open) return;
  const v = projectResolutionValue(settings.width, settings.height);
  if (sizeOptions.some((o) => o.value === v)) return;
  setSettings((prev) => ({
    ...prev,
    width: evenUp(projectWidth),
    height: evenUp(projectHeight),
  }));
}, [open, sizeOptions, settings.width, settings.height, projectWidth, projectHeight]);
```

**The effect converges in one pass, and cannot loop.** `evenUp` is idempotent, so
`projectResolutionValue(evenUp(projectWidth), evenUp(projectHeight))` equals
`projectResolutionValue(projectWidth, projectHeight)` — which `resolutionLadder(projectWidth,
projectHeight)` always contains, either as a tier or as its evened passthrough row (§2.5, measured by
§11.17). The second run therefore takes the guard and returns. That guarantee is the reason the
passthrough row is evened rather than raw: without it a project with an odd dimension would have an
effect that re-fires forever.

`resolutionLadder`, `projectResolutionValue` and `evenUp` all come from `playbackSlice.ts`, which
`ExportDialog.tsx` already imports `KNOWN_FPS` from — one widened import line.

`estimateBytes` in `exportMath.ts` reads `settings.width * settings.height` and needs no change: a
vertical 1080 × 1920 and a landscape 1920 × 1080 carry the same pixel count and the same model.

`electron/ipc/export.ts` needs no change. `ExportSettings` already carries `width`, `height` and
`fps`; no field is added, no channel is added, and `src/types/api.ts` is not touched (§10.4).

### 6.4 Amendments to `docs/EXPORT.md`

This area owns `EXPORT.md`. Apply, in the same change as the code:

1. **§1.5**, after the `tw`/`th` block — state that placement is rescaled:

   > `positionX` / `positionY` are in **project-resolution** px (`model.ts`). The overlay runs on
   > the output grid, so they are multiplied by `req.width / doc.width` and
   > `req.height / doc.height` before being formatted by `offset()`. At `req` = `doc` — every case
   > in §1.8 — both ratios are 1 and the emitted bytes are unchanged.

2. **§1.5**, extend the existing "Letterbox and pillarbox are transparent, not black" paragraph with
   a forward reference to `docs/FORMAT.md §4.1`, so the fit rule has one owner and the export doc
   is not a second definition of it.

3. **§1.10**, add: the output resolution is always aspect-locked to `doc.width`/`doc.height` by the
   dialog (FORMAT §6.3). The builder does **not** enforce it — a malformed request with a
   mismatched aspect still produces a valid graph, letterboxed to the requested frame — but nothing
   in the shipping UI can construct one.

4. **§7 Out of scope**, add: **no `pad` filter and no baked-in bars.** Bars are the base canvas
   showing through, which is what lets a smaller clip on V2 sit over a larger clip on V1 (§1.5).
   A `pad` filter would make every clip opaque to its own frame and break stacking.

5. **§1.6**, after the overlay-chain description, add the consequence item 4 implies and the preview
   does not honour:

   > The chain composites **every** video contributor, so an upper clip that does not fill the frame
   > reveals the composite beneath it rather than the base canvas. The preview does not: it renders
   > the topmost clip alone (`docs/FORMAT.md §5.5`). This is the one place where the two engines
   > disagree by design rather than by defect, and FORMAT §5.5 owns the statement of it.

6. **§6 Gates**, add: the §1.8 transcripts are no longer diffed by eye. `scripts/check-export-graph.mjs`
   rebuilds all three and diffs `filterScript` and `args` against the literals in §1.8, plus a fourth
   case at double the document resolution that pins the placement rescale above. It bundles
   `electron/export/graph.ts` **from source** with esbuild, as its two sibling gates already do, so it
   cannot pass against a stale build (FORMAT §10.6). It runs inside `npm run check`, so a change to
   `offset()`'s output or to the ratio arithmetic fails a gate rather than a reading.

---

## 7. `adoptSourceFormat`, and how an explicit choice wins

### 7.1 The problem with one boolean

`formatLocked` is a single flag covering *both* frame rate and size. `adoptSourceFormat` returns
early on it; `setProjectFps` and `setProjectSize` both set it.

That is fine while format is adopted-only. It breaks the moment shape is a deliberate choice:

> The user opens the app, sets the project to `Vertical 9:16` before importing anything, then
> imports 24 fps footage. `setProjectSize` set `formatLocked`, so `adoptSourceFormat` returns early,
> so **the project stays at 30 fps** and every clip in it is now on the wrong grid — silently,
> as a side effect of having chosen a shape.

Choosing a shape must not forfeit frame-rate adoption. They are independent facts and need
independent locks.

### 7.2 The split

`PlaybackState` gains two fields and **retains `formatLocked` as a maintained invariant**:

```ts
export interface PlaybackState {
  // … unchanged fields …
  fps: number;
  width: number;
  height: number;
  /** The frame rate has been decided — adopted from a source or set explicitly. */
  fpsLocked: boolean;
  /** The project shape has been decided — adopted from a source or set explicitly. */
  sizeLocked: boolean;
  /**
   * INVARIANT: always `fpsLocked && sizeLocked`. Never written independently.
   * Retained rather than renamed because `mediaSlice` reads it as its adoption guard, and
   * renaming it would mean rewriting guards across a slice this work touches at exactly
   * one argument — see §7.4. Not persisted; `ProjectFile` does not carry it.
   */
  formatLocked: boolean;
  // …
}
```

Every write goes through one helper so the invariant cannot rot:

```ts
/** The ONLY way any of the three lock fields is written. */
const locks = (fpsLocked: boolean, sizeLocked: boolean) => ({
  fpsLocked,
  sizeLocked,
  formatLocked: fpsLocked && sizeLocked,
});
```

Initial state: `fpsLocked: false, sizeLocked: false, formatLocked: false`.

### 7.3 The four actions

**`setProjectFps(fps)`** — locks the rate only. It no longer freezes the shape as a side effect.

```ts
if (next === s.fps) {
  if (!s.fpsLocked) set(locks(true, s.sizeLocked));
  return;
}
set({ fps: next, ...locks(true, s.sizeLocked) });
// recomputeMediaDurations / clampClipsToSource / seek / markDirty / notice — all unchanged
```

**`setProjectSize(width, height)`** — locks the shape only, and rounds to even.

```ts
setProjectSize: (width, height) => {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return;
  // EVEN, not just rounded. 4:2:0 and 4:2:2 require it, the export ladder is even by
  // construction (§2.5), and an odd project height reaching libx264 is a hard encoder
  // failure the user would meet minutes into a render with no idea why. Typing 1081
  // into the Height field gives 1082, visibly, at commit.
  const w = evenUp(clamp(width, SIZE_MIN, SIZE_MAX));
  const h = evenUp(clamp(height, SIZE_MIN, SIZE_MAX));
  const s = get();
  // The two effects are SEPARATE. Choosing the Aspect a fresh project already has is a
  // no-op on the document but still a decision about the shape, so it locks and stops.
  // The shipped shape ran markDirty() here — on a fresh 1920 × 1080 project, sizeLocked is
  // false, so confirming `Landscape 16:9` fell through, lit the unsaved-changes dot and
  // armed the close guard for an operation that changed nothing. PLAN §3.1's rule that
  // nothing may make the project look more unsaved than it was applies to a no-op too.
  // This mirrors setProjectFps's existing equal-value branch.
  if (w === s.width && h === s.height) {
    if (!s.sizeLocked) set(locks(s.fpsLocked, true));
    return;
  }
  set({ width: w, height: h, ...locks(s.fpsLocked, true) });
  get().markDirty();
},
```

No clip is touched, no history transaction is opened, no notice is raised (§3.6).

**`adoptSourceFormat(m)`** — adopts each half independently, and only the halves still open.

```ts
adoptSourceFormat: (m) => {
  const s = get();
  // `Object.keys(s.clips).length === 0` is not a nicety — it is the whole of §7.3's
  // edit-safety guarantee. See below.
  const takeFps  = !s.fpsLocked  && m.fps > 0 && Object.keys(s.clips).length === 0;
  const takeSize = !s.sizeLocked && m.width > 0 && m.height > 0;
  if (!takeFps && !takeSize) return;

  const fps = takeFps ? snapKnownFps(clamp(m.fps, FPS_MIN, FPS_MAX)) : s.fps;
  set({
    ...(takeFps ? { fps } : null),
    ...(takeSize
      ? {
          width: evenUp(clamp(m.width, SIZE_MIN, SIZE_MAX)),
          height: evenUp(clamp(m.height, SIZE_MIN, SIZE_MAX)),
        }
      : null),
    ...locks(s.fpsLocked || takeFps, s.sizeLocked || takeSize),
  });
  // Duration recompute is a consequence of the RATE only; skip it when only size moved.
  // No clampClipsToSource, no notice, no re-seek: `takeFps` requires an empty timeline,
  // so there is no clip to shorten and no clip tail that could move under the playhead.
  // `setProjectFps` still owns all three, because an explicit rate change is exactly the
  // case where clips DO exist.
  if (takeFps) get().recomputeMediaDurations(fps);
  get().markDirty();
},
```

**Why rate adoption is gated on an empty timeline, and size adoption is not.**
Today `setProjectSize` sets `formatLocked`, so choosing a shape *structurally* prevents any later
rate adoption and `adoptSourceFormat` can only ever run on a project nobody has touched. Splitting
the locks removes that guarantee, and §7.3 makes "set the shape first, then import" the motivating
workflow — so without the gate the split would open a path that did not exist before:

> Set Aspect to `Vertical 9:16`, import an audio file (`mediaSlice`'s adopt guard requires
> `kind === 'video'`, so nothing locks), lay out several minutes of audio at the default 30 fps,
> then import 24 fps video. The rate adopts, every media `durationFrames` shrinks by 20%, and
> `clampClipsToSource` — the one function in this codebase licensed to shorten a clip the user did
> not ask to shorten — truncates those audio clips.

That is an **import** silently rewriting an edit that is already laid out, and §3.6 establishes that
project format is outside `TimelineDoc`, so `Ctrl+Z` reverts neither the rate nor the truncation.
There is no notice good enough for that. A warning that an unrequested, unundoable rewrite has
already happened is a worse product than the rewrite not happening, and this document's own standard
— §3.6 point 2, "silently rewriting a hand-placed number is the worse of the two failures" — points
the same way. So the answer is not to report the truncation; it is to make it unreachable. **An
import may decide the rate of a project that has no edit in it, and may never change the rate of one
that does.**

The gate costs nothing that the split was for. Every one of the four sequences the split was designed
to fix — the four rows the requirement table below opens with — imports before anything is laid out,
so all four still hold unchanged. What a user loses is the case where they laid
out audio at the default 30 fps and expected a later video import to re-time it — and that user is
better served by the Frame rate field, which is an explicit act, which does raise the notice, and
which is where a decision that rewrites clip durations belongs.

**Size adoption stays ungated** because it mutates nothing: §3.6 is the whole argument, and a shape
adopted onto a laid-out timeline re-letterboxes on the next frame with no stored value changing. The
two halves are gated differently because they do different amounts of damage, which is the same
reason they got separate locks.

`s.clips` is `timelineSlice`'s, read through the store's own `get()` exactly as this action already
reads `recomputeMediaDurations` and `markDirty` from other slices. It is **read, never written**, no
selector is added, and `src/state/timelineSlice.ts` stays off the ownership list. `Object.keys` on a
record that holds at most a few hundred clips, once per import, is not a cost worth a memo.

**`m.fps <= 0` means "rate unknown", not "rate zero".** That is the contract, and it is what makes
`takeFps` safe: a caller that cannot measure a frame rate passes `0` and adopts only the size. The
existing guard `if (!(m.fps > 0 && m.width > 0 && m.height > 0)) return;` — which exists so an
audio-only first import cannot set the project to 0 fps — is replaced by the two per-half positivity
tests above, which are strictly stronger: an audio-only item adopts neither half and locks neither,
and a caller with dimensions but no rate adopts the shape only.

That last clause is only worth writing if a real caller can reach it, and §7.4 carries the **two**
one-line call-site edits that make it so: `importBrowserFile` must pass `0` rather than the
project's own rate, and `applyProbe`'s guard must stop ANDing a rate test in front of a call whose
whole point is now to decide per half. Without the second edit a video whose rate `ffprobe` cannot
report adopts nothing on the only path that measures anything, and a vertical source leaves the
project at 1920 × 1080 landscape — which is the exact failure §7 exists to remove.

**`hydratePlayback(p)`** — opening a project decides both halves. Add `...locks(true, true)` in place
of `formatLocked: true`. A saved project's format is explicit by definition and must never be
re-adopted by a re-probe on open.

**The requirement, restated as behaviour:**

| Sequence | Result | Timeline at the import |
|---|---|---|
| Set `9:16` → import 1920×1080 @ 24 | `1080 × 1920 @ 24`. Shape kept, rate adopted. | empty |
| Import 1920×1080 @ 24 → set `9:16` → import another | `1080 × 1920 @ 24`. Explicit shape survives the second import. | empty at the first import; `fpsLocked` by the second |
| Set fps 25 → import 1920×1080 @ 24 | `1920 × 1080 @ 25`. Rate kept, shape adopted. | irrelevant — `fpsLocked` already |
| Open a `.veproj` → import anything | Nothing adopts. Both halves are explicit. | irrelevant — both locked |
| Set `9:16` → import audio → lay several minutes of it out at 30 fps → import 1920×1080 @ 24 | `1080 × 1920 @ **30**`. Shape kept (explicit), **rate not adopted, no clip shortened, no notice.** The rate is corrected in the Frame rate field if the user wants it. | not empty |
| Import a video whose rate `ffprobe` cannot report | `1080 × 1920 @ 30`. Shape adopts, rate stays open for the next import that can report one. | empty |

**An explicit choice always wins and is never silently overwritten, and an edit that already exists
is never rewritten by an import.** The third column is the load-bearing one: the empty-timeline gate
is invisible in every row the split was designed for and decisive in the fifth, which is the row that
existed as a hazard before it.

Every row but the last assumes a source whose rate was actually **measured** — i.e. Electron's
`ffprobe` path. On the `dev:web` browser-drop path no rate exists to adopt (§7.4 Edit 2), so row 1
would read `1080 × 1920 @ 30` there with `fpsLocked` still `false`. That is the honest answer, not a
shortfall: nothing measured the source, so nothing was adopted. The harness caveat matters and
§11.29 carries it — `dev:web` opens the fixture project, and an opened project has already decided
both halves, so on that harness nothing adopts at all.

### 7.4 `src/state/mediaSlice.ts` — two single-line edits

**The `formatLocked` half of both guards does not change.** `mediaSlice` guards its two
`adoptSourceFormat` calls with `!get().formatLocked`. Because `formatLocked` is maintained as
`fpsLocked && sizeLocked`, that guard now reads "at least one half is still open", which is exactly
when the call is worth making. `adoptSourceFormat` then decides, per half, what to take. This is why
`formatLocked` is retained rather than renamed: renaming it would mean patching call sites across a
slice, which is precisely the cross-area collision that has already cost this project a build once.

#### Edit 1 — `applyProbe`'s guard stops requiring a rate

The Electron path guards with:

```ts
// src/state/mediaSlice.ts, applyProbe. TODAY:
if (!get().formatLocked && data.kind === 'video' && data.fps > 0 && data.width > 0) {
```

`data.fps > 0` was correct under the old single-flag `adoptSourceFormat`, which took both halves or
neither and would have written `fps: 0` into the project. Under the split it is a defect, and a
quiet one: it ANDs a **rate** test in front of a call whose entire purpose is now to decide each half
separately, so a video whose frame rate `ffprobe` reports as `0` — a variable-frame-rate capture, a
container with no `avg_frame_rate`, a stream ffprobe declines to guess at — adopts *nothing*. A
vertical phone recording lands in a project still sitting at 1920 × 1080 landscape, which is the
exact failure §7 exists to remove, on the only path in the app that can measure anything.

```ts
// src/state/mediaSlice.ts, applyProbe. AFTER:
if (!get().formatLocked && data.kind === 'video' && (data.fps > 0 || data.width > 0)) {
```

`kind === 'video'` still keeps audio out. The two per-half positivity tests inside
`adoptSourceFormat` do the rest: a rate of `0` adopts the shape only, a width of `0` adopts the rate
only, and both zero returns at the `if (!takeFps && !takeSize) return;` line without touching
anything. The browser path's guard already reads `probed.width > 0` with no rate test, so after this
edit the two paths express the same rule.

#### Edit 2 — `importBrowserFile` passes `0`, not the project's own rate

`importBrowserFile` — the browser-drop path, the one `dev:web` uses — calls:

```ts
// src/state/mediaSlice.ts, importBrowserFile. TODAY:
get().adoptSourceFormat({ fps: get().fps, width: probed.width, height: probed.height });
```

It passes the project's **own** frame rate because a media element cannot report one. Under a single
`formatLocked` that is harmless — the flag was going to be set either way. Under the split it is a
defect: `takeFps` is true there whenever the timeline is empty, so the browser path sets
`fpsLocked: true` from a number nobody measured, permanently blocking the project from ever adopting
a real source rate, and it runs `recomputeMediaDurations` for a rate that did not move.

The edit, and the whole of it:

```ts
// src/state/mediaSlice.ts, importBrowserFile. AFTER:
get().adoptSourceFormat({ fps: 0, width: probed.width, height: probed.height });
```

`0` is the contract's "rate unknown" (§7.3), so `takeFps` is false, only `sizeLocked` is set, and the
frame rate stays open for the first import that can actually report one. The item's own record
already stores `fps: 0` for this reason — the in-file comment "the element cannot report a frame
rate; 0 means 'unknown', never used to convert" is the same idea, and this makes the adopt call agree
with it. Update the adjacent comment's last clause, which currently reasons from the old single-flag
behaviour.

The Electron path's **argument** is unchanged — `applyProbe` passes a real probed `data.fps`. Only
its guard moves, and only as Edit 1 spells out.

`src/state/mediaSlice.ts` is on the §0 ownership list for these two lines. Nothing else in the file
is touched, and no other file outside the list changes.

**Neither edit is reachable from `dev:web`'s default state, and §11 says so rather than pretending
otherwise.** `dev:web` boots `bootstrapFixtures` → `applyProject` → `hydratePlayback`, which sets
`locks(true, true)`; both `mediaSlice` guards then fail on `!get().formatLocked` and neither call
site runs. The only unhydrated store in the app is an Electron launch with no project opened — there
is no `newProject` action — so that is the harness §11.16, §11.29 and §11.30 nominate, and the
`dev:web` half of §11.29 asserts what actually holds there instead of an expectation the harness
cannot produce.

One consequence worth stating rather than discovering: `mediaSlice`'s `resolution-mismatch` warning
compares each import's dimensions against the project and produces
`Source is 1920×1080, the project is 1080×1920`. In a vertical project that now fires on essentially
every landscape import. It is **correct and it stays** — it is the app telling the user, at import
time, exactly which clips will arrive with bars. That is useful information, not noise, and it is
`mediaSlice`'s to change in any case.

### 7.5 PLAN amendments this requires

`docs/PLAN.md` is not on the ownership list. Reported, not edited:

1. **§3.3** declares `PlaybackState.formatLocked: boolean` and describes it as "Adopted from the
   first ready media item, then locked against re-adoption." It needs `fpsLocked` and `sizeLocked`
   added to the declared interface, and `formatLocked` re-described as the maintained conjunction.
2. **§3.3** declares `adoptSourceFormat` as "One-shot auto-adopt from the first ready item. No-op
   when formatLocked." It becomes: adopts each of rate and shape independently, and only where that
   half is still unlocked; a source rate of `0` means "unknown" and adopts the shape only; and — new,
   and the reason this is an amendment rather than a clarification — **the rate half additionally
   requires an empty timeline**, so that an import can never re-time an edit that already exists
   (§7.3). It raises no `Notice` and shortens no clip: those stay `setProjectFps`'s, which is the
   action a user takes deliberately.

---

## 8. Backward compatibility

| Concern | Status |
|---|---|
| Existing `.veproj` files | **Load unchanged.** `ProjectFile` already carries `width` and `height`; no field is added and none is removed. |
| `ProjectFile.version` | **Stays `1`.** There is no migration, because there is nothing new to migrate. |
| `migrateProject` / `serializeProject` (`src/lib/project.ts`, not owned) | **No edit.** Nothing to serialise. |
| A saved `1920 × 1080` project | Opens, and the Aspect row reads `Landscape 16:9` immediately, derived. |
| A saved project with an odd dimension | Opens with the odd value intact, and the Width / Height fields show it. The store is only rounded the next time `setProjectSize` runs, which requires the user to touch a control — **loading never rewrites a file silently.** Every path that hands the number to an *encoder* rounds it up, in one helper: the ladder's passthrough row, both Resolution selects' `value` (`projectResolutionValue`), and the export dialog's `open` reset (§6.3). So a 1920 × 1081 project reads 1081, offers `1920 × 1082`, and cannot hand libx264 an odd height. |
| Autosave / crash recovery | **No edit.** `src/keyboard/projectActions.ts` already subscribes to `s.width` and `s.height`, so a shape change is captured by the crash net exactly like a resolution change is today. |
| `src/types/api.ts` | **Untouched.** See §10.4. |
| The three verified `EXPORT.md §1.8` transcripts | **Byte-identical.** §6.2's fix is a no-op at `req` = `doc`. |

---

## 9. Accessibility

Not a checklist item — the reasons each requirement is already met, or how it is met.

- **Keyboard operability.** Both new controls are native `<select>`, reached in the inspector's
  existing tab order, operable with arrows, Home/End and type-ahead on every OS. `Select`'s header
  already records that a native element is used precisely because "a hand-rolled listbox reliably
  loses" here, and that it sits inside `TEXT_INPUT_SELECTOR` so its keystrokes never leak to the
  shortcut layer.
- **Accessible names.** `PropertyRow label="Aspect" htmlFor={aspectId}` supplies the visible copy;
  `Select label="Aspect"` supplies the accessible name. Same pattern as every other row in the file.
- **Contrast.** No new text colour. Two new painted things, both checked. `.ve-video-stage`'s
  outline is `--border-structural` (`oklch(0.58 …)` in the dark themes, `oklch(0.60 …)` in
  `daylight`), the token PLAN §7.5 established for the 3:1 non-text floor — §5.3 *fixes* a 1:1
  boundary rather than introducing one. And the stage's fill becomes `--frame-matte` (`oklch(0 0 0)`),
  which sits on the inner side of that outline and **raises** its contrast rather than lowering it:
  0.58 against 0 is a larger step than 0.58 against `--surface-well`'s 0.10, and in `daylight` 0.60
  against 0 is larger than 0.60 against 0.13. The boundary clears 3:1 on both sides in all three
  themes, which is item §11.19's measurement.
- **Colour-blindness.** Nothing in this feature encodes state in hue. The aspect is carried by a
  word (`Vertical 9:16`), the resolution by a name and a number, the frame boundary by a neutral
  line. There is no red, no green, and nothing for deuteranopia to collapse.
- **The Icon Tax Rule.** No new status *surface* is introduced, and no new status *string* either.
  The one place status appears is `mediaSlice`'s existing `resolution-mismatch` warning, which
  already carries icon + text and derives colour third. §7.3 adds no `Notice`: the case that would
  have needed one — a rate adoption truncating a laid-out edit — is made unreachable instead of
  reported, which is the stronger answer and also the one that costs no new copy.
- **Reduced motion.** No animation is added anywhere in this feature. The stage changes shape
  instantly; nothing is gated on a transition completing.
- **Tabular numerals.** The Resolution select carries `numeric`; the Width, Height and Frame rate
  fields are `NumericField`, which is already mono and tabular. Every numeral in the group that can
  change while the interface is live is tabular.
- **No disabled controls.** Width and Height stay enabled in every state (§3.4), and `Custom` is
  never a dead option (§3.4). PLAN's S4 resolution — disabled requires a `disabledReason` — is
  satisfied by owing nothing.

---

## 10. Cross-area requirements

Three kinds of entry, kept apart on purpose:

- **Applied in this change**, because the feature does not land without them and nothing else is
  running to apply them: §10.1 (`tokens.css`), §10.6 (`check-export-graph.mjs` + `package.json`), and
  §7.4's two changed lines in `mediaSlice.ts`. All are on the §0 ownership list, each for the exact
  lines named there.
- **Reported to their owners**, changing no file here: §10.2 (`PLAN.md`), §10.3 (a follow-up button),
  §10.5 (`README.md`).
- **Nothing at all**: §10.4 (`src/types/api.ts`), stated explicitly because that file is where a
  cross-area collision has already cost this project a build.

### 10.1 `src/styles/tokens.css` — one token, one block

**Applied here.** Required by §5.4, and load-bearing: without it `npm run check` fails
`undefined-token` and the change cannot land (§5.4, last paragraph).

Add as a **standalone `:root` block immediately after the `daylight` colour block**, so it reads as
what it is rather than as a member of any theme's palette:

```css
/* ====================================================== 7.1a Frame matte ===
   THEME-INVARIANT ON PURPOSE, and declared ONCE rather than three times.

   This is the colour ffmpeg's `color=c=black` base canvas writes into the
   delivered file (EXPORT §1.2), so it is CONTENT, not a plane: exempt from the
   four-plane ramp for the same reason a black frame of footage is, and a theme
   has no more business changing it than it has changing the footage. The
   contract checker treats a token declared in only one block as theme-invariant
   by intent — its rule is "a token that appears in MORE THAN ONE theme block
   must appear in ALL of them" — so one declaration passes theme parity and is
   the smaller, truer edit than three identical copies.

   Consumed by .ve-video-stage and nothing else. Do not add it to the plane ramp
   and do not derive anything from it.                                        */

:root {
  --frame-matte:           oklch(0 0 0);
}
```

The value is a colour literal, which is legal here and only here — `tokens.css` is the one file rule
1 exempts, and §11.34's grep excludes it.

### 10.2 `docs/PLAN.md` — two declarations in §3.3

Stated in full in §7.5. Reported for whoever owns PLAN; this area codes against the shape described
there and does not edit the file.

### 10.3 Follow-up, not required: a "Fill frame" action

`src/components/inspector/Inspector.tsx` and `ClipPropertyRow.tsx` are on nobody's ownership list,
so this is **reported, not requested**, and the feature is complete without it.

Reframing a mismatched clip currently means typing `316` into the Scale field, and §4.2 puts that
number in a table so it is knowable. A one-click version would be a secondary `Button` in the
Transform group:

```tsx
// src/components/inspector/Inspector.tsx, inside the transform InspectorGroup.
// Not primary — the accent budget is closed (PLAN §7.4) and Export owns the one
// primary action in any view.
<Button
  variant="secondary"
  size="sm"
  onClick={() => {
    const s = readStore();
    const a = media.width / media.height;
    const p = s.width / s.height;
    s.updateClipProperties([...s.selection], { scale: Math.max(a / p, p / a) }, 'Fill frame');
  }}
>
  Fill frame
</Button>
```

It writes the existing `scale` property through the existing action with its existing history label,
so it is one undo step, fully adjustable afterwards, and it invents nothing — it is arithmetic on two
aspect ratios, not a crop tool and not content analysis.

**No helper is exported from `playbackSlice.ts` for it.** Whoever builds this owns the two lines of
arithmetic along with the button; a `fillScale` export sitting in the app's most load-bearing slice
with zero call sites would be dead API waiting for a caller that has no owner. §4.2's table is the
part a user needs and it ships now.

### 10.4 `src/types/api.ts` — **nothing**

Stated explicitly, because the orchestration failure this rule exists to prevent was two areas
editing this file.

**This area requires no change to `src/types/api.ts`.** `ExportSettings` already carries `width`,
`height`, `fps`, `codec`, `quality` and `range`; `ExportDocument` already carries `width`, `height`
and `fps`; `ExportRequest` already carries everything the graph needs. No widening, no new channel,
no new type. The `format` implementer must not open the file.

### 10.5 `README.md` — reported

Not owned. Four entries for whoever owns it, one of which is a **correction to a claim that is
currently false** and is the only one that cannot wait:

1. **Replace the Known-limitations bullet at README:218**, which currently reads *"The preview
   composites the topmost visible video clip, and so does the export."* The first half is true; the
   second is not, and this feature is what makes the difference visible (§5.5). Replacement:

   > - **The preview shows one video layer; the export composites all of them.** The preview renders
   >   the topmost visible video clip at the playhead. The export overlays every video track in
   >   order, so an upper clip that does not fill the frame — a landscape clip in a vertical project,
   >   or any clip scaled below 100% — reveals the track beneath it in the delivered file, where the
   >   preview shows black. Scale the upper clip to fill the frame, or keep the tracks under it clear
   >   at that point. Transform, opacity and speed apply per clip in both engines. Audio tracks mix.

2. Under features: project shape is chosen in the inspector, five presets plus custom, and export
   resolutions are named and locked to the project aspect.

3. Under **Known limitations**: changing the project format is not undoable (§3.6), and a mismatched
   source letterboxes and is reframed with Scale and Position (§4.2). Nothing conditional: the matte
   is correct in this change (§10.1), so there is no bar-colour limitation to record.

4. Under **Known limitations**, one sentence on the custom-shape ladder (§2.5): a project whose shape
   is not one of the four presets offers only the resolutions it reaches at exactly that shape, so an
   unusual shape may offer its own size alone — change it with the Width and Height fields. Say it
   the positive way round too, because it is the point: every row of every Resolution list is exactly
   the shape of the project, so picking one can never change what the frame looks like.

### 10.6 `scripts/check-export-graph.mjs` and one line of `package.json`

**Applied here.** §11.25 calls the byte-for-byte diff of `EXPORT.md §1.8`'s three transcripts "the
regression gate on §6.2 and it is not optional", and today no such gate exists: `npm run check` is
three scripts, none of which references `buildExportGraph`. A gate that exists only as a sentence in
a document gets satisfied by eye, which is exactly how a one-character change to `offset()`'s output
slips through — and §6.2 is a change to what `offset()` is fed.

New file, mirroring the shape of the scripts already in `scripts/`: non-zero exit on failure, and
**it bundles `electron/export/graph.ts` from SOURCE with esbuild**, exactly as `check-fps-snap.mjs`
and `check-timeline-guards.mjs` already bundle `src/state/*.ts` into a `mkdtempSync` directory. It
then rebuilds each request and diffs `filterScript` and `args` against the literals held in
`EXPORT.md §1.8`. The loading half is fixed text, and it is the only part of the script this document
dictates:

```js
// scripts/check-export-graph.mjs — the same preamble the two sibling gates use.
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const entry = fileURLToPath(new URL('../electron/export/graph.ts', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 've-export-graph-'));
const outfile = join(dir, 'graph.mjs');
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
});
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const { buildExportGraph } = await import(pathToFileURL(outfile).href);
```

**Reading `dist-electron/` instead would be wrong twice, and the second way is the dangerous one.**
`dist-electron/` is gitignored, so a clean clone running `npm run check` alone exits 2 rather than
passing — the brief's gate line happens to run `npm run build` first, but nothing makes CI or a
reviewer do the same. Far worse: a **stale** `dist-electron/` makes the gate assert against the
previous build and **pass**. `electron/export/graph.ts` is on this area's own ownership list and §6.2
changes it, so the single most likely sequence in this whole change — edit `graph.ts`, run
`npm run check` — would green-light un-rebuilt code. The one gate this document calls "not optional"
and "satisfying it by eye is not satisfying it" must not be the one gate in the suite that can
silently validate something other than the source.

Bundling from source resolves cleanly: `graph.ts` imports only `src/types/api.ts` and
`src/types/model.ts`, both of which are plain TypeScript with no DOM, no React and no node built-in,
which is the same property `EXPORT.md §1.1` already relies on for the value import of
`clipHasAudio` / `clipHasVideo`. `esbuild` is already a Vite dependency, so no package is added. The
gate becomes build-independent and stale-proof, and `npm run check` stands alone again.

**Four cases, not three.** A, B and C are the §1.8 transcripts, all `req` = `doc` = 1920 × 1080,
where `rx === ry === 1` and §6.2 is a provable no-op. A fourth case makes §11.24 a gate rather than a
one-time observation: the A document with `req.width = 2 × doc.width`, `req.height = 2 × doc.height`
and one clip at `positionX: 100`, asserting the emitted overlay carries `+200`. Without it the whole
point of §6.2 is unmeasured — the three real transcripts cannot see it by construction.

`package.json`, one string, appended:

```json
"check": "node scripts/check-contract.mjs && node scripts/check-timeline-guards.mjs && node scripts/check-fps-snap.mjs && node scripts/check-export-graph.mjs"
```

---

## 11. Verification

Every item is a measurement, not an inspection, and where a thing can only be measured in the source
the item says so and gives the exact command. Items are numbered contiguously and are referenced by
number from the sections above.

**Harnesses.** Three, and the difference between them decides several items below:

- **`dev:web`** — `http://localhost:5173`, the 41-clip fixture project. It boots
  `bootstrapFixtures` → `applyProject` → `hydratePlayback`, which runs `locks(true, true)`, so on
  this harness `fpsLocked`, `sizeLocked` and `formatLocked` are **all true from the first paint** and
  neither `mediaSlice` adopt call site can fire. Pure-function items and DOM items run here; no
  adoption item does.
- **Electron, project opened** — built through CDP per the project's standard harness. Same lock
  state as above once a project is applied.
- **Electron, fresh launch, nothing opened** — the **only unhydrated store in the app**. There is no
  `newProject` action and `applyProject` has exactly two callers (`bootstrapFixtures` and
  `projectActions`), so this is the one place `fpsLocked === false && sizeLocked === false` exists.
  Every adoption and lock item runs here.

Assert `document.visibilityState === 'visible'` in every sample that touches playback.

**Named resolutions**

1. `resolutionLadder(1920, 1080).map(o => o.label)` equals exactly
   `['4K UHD · 3840 × 2160', '2K QHD · 2560 × 1440', '1080p · 1920 × 1080', '720p · 1280 × 720', '480p · 854 × 480']`.
2. `resolutionLadder(1080, 1920).map(o => o.label)` equals exactly
   `['4K vertical · 2160 × 3840', '2K vertical · 1440 × 2560', '1080 vertical · 1080 × 1920', '720 vertical · 720 × 1280', '480 vertical · 480 × 854']`.
   **No entry reads `1080p`.**
3. Every row of every ladder carries the shape it was generated from. For each preset ladder in §2.2,
   `resolutionLadder(w, h).every(o => Math.abs(o.width / o.height - w / h) < 0.01)` is `true`. For a
   **custom** shape the bound is not approximate but exact, which is the exactness rule of §2.5:
   `resolutionLadder(4096, 2160).every(o => o.width * 2160 === o.height * 4096)` is `true`, and the
   same for `2560 × 1080` and `1440 × 1080`.
4. **The ladder is a fixed point over its tier rows — the check items 1 and 2 cannot make, because
   they only ever run against a pristine store.** For each of the five options of
   `resolutionLadder(1920, 1080)`: call `setProjectSize(o.width, o.height)`, then assert
   `resolutionLadder(readStore().width, readStore().height).map(o => o.label)` equals item 1's five
   labels in the same order. Repeat from `1080 × 1920` against item 2, and from `1080 × 1350` against
   §2.2's 4:5 table.
   Specifically, after selecting `480p · 854 × 480`, **no label contains `3844`** and nothing wider
   than 3840 is called `4K UHD`. Generating from the live ratio instead of the preset's makes this
   item fail on the first iteration.
   **And the same assertion against a custom shape, which is where §2.3 point 3 lives.**
   `resolutionLadder(4096, 2160).map(o => o.value)` is `['4096x2160', '2048x1080']`; for **each** of
   those two, `setProjectSize` to it and assert the regenerated ladder is that same two-element list.
   Restricting item 4 to presets is what let the ratchet ship the last time: before §2.5's exactness
   rule, selecting `2732 × 1440` from a 4096 × 2160 project moved the ladder to
   `['4098x2160', '2732x1440', '2050x1080', '1366x720', '912x480']` and `4096 × 2160` was gone from
   that project for good, while items 1–3 and the preset half of item 4 all still passed.
5. Every `width` and `height` in every ladder is even, **including the passthrough row**:
   `resolutionLadder(1920, 1081)[2]` is `{ width: 1920, height: 1082 }` and its label is exactly
   `'1920 × 1082'` — no tier name — while `readStore().height` is still `1081`.
6. **Every ladder is non-increasing by short edge, passthrough row included.** For each of
   `1920 × 1080`, `1080 × 1920`, `1920 × 1081`, `1000 × 1000`, `1778 × 1000`, `4096 × 2160` and
   `16 × 8192`: `resolutionLadder(w, h).map(o => Math.min(o.width, o.height))` is non-increasing.
   Specifically `resolutionLadder(1000, 1000).map(o => o.label)[3] === '1000 × 1000'` — the
   project's own size in size order, **not at the head**, where it read as the largest option while
   being the smallest. Nothing else in §11 pins ordering, so without this item a prepended
   passthrough row passes every other assertion in this list.
7. Generator inputs, not rendered labels: `JSON.stringify(ASPECT_PRESETS)` and
   `String(RESOLUTION_TIERS)` contain no `4096` and no `2048`, and no entry of
   `resolutionLadder(1920, 1080)` is wider than 3840. And the positive half, which is §2.3's escape
   hatch: `resolutionLadder(4096, 2160)` contains an entry with `width === 4096 && height === 2160`,
   whose label is exactly `'4096 × 2160'` — present, and unnamed. Item 7 is about the generator
   because a blanket "no label anywhere contains 4096" would fail the moment §2.3's own escape hatch
   is used, and inviting an implementer to suppress that entry would delete the capability §2.3
   promises survives.
8. No ladder entry exceeds `SIZE_MAX` on either axis. `resolutionLadder(16, 8192)` has length 1 and
   is the project's own size — every tier wants over 16384 px on one axis and is skipped, and the
   project's size is still reachable. `resolutionLadder(1920, 1000)` likewise has length 1, for the
   other reason in §2.5: 1.92 reaches no tier exactly, so the ladder is the project's own size alone
   rather than five rows of a slightly different shape.
9. `resolutionLabel(1920, 1084) === '1920 × 1084'` and `resolutionLabel(1922, 1080) === '1922 × 1080'`
   — both inside `ASPECT_EPSILON` of 16:9, neither borrowing a name it has not earned.
10. The export dialog's Resolution `<select>` carries `data-numeric` and its computed
    `font-family` resolves to `var(--font-mono)`.

**Project format**

11. With nothing selected, the inspector's Project group renders five rows in the order Aspect,
    Resolution, Width, Height, Frame rate.
12. Setting Aspect to `Vertical 9:16` on a `1920 × 1080` project produces `width === 1080` and
    `height === 1920` in one store write.
13. `Custom` is absent from the Aspect options while `resolveAspectId(w, h) !== 'custom'`, and
    present-and-selected when it is.
14. Typing `1081` into Height commits `1082`. `readStore().height % 2 === 0` after any
    `setProjectSize`.
15. A format change leaves `JSON.stringify(readStore().clips)` byte-identical, and leaves
    `readStore().history.past.length` unchanged.
16. `readStore().isDirty === true` after a format change that moved a dimension — **and unchanged
    after one that did not.** **Electron, fresh launch, nothing opened**, which is the only store
    where `sizeLocked === false`: on `dev:web` and on any opened project `hydratePlayback` has
    already run `locks(true, true)`, so the precondition is unreachable there and the second half of
    this item would pass vacuously. On that fresh store, with `isDirty === false`, select
    `Landscape 16:9` on the 1920 × 1080 default: `readStore().isDirty` is still `false` and
    `readStore().sizeLocked` is now `true`. Then move a dimension and assert `isDirty === true`.
    Confirming the shape you already have must not arm the quit prompt.
17. Every Resolution `<select>` holds a value that exists in its own options. For `(w, h)` in
    `1920 × 1080`, `1080 × 1920`, `1920 × 1081` and `4096 × 2160`:
    `resolutionLadder(w, h).some(o => o.value === projectResolutionValue(w, h))` is `true`.

**The preview**

18. In a `1080 × 1920` project, `.ve-video-stage`'s `getBoundingClientRect()` satisfies
    `Math.abs(w / h - 1080 / 1920) < 0.01`. Repeat for `1:1` and `4:5`.
19. `getComputedStyle(stage).outlineWidth === '1px'` and its `outlineColor` resolves to
    `--border-structural`, in all three themes.
20. `getComputedStyle(document.documentElement).getPropertyValue('--frame-matte').trim() !== ''`, and
    `getComputedStyle(stage).backgroundColor` is the **same** computed string in all three themes and
    is black. A theme switch must not move the matte.
21. With a landscape clip under the playhead in a vertical project, the `<video>` element's
    rendered content box is narrower in aspect than the stage — i.e. bars exist — and the clip is
    horizontally flush with the stage edges.
22. Changing the project format while a clip is under the playhead produces no console error and no
    reload of the `<video>` element (`el.currentTime` is continuous across the change).

**Export agreement — the rule that governs everything**

23. `buildExportGraph` for a `1920 × 1080` source in a `1080 × 1920` project at `1080 × 1920` emits
    `scale=1080:1920:force_original_aspect_ratio=decrease…` and an overlay with `x=(W-w)/2+0`.
24. With `positionX: 100` in a `1080 × 1920` project exported at `2160 × 3840`, the emitted overlay
    reads `x=(W-w)/2+200`. Before the §6.2 fix it reads `+100`; that difference is the defect. This
    is case D of the script in item 25, not a one-time observation.
25. The three `EXPORT.md §1.8` transcripts diff **byte-for-byte** against the rebuilt graph. This is
    the regression gate on §6.2 and it is not optional, which is why §10.6 makes it
    `scripts/check-export-graph.mjs` and appends it to `npm run check`. Satisfying it by eye is not
    satisfying it — and neither is satisfying it against a stale build. Two assertions on the gate
    itself, because a gate that can pass without seeing the source is worse than no gate:
    - `grep -n 'dist-electron' scripts/check-export-graph.mjs` returns **nothing**; the script
      bundles `electron/export/graph.ts` from source with esbuild (§10.6).
    - With `dist-electron/` deleted, `npm run check` still passes. Then append a stray character to
      `offset()`'s output format in `electron/export/graph.ts`, run `npm run check` **without
      rebuilding**, and assert it exits non-zero. A gate that reads the build output passes both of
      those the wrong way round.
26. A real Electron export of a vertical project at `1080 × 1920` produces a file `ffprobe` reports
    as `1080x1920`, with the source visible as a centred band and black above and below.
27. **The stacking gap of §5.5 is measured, not assumed.** In a `1080 × 1920` project: a
    full-frame vertical clip on V1 and a `1920 × 1080` landscape clip on V2, overlapping at the same
    frame, both at default properties. Park the playhead inside the overlap and export.
    - **Preview:** sample the stage at 10% and at 90% of its height, inside the bars. Both read the
      matte — `getComputedStyle(stage).backgroundColor`, i.e. black — because `VideoSurface` renders
      one `ClipId`.
    - **File:** `ffprobe`/one extracted frame at the same timestamp shows **V1's picture** in those
      same two bands, because `graph.ts` chained an `overlay` for V1 before V2.
    - Assert the two disagree. This item passing is the current, documented, README-corrected
      behaviour (§5.5, §10.5 item 1). It is written as a measurement of the *gap* so that the day a
      multi-layer preview lands, the item that proves it is already here and simply inverts.
28. **The export dialog's Resolution select cannot render a value absent from its options.** In a
    `1920 × 1080` project, open the Export dialog, then from the console call
    `readStore().setProjectSize(1080, 1920)` — the same store write an in-flight probe's
    `adoptSourceFormat` performs, and reachable while the modal `<dialog>` is up. The options are now
    the 9:16 ladder, so assert on the live element: `sel.selectedIndex === 2`,
    `sel.value === '1080x1920'`, and the selected option's text reads `1080 vertical · 1080 × 1920`.
    **`selectedIndex` is the discriminating half** — a native select with an unmatched value reports
    `selectedIndex === 0` and a `value` equal to its first option, so `sel.options[sel.selectedIndex]
    .value === sel.value` is true either way and proves nothing. Without §6.3's reconciling effect
    this reads `selectedIndex === 0` and `'2160x3840'` while the request still carries 1920 × 1080 —
    the UI lying and a landscape file shipping from a vertical project.
29. Adoption on both paths, **with the different correct answers each harness actually produces**.
    - **Electron, fresh launch, nothing opened** (`applyProbe`, a real probed rate, empty timeline):
      `setProjectSize(1080, 1920)`, then import 24 fps 1920 × 1080 footage. Leaves
      `{ fps: 24, width: 1080, height: 1920, fpsLocked: true, sizeLocked: true, formatLocked: true }`.
    - **Electron, fresh launch, nothing opened**, the contract §7.4 Edit 2 depends on, called
      directly because no Electron call site passes `0`:
      `readStore().adoptSourceFormat({ fps: 0, width: 1920, height: 1080 })` leaves
      `{ fps: 30, width: 1920, height: 1080, fpsLocked: false, sizeLocked: true, formatLocked: false }`
      — the shape taken, the **rate still open** for the first import that can report one.
    - **`dev:web`** (`importBrowserFile`): assert what actually holds, which is that **nothing
      adopts**. `readStore().formatLocked` is `true` at first paint because the fixture project was
      opened, so dropping a file leaves `fps`, `width` and `height` untouched. That is §7.3's fourth
      row, and it is the whole behaviour of that harness; expecting an adoption there is expecting a
      correct implementation to fail.
    - **The `dev:web` call site's argument**, which no runtime harness can exercise with an open
      lock: `grep -n 'adoptSourceFormat' src/state/mediaSlice.ts` shows the `importBrowserFile` call
      passing the literal `fps: 0`, never `get().fps`. Stated as a grep because that is honest about
      what is being measured; the behaviour it implies is covered by the second bullet.
30. **§7.4 Edit 1 — a source with no measurable rate still sets the shape.** Electron, fresh launch,
    nothing opened. Drive `applyProbe` with a probe result of
    `{ kind: 'video', fps: 0, width: 1080, height: 1920, … }` and assert
    `{ width: 1080, height: 1920, sizeLocked: true, fpsLocked: false, fps: 30 }`. With the shipped
    guard's `data.fps > 0 &&` still in place this reads `1920 × 1080` and `sizeLocked: false` —
    a vertical source leaving the project landscape, which is the failure §7 exists to remove.
31. **A rate adoption never rewrites an edit that already exists.** Electron, fresh launch, nothing
    opened: set Aspect to `Vertical 9:16`, import an audio file (nothing locks — `mediaSlice`'s adopt
    guard requires `kind === 'video'`), lay several minutes of it out at the default 30 fps, record
    `JSON.stringify(readStore().clips)`, then import 24 fps video. Assert **all** of:
    `readStore().fps === 30`, `readStore().fpsLocked === false`, `readStore().notice === null`, and
    `JSON.stringify(readStore().clips)` byte-identical to the recording. The shape may adopt; nothing
    else may move. Asserting instead that the truncation *happened and was announced* verifies the
    hazard rather than its absence — an import that shortens clips with no undo entry is not made
    acceptable by a `Notice` (§7.3).
32. `readStore().formatLocked === (readStore().fpsLocked && readStore().sizeLocked)` after every
    action in §7.3, in every order, on the fresh-launch store.

**Gates**

33. `npm run typecheck`, `npm run build`, `npm run check` all clean — and `npm run check` now runs
    four scripts, the fourth being `check-export-graph.mjs`. `npm run check` also passes **on a clean
    checkout with no build performed**, which is item 25's first sub-assertion restated as a gate.
34. `grep -rnE '#[0-9a-fA-F]{3,8}|rgba?\(|oklch\(|hsl\(' src/` returns zero hits outside
    `src/styles/tokens.css`.
35. `git status` shows changes only within §0's ownership list, and the narrow exceptions really are
    narrow: `git diff src/styles/tokens.css` is additions only and touches no existing declaration,
    `git diff src/state/mediaSlice.ts` changes exactly two lines plus the comment above each,
    `git diff package.json` changes one string, and `scripts/check-export-graph.mjs` is a new file
    that imports nothing outside `esbuild`, `node:` and `electron/export/graph.ts`.

---

## 12. Out of scope

Stated so nobody gold-plates, and so each omission is a decision on the record.

- **No project-setup dialog, ever.** Not on first launch, not on first import, not behind a
  "don't show again". `PRODUCT.md` names it as an anti-reference and this feature is the argument
  that it is unnecessary.
- **No aspect field in `ProjectFile`.** §3.3. The shape is what the dimensions mean.
- **No 21:9 or 4:3 preset.** §3.2, with the exact numbers to type instead.
- **No DCI 4K or DCI 2K entry.** §2.3, with the route that still reaches them.
- **No per-clip fit mode.** §4.3.
- **No auto-crop, smart crop, content-aware fill, subject tracking, or pan-and-scan keyframes.**
  §4.3. Declined, not deferred.
- **No undo of a format change.** §3.6, with the reason it is structurally impossible without
  redefining another area's snapshot type, and the reason that is acceptable.
- **Rotation still does not export.** `EXPORT.md §7`, unchanged. Reframe with scale and position.
- **No per-track or per-clip aspect.** One project, one shape.
- **No multi-layer preview.** §5.5. The preview renders the topmost video clip; the export
  composites the stack. This feature makes the difference ordinary and therefore owes the statement,
  the README correction (§10.5 item 1) and the measurement (§11.27) — but not the compositor, which
  would redefine which element the playback clock reads `currentTime` from and so touches the ONE
  playhead writer / ONE rAF loop invariant. Deferred with its reason, not declined.
- **No approximate rows in a custom shape's ladder.** §2.5. A shape that reaches a tier only to
  within a pixel or two does not get that row, even though it means some custom projects offer their
  own size alone. A menu row that changes the shape of the output is the failure this document
  exists to prevent; a short menu is not.
- **No rate adoption onto a timeline that already has clips.** §7.3. An import may decide the frame
  rate of an empty project and may never re-time an edit that exists, because the truncation that
  would follow has no undo entry (§3.6). The Frame rate field still does it, deliberately and with a
  notice.
- **No `pad` filter in the graph.** §6.4 item 4. Bars are the base showing through, which is what
  makes V2-over-V1 stacking work.
- **No fps change on the export ladder.** Frame rate and resolution stay independent controls;
  `EXPORT.md §1.3`'s two-rate handling is untouched.
- **No `fillScale` helper in `playbackSlice.ts`.** §4.2 ships the table and the one-line formula;
  the exported function waits for §10.3's button to have an owner, because an export with no call
  site in that file is dead API.
- **No fallback matte, and no conditional limitation about the matte's *colour*.** §10.1 is part of
  this change (§5.4), so the preview's bars are black in all three themes. There is no "ships either
  way" state: `var(--frame-matte, …)` fails `npm run check` exactly as hard as the bare form. The
  separate limitation about what *fills* a bar under a stack is §5.5's and is recorded in the README
  (§10.5 item 1); it is a compositing gap, not a colour one, and no token value could close it.
- **The store is never rewritten to make a dimension even.** Rounding happens where a number is
  handed to an encoder or shown in a Resolution select (§2.5, §8), not on load.
