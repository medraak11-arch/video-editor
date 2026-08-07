/* ---------------------------------------------------------------------------
   editorApi.ts — PLAN §1.1, verbatim.

   THE ABSOLUTE RULE: a renderer module never references window.editorAPI
   directly, never imports from 'electron', and never imports anything from
   'electron/'. It calls getEditorAPI().

   This module imports nothing outside src/types/**. In particular it must never
   import from src/dev/**: the fixture bridge is REGISTERED INTO this module at
   boot, which keeps the fixture project out of the production bundle and
   removes a real ESM value cycle.
--------------------------------------------------------------------------- */

import type { EditorAPI } from '../types/api';

let fallbackAPI: EditorAPI | null = null;

/** Called exactly once, from src/main.tsx, in dev when Electron is absent. */
export function registerFallbackAPI(api: EditorAPI): void {
  fallbackAPI = api;
}

export function isElectron(): boolean {
  return typeof window !== 'undefined' && window.editorAPI !== undefined;
}

export function getEditorAPI(): EditorAPI {
  const api = (typeof window !== 'undefined' && window.editorAPI) || fallbackAPI;
  if (!api) throw new Error('No editor API: registerFallbackAPI was not called before first use');
  return api;
}
