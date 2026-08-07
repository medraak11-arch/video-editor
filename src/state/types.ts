/* ---------------------------------------------------------------------------
   state/types.ts — PLAN §1.3.

   One zustand store, composed from four slice creators, one file per domain.
   Because it is one store, a slice creator's get() returns the WHOLE StoreState:
   that is the sanctioned cross-slice read mechanism. A slice must never mutate
   another slice's state directly — it calls that slice's action.

   These types are deliberately circular; import them with `import type`.
--------------------------------------------------------------------------- */

import type { StateCreator } from 'zustand';
import type { UiSlice } from './uiSlice';
import type { MediaSlice } from './mediaSlice';
import type { PlaybackSlice } from './playbackSlice';
import type { TimelineSlice } from './timelineSlice';

export type StoreState = UiSlice & MediaSlice & PlaybackSlice & TimelineSlice;

/** Every slice file exports `create<Name>Slice: SliceCreator<NameSlice>`. */
export type SliceCreator<T> = StateCreator<
  StoreState,
  [['zustand/subscribeWithSelector', never]],
  [],
  T
>;
