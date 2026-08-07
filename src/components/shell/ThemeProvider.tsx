/* ---------------------------------------------------------------------------
   ThemeProvider — PLAN §7.1. Shell-owned.

   Sets document.documentElement.dataset.theme from ui.theme and renders its
   children unchanged. Nothing else in the app touches dataset.theme.

   The FIRST write happens at module scope, from the same readPersistedUi() the
   ui slice reads its initial state from, so the very first paint is already in
   the persisted theme. Doing it in an effect meant at least one painted frame in
   the :root (signal) palette, which in `daylight` is a full-screen dark-to-light
   flash on every launch — exactly the at-rest visual noise PRODUCT.md's
   sustained-session comfort clause rules out. The layout effect below then
   tracks every later change, before paint rather than after it.

   There is no prefers-color-scheme branch: the theme is an explicit user choice
   with `signal` as the default, chosen from the titlebar Theme submenu.
--------------------------------------------------------------------------- */

import { useLayoutEffect } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useEditorStore } from '../../state/store';
import { readPersistedUi } from '../../state/uiSlice';

if (typeof document !== 'undefined') {
  document.documentElement.dataset.theme = readPersistedUi().theme;
}

export interface ThemeProviderProps {
  children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps): ReactElement {
  const theme = useEditorStore((s) => s.theme);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return <>{children}</>;
}
