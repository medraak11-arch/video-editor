# Data safety — the unsaved-changes prompt and autosave

**Status:** normative for the two features it describes. Where this document and `docs/PLAN.md`
disagree on a name, type or channel, PLAN wins and the conflict is a bug in this file — report it.
Where it and `DESIGN.md` disagree on visual behaviour, `DESIGN.md` wins except where PLAN §7.4–§7.7
already resolved the point.

Read order: `PRODUCT.md` → `DESIGN.md` → `docs/PLAN.md` → this file.

---

## 0. The problem, stated

`README.md` currently admits:

> **Nothing autosaves.** `Ctrl+S` is the only thing that writes a project, and closing the window
> does not stop to ask about unsaved changes. The dot beside the project name in the title bar is
> the only warning you get. Opening another project replaces the one in the window on the same
> terms, whether it arrives by `Ctrl+O` or by double-clicking a `.veproj`.

Three ways to lose an afternoon, all of them silent:

1. **Alt+F4 / the titlebar X.** `CH.windowClose` → `win.close()` → the window is gone. No question
   is asked and nothing is written.
2. **A crash, a power cut, an OS shutdown.** Nothing on disk between `Ctrl+S` presses.
3. **`Ctrl+O`, or a `.veproj` double-clicked in Explorer.** Both land in `openProject()`
   (`src/keyboard/projectActions.ts`), which calls `applyProject()`. Every hydrate action resets
   history and calls `markSaved()`, so after the replace there is no undo back to the old project
   and no dirty flag to warn you it was ever there. The installer claims the `.veproj` extension, so
   path 3 can be triggered by a double-click in another window entirely.

Two features close all three. They are independent — either can ship without the other — but they
share one guarantee: **the only thing that ever writes to the user's `.veproj` is an explicit save.**

| | Covers | Guarantee |
|---|---|---|
| **Close prompt** (§1) | 1 and 3 — deliberate destruction | Nothing destroys unsaved work without a three-way question the user answers |
| **Autosave** (§2) | 2 — accidental destruction | At most 20 seconds of editing is unrecoverable after a crash — a minute while an export is running (§2.4) |

That bound is stated in exactly this form everywhere it appears (§1.8, §2.4, §7, `README.md`). It is a
bound on **editing**, not on wall-clock: playback mutates no project state, so a snapshot deferred
until the transport stops (§2.4) still contains every edit made before it started.

---

## 1. The unsaved-changes prompt

### 1.1 Where it fires

| Trigger | Path today | Owner of the guard |
|---|---|---|
| Titlebar X | `WindowControls` → `CH.windowClose` → `win.close()` | `win.on('close')` in `electron/main.ts` |
| `Alt+F4`, window menu Close | Chromium → `win.close()` | same |
| `app.quit()` — `window-all-closed`, darwin `Cmd+Q`, dock Quit | `app.on('before-quit')` | `app.on('before-quit')` in `electron/main.ts` |
| OS shutdown / logoff | `app.on('session-end')` | §1.8 — **never prompts** |
| `Ctrl+O`, AppMenu → Open project | `openProject()` | `confirmDiscardChanges()` in `src/keyboard/projectActions.ts` |
| `.veproj` handed over by the OS (`useOpenHandoff` → `CH.projectOpenPath`) | `openProject(path)` | same — it is the same function |

The last two get the guard for free because `useOpenHandoff` already routes into the *same*
`openProject`. That was a deliberate choice when it was written and it pays off here: there is one
open path, so there is one place to put the question.

### 1.2 Why this is the one correct modal

`PRODUCT.md` names **modal-first flows** as a hard anti-reference, and the example it gives is the
real objection: *"A dialog asking for project settings, resolution, or frame rate before the first
frame is on screen."* The sin is ceremony **before** work — a dialog standing between the user and
the task, asking for something the application could have inferred. The close prompt inverts every
term of that:

- it comes **after** all of the work, never before it;
- it asks something that **cannot** be inferred. Only the user knows whether the last forty minutes
  matter. `adoptSourceFormat` can guess a frame rate; nothing can guess this;
- it is a **true blocking three-way decision**. An inline affordance cannot stop a window from
  closing. A banner that says "you have unsaved changes" while the window disappears behind it is
  not an affordance, it is an epitaph;
- it fires **at most once per session**, on an action the user initiated;
- `PLAN` §5 already sanctions modals ("Rare by design") and the app already ships two
  (`ExportDialog`, `ShortcutOverlay`).

**And it must be the native `dialog.showMessageBox`, not an in-app `Dialog`:**

1. **The renderer is being torn down.** An HTML dialog drawn by a window that is closing races its
   own destruction. The window may already be hidden, the compositor may already have stopped.
2. **It has to work when the renderer does not.** If React has thrown, if the page is unresponsive,
   if `webContents.isCrashed()`, an in-app dialog cannot be drawn at all — and a crashed renderer is
   precisely when unsaved work is most at risk. The native dialog is drawn by the OS.
3. **The OS gives correctness for free.** Window-modality, Enter/Escape handling, the platform's own
   button order, focus containment, screen-reader labelling, and high-contrast/forced-colours
   compliance are all the platform's, not ours. Every one of them is a requirement in `PRODUCT.md`'s
   accessibility section and every one of them is a thing we would otherwise have to re-verify.
4. **It cannot be styled wrong.** It spends no accent (`PLAN` §7.4), needs no token, and has no
   `prefers-reduced-motion` surface, because it does not animate.

This is the whole justification. It does not generalise: a second native dialog anywhere else in
this app would need its own argument.

### 1.3 Main has to know the answer before it can ask the question

`win.on('close')` is **synchronous**. `event.preventDefault()` must be called during that tick, and
the main process cannot read the renderer's zustand store. So the renderer **mirrors** three facts
into main whenever they change, and main answers from the mirror with no round trip:

```ts
/** src/types/api.ts — pushed on every change; main keeps the last value. */
export interface ProjectStateReport {
  isDirty: boolean;
  projectName: string;
  /** false = never saved anywhere, so Save will need a path. */
  hasPath: boolean;
}
```

The push is fire-and-forget (`ipcRenderer.send`), costs one message per `isDirty` transition plus
one per rename, and is emitted from the single subscription in `startProjectSafety()` (§2.10). Main
initialises the mirror to `{ isDirty: false, projectName: 'Untitled', hasPath: false }`, so a
renderer that dies before its first push closes without a prompt — which is right, because a
renderer that never reported dirty never told us it had anything.

### 1.4 The close sequence, exactly

All of this is in `electron/main.ts`. The only line added outside this block is
`quitApproved = false;` at the top of `createWindow()` — see "Approval cannot outlive its window"
below. Nothing else in that file changes.

```ts
/* ------------------------------------------------------------ close guard */

let projectState: ProjectStateReport = {
  isDirty: false, projectName: 'Untitled', hasPath: false,
};

/** Approval is per window, never per process — see "Approval cannot outlive its window" below. */
const closeApproved = new WeakSet<BrowserWindow>();
let quitApproved = false;      // reset in createWindow(); see below
let sessionEnding = false;     // the OS is shutting us down — never prompt (§1.8)

// The "a native decision dialog is up" mutex is NOT declared here. It is owned by
// electron/ipc/project.ts and shared with the open guard — see "One mutex, two guards".
import { beginDecision, endDecision, isDecisionInFlight } from './ipc/project';

ipcMain.on(CH.appProjectState, (_event, report: unknown) => {
  if (!isProjectStateReport(report)) return;
  projectState = report;
});

win.on('close', (event) => {
  if (closeApproved.has(win) || sessionEnding) return;   // let it go
  event.preventDefault();                                 // ← synchronous, always first
  if (isDecisionInFlight()) return;                       // a dialog already has focus
  void resolveCloseIntent(win, { reissueQuit: false });
});
```

`event.preventDefault()` runs **unconditionally on the undecided path**, before any `await`. That is
the whole trick: the close is cancelled first and re-issued later, so every subsequent step is free
to be asynchronous.

```ts
async function resolveCloseIntent(
  win: BrowserWindow,
  entry: { reissueQuit: boolean },       // true only when we got here from before-quit (§1.8)
): Promise<void> {
  if (!beginDecision()) return;          // the open guard, or a previous close, owns the dialog
  try {
    const exporting = hasActiveExport(win.webContents);   // §1.7
    const dirty = projectState.isDirty;
    const go = (retireSnapshot: boolean) =>
      approveAndClose(win, { ...entry, retireSnapshot });

    if (!dirty && !exporting) return go(true);

    if (!dirty && exporting) {
      const { response } = await dialog.showMessageBox(win, exportOnlyQuestion());
      if (response !== 0) return;                          // Cancel — abort, window stays
      return go(true);
    }

    const { response } = await dialog.showMessageBox(
      win,
      unsavedQuestion(projectState, exporting, 'close'),
    );
    if (response === 2) return;                            // Cancel — genuinely aborts
    if (response === 1) return go(true);                   // Do not save — an explicit discard
    // response === 0 — Save. §1.6.
    const outcome = await requestRendererSave(win);
    if (outcome === 'saved') return go(true);
    if (outcome === 'abandon') return go(false);           // §1.6 watchdog — NOT a discard
    return;                                                // cancelled or failed → stay open
  } finally {
    endDecision();
  }
}

interface CloseApproval {
  /** Re-issue app.quit() after the window goes. Set only on the before-quit path (§1.8). */
  reissueQuit: boolean;
  /** Delete this session's snapshot. FALSE on every 'abandon' — see below. */
  retireSnapshot: boolean;
}

function approveAndClose(win: BrowserWindow, a: CloseApproval): void {
  closeApproved.add(win);
  quitApproved = true;
  try {
    stopExportsSync(win.webContents);          // §1.7 — synchronous, never throws
    if (a.retireSnapshot) retireAutosaveSync(); // §2.6 — never throws
  } catch {
    /* Hygiene is never a reason to fail a close. Both callees already swallow their own
       errors (§1.7, §2.6); this is the second layer, because a close that silently does
       nothing is the worst outcome in this document. */
  }
  if (!win.isDestroyed()) win.close();
  if (a.reissueQuit) app.quit();               // §1.8 — the deferred quit is re-issued
}
```

`win.close()` is the last thing that can be skipped, and nothing before it is allowed to throw past
`approveAndClose`. Getting this wrong is not a cosmetic bug: `closeApproved` is already set by then,
so a throw would leave a window that ignored the X **and** whose next X press closes instantly with
no prompt.

**Cancel genuinely aborts.** It returns without adding the window to `closeApproved`, so the original
`preventDefault()` stands and no second `win.close()` is issued. The window is still there, the
project is still loaded, `isDirty` is untouched, and the next X press starts the whole sequence
again from the top. There is no path in `resolveCloseIntent` that reaches `approveAndClose` without
an explicit user choice.

**`'abandon'` never retires the snapshot.** It is reached only from the §1.6 watchdog — a renderer
that has crashed or wedged. The user is choosing "close this broken window", not "throw this work
away", and the snapshot is the entire remedy for that case. `retireSnapshot: false` is what keeps
the next launch able to offer it back. Contrast **Do not save**, which *is* an explicit discard by a
user looking at their own project, and does retire (§2.6).

**Approval cannot outlive its window.** `closeApproved` is a `WeakSet<BrowserWindow>`, not a boolean,
and `quitApproved` is reset to `false` on the first line of `createWindow()`. Both matter on darwin,
where `main.ts`'s `app.on('activate')` builds a *second* window in the same process after the first
has closed. With process-wide booleans that second window would inherit the first window's approval:
its `win.on('close')` would return without `preventDefault()` and `before-quit` would return early,
so a second dirty project would close with no prompt at all. That platform is exactly the one §1.8
says the quit guard exists for, so it is not theoretical.

**One mutex, two guards.** The close guard (`electron/main.ts`) and the open guard
(`CH.appConfirmDiscard`, `electron/ipc/project.ts`) both raise a **window-modal** native dialog on
the same window. They are otherwise independent state machines, so without a shared flag this
sequence stacks two of them: `Ctrl+O` raises the confirm-discard dialog → `Alt+F4` →
`win.on('close')` → `preventDefault()` → a second `dialog.showMessageBox(win, …)` on top. Answering
the second while the first is still outstanding runs `approveAndClose` against a renderer that may
be mid-`saveProject()`, and kills the pending `confirmDiscard` invoke with the window.

So the mutex has **one owner** — `electron/ipc/project.ts`, which already owns `unsavedQuestion` —
and both guards take it:

```ts
/* electron/ipc/project.ts — the only declaration */
let decisionInFlight = false;
export const beginDecision = (): boolean => (decisionInFlight ? false : (decisionInFlight = true));
export const endDecision = (): void => { decisionInFlight = false; };
export const isDecisionInFlight = (): boolean => decisionInFlight;
```

- `win.on('close')` still calls `preventDefault()` first and then **returns** while any decision is
  outstanding. The close is not queued: the user answers the dialog in front of them and presses X
  again. One question at a time, always the one they raised last.
- `CH.appConfirmDiscard` returns `'cancel'` when it cannot take the mutex, which abandons the open
  and leaves the current project loaded — the safe answer, and the same one the user gets from
  Escape.
- **Residual, stated:** the open guard releases the mutex when it *returns* `'save'`, and the
  renderer's `await saveProject()` runs after that. A close begun in that window reaches
  `requestRendererSave`, whose save meets `saveInFlight` and returns `'failed'` (§1.6), so the close
  aborts with the existing notice and nothing is lost. Two saves can never overlap; a close can be
  refused once, visibly, and retried.

