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
import { AudioLines, EyeOff, Film, Lock, TriangleAlert, Unplug, VolumeX } from 'lucide-react';
import type { ClipId, PxPerFrame } from '../../types/model';
import { clipStreams } from '../../types/model';
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
  // [stable] — a string primitive, so React.memo still holds and a pointermove
  // still causes zero renders here.
  const streams = useEditorStore((s) => {
    const c = s.clips[id];
    return c ? clipStreams(c) : 'av';
  });
  // [stable] — a boolean primitive, so React.memo still holds and a pointermove
  // still causes zero renders here. Deliberately NOT the LinkId itself: the id is
  // a string that changes on every re-link, and nothing here uses its value.
  const linked = useEditorStore((s) => s.clips[id]?.linkId !== undefined);

  if (!clip) return null;

  const paintWidth = Math.max(CLIP_MIN_RENDER_WIDTH, framesToPx(clip.duration, zoom));
  const tiny = paintWidth < CLIP_MIN_HIT_WIDTH;
  const showIcons = paintWidth >= CLIP_MIN_ICON_WIDTH;
  const stripHeight = Math.min(STRIP_MAX_HEIGHT, Math.round(laneHeight * 0.4));
  // DESIGN.md §5: below 24px the NAME drops and the strip remains. It occupies
  // the top ~40% only, so the texture underneath still reads at 8px of width.
  // The strip is the MEDIA's thumbnail and the media is a video file, so an
  // audio-only clip would otherwise render video frames on an audio lane — the
  // interface asserting something false. Suppressing it is the third of §1.8's
  // four channels, and the widest one that is not the lane itself.
  const showStrip =
    thumbnailUrl !== null &&
    streams !== 'audio' &&
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

  // `streams !== 'av'` is what makes §1.8's icon channel exist at all: a
  // detached clip on an unlocked, unmuted, visible track whose media is online
  // and warning-free satisfies none of the other five, which is the normal case
  // and the one this feature is for.
  const showStateIcons =
    showIcons && (offline || warned || trackLocked || trackMuted || trackHidden || streams !== 'av');
  // Three slots at most: source-state, stream, track-state — counted in the
  // order they are rendered. The count is subtracted from fitClipName's budget
  // below, so an un-widened one is 16px too generous and truncates a name in the
  // middle instead of at its head.
  const iconSlots = showStateIcons
    ? (offline || warned ? 1 : 0) +
      (streams !== 'av' ? 1 : 0) +
      (trackLocked || trackMuted || trackHidden ? 1 : 0)
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
  if (streams === 'audio') states.push('audio only');
  if (streams === 'video') states.push('video only');
  // The word arrives in the accessible name at the moment focus lands on the
  // clip — BEFORE the selection expands — which is the right moment for it, and
  // it is the one channel that survives to zero width (docs/LINKING.md §8.3).
  if (linked) states.push('linked');
  if (warned) states.push('format mismatch');
  const label = `${clip.name}, ${duration}${states.length > 0 ? `, ${states.join(', ')}` : ''}`;

  return (
    <div
      className="tl-clip"
      style={style}
      data-clip-id={id}
      data-selected={selected || undefined}
      data-offline={offline || undefined}
      data-streams={streams === 'av' ? undefined : streams}
      data-linked={linked || undefined}
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
              {/* Names what the clip CONTAINS, not what it lacks: a negative
                  glyph on a clip that is working normally reads as an error,
                  and VolumeX already means "track muted" in this same strip.
                  No data-tone — this is what the clip is, not a status. */}
              {streams === 'audio' ? <AudioLines size={14} strokeWidth={1.75} /> : null}
              {streams === 'video' ? <Film size={14} strokeWidth={1.75} /> : null}
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
