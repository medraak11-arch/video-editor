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
const TAIL_CHARS = 7;

/** Split for middle truncation, so both head and tail stay readable. */
function splitName(name: string): { head: string; tail: string } {
  if (name.length <= TAIL_CHARS + 2) return { head: name, tail: '' };
  return { head: name.slice(0, name.length - TAIL_CHARS), tail: name.slice(-TAIL_CHARS) };
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
  const showName = paintWidth >= CLIP_MIN_LABEL_WIDTH;
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
  const { head, tail } = splitName(clip.name);
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

      {showName || showStateIcons ? (
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
          {showName ? (
            <span className="tl-clip-name type-label">
              <span className="tl-clip-name-head">{head}</span>
              <span className="tl-clip-name-tail">{tail}</span>
            </span>
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
