/* ---------------------------------------------------------------------------
   Clip — the signature component, designed for 40 of them across 6 tracks.

   It subscribes to four primitives (its own record, selected, offline, warned)
   and re-renders only when one of them changes. It receives no object, array or
   function prop, so React.memo actually holds: a pointermove causes zero
   renders here — the drag layer writes transforms straight to the DOM and
   commits to the store once, on pointerup (PLAN §8.7).

   The degrade order is fixed (PLAN §7.6): the name and the thumbnail strip drop
   below 24 px of width, the state icon below 16 px, and the texture never drops
   at all — it is the only signal that still reads at 8 px.
--------------------------------------------------------------------------- */

import './timeline.css';
import { memo } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { EyeOff, Lock, TriangleAlert, Unplug, VolumeX } from 'lucide-react';
import type { ClipId, PxPerFrame } from '../../types/model';
import { useEditorStore } from '../../state/store';
import { framesToDuration, framesToPx } from '../../lib/time';
import {
  CLIP_MIN_HIT_WIDTH,
  CLIP_MIN_LABEL_WIDTH,
  CLIP_MIN_RENDER_WIDTH,
} from '../../lib/constants';

/** Below this the state icon drops too. The texture is what survives (PLAN §7.6). */
const CLIP_MIN_ICON_WIDTH = 16;
const STRIP_MAX_HEIGHT = 14;
const STRIP_MIN_LANE_HEIGHT = 30;

/* ---------------------------------------------------------- name truncation

   Middle truncation used to be two flex children — an ellipsising head and an
   unshrinkable tail. Under pressure the head collapsed to 0 px first and the
   clip rendered its tail alone: `Market, wide` became `t, wide`, and two clips
   on the same track could render the identical label. The head is the
   identifying part, so it is now reserved first and the string is cut here, in
   one text node, against the width the body actually has.

   The budget is analytic rather than measured: a per-clip DOM measurement would
   have to run on every zoom step for forty clips. The per-character figure is
   deliberately a shade wider than the 11 px label face measures (~5.5 px
   average), so the computed string under-fills its box; `.tl-clip-name` still
   carries `text-overflow: ellipsis` as the backstop for a name of unusually
   wide glyphs or a fallback font.                                            */

/** Average advance of one character at the 11 px label step, px. */
const LABEL_CHAR_PX = 6;
/** The ellipsis is roughly two characters wide, so it is reserved separately. */
const ELLIPSIS_PX = 10;
/** Clip chrome the name never gets: 1 px border + var(--space-xs) padding, both sides. */
const NAME_CHROME_PX = 10;
/** One 14 px state icon plus the var(--space-hair) gap that follows it. */
const ICON_SLOT_PX = 16;
/** Head characters held back before any tail is shown. Below this: head only. */
const MIN_HEAD_CHARS = 4;
/** A one- or two-character tail says nothing, so it is dropped rather than shown. */
const MIN_TAIL_CHARS = 3;
const MAX_TAIL_CHARS = 7;

/** The name as it fits in `textPx`, truncated from the middle. '' = no room at all. */
export function fitClipName(name: string, textPx: number): string {
  if (name.length * LABEL_CHAR_PX <= textPx) return name;
  const budget = Math.floor((textPx - ELLIPSIS_PX) / LABEL_CHAR_PX);
  if (budget < 1) return '';
  const tail = Math.min(MAX_TAIL_CHARS, budget - MIN_HEAD_CHARS);
  if (tail < MIN_TAIL_CHARS) return `${name.slice(0, budget)}…`;
  return `${name.slice(0, budget - tail)}…${name.slice(name.length - tail)}`;
}

export interface ClipProps {
  id: ClipId;
  zoom: PxPerFrame;
  laneHeight: number;
  trackLocked: boolean;
  trackMuted: boolean;
  /**
   * Track visibility is carried by an icon and a word rather than a fifth
   * texture: the encoding table in PLAN §7.6 closes at four, and inventing
   * another would collide with `muted` at a glance.
   */
  trackHidden: boolean;
  /** Roving tabindex: exactly one clip in the lane area is a tab stop. */
  focused: boolean;
}