### 1.5 The dialog, exactly

```ts
const unsavedQuestion = (
  s: ProjectStateReport,
  exporting: boolean,
  reason: 'close' | 'open',
): Electron.MessageBoxOptions => ({
  type: 'warning',
  noLink: true,                                   // win32: real buttons, not command links
  title: 'Video Editor',
  buttons: ['Save', 'Do not save', 'Cancel'],     // sentence case (DESIGN.md §3)
  defaultId: 0,                                   // Enter saves
  cancelId: 2,                                    // Escape, and the dialog's own X, cancel
  message: reason === 'close'
    ? `Save changes to ${s.projectName} before closing?`
    : `Save changes to ${s.projectName} before opening another project?`,
  detail: [
    'If you do not save, your changes since the last save are lost.',
    s.hasPath ? null : 'This project has never been saved, so you will be asked where to put it.',
    exporting ? 'The export still running will be stopped and its partly written file removed.' : null,
  ].filter(Boolean).join('\n\n'),
});

const exportOnlyQuestion = (): Electron.MessageBoxOptions => ({
  type: 'warning',
  noLink: true,
  title: 'Video Editor',
  buttons: ['Stop export and close', 'Cancel'],
  defaultId: 1,                                   // Enter does the safe thing here
  cancelId: 1,
  message: 'An export is still running.',
  detail: 'Closing now stops it and removes the partly written file. The export cannot be resumed.',
});
```

`cancelId: 2` is load-bearing: it maps **Escape**, the dialog's own close button, and (on Windows)
Alt+F4 on the dialog itself to Cancel. Without it, dismissing the dialog would fall through to
`response === 0` and silently start a save the user never asked for.

`defaultId` differs between the two dialogs on purpose. In the unsaved dialog the safe default is
Save. In the export dialog the safe default is Cancel, because "stop export" is unrecoverable and
Enter should never be the key that throws away a forty-minute encode.

**Both strings promise that the partly written file is removed, and that promise is only honest if
`stopExportsSync` (§1.7, §9.3) ships.** It is a hard requirement of this feature, not a nicety: the
close prompt turns "close during an export" from a rare accident into a supported flow, so anything
it leaks, it leaks routinely. If that export is not delivered, both strings must lose the removal
clause in the same change — `'Closing now stops it. The export cannot be resumed.'` and
`'The export still running will be stopped.'` — because a dialog that states a fact the code does
not perform is the anti-pattern this whole document exists to remove.

Copy rules honoured: sentence case throughout, no exclamation marks, no encouragement, no
"Are you sure?" — the message states the consequence and the buttons state the actions
(`PRODUCT.md`, Brand Personality).

### 1.6 Save inside a close handler — the sequencing

This is the part that is a real problem, so it is specified as a protocol rather than a call.

The save must be performed **by the renderer**, because `serializeProject(readStore())` needs the
store and the store is in the renderer. `ipcMain` has no `invoke` toward a renderer, so the request
is a message plus a correlated reply:

```ts
/* src/types/api.ts — declared ONCE, here; §1.9 and §5 import it, neither retypes it */

/** What the renderer can report. These three, and only these three, cross the bridge. */
export type CloseSaveOutcome = 'saved' | 'cancelled' | 'failed';

/** What main's close path resolves to. 'abandon' is main-internal — it is produced by the
 *  watchdog when the renderer is dead, and is never accepted off the wire. */
export type CloseSaveResolution = CloseSaveOutcome | 'abandon';
```

```ts
/* electron/main.ts */
const saveWaiters = new Map<string, (o: CloseSaveResolution) => void>();

ipcMain.on(CH.appSaveResult, (_event, token: unknown, outcome: unknown) => {
  if (typeof token !== 'string') return;
  const settle = saveWaiters.get(token);
  if (!settle) return;
  saveWaiters.delete(token);
  // Narrowed to the renderer's three. A message claiming 'abandon' is treated as 'failed';
  // the decision to close without saving is the user's, made in a dialog main drew.
  settle(outcome === 'saved' || outcome === 'cancelled' ? outcome : 'failed');
});

const CLOSE_SAVE_WATCHDOG_MS = 60_000;

function requestRendererSave(win: BrowserWindow): Promise<CloseSaveResolution> {
  if (win.isDestroyed()) return Promise.resolve('abandon');   // nothing left to save or to ask
  return new Promise((resolve) => {
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let timer: NodeJS.Timeout | null = null;
    const settle = (o: CloseSaveResolution) => {
      if (timer) clearTimeout(timer);
      saveWaiters.delete(token);
      resolve(o);
    };
    saveWaiters.set(token, settle);

    // A crashed renderer will never reply, so do not arm a 60-second timer to discover
    // something already known. Ask immediately.
    if (win.webContents.isCrashed()) return void watchdog(win, settle, { crashed: true });

    timer = setTimeout(() => void watchdog(win, settle, { crashed: false }), CLOSE_SAVE_WATCHDOG_MS);
    win.webContents.send(CH.appSaveRequest, token);
  });
}
```

**The renderer side.** `saveProject()` already does everything needed — including raising the native
save dialog through `CH.projectSave` when `projectPath` is `null`, and including the second
dialog-free write that adopts the file's name. It gains a return value (it returned `void`;
existing callers ignore it, so this is not a breaking change):

```ts
/* src/keyboard/projectActions.ts */
export async function saveProject(opts?: { saveAs?: boolean }): Promise<CloseSaveOutcome>;
```

`'saved'` on success, `'cancelled'` when the save dialog was dismissed, `'failed'` on any
`io-failed` (a `Notice` was already raised by the existing code). The re-entrancy guard
`saveInFlight` currently returns early with no signal; it now returns `'failed'` so a concurrent
save can never be mistaken for a completed one.

The listener is registered once, inside `startProjectSafety()`:

```ts
api.project.onSaveRequest?.((token) => {
  void saveProject().then((outcome) => api.project.reportSaveResult?.(token, outcome));
});
```

**Why this sequences correctly.** The chain is: `close` → `preventDefault` (sync) → native question
(async, window-modal) → `appSaveRequest` (async) → `saveProject()` → possibly a **second**
window-modal native dialog, the save picker → write → `appSaveResult` → `win.close()` with
`closeApproved` set. Two native dialogs appear one after another on the same window, never at the
same time, because the first has already resolved before the message is sent. The window is fully
alive throughout — it was never allowed to begin closing — so the renderer can run, the store can be
serialised, and `CH.projectSave`'s atomic temp-then-rename write completes before anything is torn
down. The save **finishes before the window closes** by construction, not by timing.

That argument is about the close path's *own* two dialogs and covers only them. The other way two
native dialogs can stack — the open guard's question and the close guard's — is a different pair and
is prevented by the shared mutex in §1.4, not by this sequencing.

**The never-saved case** is the one this was designed around and it needs no special code: the
picker is raised by `saveProject` exactly as it is for a `Ctrl+S` on a fresh project, `projectPath`
is set from the result, the name-adoption rewrite runs, and only then does `'saved'` come back.

**Outcome mapping, complete:**

