/* ---------------------------------------------------------------------------
   projectActions.ts — the renderer half of 'project:save' / 'project:open',
   plus the renderer half of the data-safety work (SAFETY.md §1.9, §2.11).

   Ctrl+S routes here from the shortcut layer; the titlebar overflow menu can
   call the same two functions so there is exactly one save path and one open
   path in the app. Both are quiet on cancel and report every real failure
   through `setNotice`, which the titlebar renders as an InlineNotice (PLAN §5).

   `isDirty` is written only by the store's markDirty / markSaved. A successful
   save calls markSaved, and that is what clears the titlebar's unsaved dot.
   Autosave never touches it: writing a snapshot is not saving (SAFETY §2.10).

   `startProjectSafety()` lives here rather than in src/lib/project.ts to avoid
   an ESM value cycle — this module already imports project.ts, and the reverse
   edge would close the loop PLAN §1.1 warns about.
--------------------------------------------------------------------------- */

import { getEditorAPI } from '../lib/editorApi';
import {
  AUTOSAVE_IDLE_MS,
  AUTOSAVE_MAX_INTERVAL_MS,
  AUTOSAVE_TICK_MS,
  applyProject,
  describeProjectProblem,
  migrateProject,
  serializeProject,
  toAutosavePayload,
} from '../lib/project';
import { readStore, useEditorStore } from '../state/store';
import type { CloseSaveOutcome, DiscardChoice, EditorAPI } from '../types/api';

/** Basename without the .veproj extension. The renderer has no node `path`. */
function projectNameFromPath(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  return base.replace(/\.veproj$/i, '') || 'Untitled';
}

let saveInFlight = false;
let openInFlight = false;
let queuedOpenPath: string | null = null;

/* Module-level, NOT per-instance: <StrictMode> mounts, tears down and remounts
   startProjectSafety in development, and restarting the sequence at 0 would put
   the second instance's first writes below main's lastRetiredSeq, where they are
   silently dropped as `skipped` (SAFETY §2.6, §2.11). */
let writeSeq = 0;
let lastExplicitSaveAt: string | null = null;

/**
 * Writes the project. With no path yet — or with `saveAs` — the main process
 * opens the native save dialog. Cancelling is not a failure and says nothing.
 *
 * The return value exists for the close guard (SAFETY §1.6), which has to tell
 * "saved" from "the user dismissed the picker" from "the disk said no". Callers
 * that do not care may ignore it, as Ctrl+S does.
 */
export async function saveProject(opts?: { saveAs?: boolean }): Promise<CloseSaveOutcome> {
  // 'failed' rather than a silent early return: a concurrent save must never be
  // mistaken for a completed one by a close that is waiting on this answer.
  if (saveInFlight) return 'failed';
  saveInFlight = true;
  try {
    const before = readStore();
    const api = getEditorAPI();
    const result = await api.project.save(serializeProject(before), {
      path: before.projectPath,
      saveAs: opts?.saveAs === true,
    });

    const store = readStore();
    if (!result.ok) {
      if (result.error.code === 'cancelled') return 'cancelled';
      store.setNotice({ tone: 'danger', title: 'Save failed', message: result.error.message });
      return 'failed';
    }

    store.setProjectPath(result.path);

    // The project takes the name of the file it lives in — that is the only way
    // to name a project in this build. The catch is that the path is not known
    // until the dialog returns, so the bytes already on disk still carry the OLD
    // name: leaving it there means the titlebar reads one name, the file another,
    // and reopening silently renames the project back. So when the name changes,
    // write once more. The path is pinned by now, so this second write is
    // dialog-free — and it only happens on a first save or a save-as, never on
    // the Ctrl+S the user presses forty times an hour.
    const adopted = projectNameFromPath(result.path);
    if (store.projectName !== adopted) {
      store.setProjectName(adopted);
      const rewrite = await api.project.save(serializeProject(readStore()), { path: result.path });
      if (!rewrite.ok) {
        readStore().setNotice({
          tone: 'danger',
          title: 'Save failed',
          message: rewrite.error.message,
        });
        // Deliberately still dirty: the file on disk does not match the editor.
        return 'failed';
      }
    }

    // Last, because setProjectName is on the markDirty list (PLAN §3.1).
    const after = readStore();
    after.markSaved();
    after.setNotice(null);

    // The .veproj now contains everything the snapshot did, so the snapshot is
    // retired. `writeSeq` is >= every write already dispatched, because this
    // thread increments before it sends (SAFETY §2.6).
    lastExplicitSaveAt = new Date().toISOString();
    void api.project.autosaveRetire?.(writeSeq);
    return 'saved';
  } finally {
    saveInFlight = false;
  }
}

