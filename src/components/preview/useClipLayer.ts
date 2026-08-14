/* ---------------------------------------------------------------------------
   useClipLayer — everything a drawn clip layer needs, computed once.

   THE POINT OF THIS FILE IS THAT THERE IS NO SECOND COPY. Opacity, geometry,
   grade, effects and the transition ramp are the clip's, and they are the same
   for a pool <video>, a fixture still, a title canvas, a vignette and a dissolve
   underlay — because in the export they are the same: every one of those is an
   input that goes through the same clip chain before it is overlaid.

   A layer built from its own inline reading of `clip.properties` is how a layer
   ends up with the transform and without the filter, or with the fade and
   without the clamp. The defect that provoked this file was that exact shape
   one level up: a title drawn only when it happened to be the clock clip.
--------------------------------------------------------------------------- */

import { useCallback, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { Clip } from '../../types/model';
import { transitionGain } from '../../lib/color';
import { useEditorStore } from '../../state/store';
import { selectDissolveLength } from './dissolve';
import type { ClipFilterSpec } from './clipRender';
import { clipFilterSpec, cssFilterValue, frameTransform } from './clipRender';

/** Monotonic per module, so a filter id is never reissued to a second mount. */
let filterSerial = 0;

export interface ClipLayer {
  /** Opacity, transform and filter. Spread onto every element that draws the clip. */
  style: CSSProperties;
  /** Null when the clip is ungraded and unsharpened — emit NO <filter> element. */
  filterSpec: ClipFilterSpec | null;
  /** Unique per layer instance and per clip. Valid as a URL fragment. */
  filterId: string;
  /** The PICTURE ramp already folded into `style.opacity`, exposed for overlays. */
  pictureGain: number;
}

export function useClipLayer(clip: Clip | null, scaleToStage: number): ClipLayer {
  // Lazy, not `useRef(expr)`: a useRef initialiser is EVALUATED on every render
  // and its value discarded, which would advance the serial once per frame.
  const prefix = useRef<string | null>(null);
  if (prefix.current === null) prefix.current = `ve-layer-${(filterSerial += 1)}`;

  /*
    The dissolve's REAL length. A dissolve whose handle is shorter than the
    authored value is built SHORTER, not built long and cut off, so the alpha
    ramp has to run for the clamped length too — otherwise the picture would keep
    ramping for frames the underlay has already left, and the tail of every
    short-handled dissolve would fade against black in the preview and against
    footage in the file.

    0 covers both "not a dissolve" and "no handle at all"; the second degrades to
    a plain `fade` over the AUTHORED length (CREATIVE §4.3), which is why that
    case leaves the clip untouched below rather than shortening it.
  */
  const dissolveLength = useEditorStore(
    useCallback((s) => (clip ? selectDissolveLength(s, clip) : 0), [clip]),
  );

  const rampClip = useMemo(() => {
    if (!clip) return null;
    const t = clip.transitionIn;
    if (!t || t.kind !== 'dissolve' || dissolveLength === 0 || dissolveLength === t.frames) {
      return clip;
    }
    return { ...clip, transitionIn: { ...t, frames: dissolveLength } };
  }, [clip, dissolveLength]);

  /*
    CREATIVE §4.2 / §4.3a. `'video'` because this is the picture half; the sound
    half asks the same function with `'audio'` at the same frame, and the rule
    that separates them lives in that function and is not restated here.

    Exactly 1 for a clip with no transitions, so this subscription costs no
    render outside a ramp.
  */
  const pictureGain = useEditorStore(
    useCallback((s) => (rampClip ? transitionGain(rampClip, s.playhead, 'video') : 1), [rampClip]),
  );

  const filterSpec = clip ? clipFilterSpec(clip.properties) : null;
  const filterId = clip ? `${prefix.current}-${clip.id}` : prefix.current;

  const style: CSSProperties = clip
    ? {
        opacity: clip.properties.opacity * pictureGain,
        transform: frameTransform(clip.properties, scaleToStage),
        filter: cssFilterValue(clip.properties, filterId, filterSpec !== null, scaleToStage),
      }
    : {};

  return { style, filterSpec, filterId, pictureGain };
}
