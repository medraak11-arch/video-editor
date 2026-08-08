/* ---------------------------------------------------------------------------
   mediaSlice.ts — OWNER: media.

   The media library and the whole import path. PLAN §3.2.

   Import flow, exactly (PLAN §3.2):
     1. addItem immediately as 'probing' — the row appears at once.
     2. probe each path through a pool capped at PROBE_CONCURRENCY (never
        Promise.all an unbounded list: 40 files must not stall the UI or the
        ffmpeg host). The same pool serves hydrateMedia's re-probe on open.
     3. ok  -> status 'ready', ProbeData spread in (INCLUDING `url` — that is
              the assignment that makes real media playable), durationFrames
              derived from the PROJECT fps.
     4. err -> status 'error' + MediaError. The row renders icon + word +
              hairline and offers Retry / Remove (PLAN §7.6).
     5. the first ready video item adopts the project format — this is how fps
        and resolution get set without a setup modal.
     6. every later ready item is compared against the project format and
        carries a MediaWarning per mismatch. This is the sole owner of
        --status-warning in the build.
     7. markDirty — via addItem, which is on PLAN §3.1's dirty list.

   Renaming a file on disk (RENAME.md) lives here too, because it is one
   `updateItem` plus the protocol that makes that update safe: detach every
   <video> holding the source, call the bridge, then land the new path/url/name
   on EVERY row that pointed at that file — or put the old url back. It marks the
   project dirty and pushes NO history entry: `history` is a stack of TimelineDoc
   snapshots, and a filesystem side effect inside it would mean a Ctrl+Z issued
   to undo a trim silently renamed a file back.

   Browser (no window.editorAPI, no filesystem path): a dropped File is read
   through an object URL and a media element, so `npm run dev:web` exercises the
   real drop path rather than a stub. PLAN §3.2: never `(file as any).path`.
--------------------------------------------------------------------------- */

import type { ProbeResult, RenameError, RenameResult } from '../types/api';
import type {
  MediaId,
  MediaItem,
  MediaKind,
  MediaStatus,
  MediaWarning,
  PersistedMediaItem,
} from '../types/model';
import type { SliceCreator, StoreState } from './types';
import { getEditorAPI } from '../lib/editorApi';
import { newId } from '../lib/id';
import { checkBaseName } from '../lib/filename';
import { secondsToFrames } from '../lib/time';

/* ------------------------------------------------------------------- types */

/**
 * A rename in flight, and the last one that failed. RENAME.md asks for a
 * `renaming` MediaStatus; this slice keeps it BESIDE `MediaItem.status` instead,
 * because `status` is the field `offlineClipIds` projects (see `updateItem`) and
 * the field `PersistedMediaItem` drops on save. A fourth member of that union
 * would have to be handled by every `status === 'error'` guard, by the timeline's
 * offline projection and by the export document builder — none of which are in
 * this feature's blast radius — to express something that lasts 40ms and is
 * owned entirely by the media rail. See the final note in §Renaming below.
 */
export interface RenameUiState {
  /** True from the moment the source is detached until the bridge answers. */
  busy: boolean;
  /** The last failure, verbatim from main. Cleared when the next attempt starts. */
  error: RenameError | null;
}

export interface MediaState {
  items: Record<MediaId, MediaItem>;
  /** Insertion order, drives rail row order. */
  order: MediaId[];
  /** True while a file drag from the OS is over the window. Drives the drop affordance. */
  dropActive: boolean;
  /** Per-row rename state. An absent entry is idle and clean. */
  renames: Record<MediaId, RenameUiState>;
  /**
   * True while an export job is running. RENAME.md §Edge cases blocks renaming
   * for its duration: the graph builder reads source paths when it starts, so a
   * file that moves underneath it fails the encode halfway through.
   */
  exportRunning: boolean;
}

