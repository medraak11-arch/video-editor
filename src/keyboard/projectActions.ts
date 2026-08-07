/* ---------------------------------------------------------------------------
   projectActions.ts — the renderer half of 'project:save' / 'project:open'.

   Ctrl+S routes here from the shortcut layer; the titlebar overflow menu can
   call the same two functions so there is exactly one save path and one open
   path in the app. Both are quiet on cancel and report every real failure
   through `setNotice`, which the titlebar renders as an InlineNotice (PLAN §5).

   `isDirty` is written only by the store's markDirty / markSaved. A successful
   save calls markSaved, and that is what clears the titlebar's unsaved dot.
--------------------------------------------------------------------------- */

import { getEditorAPI } from '../lib/editorApi';
import {
  applyProject,
  describeProjectProblem,
  migrateProject,
  serializeProject,
} from '../lib/project';
import { readStore } from '../state/store';

/** Basename without the .veproj extension. The renderer has no node `path`. */
function projectNameFromPath(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  return base.replace(/\.veproj$/i, '') || 'Untitled';
}

let saveInFlight = false;
let openInFlight = false;

/**
 * Writes the project. With no path yet — or with `saveAs` — the main process
 * opens the native save dialog. Cancelling is not a failure and says nothing.
 */
export async function saveProject(opts?: { saveAs?: boolean }): Promise<void> {
  if (saveInFlight) return;
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
      if (result.error.code !== 'cancelled') {
        store.setNotice({ tone: 'danger', title: 'Save failed', message: result.error.message });
      }
      return;
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
        return;
      }
    }

    // Last, because setProjectName is on the markDirty list (PLAN §3.1).
    const after = readStore();
    after.markSaved();
    after.setNotice(null);
  } finally {
    saveInFlight = false;
  }
}

/**
 * Opens a .veproj. The main process hands back the raw parsed object; the
 * renderer is where `migrateProject` decides whether it is a project at all
 * (PLAN §2.6), so a JSON file that is not one lands as 'bad-format' here
 * rather than hydrating the store with rubbish.
 */
export async function openProject(path?: string): Promise<void> {
  if (openInFlight) return;
  openInFlight = true;
  try {
    const result = await getEditorAPI().project.open(path);
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

    // applyProject calls the four hydrate actions in order; every hydrate resets
    // history and calls markSaved, so Ctrl+Z cannot reach the previous project.
    applyProject(project);
    const after = readStore();
    after.setProjectPath(result.path);
    after.markSaved();
    after.setNotice(null);
  } finally {
    openInFlight = false;
  }
}