| `requestRendererSave` resolves | Meaning | What the close does |
|---|---|---|
| `'saved'` | bytes are on disk | close, retiring the snapshot (the renderer's own `saveProject` already retired it; the sync call in `approveAndClose` is idempotent) |
| `'cancelled'` | user dismissed the save picker | **abort the close.** They just declined to name the file; closing anyway would destroy exactly the work they declined to discard |
| `'failed'` | disk full, read-only, path gone | **abort the close.** The `InlineNotice` in the titlebar already says why, and it is readable because the window is still open |
| `'abandon'` | the watchdog below, or a window that is already destroyed | **close, keeping the snapshot.** The renderer cannot save, so aborting would only make the window unclosable |

`'abandon'` is why the resolution type is wider than the renderer's. Without it the watchdog's
primary button has no value it can settle with that reaches `approveAndClose`: every renderer
outcome either closes-having-saved or aborts, so `Close without saving` would be a dead button, and
a crashed renderer would give **X → dirty dialog → Save → abort → repeat, forever**, explained only
through an `InlineNotice` channel that is inside the crashed renderer.

**The watchdog.** Two ways in, one dialog, and the primary button always closes the window.

```ts
async function watchdog(
  win: BrowserWindow,
  settle: (o: CloseSaveResolution) => void,
  how: { crashed: boolean },
): Promise<void> {
  if (win.isDestroyed()) return settle('abandon');
  const { response } = await dialog.showMessageBox(win, unresponsiveQuestion(how.crashed));
  if (response === 0) return settle('abandon');            // Close without saving
  if (how.crashed) return settle('cancelled');             // Cancel — abort, the window stays
  // 'Keep waiting' on a merely wedged renderer: re-arm and let it try again.
  setTimeout(() => void watchdog(win, settle, how), CLOSE_SAVE_WATCHDOG_MS);
}

const unresponsiveQuestion = (crashed: boolean): Electron.MessageBoxOptions => ({
  type: 'warning',
  noLink: true,
  title: 'Video Editor',
  buttons: crashed
    ? ['Close without saving', 'Cancel']
    : ['Close without saving', 'Keep waiting'],
  defaultId: 1,
  cancelId: 1,
  message: crashed ? 'The editor has stopped running.' : 'The editor is not responding.',
  detail: hasLiveSnapshot()
    ? 'Its unsaved changes cannot be written. Changes since the last automatic snapshot are lost; the snapshot is kept and offered back the next time the app starts.'
    : 'Its unsaved changes cannot be written. Closing now loses them.',
});
```

Three things this gets right that the naive version does not:

1. **`isCrashed()` raises this dialog synchronously rather than resolving `'failed'`.** Waiting 60
   seconds to ask about a renderer already known to be dead is theatre, and resolving `'failed'`
   aborts the close — which is how a crashed renderer produces an unclosable window.
2. **The crashed variant offers `Cancel`, not `Keep waiting`.** There is nothing to wait for, and a
   `Keep waiting` that re-raises the same dialog on the next tick is a loop. `Cancel` aborts the
   close; pressing X again brings the dialog straight back, so this is a choice, not a trap.
3. **The detail sentence is conditional on `hasLiveSnapshot()`** (§5, §9.3) because the two features
   in this document ship independently. Promising a snapshot that autosave never wrote — because it
   is not installed, or because §2.9 has it failing — would be the same fabrication as the README
   blocker. `hasLiveSnapshot` is cheap: `electron/ipc/project.ts` wrote the file, so it knows.

The window can therefore never become unclosable: every branch of every dialog on the close path has
a button that reaches `approveAndClose`.

### 1.7 What happens if an export is running

**Decision: a running export never blocks the close, and is never lost silently either. It is one
extra sentence in one dialog, and one extra dialog when there is nothing else to ask.**

The reasoning. An export is *recomputable* — every input still exists and re-running it costs time,
not information — so it does not deserve a veto over the user's decision to close. But it is also
*expensive* time already spent, and today an Alt+F4 throws it away without a word. So it is worth
exactly one question and no more.

Concretely:

| `isDirty` | export running | Dialog |
|---|---|---|
| no | no | none — the window closes immediately, as it does today |
| no | yes | `exportOnlyQuestion()` — two buttons, `Cancel` is the default |
| yes | no | `unsavedQuestion()` — three buttons |
| yes | yes | `unsavedQuestion()` with the export sentence in `detail` — still three buttons |

Two stacked confirmations for one gesture is worse than one confirmation that states both facts, so
the dirty case absorbs the export into `detail` rather than asking twice.

**Stopping the export needs two exports from that file, not one.** The close guard needs to **read**
whether a job is live in order to formulate the question, and it needs a genuinely synchronous way
to carry out what the question promised (§9.3):

```ts
/* electron/ipc/export.ts — cross-area */
export function hasActiveExport(wc: WebContents): boolean;
export function stopExportsSync(wc: WebContents): void;
```

**Why `stopExportsSync` is required and the existing teardown is not enough.** The obvious argument
— "`event.sender.once('destroyed', teardown)` already kills the child and removes the `.part` file,
so destroying the window is enough" — does not survive contact with the code:

- `teardown` calls `void removeFile(job.partPath)`, and `removeFile` is
  `rm(p, { force: true, maxRetries: 3, retryDelay: 100 })` — **asynchronous and unawaited**, with up
  to ~300 ms of retries precisely because Windows has not released the just-killed ffmpeg's handle;
- `settle()` runs `jobs.delete(job.id)` in the same tick, so the job is out of the map long before
  those retries resolve;
- `killEverythingSync()` — the one genuinely synchronous cleanup, and the only one that uses
  `rmSync` — iterates `jobs`, which by then is empty;
- the process exits a few ticks later, taking the pending retries with it.

Net result on Windows: the `.part` file **and** the tmpdir filter script survive, and both dialogs
in §1.5 told the user they would not.

```ts
/** Synchronous, tolerant, and never throws. For each live job owned by `wc`:
 *  set cancelRequested, child.kill(), then rmSync partPath and scriptPath, spinning briefly
 *  on EPERM/EBUSY (a bounded ~300 ms total, matching removeFile's existing retry budget)
 *  because the killed child's handle is not released the instant kill() returns. */
export function stopExportsSync(wc: WebContents): void;
```

It is called from `approveAndClose` **before** `win.close()` (§1.4), so it runs while the job is
still in the map and while the process is certain to be alive for the length of the spin. Destroying
the window afterwards fires `teardown` as it does today; `settle` is idempotent by construction, so
the second pass is a no-op.

Degradation, per export:

- **Without `hasActiveExport`**: treat it as `() => false`; the two export rows above collapse into
  "no dialog / three-button dialog" and a running export dies on close exactly as it does today.
  Status quo, not a regression — but the feature is incomplete.
- **Without `stopExportsSync`**: the two dialog strings in §1.5 must lose their removal clause in the
  same change. The design is not permitted to ship the promise without the mechanism.

**An export never delays the close.** We do not wait for ffmpeg to exit or to acknowledge the kill —
`stopExportsSync` kills, deletes and returns. The bounded spin is the only wait, it is measured in
hundreds of milliseconds at worst, and it happens after the user has already answered.

### 1.8 Quit, session-end, and one ordering hazard

**`before-quit`.** On the shipping target (Windows x64, frameless, `autoHideMenuBar`, no application
menu) there is no Cmd+Q and no dock, so `app.quit()` is only ever reached through main.ts's own
`window-all-closed` handler — i.e. *after* the window close decision has already been made. The
guard therefore matters on darwin and under `npm run dev`, and it is a belt over a brace:

```ts
app.on('before-quit', (event) => {
  if (quitApproved) return;
  const win = mainWindow;
  if (!win || win.isDestroyed()) { quitApproved = true; return; }
  if (!projectState.isDirty && !hasActiveExport(win.webContents)) { quitApproved = true; return; }
  holdExportsThroughQuit(true);                            // see the ordering hazard below
  event.preventDefault();
  if (!isDecisionInFlight()) void resolveCloseIntent(win, { reissueQuit: true });
});
```

**`reissueQuit` is the whole reason `approveAndClose` takes an options object.** A quit deferred by
`preventDefault()` is not resumed by anything: `approveAndClose` calls `win.close()`, and
`main.ts`'s `window-all-closed` handler only calls `app.quit()` `if (process.platform !== 'darwin')`.
So on darwin, without it, `Cmd+Q` → preventDefault → dialog → Save or Do not save → the window
closes → **no quit is ever re-issued**, leaving a running process with zero windows and no surface
left through which to reach the guard again. Entering from `before-quit` therefore records that
fact, and `approveAndClose` calls `app.quit()` after `win.close()`. That second `app.quit()` finds
`quitApproved === true` and passes straight through. §6 step 22 tests it.

> **The ordering hazard, named.** `registerExportIpc(ipcMain)` also registers a `before-quit`
> listener, `killEverythingSync`. Node's `EventEmitter` runs **every** listener regardless of
> `preventDefault()`, so on a deferred quit the export is killed *before* the user is asked about
> it — and if they then choose Cancel, the export is already gone.
>
> Mitigation in main.ts: register the guard **before** the `registerExportIpc(ipcMain)` call, so it
> is listener 0 and the question is at least formulated with a truthful `hasActiveExport`.
> Full fix is cross-area (§9.3): `export function holdExportsThroughQuit(hold: boolean): void`,
> which sets a module flag `killEverythingSync` returns early on. The guard sets it `true` before
> `preventDefault()` and `false` in `resolveCloseIntent`'s `finally`.
>
> This hazard is **unreachable on the shipping target** and must still be fixed, because
> `npm run dev` on macOS is a supported development path.

**`session-end`.** Windows gives an application a few seconds at logoff or shutdown and kills it if
it blocks. Prompting there is both futile and hostile — the user is not looking at our window, they
are looking at a shutdown screen.

```ts
app.on('session-end', () => {
  sessionEnding = true;
  // WM_ENDSESSION is not guaranteed to arrive before the WM_CLOSE that raised our dialog.
  // If a decision is outstanding when it lands, stop asking and let the window go.
  const win = mainWindow;
  if (win && !win.isDestroyed() && isDecisionInFlight()) {
    approveAndClose(win, { reissueQuit: false, retireSnapshot: false });
  }
});
```

`sessionEnding` short-circuits `win.on('close')` so no dialog is raised and the window goes. The
guarantee at shutdown is the autosave snapshot and nothing else: **at most `AUTOSAVE_MAX_INTERVAL_MS`
of editing is lost — `AUTOSAVE_MIN_INTERVAL_EXPORTING_MS` if an export was running — and the next
launch offers it back.** Nothing is written in this handler: main only ever holds the last snapshot
the renderer sent it and that snapshot is already on disk. `retireAutosaveSync()` is **not** called,
here or on the escape hatch above: a shutdown is not a clean exit, and the snapshot is the entire
point.

> **The ordering assumption, named and bounded.** The flag only works if `session-end`
> (WM_ENDSESSION) is delivered *before* `win.on('close')` (WM_CLOSE). Electron does not guarantee
> that ordering, and Windows shutdown flows can deliver WM_CLOSE first — in which case
> `sessionEnding` is still `false`, the guard calls `preventDefault()`, and a modal message box goes
> up during shutdown. That produces exactly the "this app is preventing you from shutting down"
> screen this handler exists to avoid, followed by a force-kill.
>
> Two obligations, both required before shipping:
>
> 1. **Measure it on the shipping target.** Log both events with `Date.now()` to a file in
>    `userData`, then log off. This is not reachable from the CDP harness — it is a manual step, and
>    it is §6 step 23.
> 2. **Bound the guard regardless of the result**, which is the escape hatch in the handler above:
>    the instant the OS tells us the session is ending, any outstanding decision is abandoned and the
>    window is released. `dialog.showMessageBox(win, …)` with a parent window is asynchronous and
>    does not block the main process's event loop, so the handler can still run while the dialog is
>    on screen. The pending dialog promise resolves afterwards into a `resolveCloseIntent` whose
>    every remaining branch is `win.isDestroyed()`-guarded, so it does nothing.
>
> The trade is deliberate: **a window that cannot be closed is worse than twenty seconds of lost
> editing**, and the snapshot covers those twenty seconds anyway.

### 1.9 Opening another project over a dirty one

Same question, same three outcomes, same native dialog — raised by the renderer through a new
invoke rather than by a window event.

```ts
/* src/keyboard/projectActions.ts */
import type { DiscardChoice } from '../types/api';   // declared once, in api.ts (§5)

/** Returns 'discard' immediately when the project is clean, or under dev:web. */
async function confirmDiscardChanges(): Promise<DiscardChoice>;
```

`DiscardChoice` is **imported, never redeclared.** A second `export type DiscardChoice = …` in
`projectActions.ts` would be two independent declarations of one contract in two files, free to
drift — the exact failure `src/types/api.ts` exists to prevent, and the reason `CH` is a value export
rather than a string retyped at each end.

`confirmDiscardChanges` takes **no `reason` argument**, because there is only one caller context. The
close path answers from the `ProjectStateReport` mirror inside main and never invokes
`confirmDiscard`; `'open'` was the only value this could ever carry. The handler supplies `'open'` to
the shared `unsavedQuestion()` builder itself.

It calls `getEditorAPI().project.confirmDiscard?.(question)`; when the method is absent (the fixture
bridge under `npm run dev:web`, whose save is a stub anyway) it resolves `'discard'` so the browser
preview stays usable. `electron/ipc/project.ts` handles the channel with the *same*
`unsavedQuestion()` builder as the close path, and **computes the export sentence itself**:

```ts
ipcMain.handle(CH.appConfirmDiscard, async (event, q: unknown): Promise<DiscardChoice> => {
  if (!isDiscardQuestion(q)) return 'cancel';
  if (!beginDecision()) return 'cancel';              // §1.4 — one dialog at a time
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return 'cancel';
    const mirror = { isDirty: true, projectName: q.projectName, hasPath: !q.neverSaved };
    const { response } = await dialog.showMessageBox(
      win,
      unsavedQuestion(mirror, hasActiveExport(event.sender), 'open'),
    );
    return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel';
  } finally {
    endDecision();
  }
});
```

**`DiscardQuestion` carries no `exporting` field**, and this is why. §2.4 makes it a load-bearing
design fact that main is the only side that knows an export is running — `ExportDialog` keeps its
phase in local component state, and coupling autosave or the open guard to it would be a new
cross-slice dependency for no gain. A renderer-supplied `exporting: boolean` would therefore be a
field its only caller cannot compute, and typecheck would push the implementer into hardcoding
`false`, silently dropping the export sentence from the open-guard dialog. The handler is in main,
it already imports `unsavedQuestion`, and §9.3 already requires `hasActiveExport`. It asks.

**Where the guard goes is the whole design.** `openProject` becomes:

```
open()  →  migrateProject()  →  confirmDiscardChanges()  →  applyProject()
```

Not before `open()`. The reasons, in order of how much they cost when got wrong:

1. **Cancelling the file picker is the common case and must cost nothing.** Asking first means every
   accidental `Ctrl+O` raises a save prompt for a project the user was never going to replace.
2. **A file we refuse must not have cost a save.** A damaged or wrong-version `.veproj` already
   returns early on the `migrateProject` null branch, leaving the store untouched — the prompt must
   sit *after* that branch or a bad file extracts a save prompt for nothing.
3. **The guard belongs at the point of no return.** `applyProject` is where the old project stops
   existing. Every line between the guard and that call must be unconditional; there is exactly one
   (`applyProject(project)` itself).

Outcomes:

| Choice | Effect |
|---|---|
| `'save'` | `await saveProject()`. `'saved'` → proceed to `applyProject`. `'cancelled'` or `'failed'` → **abandon the open**, silently on cancel, with the existing `Notice` on failure. The current project stays loaded. |
| `'discard'` | `applyProject` as today |
| `'cancel'` | return. The chosen file is dropped, the store is untouched, nothing is said. |

The OS handoff (`useOpenHandoff` → `openProject(path)`) inherits all of this unchanged, which closes
the third loss path in §0.

**`openInFlight` stops being a millisecond and becomes a modal, so it needs a queue.** Today
`openProject` begins `if (openInFlight) return;` and says nothing, and that window is a few
milliseconds of picker-plus-read. After this change it spans `confirmDiscardChanges()` — a native
modal the user can sit on indefinitely — plus a possible `await saveProject()` with its own picker.
A `.veproj` double-clicked in Explorer during that window arrives through `second-instance` →
`requestOpen` → `useOpenHandoff` → `openProject(path)` → `return`, and the file vanishes with no
notice and no second chance. An explicit user gesture must not be silently dropped by a guard added
to protect them:

```ts
let queuedOpenPath: string | null = null;

export async function openProject(path?: string): Promise<void> {
  if (openInFlight) {
    // Only a pathful call is queued. A pathless Ctrl+O is a picker the user cannot have
    // reached anyway (a window-modal dialog owns the keyboard), and raising one later,
    // unprompted, would be worse than dropping it.
    if (path) queuedOpenPath = path;
    return;
  }
  openInFlight = true;
  try {
    /* …unchanged, with the guard before applyProject… */
  } finally {
    openInFlight = false;
    const queued = queuedOpenPath;
    queuedOpenPath = null;
    if (queued) void openProject(queued);      // one retry; the flag is already clear
  }
}
```

The retry is unconditional on the previous outcome, including `'cancel'`. Each explicit gesture gets
exactly one question, in the order the user made them, and `queuedOpenPath` is cleared before the
retry so a repeated double-click cannot build a chain. The last path wins if several arrive while
one dialog is up — which matches what a user pressing Explorer twice means.

**Save-as-you-open is not offered as a shortcut.** There is no "save a copy and open" button — three
outcomes, and only three, everywhere the question is asked.

### 1.10 Edge cases, decided

| Case | Decision |
|---|---|
| Close while the export **dialog** is open (not exporting) | Prompt as normal. The React dialog dies with the window; it holds no unsaved state. |
| Close while an in-app dialog has focus | The native dialog is window-modal and takes focus. The shared decision mutex (§1.4) swallows repeat close events. |
| Second X press while the prompt is up | `preventDefault()`, then ignored — the shared decision mutex (§1.4). The user cannot reach the X anyway; the dialog is modal. |
| X pressed while the **open** guard's dialog is up | `preventDefault()`, then ignored — same mutex, one owner (§1.4). The user answers the dialog in front of them and presses X again. |
| Renderer crashed (`webContents.isCrashed()`) | `requestRendererSave` raises the watchdog dialog **immediately**, in its crashed variant. `Close without saving` resolves `'abandon'` → the window closes and the snapshot is **kept**. It never resolves `'failed'`: that would abort the close and leave the window unclosable. |
| `isDirty` false but the user believes otherwise | Not our problem to solve here — `markDirty`'s caller list is closed and audited (PLAN §3.1) and is not changed by this work. |
| Project dirty, media still probing | Prompt and save normally. `status`, `progress` and `error` are not persisted (PLAN §2.6); a re-probe runs on reopen. |
| Rename-on-disk in flight | Unaffected. A rename is not project state and is not undoable (README); it completes or fails on its own. |
| Two windows | Cannot happen — `requestSingleInstanceLock`, and `setWindowOpenHandler` denies new windows. |

---

## 2. Autosave

### 2.1 Where snapshots live, and what they may never touch

```
app.getPath('userData')/autosave/
```

It is created lazily with `mkdir(dir, { recursive: true })` on the first write.

**That path is not the same string in a packaged build and a development run**, and anyone verifying
this feature needs both. `app.getPath('userData')` derives from `app.getName()`, which reads
`productName` from the package.json the app was started with:

| How it was started | `productName` seen | Directory |
|---|---|---|
| Packaged (`npm run dist`, the installer) | `Video Editor`, from `electron-builder.yml` | `%APPDATA%\Video Editor\autosave\` |
| `npm run dev`, `npm start`, `npx electron .` | none — the source `package.json` has only `"name": "video-editor"` | `%APPDATA%\video-editor\autosave\` |

Every verification step in §6 that names a directory therefore names both. **Preferred fix, and it
is one line:** add `"productName": "Video Editor"` to the source `package.json` (§9.7). It changes no
behaviour, converges the two paths, and makes the README's single stated path true everywhere rather
than true only after packaging.

**The rule that outranks every other rule in this section: autosave never writes to a path the user
chose.** Not `projectPath`, not a sibling of it, not a dotfile beside it, not a `.bak`. `projectPath`
appears in a snapshot only as a *string recorded inside the snapshot body*, and is used only to
label the recovery offer and to pre-fill a later save target. The only code in this application that
may write to a `.veproj` is `saveProject` in `electron/ipc/project.ts`, reached only from an explicit
`Ctrl+S` / Save / Save as.

Consequences that are features, not accidents: a read-only project directory, a project on a network
share that has gone away, and a project on a removable disk that has been unplugged all still
autosave. So does a project that has never been saved anywhere.

### 2.2 The snapshot format

One file, self-describing, no sidecar. A sidecar would introduce a second write that can be
half-landed relative to the first, which is exactly the failure mode §2.5 exists to prevent.

```ts
/* src/types/api.ts */

/** What the renderer sends. Main adds version, sessionId and savedAt. */
export interface AutosavePayload {
  /** Monotonic per renderer session, starting at 1. Orders writes against retirement (§2.6). */
  seq: number;
  /** The .veproj this project came from, or null when it has never been saved. */
  projectPath: string | null;
  projectName: string;
  /** ISO 8601 of the last explicit save in this session; null if there has not been one. */
  lastExplicitSaveAt: string | null;
  /** Exactly what serializeProject() produces. */
  project: ProjectFile;
}

/** What is on disk. */
export interface AutosaveSnapshot extends AutosavePayload {
  version: 1;
  sessionId: string;
  /** ISO 8601, when this snapshot was written. Distinct from project.savedAt. */
  savedAt: string;
}
```

The body is `JSON.stringify(snapshot, null, 2)` plus a trailing newline — the same shape as a
`.veproj`, on purpose: a snapshot is diffable, greppable, and if it ever comes to it, the
`"project"` value can be lifted out by hand and saved as a `.veproj`.

**Which is exactly why the inner `project.savedAt` may not be left as `serializeProject` writes it.**
That function stamps `savedAt: new Date().toISOString()` at serialize time, so a snapshot taken
verbatim would claim the project was *saved* at a moment when nothing was saved — and a hand-lifted
`.veproj` would carry that claim into the user's own file. `toAutosavePayload` overwrites it:

```ts
project: { ...serializeProject(s), savedAt: lastExplicitSaveAt ?? snapshotTakenAt },
```

So the inner value means **"the last time these bytes were on disk in a file the user chose"**, and
for a project that has never been saved it falls back to the moment the snapshot was taken — which
is the earliest honest statement available, and is true of the hand-lifted file itself. The outer
`AutosaveSnapshot.savedAt` is always the snapshot time and is the only field the recovery strip
reads. `seq` (§2.6) is the write-ordering token and appears nowhere in the UI.

### 2.3 Naming, and how a snapshot maps back to its project

```
<sessionId>.veproj.autosave
```

`sessionId` is minted once per main-process launch:

```ts
const sessionId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')}-${process.pid}`;
// → '20260808T143211-1284'
```

Four properties, each of which is doing a job:

- **`.autosave` is the last extension.** Windows resolves associations from the last extension only,
  and the installer claims `.veproj`. A snapshot therefore cannot be double-clicked into the app —
  which matters, because opening one *as a project* would give it a `projectPath` inside our own
  userData folder and the next `Ctrl+S` would write there.
- **Lexicographically sortable**, so "newest" is a string comparison and does not depend on file
  mtimes, which copy tools and backup software rewrite.
- **Carries the pid**, so two files can never collide even though `requestSingleInstanceLock` means
  two live sessions cannot exist.
- **Carries no project name.** Project names come from user input and would have to be sanitised for
  the filesystem; a name that sanitises to the same string as another would then collide. The
  mapping back lives in the body, where it needs no escaping.

**The mapping back is `snapshot.projectPath`,** and its `null` case is the one that has to be right:

| `projectPath` | Recovery offer says | Restore does |
|---|---|---|
| `'D:\cuts\beach.veproj'`, file exists | *Recovered unsaved changes to Beach cut* | `applyProject`, `setProjectPath(thatPath)`, `markDirty()`. `Ctrl+S` writes straight back to the file. |
| set, but the file is gone | same text | `applyProject`, `setProjectPath(null)`, `markDirty()`. `Ctrl+S` raises the save picker rather than silently recreating a file in a folder the user deleted. |
| `null` — **never saved anywhere** | *Recovered unsaved changes to Untitled* | `applyProject`, `setProjectPath(null)`, `markDirty()`. `Ctrl+S` raises the save picker. |

Main decides which of the first two applies and reports it, because only main can stat the path:

```ts
export interface RecoveryOffer {
  sessionId: string;
  projectName: string;
  projectPath: string | null;
  /** false when projectPath is set but no longer resolves to a file. */
  projectPathExists: boolean;
  savedAt: string;          // ISO 8601 — the strip renders it as a local date and time
  project: ProjectFile;     // still passed through migrateProject in the renderer (§2.7)
}
```

Restoring **always sets `isDirty`.** The restored state does not match anything on disk, and telling
the user it is saved when it is not is the exact lie this whole document exists to remove.

### 2.4 When it writes: debounce 2 s, ceiling 20 s, 60 s during an export, never during playback

**Both triggers, because either alone is wrong.** Pure time-based writes burn disk on an idle app
and still lose up to a full interval. Pure change-based writes fire on every mutation, which for a
timeline editor means every trim and every drag commit.

```ts
/* src/lib/project.ts */
export const AUTOSAVE_IDLE_MS = 2_000;                  // quiet-period debounce
export const AUTOSAVE_MAX_INTERVAL_MS = 20_000;         // hard ceiling on exposure
export const AUTOSAVE_TICK_MS = 500;                    // scheduler granularity
/* electron/ipc/project.ts */
const AUTOSAVE_MIN_INTERVAL_EXPORTING_MS = 60_000;      // main-side floor while ffmpeg runs
```

The rule, evaluated on a 500 ms `setInterval`:

> Write when the project is dirty **and** something has changed since the last snapshot **and**
> `readStore().isPlaying === false` **and** (2 000 ms have passed since the last mutation **or**
> 20 000 ms have passed since the last snapshot).

**Why `isPlaying` is in the rule.** The snapshot is built and posted on the renderer's main thread —
the same thread as `usePlaybackClock`'s rAF tick, which PLAN §8.4 makes the only rAF loop in the
app. The 20 s ceiling is reachable *during* playback: `pending` stays true from the edit that
preceded the spacebar, so without the gate the ceiling fires mid-transport. Holding `pending` and
letting the ceiling fire on the first tick after the transport stops costs nothing and removes the
question entirely. `lastMutationAt` is not touched while playing, so the debounce is not restarted
either — the write happens on the very next tick, not 2 s later.

**This does not weaken the guarantee in §0.** The bound is on *editing*, and playback mutates no
project state (PLAN §8.3 — the playhead is not project state and is not persisted). A snapshot
deferred for a ten-minute playback pass contains exactly the same edits it would have contained ten
minutes earlier. Nothing is at risk that was not already at risk when the spacebar was pressed.

**Why 2 000 ms for the debounce.** It is longer than any gesture — a drag commit, a trim, a split, a
paste of a run of clips — and short enough that a user who makes one edit and walks away is covered
before they have finished standing up. It is also comfortably longer than the 200 ms `localStorage`
UI-persistence debounce, so the two writers never interleave.

**Why 20 000 ms for the ceiling.** It is the number that answers "how much work can I lose?" and it
should be small enough that the answer is *"a sentence, not a scene."* Twenty seconds of timeline
editing is on the order of one or two operations.

**Two resources are spent per snapshot, and the one that matters is not the disk.**

*Renderer main-thread time*, which is the scarce one, because it is shared with the app's only rAF
loop. `toAutosavePayload` → `serializeProject` walks `Object.values(s.clips)`, `s.order.map(…)`,
`s.trackOrder.map(…)` and `Object.values(s.markers)` and builds a fresh object; that object is then
structure-cloned into the IPC message by `ipcRenderer.invoke`. Both are synchronous and both are on
that thread. Measured on a synthetic 500-clip / 6-track / 12-media / 20-marker project in the same
V8 the renderer runs:

| | per snapshot |
|---|---|
| `serializeProject` + payload build | **0.05 ms** |
| structured clone for the IPC hop | **0.54 ms** |
| **total renderer main-thread time** | **≈ 0.6 ms**, about 4 % of a 16.7 ms frame |

So the honest finding is that this is *not* a frame-dropper even at five hundred clips — but it is
main-thread time on the surface `PRODUCT.md` calls the product, it is spent for no benefit while
playing, and the `isPlaying` gate above removes it for one boolean. §6 step 20 re-measures it in the
running app rather than trusting this table, with `document.visibilityState === 'visible'` asserted,
and fails if a snapshot ever costs more than 4 ms.

*Disk*, which is not close to scarce. The fixture project — 12 media items, 6 tracks, 41 clips, 4
markers — serialises to roughly **24 KB** at 2-space indent; a heavy 500-clip project is about
**140–220 KB**. At 220 KB every 20 s that is **11 KB/s**, one `write` plus one `rename`, not a
sustained stream. For scale, a `libx264 -crf 18` 1080p30 encode writes on the order of 1–2 MB/s
continuously, so the snapshot is roughly 1 % of what the encoder is already doing.

**Why it is still relaxed during an export.** Contention is negligible by size, but the failure mode
is not symmetric: a stutter in a forty-minute encode is expensive, and forty extra seconds of
exposure is cheap. So while a job is live the *main process* enforces a 60 s floor, and it enforces
it rather than the renderer because main is the only side that knows an export is running
(`ExportDialog` keeps its phase in local component state, not in the store — and coupling autosave to
that would be a new cross-slice dependency for no gain):

```ts
type AutosaveWriteResult =
  | { ok: true; skipped: false; at: number }
  | { ok: true; skipped: true }
  | { ok: false };
```

`skipped: true` means main declined this write — an export is running and the previous snapshot is
younger than 60 s, or the write was retired underneath it (§2.6). The renderer leaves its `pending`
flag set, so the next tick retries; it does **not** advance `autosaveAt`. No error, no notice,
nothing visible. The three-member union rather than one shape with a boolean is deliberate: `at` is
meaningless on the other two branches, and a discriminated union makes the renderer's handling total
instead of leaving a `number | null` to guess at.

**The 60 s floor is the one place the §0 bound is looser, and it is stated as such** — in §0, in
§1.8, in §2.4's heading and in the README bullet (§7) — four places, one form of words. "At most
twenty seconds of editing, or a minute while an export is running" is one extra clause; a flat
twenty would be a number the design does not honour for the longest, most crash-prone window in a
session.

**It never writes on a keystroke.** Two independent reasons: the mutations that mark a project dirty
are *commits*, not characters — `renameClip`, `setProjectName` and the inspector's text fields commit
on Enter or blur, never per key — and the 2 s debounce would absorb them even if they did not.

**It never writes a clean project.** `isDirty === false` means a real `.veproj` already contains
everything a snapshot would, and it is a better artefact in every way.

**It is not a rAF loop and does not touch the playhead.** PLAN §8.3 (one playhead writer) and §8.4
(one rAF loop) are unaffected: this is a single 500 ms `setInterval` plus one store subscription that
never calls `set()`. Both invariants were verified by measurement and stay true.

### 2.5 The write itself: temp → fsync → rename

A snapshot that is half-written when the process dies is worse than no snapshot: it is an offer to
restore garbage, and the user has to be able to trust the offer or the feature is a liability.

```ts
/* electron/ipc/project.ts */

/**
 * `rename` over an EXISTING destination is MoveFileEx(REPLACE_EXISTING) on Windows, and it
 * fails EACCES/EPERM/EBUSY whenever anything holds the destination open — an antivirus
 * scanner, an Explorer preview handler, the .veproj open in another editor. Node's rename
 * performs no retries of its own. This is the same lesson `removeFile` in
 * electron/ipc/export.ts already learned, with the same budget.
 */
async function renameWithRetry(from: string, to: string, attempts = 3): Promise<void> {
  for (let i = 1; ; i++) {
    try { return await rename(from, to); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const transient = code === 'EACCES' || code === 'EPERM' || code === 'EBUSY';
      if (!transient || i >= attempts) throw e;
      await delay(100);
    }
  }
}

async function writeSnapshotAtomic(target: string, body: string): Promise<void> {
  const scratch = `${target}.${process.pid}.tmp`;
  const fh = await open(scratch, 'w');
  try {
    await fh.writeFile(body, 'utf8');
    await fh.sync();                       // ← the part a plain writeFile misses
  } finally {
    await fh.close();
  }
  await renameWithRetry(scratch, target);  // a single filesystem operation, retried briefly
}
```

Three properties:

- **Until the `rename` lands, the previous good snapshot is untouched.** A full disk or a crash
  mid-write costs the newest 20 seconds, never the snapshot before it.
- **`fh.sync()` before the rename is not optional.** Filesystems journal metadata more eagerly than
  data. Without the fsync, a power cut immediately after the rename can leave a correctly-named,
  correctly-timestamped, **zero-length** snapshot — the exact "worse than none" case. The cost is one
  fsync per 20 s.
- **The rename is one filesystem operation, not a copy** — no half-replaced destination is ever
  observable. It is *not* unconditionally infallible, which is why `renameWithRetry` exists: on
  Windows the failure is a held handle, and a held handle is usually gone 100 ms later. Three
  attempts, ~100 ms apart, then give up.

On any throw: `unlink(scratch)` best-effort, return `{ ok: false }`. Never throw across the bridge —
same rule the rest of `electron/ipc/project.ts` already follows. A snapshot that fails all three
attempts is a §2.9 failure and nothing more.

**`electron/ipc/project.ts`'s existing `saveProject` gets the same two changes: `fh.sync()` and
`renameWithRetry`.** It already does temp-then-rename but writes with `writeFile`, with no fsync and
no retry, so a `.veproj` is exposed to the same zero-length window *and* turns a scanner holding the
file into a `Save failed` the user cannot explain and cannot act on — on the app's single most
important operation. Same file, same owner, a handful of lines. Do it in the same change.

### 2.6 Retirement — when a snapshot stops existing

> "A clean exit or an explicit save retires the snapshot, or the app will offer to recover work the
> user already has."

Retire this session's snapshot on:

| Event | Where | Why |
|---|---|---|
| A successful explicit save | `saveProject()` after `markSaved()` | the `.veproj` now contains everything the snapshot did |
| A project replaced (open, or a restore) | `openProject()` after `applyProject`; `restoreRecovery()` | the snapshot describes a project that is no longer loaded |
| A clean exit — **both** Save and Do not save | `approveAndClose(win, { retireSnapshot: true })`, synchronously | Save: it is on disk. **Do not save: the user explicitly threw the work away, and offering it back next launch would override a decision they already made.** |
| **Not** a clean exit — the §1.6 watchdog's `'abandon'`, a destroyed window, `session-end`, a crash, a kill | nothing runs | `retireSnapshot: false`. The user closed a broken window; they did not discard their work, and the snapshot is the entire remedy (§1.4) |

**Retirement is not just a delete, because a write can land after it.** This is the sharpest race in
the feature and it produces the one outcome the whole document exists to prevent — the app telling
the user something false about their data:

> A tick at *t* sends `autosaveWrite`. The user presses `Ctrl+S` at *t+10 ms*. The save completes at
> *t+50 ms* and retires the snapshot. The write's `rename` lands at *t+80 ms* and **puts the snapshot
> back**. The next launch offers to "recover unsaved changes" for a project that was saved and closed
> cleanly, and §2.8's Restore then unconditionally `markDirty()`s it.

The mtime backstop below does not catch it either: the resurrected `snapshot.savedAt` (*t+80*) is
*newer* than the `.veproj`'s mtime (*t+50*), so the sweep declines to sweep.

The fix is a **monotonic write sequence number**, `AutosavePayload.seq` (§2.2), starting at 1 and
incremented synchronously by the renderer immediately before each `autosaveWrite`. Main holds
`lastRetiredSeq`, and applies it in three places:

```ts
/* electron/ipc/project.ts */
let lastRetiredSeq = 0;
let inFlightWrite: Promise<void> | null = null;

async function autosaveWrite(payload: AutosavePayload): Promise<AutosaveWriteResult> {
  if (payload.seq <= lastRetiredSeq) return { ok: true, skipped: true };   // 1. on entry
  /* …export floor, body build… */
  const p = writeSnapshotAtomic(target, body);
  inFlightWrite = p.then(() => undefined, () => undefined);
  await p;
  if (payload.seq <= lastRetiredSeq) {                                     // 2. after the rename
    await rm(target, { force: true });        // retired underneath us — undo the resurrection
    return { ok: true, skipped: true };
  }
  return { ok: true, skipped: false, at: Date.now() };
}

async function autosaveRetire(throughSeq: number): Promise<void> {
  lastRetiredSeq = Math.max(lastRetiredSeq, throughSeq);
  if (inFlightWrite) await inFlightWrite;                                  // 3. then delete
  await rm(snapshotPath, { force: true });
}
```

1. **The entry check** stops a write the renderer sent *after* the retire (a tick that fired
   concurrently) from recreating anything.
2. **The post-rename re-check is the one that actually closes the race above**, and it is also what
   makes the *synchronous* retire correct — `retireAutosaveSync()` cannot await anything, so a write
   already past its entry check must be able to clean up after itself. It sets
   `lastRetiredSeq = Number.MAX_SAFE_INTEGER`, so every write for the rest of the process, in flight
   or not, resolves to `skipped` and deletes what it wrote.
3. **Awaiting the in-flight write** is what makes the returned promise mean *"nothing is left"*,
   which `openProject` relies on before `applyProject`.

The renderer passes its **current** `writeSeq` as `throughSeq`. Because it is single-threaded and
increments before sending, every write it has already dispatched has `seq ≤ throughSeq`; and after
`markSaved()` the store is clean, so §2.4's rule emits nothing further. One slot for `inFlightWrite`
is sufficient **because §2.11 guarantees at most one outstanding write** — that dependency runs in
this direction and is stated in both places.

`autosaveRetire` is invoked fire-and-forget from the renderer (`project.autosaveRetire?.(writeSeq)`);
`retireAutosaveSync()` is called from `approveAndClose`, using `rmSync`, because the process may not
survive an `await`.

**`retireAutosaveSync()` must never throw.** `rm`'s `force: true` swallows `ENOENT` and nothing else,
so on Windows a scanner or backup agent holding the snapshot gives `EPERM`/`EBUSY`. It runs inside
`approveAndClose` *after* `closeApproved` is set and *before* `win.close()`, so an uncaught throw
there means: the X did nothing, the user is told nothing, and the **next** X press closes instantly
with no prompt at all, silently discarding unsaved work on a gesture that gave no warning. So the
try/catch lives inside the function itself, not only at the call site:

```ts
export function retireAutosaveSync(): void {
  lastRetiredSeq = Number.MAX_SAFE_INTEGER;
  try { rmSync(snapshotPath, { force: true }); } catch { /* hygiene, never a reason to fail */ }
  try { tombstoneHeldOffer(); } catch { /* ditto */ }
}
```

Retiring a snapshot is hygiene. It is never a reason to fail a close, and §1.4 wraps the call a
second time for the same reason.

**A previous session's unanswered offer is tombstoned on a clean exit too** — that is
`tombstoneHeldOffer()` above, and the same call sits at the end of the async `autosaveRetire`.
Without it: session A crashes leaving S_A; session B shows the strip, the user ignores it, works, and
exits cleanly (retiring only S_B); session C shows the strip for S_A again — **forever**, because the
strip's only two exits are Restore and Discard and the user has already declined both, and it costs
32 px of the editor at every launch. A user who saw the offer and chose to keep working and then
exited cleanly *has* answered it. Tombstoning rather than deleting means it follows the Discard path
exactly: renamed to `<sessionId>.veproj.discarded`, swept after 7 days (§2.7, §2.8), recoverable in
the meantime by anyone willing to rename a file. If the strip was never shown — the offer was held
but `autosaveRecoverable` was never invoked — the tombstone still happens, and the seven days are the
safety margin for that case.

**Not retired on `session-end`, on a crash, on a kill, or on the §1.6 watchdog's `'abandon'`.** Those
are the cases the file exists for.

**Second line of defence, because a delete can fail.** At launch, a snapshot whose `projectPath`
resolves to a file whose **mtime is newer than `snapshot.savedAt`** is swept without an offer: the
file on disk is more recent than the snapshot, so the snapshot has nothing to add. With `seq` in
place this is a backstop rather than the primary defence — it catches a retirement that failed
outright (a held handle, a removed drive) and a project the user saved from somewhere else entirely.

### 2.7 Recovery at launch — how we know a session died

**The existence of a snapshot at launch is itself the signal.** No heartbeat, no lock file, no pid
liveness check. This is sound for one reason worth stating: `app.requestSingleInstanceLock()`
guarantees exactly one live process, so a snapshot found during `whenReady` cannot belong to a
running session — and every clean exit path retires its own. Pid liveness checks are the usual
alternative and they are wrong across reboots, because pids are reused.

Main, during `whenReady`, before the window is created:

1. `readdir` the autosave directory. Missing directory → nothing to offer, done.
2. Sweep `*.veproj.discarded` older than **7 days** (§2.8), and any `*.tmp` older than 1 hour.
3. Read every `*.veproj.autosave`. **A snapshot is deleted only after a SUCCESSFUL read whose bytes
   then fail `JSON.parse`, or fail
   `version === 1 && isObject(project) && typeof sessionId === 'string'`.** Bytes we have read and
   cannot use are not a snapshot, and deleting them is right.
4. **An IO error is not a validation failure.** If `readFile` itself throws — `EBUSY`, `EACCES`,
   `EPERM`, a scanner or a backup agent holding the file, which on Windows is at its most likely
   during boot, which is exactly when this code runs — the file is **left untouched**, skipped for
   this launch, and offered as nothing. Deleting on any failure would destroy the one artefact the
   whole feature exists to produce, at the one moment it is needed. §6 step 21 holds the file open
   with an exclusive handle across a launch and asserts it still exists afterwards.
5. Drop any snapshot that is **stale** by the mtime test in §2.6.
6. Sort the survivors by `savedAt` descending. **Keep the newest, delete the rest** — but only among
   snapshots successfully read at step 3; a file skipped at step 4 is neither offered nor deleted.
7. Hold it, and hold the **promise**, not just the value.

**How the launch race is actually avoided.** `registerProjectIpc(ipcMain)` is a *synchronous* call
inside `main.ts`'s `whenReady`, and `createWindow()` runs on the next line, while every step above —
`readdir`, N × `readFile`, `stat` — is asynchronous. So the renderer's `invoke` can and will land
before the scan resolves. Asserting "there is no launch race because `invoke` is a pull, not a push"
is not a mechanism. This is the mechanism, and it is one line:

```ts
/* electron/ipc/project.ts, inside registerProjectIpc */
const scan = scanAutosaveDir();                       // started now, not awaited
ipcMain.handle(CH.autosaveRecoverable, () => scan);   // every call gets the SAME promise
```

An early `invoke` simply waits on the promise the scan already owns; a late one gets the settled
value. No ready-ping is needed (unlike `CH.projectOpenPath`, which needs one because it is a push).

**`autosaveRecoverable` is idempotent and consumes nothing.** It returns the held offer every time it
is asked; only `autosaveResolveOffer` — Restore or Discard — removes anything. This matters because
`src/main.tsx` renders `<StrictMode>`, so React 18 mounts, tears down and remounts every effect in
development: §9.4's `useEffect(() => startProjectSafety(), [])` calls it **twice** on every dev run,
which is where §6 steps 13 to 18 are executed. An offer that were consumed on read would make the
strip never appear under `npm run dev` — a feature that works only in the packaged build nobody
tests. See §2.11 for what the double mount means for the timer, the mirror push and the
`setRecoveryOffer` that resolves after its own teardown.

**Only the newest is offered.** More than one survivor means several sessions died without a clean
exit; presenting a list is a startup modal wearing a different hat, and only the most recent can be
the work the user actually remembers. This is a deliberate cut and is stated in the README.

The renderer runs `migrateProject(offer.project)` before showing anything — the same validation
`openProject` uses, for the same reason: main hands back a parsed object, the renderer decides
whether it is a project. If it returns `null` the offer is dropped silently and the snapshot is
tombstoned. The user is not told that a file they never knew about was unreadable.

### 2.8 The offer is an inline strip, never a startup dialog

`PRODUCT.md` forbids a modal-first launch outright — *"Modal-first flows"*, *"the app opens directly
into the task"*, *"no entrance sequence"* — and a dialog before the user has seen the editor is
precisely that. So the app boots normally, into whatever it would have booted into (an empty project,
or the `.veproj` the OS handed over), and the offer appears as a **quiet strip inside the title bar**,
below the bar and above the notice slot.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ▣  Beach cut •                                                    …  ─ □ ✕   │  36px  --surface-chrome
├──────────────────────────────────────────────────────────────────────────────┤
│ ↺  Recovered unsaved changes to Beach cut from 8 August, 14:32.              │  32px  --surface-panel
│                                              [ Restore ]   [ Discard ]        │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Why not the existing `InlineNotice` / `setNotice` channel**, which is the app's one notification
surface. Three reasons, and the first is a work-loss bug:

1. `setNotice` **replaces, it never queues** (PLAN §3.1, §5, "one at a time, never stacked"). The
   first `fps-mismatch` warning from a re-probing media item would evict the recovery offer and the
   user would never see it again.
2. It must **persist, for the whole session, until answered**. A notice is dismissible by design;
   this is a question. (Across sessions it does not persist indefinitely — a clean exit tombstones an
   unanswered offer, §2.6.)
3. It is **not an error**. `InlineNotice` has exactly two tones, `danger` and `warning`, and
   borrowing either would say something false. The `--status-warning` token also has exactly one
   owner in this build — the media row (PLAN §7.6) — and this is not it.

Keeping it out of the notice channel also leaves that channel free to say *"Save failed"* while the
recovery strip is still up, which is a real combination.

**Specification.**

| Property | Value |
|---|---|
| Element | `<section class="shell-titlebar-recovery" role="status" aria-label="Recovered unsaved work">` in `TitleBar.tsx`, between `.shell-titlebar-bar` and `.shell-titlebar-notice` |
| Height | 32px, `padding: 0 var(--space-lg)`, `gap: var(--space-md)`, flex row |
| Background | `--surface-panel` |
| Borders | **1px `--border-structural` on the top edge only** (PLAN §7.5 — a major-region boundary). `.shell-titlebar` already carries `border-bottom: 1px solid var(--border-structural)`, so a bottom border here would draw the same boundary twice, one pixel apart — a 2px structural rule that exists nowhere else in the app and reads as a rendering bug at the exact moment the user is being asked to trust a recovery offer. `.shell-titlebar-notice` already relies on the header owning that edge; this follows it |
| Icon | `RotateCcw` 14px `strokeWidth={1.75}`, `--text-muted`, `aria-hidden` |
| Text | `.type-body`, `--text-ink`. Sentence case, no trailing exclamation |
| Timestamp | inline in the sentence, `.type-body` **not** `.type-numeric` — it never changes while live, and DESIGN.md's Tabular Rule scopes the mono to numerals that tick |
| Actions | `<Button variant="secondary" size="sm">Restore</Button>` then `<Button variant="ghost" size="sm">Discard</Button>` |
| Accent | **none.** Not one of the six permitted uses (PLAN §7.4). `Restore` is `secondary`, not `primary` |
| Status colour | **none.** Nothing here is an error |
| Shadow | none — it is in flow (DESIGN.md, The No-Shadow-In-Flow Rule) |
| Motion | **none, deliberately.** DESIGN.md forbids an entrance animation on launch, so there is nothing for `prefers-reduced-motion` to have an alternative to. See the timing note below — it is not on first paint, and it still does not animate |
| Announcement | `role="status"` on the `<section>`. Its insertion is announced politely, once, without taking focus. See below |
| Focus | The two buttons carry the standard +2px `--accent` ring from `Button`. **Nothing is autofocused** — stealing focus at launch is exactly the ceremony `PRODUCT.md` rejects. They are early in the tab order because the title bar is |
| Copy | `Recovered unsaved changes to {name} from {8 August, 14:32}.` — `toLocaleString` with `{ day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }` |

**When it appears, stated honestly, and why that needs `role="status"`.** The offer arrives from
`project.autosaveRecoverable?.()` inside `startProjectSafety()`, itself inside a `useEffect` (§9.4),
so the strip is **not** present on first paint: it is inserted one IPC round trip afterwards, and a
32 px `flex: 0 0 auto` section entering the `.shell-titlebar` column pushes the preview and the
timeline down by 32 px. Two consequences, both decided rather than left implicit:

- **A sighted user sees a single reflow**, within a frame or two of the editor appearing and well
  before anyone has begun working. It is **not** animated, and the shift is **accepted, not
  reserved**: reserving 32 px on every launch to smooth a strip that appears after a crash would tax
  every ordinary launch for a rare event, which is the opposite of what §2.8 is for.
- **A screen-reader user would otherwise get nothing at all.** Nothing is autofocused (correctly),
  so without a live region a whole session of recovered work would simply be added to the DOM in
  silence. `role="status"` is `aria-live="polite"` plus `aria-atomic`: it announces the sentence once
  when the region is populated, does not interrupt, and does not move focus. `PRODUCT.md` treats
  perceivable state as a correctness requirement, and this costs no pixels, no token and no motion,
  so the no-autofocus decision stands untouched.

**Restore.**

```
migrateProject(offer.project)          → null ⇒ tombstone, clear the offer, say nothing
confirmDiscardChanges()                → only when the CURRENT project is dirty (see below)
applyProject(project)
setProjectPath(offer.projectPathExists ? offer.projectPath : null)
markDirty()                            ← always. The restored state matches nothing on disk
autosaveResolveOffer(sessionId, 'restored')   → deletes the snapshot
clearRecoveryOffer()
```

The `confirmDiscardChanges` step handles the real combination where the OS handed the app a `.veproj`
at launch *and* a snapshot is recoverable: Restore would replace a project the user is already
looking at, so it goes through the same three-way guard as `Ctrl+O`. In the ordinary case — an empty
untouched project — that guard returns `'discard'` immediately and nothing is shown.

**Discard** clears the offer and calls `autosaveResolveOffer(sessionId, 'discarded')`, which does
**not** delete: it renames the snapshot to `<sessionId>.veproj.discarded`, and the launch sweep in
§2.7 removes tombstones older than 7 days. `autosaveResolveOffer` — for either answer — also clears
main's **held** offer, which is what makes §2.6's `tombstoneHeldOffer()` a no-op once the user has
answered. An offer is therefore resolved exactly once, by whichever comes first: Restore, Discard, or
a clean exit. Discard is one click on an irreversible loss of a whole
session, and the tombstone makes a misclick recoverable by anyone willing to rename a file — at a
cost of one `rename` and one `readdir` filter. It is `variant="ghost"` against `Restore`'s
`secondary` for the same reason. There is **no confirmation dialog on Discard**: the snapshot is a
copy, the user's real file is untouched, and a confirm here would be exactly the ceremony this
product refuses.

### 2.9 When autosave fails: quiet, then once, then never

A failing autosave must never interrupt the edit. A full disk that raised a `Notice` every 20 seconds
would be worse than having no autosave at all.

| Consecutive failures | Behaviour |
|---|---|
| 1 | **Silent.** `autosaveFailures` becomes 1. Nothing visible, tooltip unchanged. Transient failures (a virus scanner holding the file, a momentary lock) are common and self-healing — and §2.5's `renameWithRetry` has already absorbed the shortest of them |
| 2 | **One** `setNotice({ tone: 'warning', title: 'Autosave failed', message: 'Snapshots are not being written, so unsaved changes are not protected — save the project' })`, **and at the same moment** the dirty bullet's tooltip becomes `Unsaved changes — autosave is not working` (§4). Icon + word + colour, in that order, through the existing `InlineNotice` (PLAN §7.6). The notice and the tooltip appear together, at the second consecutive failure — there is no state in which one is showing and the other is not |
| 3+ | **Nothing further, for the rest of the session.** The tooltip stays. One notice, once |
| A later success | `autosaveFailures` resets to 0; the tooltip returns to normal. The notice is not cleared — the user dismisses it, or the next real notice replaces it |

`{ ok: true, skipped: true }` is **not** a failure and does not touch the counter.

### 2.10 What autosave never does

A closed list, because the store's dirty contract is a closed list (PLAN §3.1):

- **It never calls `markDirty()` or `markSaved()`.** Writing a snapshot is not saving. `isDirty` means
  "differs from the user's file", and a snapshot does not change that.
- **It never touches `projectPath` or `projectName`.**
- **It never writes to `localStorage`.** That key (`ve.ui.v1`) has one owner, the shell.
- **It never enters the undo history.**
- **It is not on the `markDirty` caller list** and must not be added to it. `noteAutosaveWritten`,
  `noteAutosaveFailed`, `setRecoveryOffer` and `clearRecoveryOffer` belong on PLAN §3.1's
  *explicitly NOT dirty* list, beside `setNotice`.
- **`restoreRecovery` is the one new `markDirty` caller** and must be added to PLAN §3.1's permitted
  list (§9.5).
- **It never blocks.** Every path is fire-and-forget or awaited off the interaction path.

### 2.11 The scheduler, concretely

One entry point, called once from `App.tsx` (§9.4). It lives in `src/keyboard/projectActions.ts`
rather than `src/lib/project.ts` to avoid an ESM value cycle — `projectActions` already imports
`project.ts`, and the reverse edge would close the loop that PLAN §1.1 warns about.

```ts
/* src/keyboard/projectActions.ts */
/** Wires the dirty mirror, the autosave loop, the close-save listener and the recovery query.
 *  Returns its own teardown. Safe to call when no bridge method exists (dev:web). */
export function startProjectSafety(): () => void;
```

It does four things:

1. **One store subscription, no selector.** `useEditorStore.subscribe(listener)` fires once per
   `set()`. The listener compares **twelve** cached references and primitives — `clips`, `tracks`,
   `trackOrder`, `markers`, `items`, `order`, `fps`, `width`, `height`, `projectName`,
   **`projectPath`**, `isDirty` — and returns immediately when none changed. **It allocates
   nothing**, which is why a bare subscription is safe here at 60 store writes per second during
   playback (PLAN §1.3 rule 1). A playhead-only write changes none of the twelve and costs twelve
   comparisons.
   On a change it sets `pending = true` and `lastMutationAt = Date.now()`.
   On an `isDirty` / `projectName` / `projectPath` change it also pushes
   `api.project.reportState?.({ isDirty, projectName, hasPath: projectPath !== null })` (§1.3).

   **`projectPath` is in the compared set precisely because the push reads it.** It is a distinct
   action that does *not* call `markDirty` (`uiSlice.ts`), and `openProject` calls it *after*
   `applyProject` has already set `isDirty` false — so a `setProjectPath` that changes nothing else
   would never trip an eleven-field listener, `hasPath` would stay `false` in main's mirror, and the
   close dialog would print *"This project has never been saved, so you will be asked where to put
   it"* for a project that has a path. Twelve fields, one more comparison, no allocation.

2. **One `setInterval(tick, 500)`.** `tick` applies the §2.4 rule and, when it fires, increments
   `writeSeq` and calls `api.project.autosaveWrite?.(toAutosavePayload(readStore(), { seq: ++writeSeq, lastExplicitSaveAt }))`.
   **A write already in flight suppresses the next — there is never more than one outstanding**, and
   §2.6's single `inFlightWrite` slot depends on that being true. `autosaveRetire` is called with the
   current `writeSeq`, which is ≥ every seq already dispatched because this thread increments before
   it sends.
3. **`api.project.onSaveRequest?.(...)`** — the close-save listener from §1.6.
4. **One `void api.project.autosaveRecoverable?.()`**, whose result goes to `setRecoveryOffer` after
   `migrateProject` validation.

**It is called twice on every mount in development, and it has to survive that.** `src/main.tsx`
renders `<StrictMode>`, so React 18 runs mount → unmount → mount for every effect, and §9.4's
`useEffect(() => startProjectSafety(), [])` therefore runs the four steps above twice with a
teardown in between. Three consequences, all handled here rather than left to the implementer:

- **The teardown must be total and must cancel in-flight work.** It clears the interval, unsubscribes
  the store listener, calls the `onSaveRequest` unsubscribe, **and sets a `cancelled` flag that the
  pending `autosaveRecoverable().then()` checks before calling `setRecoveryOffer`.** Without the
  flag, the first call's promise resolves after its own teardown has run and writes an offer into a
  store that a second, live instance is also writing to.
- **Nothing it does is destructive when repeated.** `autosaveRecoverable` is idempotent and consumes
  nothing (§2.7); `reportState` is a mirror push, so a duplicate is a no-op with the same value; the
  duplicate `onSaveRequest` registration is removed by the teardown. **`writeSeq` and
  `lastExplicitSaveAt` are module-level, not per-instance**, so a remount continues the sequence
  rather than restarting it at 0 — restarting would put the second instance's first writes below
  `lastRetiredSeq` and have main silently drop them as `skipped` (§2.6).
- §6 step 24 runs under `npm run dev` and asserts exactly one interval, one strip and one snapshot.

```ts
/* src/lib/project.ts — pure, beside serializeProject, which it calls */
export function toAutosavePayload(
  s: StoreState,
  meta: { seq: number; lastExplicitSaveAt: string | null },
): AutosavePayload;
```

It is pure: the caller owns `seq` and `lastExplicitSaveAt` (both module-level in
`projectActions.ts`), and this function only assembles them with `serializeProject(s)` and the
`project.savedAt` overwrite from §2.2.

---

## 3. Store additions — `src/state/uiSlice.ts`

Three fields and four actions. Scoped to autosave status, per the ownership note in §8.

```ts
export interface UiState {
  /* …existing… */
  /** Date.now() of the last successful snapshot, or null if none this session. */
  autosaveAt: number | null;
  /** Consecutive autosave failures. 0 = healthy. Drives the §2.9 escalation. */
  autosaveFailures: number;
  /** The launch-time recovery offer, or null once answered. Session-only, never persisted. */
  recovery: RecoveryOffer | null;
}

export interface UiActions {
  /* …existing… */
  noteAutosaveWritten(at: number): void;   // sets autosaveAt, resets autosaveFailures to 0
  noteAutosaveFailed(): void;              // increments autosaveFailures; NEVER raises the notice itself
  setRecoveryOffer(offer: RecoveryOffer): void;
  clearRecoveryOffer(): void;
}
```

Selectors, both `[stable]` — primitives, no allocation, safe as bare hook selectors:

```ts
export const selectAutosaveHealthy = (s: StoreState): boolean => s.autosaveFailures === 0;
export const selectHasRecovery = (s: StoreState): boolean => s.recovery !== null;
```

**None of the three fields is persisted.** They are session-only, like `inspectorPinned`, `notice`
and the two dialog flags — `readPersistedUi` / `writePersistedUi` and the `PersistedUi` shape are
unchanged, so `ve.ui.v1` does not need a version bump.

The §2.9 escalation lives in the caller, not in `noteAutosaveFailed`, because a slice must not decide
UI policy and because `setNotice` is a cross-slice write that PLAN §3.1 restricts.

---

## 4. Title bar — `src/components/shell/TitleBar.tsx`

**At rest, nothing new is drawn.** PLAN §7.7 already settled the dirty indicator: a `--text-muted`
`•` suffix on the project name, accessible name `<project name>, unsaved changes`, tooltip
`Unsaved changes`. Autosave does not get pixels; it gets words that were already there.

| State | `title` on `<h1>` | sr-only suffix | Extra glyph |
|---|---|---|---|
| clean | none | none | none |
| dirty, autosave healthy, a snapshot exists | `Unsaved changes — last recovery point 14:32` | `, unsaved changes, last recovery point 14:32` | none |
| dirty, autosave healthy, no snapshot yet | `Unsaved changes` | `, unsaved changes` | none |
| dirty, autosave failing (**≥2** — §2.9's escalation, not ≥1) | `Unsaved changes — autosave is not working` | `, unsaved changes, autosave failed` | none |

No spinner, no "Saving…", no time that ticks. `PRODUCT.md`: *"no high-frequency motion at rest, no
elements that pulse or shimmer while idle."* A recovery-point time that updated every 20 seconds in a
visible label would be exactly that, so it lives in the tooltip and the accessible name, where it is
read on demand and costs nothing at rest. The failure state deliberately adds **no icon and no
colour** to the bar — it has already been said properly, once, through the `InlineNotice` channel
(§2.9), and saying it twice would spend chrome on a state that should be rare.

The recovery strip (§2.8) is the only new element, it is transient, and it appears at most once per
launch.

Contrast, verified against the tokens it uses: `--text-ink` on `--surface-panel` is 14.04:1;
`--text-muted` on `--surface-panel` is 6.36:1; `--border-structural` on `--surface-panel` is
3.66 / 3.80 / 3.96:1 across the three themes (PLAN §7.5). Nothing new needs re-verification because
nothing new is coloured.

---

## 5. IPC and API surface, consolidated

Every new bridge method is **optional (`?`)**, exactly as `media.reveal?` and `export?` already are.
That is not cosmetic: it means `src/dev/fixtures.ts` needs no change at all and `npm run dev:web`
keeps working, with feature detection at every call site.

```ts
/* src/types/api.ts — additions to CH */
appProjectState: 'app:project-state',        // renderer → main, send
appSaveRequest:  'app:save-request',         // main → renderer, send
appSaveResult:   'app:save-result',          // renderer → main, send
appConfirmDiscard: 'app:confirm-discard',    // renderer → main, invoke
autosaveWrite:      'autosave:write',        // renderer → main, invoke
autosaveRecoverable:'autosave:recoverable',  // renderer → main, invoke
autosaveRetire:     'autosave:retire',       // renderer → main, invoke
autosaveResolve:    'autosave:resolve-offer',// renderer → main, invoke
```

```ts
/* src/types/api.ts — additions to EditorAPI.project */
interface EditorAPI {
  project: {
    /* …existing save / open / pickDirectory / onOpenRequest… */

    /** Mirrors dirty state into main so win.on('close') can answer synchronously. */
    reportState?(report: ProjectStateReport): void;
    /** Main is asking the renderer to save before a close completes. Returns its unsubscribe. */
    onSaveRequest?(cb: (token: string) => void): () => void;
    reportSaveResult?(token: string, outcome: CloseSaveOutcome): void;
    /** Raises the native three-way question. Absent under dev:web ⇒ treat as 'discard'. */
    confirmDiscard?(q: DiscardQuestion): Promise<DiscardChoice>;

    autosaveWrite?(payload: AutosavePayload): Promise<AutosaveWriteResult>;
    /** Idempotent: returns the held offer without consuming it (§2.7). */
    autosaveRecoverable?(): Promise<RecoveryOffer | null>;
    /** Retires THIS session's snapshot through `throughSeq` (§2.6). Fire-and-forget. */
    autosaveRetire?(throughSeq: number): Promise<void>;
    /** Answers a recovery offer from a PREVIOUS session. */
    autosaveResolveOffer?(sessionId: string, how: 'restored' | 'discarded'): Promise<void>;
  };
}

/** Everything the open-guard dialog needs that only the renderer knows. `exporting` is NOT
 *  here and must not be added: main computes it with hasActiveExport (§1.9). `reason` is not
 *  here either — this question is only ever asked on the open path. */
export interface DiscardQuestion {
  projectName: string;
  neverSaved: boolean;
}

/* Declared ONCE, here. src/keyboard/projectActions.ts imports them; it does not redeclare
   them, for the same reason CH is imported rather than retyped. */
export type DiscardChoice = 'save' | 'discard' | 'cancel';
export type CloseSaveOutcome = 'saved' | 'cancelled' | 'failed';
export type CloseSaveResolution = CloseSaveOutcome | 'abandon';   // 'abandon' is main-internal

export type AutosaveWriteResult =
  | { ok: true; skipped: false; at: number }
  | { ok: true; skipped: true }
  | { ok: false };
```

`electron/ipc/project.ts` gains, alongside its existing three channels:

```ts
export function registerProjectIpc(ipcMain: IpcMain): void;   // + the four autosave channels
                                                              // + CH.appConfirmDiscard

/** For approveAndClose — the process may not survive an await. Never throws (§2.6). */
export function retireAutosaveSync(): void;

/** True while a snapshot for THIS session exists on disk. Read by the §1.6 watchdog so its
 *  dialog does not promise a recovery that autosave never wrote. */
export function hasLiveSnapshot(): boolean;

/** The window-title question, shared by the close guard and the open guard. */
export function unsavedQuestion(
  s: ProjectStateReport, exporting: boolean, reason: 'close' | 'open',
): Electron.MessageBoxOptions;

/** The one decision mutex, shared with main.ts's close guard (§1.4). */
export function beginDecision(): boolean;
export function endDecision(): void;
export function isDecisionInFlight(): boolean;
```

`electron/main.ts` imports `retireAutosaveSync`, `hasLiveSnapshot`, `unsavedQuestion` and the three
decision-mutex functions from it, and `hasActiveExport`, `stopExportsSync` and
`holdExportsThroughQuit` from `electron/ipc/export.ts` (§9.3). Nothing else in main changes: the
protocol handler, the `ve-media` scheme, the argv scan, the single-instance lock and the
window-control channels are all untouched — apart from the one line in `createWindow()` that resets
`quitApproved` (§1.4).

**Validation on the main side is total.** `appProjectState` and `appSaveResult` arrive as `unknown`
and are shape-checked before use; a malformed message is dropped, never thrown on. `autosaveWrite`
rejects a payload that is not an object or whose `project` is not an object, returning
`{ ok: false }` — main never writes bytes it has not shape-checked, for the same reason
`openProject` hands the raw object to the renderer rather than trusting it.

---

## 6. How to verify this, concretely

All but the last three are reachable from the harness described in the repo brief (`npm run build`,
`npx electron .`, CDP on 9222). Assert `document.visibilityState === 'visible'` in every sample —
an occluded window suspends `requestAnimationFrame` and makes a working playback path look frozen.

**`$AUTOSAVE_DIR` below means `%APPDATA%\video-editor\autosave\` when the app was started with
`npm run dev` / `npm start` / `npx electron .`, and `%APPDATA%\Video Editor\autosave\` when it was
started from a packaged build — see §2.1.** Steps 10 and 14 to 18 all report a false "no snapshot"
against a working implementation if the packaged path is used under the harness. Adding
`"productName": "Video Editor"` to `package.json` (§9.7) collapses the two into one.

**Close prompt**

1. Import a clip, drag it, confirm the titlebar bullet. Click X. → dialog. Press Escape. → window
   still open, bullet still there, `readStore().isDirty === true`.
2. Same, choose **Do not save**. → window closes. Relaunch. → **no recovery offer** (the snapshot was
   retired by the explicit discard).
3. Never-saved project, dirty, click X, choose **Save**. → the save picker appears *after* the
   question, not before. Name it. → the file exists, contains the edit, and the window closes only
   after it does. `stat` the file before the window is gone.
4. Same, but cancel the save picker. → the close is abandoned; the window is still open and dirty.
5. Make the project read-only, dirty it, X → Save. → `Save failed` notice in the titlebar, window
   still open and readable.
6. Start a 60-second export, click X while it runs. → the export dialog; Cancel keeps both. Stop and
   close → the `.part` file is gone from the output folder.
7. Dirty project, `Ctrl+O`, cancel the picker. → **no dialog at all** (the guard is after the pick).
8. Dirty project, `Ctrl+O`, choose a valid `.veproj`. → dialog; Cancel → the original project is
   still loaded and still dirty.
9. Dirty project, double-click a `.veproj` in Explorer. → the same dialog, same three outcomes.

**Autosave**

10. Dirty the project, wait 3 s, `dir "$AUTOSAVE_DIR"`. → exactly one `*.veproj.autosave`; its
    `project.clips` matches the store, and its `project.savedAt` is **not** later than the snapshot's
    own `savedAt` (§2.2).
11. Hold a clip in a drag for 10 s without releasing. → no new snapshot until the commit, then one
    2 s later.
12. Edit continuously for 60 s. → snapshots at roughly 20 s intervals, never more often.
13. `taskkill /IM electron.exe /F` while dirty. Relaunch. → the recovery strip, naming the project
    and a time within 20 s of the kill. Restore → the timeline is back and the bullet is lit.
14. Same, then Discard. → the strip goes; `dir` shows a `*.veproj.discarded` and no `*.veproj.autosave`.
15. `Ctrl+S`, then `dir`. → the snapshot is gone.
16. Kill mid-write (loop step 10 while killing repeatedly). → the directory never contains a
    zero-length or unparseable `*.veproj.autosave`; at worst a stray `*.tmp`, which the next launch
    sweeps.
17. Start an export, edit during it. → snapshots no more often than 60 s while the job runs, and back
    to 20 s within one interval of it finishing.
18. Make the autosave directory read-only, dirty the project. → first failure silent; second raises
    exactly one `Autosave failed` warning notice; a third and fourth raise nothing.
19. `npm run dev:web`. → no crash, no autosave, `Ctrl+O` behaves as it does today. Every new bridge
    method is absent and every call site feature-detects.

**The ones the earlier draft of this document did not have, each closing a specific defect**

20. **Snapshot cost on the renderer's main thread.** Build a 500-clip timeline through CDP, wrap the
    `autosaveWrite` call in `performance.now()`, dirty the project and sample ten snapshots with
    `document.visibilityState === 'visible'` asserted. → every one under **4 ms** (§2.4 measures
    ≈0.6 ms synthetically). Then press play with `pending` set and let the 20 s ceiling elapse mid
    transport. → **no snapshot is written while `isPlaying`**, and exactly one is written on the
    first tick after the transport stops.
21. **A held snapshot is never deleted.** Open `<sessionId>.veproj.autosave` with an exclusive handle
    (PowerShell: `[System.IO.File]::Open($p,'Open','Read','None')`), launch the app, quit it, release
    the handle. → the file **still exists**, no offer was made, and nothing was logged as corrupt
    (§2.7 step 4).
22. **A deferred quit is re-issued.** darwin, `npm run dev`: dirty the project, `Cmd+Q`, choose **Do
    not save**. → the window closes **and the process exits**. Repeat choosing **Save**. → same.
    Then: `Cmd+W` to close the window, `Cmd+Tab` back and reopen a window via the dock, dirty it,
    `Cmd+Q`. → the dialog appears **again** (`quitApproved` was reset in `createWindow`, §1.4).
23. **`session-end` ordering.** Manual, not CDP, and required before shipping. Log `Date.now()` from
    both `app.on('session-end')` and `win.on('close')` to a file in `userData`, dirty the project,
    and log off Windows. → record which arrived first. Whatever the answer, verify the escape hatch:
    no dialog survives on the shutdown screen and the app does not appear in "these apps are
    preventing you from shutting down".
24. **StrictMode.** `npm run dev` with a recoverable snapshot present. → the strip appears **once**,
    `dir "$AUTOSAVE_DIR"` shows **one** `*.veproj.autosave`, and snapshots arrive at the §2.4
    cadence, not double. Count the live intervals in the renderer. → exactly one.
25. **The write/retire race.** With a dirty 500-clip project, drive `Ctrl+S` from CDP ~10 ms after a
    snapshot tick fires, in a loop of 20. → after each save the directory contains **no**
    `*.veproj.autosave`, and a relaunch offers nothing (§2.6).
26. **The two guards cannot stack.** `Ctrl+O` on a dirty project, and while the confirm dialog is up,
    `Alt+F4`. → **no second dialog**; the window stays; answering the first works normally; pressing
    X afterwards raises the close dialog as usual.
27. **Close with a crashed renderer.** Dirty the project, crash the renderer
    (`chrome://crash` via CDP, or `webContents.forcefullyCrashRenderer()`), click X. → the dirty
    dialog, then **immediately** the "The editor has stopped running" dialog — not a 60 s wait.
    `Close without saving` closes the window; the next launch **still offers the snapshot**.
28. **The `.part` file really goes.** Repeat step 6 on Windows and check both the output folder and
    `%TEMP%` after the process has exited. → no `*.part`, no leftover filter script.

**Gates**: `npm run typecheck`, `npm run build`, `npm run check` all clean. `npm run check` will
confirm the two new surfaces spend no colour literal and no accent.

---

## 7. README — the change to "Known limitations"

> **This section is a pending instruction, not a description of the file.** `README.md` documents
> what ships. Applying these edits before the code exists makes the README claim two capabilities the
> app does not have — a fabricated capability documented as fact, which is the exact anti-pattern
> this document was written to remove, and which additionally breaks §0, whose opening quote is taken
> verbatim from the bullet being replaced. **The implementer applies §7 in the same commit as the
> code, never before it.** Until then the README's honest *"Nothing autosaves"* bullet stands, and
> §0's quote matches it word for word — re-check that if you touch either.

**Delete** the bullet beginning *"**Nothing autosaves.**"* in full, including its last sentence about
opening another project. **Replace** it with:

> - **Autosave is a crash net, not version history.** A snapshot of the open project is written to
>   `%APPDATA%\Video Editor\autosave\` about two seconds after you stop editing, and never less often
>   than every twenty seconds while there are unsaved changes — so a crash or a power cut costs at
>   most twenty seconds of editing. While an export is running that becomes a minute, so the snapshot
>   never stutters the encode. It never writes to your `.veproj`; only `Ctrl+S` does that. After a
>   crash the next launch offers the work back in the title bar, but only the **newest** snapshot:
>   there is no list to browse and no history to roll back through. A clean exit or a save retires it.

**Add** to "What it does", after the `.veproj` bullet:

> - Closing with unsaved changes stops and asks — save, do not save, or cancel — and so does opening
>   another project over one, whether it arrives by `Ctrl+O` or from a double-clicked `.veproj`.
>   Cancel genuinely cancels, and a save that needs a filename gets one before the window goes.

**Add** `SAFETY.md (the close prompt and autosave)` to the `docs/` line of the source tree listing.

Everything else in "Known limitations" is unaffected. The **One export at a time** bullet stands, and
gains no caveat: closing during an export asks first, which is a fix, not a limitation.

The stated bound is *"at most twenty seconds of editing, a minute while an export is running."* That
exact pair appears in §0, §1.8, §2.4 and here, and it is the only form permitted: a flat twenty
seconds is a number §2.4's `AUTOSAVE_MIN_INTERVAL_EXPORTING_MS` does not honour, during the longest
and most crash-prone window in a session.

---

## 8. File ownership for the implementer

| File | Scope of the change |
|---|---|
| `electron/main.ts` | **Close handling only.** The `projectState` mirror, the `closeApproved` `WeakSet`, `quitApproved` (+ its one-line reset in `createWindow`), `sessionEnding`, `win.on('close')`, `resolveCloseIntent`, `approveAndClose`, `requestRendererSave` + the watchdog, `app.on('before-quit')`, `app.on('session-end')`, and moving the `before-quit` registration above `registerExportIpc`. The decision mutex is **imported**, not declared here (§1.4). Nothing else — not the protocol handler, not the argv scan, not the window-control channels. |
| `electron/ipc/project.ts` | The four autosave channels, `CH.appConfirmDiscard`, `writeSnapshotAtomic` + `renameWithRetry`, the launch scan and sweep, `lastRetiredSeq` / `inFlightWrite`, `retireAutosaveSync`, `hasLiveSnapshot`, `unsavedQuestion`, the `beginDecision` / `endDecision` / `isDecisionInFlight` mutex, and adding `fh.sync()` **and** `renameWithRetry` to the existing `saveProject` write. |
| `src/lib/project.ts` | `toAutosavePayload(s, meta)` and the three `AUTOSAVE_*` timing constants. `serializeProject`, `applyProject` and `migrateProject` are unchanged **by this document** — docs/AUDIO-FEATURES.md §7.3 adds the `streamsOf` sanitiser inside `migrateProject`'s clip mapping (amendment A3). The two edits are disjoint and both apply. |
| `src/keyboard/projectActions.ts` | `startProjectSafety()` (+ its total teardown and `cancelled` flag), `confirmDiscardChanges()`, `restoreRecovery()`, `discardRecovery()`, the guard inside `openProject`, `queuedOpenPath`, the module-level `writeSeq` / `lastExplicitSaveAt`, the retire call inside `saveProject`, and `saveProject`'s new `Promise<CloseSaveOutcome>` return type. `DiscardChoice` and `CloseSaveOutcome` are **imported** from `src/types/api.ts`, never redeclared. |
| `src/state/uiSlice.ts` | **Autosave status only.** `autosaveAt`, `autosaveFailures`, `recovery`; `noteAutosaveWritten`, `noteAutosaveFailed`, `setRecoveryOffer`, `clearRecoveryOffer`; the two new selectors. No change to `PersistedUi`, `readPersistedUi` or `writePersistedUi`. |
| `src/components/shell/TitleBar.tsx` | **Dirty and autosave indicator only.** The tooltip / accessible-name table in §4, and the recovery strip in §2.8. The notice slot, the rail toggle, `AppMenu` and `WindowControls` are untouched. |

---

## 9. Cross-area requirements

Changes needed in files **outside** the list above. Two other architects are working against the same
tree in parallel; none of these is assumed, and each is stated as the exact declaration required
(PLAN §0.2).

### 9.1 `src/types/api.ts` — scaffold

Add the eight `CH` entries, the six optional `EditorAPI.project` methods, and the nine types listed
in §2.2, §2.3 and §5 verbatim — `ProjectStateReport`, `DiscardQuestion`, `DiscardChoice`,
`CloseSaveOutcome`, `CloseSaveResolution`, `AutosavePayload`, `AutosaveSnapshot`,
`AutosaveWriteResult`, `RecoveryOffer`. **Each is declared
exactly once, here.** `src/keyboard/projectActions.ts` imports `DiscardChoice` and
`CloseSaveOutcome`; it does not declare its own. All bridge methods are optional, so **no change is
needed to `src/dev/fixtures.ts`** and `npm run dev:web` keeps compiling and running.

### 9.2 `electron/preload.ts` — scaffold

Wire the eight channels into `project`. Nothing but `ipcRenderer.invoke` / `.send` / `.on`; no logic,
no `fs`. The three `on`-style methods return their own unsubscribe, matching `onOpenRequest`:

```ts
reportState: (report) => ipcRenderer.send(CH.appProjectState, report),
onSaveRequest: (cb) => {
  const h = (_e: unknown, token: string) => cb(token);
  ipcRenderer.on(CH.appSaveRequest, h);
  return () => { ipcRenderer.off(CH.appSaveRequest, h); };
},
reportSaveResult: (token, outcome) => ipcRenderer.send(CH.appSaveResult, token, outcome),
confirmDiscard: (q) => ipcRenderer.invoke(CH.appConfirmDiscard, q),
autosaveWrite: (payload) => ipcRenderer.invoke(CH.autosaveWrite, payload),
autosaveRecoverable: () => ipcRenderer.invoke(CH.autosaveRecoverable),
autosaveRetire: (throughSeq) => ipcRenderer.invoke(CH.autosaveRetire, throughSeq),
autosaveResolveOffer: (id, how) => ipcRenderer.invoke(CH.autosaveResolve, id, how),
```

### 9.3 `electron/ipc/export.ts` — export area

Three exports over the existing `jobs` map. None changes the ffmpeg invocation, the filter graph, or
anything in `docs/EXPORT.md`.

```ts
/** True while this WebContents owns a job that has not settled. Read-only. */
export function hasActiveExport(wc: WebContents): boolean;

/** Synchronously stop every live job owned by `wc` and remove what it wrote. For each job:
 *  cancelRequested = true; child.kill(); then rmSync(partPath) and rmSync(scriptPath),
 *  tolerating EPERM/EBUSY with a short bounded spin (~300 ms total, the same budget
 *  `removeFile` already uses) because Windows does not release the killed child's handle the
 *  instant kill() returns. Never throws. Called from approveAndClose BEFORE win.close(). */
export function stopExportsSync(wc: WebContents): void;

/** While true, killEverythingSync() returns early. Set by main's before-quit guard so a
 *  quit that the user then cancels does not have already destroyed a running export. */
export function holdExportsThroughQuit(hold: boolean): void;
```

`stopExportsSync` exists because `teardown`'s `void removeFile(job.partPath)` is asynchronous and
unawaited while `settle` removes the job from `jobs` in the same tick — so `killEverythingSync`, the
only genuinely synchronous cleanup, finds an empty map and the process exits with the `.part` file
and the tmpdir filter script still on disk. §1.7 has the full trace.

- **Without `hasActiveExport`**: main treats it as `() => false`; the export question is never asked
  and a running export dies on close exactly as it does today. Degraded, not broken.
- **Without `stopExportsSync`**: the removal clause must be struck from both dialog strings in §1.5
  in the same change. This one is **not** an acceptable degradation to ship silently — the close
  prompt makes "close during an export" a supported flow, so the leak becomes routine, and a dialog
  that states a fact the code does not perform is the defect this document exists to remove.
- **Without `holdExportsThroughQuit`**: cancelling a deferred *quit* (darwin / `npm run dev` only —
  unreachable on the Windows target, see §1.8) leaves the export already killed. Degraded, not
  broken, but it is a defect and should be fixed.

### 9.4 `src/App.tsx` — shell

One line, beside the existing `useShortcuts()` / `useOpenHandoff()` calls:

```tsx
useEffect(() => startProjectSafety(), []);   // from '../keyboard/projectActions'
```

It must be inside the component, not at module scope, so mounting `App` in a test or under
`dev:web` does not leave a timer running that nothing owns. `App` is rendered inside `<StrictMode>`
(`src/main.tsx`), so this effect runs **mount → unmount → mount** in development: the returned
teardown must be total, and `startProjectSafety` must be safe to call twice. §2.11 specifies exactly
what that requires; §6 step 24 verifies it.

### 9.5 `src/components/shell/shell.css` — shell

Three rules for the recovery strip, following the existing `.shell-titlebar-notice` pattern:
`.shell-titlebar-recovery`, `.shell-titlebar-recovery-text`, `.shell-titlebar-recovery-actions`.
Tokens only, per §2.8's table. No colour literal, no shadow, no animation, and **`border-top` only** —
`.shell-titlebar` already owns the bottom edge.

### 9.6 `docs/PLAN.md` §3.1 — documentation

Two list amendments, so the closed dirty contract stays true:

- add `restoreRecovery` to the **permitted `markDirty()` callers**;
- add `noteAutosaveWritten`, `noteAutosaveFailed`, `setRecoveryOffer` and `clearRecoveryOffer` to
  **explicitly NOT dirty**, beside `setNotice`.

### 9.7 `package.json` — scaffold

One line, no behaviour change:

```json
"productName": "Video Editor",
```

`app.getPath('userData')` derives from `app.getName()`, which reads `productName`. The packaged build
gets it from `electron-builder.yml`; a development run reads the source `package.json`, which has
only `"name": "video-editor"`. Without this line the autosave directory has two different names
depending on how the app was started (§2.1), the README states one of them as if it were universal,
and half of §6 looks in the wrong folder. **Degradation if the scaffold owner declines it:** §2.1 and
§6 already name both paths, so nothing is broken — the divergence just has to stay documented
forever.

### 9.8 Not required, and deliberately not asked for

- **No change to `src/components/ui/**`.** The recovery offer was specifically designed onto existing
  primitives (`Button` secondary + ghost) rather than by adding a tone or an actions slot to
  `InlineNotice` — see §2.8 for why that is the better design and not merely the cheaper one.
- **No change to `src/dev/fixtures.ts`**, because every new bridge method is optional.
- **No change to `src/lib/constants.ts`.** The three `AUTOSAVE_*` constants have exactly one consumer
  and are declared in `src/lib/project.ts`. If the scaffold owner would rather they lived in
  `constants.ts`, that is a pure move with no behavioural consequence.
- **No change to `src/state/store.ts`, the export filter graph, `docs/EXPORT.md`, or any ffmpeg
  argument.** Autosave and the close prompt do not spawn a process, do not read media, and do not
  change a single encoder flag.

---

## 10. What this design deliberately does not do

Stated so it is a decision on the record rather than an omission someone finds later.

- **No snapshot history.** One file per session, overwritten in place. Version history is a different
  feature with a different UI and a real storage-growth question; a crash net is not the place to
  smuggle it in.
- **No list of recoverable sessions.** Only the newest survivor is offered; the rest are deleted at
  launch (§2.7). A picker at launch is a startup modal in disguise.
- **No `beforeunload` handler under `dev:web`.** The browser preview's save is a stub, so there is
  nothing to protect and a browser-native "leave site?" prompt would be noise.
- **No prompt during OS shutdown.** The snapshot is the guarantee there (§1.8).
- **No autosave of view state.** Zoom, scroll, selection, panel sizes and theme stay in
  `localStorage` under `ve.ui.v1`, exactly as PLAN §2.6 has it. A snapshot restores the *project*,
  and the view state was never lost in the first place.
- **No "not now" on the recovery strip.** Two buttons, two exits. Ignoring the strip is not a third
  answer that persists: a clean exit tombstones an unanswered offer (§2.6), because a user who saw
  it, worked past it and quit cleanly has answered it. Without that, an offer nobody pressed would be
  re-presented at every launch forever, costing 32 px of the editor each time, with the only way to
  stop it being an action the user had already declined twice. The seven-day tombstone window is
  what makes that safe to decide on their behalf.
- **No "recovered" badge on the timeline** after a restore. The dirty bullet already says the only
  thing that matters — this does not match your file — and a second, subtler indicator would be a
  state with no word.