export interface MediaActions {
  /** Opens the native picker (or the fixture picker) and imports the result. */
  importFromPicker(): Promise<void>;
  /** Electron path: absolute fs paths. */
  importPaths(paths: string[]): Promise<void>;
  /** Browser/DnD path. Resolves each File to a path via the bridge. */
  importFiles(files: File[]): Promise<void>;
  addItem(item: MediaItem): void;
  updateItem(id: MediaId, patch: Partial<MediaItem>): void;
  /** Does not delete clips: calls get().markClipsOffline(id). */
  removeItem(id: MediaId): void;
  retryItem(id: MediaId): void;
  /**
   * Renames the real file on disk and lands the result on every row that pointed
   * at it. RENAME.md §The file-lock problem, in full: detach, call, re-attach.
   * Never throws, never pushes a history entry, marks the project dirty on
   * success. `baseName` EXCLUDES the extension.
   */
  renameMedia(id: MediaId, baseName: string): Promise<RenameResult>;
  /** Drops a row's inline rename error without starting another attempt. */
  clearRenameError(id: MediaId): void;
  /**
   * Idempotent, called from the mount of anything that offers rename. Attaches
   * the one export-progress listener that maintains `exportRunning`; the export
   * dialog owns no store state, so this is the only signal a slice can read.
   */
  watchExportActivity(): void;
  setDropActive(active: boolean): void;
  /** Re-derives durationFrames for every item after a project-fps change. */
  recomputeMediaDurations(fps: number): void;
  /** Inserts as 'probing', then re-probes by path. */
  hydrateMedia(items: PersistedMediaItem[]): void;
}

export type MediaSlice = MediaState & MediaActions;

/* --------------------------------------------------------------- constants */

/** PLAN §3.2 step 2. Probing 40 files must not stall the UI or the ffmpeg host. */
const PROBE_CONCURRENCY = 3;

/** Only used to guess `kind` for the optimistic row; the probe is authoritative. */
const AUDIO_EXTENSIONS = new Set([
  'wav', 'mp3', 'aac', 'm4a', 'flac', 'ogg', 'oga', 'opus', 'aiff', 'aif', 'wma', 'caf', 'mka',
]);

/** How far apart two frame rates may sit before it is worth telling the user. */
const FPS_EPSILON = 0.05;

/* ----------------------------------------------------------------- helpers */

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : Number.isFinite(n) ? n : 0);

const basename = (p: string): string => {
  const parts = p.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : p;
};

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

const guessKind = (name: string): MediaKind =>
  AUDIO_EXTENSIONS.has(extensionOf(name)) ? 'audio' : 'video';

/** 29.97 stays 29.97; 30.000 reads as 30. */
const formatFps = (fps: number): string => String(Number(fps.toFixed(3)));

const isObjectUrl = (url: string): boolean => url.startsWith('blob:');

/**
 * A browser-imported row's `path` is the bare File name — there is no
 * filesystem path to hand the bridge. An Electron path always carries a
 * separator, so this tells the two apart without a new field on MediaItem.
 */
const isProbeablePath = (p: string): boolean => p.length > 0 && /[\\/]/.test(p);

/**
 * Whether a row can be re-probed. A browser row cannot: re-probing it would
 * send a bare filename across the bridge, overwrite its live object URL with
 * whatever the bridge answered, and leak the blob. The rail hides Retry for
 * those rows rather than offering an action that would corrupt them.
 */
export const canRetryMedia = (item: MediaItem): boolean =>
  !isObjectUrl(item.url) && isProbeablePath(item.path);

/* ------------------------------------------------------- renaming on disk
   RENAME.md. The model work is one `updateItem` — `Clip.mediaId` is the only
   reference to a file anywhere in the document, so one row update fixes every
   clip, every thumbnail strip and the preview at once. Everything below is the
   part that is not the model: the file may be held open by the preview.       */

/** Shared identity, so the selector can answer "idle" without allocating. */
const RENAME_IDLE: RenameUiState = { busy: false, error: null };

/* The two sentences main cannot say, because on these two paths main was never
   reached. Same register as RENAME_MESSAGE in electron/ipc/media.ts: one
   sentence, sentence case, no path and no stack. */
const RENAME_GONE = 'That file could not be found on disk';
const RENAME_BRIDGE_FAILED = 'That file could not be renamed';

/**
 * Why renaming is refused, or null when it is allowed. Every string is rendered
 * verbatim as a `disabledReason` on the menu item and on the field, so each one
 * says what to do about it rather than that something is wrong.
 *
 * [stable] — returns a literal or null, so it is safe in a hook.
 */