/**
 * The three-way question, raised natively by main (SAFETY §1.9). Returns
 * 'discard' immediately when the project is clean, and under dev:web where the
 * method is absent and the save is a stub anyway.
 */
async function confirmDiscardChanges(): Promise<DiscardChoice> {
  const store = readStore();
  if (!store.isDirty) return 'discard';
  try {
    const ask = getEditorAPI().project.confirmDiscard;
    if (!ask) return 'discard';
    return await ask({
      projectName: store.projectName,
      neverSaved: store.projectPath === null,
    });
  } catch {
    // A question that could not be asked must not be answered with 'discard'.
    return 'cancel';
  }
}

/**
 * Opens a .veproj. The main process hands back the raw parsed object; the
 * renderer is where `migrateProject` decides whether it is a project at all
 * (PLAN §2.6), so a JSON file that is not one lands as 'bad-format' here
 * rather than hydrating the store with rubbish.
 *
 * The guard sits at open → migrate → CONFIRM → apply, and nowhere earlier
 * (SAFETY §1.9): cancelling the picker is the common case and must cost
 * nothing, a file we refuse must not have cost a save, and `applyProject` is
 * the point of no return.
 */
export async function openProject(path?: string): Promise<void> {
  if (openInFlight) {
    // Only a pathful call is queued. `openInFlight` now spans a native modal the
    // user can sit on indefinitely, and a .veproj double-clicked in Explorer
    // during that window is an explicit gesture that must not vanish. A pathless
    // Ctrl+O is a picker the user cannot have reached anyway.
    if (path) queuedOpenPath = path;
    return;
  }
  openInFlight = true;
  try {
    const api = getEditorAPI();
    const result = await api.project.open(path);
    const store = readStore();

    if (!result.ok) {
      if (result.error.code !== 'cancelled') {
        store.setNotice({
          tone: 'danger',
          title: 'Could not open',
          message: result.error.message,
        });
      }
      return;
    }

    const project = migrateProject(result.project);
    if (!project) {
      // The store is untouched on this branch: a file we will not open must
      // never cost the user the project already loaded.
      store.setNotice({
        tone: 'danger',
        title: 'Could not open',
        message: describeProjectProblem(result.project),
      });
      return;
    }

    const choice = await confirmDiscardChanges();
    if (choice === 'cancel') return; // the chosen file is dropped, silently
    if (choice === 'save') {
      const outcome = await saveProject();
      // 'cancelled' says nothing — they just declined to name the file.
      // 'failed' already raised its own notice.
      if (outcome !== 'saved') return;
    }

    // applyProject calls the four hydrate actions in order; every hydrate resets
    // history and calls markSaved, so Ctrl+Z cannot reach the previous project.
    applyProject(project);
    const after = readStore();
    after.setProjectPath(result.path);
    after.markSaved();
    after.setNotice(null);

    // The snapshot describes a project that is no longer loaded (SAFETY §2.6),
    // and no explicit save has happened in this session for the new one.
    lastExplicitSaveAt = null;
    void api.project.autosaveRetire?.(writeSeq);
  } finally {
    openInFlight = false;
    const queued = queuedOpenPath;
    queuedOpenPath = null;
    // One retry, unconditional on the previous outcome: each explicit gesture
    // gets exactly one question, in the order the user made them. The flag is
    // already clear and `queuedOpenPath` is cleared first, so a repeated
    // double-click cannot build a chain.
    if (queued) void openProject(queued);
  }
}

/* ------------------------------------------------------- recovery answers */

/**
 * Restore. `markDirty()` is unconditional and deliberate: the restored state
 * matches nothing on disk, and telling the user it is saved when it is not is
 * the exact lie SAFETY.md exists to remove. This is the one new markDirty
 * caller (PLAN §3.1).
 */
