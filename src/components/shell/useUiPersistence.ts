/* ---------------------------------------------------------------------------
   useUiPersistence — PLAN §3.1. Shell-owned.

   Subscribes to the five persisted ui fields and writes ve.ui.v1, debounced
   200 ms. Mounted exactly once, from App.tsx.

   The subscription is a bare zustand listener, so it runs on every store write
   — including the rAF playhead commit at 60 Hz during playback. It therefore
   compares the five fields directly and returns before allocating anything in
   the overwhelmingly common case where none of them changed. Five identity
   comparisons per frame is free; an object allocation per frame is not
   (PLAN §1.3 rule 1).
--------------------------------------------------------------------------- */

import { useEffect } from 'react';
import { useEditorStore } from '../../state/store';
import { writePersistedUi } from '../../state/uiSlice';
import type { PersistedUi } from '../../state/uiSlice';

const DEBOUNCE_MS = 200;

export function useUiPersistence(): void {
  useEffect(() => {
    const initial = useEditorStore.getState();
    let last: PersistedUi = {
      theme: initial.theme,
      railWidth: initial.railWidth,
      railCollapsed: initial.railCollapsed,
      timelineHeightPct: initial.timelineHeightPct,
      inspectorGroups: initial.inspectorGroups,
    };

    let timer: number | null = null;

    const flush = () => {
      timer = null;
      writePersistedUi(last);
    };

    const unsubscribe = useEditorStore.subscribe((s) => {
      if (
        s.theme === last.theme &&
        s.railWidth === last.railWidth &&
        s.railCollapsed === last.railCollapsed &&
        s.timelineHeightPct === last.timelineHeightPct &&
        s.inspectorGroups === last.inspectorGroups
      ) {
        return;
      }

      last = {
        theme: s.theme,
        railWidth: s.railWidth,
        railCollapsed: s.railCollapsed,
        timelineHeightPct: s.timelineHeightPct,
        inspectorGroups: s.inspectorGroups,
      };

      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(flush, DEBOUNCE_MS);
    });

    return () => {
      unsubscribe();
      if (timer !== null) {
        window.clearTimeout(timer);
        // Landing the last change matters more than the debounce on teardown.
        writePersistedUi(last);
      }
    };
  }, []);
}