export const selectRenameDisabledReason = (s: StoreState, id: MediaId): string | null => {
  const item = s.items[id];
  if (!item) return RENAME_GONE;
  if (s.exportRunning) return 'Not while an export is running';
  if (item.status === 'probing') return 'Not until this file has finished importing';
  if (item.status === 'error' && item.error?.code === 'not-found') return RENAME_GONE;
  // A browser-imported row is a Blob and a bare filename: there is no file on
  // any disk to rename, and sending that name over the bridge would be a
  // filesystem call against a path that means nothing.
  if (isObjectUrl(item.url) || !isProbeablePath(item.path)) {
    return 'That file was opened in the browser and has no location on disk';
  }
  return null;
};

/** The phases during which an export is holding source paths open. */
const RUNNING_EXPORT_PHASES: ReadonlySet<string> = new Set([
  'preparing',
  'encoding',
  'finalizing',
]);

/** Attached at most once per session; there is nothing to detach it from. */
let exportWatchAttached = false;

/**
 * Two rows may point at one file (RENAME.md §Edge cases), and on a Windows
 * volume they may spell it differently. `path.resolve` is a node function, so
 * the comparison is done on the string with the separator normalised.
 */
function isSameFile(a: string, b: string, platform: string): boolean {
  if (a === b) return true;
  const normalise = (p: string): string => p.replace(/\//g, '\\');
  return platform === 'win32'
    ? normalise(a).toLowerCase() === normalise(b).toLowerCase()
    : normalise(a) === normalise(b);
}

/**
 * Every media element currently holding this source. That is VideoSurface's two-element
 * pool plus AudioSurface's two elements per track in practice, but it is found by
 * source rather than by reaching into those components' refs: the pools are their
 * private business, and a rename must release the handle whoever is holding it.
 *
 * `audio` is in the query and it is load-bearing, not tidiness
 * (docs/AUDIO-MONITOR.md §8.4 change 2). After audio monitoring landed there are up to
 * twelve <audio> elements on ve-media:// sources — INCLUDING sources they merely
 * preloaded and will never play — and on Windows an open handle answers `fs.rename`
 * with EBUSY/EPERM. A `video`-only query would start failing renames with
 * `file-in-use` on files nothing is even playing.
 */
function mediaHolding(url: string): HTMLMediaElement[] {
  if (url === '' || typeof document === 'undefined') return [];
  return Array.from(document.querySelectorAll<HTMLMediaElement>('video, audio')).filter(
    (el) => el.getAttribute('src') === url,
  );
}

/**
 * RENAME.md §The file-lock problem, step 2. Clearing the attribute and calling
 * `load()` runs the media load algorithm, which aborts the fetch and drops the
 * decoder's handle on the file; without it Windows answers `fs.rename` with
 * EPERM and the user is told to close a program that is this one.
 *
 * The microtask is the spec's, and it is deliberately not a timeout: `load()`
 * does its teardown synchronously, so one turn of the queue is enough and a
 * timeout would only add latency to the common case.
 */
async function detachSources(elements: HTMLMediaElement[]): Promise<void> {
  for (const el of elements) {
    el.removeAttribute('src');
    el.load();
  }
  await Promise.resolve();
}

function pendingItem(path: string, name: string, kind: MediaKind): MediaItem {
  return {
    id: newId('m'),
    path,
    url: '',
    name,
    kind,
    status: 'probing',
    error: null,
    warnings: [],
    progress: 0,
    durationFrames: 0,
    durationSeconds: 0,
    width: 0,
    height: 0,
    fps: 0,
    codec: '',
    hasAudio: false,
    thumbnailUrl: null,
    addedAt: Date.now(),
  };
}

/* ------------------------------------------------------------- the one gate
   ONE global semaphore, not a per-call pool. Every route that spawns a probe
   goes through it — the picker, a file drop, hydrateMedia's re-probe on open,
   and Retry. A per-call pool would let ten Retry clicks start ten concurrent
   ffprobe/ffmpeg pairs, which is exactly the ffmpeg-host stall the cap exists
   to prevent.                                                               */

let probesInFlight = 0;
const probeWaiters: Array<() => void> = [];

function acquireProbeSlot(): Promise<void> {
  if (probesInFlight < PROBE_CONCURRENCY) {
    probesInFlight += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => probeWaiters.push(resolve));
}

function releaseProbeSlot(): void {
  const next = probeWaiters.shift();
  if (next) {
    next(); // the slot is handed straight over; probesInFlight is unchanged
    return;
  }
  probesInFlight -= 1;
}

/** Runs `worker` over `jobs` against the one global gate. Never rejects. */
async function pooled<T>(jobs: T[], worker: (job: T) => Promise<void>): Promise<void> {
  await Promise.all(
    jobs.map(async (job) => {
      await acquireProbeSlot();
      try {
        await worker(job);
      } catch {
        // One job must never take the others down: the remaining files would be
        // abandoned mid-import with their rows stuck on 'probing'. The row
        // itself already carries whatever error state it earned.
      } finally {
        releaseProbeSlot();
      }
    }),
  );
}

/* ------------------------------------------------- browser-only file reading
   `media.pathForFile` returns null outside Electron, so there is no path to
   probe. The file is still real, so read it the way the browser can: an object
   URL plus a media element for the metadata and one canvas frame for the
   thumbnail. Nothing here runs in the Electron path.                        */

function onceEvent(
  el: HTMLMediaElement,
  event: 'loadedmetadata' | 'seeked',
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      window.clearTimeout(timer);
      el.removeEventListener(event, ok);
      el.removeEventListener('error', bad);
    };
    const ok = (): void => {
      cleanup();
      resolve();
    };
    const bad = (): void => {
      cleanup();
      reject(new Error(`media element failed before ${event}`));
    };
    const timer = window.setTimeout(bad, timeoutMs);
    el.addEventListener(event, ok);
    el.addEventListener('error', bad);
  });
}