export async function restoreRecovery(): Promise<void> {
  const offer = readStore().recovery;
  if (!offer) return;
  const api = getEditorAPI();

  const project = migrateProject(offer.project);
  if (!project) {
    // The user never knew this file existed; being told it was unreadable helps
    // nobody. Tombstone it and say nothing.
    readStore().clearRecoveryOffer();
    void api.project.autosaveResolveOffer?.(offer.sessionId, 'discarded');
    return;
  }

  // The real combination this covers: the OS handed the app a .veproj at launch
  // AND a snapshot is recoverable. Restoring would replace a project the user is
  // already looking at, so it goes through the same guard as Ctrl+O. In the
  // ordinary case — an empty untouched project — this returns immediately.
  const choice = await confirmDiscardChanges();
  if (choice === 'cancel') return;
  if (choice === 'save') {
    const outcome = await saveProject();
    if (outcome !== 'saved') return;
  }

  applyProject(project);
  const after = readStore();
  after.setProjectPath(offer.projectPathExists ? offer.projectPath : null);
  after.markDirty();
  after.clearRecoveryOffer();
  lastExplicitSaveAt = null;

  // Resolved first, so the retire that follows finds no held offer to tombstone.
  await api.project.autosaveResolveOffer?.(offer.sessionId, 'restored');
  void api.project.autosaveRetire?.(writeSeq);
}

/**
 * Discard. No confirmation: the snapshot is a copy, the user's real file is
 * untouched, and main renames rather than deletes, so a misclick stays
 * recoverable for seven days (SAFETY §2.8).
 */
export function discardRecovery(): void {
  const offer = readStore().recovery;
  if (!offer) return;
  readStore().clearRecoveryOffer();
  void getEditorAPI().project.autosaveResolveOffer?.(offer.sessionId, 'discarded');
}

/* ------------------------------------------------------ the safety wiring */

const AUTOSAVE_FAILED_NOTICE = {
  tone: 'warning',
  title: 'Autosave failed',
  message:
    'Snapshots are not being written, so unsaved changes are not protected — save the project',
} as const;

/**
 * Wires the dirty mirror, the autosave loop, the close-save listener and the
 * recovery query. Returns its own teardown. Called once from App (SAFETY §9.4).
 *
 * Safe to call when no bridge method exists (dev:web), and safe to call twice:
 * <StrictMode> runs mount → unmount → mount for every effect in development, so
 * the teardown has to be total and has to cancel the in-flight recovery query.
 */
