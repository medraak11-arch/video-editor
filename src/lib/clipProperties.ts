/* ---------------------------------------------------------------------------
   clipProperties.ts — the pure sanitisers, shared by the LOAD path and the
   WRITE path.

   WHY THIS FILE EXISTS, and the one rule it has:

   `normalizeClipProperties` and `subtitleStyleOf` have two callers that live on
   opposite sides of the app. `src/lib/project.ts` needs them to sanitise a
   `.veproj` on open; `src/state/timelineSlice.ts` needs the SAME tables to clamp
   every inspector write, because two copies of a clamp table are two clamp
   tables that drift — and the drift surfaces as a value the migration accepts
   and the store rejects, or a value the store holds and the next open silently
   rewrites.

   They cannot live in project.ts. That module imports `readStore` from
   `src/state/store.ts`, and store.ts calls `createTimelineSlice(...a)` at
   MODULE-EVAL time inside `create(...)`. A `timelineSlice → project → store →
   timelineSlice` cycle therefore resolves with whichever module resumes second
   reading a `const` arrow still in its temporal dead zone, and the store is
   built with `createTimelineSlice` as `undefined`. That is not theoretical: it
   took out check-linking, check-timeline-guards and check-fps-snap with
   `TypeError: createTimelineSlice is not a function`. Hoisting does not save it,
   because none of the bindings involved is a hoisted function declaration.

   THE RULE: this module imports from `src/types/` ONLY. Nothing from
   `src/state/`, nothing from `src/components/`, no DOM and no node import — it
   is compiled into both the renderer bundle and dist-electron, exactly as
   model.ts is. An import added here that reaches into the store re-creates the
   cycle this file was carved out to break.

   project.ts re-exports both functions, so the load path and every existing
   consumer are unchanged.
--------------------------------------------------------------------------- */

import type { ClipProperties, SubtitleStyle } from '../types/model';
import { DEFAULT_CLIP_PROPERTIES, DEFAULT_SUBTITLE_STYLE } from '../types/model';

/* ------------------------------------------------------- shared primitives
   Exported so project.ts's own sanitisers — `titleOf`, `transitionOf`, and the
   track-volume pass in `migrateProject` — keep using one implementation rather
   than acquiring a second copy on the way out of this refactor.               */

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Clamps into [lo, hi]. A non-number, NaN or Infinity takes the fallback. */
export const num = (v: unknown, fallback: number, lo: number, hi: number): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return v < lo ? lo : v > hi ? hi : v;
};

export const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === 'boolean' ? v : fallback;

/** '#rrggbb', lower-cased. Anything else takes the fallback. */
export const hex = (v: unknown, fallback: string): string =>
  typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.trim()) ? v.trim().toLowerCase() : fallback;

/**
 * THE choke point for clip properties. Every clip that survives `migrateProject`
 * has been through it, so nothing downstream has to ask whether `brightness`
 * exists.
 *
 * It also closes a hole that predates this feature: `validClip` only ever
 * checked that `properties` was an OBJECT, so a file with `"properties": {}`
 * already reached the graph and turned `scale` into `undefined` and then every
 * dimension into NaN. Nine new fields would have made that reachable by simply
 * opening a version-1 project, which is why the fill is total rather than
 * additive.
 *
 * TOTAL, and every caller must know it: unknown in, a COMPLETE `ClipProperties`
 * out, every absent key filled from the defaults. A caller holding a PARTIAL
 * patch must merge it onto the clip's existing properties BEFORE calling this,
 * or every field the user did not touch snaps back to unity.
 */
export function normalizeClipProperties(v: unknown): ClipProperties {
  const p = isObject(v) ? v : {};
  const d = DEFAULT_CLIP_PROPERTIES;
  return {
    scale: num(p.scale, d.scale, 0.01, 16),
    positionX: num(p.positionX, d.positionX, -100_000, 100_000),
    positionY: num(p.positionY, d.positionY, -100_000, 100_000),
    rotation: num(p.rotation, d.rotation, -180, 180),
    opacity: num(p.opacity, d.opacity, 0, 1),
    // Never 0: a zero speed is a division by zero in clipSourceLength and an
    // atempo chain that never terminates.
    speed: num(p.speed, d.speed, 0.1, 8),
    volume: num(p.volume, d.volume, 0, 2),
    brightness: num(p.brightness, d.brightness, -1, 1),
    contrast: num(p.contrast, d.contrast, 0, 3),
    // 1.8, not 3 — CREATIVE §2.5. Above 1.846 `colorchannelmixer` refuses the
    // whole filtergraph, so a higher value is not a stronger grade, it is a
    // failed export. A project saved before the narrowing clamps down to 1.8 on
    // load, which is the one place that can happen quietly and correctly.
    saturation: num(p.saturation, d.saturation, 0, 1.8),
    temperature: num(p.temperature, d.temperature, -100, 100),
    blur: num(p.blur, d.blur, 0, 50),
    sharpen: num(p.sharpen, d.sharpen, 0, 2),
    vignette: num(p.vignette, d.vignette, 0, 1),
    flipH: bool(p.flipH, d.flipH),
    flipV: bool(p.flipV, d.flipV),
  };
}

/** TOTAL, in the same sense and with the same caller obligation as above. */
export function subtitleStyleOf(v: unknown): SubtitleStyle {
  const s = isObject(v) ? v : {};
  const d = DEFAULT_SUBTITLE_STYLE;
  return {
    sizePct: num(s.sizePct, d.sizePct, 0.02, 0.2),
    color: hex(s.color, d.color),
    outline: num(s.outline, d.outline, 0, 4),
    marginPct: num(s.marginPct, d.marginPct, 0, 0.4),
  };
}