export const Clip = memo(function Clip({
  id,
  zoom,
  laneHeight,
  trackLocked,
  trackMuted,
  trackHidden,
  focused,
}: ClipProps): ReactElement | null {
  const clip = useEditorStore((s) => s.clips[id]);
  const selected = useEditorStore((s) => s.selection.has(id));
  const offline = useEditorStore((s) => s.offlineClipIds.has(id));
  const fps = useEditorStore((s) => s.fps);
  const thumbnailUrl = useEditorStore((s) =>
    clip ? (s.items[clip.mediaId]?.thumbnailUrl ?? null) : null,
  );
  const warned = useEditorStore((s) =>
    clip ? (s.items[clip.mediaId]?.warnings.length ?? 0) > 0 : false,
  );

  if (!clip) return null;

  const paintWidth = Math.max(CLIP_MIN_RENDER_WIDTH, framesToPx(clip.duration, zoom));
  const tiny = paintWidth < CLIP_MIN_HIT_WIDTH;
  const showIcons = paintWidth >= CLIP_MIN_ICON_WIDTH;
  const stripHeight = Math.min(STRIP_MAX_HEIGHT, Math.round(laneHeight * 0.4));
  // DESIGN.md §5: below 24px the NAME drops and the strip remains. It occupies
  // the top ~40% only, so the texture underneath still reads at 8px of width.
  const showStrip =
    thumbnailUrl !== null &&
    laneHeight >= STRIP_MIN_LANE_HEIGHT &&
    stripHeight >= 8 &&
    paintWidth >= CLIP_MIN_HIT_WIDTH;

  // Texture first, icon second, hue third — and they stack when several apply.
  const textures: string[] = [];
  if (offline) textures.push('var(--texture-offline)');
  if (trackLocked) textures.push('var(--texture-locked)');
  if (trackMuted) textures.push('var(--texture-muted)');
  if (warned) textures.push('var(--texture-warning)');

  const style: CSSProperties = {
    left: `${framesToPx(clip.start, zoom)}px`,
    width: `${paintWidth}px`,
  };
  if (textures.length > 0) style.backgroundImage = textures.join(', ');

  const showStateIcons =
    showIcons && (offline || warned || trackLocked || trackMuted || trackHidden);
  // Two slots at most: one source-state glyph, one track-state glyph.
  const iconSlots = showStateIcons
    ? (offline || warned ? 1 : 0) + (trackLocked || trackMuted || trackHidden ? 1 : 0)
    : 0;
  // CLIP_MIN_LABEL_WIDTH gates on the clip's paint width; the icons then take a
  // further 16 px each out of the body, which is what used to leave 38-50 px clips
  // rendering a 0 px head. Both gates apply.
  const name =
    paintWidth >= CLIP_MIN_LABEL_WIDTH
      ? fitClipName(clip.name, paintWidth - NAME_CHROME_PX - iconSlots * ICON_SLOT_PX)
      : '';
  const duration = framesToDuration(clip.duration, fps);

  const states: string[] = [];
  if (offline) states.push('offline');
  if (trackLocked) states.push('track locked');
  if (trackMuted) states.push('track muted');
  if (trackHidden) states.push('track hidden');
  if (warned) states.push('format mismatch');
  const label = `${clip.name}, ${duration}${states.length > 0 ? `, ${states.join(', ')}` : ''}`;

  return (
    <div
      className="tl-clip"
      style={style}
      data-clip-id={id}
      data-selected={selected || undefined}
      data-offline={offline || undefined}
      data-tiny={tiny || undefined}
      role="option"
      aria-selected={selected}
      aria-label={label}
      tabIndex={focused ? 0 : -1}
    >
      {showStrip ? (
        <div
          className="tl-clip-strip"
          style={{ height: `${stripHeight}px`, backgroundImage: `url(${thumbnailUrl})` }}
          aria-hidden="true"
        />
      ) : null}

      {name !== '' || showStateIcons ? (
        <div className="tl-clip-body">
          {showStateIcons ? (
            <span className="tl-clip-icons" aria-hidden="true">
              {offline ? (
                <span data-tone="danger">
                  <Unplug size={14} strokeWidth={1.75} />
                </span>
              ) : null}
              {warned && !offline ? (
                <span data-tone="warning">
                  <TriangleAlert size={14} strokeWidth={1.75} />
                </span>
              ) : null}
              {trackLocked ? <Lock size={14} strokeWidth={1.75} /> : null}
              {trackMuted && !trackLocked ? <VolumeX size={14} strokeWidth={1.75} /> : null}
              {trackHidden && !trackLocked && !trackMuted ? (
                <EyeOff size={14} strokeWidth={1.75} />
              ) : null}
            </span>
          ) : null}
          {name !== '' ? (
            <span className="tl-clip-name type-label">{name}</span>
          ) : null}
        </div>
      ) : null}

      {paintWidth >= 12 ? (
        <>
          <span className="tl-clip-edge" data-edge="in" data-clip-edge={id} aria-hidden="true" />
          <span className="tl-clip-edge" data-edge="out" data-clip-edge={id} aria-hidden="true" />
        </>
      ) : null}
    </div>
  );
});
