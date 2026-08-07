/* ---------------------------------------------------------------------------
   PreviewWell — the largest, highest-contrast region in the app
   (PRODUCT.md principle 1). PLAN §8.1: no props, reads the store itself.

   It paints --surface-well, the darkest plane, and renders no Panel (PLAN §7.0):
   the well is not a panel, and the frame inside it is the brightest thing on
   screen. No border, no shadow, no radius on the video.

   It mounts usePlaybackClock() — the one rAF loop in the app that advances the
   playhead (PLAN §8.4) — and hands it the pooled <video> that is currently live.
--------------------------------------------------------------------------- */

import './preview.css';
import { useRef } from 'react';
import type { ReactElement } from 'react';
import { Transport } from './Transport';
import { VideoSurface } from './VideoSurface';
import { usePlaybackClock } from './usePlaybackClock';

export function PreviewWell(): ReactElement {
  const activeVideoRef = useRef<HTMLVideoElement | null>(null);
  usePlaybackClock(activeVideoRef);

  return (
    <section className="ve-preview" aria-label="Preview">
      <VideoSurface activeVideoRef={activeVideoRef} />
      <Transport />
    </section>
  );
}
