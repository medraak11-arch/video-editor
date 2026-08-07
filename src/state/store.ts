/* ---------------------------------------------------------------------------
   store.ts — PLAN §1.3, verbatim.

   There is no context provider for state, no second store, no reducer, and no
   useReducer in a component that holds domain state.
--------------------------------------------------------------------------- */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { StoreState } from './types';
import { createUiSlice } from './uiSlice';
import { createMediaSlice } from './mediaSlice';
import { createPlaybackSlice } from './playbackSlice';
import { createTimelineSlice } from './timelineSlice';

export const useEditorStore = create<StoreState>()(
  subscribeWithSelector((...a) => ({
    ...createUiSlice(...a),
    ...createMediaSlice(...a),
    ...createPlaybackSlice(...a),
    ...createTimelineSlice(...a),
  })),
);

/** Non-reactive read, for pointer handlers and rAF loops. */
export const readStore = (): StoreState => useEditorStore.getState();