export function startProjectSafety(): () => void {
  let api: EditorAPI;
  try {
    api = getEditorAPI();
  } catch {
    return () => undefined; // nothing registered a bridge; there is nothing to wire
  }

  let cancelled = false;
  let pending = false;
  let writeInFlight = false;
  let lastMutationAt = 0;
  let lastSnapshotAt = Date.now();
  /** Set only by noteFailure. Without it a failed write retries on every 500 ms
   *  tick, because the quiet period that let it through is still quiet. */
  let retryNotBefore = 0;

  /* One subscription, no selector, and it ALLOCATES NOTHING — which is what
     makes a bare subscription safe at 60 store writes per second during
     playback (PLAN §1.3 rule 1). A playhead-only write changes none of the
     twelve and costs twelve comparisons. */
  const s0 = readStore();
  let clips = s0.clips;
  let tracks = s0.tracks;
  let trackOrder = s0.trackOrder;
  let markers = s0.markers;
  let items = s0.items;
  let order = s0.order;
  let fps = s0.fps;
  let width = s0.width;
  let height = s0.height;
  let projectName = s0.projectName;
  // projectPath is compared precisely BECAUSE the mirror push reads it: it is a
  // distinct action that does not call markDirty, and openProject calls it after
  // applyProject has already cleared isDirty — so an eleven-field listener would
  // leave hasPath false in main's mirror and the close dialog would offer to
  // pick a location for a project that already has one.
  let projectPath = s0.projectPath;
  let isDirty = s0.isDirty;

  const pushState = () => {
    api.project.reportState?.({ isDirty, projectName, hasPath: projectPath !== null });
  };
  pushState();

  const unsubscribe = useEditorStore.subscribe((s) => {
    const identityChanged =
      s.isDirty !== isDirty || s.projectName !== projectName || s.projectPath !== projectPath;
    if (
      !identityChanged &&
      s.clips === clips &&
      s.tracks === tracks &&
      s.trackOrder === trackOrder &&
      s.markers === markers &&
      s.items === items &&
      s.order === order &&
      s.fps === fps &&
      s.width === width &&
      s.height === height
    ) {
      return;
    }
    clips = s.clips;
    tracks = s.tracks;
    trackOrder = s.trackOrder;
    markers = s.markers;
    items = s.items;
    order = s.order;
    fps = s.fps;
    width = s.width;
    height = s.height;
    projectName = s.projectName;
    projectPath = s.projectPath;
    isDirty = s.isDirty;
    pending = true;
    lastMutationAt = Date.now();
    if (identityChanged) pushState();
  });

  const noteFailure = () => {
    // A failed write produced no snapshot, so "something has changed since the
    // last snapshot" is still true and `pending` has to go back up, or nothing
    // retries until the user's next edit. The back-off is what stops that from
    // becoming an attempt every 500 ms: the quiet period that admitted this
    // write is still quiet, so the gate has to be an explicit one. A full disk
    // is retried at the same cadence a healthy project is snapshotted.
    pending = true;
    retryNotBefore = Date.now() + AUTOSAVE_MAX_INTERVAL_MS;
    readStore().noteAutosaveFailed();
    // One notice, once, at the SECOND consecutive failure: a full disk that
    // raised one every 20 seconds would be worse than having no autosave at all,
    // and the first failure is usually a scanner holding the file for a moment.
    if (readStore().autosaveFailures === 2) readStore().setNotice({ ...AUTOSAVE_FAILED_NOTICE });
  };

  const tick = () => {
    if (writeInFlight) return; // never more than one outstanding write
    const write = api.project.autosaveWrite;
    if (!write) return; // dev:web — no autosave, and no error either
    const s = readStore();
    if (!s.isDirty || !pending) return;
    if (Date.now() < retryNotBefore) return; // backing off after a failure
    // The snapshot is built on the renderer's main thread, which is the thread
    // that owns the app's only rAF loop. Holding `pending` through playback and
    // letting the ceiling fire on the first tick after the transport stops costs
    // nothing: playback mutates no project state, so a deferred snapshot
    // contains exactly the edits it would have contained (SAFETY §2.4).
    if (s.isPlaying) return;
    const now = Date.now();
    if (now - lastMutationAt < AUTOSAVE_IDLE_MS && now - lastSnapshotAt < AUTOSAVE_MAX_INTERVAL_MS) {
      return;
    }

    pending = false;
    writeInFlight = true;
    writeSeq += 1;
    void write(toAutosavePayload(s, { seq: writeSeq, lastExplicitSaveAt }))
      .then((result) => {
        if (!result.ok) return noteFailure();
        if (result.skipped) {
          // Main declined it. Not a failure, nothing visible: leave `pending`
          // set so the next tick retries, and do not advance autosaveAt.
          pending = true;
          return;
        }
        lastSnapshotAt = result.at;
        readStore().noteAutosaveWritten(result.at);
      })
      .catch(() => noteFailure())
      .finally(() => {
        writeInFlight = false;
      });
  };

  const timer = setInterval(tick, AUTOSAVE_TICK_MS);

  const stopSaveRequest = api.project.onSaveRequest?.((token) => {
    void saveProject().then((outcome) => api.project.reportSaveResult?.(token, outcome));
  });

  void (async () => {
    try {
      const offer = await api.project.autosaveRecoverable?.();
      // The flag matters: without it the first StrictMode instance's promise
      // resolves after its own teardown and writes an offer into a store a
      // second, live instance is also writing to.
      if (cancelled || !offer) return;
      if (!migrateProject(offer.project)) {
        void api.project.autosaveResolveOffer?.(offer.sessionId, 'discarded');
        return;
      }
      readStore().setRecoveryOffer(offer);
    } catch {
      /* a recovery offer that cannot be read is not something the user can act on */
    }
  })();

  return () => {
    cancelled = true;
    clearInterval(timer);
    unsubscribe();
    stopSaveRequest?.();
  };
}