async function grabFrame(video: HTMLVideoElement): Promise<string | null> {
  try {
    if (video.videoWidth <= 0 || video.videoHeight <= 0) return null;
    video.currentTime = Math.min(1, (video.duration || 0) / 2);
    await onceEvent(video, 'seeked', 6000);
    const width = 320;
    const height = Math.max(2, Math.round((video.videoHeight / video.videoWidth) * width));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    return null;
  }
}

interface BrowserProbe {
  kind: MediaKind;
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
  thumbnailUrl: string | null;
}

async function readBrowserFile(url: string, kind: MediaKind): Promise<BrowserProbe> {
  if (kind === 'audio') {
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.src = url;
    await onceEvent(audio, 'loadedmetadata', 10000);
    const durationSeconds = Number.isFinite(audio.duration) ? audio.duration : 0;
    audio.src = '';
    return { kind: 'audio', durationSeconds, width: 0, height: 0, hasAudio: true, thumbnailUrl: null };
  }

  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.src = url;
  await onceEvent(video, 'loadedmetadata', 10000);
  const durationSeconds = Number.isFinite(video.duration) ? video.duration : 0;
  const width = video.videoWidth;
  const height = video.videoHeight;
  const thumbnailUrl = await grabFrame(video);
  video.src = '';
  return {
    kind: width > 0 ? 'video' : 'audio',
    durationSeconds,
    width,
    height,
    // The element cannot enumerate tracks; a video container is assumed to carry sound
    // unless it has no dimensions, in which case it is audio and certainly does.
    hasAudio: true,
    thumbnailUrl,
  };
}

/* ------------------------------------------------------------------- slice */

