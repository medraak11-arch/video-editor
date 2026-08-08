/* ---------------------------------------------------------------------------
   PreviewWell — the largest, highest-contrast region in the app
   (PRODUCT.md principle 1). PLAN §8.1: no props, reads the store itself.

   It paints --surface-well, the darkest plane, and renders no Panel (PLAN §7.0):
   the well is not a panel, and the frame inside it is the brightest thing on
   screen. No border, no shadow, no radius on the video.

   It mounts usePlaybackClock() — the one rAF loop in the app that advances the
   playhead (PLAN §8.4) — and hands it the pooled <video> that is currently live.

   It also mounts useAudioMonitor(), which plays every OTHER audible clip on the
   timeline through AudioSurface's per-track <audio> pairs so that what the user
   hears while editing matches what the export renders (AUDIO-MONITOR.md). That
   engine adds no rAF loop of its own and never writes the playhead: it
   subscribes to the same clock, and reaches the elements through the registry
   created here.
--------------------------------------------------------------------------- */

import './preview.css';
import { useRef } from 'react';
import type { ReactElement } from 'react';
import { Transport } from './Transport';
import { VideoSurface } from './VideoSurface';
import { AudioSurface } from './AudioSurface';
import { usePlaybackClock } from './usePlaybackClock';
import { useAudioMonitor } from './useAudioMonitor';
import { createVoiceRegistry } from './audioMonitor';
import type { VoiceRegistry } from './audioMonitor';

export function PreviewWell(): ReactElement {
  const activeVideoRef = useRef<HTMLVideoElement | null>(null);
  const registryRef = useRef<VoiceRegistry>(createVoiceRegistry());
  usePlaybackClock(activeVideoRef);
  useAudioMonitor(activeVideoRef, registryRef);

  return (
    <section className="ve-preview" aria-label="Preview">
      <VideoSurface activeVideoRef={activeVideoRef} />
      <AudioSurface registryRef={registryRef} />
      <Transport />
    </section>
  );
}
