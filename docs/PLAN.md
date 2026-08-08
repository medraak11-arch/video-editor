# Implementation plan — Video Editor

**Status:** normative. This document is the integration contract between five parallel slices.
Where this plan and a slice brief disagree on a *name, type, or channel*, this plan wins — report
the conflict rather than diverging. Where they disagree on *visual behaviour*, `DESIGN.md` wins,
**except** at the four points listed immediately below, where `DESIGN.md` is internally
contradictory or collides with an accessibility floor in `PRODUCT.md`. At those four points this
plan is the resolution and supersedes `DESIGN.md`. Do not re-litigate them in code.

| # | `DESIGN.md` text | Resolution (this plan wins) |
|---|---|---|
| S1 | §2 "The Three Uses Rule … A fourth use is a bug." vs §5 track heads "Active toggles take the accent." | §7.4: the accent has **four families** and **six enumerated uses**. Six is the ceiling. |
| S2 | §5 Buttons "Focus-visible: 2px accent ring at 2px offset" vs §5 Timeline clips "outline-offset: -1.5px" | §5 state table: `+2px` everywhere **except** timeline clips and track heads, which focus **inset**. |
| S3 | §4 The Audit Test "fix the step, don't add the border" | §7.5: `PRODUCT.md`'s 3:1 non-text floor outranks it. Clip edges and lane boundaries carry a 1px `--border-structural`. |
| S4 | §5 Buttons "Disabled: 50 % opacity" (implied by the dark-UI warning) | §5 state table: disabled is token-based, never opacity-based, and requires a `disabledReason`. |

Read order for every agent: `PRODUCT.md` → `DESIGN.md` → this file → your own slice brief.

---

## 0. File ownership map

Nobody creates, edits or deletes a file outside their own list. If you need a change elsewhere,
report it as a required integration change in your final message.

| Owner | Files |
|---|---|
| **scaffold** | `package.json`, `tsconfig*.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/styles/tokens.css`, `src/styles/base.css`, `src/types/model.ts`, `src/types/api.ts`, `src/lib/**`, `src/state/store.ts`, `src/state/types.ts`, `src/components/ui/**`, `src/dev/fixtures.ts`, `electron/main.ts`, `electron/preload.ts` |
| **shell** | `src/App.tsx`, `src/components/shell/**` (incl. `ThemeProvider.tsx`), `src/state/uiSlice.ts` |
| **media** | `src/components/media/**`, `src/state/mediaSlice.ts`, `electron/ipc/media.ts` |
| **preview** | `src/components/preview/**`, `src/state/playbackSlice.ts` |
| **timeline** | `src/components/timeline/**` (incl. `TimelineToolbar.tsx`), `src/state/timelineSlice.ts` |
| **inspector** | `src/components/inspector/**`, `src/components/export/**`, `src/keyboard/**`, `electron/ipc/project.ts` |

### 0.1 The t0 handoff — how five slices compile before any of them is finished

Scaffold's own deliverable imports four slice files it does not own and two IPC modules it does not
own. Symmetrically, §9 requires every slice to boot under `npm run dev:web` with the full fixture
project, which needs all four hydrate actions. Neither is satisfiable if the files simply do not
exist. Therefore:

**At t0, scaffold creates — once — a complete-signature placeholder for each of these six files:**

```
src/state/uiSlice.ts        src/state/mediaSlice.ts
src/state/playbackSlice.ts  src/state/timelineSlice.ts
electron/ipc/media.ts       electron/ipc/project.ts
```

A placeholder is **not** a stub interface. It must:

- export every type, constant, selector, creator and action name this document declares, with the
  exact declared signature — so `tsc --noEmit` is clean for everyone from minute one;
- carry a correct, non-empty **initial state** (`fps: 30`, `width: 1920`, `height: 1080`,
  `playhead: 0`, `items: {}`, `order: []`, `tracks: {}`, `trackOrder: []`, `clips: {}`,
  `clipsByTrack: {}`, `markers: {}`, `selection: EMPTY_SELECTION`,
  `history: { past: [], future: [] }`, `historyTxn: null`, `offlineClipIds: new Set()`, the §7.3
  layout defaults);
- implement the **hydrate actions for real** (`hydrateUi`, `hydratePlayback`, `hydrateMedia`,
  `hydrateTimeline`) — plain `set()` of the incoming data plus the `clipsByTrack` rebuild — because
  `bootstrapFixtures()` depends on them and nothing else does;
- implement every other action as a body that `console.warn`s once with its own name and returns
  the declared type's neutral value (`{ ok: true }`, `null`, `undefined`, `''`). Never `throw`.

**Handoff rule.** The moment those six files exist and `tsc --noEmit` is clean, scaffold commits
them (commit message `chore: slice placeholders — handoff`) and **never touches them again**. From
that commit forward each file has exactly one editor: its owner from the table above. If scaffold
later needs a change inside a slice file, it reports it — it does not re-write the file. A slice
that finds a placeholder body still present in a file it owns replaces it; a slice that finds a
placeholder in a file it does **not** own leaves it alone and reports the gap.

### 0.2 Escalation protocol for the shared scaffold files

`src/types/model.ts`, `src/types/api.ts`, `src/lib/project.ts`, `src/lib/constants.ts` and
`src/styles/tokens.css` are cross-cutting: every slice reads them and only scaffold writes them.
`serializeProject` in particular hard-codes all four slices' state shapes, so any field a slice adds
to persisted state requires a scaffold edit.

Protocol: a slice that needs a field, token, constant or channel added **states the exact
declaration it needs in its final message** and codes against it as if it existed (it will fail
`tsc` — that is the signal). It must not patch around the gap locally, must not add a parallel
constant in its own file, and must not add a custom property. Scaffold is the only editor.

Global conventions, no exceptions:

- **Named exports only.** No `export default` anywhere. Cross-slice imports resolve by name.
- **`import type`** for every type-only import (the store types are deliberately circular).
- One component per file, file name equals component name.
- Every `.tsx` file that renders a surface imports no colour literal, ever. `grep -nE
  '#[0-9a-fA-F]{3,8}|rgba?\(|oklch\(|hsl\(' src/` must return zero hits outside
  `src/styles/tokens.css`.

---

## 1. Architecture

### 1.1 Process model

```
electron/main.ts        main process. BrowserWindow({ frame: false, titleBarStyle: 'hidden',
                        webPreferences: { preload, contextIsolation: true, nodeIntegration: false,
                        sandbox: false } }). Registers the ve-media protocol (§1.4), calls
                        registerMediaIpc(ipcMain) and registerProjectIpc(ipcMain) at startup.
                        Owns the only child_process spawn.
electron/preload.ts     contextBridge.exposeInMainWorld('editorAPI', api). The api object is a
                        thin, typed wrapper over ipcRenderer.invoke / .on, plus the one
                        preload-only call webUtils.getPathForFile. No logic, no fs, no
                        child_process. Implements src/types/api.ts exactly.
src/**                  renderer. Plain React 18 + Vite. Runs headless-of-Electron under
                        `npm run dev:web`.
electron/ipc/*.ts       main-process handlers. May use node builtins freely.
```

**The absolute rule:** a renderer module never references `window.editorAPI` directly, never
imports from `electron`, and never imports anything from `electron/`. It calls
`getEditorAPI()` from `src/lib/editorApi.ts`, which returns the real bridge or the registered
fallback bridge. A component that touches `window.` for anything except `localStorage`,
`matchMedia`, `requestAnimationFrame` and DOM APIs is a bug.

`src/lib/**` must contain **no import from `src/dev/**`**, in either direction of the graph. The
fixture bridge is *registered into* `editorApi.ts` at boot; it is never imported by it. This keeps
the 41-clip fixture project and its data-URI thumbnails out of the production bundle, and removes a
real ESM value cycle (`editorApi → fixtures → project → store → mediaSlice → editorApi`).

```ts
// src/lib/editorApi.ts  (scaffold) — imports nothing outside src/types/**
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
```

```tsx
// src/main.tsx  (scaffold)
async function boot() {
  if (!isElectron()) {
    const dev = await import('./dev/fixtures');   // dynamic: tree-shaken out of the Electron build
    registerFallbackAPI(dev.fixtureAPI);
    dev.bootstrapFixtures();
  }
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
}
void boot();
```

Nothing branches on `isElectron()` except (a) `boot()` above, (b) the titlebar window controls,
which hide in the browser, and (c) `VideoSurface`'s playable-source check (§4.4).

### 1.2 Build / scripts

`package.json` fields that are part of this contract:

```json
{
  "main": "dist-electron/electron/main.js",
  "type": "module",
  "scripts": {
    "dev:web": "vite",
    "dev": "concurrently -k \"vite\" \"tsc -p tsconfig.electron.json -w --preserveWatchOutput\" \"wait-on dist-electron/electron/main.js http://localhost:5173 && cross-env ELECTRON=1 VITE_DEV_SERVER_URL=http://localhost:5173 electron .\"",
    "build": "tsc -b && vite build && tsc -p tsconfig.electron.json",
    "start": "electron ."
  }
}
```

`"type": "module"` governs `src/**` (Vite/ESM). The electron output is CommonJS, so
`dist-electron/package.json` is written once by scaffold containing exactly `{"type":"commonjs"}`
— this is the standard, and required, way to run a CJS preload under a `"type":"module"` root.
The preload **must** be CommonJS: with `contextIsolation: true` and `sandbox: false`, Electron
loads the preload as CJS and an ESM preload fails silently, leaving `window.editorAPI` undefined
and the app running in fixture mode inside Electron — a failure that looks like a data bug.

`tsconfig.electron.json`, pinned:

```jsonc
{
  "compilerOptions": {
    "module": "commonjs",          // preload with contextIsolation:true + sandbox:false must be CJS
    "moduleResolution": "node",
    "target": "ES2022",
    "outDir": "dist-electron",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": false
  },
  "include": ["electron/**/*.ts", "src/types/api.ts", "src/types/model.ts"]
}
```

**Emitted layout is normative** — three agents reference these paths and they must not drift:

| Source | Emitted |
|---|---|
| `electron/main.ts` | `dist-electron/electron/main.js` |
| `electron/preload.ts` | `dist-electron/electron/preload.js` |
| `electron/ipc/media.ts` | `dist-electron/electron/ipc/media.js` |
| `electron/ipc/project.ts` | `dist-electron/electron/ipc/project.js` |
| `src/types/api.ts` | `dist-electron/src/types/api.js` |

`rootDir` is the **repo root** and both `electron/**` and the two shared type modules are compiled
into `dist-electron`, preserving the source tree beneath it. That is what makes
`import { CH } from '../src/types/api'` — a **value** import, not a type import — resolve identically
at compile time and at runtime in `dist-electron`. `src/types/api.ts` and `src/types/model.ts` are
the only two renderer files the electron build compiles; they contain no React, no DOM and no node
imports, which is why they can be shared. Any other `src/**` import from `electron/**` is a bug.

Consequently:

```json
{ "main": "dist-electron/electron/main.js" }
```

and the `dev` script waits on that path. `__dirname` inside the emitted `main.js` is
`dist-electron/electron`, so `preload.js` is its sibling and the built renderer is two levels up.

Main process window creation, both branches stated:

```ts
const preload = path.join(__dirname, 'preload.js');            // dist-electron/preload.js
const devUrl = process.env.VITE_DEV_SERVER_URL;                 // 'http://localhost:5173' in dev
if (devUrl) win.loadURL(devUrl);
else win.loadFile(path.join(__dirname, '../dist/index.html'));  // vite build output
```

Dependencies (scaffold installs; no slice adds one without reporting it):
`react@^18`, `react-dom@^18`, `zustand@^5`, `lucide-react`, `@fontsource/inter`,
`@fontsource-variable/jetbrains-mono`, `electron@^33`, `vite@^5`, `@vitejs/plugin-react`,
`typescript@^5`, `concurrently`, `wait-on`, `cross-env`. Fonts are bundled, never fetched from a
CDN. Electron is pinned at **major 33** because `File.path` was removed in 32 and the replacement
`webUtils.getPathForFile` is assumed present (§4.2).

**ffmpeg / ffprobe are NOT dependencies.** Both are resolved via `spawn`, and nothing links against
them. `MediaErrorCode = 'ffmpeg-missing'` therefore stays a reachable, meaningful state rather than
dead code. The exact invocations and the `ProbeData` field mapping are pinned in §4.3 so main and
the fixture bridge cannot disagree.

> **Amended by packaging.** This paragraph originally said resolution happens on `PATH` and that
> bundling was out of scope. PATH-only is correct for a repo and wrong for an installer: it means
> the shipped app works on the machine that built it and on no other. Resolution now lives in
> **`electron/ffmpeg.ts`** — the bundled copy at `<resources>/ffmpeg/` in a packaged build, `PATH`
> in development, with `PATH` as the fallback in both. The dependency list is still unchanged: the
> named follow-up `ffmpeg-static` is still **not** added, and `scripts/stage-ffmpeg.mjs` copies the
> binaries the build machine already has rather than pulling a package. `npm run dist:nobundle`
> builds the PATH-only variant this paragraph described.

### 1.3 State

One zustand store, composed from four slice creators, one file per domain. There is no context
provider for state, no second store, no reducer, no `useReducer` in a component that holds
domain state.

```ts
// src/state/types.ts  (scaffold)
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
```

```ts
// src/state/store.ts  (scaffold)
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
export const readStore = () => useEditorStore.getState();
```

Because it is one store, a slice creator's `get()` returns the **whole** `StoreState`. That is
the sanctioned cross-slice read mechanism. Slice files may import *selectors and types* from one
another (`import { selectTimelineDurationFrames } from './timelineSlice'`), but must never
mutate another slice's state directly — call that slice's action.

#### The playhead transport decision (normative, one answer only)

**The playhead lives in the store.** `playbackSlice.playhead` is committed by the rAF clock at up to
one write per animation frame during playback. There is no shadow channel, no ref-based playhead, no
"commit on pause". §8.3 and §8.4 depend on this and nothing overrides it.

That decision is only survivable because of the four rules below, which are the real content of the
"40 clips × 6 tracks" requirement. They replace the earlier blanket "anything changing at frame rate
is not React state".

1. **Selector cost ceiling.** A selector passed to `useEditorStore(…)` must be O(1) or O(log n),
   must not allocate, and must return a primitive or a reference that is stable across unrelated
   writes. `s.playhead`, `s.selection.has(id)`, `s.clipsByTrack[t]` all qualify.
   `s.order.map(…)`, `ids.map(id => s.clips[id])`, `.filter(…)` do not — at 60 store writes per
   second an allocating selector re-renders its component 60 times per second under zustand's
   default `Object.is`.
2. **Every array-returning selector in §3 is marked `UNSTABLE REFERENCE`.** Those are legal from
   `readStore()` inside a pointer handler or a rAF body, and legal inside
   `useEditorStore(useShallow(…))` *when the array is small and changes rarely*. They are illegal
   as a bare hook selector. Where a hot path needed one, §3 publishes a stable id-returning
   primitive beside it (`selectVideoClipIdAtFrame`, `selectClipIdsInTrack`).
3. **Nothing that moves with the playhead is a React render.** The timeline playhead line, its
   ruler head, and the scroll transform of the lane content are positioned imperatively through
   `useEditorStore.subscribe(sel, cb)` writing `element.style.transform`. The playhead's own
   component renders once, on mount. The only components permitted to *render* on a playhead change
   are the transport timecode read-out and `VideoSurface` — and `VideoSurface` subscribes to
   `selectVideoClipIdAtFrame`, a `ClipId | null`, so it renders on clip boundaries, not on frames.
4. **Pointer-rate values are still not store state.** Drag offsets, scrub deltas, marquee rects and
   resize widths live in refs and are written to `style.transform` / `style.width`; they commit to
   the store once, on `pointerup`. `useSyncExternalStore` is already inside zustand; do not add a
   second subscription layer.

### 1.4 The `ve-media://` protocol

A `file://` URL cannot be loaded by a renderer served from `http://localhost:5173` — `webSecurity`
blocks it, and disabling `webSecurity` is not an option. So the main process serves media over a
privileged custom scheme, and **`ve-media://` is the only form `MediaItem.url` and
`MediaItem.thumbnailUrl` ever take in the Electron path.**

```ts
// electron/main.ts  (scaffold) — BEFORE app.whenReady()
protocol.registerSchemesAsPrivileged([{
  scheme: 've-media',
  privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: false },
}]);

// after app.whenReady()
protocol.handle('ve-media', (request) => {
  const u = new URL(request.url);                       // ve-media://file/<encodeURIComponent(abs)>
  if (u.host !== 'file') return new Response(null, { status: 400 });
  const abs = decodeURIComponent(u.pathname.replace(/^\//, ''));
  return net.fetch(pathToFileURL(abs).toString());      // supports Range, so <video> can seek
});
```

`stream: true` is what makes `<video>` seekable; without it the element downloads the whole file
before it can play. The URL builder is a pure string function and is stated once, in §4.3, so
`electron/ipc/media.ts` (media) and `electron/main.ts` (scaffold) cannot drift:

```ts
const mediaUrlForPath = (abs: string) => `ve-media://file/${encodeURIComponent(abs)}`;
```

No allowlist is maintained. The renderer loads no remote content, `nodeIntegration` is off, and the
scheme is not CORS-enabled, so only this app's own origin can fetch it.

In the browser (`npm run dev:web`) the scheme does not exist. Fixture media therefore carry
`url: ''`, which §4.4 defines as *not playable*, and a `data:` `thumbnailUrl`.

---

## 2. The shared data model

`src/types/model.ts` (scaffold). Reproduced here verbatim — this is the file's contents.

### 2.1 Time

**Time is stored in whole frames, as integers, everywhere in the store, without exception.**
Seconds and timecode exist only at the edges: the `<video>` element, ffprobe output, and text
the user reads. There is exactly one conversion point, `state.fps` (the project frame rate).

```ts
/** Whole frames at the project fps. Always an integer. Never negative for a timeline position. */
export type Frames = number;
/** Real seconds. Only ever at an edge: <video>.currentTime, ffprobe, export duration. */
export type Seconds = number;
/** Timeline pixels per frame. The single zoom unit. */
export type PxPerFrame = number;
```

Helpers live in `src/lib/time.ts` (scaffold). These signatures are final:

```ts
export function framesToSeconds(frames: Frames, fps: number): Seconds;
export function secondsToFrames(seconds: Seconds, fps: number): Frames;   // Math.round
export function framesToTimecode(frames: Frames, fps: number): string;    // "HH:MM:SS:FF"
export function timecodeToFrames(tc: string, fps: number): Frames | null; // null = invalid
export function framesToDuration(frames: Frames, fps: number): string;    // "1:23" / "1:02:03"
export function clampFrames(f: Frames, min: Frames, max: Frames): Frames;
export function framesToPx(frames: Frames, zoom: PxPerFrame): number;
export function pxToFrames(px: number, zoom: PxPerFrame): Frames;         // Math.round
/** No rounding. For zoom anchoring and any accumulating maths — see §3.4 zoomAround. */
export function pxToFramesExact(px: number, zoom: PxPerFrame): number;
export function snapToFrame(f: number): Frames;                           // Math.round, >= 0
/** The one rounding rule for second-sized jumps. Preview and inspector both call this. */
export function secondStepFrames(fps: number): Frames;                    // Math.round(fps)
```

`pxToFrames` is `Math.round(pxToFramesExact(...))`. **Never use `pxToFrames` inside an accumulating
calculation** — at `ZOOM_MIN` one pixel is 50 frames and rounding drift is immediately visible.
`zoomAround` and any pointer-anchored maths use `pxToFramesExact` and round exactly once, at the end.

`timecodeToFrames` accepts `HH:MM:SS:FF`, `MM:SS:FF`, `SS:FF` and bare `FF`, tolerates `.` or
`;` as the frame separator, and returns `null` (not `NaN`, not `0`) on anything else. Fields
`MM`/`SS` ≥ 60 and `FF` ≥ fps are invalid, not wrapped. Frame rates are stored as the exact
decimal (`23.976`, `29.97`); timecode is non-drop-frame — `FF` counts `0 … ceil(fps)-1`.

### 2.2 Ids

```ts
export type MediaId = string;   // 'm_' + nanoid
export type ClipId = string;    // 'c_' + nanoid
export type TrackId = string;   // 't_' + nanoid
export type MarkerId = string;  // 'k_' + nanoid
```
`src/lib/id.ts` exports `newId(prefix: 'm' | 'c' | 't' | 'k'): string`. Never derive an id from
an index or a path.

### 2.3 Media

```ts
export type MediaKind = 'video' | 'audio';
export type MediaStatus = 'probing' | 'ready' | 'error';

export type MediaErrorCode =
  | 'not-found'          // file disappeared or path unreadable
  | 'unsupported-codec'  // probed fine, we cannot decode it
  | 'probe-failed'       // ffprobe returned non-zero / unparseable
  | 'ffmpeg-missing'     // binary not on PATH
  | 'cancelled';

export interface MediaError {
  code: MediaErrorCode;
  /** One sentence, sentence case, no trailing period, safe to show verbatim. */
  message: string;
}

/** Non-fatal. The item is usable; something about it will bite later. */
export type MediaWarningCode = 'fps-mismatch' | 'resolution-mismatch';
export interface MediaWarning {
  code: MediaWarningCode;
  message: string;     // sentence case, no trailing period
}

export interface MediaItem {
  id: MediaId;
  /** Absolute filesystem path. In the browser fixture, a plausible pseudo-path. */
  path: string;
  /** Playable source for <video src>. 've-media://…' in Electron. Empty string = not playable. */
  url: string;
  /** Basename including extension. */
  name: string;
  kind: MediaKind;
  status: MediaStatus;
  error: MediaError | null;
  /** Non-fatal notes. Empty array when clean. Drives the warning treatment (§7.6). */
  warnings: MediaWarning[];
  /** 0..1, meaningful only while status === 'probing'. */
  progress: number;
  /** Source duration converted to project frames. 0 until ready. */
  durationFrames: Frames;
  /** Native duration in seconds, as probed. */
  durationSeconds: Seconds;
  /** Native pixel dimensions. 0 for audio-only. */
  width: number;
  height: number;
  /** Native frame rate. 0 for audio-only. */
  fps: number;
  codec: string;
  hasAudio: boolean;
  /** 've-media://…' (Electron) or 'data:…' (fixture). null when none could be extracted. */
  thumbnailUrl: string | null;
  addedAt: number;   // Date.now()
}

/** What actually goes in a .veproj. Runtime-only fields are dropped — see §2.6. */
export type PersistedMediaItem =
  Omit<MediaItem, 'url' | 'status' | 'progress' | 'error' | 'warnings' | 'thumbnailUrl'>;
```

`durationFrames` is recomputed from `durationSeconds` whenever the project fps changes. The
recompute lives in `mediaSlice` as `recomputeMediaDurations(fps)`, and `playbackSlice` is the
caller: `setProjectFps` and `adoptSourceFormat` both invoke `get().recomputeMediaDurations(fps)`
and then `get().clampClipsToSource()` after writing the new rate. No subscription, no effect — an
explicit call, so the ordering is readable (§3.2, §3.3).

### 2.4 Clips, tracks, markers

```ts
export interface ClipProperties {
  scale: number;      // 1 = 100%
  positionX: number;  // px in project-resolution space, 0 = centred
  positionY: number;
  rotation: number;   // degrees, -180..180
  opacity: number;    // 0..1
  speed: number;      // 1 = 100%, 0.1..8, never 0
  volume: number;     // 0..2, 1 = unity
}

export const DEFAULT_CLIP_PROPERTIES: ClipProperties = {
  scale: 1, positionX: 0, positionY: 0, rotation: 0, opacity: 1, speed: 1, volume: 1,
};

export interface Clip {
  id: ClipId;
  mediaId: MediaId;
  trackId: TrackId;
  /** Timeline frame of this clip's first frame. Inclusive. >= 0. PROJECT frames. */
  start: Frames;
  /** Length on the timeline. >= 1. PROJECT frames. */
  duration: Frames;
  /** Offset into the source of this clip's first frame. >= 0. PROJECT frames (see below). */
  mediaIn: Frames;
  /** Display name. Defaults to the media name; user-renameable later. */
  name: string;
  properties: ClipProperties;
}

/** Exclusive end. There is no `end` field — derive it, always, with this helper. */
export const clipEnd = (c: Clip): Frames => c.start + c.duration;

/** Source frames this clip consumes. THE source-mapping primitive — see the invariant below. */
export const clipSourceLength = (c: Clip): Frames =>
  Math.round(c.duration * c.properties.speed);
```

#### The source-mapping invariant (normative; restated verbatim in §8.4)

Three slices map timeline position onto source position and they must produce the same number.

1. **`start`, `duration` and `mediaIn` are all in PROJECT frames.** `MediaItem.fps` is the *native*
   rate and is informational only — it is never used to convert a clip field. The conversion from
   native duration to project frames happens exactly once, in
   `recomputeMediaDurations`, which writes `MediaItem.durationFrames`. Every frame calculation
   downstream reads `durationFrames`; **no frame calculation anywhere may read `MediaItem.fps` or
   `MediaItem.durationSeconds`.** (Those two fields are still *displayed*, and `fps` is compared
   against the project rate to raise a `fps-mismatch` warning — that is a comparison, not a
   conversion.)

2. **Source bound:** `mediaIn + clipSourceLength(clip) <= media.durationFrames`, always. Every
   action that can violate it — `addClip`, `insertMediaAt`, `trimClip`, and `updateClipProperties`
   when the patch contains `speed` — checks it and **fails** with `reason: 'no-source'` rather than
   clamping silently. `clampClipsToSource` is the one exception and the only place a clip is
   shortened without the user asking: it runs after an fps change has moved `durationFrames` under
   existing clips, shortens each offending clip's `duration` to
   `max(1, floor((media.durationFrames - mediaIn) / speed))`, marks any clip whose `mediaIn` now
   sits past the end of its source as offline, and returns the count so `setProjectFps` can report
   it (§3.3).

3. **Playback mapping** — the only expression permitted, used by `VideoSurface` and by nothing else:

```ts
const clipFrame = playhead - clip.start;                            // 0 .. duration-1
const sourceFrame = clip.mediaIn + clipFrame * clip.properties.speed;
video.currentTime = framesToSeconds(sourceFrame, state.fps);        // project fps, not media.fps
video.playbackRate = clip.properties.speed * Math.abs(state.rate);  // never negative; see §8.4
```

4. **Changing `speed` rescales `duration`.** Source consumption is held constant, so
   `nextDuration = Math.max(1, Math.round(duration * oldSpeed / newSpeed))`. This means
   `updateClipProperties` is *not* a pure property write when the patch contains `speed`: it moves
   the clip's out edge, so it runs the same overlap and source checks as `trimClip` and returns a
   `MutationResult` (§3.4). A speed change that would overlap the next clip fails whole; it never
   overwrites a neighbour and never leaves a clip pointing past the end of its source.

There is no `mediaOut` field. `mediaIn + clipSourceLength(c)` is the out point; deriving it is the
only correct way to read it.

```ts
export interface Track {
  id: TrackId;
  kind: MediaKind;
  /** Monotonic within kind, 1-based. Drives the label. NEVER renumbered — see below. */
  index: number;
  /** 'V1' | 'A2'. The ONLY uppercase strings in the UI. */
  label: string;
  /** Lane height in px. THE runtime source of truth for lane geometry. */
  height: number;
  muted: boolean;
  locked: boolean;
  visible: boolean;
}

export interface Marker {
  id: MarkerId;
  frame: Frames;
  label: string;   // may be ''
}
```

No `color` on `Marker` and no `color` on `Clip`. Hue is not a user-assignable dimension in this
build; adding one would break the accent budget.

**`Track.height` has exactly one source of truth: the `Track` record.** `TRACK_HEIGHT_VIDEO` /
`TRACK_HEIGHT_AUDIO` in `src/lib/constants.ts` are **seed defaults only**, read once by `addTrack`
and by `hydrateTimeline`'s default track set. There are no `--track-height-*` CSS custom properties
— they were removed precisely so the three could not disagree. Lane geometry is inline style driven
by `Track.height`, and `selectLaneTop` / `selectLaneHeight` sum `Track.height`. `setTrackHeight(id,
px)` exists (clamped `TRACK_HEIGHT_MIN..TRACK_HEIGHT_MAX`) even though no UI calls it in this build,
so the field can never become a lie.

#### Track order and numbering

`trackOrder: TrackId[]`, index 0 = topmost lane. Video tracks always sort above audio tracks. `V1`
is the *bottom-most* video track (NLE convention): higher video index composites on top, so
`trackOrder` for `V2, V1, A1, A2` is exactly that.

**Track labels are a user-visible contract and never change once assigned.** Therefore:

- `addTrack('video')` inserts the new track at **`trackOrder` index 0** (the top) and gives it
  `index = maxVideoIndex + 1`. Existing video tracks keep their index, their label and their lane.
- `addTrack('audio')` **appends** to `trackOrder` and gives the new track
  `index = maxAudioIndex + 1`.
- `removeTrack` removes the id from `trackOrder` and **does not renumber anything.** Indices are
  monotonic, not dense: after removing `V2` from `V3 V2 V1` the remaining labels stay `V3` and `V1`.

The earlier "insert directly above the first audio track" rule is withdrawn: it made every new video
track `V1`, renumbered every existing video track, and made clips appear to jump lanes.

### 2.5 Selection

```ts
/** Immutable. Every mutation allocates a new Set so referential equality means "unchanged". */
export type Selection = ReadonlySet<ClipId>;
export const EMPTY_SELECTION: Selection = new Set<ClipId>();
```

Selection contains clip ids only, and **every id in it is guaranteed to exist in `clips`** — see the
pruning rules in §3.4. Media-rail row highlight is **not** selection and must not use the accent —
it uses `--surface-raised` (§7.0).

### 2.6 Project file

```ts
export interface ProjectFile {
  version: 1;
  name: string;
  fps: number;
  width: number;
  height: number;
  media: PersistedMediaItem[];
  tracks: Track[];
  trackOrder: TrackId[];
  clips: Clip[];
  markers: Marker[];
  savedAt: string;   // ISO 8601
}
```

Extension `.veproj`, JSON, 2-space indent. View state (zoom, scroll, selection, panel sizes,
theme) is **not** in the project file — it lives in `localStorage`.

**Media is persisted by path, not by runtime state.** `url` (a `ve-media://` or object URL, dead on
reopen), `status`, `progress`, `error`, `warnings` and `thumbnailUrl` (potentially a multi-megabyte
data URI) are all dropped on save. On open, `hydrateMedia(items: PersistedMediaItem[])` inserts each
item with `status: 'probing'`, `progress: 0`, `url: ''`, `thumbnailUrl: null`, `error: null`,
`warnings: []`, then **re-probes every item by `path`** through the same capped-concurrency pool as
an import (§3.2). This is also the only way a moved or deleted file is detected: its re-probe
returns `not-found` and the item lands in `status: 'error'`, which drives the offline clip treatment
automatically.

`src/lib/project.ts` (scaffold) is the only module that crosses all four slices:

```ts
export function serializeProject(s: StoreState): ProjectFile;
export function applyProject(p: ProjectFile): void;  // calls the four hydrate actions in order:
                                                     // hydrateUi, hydratePlayback, hydrateMedia,
                                                     // hydrateTimeline
export function migrateProject(raw: unknown): ProjectFile | null;  // null = not a project file
```

Ordering matters: `hydratePlayback` must set `fps` before `hydrateMedia` computes
`durationFrames`, and `hydrateMedia` must land before `hydrateTimeline` computes `offlineClipIds`.

---

## 3. The store contract

Each slice file exports: its state interface, its actions interface, the union `XSlice`,
the creator `createXSlice`, and its selectors. Selectors are plain
`(s: StoreState, ...args) => T` functions — never hooks — so they compose and can be called from
pointer handlers via `readStore()`.

**Every selector below is tagged.** `[stable]` means it returns a primitive or a reference that only
changes when the thing it describes changes — safe as a bare `useEditorStore(…)` selector.
`[UNSTABLE REFERENCE]` means it allocates on every call — **never call it inside `useEditorStore`
without `useShallow`**, and never at all in a component that is mounted during playback. Use it from
`readStore()` in a pointer handler or a rAF body. This tagging is the §1.3 rule made operational.

### 3.1 `uiSlice.ts` — owner: **shell**

```ts
export type ThemeName = 'signal' | 'instrument' | 'daylight';

/** Collapsible groups in the inspector. Persisted. See §8.15. */
export type InspectorGroupId = 'project' | 'transform' | 'blend' | 'timeAndSound';

/** The app's single notification channel. One at a time, never stacked. See §5 InlineNotice. */
export interface Notice {
  tone: 'danger' | 'warning';
  title: string;     // two or three words, sentence case: 'Save failed'
  message: string;   // one sentence, sentence case, no trailing period
}

export interface UiState {
  theme: ThemeName;
  /** Media rail width in px, RAIL_MIN..RAIL_MAX. Retained while collapsed. */
  railWidth: number;
  railCollapsed: boolean;
  /** Timeline region as a fraction of the area under the titlebar. TIMELINE_MIN..MAX. */
  timelineHeightPct: number;
  /** Keeps the inspector mounted with an empty selection so project format can be corrected. */
  inspectorPinned: boolean;
  /** true = open. Persisted. Defaults: transform open, everything else closed. */
  inspectorGroups: Record<InspectorGroupId, boolean>;
  /** Project identity — the titlebar reads these; the keyboard layer writes them. */
  projectName: string;
  projectPath: string | null;
  isDirty: boolean;
  /** Transient overlays. Owned here so any slice can open them without prop drilling. */
  exportDialogOpen: boolean;
  shortcutOverlayOpen: boolean;
  /** The titlebar notice slot. null = nothing to say. */
  notice: Notice | null;
}

export interface UiActions {
  setTheme(theme: ThemeName): void;
  setRailWidth(px: number): void;               // clamps to RAIL_MIN..RAIL_MAX
  setRailCollapsed(collapsed: boolean): void;
  toggleRail(): void;
  setTimelineHeightPct(pct: number): void;      // clamps to TIMELINE_MIN..MAX_PCT
  setInspectorPinned(pinned: boolean): void;
  setInspectorGroup(id: InspectorGroupId, open: boolean): void;
  setProjectName(name: string): void;
  setProjectPath(path: string | null): void;
  markDirty(): void;
  markSaved(): void;
  setExportDialogOpen(open: boolean): void;
  setShortcutOverlayOpen(open: boolean): void;
  /** Replaces whatever notice is showing. Any slice may call it. */
  setNotice(n: Notice | null): void;
  hydrateUi(p: Pick<ProjectFile, 'name'>): void;   // called by applyProject
}

export type UiSlice = UiState & UiActions;
export const createUiSlice: SliceCreator<UiSlice>;

/** [stable] */
export const selectInspectorVisible = (s: StoreState): boolean =>
  s.selection.size > 0 || s.inspectorPinned;
/** [stable] Any overlay that swallows the keyboard. Drives §8.10 scope gating. */
export const selectOverlayOpen = (s: StoreState): boolean =>
  s.exportDialogOpen || s.shortcutOverlayOpen;
```