export const createMediaSlice: SliceCreator<MediaSlice> = (set, get) => {
  /** PLAN §3.2 step 6. Compares a ready item against the adopted project format. */
  const warningsFor = (item: {
    kind: MediaKind;
    fps: number;
    width: number;
    height: number;
  }): MediaWarning[] => {
    const s = get();
    const warnings: MediaWarning[] = [];
    if (item.fps > 0 && Math.abs(item.fps - s.fps) > FPS_EPSILON) {
      warnings.push({
        code: 'fps-mismatch',
        message: `Source runs at ${formatFps(item.fps)} fps, the project at ${formatFps(s.fps)}`,
      });
    }
    if (
      item.kind === 'video' &&
      item.width > 0 &&
      item.height > 0 &&
      (item.width !== s.width || item.height !== s.height)
    ) {
      warnings.push({
        code: 'resolution-mismatch',
        message: `Source is ${item.width}×${item.height}, the project is ${s.width}×${s.height}`,
      });
    }
    return warnings;
  };

  /** Lands a finished probe on a row. Steps 3–6. */
  const applyProbe = (id: MediaId, result: ProbeResult): void => {
    if (!get().items[id]) return; // removed while probing

    if (!result.ok) {
      get().updateItem(id, { status: 'error', error: result.error, progress: 1 });
      get().markClipsOffline(id);
      return;
    }

    const data = result.data;
    get().updateItem(id, {
      status: 'ready',
      error: null,
      progress: 1,
      kind: data.kind,
      url: data.url,
      thumbnailUrl: data.thumbnailUrl,
      durationSeconds: data.durationSeconds,
      durationFrames: secondsToFrames(data.durationSeconds, get().fps),
      width: data.width,
      height: data.height,
      fps: data.fps,
      codec: data.codec,
      hasAudio: data.hasAudio,
      warnings: [],
    });

    // Step 5: the first ready video item sets the project format. adoptSourceFormat
    // is a no-op once formatLocked, and it re-derives every duration itself.
    if (!get().formatLocked && data.kind === 'video' && data.fps > 0 && data.width > 0) {
      get().adoptSourceFormat({ fps: data.fps, width: data.width, height: data.height });
    }

    // Step 6: every item — including the one that just adopted — is measured against
    // the project format that is now in force.
    const warnings = warningsFor(data);
    if (warnings.length > 0) get().updateItem(id, { warnings });

    get().recomputeOfflineClips();
  };

  /** One row's probe, with the bridge's progress events wired to that row. */
  const probeRow = async (id: MediaId, path: string): Promise<void> => {
    const api = getEditorAPI();
    const off = api.media.onProbeProgress((e) => {
      if (e.path !== path) return;
      const item = get().items[id];
      if (!item || item.status !== 'probing') return;
      get().updateItem(id, { progress: clamp01(e.progress) });
    });
    try {
      applyProbe(id, await api.media.probe(path));
    } finally {
      off();
    }
  };

  const probeRows = (jobs: Array<{ id: MediaId; path: string }>): Promise<void> =>
    pooled(jobs, (job) => probeRow(job.id, job.path));

  /** The browser drop path: no filesystem path, so read the File itself. */
  const importBrowserFile = async (file: File): Promise<void> => {
    const kind: MediaKind = file.type.startsWith('audio/') ? 'audio' : guessKind(file.name);
    const item = pendingItem(file.name, file.name, kind);
    get().addItem(item);

    const url = URL.createObjectURL(file);
    try {
      const probed = await readBrowserFile(url, kind);
      if (!get().items[item.id]) {
        URL.revokeObjectURL(url);
        return;
      }
      get().updateItem(item.id, {
        status: 'ready',
        error: null,
        progress: 1,
        kind: probed.kind,
        url,
        thumbnailUrl: probed.thumbnailUrl,
        durationSeconds: probed.durationSeconds,
        durationFrames: secondsToFrames(probed.durationSeconds, get().fps),
        width: probed.width,
        height: probed.height,
        fps: 0, // the element cannot report a frame rate; 0 means "unknown", never used to convert
        codec: file.type,
        hasAudio: probed.hasAudio,
        warnings: [],
      });

      // Step 5 applies to this path too. Without it the very first import into
      // an empty project would be measured against the untouched 1920×1080
      // default and warn about a format the project was never given the chance
      // to adopt. `fps: 0` is the contract's "rate unknown" (FORMAT §7.3) — a media
      // element cannot report a frame rate — so only the shape is adopted and the
      // rate stays open for the first import that can actually measure one. Passing
      // get().fps here would lock the rate to a number nobody measured.
      if (!get().formatLocked && probed.kind === 'video' && probed.width > 0) {
        get().adoptSourceFormat({
          fps: 0,
          width: probed.width,
          height: probed.height,
        });
      }

      // Step 6, and only after the adoption above: the item is measured against
      // the project format that is now in force.
      const warnings = warningsFor({
        kind: probed.kind,
        fps: 0,
        width: probed.width,
        height: probed.height,
      });
      if (warnings.length > 0) get().updateItem(item.id, { warnings });
      get().recomputeOfflineClips();
    } catch {
      URL.revokeObjectURL(url);
      if (!get().items[item.id]) return;
      get().updateItem(item.id, {
        status: 'error',
        progress: 1,
        error: {
          code: 'unsupported-codec',
          message: 'This browser cannot decode the file',
        },
      });
      get().markClipsOffline(item.id);
    }
  };

  /** Writes one row's rename state; `null` returns it to idle and clean. */
  const setRename = (id: MediaId, next: RenameUiState | null): void =>
    set((s) => {
      if (next === null && s.renames[id] === undefined) return {};
      const renames = { ...s.renames };
      if (next === null) delete renames[id];
      else renames[id] = next;
      return { renames };
    });

  const failRename = (id: MediaId, error: RenameError): RenameResult => {
    setRename(id, { busy: false, error });
    return { ok: false, error };
  };

  /**
   * Step 5, and the tail of step 4. React re-attaches by itself whenever the url
   * actually changed — the store write moves `MediaItem.url`, VideoSurface's pool
   * derives a new src during render and the DOM diff sets it. It does NOT
   * re-attach when the url is unchanged (a no-op rename, or the fixture bridge,
   * which keeps serving the same file), because React compares its own previous
   * prop and sees no change: the attribute this function cleared would stay
   * cleared and the preview would sit black. So the two cases that React cannot
   * see — unchanged url, and failure — are re-attached here.
   *
   * The playhead is not touched, by anyone: VideoSurface's `loadedmetadata`
   * handler seeks the element back to whatever frame the playhead still holds.
   * Resuming `play()` is this function's job only because no store field changed
   * on these two paths, so the transport effect that would normally do it does
   * not re-run.
   */
  const reattachSources = (elements: HTMLMediaElement[], url: string): void => {
    if (url === '') return;
    for (const el of elements) {
      if (el.getAttribute('src') === url) continue;
      el.setAttribute('src', url);
      el.load();
    }
    const s = get();
    if (!s.isPlaying || s.rate <= 0) return;
    for (const el of elements) {
      // data-active is VideoSurface's published "this is the element on screen".
      if (el.dataset.active !== 'true') continue;
      void el.play().catch(() => {
        /* The element fires `error` too, and VideoSurface owns that report. */
      });
    }
  };

  return {
    items: {},
    order: [],
    dropActive: false,
    renames: {},
    exportRunning: false,

    /* ------------------------------------------------------------- import */

    importFromPicker: async () => {
      const paths = await getEditorAPI().media.pickFiles();
      if (paths.length === 0) return; // cancelled: not an error, nothing to say
      await get().importPaths(paths);
    },

    importPaths: async (paths) => {
      const clean = paths.filter((p) => typeof p === 'string' && p.length > 0);
      if (clean.length === 0) return;
      const jobs = clean.map((path) => {
        const name = basename(path);
        const item = pendingItem(path, name, guessKind(name));
        get().addItem(item); // step 1: the row appears before the probe starts
        return { id: item.id, path };
      });
      await probeRows(jobs);
    },

    importFiles: async (files) => {
      if (files.length === 0) return;
      const api = getEditorAPI();
      const paths: string[] = [];
      const browserFiles: File[] = [];
      for (const file of files) {
        const path = api.media.pathForFile(file);
        if (path) paths.push(path);
        else browserFiles.push(file);
      }
      await Promise.all([
        paths.length > 0 ? get().importPaths(paths) : Promise.resolve(),
        pooled(browserFiles, importBrowserFile),
      ]);
    },

    retryItem: (id) => {
      const item = get().items[id];
      if (!item || item.status === 'probing') return;
      // A browser row has no probeable path (canRetryMedia). Retrying it would
      // send a bare filename over the bridge and leak its object URL.
      if (!canRetryMedia(item)) return;
      get().updateItem(id, { status: 'probing', progress: 0, error: null, warnings: [] });
      // Through the pool, not around it: retrying ten failed rows must not launch
      // ten concurrent ffprobe/ffmpeg pairs at the host.
      void probeRows([{ id, path: item.path }]);
    },

    /* ------------------------------------------------------------- rename */

    clearRenameError: (id) => {
      const current = get().renames[id];
      if (!current || current.error === null) return;
      setRename(id, current.busy ? { busy: true, error: null } : null);
    },

    watchExportActivity: () => {
      if (exportWatchAttached) return;
      let bridge;
      try {
        bridge = getEditorAPI().export;
      } catch {
        return; // called before the fallback bridge was registered; a later mount retries
      }
      if (!bridge) return; // dev:web, where the dialog runs its local stub
      exportWatchAttached = true;
      const running = new Set<string>();
      bridge.onProgress((e) => {
        if (RUNNING_EXPORT_PHASES.has(e.phase)) running.add(e.jobId);
        else running.delete(e.jobId);
        const next = running.size > 0;
        if (get().exportRunning !== next) set({ exportRunning: next });
      });
    },

    renameMedia: async (id, baseName) => {
      const item = get().items[id];
      if (!item) {
        return {
          ok: false,
          error: { code: 'not-found', message: RENAME_GONE },
        };
      }

      // The gate the UI already renders as a disabledReason, restated here: an
      // action must not depend on its own affordance having been drawn correctly.
      const blocked = selectRenameDisabledReason(get(), id);
      if (blocked !== null) return failRename(id, { code: 'io-failed', message: blocked });

      // The renderer's copy of the rule (RENAME.md §Validation). Main checks it
      // again — this one exists so an illegal name never reaches the bridge and
      // never costs the preview its source.
      const check = checkBaseName(baseName, item.path);
      if (!check.ok) return failRename(id, { code: 'invalid-name', message: check.message });

      const previousPath = item.path;
      const previousUrl = item.url;

      setRename(id, { busy: true, error: null });

      // Steps 2 and 3. The detach happens whatever the outcome, so the re-attach
      // below is unconditional too.
      const held = mediaHolding(previousUrl);
      await detachSources(held);

      let result: RenameResult;
      try {
        result = await getEditorAPI().media.rename(previousPath, baseName);
      } catch {
        // The bridge contract says it never throws. If it does anyway, the
        // source still has to come back.
        result = { ok: false, error: { code: 'io-failed', message: RENAME_BRIDGE_FAILED } };
      }

      if (!result.ok) {
        reattachSources(held, previousUrl);
        return failRename(id, result.error);
      }

      // Step 4, keyed by resolved path rather than by id: two rows may reference
      // one file, and a row left holding the old path would go offline on the
      // next probe (RENAME.md §Edge cases).
      const platform = getEditorAPI().platform;
      for (const otherId of get().order) {
        const other = get().items[otherId];
        if (!other || !isSameFile(other.path, previousPath, platform)) continue;
        get().updateItem(otherId, {
          path: result.path,
          url: result.url,
          name: result.name,
        });
      }

      setRename(id, null);
      // The stored path changed, so the project is dirty — but NOTHING is pushed
      // onto `history`. RENAME.md §Undo: a Ctrl+Z issued to undo an unrelated
      // trim must never rename a file back on disk.
      get().markDirty();

      if (result.url === previousUrl) reattachSources(held, previousUrl);
      return result;
    },

    /* -------------------------------------------------------------- store */

    addItem: (item) => {
      set((s) => ({
        items: { ...s.items, [item.id]: item },
        order: s.order.includes(item.id) ? s.order : [...s.order, item.id],
      }));
      get().markDirty();
    },

    /**
     * `offlineClipIds` is a projection of MEDIA state, and `status` is the field it
     * projects — so a status write maintains it here rather than at each call site.
     * `VideoSurface.handleDecodeError` moved an item to `error` through this action
     * and every clip cut from that media stayed looking healthy, because the two
     * probe paths remembered to pair the write with `markClipsOffline` and the
     * decode path did not. `markClipsOffline` never pushes history, never marks
     * dirty and only ever adds, so it is idempotent beside the explicit calls that
     * already exist and it cannot clear the flag early on a re-probe — the
     * recompute after a SUCCESSFUL probe is what does that.
     */
    updateItem: (id, patch) => {
      let wentOffline = false;
      set((s) => {
        const prev = s.items[id];
        if (!prev) return {};
        if (patch.status === 'error' && prev.status !== 'error') wentOffline = true;
        return { items: { ...s.items, [id]: { ...prev, ...patch } } };
      });
      if (wentOffline) get().markClipsOffline(id);
    },

    removeItem: (id) => {
      const item = get().items[id];
      if (!item) return;
      if (isObjectUrl(item.url)) URL.revokeObjectURL(item.url);
      set((s) => {
        const items = { ...s.items };
        delete items[id];
        const renames = { ...s.renames };
        delete renames[id];
        return { items, renames, order: s.order.filter((existing) => existing !== id) };
      });
      // Clips are NOT deleted: they go offline and the project stays editable.
      get().markClipsOffline(id);
      get().markDirty();
    },

    setDropActive: (active) =>
      set((s) => (s.dropActive === active ? {} : { dropActive: active })),

    recomputeMediaDurations: (fps) =>
      set((s) => {
        let changed = false;
        const items: Record<MediaId, MediaItem> = { ...s.items };
        for (const id of s.order) {
          const item = items[id];
          if (!item || item.durationSeconds <= 0) continue;
          const durationFrames = secondsToFrames(item.durationSeconds, fps);
          if (durationFrames === item.durationFrames) continue;
          items[id] = { ...item, durationFrames };
          changed = true;
        }
        return changed ? { items } : {};
      }),

    hydrateMedia: (items) => {
      // The outgoing set is replaced wholesale, so any live object URL in it
      // would be leaked. removeItem revokes on the single-row path; this is the
      // same obligation on the bulk path.
      const outgoing = get().items;
      for (const id of get().order) {
        const prev = outgoing[id];
        if (prev && isObjectUrl(prev.url)) URL.revokeObjectURL(prev.url);
      }

      const next: Record<MediaId, MediaItem> = {};
      const order: MediaId[] = [];
      for (const persisted of items) {
        next[persisted.id] = {
          ...persisted,
          url: '',
          status: 'probing',
          progress: 0,
          error: null,
          warnings: [],
          thumbnailUrl: null,
        };
        order.push(persisted.id);
      }
      // Every row is replaced, so no rename error or busy flag from the outgoing
      // set describes anything that still exists.
      set({ items: next, order, renames: {} });
      get().recomputeOfflineClips();
      // Re-probe every item by path through the same capped pool as an import. This is
      // also the only way a moved or deleted file is detected (PLAN §2.6).
      void probeRows(order.map((id) => ({ id, path: next[id].path })));
    },
  };
};

