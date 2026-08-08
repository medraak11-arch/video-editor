/* ---------------------------------------------------------------------------
   AudioSurface — the container for every track's pooled <audio> pair.
   docs/AUDIO-MONITOR.md §2.4.

   One AudioTrackVoice per id in `trackOrder`; a voice for a track with no clips
   renders nothing. The elements carry no `controls` attribute, so Chromium's UA
   stylesheet gives them `display: none` and they are neither visible nor
   focusable — and the wrapper is aria-hidden regardless, because there is
   nothing here for a screen reader to read.

   NO CSS IS ADDED. preview.css does not change, no token is introduced, and no
   accent is spent: §6 ships no new user-facing surface at all. The three
   controls this feature needs — master mute, per-track mute, per-clip volume —
   already exist, and until now two of them were partly lying.
--------------------------------------------------------------------------- */

import type { MutableRefObject, ReactElement } from 'react';
import { useEditorStore } from '../../state/store';
import { AudioTrackVoice } from './AudioTrackVoice';
import type { VoiceRegistry } from './audioMonitor';

export interface AudioSurfaceProps {
  registryRef: MutableRefObject<VoiceRegistry>;
}

export function AudioSurface({ registryRef }: AudioSurfaceProps): ReactElement {
  // [stable] `trackOrder` is reallocated only on addTrack / removeTrack.
  const trackOrder = useEditorStore((s) => s.trackOrder);

  return (
    <div aria-hidden="true" data-audio-surface="">
      {trackOrder.map((trackId) => (
        <AudioTrackVoice key={trackId} trackId={trackId} registryRef={registryRef} />
      ))}
    </div>
  );
}