Persistence: shell subscribes to
`{theme, railWidth, railCollapsed, timelineHeightPct, inspectorGroups}` and writes
`localStorage['ve.ui.v1']` debounced 200 ms. On load, parse inside `try/catch`, validate
every field's type **and range**, and fall back to the default for any field that fails. A
corrupt or partial blob must never prevent boot. `inspectorPinned`, `notice` and both dialog flags
are session-only and are never persisted. No other slice reads or writes this key.

**Who calls `markDirty()` — the complete list. Nothing else may call it.**

`addClip`, `insertMediaAt`, `moveClip`, `moveClips`, `trimClip`, `splitAtPlayhead`,
`deleteSelection`, `rippleDelete`, `addTrack`, `removeTrack`, `setTrackHeight`, `toggleMute`,
`toggleLock`, `toggleVisible`, `addMarker`, `removeMarker`, `updateClipProperties`, `renameClip`,
`clampClipsToSource` (only when it changed something), `undo`, `redo`, `addItem`, `removeItem`,
`setProjectName`, `setProjectFps`, `setProjectSize` and `adoptSourceFormat`.

**Explicitly NOT dirty:** `setZoom`, `zoomAround`, `zoomToFit`, `setScroll`, `setSnapEnabled`,
`select`, `selectMany`, `clearSelection`, `setTheme`, rail/timeline resize, every playback transport
action, `markClipsOffline`, `setNotice`, and every hydrate action (which call `markSaved()`
instead). Scrolling the timeline must never light the unsaved dot.

Since `timelineSlice` and `mediaSlice` cannot import `uiSlice` state directly, they call
`get().markDirty()` — the action exists on the merged store. That plus `get().setNotice(…)` are the
only ui writes those slices perform.

### 3.2 `mediaSlice.ts` — owner: **media**

```ts
export interface MediaState {
  items: Record<MediaId, MediaItem>;
  order: MediaId[];                 // insertion order, drives rail row order
  /** True while a file drag from the OS is over the window. Drives the drop affordance. */
  dropActive: boolean;
}

export interface MediaActions {
  /** Opens the native picker (or the fixture picker) and imports the result. */
  importFromPicker(): Promise<void>;
  /** Electron path: absolute fs paths. */
  importPaths(paths: string[]): Promise<void>;
  /** Browser/DnD path. Resolves each File to a path via the bridge; see below. */
  importFiles(files: File[]): Promise<void>;
  addItem(item: MediaItem): void;
  updateItem(id: MediaId, patch: Partial<MediaItem>): void;
  removeItem(id: MediaId): void;          // also calls get().markClipsOffline(id)
  retryItem(id: MediaId): void;
  setDropActive(active: boolean): void;
  /** Re-derives durationFrames for every item after a project-fps change. */
  recomputeMediaDurations(fps: number): void;
  hydrateMedia(items: PersistedMediaItem[]): void;   // inserts as 'probing', then re-probes
}

export type MediaSlice = MediaState & MediaActions;
export const createMediaSlice: SliceCreator<MediaSlice>;

/** [stable] */
export const selectMediaItem = (s: StoreState, id: MediaId): MediaItem | undefined => s.items[id];
/** [stable] The rail row list. `order` is only reallocated on add/remove. */
export const selectMediaOrder = (s: StoreState): readonly MediaId[] => s.order;
/** [stable] */
export const selectMediaStatus = (s: StoreState, id: MediaId): MediaStatus | undefined =>
  s.items[id]?.status;
/** [stable] Cheap scan over `order`, returns a boolean. Safe in a hook. */
export const selectIsImporting = (s: StoreState): boolean =>
  s.order.some(id => s.items[id]?.status === 'probing');
/** [stable] */
export const selectOfflineMediaCount = (s: StoreState): number =>
  s.order.reduce((n, id) => n + (s.items[id]?.status === 'error' ? 1 : 0), 0);

/** [UNSTABLE REFERENCE] readStore() / useShallow only. */
export const selectAllMedia = (s: StoreState): MediaItem[] => s.order.map(id => s.items[id]);
/** [UNSTABLE REFERENCE] readStore() / useShallow only. */
export const selectOfflineMedia = (s: StoreState): MediaItem[] =>
  selectAllMedia(s).filter(m => m.status === 'error');
```

`MediaRail` renders rows from `selectMediaOrder` (stable) and each `MediaRow` subscribes to its own
item by id. It must not call `selectAllMedia` in a hook.

**Resolving a dropped `File` to a path.** `File.path` was removed in Electron 32; the supported
replacement is `webUtils.getPathForFile`, which is a **preload-only** API and therefore
unreachable from the renderer under §1.1. The bridge exposes it as `media.pathForFile(file)`
(§4.2), returning `null` in the fixture bridge. `importFiles` therefore reads:

```ts
const path = getEditorAPI().media.pathForFile(file);
if (path) { /* real import: probe by path */ }
else      { /* browser: URL.createObjectURL(file), url set directly, no probe */ }
```

There is no `(file as any).path` anywhere in this codebase.

Import flow, exactly:

1. `addItem` immediately with `status: 'probing'`, `progress: 0`, `warnings: []`, `url: ''`,
   a placeholder `durationFrames: 0`, and `name` from the basename. The row appears at once.
2. `await getEditorAPI().media.probe(path)` per file, **concurrency capped at 3**
   (`for await` over a small pool). Never `Promise.all` an unbounded list — probing 40 files must
   not stall the UI or the ffmpeg host. The same pool serves `hydrateMedia`'s re-probe on open.
3. On `{ ok: true }`, `updateItem(id, { status: 'ready', ...data, durationFrames:
   secondsToFrames(data.durationSeconds, readStore().fps) })`. `data` is `ProbeData`, which
   **includes `url`** (§4.1) — this is the assignment that makes real media playable, and omitting
   it leaves every item permanently on the static-thumbnail path.
4. On `{ ok: false }`, `updateItem(id, { status: 'error', error })`. Presentation is specified in
   §7.6: `Unplug` icon + the word `Offline` + the message in `--text-ink` + a 1px `--status-danger`
   border. Status colour is never text and never the only signal. Two ghost actions on the row:
   **Retry** and **Remove**.
5. After the *first* item reaches `ready`, call `get().adoptSourceFormat(item)` — this is how the
   project fps and resolution get set without a setup modal (PRODUCT.md anti-reference: modal-first
   flows). It is a no-op once `formatLocked` is true.
6. For every *subsequent* ready item, compare `item.fps` to `readStore().fps` and
   `item.width/height` to the project size; push a `MediaWarning` for each mismatch. This is the
   sole owner of `--status-warning` in this build (§7.6).
7. `get().markDirty()`.

`removeItem` does not delete clips. It calls `get().markClipsOffline(mediaId)`; those clips
render with the offline treatment and the project remains editable.

### 3.3 `playbackSlice.ts` — owner: **preview**

```ts
export interface PlaybackState {
  /** THE playhead. Single source of truth for the whole app. Integer frames. */
  playhead: Frames;
  isPlaying: boolean;
  /** Playback rate. 1 = normal. Negative = reverse shuttle (§8.4). Never 0 (use pause). */
  rate: number;
  inPoint: Frames | null;
  outPoint: Frames | null;
  /** Project format. Adopted from the first ready media item, then locked against re-adoption. */
  fps: number;      // default 30
  width: number;    // default 1920
  height: number;   // default 1080
  formatLocked: boolean;
  volume: number;   // 0..1
  muted: boolean;
}

export interface PlaybackActions {
  play(): void;
  pause(): void;
  togglePlay(): void;
  /** Rounds to an integer frame, then clamps — see the clamp rule below. */
  seek(frame: Frames): void;
  /** Relative seek. ALWAYS rounds: seek(Math.round(get().playhead + delta)). */
  step(delta: Frames): void;
  /** J/K/L. dir -1 reverse, 0 stop, +1 forward; repeated calls in the same direction
      escalate the rate through SHUTTLE_RATES. */
  shuttle(dir: -1 | 0 | 1): void;
  setRate(rate: number): void;
  setInPoint(frame?: Frames): void;    // default: current playhead
  setOutPoint(frame?: Frames): void;
  clearInOut(): void;
  /** Always succeeds. Never retimes clips. Clamps clips that no longer fit their source. */
  setProjectFps(fps: number): void;
  setProjectSize(width: number, height: number): void;
  /** One-shot auto-adopt from the first ready item. No-op when formatLocked. */
  adoptSourceFormat(m: Pick<MediaItem, 'fps' | 'width' | 'height'>): void;
  setVolume(v: number): void;
  toggleMute(): void;
  hydratePlayback(p: Pick<ProjectFile, 'fps' | 'width' | 'height'>): void;
}

export type PlaybackSlice = PlaybackState & PlaybackActions;
export const createPlaybackSlice: SliceCreator<PlaybackSlice>;

export const SHUTTLE_RATES = [1, 2, 4, 8] as const;
/** [stable] */
export const selectTimecode = (s: StoreState): string => framesToTimecode(s.playhead, s.fps);
/** [stable] Where playback stops. See the clamp rule. */
export const selectPlaybackStopFrame = (s: StoreState): Frames;
```

**The clamp rule (three separate bounds, do not conflate them):**

1. **`seek()` upper bound** is
   `selectTimelineDurationFrames(get()) + PLAYHEAD_TAIL_FRAMES` (`PLAYHEAD_TAIL_FRAMES = 300`).
   The tail is what makes the ruler live on a brand-new project — with a bare `max clipEnd` clamp
   the playhead can never leave frame 0 before the first clip lands — and it is what lets the user
   park past the last clip to append. Lower bound is always `0`.
2. **`nav.end`** seeks to `Math.max(0, selectTimelineDurationFrames(s) - 1)`, not to the duration.
   `clipEnd` is exclusive, so the duration frame itself has no content.
3. **Playback stop.** `selectPlaybackStopFrame(s)` is a pure function of state:

   ```ts
   export const selectPlaybackStopFrame = (s: StoreState): Frames =>
     s.outPoint !== null && s.playhead <= s.outPoint
       ? s.outPoint + 1
       : selectTimelineDurationFrames(s);
   ```

   The clock (§8.4) evaluates it each frame and calls `pause()` and `seek(stop - 1)` the moment
   the next frame would reach `stop`. Because it reads the *current* playhead, playback that
   begins past `outPoint` naturally ignores in/out and runs to the end — no "did playback start
   inside the range" flag is needed or permitted. **Nothing loops in this build** — reaching the
   stop frame pauses, always.

`step` rounds explicitly (`Math.round`) because `fps` is stored as the exact decimal — `step(29.97)`
must not produce a fractional playhead. `nav.secondForward` / `nav.secondBack` pass
`secondStepFrames(fps)` from §2.1, never a raw `fps`, so preview and inspector round identically.

`adoptSourceFormat` rounds an odd source fps to the nearest known rate
(`[23.976, 24, 25, 29.97, 30, 50, 59.94, 60]`, tolerance 0.05) and sets `formatLocked = true`. It
then calls `recomputeMediaDurations(fps)` and `clampClipsToSource()`.