/* --------------------------------------------------------------- selectors */

/** [stable] */
export const selectMediaItem = (s: StoreState, id: MediaId): MediaItem | undefined => s.items[id];

/**
 * [stable] The rename state of one row. Returns the shared idle object rather
 * than undefined, so a component can read `.busy` without a guard and a
 * subscription to it does not fire on every unrelated store write.
 */
export const selectRenameState = (s: StoreState, id: MediaId): RenameUiState =>
  s.renames[id] ?? RENAME_IDLE;

/** [stable] The rail row list. `order` is only reallocated on add/remove. */
export const selectMediaOrder = (s: StoreState): readonly MediaId[] => s.order;

/** [stable] */
export const selectMediaStatus = (s: StoreState, id: MediaId): MediaStatus | undefined =>
  s.items[id]?.status;

/** [stable] Cheap scan over `order`, returns a boolean. Safe in a hook. */
export const selectIsImporting = (s: StoreState): boolean =>
  s.order.some((id) => s.items[id]?.status === 'probing');

/** [stable] */
export const selectOfflineMediaCount = (s: StoreState): number =>
  s.order.reduce((n, id) => n + (s.items[id]?.status === 'error' ? 1 : 0), 0);

/** [UNSTABLE REFERENCE] readStore() / useShallow only. */
export const selectAllMedia = (s: StoreState): MediaItem[] =>
  s.order.map((id) => s.items[id]).filter(Boolean);

/** [UNSTABLE REFERENCE] readStore() / useShallow only. */
export const selectOfflineMedia = (s: StoreState): MediaItem[] =>
  selectAllMedia(s).filter((m) => m.status === 'error');