**`setProjectFps` always succeeds, including with clips on the timeline.** The old refusal
(`formatLocked && clips.length > 0`) implemented the first half of PRODUCT.md's anti-reference
("sensible defaults, inferred from the first clip imported") and deleted the second ("corrected
inline later"), leaving the frame rate permanently uncorrectable after the first clip. The correct
behaviour:

- `formatLocked` gates **automatic** adoption only. It never gates the user.
- Changing fps does **not** retime clips: `start`, `duration` and `mediaIn` are literal frame
  numbers and keep their values.
- After writing the new rate, `setProjectFps` calls `recomputeMediaDurations(fps)` — which shortens
  `MediaItem.durationFrames` when the rate drops — and then `clampClipsToSource()`, which is the
  action that resolves the resulting over-run. If it trimmed anything, `setProjectFps` reports it:
  `setNotice({ tone: 'warning', title: 'Frame rate changed', message: 'N clips were shortened to fit their source' })`.
- The surface is the inspector's `Project` group, shown when the selection is empty (§8.15). That is
  the "corrected inline later" path, and `inspectorPinned` is what reaches it from the titlebar
  overflow menu when nothing is selected.

### 3.4 `timelineSlice.ts` — owner: **timeline**

```ts
export interface TimelineViewState {
  zoom: PxPerFrame;   // ZOOM_MIN..ZOOM_MAX
  scrollX: number;    // px from timeline frame 0, >= 0
  scrollY: number;    // px, lane area vertical scroll
  snapEnabled: boolean;
}

/** EXACTLY what history snapshots. Everything in here is restorable and self-consistent. */
export interface TimelineDoc {
  tracks: Record<TrackId, Track>;
  trackOrder: TrackId[];
  clips: Record<ClipId, Clip>;
  /** Invariant: every array is sorted ascending by clip.start and contains no overlaps.
      Derived FROM this doc, so a snapshot always carries a matching index — restore it as-is. */
  clipsByTrack: Record<TrackId, ClipId[]>;
  markers: Record<MarkerId, Marker>;
}

export interface TimelineState extends TimelineDoc, TimelineViewState {
  selection: Selection;
  /** NOT part of TimelineDoc: derived from MEDIA state, which history does not cover. */
  offlineClipIds: ReadonlySet<ClipId>;
  history: { past: TimelineDoc[]; future: TimelineDoc[] };
  /** Open transaction, or null. See the history protocol below. */
  historyTxn: { label: string } | null;
}

export type MoveFailure =
  | 'overlap'         // a clip already occupies the target range
  | 'locked'          // source or target track is locked
  | 'out-of-range'    // start < 0, or duration < 1
  | 'no-track'        // no track of the right kind exists at that position
  | 'kind-mismatch'   // video clip onto an audio track, or vice versa
  | 'no-source';      // would need more source frames than the media has

export type MutationResult = { ok: true } | { ok: false; reason: MoveFailure };
export type CreateResult   = { ok: true; id: ClipId } | { ok: false; reason: MoveFailure };

export interface AddClipInput {
  mediaId: MediaId;
  trackId: TrackId;
  start: Frames;
  duration?: Frames;   // defaults to the media's full durationFrames
  mediaIn?: Frames;    // defaults to 0
}

export interface TimelineActions {
  addClip(input: AddClipInput): CreateResult;
  /** Convenience used by media double-click and by drop: finds the first track of the right
      kind with room at `start`, adding a track if none has room. */
  insertMediaAt(mediaId: MediaId, start: Frames, preferredTrackId?: TrackId): CreateResult;
  moveClip(id: ClipId, next: { trackId: TrackId; start: Frames }): MutationResult;
  /** Group move. `deltaTrackIndex` is an offset within the SAME-KIND subsequence of trackOrder,
      so a move can never cross video/audio. All-or-nothing: if any member fails, none move. */
  moveClips(ids: ClipId[], deltaFrames: Frames, deltaTrackIndex: number): MutationResult;
  trimClip(id: ClipId, edge: 'in' | 'out', nextFrame: Frames): MutationResult;
  splitAtPlayhead(): void;                 // splits every selected clip, or every clip under
                                           // the playhead when selection is empty
  deleteSelection(): void;                 // lift: leaves a gap
  rippleDelete(): void;                    // closes the gap on the affected tracks
  select(id: ClipId, mode: 'replace' | 'extend' | 'toggle'): void;
  selectMany(ids: ClipId[], mode: 'replace' | 'extend' | 'toggle'): void;
  clearSelection(): void;
  addTrack(kind: MediaKind): TrackId;
  removeTrack(id: TrackId): void;
  setTrackHeight(id: TrackId, px: number): void;   // TRACK_HEIGHT_MIN..TRACK_HEIGHT_MAX
  toggleMute(id: TrackId): void;
  toggleLock(id: TrackId): void;
  toggleVisible(id: TrackId): void;
  setZoom(zoom: PxPerFrame): void;
  /** anchorPx = pointer x relative to the lane viewport's left edge. Keeps the frame under the
      pointer stationary. Uses pxToFramesExact internally — see §2.1. This is the only zoom
      entry point wheel handlers may call. */
  zoomAround(nextZoom: PxPerFrame, anchorPx: number): void;
  zoomToFit(viewportPx: number): void;
  setScroll(x: number, y: number): void;
  setSnapEnabled(on: boolean): void;
  addMarker(frame?: Frames, label?: string): MarkerId;
  removeMarker(id: MarkerId): void;
  /** Called by mediaSlice.removeItem, by probe failure, and after every undo/redo/hydrate.
      NEVER touches history and never marks dirty — it is a projection of media state. */
  markClipsOffline(mediaId: MediaId): void;
  /** Full recompute of offlineClipIds from current media. Idempotent. */
  recomputeOfflineClips(): void;
  /** Shortens any clip whose source no longer covers it. Returns how many it changed. */
  clampClipsToSource(): number;
  /** THE inspector's only write path. All-or-nothing across `ids`. Returns a result because a
      `speed` change moves the out edge — see §2.4 invariant 4. */
  updateClipProperties(ids: ClipId[], patch: Partial<ClipProperties>): MutationResult;
  renameClip(id: ClipId, name: string): void;

  // --- history ---
  /** Open a transaction: snapshot now, suppress per-action snapshots until commit.
      A no-op when a transaction is already open (transactions do not nest). */
  beginHistory(label: string): void;
  /** Close the open transaction. A no-op when none is open. */
  commitHistory(): void;
  /** Restore the open transaction's snapshot and close it. A no-op when none is open. */
  abortHistory(): void;
  undo(): void;
  redo(): void;

  hydrateTimeline(p: Pick<ProjectFile, 'tracks' | 'trackOrder' | 'clips' | 'markers'>): void;
}

export type TimelineSlice = TimelineState & TimelineActions;
export const createTimelineSlice: SliceCreator<TimelineSlice>;
```

Selectors exported from `timelineSlice.ts` — these are the cross-slice read surface:

```ts
/** [stable] max clipEnd, min 0. */
export const selectTimelineDurationFrames = (s: StoreState): Frames;
/** [stable] Returns s.clipsByTrack[t] BY REFERENCE — reallocated only when that track mutates.
    This is the lane renderer's subscription. */
export const selectClipIdsInTrack = (s: StoreState, t: TrackId): readonly ClipId[];
/** [stable] */
export const selectIsSelected = (s: StoreState, id: ClipId): boolean;
/** [stable] */
export const selectIsOffline = (s: StoreState, id: ClipId): boolean;
/** [stable] Topmost VISIBLE video clip whose [start, end) contains frame, as an ID.
    Binary search per track: O(tracks · log n). THE preview's subscription — it changes at clip
    boundaries, not at frame rate. */
export const selectVideoClipIdAtFrame = (s: StoreState, frame: Frames): ClipId | null;
/** [stable] The clip that starts next after `frame` on any visible video track, as an ID. */
export const selectNextVideoClipIdAfter = (s: StoreState, frame: Frames): ClipId | null;
/** [stable] */
export const selectTrackAtY = (s: StoreState, y: number): Track | null;
/** [stable] px from lane-content top. */
export const selectLaneTop = (s: StoreState, trackId: TrackId): number;
/** [stable] total px, the sum of every Track.height in trackOrder. */
export const selectLaneHeight = (s: StoreState): number;
/** [stable] */
export const selectCanUndo = (s: StoreState): boolean;
/** [stable] */
export const selectCanRedo = (s: StoreState): boolean;
/** [stable] */
export const selectSelectionCount = (s: StoreState): number;

/** [UNSTABLE REFERENCE] readStore() / useShallow only. */
export const selectClipsInTrack = (s: StoreState, t: TrackId): Clip[];
/** [UNSTABLE REFERENCE] readStore() / useShallow only.
    Guaranteed to contain no undefined: ids missing from `clips` are filtered out. */
export const selectSelectedClips = (s: StoreState): Clip[];
/** [UNSTABLE REFERENCE] Called from the rAF audio-gain pass via readStore(), never from a hook. */
export const selectAudioClipsAtFrame = (s: StoreState, frame: Frames): Clip[];
/** [UNSTABLE REFERENCE] Called once per drag start, cached in a ref for the drag's duration. */
export const selectSnapTargets = (s: StoreState, excludeClipIds?: ReadonlySet<ClipId>): Frames[];
```

**`selectTrackAtY` contract, pinned because it is cross-slice:** `y` is **pixels from the top of the
lane *content***, not from the viewport and not from the lane rect. The caller computes it as
`event.clientY - laneRect.top + scrollY`. It does **not** include `RULER_HEIGHT` — the ruler is a
sibling of the lane content, not part of it. Returns `null` above the first lane or below the last.

#### History

Snapshots cover `TimelineDoc` **only** — never `selection`, `offlineClipIds`, zoom, scroll,
`historyTxn`, or the history stack itself. `HISTORY_LIMIT = 100`, oldest dropped. Every mutating
action calls the internal `pushHistory(label)` *before* mutating, **unless `historyTxn !== null`**.

`offlineClipIds` deliberately sits outside `TimelineDoc` because it is derived from *media* state,
which history does not cover. If it were snapshotted, an undo would silently restore a stale offline
set — clips would render as online while their file is broken — and `markClipsOffline`, called from
`mediaSlice.removeItem`, would either make a media operation undoable (contradicting §8.8) or leave
inconsistent data inside every snapshot. Neither is acceptable. Instead:

- `markClipsOffline` and `recomputeOfflineClips` write only `offlineClipIds`. They never push
  history and never mark dirty.
- `undo`, `redo` and `hydrateTimeline` call `recomputeOfflineClips()` immediately after restoring.
- `clipsByTrack` **stays inside `TimelineDoc`**: it is derived from the clips in the same object, so
  every snapshot carries a matching index and restore is a straight assignment. `hydrateTimeline`
  rebuilds it from the incoming clip list (sort each track's ids by `start`); `undo`/`redo` do not
  rebuild it.

**Selection is pruned, never left dangling.** `selection` is not snapshotted, so it can outlive the
clips it names — that path ends in `selectSelectedClips` returning `undefined` entries and the
inspector reading `clip.properties` of `undefined`. Normative:

- `deleteSelection`, `rippleDelete`, `removeTrack`, `splitAtPlayhead` and `hydrateTimeline` prune
  `selection` to ids that still exist in `clips` when they finish.
- `undo` and `redo` intersect `selection` with `Object.keys(clips)` **after** restoring the snapshot.
- `selectSelectedClips` filters missing ids and is typed `Clip[]` — definitely-defined, never
  `(Clip | undefined)[]`. The inspector may index it without a guard.
- `selectInspectorVisible` therefore cannot be true with a selection full of dead ids.

**Transaction protocol.** Exactly one transaction may be open. `beginHistory` while one is open is a
no-op (no nesting, no counter). `commitHistory` and `abortHistory` with none open are no-ops.
Drags and scrubs open a transaction on `pointerdown` and commit on `pointerup`, so one drag is one
undo step; a cancelled drag calls `abortHistory()`. `updateClipProperties` pushes its own history
entry **only when `historyTxn === null`** — inside a transaction it is one of many writes under the
transaction's single snapshot. Every hydrate action resets `history` to `{ past: [], future: [] }`,
sets `historyTxn = null`, clears `selection`, calls `recomputeOfflineClips()` and calls
`markSaved()`. Without that, Ctrl+Z immediately after opening a project reverts into the *previous*
project's document — and in the browser, past the fixture bootstrap into an empty timeline.

#### Overlap and refusal policy (must be visible, never silent, never colour-only)

`moveClip`, `moveClips`, `trimClip`, `addClip`, `insertMediaAt` and `updateClipProperties` first try
the requested placement; if it fails they change nothing and return the reason. The interaction
layer owns the feedback, and **every reason has a specified treatment** — a bare coloured hairline
is not one of them (DESIGN.md, The Icon Tax Rule):

| reason | Drag-ghost icon | Ghost label | Edge treatment |
|---|---|---|---|
| `overlap` | `AlertCircle` | `Blocked by <clip name>` | 2px `--status-danger` bar on the blocking edge |
| `locked` | `Lock` | `Track is locked` | 2px `--status-danger` bar along the target lane's edge |
| `out-of-range` | `AlertCircle` | `Start of timeline` | 2px `--status-danger` bar at frame 0 |
| `no-track` | `AlertCircle` | `No track for this media` | none — the ghost carries it |
| `kind-mismatch` | `AlertCircle` | `Video cannot go on an audio track` (and the reverse) | 2px bar along the rejected lane's edge |
| `no-source` | `Unplug` | `End of source media` | 2px bar at the clip's source-out frame |

In every case the drag ghost additionally dims to **60 % opacity**, so illegality is carried by
lightness *before* hue, by an icon, and by a word — in that order. The ghost stops at the last legal
frame; on `pointerup` the clip settles there with a `var(--dur-feedback)` transition. Never snap
silently back to origin, and never overwrite the blocking clip. A 1px hairline alone is forbidden:
it is below PRODUCT.md's 3:1 non-text floor and under deuteranopia it reduces to a faint lightness
edge against `--surface-raised`.

---

## 4. `window.editorAPI`

`src/types/api.ts` (scaffold). Preload implements it; `fixtureAPI` implements the same interface
against in-memory data. Channel names are string constants exported from the same file so main
and preload cannot drift (§1.2 pins how `electron/**` reaches them).

### 4.1 Types

```ts
export const CH = {
  windowMinimize:    'window:minimize',
  windowMaximize:    'window:maximize-toggle',
  windowClose:       'window:close',
  windowIsMaximized: 'window:is-maximized',
  windowMaxChanged:  'window:maximize-changed',   // main -> renderer
  mediaPick:         'media:pick',
  mediaProbe:        'media:probe',
  mediaProbeProgress:'media:probe-progress',      // main -> renderer
  projectSave:       'project:save',
  projectOpen:       'project:open',
  projectPickDir:    'project:pick-directory',
} as const;

export interface ProbeData {
  kind: MediaKind;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  hasAudio: boolean;
  /** THE playable source. 've-media://file/<encodeURIComponent(abs)>' — see §1.4.
      Never a bare file:// URL: the dev renderer is served from http://localhost:5173 and
      webSecurity blocks file://. Never '' from a successful probe. */
  url: string;
  /** Same scheme as `url`, pointing at the extracted temp frame. null when none. */
  thumbnailUrl: string | null;
}
export type ProbeResult = { ok: true; data: ProbeData } | { ok: false; error: MediaError };

export type SaveResult =
  | { ok: true; path: string }
  | { ok: false; error: { code: 'cancelled' | 'io-failed'; message: string } };
export type OpenResult =
  | { ok: true; path: string; project: ProjectFile }
  | { ok: false; error: { code: 'cancelled' | 'io-failed' | 'bad-format'; message: string } };

export interface ExportSettings {
  filename: string;      // WITHOUT extension; the container supplies it — see CONTAINER in §7.3
  folder: string;
  width: number; height: number; fps: number;
  codec: 'h264' | 'h265' | 'prores';
  quality: 'draft' | 'good' | 'best';
  range: 'entire' | 'inout';
}
export interface ExportProgressEvent {
  jobId: string;
  phase: 'preparing' | 'encoding' | 'finalizing' | 'done' | 'cancelled' | 'error';
  progress: number;      // 0..1, monotonic within a phase
  framesDone: number;
  framesTotal: number;
  message?: string;      // required when phase === 'error'
}
export interface ExportBridge {
  /** The DIALOG resolves `range` into absolute frames before calling. A real ffmpeg-backed
      bridge cannot know where an in/out range begins otherwise, and the stub and the real
      bridge must be interchangeable. */
  start(req: ExportSettings & { startFrame: Frames; durationFrames: Frames }): Promise<{ jobId: string }>;
  cancel(jobId: string): Promise<void>;
  onProgress(cb: (e: ExportProgressEvent) => void): () => void;   // returns unsubscribe
}

export interface EditorAPI {
  platform: 'win32' | 'darwin' | 'linux';
  window: {
    minimize(): void;
    maximizeToggle(): void;
    close(): void;
    isMaximized(): Promise<boolean>;
    onMaximizeChange(cb: (isMaximized: boolean) => void): () => void;
  };
  media: {
    pickFiles(): Promise<string[]>;                 // [] on cancel
    probe(path: string): Promise<ProbeResult>;      // never throws
    onProbeProgress(cb: (e: { path: string; progress: number }) => void): () => void;
    /** Synchronous. Preload-only capability (webUtils.getPathForFile); null in the fixture
        bridge and for a File that has no filesystem backing. See §3.2. */
    pathForFile(file: File): string | null;
  };
  project: {
    save(project: ProjectFile, opts?: { path?: string | null; saveAs?: boolean }): Promise<SaveResult>;
    open(): Promise<OpenResult>;
    pickDirectory(): Promise<string | null>;
  };
  /** ABSENT in this build. ExportDialog falls back to the local stub. See §8.9. */
  export?: ExportBridge;
}

declare global {
  interface Window { editorAPI?: EditorAPI }
}
```

**Every `invoke` resolves; none reject.** Main-process handlers catch everything and return the
`{ ok: false, error }` branch. A renderer `try/catch` around an editorAPI call is a smell —
handle the discriminated union instead.

### 4.2 Preload

`electron/preload.ts` (scaffold) is the *only* module permitted to call `webUtils`:

```ts
import { contextBridge, ipcRenderer, webUtils } from 'electron';
// media.pathForFile:
(file: File) => { try { return webUtils.getPathForFile(file) || null; } catch { return null; } }
```

Everything else on the object is a one-line `ipcRenderer.invoke(CH.x, …)` or an `.on` wrapper that
returns its own unsubscribe.

### 4.3 ffprobe / ffmpeg invocation and the `ProbeData` mapping

`electron/ipc/media.ts` (media) resolves both binaries **on `PATH`** — no bundled binary in this
build (§1.2). Pinned so main, media and the fixture cannot disagree:

```
ffprobe -v error -print_format json -show_streams -show_format -- <abs>
```

| `ProbeData` field | Source |
|---|---|
| `kind` | `'video'` if any stream has `codec_type === 'video'` and `disposition.attached_pic !== 1`, else `'audio'` |
| `durationSeconds` | `Number(format.duration)`, falling back to the chosen stream's `duration` |
| `width` / `height` | first video stream's `width` / `height`; `0` when `kind === 'audio'` |
| `fps` | first video stream's `r_frame_rate` (`"30000/1001"`) evaluated as a division; `0` for audio |
| `codec` | that stream's `codec_name` |
| `hasAudio` | any stream with `codec_type === 'audio'` |
| `url` | `` `ve-media://file/${encodeURIComponent(abs)}` `` |
| `thumbnailUrl` | same scheme over the extracted temp file, or `null` |

Thumbnail extraction, video only, best-effort — a failure yields `thumbnailUrl: null`, never an
error result:

```
ffmpeg -v error -ss <min(1, durationSeconds/2)> -i <abs> -frames:v 1 -vf scale=320:-2 -y <tmp>/<mediaId>.jpg
```

Error mapping: `spawn` `ENOENT` → `ffmpeg-missing`; `fs.access` failure → `not-found`; non-zero exit
or unparseable JSON → `probe-failed`; a video stream whose `codec_name` is outside the Chromium-
decodable set → `unsupported-codec`. Never `throw` across the bridge, never resolve `ok` with
partial data, never leave a temp thumbnail behind on failure.

### 4.4 Fixture-provider fallback contract

`src/dev/fixtures.ts` (scaffold) exports:

```ts
export const fixtureAPI: EditorAPI;
export const FIXTURE_PROJECT: ProjectFile;   // 12 media items, 6 tracks (V3 V2 V1 A1 A2 A3),
                                             // 41 clips, 4 markers, fps 30, 1920x1080
export function bootstrapFixtures(): void;   // calls applyProject(FIXTURE_PROJECT)
```

`src/main.tsx` calls `bootstrapFixtures()` when `!isElectron()`, before the first render, via the
dynamic import in §1.1 — nothing in `src/lib/**` imports this module.

Guarantees the fixture data must satisfy:

- Clip widths span two orders of magnitude, including at least three clips narrower than 24 px at
  the default zoom, so the degrade-not-overflow path (§7.6) is visible on first load.
- At least two clips abut exactly (`a.start + a.duration === b.start`) so the 3 px radius decision
  and the inset focus/selection geometry (§5) can be judged.
- At least one media item has `status: 'error'` with `code: 'not-found'`, and at least one clip
  references it, so the offline treatment renders.
- At least one item is `status: 'probing'` with `progress: 0.4`.
- At least one *ready* item carries a `fps-mismatch` warning, so `--status-warning` renders.
- At least one clip has `properties.speed !== 1`, so the source-mapping invariant is exercised.
- At least one track is `locked` and one is `muted`, so both textures render.
- `fixtureAPI.media.pickFiles()` resolves with two synthetic paths and `probe()` resolves `ok`
  after a 600 ms delay with staged progress, so the import path is exercisable in a browser.
- `fixtureAPI.media.pathForFile()` returns `null`, always.

**Playability:** fixture media have `url: ''` and a data-URI `thumbnailUrl`. `MediaItem.url === ''`
means *not playable*. `VideoSurface` must handle it: instead of a `<video>`, render the clip's
thumbnail letterboxed on the well with the timecode drawn in `--text-on-well` `.type-numeric`, and
drive the playhead from the rAF wall clock (§8.4). This is the only branch permitted on source
availability, and it is a property of the data, not of `isElectron()`.

---

## 5. Shared UI primitives

`src/components/ui/**` (scaffold), barrel `src/components/ui/index.ts`. **No slice defines its
own button, input, tooltip, notice or dialog.** If a primitive lacks a prop you need, report it
under §0.2.

The primitive inventory is closed at **nine**: `Button`, `IconButton`, `NumericField`,
`TimecodeField`, `InlineNotice`, `Panel`, `Tooltip`, `Dialog`, `Menu` (with `MenuItem`).

All seven states are implemented on the primitive, once. Slices get them for free and must not
re-implement hover/focus styling on top.

| State | Mechanism | Visual (all variants) |
|---|---|---|
| default | — | per variant below |
| hover | `:hover` | background moves one step along the ramp (`--surface-panel-hover` / `--surface-raised-hover`), text lifts to `--text-ink`, `var(--dur-feedback)`. There is no `--surface-chrome-hover` and no `--surface-well-hover` — nothing at those planes is an interactive target. |
| focus-visible | `:focus-visible` | `outline: var(--focus-ring-width) solid var(--accent); outline-offset: var(--focus-ring-offset)` (+2px). Never removed, never replaced by a box-shadow. **One exception, below.** |
| active | `:active` | background one further step, transform none (no scale bounce) |
| disabled | `[disabled]` / `aria-disabled` | text drops to `--text-muted`, **background unchanged**, `cursor: not-allowed`, focus ring retained, element stays in the tab order, `disabledReason` renders in the tooltip. Never opacity. |
| loading | `loading` prop | content stays in place, a 12 px spinner replaces the icon slot, `aria-busy="true"`, pointer events off. Under reduced motion the spinner becomes a static three-dot glyph. Text stays at `--text-ink` — no opacity dimming. |
| error | `invalid` / `error` prop | 1 px `--status-danger` border **plus** an `AlertCircle` icon **plus** the message text in `--text-ink`. `aria-invalid="true"`, `aria-describedby` pointing at the message. Colour is never the only signal and never the text colour. |

**Disabled, spelled out.** The old "50 % opacity" rule is withdrawn. An `aria-disabled` control stays
focusable and is not exempt from contrast, and at 50 % opacity `--text-muted` on `--surface-raised`
falls from a verified 5.31:1 to roughly 2.4:1 — below PRODUCT.md's 4.5:1 floor. `--text-muted` on an
unchanged `--surface-raised` holds 5.31:1 and reads as unavailable by tone alone. **Every `disabled`
requires a `disabledReason: string`**; in development, `disabled && !disabledReason` throws. A
control that cannot state a reason must stay enabled and explain on use, which is what DESIGN.md
prefers anyway.

**The one focus-ring exception (supersedes DESIGN.md — see S2 in the preamble).** On **timeline
clips and track heads**, focus-visible is a 2 px `--accent` outline at `outline-offset: -2px`
(inset). A +2 px offset ring on a clip bleeds 4 px into abutting neighbours — and the fixture data
is required to contain abutting clips — and is clipped by the lane's `overflow`. No other component
may claim this exception.

**A clip carries three edge treatments and CSS allows only one `outline`, so the mechanism is
pinned here.** Do not invent a fourth layer, and do not reach for `box-shadow` (DESIGN.md's
No-Shadow-In-Flow Rule):

| Layer | Property | Value | Always present? |
|---|---|---|---|
| Structural edge (the 3:1 floor, §7.5) | `border` + `box-sizing: border-box` | `1px solid var(--border-structural)` | yes, on every clip |
| Selected | `outline` | `1.5px solid var(--accent); outline-offset: -1.5px` | only when selected |
| Focus-visible | `outline` | `2px solid var(--accent); outline-offset: -2px` | only when focused — **replaces** the selection outline |

Because focus and selection would otherwise be the same accent outline, a **focused** clip
additionally raises its background to `--surface-raised-hover`. That lightness lift is what
distinguishes focus from selection when a clip is both, and it satisfies PRODUCT.md's requirement
for visible focus on timeline clips and track headers. The structural border never changes and never
shifts the clip's footprint, so neighbours never move.

```ts
// Button
export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: 'primary' | 'secondary' | 'ghost';   // default 'secondary'
  size?: 'sm' | 'md';                            // 24px | 28px, default 'md'
  loading?: boolean;
  invalid?: boolean;
  /** REQUIRED whenever `disabled` is set. Rendered in the tooltip. */
  disabledReason?: string;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
  children: React.ReactNode;                     // sentence case, always
}

// IconButton — label is REQUIRED and becomes aria-label; there is no icon-only escape hatch.
export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: React.ReactNode;
  label: string;
  variant?: 'ghost' | 'secondary';               // default 'ghost'
  size?: 'sm' | 'md';                            // 24px | 28px square
  /** Toggle semantics. Sets aria-pressed and swaps the icon glyph. Does NOT tint anything. */
  pressed?: boolean;
  /** Opt-in accent for the pressed state. Default FALSE. §7.4 permits it on track-head
      mute/lock/visibility toggles and NOWHERE else. */
  accentWhenPressed?: boolean;
  /** 'danger' turns the HOVER background --status-danger with the glyph in --text-on-danger.
      Used only by the titlebar close button. */
  tone?: 'default' | 'danger';
  loading?: boolean;
  disabledReason?: string;
  /** Rendered in the tooltip; pass <ShortcutHint id="..." />. */
  shortcut?: React.ReactNode;
}
```

`pressed` alone renders as `--text-ink` glyph on a persistent `--surface-raised-hover` background —
a lightness change plus a distinct glyph, which is enough to carry a binary state without spending
accent. This is the treatment for the snap toggle, the transport mute toggle, the rail-collapse
toggle, and every future toggle. Only track-head toggles set `accentWhenPressed`.

```ts
// NumericField — the workhorse of the inspector, and the only free-numeric input in the app.
export interface NumericFieldProps {
  value: number | 'mixed';
  /** Fires continuously during scrub and typing. Cheap: does not open a history entry. */
  onChange(next: number): void;
  /** Fires on pointerup / Enter / blur. REQUIRED: this is where the history transaction closes.
      An optional onCommit leaves transactions open forever, and §3.4 says an open transaction
      suppresses every per-action snapshot — undo would silently die for the session. */
  onCommit(next: number): void;
  /** Fires on Escape. The field reverts to `value` and the caller calls abortHistory(). */
  onCancel?(): void;
  label: string;                 // accessible name; PropertyRow renders the visible copy
  min?: number; max?: number;
  step?: number;                 // keyboard arrow increment, default 1
  precision?: number;            // decimals shown, default 0
  /** Units per pixel of horizontal drag. Default step. Shift = ×0.1, Ctrl = ×10. */
  scrubSensitivity?: number;
  suffix?: string;               // '%', '°', '×'
  disabled?: boolean;
  disabledReason?: string;
  loading?: boolean;
  error?: string | null;
  /** 'panel' (default) = --surface-well inset. 'well' = transparent + hairline underline. */
  surface?: 'panel' | 'well';
  id?: string;
}

// TimecodeField — scaffold-owned, NOT preview-owned. A directly-editable timecode is an input,
// and §5's first sentence forbids a slice defining one. Preview and the timeline ruler both use
// this; there is exactly one timecode field implementation in the app.
export interface TimecodeFieldProps {
  value: Frames;
  fps: number;
  /** Parsed with timecodeToFrames. null (invalid) reverts to `value` and sets the error state
      with the message 'Not a timecode'. Valid input commits and clears the error. */
  onCommit(frames: Frames): void;
  onCancel?(): void;
  label: string;                 // accessible name, e.g. 'Playhead position'
  disabled?: boolean;
  disabledReason?: string;
  /** 'well' is the transport's variant — see below. */
  surface?: 'panel' | 'well';
}
```

`value === 'mixed'` renders the literal text `Mixed` in `--text-muted`, keeps the field
editable, and typing replaces the value for the whole selection. It never renders blank.

**Fields on the well.** DESIGN.md puts input backgrounds on `well` *inset into a panel*, and puts
the transport on the `well` surface. A well field on a well surface has zero tonal separation and
fails The Audit Test. So `surface='well'` renders the field **transparent, with a 1 px
`--border-structural` underline and `--text-on-well` text** — it recedes by hairline because the
tone is already spent. `surface='panel'` renders the `--surface-well` inset DESIGN.md specifies.

```ts
// InlineNotice — the ONLY error/warning presentation surface in the app. No toasts, no stacking,
// no status-tile row (PRODUCT.md forbids dashboard grammar).
export interface InlineNoticeProps {
  tone: 'danger' | 'warning';
  title: string;                 // 'Save failed', 'Codec mismatch' — sentence case
  message: string;
  action?: { label: string; onSelect(): void };   // e.g. 'Retry'
  onDismiss?(): void;
}
```

`InlineNotice` renders on `--surface-raised` with a 1 px border in `--status-danger` /
`--status-warning`, an `AlertCircle` / `TriangleAlert` icon in the same colour, and **title and
message in `--text-ink`**. Status colour never becomes text (§7.6). Exactly three host sites, and no
others:

| Failure | Host | Owner |
|---|---|---|
| `SaveResult` / `OpenResult` `io-failed`, `bad-format`; `setNotice` from any slice | the titlebar notice strip, driven by `ui.notice` | shell |
| `ExportProgressEvent` `phase: 'error'` | inside the export dialog body, above the footer | inspector |
| `MediaError` on a row | inside the media row itself (compact variant: icon + title, message in the row tooltip) | media |

One notice at a time. `setNotice` replaces; it does not queue.

```ts
// Panel — bounded region with a heading. NESTING IS FORBIDDEN and enforced.
export interface PanelProps {
  heading?: React.ReactNode;     // title type
  actions?: React.ReactNode;     // right-aligned in the heading row
  padded?: boolean;              // default true -> var(--space-lg)
  scroll?: boolean;              // default false
  className?: string;
  children: React.ReactNode;
}
```
`Panel` publishes a React context; a `Panel` rendered inside a `Panel` throws in development with
"Nested panels are forbidden (DESIGN.md §4)". Flatten instead.

**Who renders a `Panel` — stated once so integration cannot discover it (§7.0 is the plane table):**
the shell renders **bare containers with no `Panel`** for every region. `MediaRail` and `Inspector`
each render **exactly one** `Panel` at their own root. `Timeline`, `TimelineToolbar` and
`PreviewWell` render **no** `Panel` at all — they are chrome and well surfaces, not panels.
`Dialog` and `Menu` paint their own `--surface-panel` body and must not wrap a `Panel`.

```ts
// Tooltip — wraps exactly one focusable child. Opens on hover (400ms) and on focus-visible (0ms).
export interface TooltipProps {
  content: React.ReactNode;
  shortcut?: React.ReactNode;    // <ShortcutHint id="..." />
  placement?: 'top' | 'bottom' | 'left' | 'right';
  children: React.ReactElement;
}

// Dialog — native <dialog>, focus trap, focus restore, Escape, scrim.
export interface DialogProps {
  open: boolean;
  onClose(): void;
  title: string;                 // headline type; becomes the accessible name
  description?: string;
  footer?: React.ReactNode;      // action row, right-aligned, primary last
  initialFocusRef?: React.RefObject<HTMLElement>;
  width?: number;                // px, default 480
  children: React.ReactNode;
}

// Menu — the titlebar overflow and any context menu. Popover shadow, roving tabindex.
export interface MenuProps {
  trigger: React.ReactElement;
  items: MenuItem[];
  align?: 'start' | 'end';
}
export type MenuItem =
  | { kind: 'item'; id: string; label: string; icon?: React.ReactNode;
      shortcut?: React.ReactNode; checked?: boolean; disabled?: boolean;
      disabledReason?: string; onSelect(): void }
  | { kind: 'submenu'; id: string; label: string; items: MenuItem[] }
  | { kind: 'separator'; id: string }
  | { kind: 'label'; id: string; label: string };
```

**`MenuItem` ships all seven states too** — "half a component is not a component" applies to it as
much as to `Button`. Body `--surface-panel` (see `Dialog`/`Menu` in §7.0); hover
`--surface-panel-hover`; focus-visible the standard +2 px accent ring within the roving-tabindex
group; active one further step; disabled per the rule above (`--text-muted`, reason in the
tooltip, still reachable by the roving index); loading not applicable — a menu item that starts
async work closes the menu and the work reports through `InlineNotice`; error not applicable.
`checked` renders a `Check` icon in the leading icon slot — **never a colour change**, so it
survives deuteranopia and does not spend accent.

**Keyboard-guard contract.** `NumericField`, `TimecodeField`, and every text input in the app set
`data-editor-text-input="true"` on the focusable element. `useShortcuts` ignores any event whose
`target` matches:

```
input, textarea, select, [contenteditable=""], [contenteditable="true"], [data-editor-text-input="true"]
```
…**except** for `Escape`, whose routing is pinned in §8.10. This is the single contract that stops
"pressing S in a filename field splits the clip". Because both fields are scaffold-owned, the
attribute is set in one place and no slice can forget it.

**Icons:** `lucide-react`, size 14 (`sm`) / 16 (`md`), `strokeWidth={1.75}`, `aria-hidden="true"`.
Fixed assignments so the "distinct icon per state" rule holds:
mute `Volume2` / `VolumeX`; lock `LockOpen` / `Lock`; visibility `Eye` / `EyeOff`;
offline media `Unplug`; error `AlertCircle`; warning `TriangleAlert`; checked `Check`;
snap `Magnet`; import `FolderInput`; export `Upload`; split `Scissors`; marker `Bookmark`;
settings `Sliders`; transport `SkipBack` `ChevronLeft` `Play` `Pause` `ChevronRight` `SkipForward`.

---

## 6. Semantic z-index scale

Declared once in `src/styles/tokens.css`. **A numeric `z-index` literal anywhere in slice code is
a bug.** Always `z-index: var(--z-…)`.

```css
--z-base:              0;   /* lane background, track lanes */
--z-clip:             10;   /* resting clips */
--z-clip-dragging:    20;   /* the clip(s) under the pointer */
--z-snap-guide:       25;   /* the 1px accent snap line */
--z-playhead:         30;   /* the playhead LINE through the lanes: above every clip, always */
--z-timeline-ruler:   40;   /* sticky top of the lane area */
--z-track-heads:      45;   /* sticky left column, above the ruler's left corner */
--z-playhead-head:    46;   /* the playhead MARKER inside the ruler */
--z-marquee:          50;   /* selection rectangle */
--z-resizer:          60;   /* panel splitters */
--z-inspector:        70;   /* the inspector overlays the preview at every width (§8.11) */
--z-titlebar:         80;
--z-drop-overlay:     90;   /* file-drop affordance over the whole window */
--z-menu:            100;   /* popovers, overflow menu, context menus */
--z-tooltip:         110;
--z-dialog-scrim:    120;
--z-dialog:          130;   /* export dialog, shortcut overlay */
```

The playhead is **two elements with two tokens**, because the ruler is sticky and paints over
`--z-playhead`: the vertical line through the lanes owns `--z-playhead` (30) and its marker inside
the ruler owns `--z-playhead-head` (46). Without the split, the single element §7.4 spends its first
accent slot on is occluded by the ruler it sits in. The two share one `left`/`transform` write from
the same `useEditorStore.subscribe` callback so they cannot drift.

Only `--z-menu` and above may carry a shadow (`--shadow-popover` / `--shadow-dialog`).
Everything below is in-flow and casts none.

---

## 7. Token names

`src/styles/tokens.css` (scaffold) is the only file containing a colour literal. Every value below
is derived from `DESIGN.md`; **the names are normative — five agents must type the same string.**

### 7.0 Plane assignment — which surface each region paints

DESIGN.md §2 makes the four-plane ramp normative but assigns it to *kinds* of thing, not to this
app's named regions. Five agents cannot each answer "is the timeline lane chrome or panel?"
independently — the ramp is the only depth mechanism in the system, so a wrong answer in three
regions destroys it. **This table is the assignment. It is closed.**

| Region | Plane | Renders a `Panel`? |
|---|---|---|
| Titlebar (incl. the notice strip) | `--surface-chrome` | no |
| Gutters between regions, resizer tracks | `--surface-chrome` | no |
| Timeline region background, lane backgrounds, ruler, `TimelineToolbar` | `--surface-chrome` | no |
| Media rail body | `--surface-panel` | **yes — `MediaRail`, exactly one** |
| Inspector body | `--surface-panel` | **yes — `Inspector`, exactly one** |
| `Dialog` body (export, shortcut overlay), `Menu` body | `--surface-panel` + `--shadow-dialog` / `--shadow-popover` + `--radius-lg` | no (own primitives) |
| Track heads | `--surface-raised` | no |
| Timeline clips | `--surface-raised` | no |
| Secondary buttons, `IconButton` hover/pressed, `InlineNotice` | `--surface-raised` | no |
| Media-rail row highlight (**not** selection) | `--surface-raised` | no |
| Preview surround (`PreviewWell`), transport strip | `--surface-well` | no |
| `NumericField` / `TimecodeField` inset, `surface='panel'` variant | `--surface-well` | no |

**`--surface-well` may be painted by `PreviewWell`, by the transport strip beneath it, and by the
two field insets. Any other use is a bug.** In particular it is not a progress-bar trough: DESIGN.md
closes the plane ("Nothing else uses it"), and in `daylight` `--text-ink` is dark while the well
stays dark, so an ink-on-well progress fill is ~1.3:1 and the import indicator disappears. Progress
bars are specified in §7.7.

Lane / clip separation is a **0.095 tonal step** (chrome 0.215 → raised 0.31), which is the largest
step in the ramp — that is the intended mechanism, and it is why the timeline is not a `Panel`.

### 7.1 Colour (theme-swapped)

Twenty-two colour tokens, written out literally for all three themes. **No derivation, no
placeholders.** A theme block that is empty renders as `signal` and the theme switcher looks broken;
a derivation rule ("+0.04 lightness") is simply wrong in `daylight`, where the ramp inverts.

```css
:root, :root[data-theme='signal'] {
  --surface-well:          oklch(0.10  0.008 265);
  --surface-chrome:        oklch(0.215 0.014 265);
  --surface-panel:         oklch(0.255 0.016 265);
  --surface-raised:        oklch(0.31  0.018 265);
  --surface-panel-hover:   oklch(0.28  0.016 265);
  --surface-raised-hover:  oklch(0.35  0.018 265);
  --text-ink:              oklch(0.96  0.004 265);
  --text-muted:            oklch(0.72  0.012 265);
  --text-on-well:          oklch(0.96  0.004 265);
  --text-on-accent:        oklch(0.17  0.03  68);
  --text-on-danger:        oklch(0.18  0.03  22);
  --text-on-warning:       oklch(0.20  0.04  100);
  --accent:                oklch(0.75  0.15  68);
  --accent-hover:          oklch(0.79  0.15  68);
  --status-danger:         oklch(0.66  0.19  22);
  --status-danger-hover:   oklch(0.70  0.19  22);
  --status-warning:        oklch(0.90  0.15  100);
  --border-hairline:        oklch(1 0 0 / 0.08);
  --border-hairline-strong: oklch(1 0 0 / 0.16);
  --border-structural:     oklch(0.58  0.014 265);
  --scrim:                 oklch(0 0 0 / 0.56);
  --texture-tint:          oklch(1 0 0 / 0.07);
}

:root[data-theme='instrument'] {
  --surface-well:          oklch(0.10  0 0);
  --surface-chrome:        oklch(0.205 0 0);
  --surface-panel:         oklch(0.245 0 0);
  --surface-raised:        oklch(0.30  0 0);
  --surface-panel-hover:   oklch(0.27  0 0);
  --surface-raised-hover:  oklch(0.34  0 0);
  --text-ink:              oklch(0.96  0 0);
  --text-muted:            oklch(0.70  0 0);
  --text-on-well:          oklch(0.96  0 0);
  --text-on-accent:        oklch(0.16  0.03  205);
  --text-on-danger:        oklch(0.18  0.03  25);
  --text-on-warning:       oklch(0.20  0.04  92);
  --accent:                oklch(0.72  0.13  205);
  --accent-hover:          oklch(0.76  0.13  205);
  --status-danger:         oklch(0.66  0.19  25);
  --status-danger-hover:   oklch(0.70  0.19  25);
  --status-warning:        oklch(0.87  0.15  92);
  --border-hairline:        oklch(1 0 0 / 0.08);
  --border-hairline-strong: oklch(1 0 0 / 0.16);
  --border-structural:     oklch(0.58  0 0);
  --scrim:                 oklch(0 0 0 / 0.56);
  --texture-tint:          oklch(1 0 0 / 0.07);
}

:root[data-theme='daylight'] {
  --surface-well:          oklch(0.13  0 0);
  --surface-chrome:        oklch(0.97  0.004 290);
  --surface-panel:         oklch(1     0 0);
  --surface-raised:        oklch(0.94  0.006 290);
  --surface-panel-hover:   oklch(0.965 0.004 290);
  --surface-raised-hover:  oklch(0.90  0.006 290);
  --text-ink:              oklch(0.25  0.012 290);
  --text-muted:            oklch(0.50  0.014 290);
  --text-on-well:          oklch(0.96  0.002 290);
  --text-on-accent:        oklch(0.99  0.002 290);
  --text-on-danger:        oklch(0.99  0.002 290);
  --text-on-warning:       oklch(0.99  0.002 290);
  --accent:                oklch(0.533 0.125 294.3);
  --accent-hover:          oklch(0.49  0.125 294.3);
  --status-danger:         oklch(0.42  0.19  25);
  --status-danger-hover:   oklch(0.38  0.19  25);
  --status-warning:        oklch(0.55  0.13  72);
  --border-hairline:        oklch(0 0 0 / 0.10);
  --border-hairline-strong: oklch(0 0 0 / 0.18);
  --border-structural:     oklch(0.60  0.014 290);
  --scrim:                 oklch(0 0 0 / 0.56);
  --texture-tint:          oklch(0 0 0 / 0.09);
}

/* THEME-INVARIANT. Geometry, not colour — these are identical in all three themes and derive
   their one colour from --texture-tint above. See §7.6. */
:root {
  --texture-locked:     repeating-linear-gradient(135deg, transparent 0 3px, var(--texture-tint) 3px 6px);
  --texture-muted:      repeating-linear-gradient(90deg,  transparent 0 2px, var(--texture-tint) 2px 3px);
  --texture-offline:    repeating-linear-gradient(45deg,  transparent 0 4px, var(--texture-tint) 4px 8px);
  --texture-warning:    repeating-linear-gradient(0deg,   transparent 0 3px, var(--texture-tint) 3px 4px);
}
```

**Hover direction is signed, not additive.** `hover = one step *away from* the theme's text colour`
— which in `signal` and `instrument` means lighter, and in `daylight` means *darker*. "+0.04
lightness" is meaningless in `daylight`, where `--surface-panel` is `oklch(1 0 0)`, and it inverts
the ramp, where `raised` (0.94) is already darker than `panel` (1.0).

**There is no `--surface-chrome-hover` and no `--surface-well-hover`, deliberately.** Nothing at
those two planes is an interactive target in this build, and inventing tones for them broke the
ramp: `chrome-hover` at 0.255 was lightness-identical to resting `--surface-panel`, so a hovered
gutter read as a panel. DESIGN.md's Four Planes Rule caps the ramp at four in-flow tones; the two
`-hover` values that survive are the minimum needed for real interactive targets, and
`--surface-panel-hover` (0.28) is placed 0.03 clear of `--surface-raised` (0.31) so a hovered media
row can never be mistaken for a raised control.

**Verified pairings** (`Y ≈ L³` for these near-neutral tones; the ratios below were the deciding
factor for each value):

| Pair | signal | instrument | daylight |
|---|---|---|---|
| `--text-ink` on `--surface-panel` | 14.0:1 | 14.4:1 | 16.0:1 |
| `--text-muted` on `--surface-raised` | 5.31:1 | 5.10:1 | 5.03:1 |
| `--text-muted` on `--surface-panel-hover` | 5.88:1 | 5.64:1 | 5.42:1 |
| `--text-ink` on `--surface-raised-hover` | 10.1:1 | 10.4:1 | 11.9:1 |
| `--text-on-accent` on `--accent` | 8.36:1 | 8.1:1 | 5.06:1 |
| `--text-on-danger` on `--status-danger` | 6.05:1 | 6.05:1 | 8.2:1 |
| `--text-on-warning` on `--status-warning` | 13.4:1 | 12.2:1 | 4.7:1 |
| `--accent` on `--surface-raised` (non-text, 3:1 floor) | 5.9:1 | 5.4:1 | 4.35:1 |
| `--border-structural` on `--surface-chrome` | 4.0:1 | 4.1:1 | 3.62:1 |
| `--border-structural` on `--surface-raised` | 3.02:1 | 3.10:1 | 3.30:1 |

Those ratios are computed with the neutral approximation `Y ≈ L³`, which is exact for the chroma-0
`instrument` ramp and within ~2 % for the others. **Scaffold re-runs every pairing through a real
contrast checker before committing `tokens.css`** and reports any value that lands under its floor
rather than shipping it — the two marginal pairings flagged below are the ones to watch.

`--text-muted` on `--surface-raised-hover` lands at 4.55 / 4.40 / 4.45:1 across the three themes —
at or under the floor. **It is therefore forbidden:** hovered controls lift their text to
`--text-ink` (DESIGN.md §5, Ghost buttons, already says so). No component may render `--text-muted`
on any `-hover` surface. That rule is what makes the two hover tones safe.

`ThemeProvider` (`src/components/shell/ThemeProvider.tsx`, shell-owned) sets
`document.documentElement.dataset.theme` from `ui.theme` in one effect and renders `props.children`
unchanged. Nothing else touches `dataset.theme`. `App.tsx` mounts it as the outermost element. There
is no `prefers-color-scheme` branch — the theme is an explicit user choice with `signal` as default.

**Where the theme is chosen.** `setTheme` had no surface, so two of three themes were unreachable
and would have shipped unverified. The titlebar overflow `Menu` (shell-owned) carries a
`kind: 'submenu'` item labelled `Theme` with three `checked` items — `Signal`, `Instrument`,
`Daylight`. That is the only theme control in the app.

### 7.2 Type

```
--font-sans   Inter, system-ui, sans-serif
--font-mono   'JetBrains Mono', ui-monospace, monospace

--type-headline-size 18px  --type-headline-weight 600  --type-headline-line 1.3   --type-headline-track -0.01em
--type-title-size    15px  --type-title-weight    600  --type-title-line    1.35  --type-title-track    -0.005em
--type-body-size     13px  --type-body-weight     400  --type-body-line     1.45  --type-body-track     normal
--type-label-size    11px  --type-label-weight    500  --type-label-line    1.3   --type-label-track    0.005em
--type-numeric-size  12px  --type-numeric-weight  400  --type-numeric-line  1.2   --type-numeric-track  normal
```

`base.css` ships six utility classes; **use these rather than re-declaring the properties**:
`.type-headline`, `.type-title`, `.type-body`, `.type-label`, `.type-numeric`, `.type-numeric-sm`.
`.type-numeric` sets `font-family: var(--font-mono); font-variant-numeric: tabular-nums;
font-feature-settings: 'tnum' 1, 'zero' 1;`. `.type-numeric-sm` is `.type-numeric` at
`font-size: var(--type-label-size)` — the 11 px mono variant.

**The tabular rule, operationally:** every timecode, duration, frame count, **timeline ruler mark**,
percentage, dimension, bitrate, file size, and every value inside a `NumericField` or
`TimecodeField` carries `.type-numeric` (or `.type-numeric-sm`). If a number can change while the
app is running and it is not in one of those two classes, that is a bug.

**Ruler marks — the conflict resolved.** DESIGN.md §3 lists "ruler marks" under **Label** (Inter,
proportional, 11 px); The Tabular Rule requires mono + tabular for every numeral that changes while
the UI is live, and ruler marks re-render on every zoom and every scroll. **Mono wins wherever the
two collide.** Ruler marks are `.type-numeric-sm` in `--text-muted`: 11 px from the Label step, mono
and tabular from the numeric step. Label governs only the non-numeric part of a mark, if any. This
also keeps the ruler's digits aligned with the transport `TimecodeField` immediately above it, which
was the practical reason the rule exists.

### 7.3 Radius, space, motion, layout

```
--radius-clip 3px   --radius-sm 4px   --radius-md 6px   --radius-lg 10px

--space-hair 2px  --space-xs 4px  --space-sm 6px  --space-md 8px
--space-lg 12px   --space-xl 16px --space-xxl 24px

--dur-feedback   120ms   /* hover, focus, toggle */
--dur-transition 180ms   /* the default; DESIGN.md band is 150-250 */
--dur-panel      200ms   /* inspector mount/unmount, rail collapse */
--dur-snap        90ms   /* timeline snap settle */
--ease-out cubic-bezier(0.22, 1, 0.36, 1);

--shadow-popover 0 8px 24px oklch(0 0 0 / 0.44), 0 2px 6px oklch(0 0 0 / 0.32);
--shadow-dialog  0 24px 64px oklch(0 0 0 / 0.56);

--focus-ring-width 2px   --focus-ring-offset 2px

--titlebar-height 36px
--rail-width-default 260px
--inspector-width 280px
--track-head-width 88px
--ruler-height 28px
--timeline-toolbar-height 32px
--resizer-hit 5px
```

There are no `--track-height-*` custom properties: `Track.height` is the single runtime source
(§2.4), and a CSS token would be a second one.

Reduced motion, declared once in `base.css`:

```css
@media (prefers-reduced-motion: reduce) {
  :root { --dur-feedback: 1ms; --dur-transition: 1ms; --dur-panel: 1ms; --dur-snap: 1ms; }
  *, *::before, *::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
  }
}
```

The `transition-duration` override is the belt to the token braces: overriding only the custom
properties leaves any literal `200ms` in a component untouched. **No slice writes a literal
duration** — always `var(--dur-…)` — and §8.1 is written that way too.

That global is a floor, not a substitute. Any component whose *logic* depends on motion (timeline
inertia, momentum scrub, snap settle) must read
`window.matchMedia('(prefers-reduced-motion: reduce)').matches` via the scaffold hook
`useReducedMotion(): boolean` and take the instant path. Nothing may be gated on a `transitionend`.

The same numbers exist as TypeScript in `src/lib/constants.ts` (scaffold) for layout maths:

```ts
export const TITLEBAR_HEIGHT = 36;
export const RAIL_DEFAULT = 260, RAIL_MIN = 200, RAIL_MAX = 420;
export const INSPECTOR_WIDTH = 280;
export const MIN_WINDOW = { width: 1024, height: 640 };
export const TIMELINE_DEFAULT_PCT = 0.38, TIMELINE_MIN_PCT = 0.22, TIMELINE_MAX_PCT = 0.65;
export const TRACK_HEAD_WIDTH = 88, RULER_HEIGHT = 28, TIMELINE_TOOLBAR_HEIGHT = 32;
/** Seed defaults for Track.height only — never read at render time. */
export const TRACK_HEIGHT_VIDEO = 56, TRACK_HEIGHT_AUDIO = 40;
export const TRACK_HEIGHT_MIN = 28, TRACK_HEIGHT_MAX = 160;
export const MEDIA_ROW_HEIGHT = 44, MEDIA_THUMB = { width: 32, height: 18 };

export const CLIP_RADIUS = 3;
export const CLIP_MIN_LABEL_WIDTH = 24;   // below this, drop the name
export const CLIP_MIN_RENDER_WIDTH = 2;   // a clip is never painted narrower than this
export const CLIP_MIN_HIT_WIDTH = 6;      // its pointer target is never narrower than this

export const SNAP_THRESHOLD_PX = 8;           // SCREEN px
export const SNAP_THRESHOLD_MAX_FRAMES = 30;  // hard cap; see below
/** px per frame. ZOOM_MIN fits ~108k frames (1 hour at 30fps) in a 2160px lane. */
export const ZOOM_MIN = 0.02, ZOOM_MAX = 40, ZOOM_STEP = 1.25;

export const PLAYHEAD_TAIL_FRAMES = 300;  // how far past the last clip the playhead may park
export const SHUTTLE_REVERSE_MAX_SEEKS_PER_SEC = 15;

/** Timeline motion — DESIGN.md §5's "instrument, not software" exception, made reproducible.
    useReducedMotion() zeroes all four; snapping still lands, instantly. */
export const SCRUB_MOMENTUM_DECAY = 0.94;      // per animation frame
export const SCRUB_MOMENTUM_CUTOFF_PX = 0.5;   // below this velocity, stop
export const DRAG_INERTIA_MS = 120;
export const SNAP_MAGNET_CURVE = 'ease-out';   // maps to var(--ease-out)

export const RESIZER_HIT = 5, RESIZER_KEY_STEP = 16;
export const HISTORY_LIMIT = 100;
export const DND_MEDIA_MIME = 'application/x-editor-media';   // payload: MediaId
export const DND_CLIP_MIME  = 'application/x-editor-clip';    // reserved; NOT used (see §8.5)
export const LS_UI_KEY = 've.ui.v1';

/** Output container per codec. The export dialog needs it to show the final filename. */
export const CONTAINER: Record<ExportSettings['codec'], string> =
  { h264: 'mp4', h265: 'mp4', prores: 'mov' };
```

`ZOOM_MIN` was raised from 0.002: at that value one pixel was 500 frames, `SNAP_THRESHOLD_PX / zoom`
resolved to 4000 frames (over two minutes at 30 fps), and a 60-frame clip rendered 0.12 px wide.
The snap threshold is now `Math.min(SNAP_THRESHOLD_PX / zoom, SNAP_THRESHOLD_MAX_FRAMES)`, and clip
geometry is `max(framesToPx(duration, zoom), CLIP_MIN_RENDER_WIDTH)` for paint with a transparent
hit area widened to `CLIP_MIN_HIT_WIDTH` — so a very short clip stays visible and selectable rather
than vanishing well before the documented 24 px label-drop threshold.

### 7.4 The accent budget — four families, six uses, closed

DESIGN.md's Three Uses Rule and its track-heads section contradict each other ("A fourth use is a
bug" vs "Active toggles take the accent"). Per S1 in the preamble, **this section is the
resolution**: the accent marks **time indication, selection (including focus, which is keyboard
selection), active toggle state, and the one primary action** — four families, and within them
exactly these six uses. **Six is the ceiling.** A use not on this list is a bug; report it rather
than adding one.

| # | Family | Use |
|---|---|---|
| 1 | Time | The timeline playhead line (`--z-playhead`) and its ruler marker (`--z-playhead-head`) |
| 2 | Time | The snap guide line — same family; it is a time indicator, not decoration |
| 3 | Selection | The selection outline on timeline clips (1.5 px, `outline-offset: -1.5px`) |
| 4 | Selection | The `:focus-visible` ring, anywhere (focus is selection; see the §5 inset exception) |
| 5 | Active toggle | Track-head mute / lock / visibility toggles, via `accentWhenPressed` |
| 6 | Primary action | The one primary action per view — in this build the **Export** button inside `ExportDialog`, and nothing else. The media rail's Import button is `secondary`. |

**Not permitted, explicitly:** the play button; panel headings; the media-rail row highlight; the
dirty indicator; progress bars; track labels; hover states; the titlebar; the marquee rectangle;
the file-drop target; the snap toggle's pressed state; the transport mute toggle's pressed state;
the rail-collapse toggle's pressed state; any `IconButton` that has not set `accentWhenPressed`.

The file-drop border was previously permitted and is **withdrawn**: it has no backing in DESIGN.md,
it is the single largest accented area in the app when it fires, and a full-window accent border is
precisely the "never a background for large areas, never a border on a resting element" case
DESIGN.md rules out. Its replacement is in §7.7.

### 7.5 Borders and the 3:1 non-text floor

Three border tokens, three different jobs. Using the wrong one is the most likely way to fail an
accessibility requirement without noticing.

- **`--border-hairline`** — decorative region marker only: the divider between a panel and its
  heading, gutters, the separator inside a `Menu`. Measured at 2.3:1 over `--surface-chrome`; it
  **cannot** reach 3:1 against any plane in this ramp and is **explicitly exempt**, because it never
  carries meaning that PRODUCT.md names. It is forbidden on anything in the list below.
- **`--border-hairline-strong`** — the underline on a `surface='well'` field, and dividers *inside*
  a region. Measured over the rendered tokens it is **1.64 / 1.63 / 1.52:1 over chrome**,
  **1.67 / 1.67 / 1.53:1 over panel** and **1.46 / 1.46 / 1.01:1 over well** (signal / instrument /
  daylight). The "3.65:1 over chrome, 3.36:1 over panel" figures printed here previously were wrong
  by roughly 2.2×; an alpha wash at 0.16 (0.18 in daylight) cannot reach 3:1 against any plane in
  this ramp, for the same reason `--border-hairline` cannot. **It is therefore no longer the carrier
  for a major-region boundary.** The boundaries between major regions — titlebar ↔ body, rail ↔
  preview, preview ↔ inspector, preview ↔ timeline — carry `--border-structural`, because the
  chrome → panel plane step is only 1.12 / 1.10 / 1.09:1 and an invisible rule on top of it leaves
  the first screen reading as one undifferentiated sheet. In `daylight` it is worse than invisible:
  hairline-strong over `--surface-well` measures 1.01:1, so the preview region had no edge at all.
- **`--border-structural`** — a **solid** token, not an alpha wash, verified ≥3:1 against `chrome`,
  `panel` **and** `raised` in all three themes (§7.1 table). This is the only border permitted on
  anything PRODUCT.md names at the 3:1 floor.

PRODUCT.md: *"Non-text UI (track boundaries, clip edges, focus rings, control borders) ≥3:1."*
DESIGN.md's Audit Test says to fix the tonal step rather than add a border — but no step inside a
ramp spanning 0.10–0.31 reaches 3:1 (chrome→raised is 1.33:1), and in `daylight` an alpha hairline
over a near-white surface reaches 1.2:1. The accessibility floor outranks the Audit Test (S3 in the
preamble). Therefore, normatively:

| Element PRODUCT.md names | Carrier |
|---|---|
| Clip edges | 1 px `--border-structural` **border** (not outline — see the three-layer table in §5) on every clip |
| Track lane boundaries | 1 px `--border-structural` bottom rule per lane |
| Major-region boundaries (titlebar ↔ body, rail ↔ preview, preview ↔ inspector, preview ↔ timeline) | 1 px `--border-structural` |
| Focus rings | `--accent`, already ≥4.3:1 on every plane in every theme |
| Control borders (`InlineNotice`, error state, marquee, resizer-on-hover) | `--border-structural`, or the status colour where §7.6 specifies one |

`--border-structural` measures 4.09 / 4.18 / 3.64:1 on `--surface-chrome`, 3.66 / 3.80 / 3.96:1 on
`--surface-panel`, 3.07 / 3.16 / 3.31:1 on `--surface-raised` and 4.79 / 4.80 / 5.09:1 on
`--surface-well`. `raised` is the marginal one — the signal theme sits 0.07 above the floor. It is
measured, deliberate, and must be re-verified if any of those values ever changes.

**Known, accepted: the plane ramp is not monotonic in `daylight`.** `panel` is `oklch(1 0 0)`, so
`raised` (0.94) is necessarily *darker* than the plane it sits above — §7.1 already states this
("it inverts the ramp"), and there is no headroom above pure white to fix it. Depth in `daylight` is
therefore read from the boundary rules and from the near-black well, not from "lighter = closer".
Nothing here may be "corrected" by moving a palette value: `--surface-panel-hover` is pinned 0.03
clear of `--surface-raised` (§7.1) and widening the chrome → panel step collapses that clearance.

### 7.6 Status, textures, and clip state encoding

**Status colour is never a text colour.** Not `--status-danger`, not `--status-warning`, in any
theme, on any plane. DESIGN.md verifies danger at 4.63:1 on *panel* only and warns to check against
*raised*, where it falls to ~3.8:1 — below the 4.5:1 body/label floor, and the media row's error
message sits on exactly that surface. So: **message text is always `--text-ink`**, and the status
colour appears only as an **icon**, a **1–2 px border or bar**, or a **fill behind
`--text-on-danger` / `--text-on-warning`**. This removes the need for a lightened
`--status-danger-text`, which would have collided with `--accent` in lightness and violated the
Lightness-First Rule.

Every status presentation is **icon + word + colour, in that order** (DESIGN.md, The Icon Tax Rule):

| State | Icon | Word | Colour role |
|---|---|---|---|
| Media file missing (`not-found`) | `Unplug` | `Offline` | 1 px `--status-danger` border on the row |
| Media `unsupported-codec` / `probe-failed` / `ffmpeg-missing` | `AlertCircle` | `Error` | 1 px `--status-danger` border on the row |
| Media fps or resolution mismatch | `TriangleAlert` | `Mismatch` | 1 px `--status-warning` border on the row |
| Export failed | `AlertCircle` | `Export failed` | `InlineNotice` tone `danger` |
| Save / open failed | `AlertCircle` | `Save failed` / `Could not open` | `InlineNotice` tone `danger` |

`--status-warning` now has exactly one owner — the media row's `MediaWarning[]` (§3.2 step 6) — so
it is neither a dead token nor a guess. Codec *failure* stays `danger`; format *mismatch* is the
warning, which is what DESIGN.md means by "codec mismatch".

**Clip state is carried by texture first, icon second, hue third.** DESIGN.md §5 requires muted,
locked and offline to be non-chromatic, and the fixture data is required to contain clips narrower
than 24 px — where a 14 px icon does not fit either, leaving hue as the only signal. Textures are
the one channel that survives to 8 px of clip width, so:

| Clip state | Texture | Icon (≥24 px only) | Hue |
|---|---|---|---|
| Track locked | `--texture-locked` (135° hatch, 3/6) | `Lock` | none |
| Track muted | `--texture-muted` (90° pinstripe, 2/3) | `VolumeX` | none |
| Media offline | `--texture-offline` (45° hatch, 4/8) | `Unplug` | the clip's 1 px structural **border colour** swaps to `--status-danger` — not an extra layer |
| Media warning | `--texture-warning` (0° rule, 3/4) | `TriangleAlert` | none |

The four textures differ in **angle and pitch**, not only in density, so they are distinguishable
from each other at a glance and under every colour-vision deficiency.

**The degrade order is fixed and normative.** As a clip narrows:

1. below `CLIP_MIN_LABEL_WIDTH` (24 px) — **the name drops** first;
2. below ~16 px — **the state icon drops**;
3. **the texture never drops**, at any width down to `CLIP_MIN_RENDER_WIDTH`;
4. the thumbnail strip drops with the name.

Texture is last out, because it is the only signal that still reads at 8 px.

### 7.7 The remaining named surfaces

**Marquee (selection rectangle, `--z-marquee`).** 1 px `--border-structural` border, fill
`--scrim`. **Explicitly not accent** — it is a transient gesture affordance, not a selection state,
and it is on §7.4's not-permitted list. No radius, no shadow, no animation.

**Resizers (`--z-resizer`).** Invisible at rest (the gutter is `--surface-chrome`); on hover and
while dragging, a 1 px `--border-structural` line down the centre of the `--resizer-hit` (5 px)
target. Keyboard-operable and therefore fully labelled: `role="separator"`,
`aria-orientation="vertical"` (rail) / `"horizontal"` (timeline), `aria-valuenow` / `aria-valuemin`
/ `aria-valuemax` in the same unit as the underlying state, `aria-label` of `Media rail width` /
`Timeline height`, `tabindex={0}`, arrow keys move by `RESIZER_KEY_STEP` (16), Home/End jump to
min/max, and the standard +2 px focus ring. Shell-owned, both of them.

**File-drop affordance (`--z-drop-overlay`).** Replaces withdrawn accent use 7. A 2 px
`--border-hairline-strong` inset border on a `--surface-panel` overlay, with the `FolderInput` icon
and the label `Drop video or audio files` in `--text-ink`. It already carries an icon and a word, so
it needs no hue. Media-owned, driven by `media.dropActive`.

**Progress bars** (media-row import progress, export dialog progress). Trough: 2 px tall,
`--border-structural`, `--radius-sm`, on whatever plane the host sits on — the media row's
`--surface-raised`, the dialog's `--surface-panel`. Fill: `--text-ink`. **Never `--surface-well`**
(§7.0) and never `--accent` (§7.4). Both are determinate; the percentage is stated as a
`.type-numeric` numeral beside the bar, so the bar is never the only signal.

**Dirty indicator.** `--text-muted`, rendered as a `•` suffix on the project name in the titlebar —
not a free-floating dot. A bare dot is a state with no word and no accessible name. The titlebar
region's accessible name reads `<project name>, unsaved changes` when `isDirty`, and its tooltip
reads `Unsaved changes`. Costs no pixels.

---

## 8. Integration risks and the contracts that prevent them

### 8.1 Composition — what `App.tsx` renders

The shell slice writes `App.tsx`; the other slices must export exactly these names from exactly
these paths, all taking **no props** and reading the store themselves:

```tsx
import { MediaRail }       from './components/media/MediaRail';        // media
import { PreviewWell }     from './components/preview/PreviewWell';    // preview
import { Timeline }        from './components/timeline/Timeline';      // timeline
import { Inspector }       from './components/inspector/Inspector';    // inspector
import { ExportDialog }    from './components/export/ExportDialog';    // inspector
import { ShortcutOverlay } from './keyboard/ShortcutOverlay';          // inspector
import { useShortcuts }    from './keyboard/useShortcuts';             // inspector
```

`App.tsx` mounts `ThemeProvider` as the outermost element, calls `useShortcuts()` once at the root,
and renders `<ExportDialog />` and `<ShortcutOverlay />` unconditionally at the end of the tree —
they read `ui.exportDialogOpen` / `ui.shortcutOverlayOpen` and render `null` when closed. The shell
does **not** conditionally mount them and does **not** pass them open/close props.

`<Inspector />` is the exception: the shell mounts it only when `selectInspectorVisible(s)` is
true and owns the `var(--dur-panel)` transform/opacity entry animation and the `--inspector-width`
sizing. `Inspector` itself renders at `width: 100%; height: 100%` with no animation, no width, and
no mount condition of its own. Two animations here would double up; one owner only.
**The duration is written as `var(--dur-panel)`, never as a literal `200ms`** — a literal survives
the `prefers-reduced-motion` block's custom-property overrides.

**Panels:** per §5 and §7.0, the shell renders **bare containers**. It never wraps a slice component
in a `Panel`. `MediaRail` and `Inspector` each render exactly one; `Timeline` and `PreviewWell`
render none. Getting this wrong throws on first render, at integration — which is the failure mode
this document exists to prevent.

The shell also puts `data-shortcut-scope` on each region container (§8.10) and owns both resizers
(§7.7).

Risk if violated: the inspector never appears, or appears with a doubled transition, or the app
throws `Nested panels are forbidden`. Contract: **mounting and chrome are the shell's, contents are
the slice's.**

### 8.2 Token drift — the highest-risk item in the build

Five agents inventing `--color-panel`, `--bg-panel`, `--panel-bg` produces an app that looks
half-dead and nobody notices until integration. Contract: §7 is the complete list. No slice adds
a custom property to `:root`. A slice may define a **locally scoped** variable on its own root
element (`--clip-x`, `--rail-w`) for layout maths; it may not define a colour. Before finishing,
each agent greps their own files for colour literals and for `--` names not in §7.

### 8.3 The playhead has exactly one owner

`playbackSlice.playhead` is the only playhead, it lives in the store (§1.3), and it is an integer.
The timeline reads it and writes it via `seek()` when scrubbing the ruler or dragging the head. The
timeline must not keep a shadow copy, must not store a scrub position, and must not advance it
during playback. The preview owns advancement.

The timeline's playhead line and ruler marker are positioned **imperatively** through one
`useEditorStore.subscribe(s => s.playhead, cb)` that writes `transform: translate3d(x,0,0)` on both
elements. They do not re-render.

Symmetrically, the preview never reads `zoom` or `scrollX` and never writes to `timelineSlice`.

Risk: two sources of truth drift by a frame and the playhead visibly desynchronises from the
image. Contract: **frames, one field, `seek()` is the only writer besides the clock.**

### 8.4 One rAF loop

`PreviewWell` mounts `usePlaybackClock()`, and it is the only `requestAnimationFrame` loop that
advances the playhead in the app.

**The source-mapping invariant from §2.4 is restated here because this is where it is used, and it
is the expression three slices must agree on:**

```ts
const clip = /* selectVideoClipIdAtFrame -> clips[id] */;
const clipFrame  = playhead - clip.start;                                  // 0 .. duration-1
const sourceFrame = clip.mediaIn + clipFrame * clip.properties.speed;
video.currentTime = framesToSeconds(sourceFrame, state.fps);               // PROJECT fps
video.playbackRate = clip.properties.speed * Math.abs(state.rate);
// and the inverse, when deriving the playhead from the element:
const playhead = clip.start + Math.round(
  (secondsToFrames(video.currentTime, state.fps) - clip.mediaIn) / clip.properties.speed
);
```

`mediaIn` and `duration` are both PROJECT frames; `MediaItem.fps` never appears in this maths.
Source consumption is `mediaIn + Math.round(duration * speed) <= media.durationFrames`.

Loop rules:

- **Forward playback with a playable `<video>` (`rate > 0`, `url !== ''`):** the loop reads
  `video.currentTime` each frame and derives the playhead with the inverse expression above. It does
  **not** integrate wall-clock time. This is what keeps hour-long playback accurate.
- **Not playable (`url === ''`, the fixture case):** integrate `performance.now()` deltas at
  `rate * fps` against a stored anchor, and re-anchor on every `seek`.
- **Reverse shuttle (`rate < 0`):** `HTMLMediaElement.playbackRate` does not accept negative values
  in Chromium, so there is no element-driven reverse path and the loop must not pretend there is.
  The element is **paused**, the loop integrates wall-clock backwards at `|rate| * fps`, calls
  `seek()`, and `VideoSurface` sets `video.currentTime` per frame from the new playhead —
  rate-limited to `SHUTTLE_REVERSE_MAX_SEEKS_PER_SEC` (15) so seeking does not thrash the decoder.
  Reverse is therefore a stuttering scrub, not smooth playback; that is the honest capability of
  this build and J must not silently no-op.
- **Stopping:** before writing, compare against `selectPlaybackStopFrame` (§3.3). If the next frame
  would reach or pass it, call `pause()` and `seek(stop - 1)`. Nothing loops.
- It writes with `readStore().seek(frame)` and only when the integer frame actually changed
  (guard: `if (next !== readStore().playhead)`), so a paused editor performs zero renders.
- `cancelAnimationFrame` in the effect cleanup, and a `pause()` on unmount. No `setInterval`.

**Compositing scope, stated so preview and timeline cannot assume differently:** this build
composites **the topmost visible video clip only**. `opacity`, `scale`, `positionX/Y` and `rotation`
apply to that single clip against the well background. Multi-track compositing, blending and
transitions are **out of scope**, which is why the preview reads one `selectVideoClipIdAtFrame` and
mounts one `<video>`. `Track.visible` selects which clip is topmost; it does not blend.

The timeline may run its own rAF for *drag rendering* (transform writes), but that loop must never
touch the store.

> **Amended by audio monitoring** (`docs/AUDIO-MONITOR.md`, which is normative for the detail).
> Three things this section predates:
>
> 1. **The audio monitor is a SUBSCRIBER to this loop, not a second one.** `PreviewWell` also mounts
>    `useAudioMonitor()`, which plays every audible clip the pooled `<video>` is not carrying through
>    per-track `<audio>` pairs. It runs from `useEditorStore.subscribe(s => s.playhead, …)` — driven
>    by the tick above, at most once per advanced frame — and schedules no animation frames of its
>    own. It **reads** the playhead and never writes it, so §8.3's single-owner rule is untouched: it
>    calls no transport action and exports no setter. `grep -rl 'requestAnimationFrame'
>    src/components/preview/` must still return exactly one path.
> 2. **The `<video>` element's volume is the full gain law, not the master volume alone.** The
>    element carries the clock clip's own audio and nothing else carries it, so it is a gain consumer
>    under the same expression as every voice: clip volume, track mute, master volume, master mute,
>    and a transport term that mutes it at 8× shuttle. Before this, a video clip set to `volume: 0`
>    or sitting on a muted track monitored at full level and exported silent.
> 3. **The pool is keyed on the CLIP ID, with a source-contiguity exception — not on the URL.** Two
>    clips cut from one source file on one track share a URL, so a url-keyed pool never swaps at that
>    cut. `derivePool` now lives in `src/components/preview/audioMonitor.ts` and serves both surfaces,
>    and `VideoSurface`'s `playable` is defined in terms of the active slot's clip id. That
>    definition is load-bearing for the inverse expression above: it is what keeps `activeVideoRef`
>    null while the pool is stale, so `frameFromElement` does not map the outgoing source's clock
>    onto the incoming clip.

### 8.5 Two drag systems in one region

The timeline is both an HTML5 drop target and a pointer-events manipulation surface. They must not
see each other.

- **File drop (OS → app):** HTML5 `dragenter`/`dragover`/`drop` on the window. Handler runs only
  when `event.dataTransfer.types.includes('Files')`. Media slice owns the window-level listeners
  and `dropActive`. Paths resolve through `media.pathForFile` (§3.2), never `file.path`.
- **Media rail → timeline:** HTML5 drag with `dataTransfer.setData(DND_MEDIA_MIME, mediaId)` plus
  a custom drag image. The timeline's drop handler runs only when
  `types.includes(DND_MEDIA_MIME)`, and calls `insertMediaAt(mediaId, frameAtPointer, trackAtPointer)`.
- **Clip manipulation inside the timeline:** `pointerdown` / `setPointerCapture` /
  `pointermove` / `pointerup` **only**. It must never call `draggable`, never set
  `dataTransfer`, and must `preventDefault()` on `dragstart` within the lane area. `DND_CLIP_MIME`
  is declared but deliberately unused — internal clip drags do not use HTML5 DnD at all.
- `dropActive` is set on `dragenter` with `Files` and cleared on `dragleave` **counted with a
  depth counter** (dragleave fires on every child), on `drop`, and on `dragend`.

Risk: dragging a clip lights up the drop affordance across the whole window. Contract: the
`Files` type check plus pointer-events-only internal drags.

### 8.6 Frames vs pixels vs seconds, and the timeline render topology

`zoom` is **pixels per frame**, always. Not px/second, not a zoom "level", not a log scale.
`scrollX` is px and is stored, not read from `element.scrollLeft` at draw time (the ruler,
lanes and playhead must agree within one frame; reading the DOM in three places will not).

**Two expressions, two jobs — do not mix them.**

```ts
// LAYOUT: absolute position inside the lane-content element. No scrollX. Used by every clip,
// marker and ruler tick.
const x = framesToPx(frame, zoom);

// HIT-TESTING: pointer -> frame. This is the only place scrollX appears in a formula.
const frame = pxToFrames(clientX - laneRect.left + scrollX, zoom);
```

**`scrollX` is applied exactly once, as a transform on the lane-content element**, written
imperatively from `useEditorStore.subscribe(s => s.scrollX, …)`:

```css
.lane-content { transform: translate3d(calc(-1 * var(--scroll-x)), 0, 0); }
```

The earlier per-renderer formula (`framesToPx(frame, zoom) - scrollX`) required all 41 clips plus
the ruler plus every marker to subscribe to `scrollX`, so one horizontal scroll frame re-rendered
the whole timeline — which makes §8.7's "a pointermove must cause zero React renders" unachievable.
A clip re-renders when *its own* data changes and at no other time. The ruler and the lane content
share one transform write, so they cannot drift.

`SNAP_THRESHOLD_PX` converts per-evaluation and is capped:
`threshold = Math.min(SNAP_THRESHOLD_PX / zoom, SNAP_THRESHOLD_MAX_FRAMES)`.

`zoomAround` uses `pxToFramesExact` (§2.1) and rounds once at the end; using the rounding helper
inside an anchor calculation accumulates drift that is plainly visible at low zoom.

### 8.7 Selection identity and re-render cost

`selection` is a `ReadonlySet` replaced wholesale on every change. A `Clip` component subscribes
with `useEditorStore(s => s.selection.has(clip.id))` — a boolean, so only clips whose selection
actually changed re-render. Never `useEditorStore(s => s.selection)` in a leaf. Never
`Array.from(selection)` inside a selector. Same for `useEditorStore(s => s.offlineClipIds.has(id))`.

`Clip` is `React.memo` and must not receive a new object/array/function prop on every parent
render — hoist handlers to the `Track` level and pass ids through `data-clip-id` + event
delegation on the lane. The lane subscribes to `selectClipIdsInTrack` (stable reference, §3.4), so
adding a clip to track 3 does not re-render tracks 1, 2, 4, 5 and 6.

At 40 clips × 6 tracks, a pointermove must cause **zero** React renders, and a playing timeline must
cause zero renders outside the transport read-out and `VideoSurface`.

### 8.8 History scope

Undo covers `TimelineDoc` only. Consequences the other slices must respect:

- Inspector property edits go through `updateClipProperties`. A drag-scrub in a `NumericField` calls
  `beginHistory('Adjust opacity')` on `onChange`'s first fire and `commitHistory()` on `onCommit` —
  one undo step per gesture, not one per pixel. Escape fires `onCancel`, which calls
  `abortHistory()`. `onCommit` is **required** on `NumericField` precisely so this can never be left
  open; §3.4's protocol makes double-begin and orphan-commit no-ops.
- `updateClipProperties` pushes its own entry only when `historyTxn === null`.
- Media import, media removal, theme change, panel resize, zoom, scroll, selection and
  `markClipsOffline` are **not** undoable.
- Undo does not move the playhead.
- Every hydrate resets the stacks (§3.4) — Ctrl+Z after opening a project must not reach into the
  previous project.

### 8.9 The export stub boundary

`getEditorAPI().export` is `undefined` in this build. `ExportDialog` resolves its bridge once:

```ts
// src/components/export/exportStub.ts   (inspector-owned)
// TODO(export): replace with the real ffmpeg-backed bridge in electron/ipc/export.ts.
// This stub reports genuine progress for a simulated encode; the UI below it is final and
// must not change when the real bridge lands.
export const exportStub: ExportBridge;
```
```ts
const bridge = getEditorAPI().export ?? exportStub;
```

**The dialog resolves the range before calling `start`.** `ExportSettings.range` is a UI choice;
the bridge receives absolute frames, because a real ffmpeg-backed bridge cannot otherwise know where
the range begins:

```ts
const startFrame = settings.range === 'inout' && s.inPoint !== null ? s.inPoint : 0;
const endFrame   = settings.range === 'inout' && s.outPoint !== null
  ? s.outPoint + 1 : selectTimelineDurationFrames(s);
bridge.start({ ...settings, startFrame, durationFrames: Math.max(1, endFrame - startFrame) });
```

The final filename is `${filename}.${CONTAINER[codec]}` (§7.3) and is shown in the dialog, so the
estimated-size row has something to label. The dialog drives its determinate progress bar, its frame
counter and its cancel button purely from `ExportProgressEvent`. It never runs its own timer, never
interpolates, and never displays a percentage the bridge did not report. `cancel()` must actually
stop the stub and land the UI in the `cancelled` phase. `phase: 'error'` renders an `InlineNotice`
inside the dialog body (§5).

Estimated size is computed, not guessed, from a fixed table so the number is reproducible:

```ts
const BITRATE_KBPS = {
  h264:   { draft: 4000,  good: 12000, best: 24000 },
  h265:   { draft: 2500,  good:  8000, best: 16000 },
  prores: { draft: 45000, good: 82000, best: 122000 },
};
bytes = (BITRATE_KBPS[codec][quality] * 1000 / 8) * framesToSeconds(durationFrames, fps)
        * (width * height) / (1920 * 1080);
```

### 8.10 Shortcuts as the single source of truth

`src/keyboard/shortcuts.ts` exports the registry and its ids; **tooltips read from it**, so a
label can never drift from its binding.

```ts
export type ShortcutScope = 'global' | 'timeline' | 'preview' | 'media' | 'dialog';
export interface ShortcutDef {
  id: ShortcutId;
  /** Normalised combos, e.g. 'Space', 'Ctrl+Z', 'Ctrl+Shift+Z', 'Shift+ArrowLeft'.
      'Ctrl' means Cmd on darwin — resolved at render time by ShortcutHint. */
  keys: string[];
  label: string;          // sentence case, imperative: 'Split at playhead'
  scope: ShortcutScope;
  handler: ShortcutHandlerName;
}
export const SHORTCUTS: readonly ShortcutDef[];
export const SHORTCUT_BY_ID: Record<ShortcutId, ShortcutDef>;
export type ShortcutId =
  | 'play.toggle' | 'shuttle.back' | 'shuttle.stop' | 'shuttle.forward'
  | 'mark.in' | 'mark.out' | 'edit.split' | 'nav.stepBack' | 'nav.stepForward'
  | 'nav.secondBack' | 'nav.secondForward' | 'nav.start' | 'nav.end'
  | 'edit.lift' | 'edit.ripple' | 'edit.undo' | 'edit.redo'
  | 'file.import' | 'file.save' | 'view.zoomIn' | 'view.zoomOut' | 'view.zoomFit'
  | 'edit.marker' | 'edit.clearSelection' | 'help.shortcuts';
```

**How a scope becomes active — concrete, so two slices cannot assume differently.** The shell puts
`data-shortcut-scope="timeline" | "preview" | "media"` on each region's container element. On every
keydown, `useShortcuts` computes:

```ts
const el = document.activeElement as HTMLElement | null;
const active = el?.closest('[data-shortcut-scope]')
  ?.getAttribute('data-shortcut-scope') ?? null;      // null when focus is on <body>
```

A shortcut dispatches when `def.scope === 'global'`, or when `def.scope === active`. Focus
containment is the mechanism — not hover, not last-clicked. Regions are focusable containers
(`tabindex={-1}`) so clicking into one makes its scope active.

**Overlay gating and Escape routing** (Escape was triply overloaded and unresolved):

1. When `selectOverlayOpen(s)` is true — `exportDialogOpen || shortcutOverlayOpen` — **only
   `scope === 'dialog'` shortcuts dispatch.** Nothing else, including `global`, fires. Ctrl+Z does
   not reach the timeline through an open export dialog.
2. **Escape is consumed by the topmost layer, in this order**, and stops at the first one that
   handles it: (a) an open `Menu` or `Tooltip` closes; (b) a focused field with `onCancel` reverts
   and releases focus; (c) an in-flight pointer drag calls `abortHistory()` and cancels; (d) an open
   `Dialog` / overlay closes via its own `cancel` event; (e) only if none of the above applied does
   `edit.clearSelection` fire. Escape inside the export dialog therefore never clears the timeline
   selection underneath it.
3. The §5 text-input guard still applies to every other key: an event whose target matches the
   input selector is ignored unless it is Escape, which follows the ladder above.

`ShortcutHint` (inspector-owned) renders the platform-correct glyphs
(`⌘ ⇧ ⌥ ⌃` on darwin, `Ctrl Shift Alt` elsewhere) from `getEditorAPI().platform`. Other slices
pass `shortcut={<ShortcutHint id="edit.split" />}` into `Tooltip`/`IconButton` — they never
hardcode a key string in a tooltip. If a slice needs a hint for an action it owns, the shortcut id
must already exist in the registry; if it does not, report it under §0.2 rather than inventing a
local label.

`useShortcuts()` is mounted once, in `App.tsx`. It attaches one `keydown` listener on `document`,
applies the guard and the gating above, resolves the combo, and dispatches through `readStore()`.
It must not be mounted a second time by any slice.

### 8.11 The inspector overlays at every width

The inspector is non-resident — the shell mounts it only when `selectInspectorVisible(s)` is true,
which satisfies PRODUCT.md principle 2. But if it were a grid column, every selection and
deselection would change the preview's width by 280 px, animated, with `PreviewWell` re-letterboxing
through a `ResizeObserver` the whole way. Clicking through six clips would resize the video frame
six times, and PRODUCT.md principle 1 makes the frame the one stable subject on screen.

Therefore, **at every width**: `position: absolute; right: 0; top: 0; bottom: 0; z-index:
var(--z-inspector)`, over the preview region — never a grid column. The preview region reserves
`padding-right: var(--inspector-width)` **permanently**, mounted or not, so the letterbox box is
invariant across inspector state. `INSPECTOR_OVERLAY_BREAKPOINT` is deleted; there is no breakpoint
behaviour left to get wrong.

`Inspector` is width-agnostic and must not assume 280 px; it fills its container. `PreviewWell`
letterboxes against its own measured box (`ResizeObserver`), not a computed "available width".

### 8.12 IPC registration and channel names

`electron/main.ts` (scaffold) contains exactly:

```ts
import { registerMediaIpc } from './ipc/media';
import { registerProjectIpc } from './ipc/project';
registerMediaIpc(ipcMain);
registerProjectIpc(ipcMain);
```
Both must export `export function registerXIpc(ipcMain: IpcMain): void` and register **only** the
channels named in §4's `CH`. A handler registered under a name the preload does not call is dead
code; a preload call to a name no handler registered hangs forever. Import `CH` from
`../src/types/api` (§1.2 pins how that resolves) in both — never retype the string.

`media:probe` behaviour is pinned in §4.3. It must never `throw` across the bridge and never resolve
`ok` with partial data — and it must always return a `ve-media://` `url`, never `''` and never
`file://` (§1.4).

### 8.13 Track structure must exist before a drop lands

A brand-new project has no tracks, so a first drop has nowhere to go. Contract: `hydrateTimeline`
with an empty clip list still creates the default track set — `trackOrder` = `V2, V1, A1, A2`, with
video indices 2 and 1 and audio indices 1 and 2, heights seeded from `TRACK_HEIGHT_VIDEO` /
`TRACK_HEIGHT_AUDIO` — and `insertMediaAt` adds a track when every track of the right kind is
occupied or locked at the target frame. A video track added that way appears at `trackOrder` index 0
with `index = maxVideoIndex + 1` (§2.4), and the clip lands in it. The timeline's "media exists,
nothing placed" state therefore always has lanes to show.

### 8.14 Empty-state and error-presentation ownership

Only one empty state exists in the app, and it is the media rail's. The preview well shows the
bare surface (no icon, no text) when nothing is loaded; the timeline shows its lane structure plus
one muted line. Neither may add a heading, an illustration, or a call to action. If two slices
each ship an empty state, the first screen becomes a sales page, which PRODUCT.md principle 5
forbids outright.

Errors are the symmetric case and now have the same discipline: **one primitive (`InlineNotice`),
three host sites, one notice at a time** (§5). No toast stack, no notification centre, no status
tile row — PRODUCT.md forbids dashboard grammar, and five agents each inventing an error surface is
exactly how that grammar arrives.

### 8.15 The inspector's contents — grouping and the project row

`ClipProperties` has seven fields. Seven always-open numeric rows in a 280 px column is a miniature
of the named anti-reference ("every panel, every scope, every inspector visible at once"), and
PRODUCT.md principle 2 names *a named disclosure* as the mechanism. The inspector therefore renders
named, collapsible groups, in this order:

| Group | `InspectorGroupId` | Contents | Default |
|---|---|---|---|
| Project | `project` | Frame rate, Width, Height — **shown only when `selection.size === 0`** | open |
| Transform | `transform` | Scale, Position X, Position Y, Rotation | open |
| Blend | `blend` | Opacity | closed |
| Time and sound | `timeAndSound` | Speed, Volume | closed |

Group headers use title type; the collapse control is a real button with the standard focus ring and
`aria-expanded`. Open/closed state persists via `ui.inspectorGroups` in `ve.ui.v1` (§3.1).

The `Project` group is the "corrected inline later" path PRODUCT.md's modal-first anti-reference
requires (§3.3). It is reachable with an empty selection through `ui.inspectorPinned`, which the
titlebar overflow menu's `Project settings` item toggles. Changing `Frame rate` calls
`setProjectFps`, which may report trimmed clips through `setNotice`. When a selection exists, the
`Project` group is not rendered — the inspector is about the selection then.

`Speed` deserves its own note: per §2.4 invariant 4 it rescales `duration`, so its `onCommit` must
handle a `{ ok: false }` result and revert the field, showing the reason through the field's `error`
prop (`End of source media` / `Blocked by <clip name>`).

### 8.16 The timeline toolbar

`setSnapEnabled`, `zoomToFit`, `setZoom`, `addMarker` and `splitAtPlayhead` had shortcuts and no
control, which makes them keyboard-only and undercuts PRODUCT.md principle 3 ("the UI teaches them
passively — shortcut hints live on the controls themselves"). The surface is named here so it is not
invented: **`src/components/timeline/TimelineToolbar.tsx`, timeline-owned**,
`--surface-chrome`, `--timeline-toolbar-height` (32 px), a single row of `size='sm'` `IconButton`s,
each with `shortcut={<ShortcutHint id="…" />}`:

`Scissors` (`edit.split`) · `Bookmark` (`edit.marker`) · `Magnet` (snap toggle, `pressed` **without**
`accentWhenPressed`) · zoom out / zoom in / fit (`view.zoomOut`, `view.zoomIn`, `view.zoomFit`) ·
the current zoom as a `.type-numeric-sm` read-out in `--text-muted`.

It renders no `Panel` (§7.0) and defines no layout constant of its own.

---

## 9. Definition of done, per slice

- No colour literal, no `z-index` number, no custom property outside §7, no literal transition
  duration.
- Every interactive element: all seven states, an accessible name, and a visible focus ring —
  including timeline clips, track heads, resizers and menu items.
- Every `disabled` control carries a `disabledReason`.
- Every live numeral: `.type-numeric` or `.type-numeric-sm`, including ruler marks.
- Every status: icon **and** word before colour; no status colour used as text.
- Every transition: `var(--dur-…)` with `var(--ease-out)`, and a reduced-motion path;
  `useReducedMotion()` consulted wherever logic (not just styling) depends on motion.
- Sentence case; uppercase only in `Track.label`.
- Runs under `npm run dev:web` with `bootstrapFixtures()` and renders fully populated.
- Runs under `npm run dev` in Electron, with real media playing through `ve-media://`.
- `tsc --noEmit` clean against the other four slices' declared exports.
- Keyboard-only walkthrough of the slice completes without a trap, and Escape behaves per §8.10.
- **The slice's region has been eyeballed in all three themes**, `signal`, `instrument` and
  `daylight`, via the titlebar `Theme` submenu. Shell additionally verifies that the switch itself
  works and that no region falls back to `signal`'s palette.
- Every array-returning selector the slice calls is either inside `readStore()` or wrapped in
  `useShallow`; a pointermove causes zero React renders at 40 clips × 6 tracks.
