# Release — auto-update, the version number, and the start-up splash

**Status:** normative for the three features it describes. Where this document and `docs/PLAN.md`
disagree on a name, type or channel, PLAN wins and the conflict is a bug in this file — report it.
Where it and `docs/SAFETY.md` disagree on what happens to unsaved work, **SAFETY wins**: §1 of this
document is a caller of SAFETY's guard, never a second copy of it.

Read order: `PRODUCT.md` → `DESIGN.md` → `docs/PLAN.md` → `docs/SAFETY.md` → this file.

No implementation code lives here. Every signature, number and config block below is one the
implementer types into a named file.

---

## 0. What is being added, and what it costs

Three features that share nothing at runtime and one document, because they share a single subject:
what a *version of this application* is, how it announces itself, and how it becomes the next one.

| | Adds | Ships on by default |
|---|---|---|
| **§1 Auto-update** | `electron-updater`, `electron/update.ts`, one strip in the titlebar, one menu item | **No.** There is no feed configured, so the module registers nothing and opens no socket. |
| **§2 The version number** | one field on `EditorAPI`, one menu item, one line on the splash | Yes |
| **§3 The splash** | a second BrowserWindow, a second Vite entry, a second preload | Yes, **conditionally** — §3.4 |

**One new runtime dependency, total:** `electron-updater` (^6.3.9) — which drags **fifteen
transitive packages** behind it, all of which must be inside the asar. It is a main-process
dependency and therefore must move out of `devDependencies` discipline — see §1.11, which is the only
place in this project where `electron-builder.yml`'s `files: - '!node_modules/**'` exclusion has to
be revisited, and which states the measured closure, its measured size, and the gate that keeps the
list from going stale.

**Deliberately out of scope**, stated once so nobody negotiates for it later:

- **No macOS or Linux update path.** `electron-builder.yml` targets `--win` only. `autoUpdater` on
  darwin requires a signed, notarised app and a `dmg`/`zip` feed; neither exists.
- **No beta / prerelease channel.** `allowPrerelease = false`, `allowDowngrade = false`. One channel,
  `latest`.
- **No release notes rendering.** The strip carries a version number and nothing else. Notes, if the
  feed supplies them, are reachable through `shell.openExternal` on a link — §1.6 says why that is
  the whole of it.
- **No silent background install.** `autoInstallOnAppQuit = false`. Nothing ever installs without a
  press.
- **No theme-following splash.** §3.3 states the reasoning and §3.12 states the one-line escape hatch
  if that is ever wanted.
- **No screen-reader announcement from the splash.** §3.11 states plainly what a screen-reader user
  gets, which is the same thing they get today.
- **No code signing.** §1.9 states exactly what that costs and exactly what fixes it. Signing is a
  purchase, not a code change, so it cannot be specified into existence here.

---

# §1 Auto-update

## 1.1 The shape of the decision

Four properties, in the order they constrain everything else:

1. **Silent by default.** The build that ships today has no feed. It must therefore make **no network
   request, raise no error, register no timer, and draw no pixel** on the subject of updates. Not a
   suppressed error — an unreached code path.
2. **Never on launch.** A launch is the moment the user wants to be editing. Nothing about updates
   happens in the first ten minutes of a session.
3. **Never a modal, never an interruption.** The affordance is an inline strip in the titlebar — the
   same 32 px row shape the recovery offer already uses (`SAFETY.md` §2.8,
   `.shell-titlebar-recovery`) — and it is not even *inserted* while the user's hands are on the
   timeline (§1.7).
4. **The install exits through the unsaved-changes guard, or it does not exit.** There is exactly one
   function in this application permitted to end the process for an install, and it goes through
   `resolveCloseIntent` (§1.8). `autoUpdater.quitAndInstall()` is never called from anywhere else.

## 1.2 Where the endpoint lives — one place

**`electron-builder.yml`'s `publish:` key.** That is the whole answer. At package time
electron-builder turns that block into `resources/app-update.yml` inside the installed application,
and `electron-updater` reads that file at runtime. There is no second copy, no constant in
TypeScript, no `.env`.

The file gains this block, at the top, and it ships with `publish: null`:

```yaml
# ---------------------------------------------------------------------------
# UPDATE FEED — the one place the update endpoint is configured.
#
# This key is what electron-builder turns into resources/app-update.yml, which
# is the only thing electron-updater reads at runtime. docs/RELEASE.md §1.2.
#
# `null` is not "unset": it is an EXPLICIT instruction not to publish, and it is
# load-bearing. With NO publish key at all, electron-builder infers a GitHub
# provider from the git remote (or from package.json "repository") and writes an
# app-update.yml pointing at a repository that may not exist. The app would then
# have a feed nobody configured. Removing this line is a bug; changing it is the
# release decision.
#
# To ship updates, replace `null` with ONE of the two blocks below and read
# docs/RELEASE.md §1.10 before the first publish.
#
#   publish:
#     - provider: github
#       owner: <github-user-or-org>
#       repo: video-editor
#       releaseType: release        # not 'draft'; a draft release is invisible
#                                   # to the updater and looks like "no update"
#
#   publish:
#     - provider: generic
#       url: https://updates.example.com/video-editor/   # HTTPS ONLY — §1.9
#       channel: latest
# ---------------------------------------------------------------------------
publish: null
```

**One override, for testing only**, mirroring the established `VE_FFMPEG_DIR` pattern in
`electron/ffmpeg.ts`:

```
VE_UPDATE_FEED=https://host/path/    # generic provider, HTTPS only, packaged builds only
```

It is read once, at `registerUpdate()`. It exists so the update path can be exercised against a
throwaway static server without cutting a real release. It is **ignored when `app.isPackaged` is
false** and **rejected when it does not start with `https://`** (§1.9).

## 1.3 The silence gate

```ts
/* electron/update.ts */

/**
 * Whether this build can update AT ALL. Every other function in this module is
 * unreachable when this returns false: registerUpdate() arms nothing, imports
 * nothing and registers nothing. Nothing is "disabled" — nothing exists.
 *
 * MEMOISED on first call into a module-level `let cached: boolean | null`. It is
 * asked twice — once by registerUpdate() and once by createWindow(), which needs
 * the answer to decide whether the renderer's preload gets an `update` member
 * (§1.11) — and two filesystem reads that could disagree would produce a menu
 * item with no handler behind it. One answer per process, computed once.
 */
export function updateFeedConfigured(): boolean;
```

It answers `true` only when **all four** hold:

| # | Condition | Why |
|---|---|---|
| 1 | `app.isPackaged` | A dev run has no `resources/app-update.yml` and `autoUpdater` throws on it. `npm run dev` must never see an update anything. |
| 2 | `process.env.PORTABLE_EXECUTABLE_FILE` is **unset** | `electron-builder.yml` also builds a `portable` target. A portable exe cannot be updated in place: the NSIS installer would install a *second*, separate copy and the portable one would keep reporting the old version forever. electron-builder sets that variable in portable builds and nothing else does; it is the only reliable discriminator. |
| 3 | `existsSync(path.join(process.resourcesPath, 'app-update.yml'))`, **or** a valid `VE_UPDATE_FEED` | This is the actual feed. It exists if and only if `publish:` was configured at package time. |
| 4 | the feed URL is `https://` when it is a generic provider | §1.9. Checked by reading the yml's `url` key, not by trusting it. **How it is read is specified below** — this file has no YAML parser and is not permitted one. |

Condition 3 is the one that makes the default silent, and it is a filesystem fact rather than a flag,
so it cannot be got wrong by a build that forgot to set something.

**Condition 4 is a deliberate non-parse, and that is stated rather than smuggled.** The check must
run *before* the lazy import — the whole point of the gate is that nothing loads when it fails — so
there is no YAML parser in scope, and §1.11 does not permit one. `app-update.yml` is a flat file of
four or five scalar keys written by electron-builder, never by a human, and the check is a
single-key lookup:

```ts
/* electron/update.ts — the whole of condition 4. `js-yaml` is a packaging entry
   (§1.11), NOT an import this file is permitted to make. */
const GENERIC_URL = /^\s*url:\s*(\S+)\s*$/m;

/** True when the yml declares no generic url, or declares one that is https://.
 *  A one-key regex lookup on a machine-written file, chosen over pulling a YAML
 *  parser into a gate whose entire purpose is that nothing has loaded yet. */
function feedUrlIsSafe(ymlText: string): boolean {
  const m = GENERIC_URL.exec(ymlText);
  return m === null || m[1].startsWith('https://');
}
```

`VE_UPDATE_FEED` is checked the same way, against the env value directly. A feed that fails this
check does not warn, does not log a user-visible error, and does not fall back to a different feed:
`updateFeedConfigured()` returns false and the whole feature ceases to exist, exactly as it does on a
build with no feed at all. §1.12 gate 3 measures that case.

```ts
/**
 * Called from app.whenReady(), after registerExportIpc and BEFORE createWindow().
 * Returns immediately and does nothing at all when updateFeedConfigured() is
 * false — no import of electron-updater, no ipcMain.handle, no setTimeout, no
 * listener.
 */
export function registerUpdate(ipcMain: Electron.IpcMain): void;
```

**It is `void`, it registers synchronously, and the lazy import happens beside it — not inside it.**
This shape is load-bearing and the obvious alternative is a bug:

```ts
export function registerUpdate(ipcMain: Electron.IpcMain): void {
  if (!updateFeedConfigured()) return;

  // 1. Every handler, registered NOW, synchronously. They close over a
  //    module-level `let phase: UpdatePhase = { kind: 'idle' }`, so they answer
  //    correctly whether or not the import below has landed.
  ipcMain.handle(CH.updateCurrent, () => phase);
  ipcMain.on(CH.updateCheck, () => void checkNow({ manual: true }));
  /* …download, cancel, install, dismiss… */

  // 2. The import, the settings, the listeners and the timers, fire-and-forget.
  void (async () => {
    const mod = await import('electron-updater');
    updater = mod.autoUpdater;          // module-level, read by runUpdateInstaller (§1.8)
    Cancellation = mod.CancellationToken; // §1.5's cancel mechanism
    /* …§1.4's settings, the event listeners, then arm UPDATE_FIRST_CHECK_MS… */
  })();
}
```

**Why not `async function registerUpdate`.** An `async` registrar registers
`ipcMain.handle(CH.updateCurrent, …)` a microtask later than `createWindow()`. The strip calls
`api.update.current()` on its first paint — which §1.11 says is precisely what that method is for —
and an invoke with no handler yet registered rejects with *"No handler registered for
'update:current'"*. Registering synchronously and arming asynchronously keeps the gate's "nothing
exists when the feed is absent" property **and** removes the race.

A build with no feed therefore does not even pay the module's load time or its `electron-log` probe.
This is the one place in `electron/**` where a dynamic import is used, and this section is its reason.

**Verified silence.** §1.12 gate 3 asserts it by measurement, not by reading: launch the installed
app with no feed, leave it for fifteen minutes, and assert zero outbound requests and zero
`update:*` IPC traffic.

## 1.4 Settings, exactly

Set inside §1.3's async arm, immediately after the lazy import and before any listener:

```ts
autoUpdater.autoDownload = false;          // §1.6 — the user presses Download
autoUpdater.autoInstallOnAppQuit = false;  // CRITICAL — see below
autoUpdater.allowPrerelease = false;
autoUpdater.allowDowngrade = false;
autoUpdater.forceDevUpdateConfig = false;  // never synthesise a feed in dev
autoUpdater.logger = veUpdateLogger;       // §1.11
```

**`autoInstallOnAppQuit = false` is the single most important line in this feature.** Its default is
`true`. Left at the default, electron-updater installs a downloaded update on *any* `will-quit` —
including the quit that follows the unsaved-changes dialog, including a quit the user triggered by
pressing **Cancel** on something else, and including a `session-end` shutdown. The user would be
handed a different version of the application than the one they closed, with no press and no
question, which is the exact class of thing `SAFETY.md` exists to eliminate. With it `false`, the
only path to an installer is §1.8, and §1.8 goes through the guard.

## 1.5 When it checks

Never on launch. Three triggers and nothing else:

```ts
/* electron/update.ts */
const UPDATE_FIRST_CHECK_MS = 10 * 60_000;   // 10 minutes after registerUpdate()
const UPDATE_INTERVAL_MS = 6 * 60 * 60_000;  // 6 hours
const UPDATE_CHECK_FAILURE_LIMIT = 2;        // consecutive automatic failures
```

| Trigger | Pushes | Behaviour |
|---|---|---|
| Manual — `Check for updates` in the application menu (§1.6) | `checking` → one of `current` / `available` / `failed` | Always runs. Reports its result, including "no update", because the user asked a question and silence is not an answer. Resets the failure counter. |
| First automatic — `UPDATE_FIRST_CHECK_MS` after `registerUpdate()` | **`available`, or nothing at all** | Runs once. Silent on failure, silent on "no update". |
| Periodic — every `UPDATE_INTERVAL_MS` after that | Same | Same. |

**"Silent" is a property of the transport, not of the renderer.** `UpdatePhase` carries no
manual/automatic discriminator and is not given one: main simply **does not push `checking`,
`current` or `failed` for an automatic check.** An automatic check that finds nothing, or fails,
leaves `phase` at whatever it already was — `idle`, in the common case — so no `update:phase` message
is sent, no subscriber runs, and the interface stays byte-identical. The only phase an automatic
check can push is `available`, which is the one thing the user asked to be told about by installing a
build with a feed.

This is why the renderer needs no rule to enforce. §1.6's *"`checking` is only ever rendered for a
manual check"* and *"`current` is only ever reached from an explicit press"* are consequences of the
transport, not requests to a consumer that has no way to comply. A model that carried both triggers
in the same shape and asked the renderer to tell them apart would be a distinction the consumer
silently drops the first time someone adds a state.

**The timer stops after `UPDATE_CHECK_FAILURE_LIMIT` consecutive automatic failures**, for the rest
of the session. A machine that is offline, behind a proxy, or pointed at a dead host does not get a
network attempt every six hours forever. The threshold is 2 rather than 1 for the same reason
`SAFETY.md` §2.9 escalates at 2: one failure is a blip, two is a condition. A manual check re-arms
the timer, because a manual check is the user saying the condition may have changed.

Nothing is scheduled while a check or a download is already in flight; `checkForUpdates()` is not
re-entrant and electron-updater's own guard returns the in-flight promise, which is easy to mistake
for a second result.

### The download, and the cancel that actually cancels

`Cancel` on the `downloading` row (§1.6) is a real control, so its mechanism is specified rather than
assumed. **electron-updater has no post-hoc cancel.** There is no `autoUpdater.cancel()`; the only
supported form is a `CancellationToken` constructed *before* the download and handed to it. A button
wired to anything else either does nothing — a dead control, which `PRODUCT.md` rules out — or lies,
by reporting a cancellation while the HTTP transfer keeps running.

`CancellationToken` is exported from `electron-updater`, so it comes from the **same lazy import**
§1.3 already makes and is held in module scope beside `updater`. No new import, and §1.11's import
list is unchanged.

```ts
/* electron/update.ts — module scope, both set by §1.3's async arm */
let updater: import('electron-updater').AppUpdater | null = null;
let Cancellation: typeof import('electron-updater').CancellationToken | null = null;
/** Non-null for exactly the length of one download. */
let inFlight: InstanceType<NonNullable<typeof Cancellation>> | null = null;

function download(): void {
  if (!updater || !Cancellation || inFlight) return;   // one download at a time
  inFlight = new Cancellation();
  void updater.downloadUpdate(inFlight).catch(() => { /* phase already pushed */ });
}

function cancelDownload(): void {
  inFlight?.cancel();
}
```

`inFlight` is cleared on **every** terminal transition — `update-downloaded`, `error`, and the
cancellation's own rejection — and nowhere else. A token that outlives its download is a `Cancel`
press that silently kills the *next* download.

**Where a cancelled download lands, and what this app does about it.** `cancelDownload()` pushes
**`{ kind: 'available' }`** — not `idle`. Three reasons, and they are the same reason: the update is
still available, so saying otherwise is false; `Download` must remain pressable, and `idle` removes
the row that carries it; and `available` → `downloading` → `available` is the *same row height*, so
it commits immediately under §1.7 instead of waiting for an idle instant to remove a row the user is
looking at. `Not now` is how the strip goes away, and it is already on the `available` row.

The partial file sits in `%LOCALAPPDATA%\Video Editor-updater\pending\` (note the space — §1.8), and
**nothing in this application touches it.** electron-updater owns that directory: it overwrites the
temp file on the next download of the same version rather than resuming, and reaps it on its own
cache housekeeping. Deleting files under a path the updater owns is the standard way to produce an
updater that can no longer install. §1.12 gate 4 measures what is actually left there after a cancel
and records the answer.

## 1.6 The affordance

**Two surfaces, both inline, neither modal.**

### The menu item

`src/components/shell/AppMenu.tsx` gains one item, in the help group, above `Keyboard shortcuts`:

```
Check for updates
```

It is rendered **only when `getEditorAPI().update` is present.** A build with no feed has no `update`
member, so the item does not exist. An item that always answers "you're up to date" on a build that
can never update is a lie, and it is the kind of lie that makes a user stop believing the rest of the
interface.

**How preload decides is §1.11, and it is not the `media.reveal` precedent.** `media.reveal` and
`export` are absent only under `dev:web`, where there is no preload at all — that is a whole-bridge
condition, not a per-build one, and it does not cover this case. `update` is a member that is present
in one packaged build and absent in another, decided by a main-process fact
(`updateFeedConfigured()`, which reads `app.isPackaged` and `process.resourcesPath`) that preload
cannot compute and must not round-trip for. §1.11 specifies the seam: main carries the answer in the
same `additionalArguments` payload §2.2 already adds, and preload reads it off `process.argv`.

Selecting it calls `api.update.check()` and closes the menu. The result lands in the strip.

### The strip

A second instance of the recovery strip's shape, in `src/components/shell/TitleBar.tsx`, **below**
the recovery strip and **above** the notice strip. New component:
`src/components/shell/UpdateStrip.tsx`, styled in `shell.css` beside `.shell-titlebar-recovery`.

Identical geometry and tokens to the recovery strip, for a reason that is not laziness: these two
rows are the same *kind* of thing — a fact about the session that the app is telling you, with two
actions, that you may ignore. Giving them two different appearances would encode a difference that
does not exist.

```
.shell-titlebar-update
  height: 32px
  background: var(--surface-panel)
  border-top: 1px solid var(--border-structural)
  padding: 0 var(--space-lg)
  gap: var(--space-md)

.shell-titlebar-update-pct        /* the download percentage, and only that */
  display: inline-block
  min-width: 3ch
  text-align: right
```

`min-width: 3ch` is not cosmetic. Tabular figures fix the width of each *digit*; they do not fix the
number of digits, so `9 %` → `10 %` → `100 %` reflows the row twice and drags the `%` sign and every
word left of it with it. Reserving three characters at the widest digit width makes the field
constant for the whole download. This is the field's own rule, stated here because §1.11's `percent`
contract is about the value and this is about the box it lands in.

No accent (a fourth family is not on `PLAN.md` §7.4's closed list). No status colour — an available
update is not an error, and a failed check is reported through the existing notice channel, not by
recolouring this row. No shadow (in flow). No animation on insert or removal (§1.7 explains why the
insert is the risk, and the answer is *when*, not *how fast*).

Five states. Icon and text first, colour never (`DESIGN.md`, The Icon Tax Rule):

| Phase | Icon (lucide, 14px, 1.75) | Text | Actions |
|---|---|---|---|
| `checking` | `RefreshCw` | Checking for updates. | — |
| `available` | `ArrowDownToLine` | Version **0.2.0** is available. | `Download` (secondary) · `Not now` (ghost) |
| `downloading` | `ArrowDownToLine` | Downloading version **0.2.0** — **62 %** | `Cancel` (ghost) — the `CancellationToken` in §1.5, which returns the row to `available` |
| `ready` | `RotateCcw` | Version **0.2.0** is ready to install. | `Restart and install` (secondary) · `Later` (ghost) |
| `failed` (manual only) | — | *not shown in the strip* — see below | — |

Bold spans above are `<span class="type-numeric">`: the version number and the percentage both change
while the interface is live, which is exactly what `DESIGN.md`'s Tabular Rule covers. The rest of the
sentence is `type-body` in `--text-ink`, matching `.shell-titlebar-recovery-text`.

**`checking` is only ever rendered for a manual check** — and the renderer does nothing to make that
true. §1.5 puts the rule in the transport: main pushes no `checking`, no `current` and no `failed`
for an automatic check, so those three phases can only have come from a press. An automatic check
that finds nothing leaves the interface byte-identical to how it was, because nothing was sent;
flashing a row in and out while the user is trimming is the interruption this whole section exists to
prevent.

**Failures do not use the strip.** They use the existing notice channel
(`ui.notice`, `InlineNotice`, one of the three sanctioned host sites in `PLAN.md` §5), with
`tone: 'warning'` — not `danger`, because nothing was lost and nothing is broken. Titles and messages
are a closed table:

| Cause | title | message |
|---|---|---|
| manual check, network unreachable | `Check failed` | `The update server could not be reached` |
| manual check, HTTP 4xx/5xx | `Check failed` | `The update server answered with an error` |
| manual check, malformed feed | `Check failed` | `The update information could not be read` |
| manual check, nothing newer | `Up to date` | `Version 0.1.0 is the newest release` — **`tone: 'warning'` is wrong here.** See below. |
| download failed | `Download failed` | `The update could not be downloaded` |
| download hash mismatch | `Download failed` | `The downloaded file did not match its checksum` |

**The "up to date" answer needs a channel the app does not have, and this is the honest resolution.**
`Notice.tone` is `'danger' | 'warning'` — `success` was cut from the palette deliberately
(`DESIGN.md` §2 Status). Rendering "you are up to date" as a warning is wrong; adding a third tone to
satisfy one string is worse. So: **a manual check that finds nothing renders the strip in a sixth
state, `current`**, with a `Check` icon and the text *Version 0.1.0 is the newest release.*, one
action (`Dismiss`, ghost), and an eight-second self-dismiss. It is the one strip state that is
transient, it is only ever reached from an explicit press (§1.5), and it spends no colour at all.

**The self-dismiss goes through §1.7's commit gate, and this is not optional.** A bare
`setTimeout(() => setPhase('idle'), 8000)` fires eight seconds after a press, by which time the user
is back on the timeline — and removing the strip is the *same 32 px layout shift* as inserting it,
in the other direction. §1.7 calls that a data-destroying interruption and it means it. So the timer
sets the **intended** phase to `idle`; the promotion to the DOM waits for `safeToCommit()` exactly as
an insert does, and if the user's pointer is down at eight seconds the row simply stays until the
next idle instant. The `setTimeout` is cleared on unmount and on any phase change. `Dismiss` takes
the same path — it is the same removal, and a press is not a licence to move the timeline either.

**Release notes are one link and no more.** If the feed supplies `releaseNotes`, the `available` and
`ready` rows render the version number as a link that calls `shell.openExternal` through the existing
`setWindowOpenHandler` path in `main.ts`. Rendering markdown release notes inside a 32 px strip is
not possible, and expanding the strip to fit them turns it into the modal this design refuses.
`notesUrl` is `null` when the feed supplies nothing, and then the version is plain text.

## 1.7 It must never interrupt an edit

Three separate hazards. Only the first is obvious.

**Hazard 1 — the layout shift.** The strip is 32 px tall and it is *above* the editor body. Inserting
it moves the timeline, the preview and every clip 32 px down. If that happens mid-drag, the clip the
user is dragging jumps out from under the pointer, and on a trim the edge they were pulling lands
somewhere they did not choose. This is a data-destroying interruption, not a cosmetic one.

The rule: **the strip's presence changes only at an idle instant.** `UpdateStrip` holds the phase it
has been told about (the *intended* phase) and the phase it has *committed to the DOM*, and it
promotes the former to the latter only when all three hold:

```ts
/* src/components/shell/UpdateStrip.tsx */
/**
 * True when adding OR REMOVING a 32px row cannot move anything under the user's
 * hands. It governs both directions — a removal is the same shift as an insert,
 * and the auto-dismiss of `current` (§1.6) is a removal on a timer, which is the
 * most dangerous of the three because nobody pressed anything.
 */
function safeToCommit(): boolean;
```

1. **No pointer is down.** A document-level `pointerdown` / `pointerup` / `pointercancel` latch,
   owned by this component. Deliberately *not* a store field: the timeline's interaction state lives
   in `useTimelineInteraction`, a hook with local state, and reaching into it would be a new
   cross-slice dependency for a boolean this component can observe directly.
2. **`ui.exportDialogOpen` is false.** See hazard 3.
3. **`ui.shortcutOverlayOpen` is false.** A dialog is open; the row would insert behind a scrim.

When any is false the promotion is deferred, and it is retried on the transition that makes them all
true. **The strip never removes itself unbidden either**, for the same reason — a removal is the same
32 px shift in the other direction. So the rule is about *height*, not about direction:

| Change | Commit |
|---|---|
| `checking` → `available` → `downloading` → `ready`, and `downloading` → `available` on a cancel — one 32 px row to a different 32 px row | **immediately.** Nothing moves; only the row's own contents change. |
| `idle` → any other phase — an insert | **waits for `safeToCommit()`.** |
| any phase → `idle` — a removal, whether from `Not now`, `Later`, `Dismiss`, or §1.6's eight-second timer | **waits for `safeToCommit()`.** |

That third row is the one an implementation forgets, because a removal feels like tidying up rather
than like an edit to the layout. It is an edit to the layout.

**Hazard 2 — the moment a download completes.** `download-progress` fires many times a second.
The renderer must not re-render the whole titlebar at that rate. The strip subscribes to
`api.update.onPhase` directly and holds the percentage in **component-local state**, never in the
zustand store: a store write at 20 Hz would run every store subscriber in the application, including
`useUiPersistence`'s comparison, on every progress tick. `PLAN.md` §1.3 rule 1 is the general form of
this and it applies here unchanged. Main throttles `download-progress` to **one push every 500 ms**
plus a final push at 100 %, so the numeral in `.type-numeric` ticks at a readable rate rather than a
flickering one.

**Hazard 3 — an export is running.** An installer that overwrites the application directory while an
`ffmpeg` child of that application is writing a `.part` file produces a corrupt output and an
orphaned process.

`electron/ipc/export.ts` does not export `hasActiveExport` today —
`electron/main.ts` says so in its own header, and `SAFETY.md` §1.7 states the degradation. **This
feature inherits that degradation exactly and does not paper over it:**

- `ui.exportDialogOpen` is used as the guard, because it is the one fact the renderer genuinely has.
  It is a good proxy — the dialog is what starts an export and it stays open through the encode — and
  it is stated as a proxy rather than as the thing itself.
- It leaks in exactly one case: a dialog closed while its job is still running. If that is reachable,
  the install path kills the export the same way a window close does today. Status quo, not a
  regression.
- **When `hasActiveExport` / `stopExportsSync` land (`SAFETY.md` §9.3), both paths are fixed by one
  change and nothing in this document moves**, because §1.8 routes through `resolveCloseIntent`,
  which is where those two functions are already specified to be called.

## 1.8 `quitAndInstall` routes through the guard — the mechanism

This is the requirement that decides the shape of the whole feature, so it is specified as a
sequence rather than as a call.

**The wrong version, and why it is wrong.** The obvious implementation is
`autoUpdater.quitAndInstall()` and a trust that `main.ts`'s `before-quit` guard catches it. It does
not work, and it fails destructively. On win32, `NsisUpdater.quitAndInstall` **spawns the installer
first** and then calls `app.quit()`. If our `before-quit` handler calls `event.preventDefault()` to
raise the unsaved-changes dialog, the installer is already running: it will find the application's
files locked, or it will replace them underneath a live process, while the user is being asked
whether to save. Cancel does not un-spawn an installer.

**Therefore: ask first, install second. Always.**

The guard's existing shape supports this with a **new optional field**, and the four edits are
enumerated below rather than waved at. It is *not* true that `resolveCloseIntent` is untouched: its
**body** does not change, but its parameter type must, or `{ ...entry, retireSnapshot }` stops
satisfying `CloseApproval` and the file does not compile.

**Edit 1 — `CloseApproval` gains an optional field.** Optional, not required. A required field would
force all three existing call sites of the two functions — `before-quit`'s
`resolveCloseIntent(win, { reissueQuit: true })`, `win.on('close')`'s
`resolveCloseIntent(win, { reissueQuit: false })`, and `handleSessionEnd`'s direct
`approveAndClose(win, { reissueQuit: false, retireSnapshot: false })` — to pass `installUpdate: false`
explicitly. Three edits bought for nothing, on the three most safety-critical lines in the file.

```ts
/* electron/main.ts */
interface CloseApproval {
  reissueQuit: boolean;
  retireSnapshot: boolean;
  /** Hand off to the update installer after the window has gone. Set only from §1.8. */
  installUpdate?: boolean;          // ← new, OPTIONAL
}
```

**Edit 2 — `resolveCloseIntent`'s parameter type widens by the same optional member. Its body does
not change.**

```ts
async function resolveCloseIntent(
  win: BrowserWindow,
  entry: { reissueQuit: boolean; installUpdate?: boolean },   // ← was { reissueQuit: boolean }
): Promise<void> {
```

It already threads `entry` through every branch via `approveAndClose(win, { ...entry, retireSnapshot })`,
so the new field flows to every outcome — save, discard, cancel, watchdog-abandon — with no further
change. Because the member is optional, both existing calls compile unchanged and mean exactly what
they meant before: no install.

**Edit 3 — `approveAndClose` becomes idempotent and shutdown-aware, and only then gains the install
line.** The order matters: the new line is the first side effect in this function that is not
`isDestroyed()`-guarded, so the two guards are a precondition for adding it, not a refinement of it.

```ts
function approveAndClose(win: BrowserWindow, a: CloseApproval): void {
  if (closeApproved.has(win)) return;   // ← new. Second entry for the same window is a no-op.
  closeApproved.add(win);
  quitApproved = true;
  try {
    if (a.retireSnapshot) retireAutosaveSync();
  } catch { /* …unchanged… */ }
  if (!win.isDestroyed()) win.close();
  if (a.reissueQuit) app.quit();
  if (a.installUpdate && !sessionEnding) runUpdateInstaller();   // ← new, last, after the window is gone
}
```

**Why `closeApproved.has(win)` first.** `approveAndClose` can be entered **twice for the same
window**, and main.ts's own comment says the existing code survives it only because "every remaining
branch is `isDestroyed()`-guarded". The path is `handleSessionEnd`: WM_ENDSESSION arrives while a
decision is in flight, `handleSessionEnd` calls `approveAndClose` directly, and the still-pending
`resolveCloseIntent` later resumes and calls it again through `go()`. Making the function idempotent
converts a property that happens to hold into one that is enforced, and it fixes a second-order bug
that exists today: on that path the resumed `go(true)` would call `retireAutosaveSync()` and delete
the snapshot that `handleSessionEnd` deliberately kept. First call wins; the snapshot survives the
shutdown, which is what `SAFETY.md` promises.

**Why `!sessionEnding`.** The deterministic version of the race is not the dialog resuming — it is
the watchdog. Press `Restart and install` on a dirty project, and while the unsaved-changes dialog is
open the OS begins logging off: `handleSessionEnd` destroys the window, `requestRendererSave`'s
pending promise settles `'abandon'` at `CLOSE_SAVE_WATCHDOG_MS`, `go(false)` runs — and without this
guard the NSIS installer spawns into a session that is logging off. §1.8's own table says *"a shutdown
is not consent to install"*; this clause is what makes that sentence true rather than aspirational.

**`handleSessionEnd` is not edited, and that is a claim, not an omission.** Its call is
`approveAndClose(win, { reissueQuit: false, retireSnapshot: false })`; `installUpdate` is optional and
therefore absent and falsy, so it installs nothing without a single character changing. The two new
lines in `approveAndClose` are what protect it.

**Edit 4 — the entry point**, which is the only sanctioned way to leave this application for an
install:

```ts
/* electron/main.ts — exported for electron/update.ts and for nothing else. */
export function requestInstallAndRestart(): void {
  if (sessionEnding) return;                                   // same rule as approveAndClose
  const win = mainWindow;
  if (!win || win.isDestroyed()) return runUpdateInstaller();  // nothing to ask
  if (isDecisionInFlight()) return;                            // a dialog owns the screen
  void resolveCloseIntent(win, { reissueQuit: false, installUpdate: true });
}
```

The `sessionEnding` line is first, not last: it is the one branch here that reaches
`runUpdateInstaller()` without passing through `approveAndClose`, so it needs its own copy of the
rule. Two guards for one property is a smell; two guards for one property on *two different paths to
the same syscall* is the minimum.

```ts
/* electron/update.ts */
/** The ONLY call to autoUpdater.quitAndInstall in this application.
 *  isSilent=false: the user sees the same installer they installed with.
 *  isForceRunAfter=true: the app comes back up on the new version. */
function runUpdateInstaller(): void;   // autoUpdater.quitAndInstall(false, true)
```

`runUpdateInstaller` lives in `update.ts` and is imported by `main.ts` — the same direction
`main.ts` already imports `retireAutosaveSync` from `ipc/project.ts`. It is a no-op when
`updateFeedConfigured()` is false **or when the module-level `updater` is still null** (§1.3's async
arm has not landed, which is unreachable from `ready` but is the honest guard), so an
`installUpdate: true` that somehow reached a feedless build closes the window and does nothing else.

**Every outcome, enumerated:**

| Situation | What happens |
|---|---|
| Project clean | No dialog. Window closes, snapshot retired, installer runs. |
| Project dirty | The existing three-way dialog, with `'close'` wording. **Save** → the renderer saves (including raising the save picker on a never-saved project), then close + install. **Do not save** → close + install, snapshot retired. **Cancel** → **returns; nothing is installed, the window stays, the strip stays in `ready`.** |
| Save picker cancelled | `'cancelled'` → the close aborts → **no install.** They declined to name the file; installing anyway would destroy exactly the work they declined to discard. |
| Save failed (disk full, read-only) | `'failed'` → the close aborts → **no install.** The `InlineNotice` says why, and it is readable because the window is still there. |
| Renderer crashed or wedged | The §1.6-of-SAFETY watchdog dialog. `Close without saving` → `'abandon'` → close + install, **snapshot kept**. `Cancel` / `Keep waiting` → no install. |
| Export running | §1.7 hazard 3. Today: the strip is not inserted while the export dialog is open, so the press is not reachable in the common case. When `stopExportsSync` lands, the export is stopped by `approveAndClose` before `win.close()`, exactly as on the close path. |
| OS shutdown mid-`ready`, no dialog open | `session-end` sets `sessionEnding`, the window is released, **nothing is installed**. A shutdown is not consent to install. |
| **OS shutdown while the unsaved-changes dialog raised by `Restart and install` is open** | `handleSessionEnd` calls `approveAndClose` directly; `sessionEnding` is already true, so the install line does not run. **Nothing is installed.** |
| **…and then the abandoned decision resumes** | `requestRendererSave` settles `'abandon'` at `CLOSE_SAVE_WATCHDOG_MS` and `go(false)` re-enters `approveAndClose`. The `closeApproved.has(win)` guard returns immediately: **no second close, no `retireAutosaveSync`, no installer.** The snapshot the shutdown path kept stays kept. |
| Two presses of `Restart and install` | `isDecisionInFlight()` swallows the second. The dialog is window-modal anyway. |

The two bold rows are the reason `approveAndClose` is idempotent and shutdown-aware **before** it
grows the install line, and §1.12 gate 5 step 8 measures them rather than trusting the reading.

**The reverse direction is also closed.** With `autoInstallOnAppQuit = false`, an ordinary window
close on a build that has a downloaded update installs nothing. The download sits in
`%LOCALAPPDATA%\Video Editor-updater\pending\` — electron-updater derives that directory from
`app.getName()`, which is the `productName` **`Video Editor`**, so the real path contains a space and
must be quoted in any shell command written against it — and is offered again on the next launch by
the first automatic check, which finds it already downloaded and reports `ready` without
re-downloading.

## 1.9 The installer is unsigned — what that actually means

Stated plainly, because a user reading a SmartScreen warning deserves to know whether it is expected.

**1. SmartScreen will warn, on every version, forever.** Windows Defender SmartScreen shows *"Windows
protected your PC — Microsoft Defender SmartScreen prevented an unrecognised app from starting"* and
requires **More info → Run anyway**. Reputation in SmartScreen accrues to a *publisher certificate*,
not to a filename or a URL. With no certificate there is no publisher, so no reputation ever
accumulates: version 0.9.0 is warned about exactly as loudly as 0.1.0 was. This is already true of
the installer today (`README.md` says so); auto-update does not make it worse, but it makes it
*recurrent*, because the user now meets it on every update rather than once.

**2. The only integrity check on an update is the sha512 in `latest.yml`.** electron-updater computes
the SHA-512 of the file it downloaded and compares it to the `sha512` field the feed published. That
is a **transport integrity** check: it proves the bytes were not corrupted or truncated between the
server and the disk. It proves **nothing about authenticity**, because whoever can serve `latest.yml`
can serve a hash that matches whatever executable they also serve. The security of this update
channel therefore reduces *entirely* to the security of the host and its TLS:

- **GitHub Releases** — TLS to `github.com` / `objects.githubusercontent.com`, and the account's own
  security. Reasonable, and the recommended host for that reason.
- **A generic HTTP server** — **must be HTTPS.** Over plain `http://` any party on the network path
  can replace both `latest.yml` and the `.exe` and the sha512 will match perfectly, because the
  attacker wrote both. §1.3 condition 4 makes this a hard refusal rather than a warning: a feed URL
  that does not start with `https://` fails `updateFeedConfigured()`, and the app stays silent.

**3. electron-updater's signature verification is off, and says so.** On win32 electron-updater
normally runs `Get-AuthenticodeSignature` on the downloaded installer and compares the subject to
`publisherName`. With an unsigned build it logs *"skipped signature validation due to unsigned
build"* and installs anyway. That log line is expected, not a bug, and it is the second half of point
2: there is no signature to check.

**4. What fixes it properly, and it is a purchase, not a patch.** In order:

1. Obtain a code-signing certificate. An **OV** certificate is cheaper and accrues SmartScreen
   reputation over time and downloads; an **EV** certificate (hardware token or cloud HSM) carries
   SmartScreen reputation immediately. Azure Trusted Signing is the current low-friction option and
   is what `electron-builder` documents first.
2. Add to `electron-builder.yml`:

   ```yaml
   win:
     signtoolOptions:
       certificateSubjectName: '<the certificate subject>'
       # or certificateFile / certificatePassword, or an Azure Trusted Signing block
     publisherName: '<exactly the certificate subject>'
   ```

3. Nothing else changes. `publisherName` is what electron-updater compares the downloaded
   installer's Authenticode subject against, which turns point 2's integrity check into a real
   authenticity check and makes a compromised host insufficient to ship a payload.
4. Re-verify: a signed build must still pass every gate in §1.12, and the first signed release must
   be installed by hand over an unsigned one to confirm the upgrade path.

**Until then, both facts belong in `README.md`** — §1.13 specifies the edit. A user who is going to
be asked to click *Run anyway* on every update should read that in the README before the first
update, not discover it from Windows.

## 1.10 The publish workflow, end to end

Nothing below is automated. There is no CI in this repository, and adding one is not in scope.

### Once, before the first release

1. **Choose a host** and put it in `electron-builder.yml`'s `publish:` block (§1.2). Replace
   `publish: null` — do not delete the key.
2. **GitHub only:** create the repository, and export a token with `repo` scope as `GH_TOKEN` in the
   shell that will run the publish. electron-builder reads `GH_TOKEN` and nothing else.
3. **Generic only:** confirm the URL is `https://`, that it serves `latest.yml` with
   `Content-Type: text/yaml` or `application/octet-stream` (either is fine; `text/html` is not), and
   that it does **not** redirect from `https://` to `http://` anywhere in the chain.
4. **Decide the artifact name.** This is the one packaging detail that bites, and it bites only on a
   generic host:

   `electron-builder.yml` currently sets `artifactName: ${productName} ${version} Setup.${ext}`,
   which produces **`Video Editor 0.1.0 Setup.exe`** — two spaces. GitHub rewrites spaces to `.` in
   release asset names and electron-updater's GitHub provider accounts for that, so GitHub is fine.
   A generic static host is not reliably fine: the URL in `latest.yml` is percent-encoded and some
   servers (and some CDNs) 404 on `%20` in a path segment. **If the host is generic, change it:**

   ```yaml
   nsis:
     artifactName: VideoEditor-${version}-Setup.${ext}
   ```

   The user-visible cost is that the downloaded file is named `VideoEditor-0.2.0-Setup.exe` instead
   of `Video Editor 0.2.0 Setup.exe`. That is the whole cost. Change it **before** the first
   release, not between two of them — `latest.yml` names a file, and renaming the scheme mid-stream
   makes the previous version unable to find the next one.

### Every release

```
1.  git status                       # clean tree, or the build embeds an unknown state
2.  npm run typecheck
3.  npm run build
4.  npm run check                    # includes scripts/check-release.mjs — §1.12
5.  npm version minor                # or patch/major. Writes package.json, commits, tags v0.2.0
6.  npm run dist                     # build + icon + stage:ffmpeg + electron-builder --win
7.  ls dist-release/                 # see the table below
8.  <publish — see below>
9.  verify — §1.12 gate 5, on a real machine, over a real previous install
```

Step 5 before step 6 is not optional: `app.getVersion()`, the splash footer, the menu item and
`latest.yml` all read `package.json` at package time, so a bump after the build ships the old number
under a new tag.

**What `dist-release/` must contain after step 6**, for the update to work:

| File | Required | Why |
|---|---|---|
| `Video Editor 0.2.0 Setup.exe` | yes | the update payload |
| `Video Editor 0.2.0 Setup.exe.blockmap` | **yes** | differential download. Without it every update is a full ~300 MB download because ffmpeg is bundled. With it, an update that changes only the app bundle transfers a few MB. |
| `latest.yml` | **yes** | the feed itself: version, path, sha512, releaseDate. This is the file electron-updater actually reads. |
| `Video Editor 0.2.0 Portable.exe` | optional | **must not be published.** It is not an update target (§1.3 condition 2). Publish it as a separate download if at all. |

**Publishing:**

- **GitHub** — `npm run dist -- --publish always` (electron-builder uploads all three files to a
  release tagged `v0.2.0` and, with `releaseType: release`, publishes it). A **draft** release is
  invisible to electron-updater and presents to users as "no update available", which is the single
  most common way this goes wrong.
- **Generic** — upload `latest.yml`, the `.exe` and the `.blockmap` to the configured URL.
  **Upload `latest.yml` last.** It is the pointer; publishing it before the payload gives every
  running client a 404 for the length of the upload, and a 404 is the one failure that looks like a
  broken app rather than a slow one.

### Rolling back

There is no rollback. `allowDowngrade = false`, so republishing an older `latest.yml` does nothing
for clients already on the newer version. The remedy for a bad release is a *newer* release: bump the
patch, fix, publish. Say so in the README rather than discovering it at the worst moment.

**The same class of one-way door sits at the other end of the sequence.** Every build made with
`publish: null` — including the 0.1.0 installed at `E:/Video Editor` today — has no
`resources/app-update.yml`, so §1.3 condition 3 is false and it can never receive anything. Turning
the feed on does not reach backwards. **The first feed-carrying version is a manual install over the
old one**, and only the installs that follow it update themselves. Plan the first release knowing
that its only distribution channel is the one that exists today: a download and a double-click.

## 1.11 Files, contracts and the packaging consequence

### New channels

```ts
/* src/types/api.ts — added to CH */
  updateCurrent:  'update:current',   // renderer -> main, invoke
  updatePhase:    'update:phase',     // main -> renderer, send
  updateCheck:    'update:check',     // renderer -> main, send
  updateDownload: 'update:download',  // renderer -> main, send
  updateCancel:   'update:cancel',    // renderer -> main, send
  updateInstall:  'update:install',   // renderer -> main, send
  updateDismiss:  'update:dismiss',   // renderer -> main, send
```

### The contract

```ts
/* src/types/api.ts */

/**
 * One state machine, pushed whole on every transition. A discriminated union
 * rather than a phase plus optional fields, for the same reason ExportRequest's
 * codec is one widened union: the alternative admits illegal combinations that
 * every consumer then has to reject.
 *
 * NO manual/automatic discriminator, DELIBERATELY. `checking`, `current` and
 * `failed` are pushed ONLY for a check the user started; an automatic check that
 * finds nothing or fails pushes nothing at all and leaves the phase where it was
 * (RELEASE.md §1.5). The distinction lives in the transport rather than in the
 * type, so there is no field a consumer can forget to branch on. The only phase
 * an automatic check can push is `available`.
 */
export type UpdatePhase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current'; version: string }
  | { kind: 'available'; version: string; notesUrl: string | null }
  | { kind: 'downloading'; version: string; percent: number }   // 0..100, integer
  | { kind: 'ready'; version: string; notesUrl: string | null }
  | { kind: 'failed'; at: 'check' | 'download'; message: string; retryable: boolean };

export interface UpdateBridge {
  /** Pushed on every transition. Returns its own unsubscribe. */
  onPhase(cb: (p: UpdatePhase) => void): () => void;
  /** The phase right now, so the strip renders correctly on its first paint
   *  rather than after the next transition. */
  current(): Promise<UpdatePhase>;
  /** Manual check. Never throws; failures arrive as a 'failed' phase. */
  check(): void;
  download(): void;
  /** Cancels the in-flight download through the CancellationToken main is
   *  holding (§1.5) — there is no other way to stop electron-updater. Returns
   *  the phase to 'available', not 'idle': the update is still available, the
   *  Download button must stay pressable, and the row keeps its height. */
  cancelDownload(): void;
  /** Routes through electron/main.ts's requestInstallAndRestart — §1.8. */
  installAndRestart(): void;
  /** 'Not now' / 'Later' / 'Dismiss'. Returns the phase to 'idle' for THIS
   *  SESSION only; a downloaded update is not deleted and is offered again on
   *  the next launch. */
  dismiss(): void;
}

export interface EditorAPI {
  /* … */
  /** PRESENT only when a feed is configured (§1.3). Absent under dev:web and in
   *  every build that ships without a publish target — which is how it ships
   *  today. Every call site feature-detects. How preload decides is below. */
  update?: UpdateBridge;
}
```

`percent` is an **integer 0..100**, rounded in main, so the renderer never renders `61.83 %`. It says
nothing about the field's width: tabular figures fix the width per *digit*, not the digit *count*, so
`9 %` → `10 %` → `100 %` would still reflow the row twice. §1.6 reserves the field at `3ch`; that,
and not this, is what keeps the row still.

`message` on `failed` is one sentence, sentence case, no trailing period, safe to render verbatim —
the same contract every other error string in `api.ts` carries. Main never puts a URL, a path, an
errno or a stack in it.

### How `update` is conditionally exposed

`electron/preload.ts` builds one object literal and exposes it unconditionally. There is no seam
today and two of the three obvious ways to make one are wrong:

- **Duplicate the gate inside preload.** It would need `node:fs` and `process.resourcesPath` in a
  file whose header says *"No logic, no fs, no child_process"*, and it would make
  `updateFeedConfigured()` two implementations that can disagree — contradicting §1.3's claim that
  every other function in that module is unreachable behind one answer.
- **An IPC round trip during preload.** §2.2 rejects exactly this, for exactly this class of value:
  a constant known in main at window creation, fetched by blocking or by arriving late.
- **Carry it in `additionalArguments`, beside the build payload.** ← chosen. Same transport, same
  tick, no new mechanism, and §2.2 has already established that this preload reads `process.argv`.

```ts
/* electron/main.ts — beside BUILD_ARG (§2.2) */
const UPDATE_ARG = '--ve-update=1';

/* …in createWindow's webPreferences. updateFeedConfigured() is memoised (§1.3),
   so this and registerUpdate() cannot disagree. The splash window does NOT get
   this switch: it has no EditorAPI and nothing to update. */
additionalArguments: [
  `${BUILD_ARG}${encodeURIComponent(JSON.stringify(appBuild()))}`,
  ...(updateFeedConfigured() ? [UPDATE_ARG] : []),
],
```

```ts
/* electron/preload.ts */
const UPDATE_ARG = '--ve-update=1';

const api: EditorAPI = { /* …every unconditional member, unchanged… */ };

// The one conditional member in this file. A build with no feed never gets it,
// so `getEditorAPI().update` is undefined and both §1.6 surfaces vanish.
if (process.argv.includes(UPDATE_ARG)) {
  api.update = {
    onPhase: (cb) => subscribe<UpdatePhase>(CH.updatePhase, cb),
    current: () => ipcRenderer.invoke(CH.updateCurrent) as Promise<UpdatePhase>,
    check: () => ipcRenderer.send(CH.updateCheck),
    /* …download, cancelDownload, installAndRestart, dismiss… */
  };
}

contextBridge.exposeInMainWorld('editorAPI', api);
```

`createWindow()` runs after `registerUpdate(ipcMain)` in `whenReady`, so the answer exists before the
window that needs it. `preload.ts`'s header comment gains one clause naming argv-derived constants
(`readBuild`, this switch) as the one thing in the file that is not a one-line `ipcRenderer` call —
a comment that states a premise the file no longer holds is worse than no comment.

### Files

Owned by this feature:

- **`electron/update.ts`** — new. The gate, the lazy import, the settings, the timers, the phase
  machine, the IPC registration, `runUpdateInstaller`. It imports `electron`, `node:fs`, `node:path`,
  `../src/types/api`, and — lazily — `electron-updater`. Nothing else.
- **`src/components/shell/UpdateStrip.tsx`** — new. §1.6, §1.7.
- **`src/components/shell/shell.css`** — the `.shell-titlebar-update*` rules, beside the recovery
  strip's.
- **`scripts/check-release.mjs`** — new gate, §1.12.

Edited elsewhere, minimally:

- **`src/types/api.ts`** — seven `CH` entries, `UpdatePhase`, `UpdateBridge`, `EditorAPI.update?`,
  and (§2) `AppBuild` + `EditorAPI.build`.
- **`electron/preload.ts`** — the `UPDATE_ARG` switch and the conditional `update` member, `build`,
  and one clause on the header comment.
- **`electron/main.ts`** — `CloseApproval.installUpdate?`, the widened `resolveCloseIntent` parameter
  type, two lines in `approveAndClose`, `requestInstallAndRestart`, one `registerUpdate(ipcMain)`
  call, `UPDATE_ARG` in `createWindow`'s `additionalArguments`, plus §2's build payload and §3's
  splash lifecycle. (**Not** `handleSessionEnd` — §1.8 says why.)
- **`src/components/shell/AppMenu.tsx`** — `Check for updates` (§1.6), `Copy version` (§2.3), and
  `run()`'s third parameter (§2.3).
- **`src/components/shell/TitleBar.tsx`** — one `<UpdateStrip />`.
- **`src/dev/fixtures.ts`** — `build` only. **No `update` member**, so `dev:web` renders no strip and
  no menu item, which is correct: a browser preview cannot update anything.
- **`scripts/check-contract.mjs`** — one entry on `ACCENT_ALLOWED`, for the splash mark. §3.8 and
  §3.13 are why; §1.12 gate 2 records that this gate is amended rather than untouched.
- **`electron-builder.yml`** — the `publish:` block, and the `files` change below.
- **`package.json`** — `electron-updater` in `dependencies`.
- **`README.md`** — §1.13.

§2 and §3 touch more files of their own, all listed where they are specified:
`src/vite-env.d.ts` (§2.2, new); `vite.config.ts` (§2.2's `define`, §3.6's second entry and CSP
plugin); `src/styles/type.css` (§3.6, new) and `src/styles/base.css` (§3.6); and §3.6's six splash
files — `splash.html`, `src/splash/splash.ts`, `src/splash/splash.css`, `src/splash/graphic.ts`,
`electron/splash.ts`, `electron/splash-preload.ts`. Plus the three documents §3.13 amends.

### The packaging consequence, which is real

`electron-builder.yml` currently excludes `node_modules` outright, with a comment that is correct
today:

> Nothing in `electron/` imports a package — only `electron` itself and node builtins — so
> `node_modules` is 240 MB of nothing and is excluded outright.

**`electron-updater` breaks that premise, and it brings fifteen packages with it.** `'!node_modules/**'`
excludes everything not explicitly re-included, so a list that names `electron-updater` and stops
produces an asar containing `electron-updater` and none of its dependency graph. The first `require`
inside §1.3's lazy import then throws `Cannot find module 'fs-extra'` — in main, at the moment the
user presses *Check for updates*, with no UI path to report it. **A partial list is worse than no
feature**, so the list is the full closure or it is nothing.

The `files` block therefore becomes:

```yaml
files:
  - dist/**
  - dist-electron/**
  - package.json
  - '!node_modules/**'
  # electron-updater's COMPLETE production closure at 6.3.9 — 16 packages,
  # sorted, machine-generated. Regenerate with:
  #     node scripts/check-release.mjs --write-deps
  # Never hand-edit: scripts/check-release.mjs re-resolves it and fails the
  # build on any difference (docs/RELEASE.md §1.11, §1.12 gate 1.5).
  - 'node_modules/argparse/**'
  - 'node_modules/builder-util-runtime/**'
  - 'node_modules/debug/**'
  - 'node_modules/electron-updater/**'
  - 'node_modules/fs-extra/**'
  - 'node_modules/graceful-fs/**'
  - 'node_modules/js-yaml/**'
  - 'node_modules/jsonfile/**'
  - 'node_modules/lazy-val/**'
  - 'node_modules/lodash.escaperegexp/**'
  - 'node_modules/lodash.isequal/**'
  - 'node_modules/ms/**'
  - 'node_modules/sax/**'
  - 'node_modules/semver/**'
  - 'node_modules/tiny-typed-emitter/**'
  - 'node_modules/universalify/**'
  - '!**/*.map'
```

The comment above the block must be amended in the same change — a comment that states a premise the
config no longer holds is worse than no comment.

**The list is measured, and the command that measures it is not the obvious one.**
`npm ls --omit=dev --parseable electron-updater` prints **one line**: the path of `electron-updater`
itself. So does `npm ls --omit=dev --all --parseable electron-updater` — the name filter defeats
`--all`. Neither can produce a closure, and a list attributed to either is a guess wearing a
citation. What was actually run, in a throwaway directory containing nothing but
`npm i electron-updater@6.3.9`:

```
npm ls --omit=dev --all --parseable      # no name filter: prints the whole tree
du -sk node_modules                      # 2750 KB
```

which yields exactly the sixteen names above, all hoisted to the top level, at a **measured 2.7 MB**
on disk against a ~300 MB installer. Running the unfiltered form **in this repository** would be
wrong for a different reason: it prints the whole production tree, including `react`, `zustand`,
`lucide-react` and the two font packages, which Vite bundles into `dist/` and which have no business
in the asar.

So the gate does not shell out to npm at all:

1. **`scripts/check-release.mjs` re-resolves the closure itself** (§1.12 gate 1.5). Start at
   `node_modules/electron-updater/package.json`; take its `dependencies`, plus any
   `optionalDependencies` actually present on disk; resolve each name the way node does, walking up
   through successive `node_modules/` directories from the requiring package; recurse; collect names.
   Compare the resulting set with the yml's re-inclusion set. Any difference — in either direction —
   fails the build, so an `electron-updater` upgrade that adds a transitive dependency is caught by
   `npm run check` rather than by a user pressing a button in an installed app.
2. **It also asserts every resolved package is hoisted to the top level of `node_modules`.** The glob
   form `node_modules/<name>/**` covers only top-level packages; a nested copy (a version conflict
   npm could not hoist) would be silently omitted from the asar and would reproduce the exact
   `Cannot find module` this list exists to prevent. If that ever fires, the fix is the fallback
   below, not a cleverer glob.
3. **`--write-deps` rewrites the yml block from the resolution**, so the list is regenerated rather
   than edited, and the two can never drift by a typo.

> **Implementation note — assertion 2 fired on the first install, and this is what was chosen.**
> `electron-updater@6.8.9` in *this* repository resolves sixteen packages, exactly the names listed
> above, but only **eleven of them hoist**. `electron-builder` is a devDependency and its own
> `fs-extra`, `jsonfile`, `universalify`, `semver` and `builder-util-runtime` reached the top level
> first at incompatible versions, so npm nested electron-updater's copies under
> `node_modules/electron-updater/node_modules/`.
>
> **The fallback below was not taken, because assertion 2's stated premise does not hold for this
> case.** A copy nested *under a package the list already re-includes* is not silently omitted: it
> is inside `node_modules/electron-updater/**`, which ships it. What the assertion is actually
> protecting is *reachability inside the asar*, so that is what `scripts/check-release.mjs` asserts:
> every resolved package must be either at the top level (covered by its own glob) or nested inside
> a directory that is itself re-included. Anything else still fails the build. The gate prints the
> nested five on every run, so the situation cannot go quiet. Measured closure on disk, all sixteen
> including the nested copies: **2.53 MB**.
>
> The yml's sixteen entries are still correct and are still generated by `--write-deps`. Five of
> them point at the *devDependency's* copy of a package rather than at electron-updater's; that costs
> a little dead weight in the asar and nothing else, because node resolves the nested copy first at
> runtime.

**The size budget, and the fallback if it is ever exceeded.** The closure is 2.7 MB measured. If a
future `electron-updater` pushes it past **12 MB**, or if assertion 2 fires in its true form — a
package reachable from neither its own glob nor an enclosing one — stop maintaining a list:
drop `'!node_modules/**'` and ship `node_modules/**`, accepting ~240 MB in the installer, or unpack
`electron-updater` and its closure with `asarUnpack`. Both are worse than the list *today*; both are
better than a list that is wrong. State which was chosen here when it happens.

**The other alternatives were considered and rejected.** Dropping the exclusion now costs ~240 MB for
2.7 MB of need. Bundling `electron-updater` into `dist-electron` with a bundler would avoid the list
entirely, at the cost of introducing a bundler into a build that currently has none for the main
process — and of bundling a library that reads its own `package.json` at runtime. Neither trade is
worth it at 2.7 MB with a gate holding the list honest.

## 1.12 Verification

**Gates 1 and 2 are automatic** and run in `npm run check`. **Gates 3–6 are manual** and are run once
per release, on the shipping target — gate 3 included: it installs a packaged build and watches it
for fifteen minutes, which is not something a script in this repository can do.

**Gate 1 — `scripts/check-release.mjs`, added to `npm run check`.** Exits non-zero on any failure and
prints every measured value beside its expectation:

1. `electron-builder.yml` contains an explicit top-level `publish:` key. Absent → **fail**, with the
   §1.2 comment quoted, because absence means electron-builder may infer a feed nobody chose.
2. If `publish` names a `generic` provider, its `url` starts with `https://`.
3. `package.json`'s `version` parses as semver.
4. **No version literal anywhere else.** Grep `src/**` and `electron/**` for a bare `\d+\.\d+\.\d+`
   string literal; the only permitted matches are in comments. This is what makes "one source of
   truth" a gate rather than a promise (§2.1).
5. The `files` allow-list in `electron-builder.yml` equals the resolved production closure of
   `electron-updater`, re-resolved by this script rather than by `npm ls` (§1.11), **and** every
   package in that closure is hoisted to the top level of `node_modules`. Prints the resolved set and
   the yml's set side by side on failure.
6. `src/splash/splash.css` declares no motion (§3.11). **Comments are stripped first** — every CSS
   file in this codebase opens with a prose header, and §3.11's own justification contains the words
   *transition* and *animation*, so a word-match on the raw text fails the build on the very comment
   that explains the rule. Delete `/*…*/` spans, then match declarations, not words:
   `/^\s*(transition|animation)[\w-]*\s*:/m` and `/@keyframes\b/`.
7. `electron/update.ts` calls `quitAndInstall` exactly once. **Comments are stripped first**, for the
   same reason: §1.8's specified source for that file contains the string twice more, in a JSDoc
   block and a trailing comment. Drop `//…` to end of line and `/*…*/` spans, then count.

**Gate 2 — `npm run contract`, with one amendment to the checker.** Nearly everything the splash
needs is already covered: its CSS lives under `src/`, so `scripts/check-contract.mjs` already walks
it and a hardcoded colour fails with no new rule — that is why §3.6 puts `splash.css` under `src/`
rather than beside `index.html`.

**One rule does have to be amended, and pretending otherwise would fail the build.** Rule 6, the
accent budget, fails any file under `src/` that reads `var(--accent` unless its path matches
`components/timeline/`, `components/ui/`, `styles/` or `components/export/`. The splash mark is drawn
in `var(--accent)` (§3.8) and `src/splash/` matches none of them. So `ACCENT_ALLOWED` gains **one
entry, `'splash/graphic.ts'`** — the file, not the directory, because the allowance §3.13 writes into
`DESIGN.md` and `PLAN.md` §7.4 is for the mark's reproduction at identity scale and nothing else.
`src/splash/splash.css` therefore still fails the gate if it so much as mentions the accent, which is
the property worth keeping. The amendment ships in the same change as the §3.13 edits; the checker is
listed in §1.11's edited-files table.

**Gate 3 — silence, measured.** Install a build with `publish: null`. Launch it. Leave it for fifteen
minutes with a project open.

- `CDP_PORT=9222 node .../cdp.mjs "typeof window.editorAPI.update"` → `"undefined"`.
- `CDP_PORT=9222 node .../cdp.mjs "process.argv.some(a=>a.startsWith('--ve-update'))"` → `false`.
  The switch is the seam §1.11 hangs the member on; asserting the member without asserting the switch
  leaves the two able to drift.
- The application menu contains no `Check for updates` item.
- A packet capture (or `netstat -b` sampled over the window) shows no outbound connection from
  `Video Editor.exe` other than the ones the app already makes, which is none.
- The main-process log contains no `[update]` line.
- **Then repeat the whole gate on a build whose `publish:` block names a `generic` provider over
  plain `http://`.** §1.3 condition 4 must reject it: every assertion above holds again, same
  silence, no warning and no notice. A feed the app refuses must be indistinguishable from no feed —
  if the two differ in any observable way, condition 4 is a warning wearing a gate's clothes.

**Gate 4 — the feed works, and Cancel cancels.** Against a throwaway HTTPS static host, or a private
GitHub repo: build 0.1.0, install it, publish 0.2.0, press `Check for updates`, and observe
`available` → `Download` → `downloading` with a moving percentage → `ready`.

Then, on a fresh run: press `Download`, and press **Cancel** at roughly 30 %. Assert that the strip
returns to `available` (not to no strip at all), that **no further `download-progress` push arrives**
— sample `update:phase` over the next ten seconds — and record what is left in
`"%LOCALAPPDATA%\Video Editor-updater\pending"` (quote it; the path contains a space). Then press
`Download` again and assert it completes to `ready`. A `Cancel` that leaves the transfer running, or
that poisons the next download, is the failure this step exists to find.

**Gate 5 — the install path, over a real previous install.** This is the one that cannot be skipped
and cannot be simulated.

**Both builds must be feed-configured.** The 0.1.0 installed at step 1 is *not* the 0.1.0 currently
shipping: a build made with `publish: null` contains no `resources/app-update.yml`, so it has no
update UI and can never receive anything (§1.13). Build 0.1.0 with the feed block filled in, install
that, and publish 0.2.0 against the same feed.

1. Install 0.1.0 to `E:/Video Editor` with the NSIS installer.
2. Open a project, make an edit, do **not** save.
3. Press `Restart and install`.
4. **Assert the unsaved-changes dialog appears.** Press **Cancel**. Assert the app is still running,
   the project is still dirty, nothing was installed, and the strip is still in `ready`.
5. Press `Restart and install` again. Press **Save**. Assert the file is written, the window closes,
   the installer runs, and the app comes back up reporting 0.2.0 in the application menu.
6. Assert the installer **did not** ask for an installation directory. `nsis.oneClick: false` plus
   `allowToChangeInstallationDirectory: true` means the assisted installer normally shows a directory
   page; on an update electron-builder's template passes `--updated` and the existing install is
   detected. **If the directory page appears anyway**, the fix is one of: set `nsis.oneClick: true`
   (loses the assisted install for first-time users), or accept one extra click per update. Decide
   it here, once, by measurement — do not guess.
7. Repeat 1–5 with the renderer deliberately crashed
   (`cdp.mjs "process.crash()"` is not reachable; use the DevTools *Crash renderer* action) and
   assert the watchdog dialog appears and `Close without saving` still installs.
8. **A shutdown is not consent to install** (§1.8, the two bold rows). On a dirty project in `ready`, press
   `Restart and install`; with the unsaved-changes dialog open, trigger `session-end` — log off, or
   send `WM_ENDSESSION` to the window — and assert **no installer process appears**: nothing named
   `Video Editor*Setup*.exe` or `elevate.exe` in Task Manager or in a `Get-Process` sample taken
   during and after the logoff, and `E:/Video Editor` still reports 0.1.0 on the next launch. Then
   repeat with the renderer paused in DevTools so the decision is still outstanding at
   `CLOSE_SAVE_WATCHDOG_MS`, and assert the same, plus that the autosave snapshot **survives** and is
   offered on the next launch. That second run is the deterministic path: without the two guards in
   `approveAndClose` it spawns an installer into a session that is logging off, and it retires the
   snapshot on the way.

**Gate 6 — the app never installs on its own.** Install 0.1.0, publish 0.2.0, let the automatic check
find it, press **Download**, wait for `ready`, then close the window normally. Relaunch. Assert the
running version is still **0.1.0** and the update is offered again. That is `autoInstallOnAppQuit =
false` working, and it is the property the whole design rests on.

Confirm by looking: the downloaded payload is still sitting in
`"%LOCALAPPDATA%\Video Editor-updater\pending"` — quote it, the directory name is derived from
`app.getName()`, which is the `productName` `Video Editor`, so it contains a space and an unquoted
`dir`/`ls` against it silently lists the wrong thing. `dir "$env:LOCALAPPDATA\Video Editor-updater\pending"`
must show the `.exe`, and the second offer must report `ready` without re-downloading it.

## 1.13 `README.md`

Two edits, both to the packaging section.

1. The sentence that currently reads:

   > **The installer is not code-signed.** There is no certificate, so Windows SmartScreen will say
   > "Windows protected your PC" the first time you run it; *More info → Run anyway*. Signing it
   > means buying a certificate and adding `win.certificateFile` to the config. Nothing else has to
   > change.

   gains, after it, the second half of §1.9: that reputation accrues to a certificate rather than to
   a file, so the warning appears on **every** version rather than once; that the only integrity
   check on an update is the sha512 in `latest.yml`, which proves the bytes arrived intact and
   nothing about who wrote them; and that the update host's TLS is therefore the whole of the
   channel's security.

2. A new short subsection, **Updates**, stating: that this build ships with no update feed and
   therefore never contacts a server; that configuring one is a single block in
   `electron-builder.yml` documented in `docs/RELEASE.md` §1.2; that when a feed exists the app
   checks ten minutes after launch and every six hours, never on launch, and never installs anything
   without a press; and that there is no rollback — the remedy for a bad release is a newer one.

   **It must also state the consequence for the copy already installed.** A build made with
   `publish: null` contains no `resources/app-update.yml`, so it can never *receive* an update — the
   0.1.0 at `E:/Video Editor` today included. The first version that carries a feed has to be
   installed by hand, over the old one, with the NSIS installer; from that install onwards updates
   flow on their own. Say it in the README, because it is the one thing a user cannot discover from
   inside the application: an app with no update UI looks identical to an app that is up to date.

Quote the sentence rather than a line number; `README.md` is edited by more than one area.

---

# §2 The version number

## 2.1 One source of truth

**`package.json`'s `"version"` field. Read at runtime, never at build time.**

The build-time alternative — a Vite `define` of `__VE_VERSION__` — is rejected on one concrete
failure: `npm version patch` followed by `electron-builder` *without* an intervening `vite build`
ships a new `package.json` inside the asar next to a renderer bundle carrying the old number, and
the two disagree in the one place that matters, which is a bug report. Reading at runtime cannot
produce that state.

At runtime, main asks `app.getVersion()`. In a packaged build that reads the `version` field of the
`package.json` that electron-builder packed into `app.asar` — which is exactly this repository's
`package.json`, because it is listed in the `files` block. In a dev run it reads the same file from
disk. One value, both modes, no plumbing.

Gate 1.12/4 asserts there is no other version literal in `src/**` or `electron/**`.

## 2.2 How it reaches the renderer in an asar-packed build

The renderer cannot read it. `nodeIntegration` is false, the file is inside an archive, and
`app` is a main-process module. Three routes exist and two are wrong:

- `ipcRenderer.sendSync` — blocks the renderer during preload for an IPC round trip, to fetch a
  constant.
- `ipcRenderer.invoke` — asynchronous, so the application menu renders with an empty version on first
  open and fills it in a tick later. A number that appears after you look at it is worse than no
  number.
- **`webPreferences.additionalArguments`** — main puts the value in the renderer process's `argv`
  at window creation; the preload reads it synchronously off `process.argv` with no IPC at all.
  ← chosen.

It carries more than the version, because everything a bug report needs is known at the same instant
and none of it changes:

```ts
/* src/types/api.ts */

/** Everything a bug report needs, computed once in main, delivered synchronously. */
export interface AppBuild {
  /** package.json "version" via app.getVersion(). Semver, no leading 'v'. */
  version: string;
  /** process.versions.electron */
  electron: string;
  /** process.versions.chrome */
  chromium: string;
  /** os.release() — '10.0.26200' on win32. */
  os: string;
  /** process.arch — 'x64'. */
  arch: string;
  /** app.isPackaged. False under `npm run dev`; the fixture bridge reports false too. */
  packaged: boolean;
}

export interface EditorAPI {
  platform: 'win32' | 'darwin' | 'linux';
  /** Constant for the life of the process. Never a promise — see RELEASE.md §2.2. */
  build: AppBuild;
  /* … */
}
```

```ts
/* electron/main.ts — computed once, module scope, after app is available */
const BUILD_ARG = '--ve-build=';
const appBuild = (): AppBuild => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chromium: process.versions.chrome,
  os: os.release(),
  arch: process.arch,
  packaged: app.isPackaged,
});

/* …in createWindow's webPreferences, and in the splash window's: */
additionalArguments: [`${BUILD_ARG}${encodeURIComponent(JSON.stringify(appBuild()))}`],
```

**The main window's array carries one more element, and §1.11 owns it.** `--ve-update=1` rides the
same transport for the same reason — a main-process fact, known at window creation, that preload must
read synchronously — and it is deliberately **not** a field on `AppBuild`: `AppBuild` is "everything
a bug report needs", every one of its six fields is rendered by §2.3's diagnostic block, and a
seventh that is never rendered would be the first thing in that struct that is not what the struct
says it is. Two switches, two meanings, one mechanism. The splash window gets the build payload and
**not** the update switch — it has no `EditorAPI` and nothing to update.

```ts
/* electron/preload.ts — and, identically, electron/splash-preload.ts */
const BUILD_ARG = '--ve-build=';

/** Never throws. A malformed argument yields a build whose every field is 'unknown',
 *  which is a visible, reportable state rather than a crash during preload. */
function readBuild(): AppBuild {
  const raw = process.argv.find((a) => a.startsWith(BUILD_ARG));
  try {
    if (raw) return JSON.parse(decodeURIComponent(raw.slice(BUILD_ARG.length))) as AppBuild;
  } catch { /* fall through */ }
  return { version: 'unknown', electron: 'unknown', chromium: 'unknown',
           os: 'unknown', arch: 'unknown', packaged: false };
}
```

`encodeURIComponent` is not decoration: the JSON contains quotes and braces, and an unencoded
argument is at the mercy of every layer between `BrowserWindow` and `process.argv`. It also
guarantees the value contains no whitespace, which is what makes `argv.find(startsWith)` safe.

**`dev:web` gets it from Vite**, and this is not a second source of truth because the fixture bridge
does not exist in the Electron bundle:

```ts
/* vite.config.ts — `fs` and `URL` are already imported by this file. */
const pkg = JSON.parse(
  fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineConfig(({ command }) => ({
  define: { __VE_VERSION__: JSON.stringify(pkg.version) },
  /* … */
}));
```

The function form is §3.6's doing, not this section's — the splash's CSP plugin needs `command`. If
§3 is ever dropped, this reverts to the object form and nothing here changes.

**A read, not an import, and that is not fussiness.** `import pkg from './package.json' assert
{ type: 'json' }` is deprecated in Node 22 and **removed in Node 23+**; its replacement, `with
{ type: 'json' }`, is a syntax whose support depends on the `module` setting of whichever of the two
tsconfigs happens to pick the file up. `fs.readFileSync` has none of that coupling, `vite.config.ts`
already imports `fs` and `URL`, and the value is a string either way.

```ts
/* src/vite-env.d.ts — NEW. tsconfig.json's "include" already covers `src`, so
   nothing else has to change to make it visible. */
/// <reference types="vite/client" />

/** Injected by vite.config.ts's `define`. The ONLY consumer is src/dev/fixtures.ts,
 *  which exists only under dev:web — RELEASE.md §2.2. */
declare const __VE_VERSION__: string;
```

```ts
/* src/dev/fixtures.ts — the only consumer of __VE_VERSION__ in the project */
build: { version: __VE_VERSION__, electron: 'n/a', chromium: 'n/a',
         os: 'n/a', arch: 'n/a', packaged: false },
```

Without that declaration file `npm run typecheck` fails with **TS2304: cannot find name
`__VE_VERSION__`** — and `npm run typecheck` is gate 1 of §1.10's release sequence *and* the first
step of `npm run build`, so the whole release stops on a missing three-line file. `tsconfig.electron.json`
includes only `electron/**` and two files under `src/types/`, so it never sees `fixtures.ts` and
needs nothing.

## 2.3 Where it is visible, and how it is copied

**Three surfaces, one number.**

### 1. The application menu — the conventional home

`AppMenu.tsx`, in the help group, below `Keyboard shortcuts`, after a separator:

```
──────────────────────────
Copy version          0.1.0
```

One `MenuItem` of `kind: 'item'`, and **it needs no change to the `Menu` component**:

```ts
{
  kind: 'item',
  id: 'version',
  label: 'Copy version',
  shortcut: <span className="type-numeric">{build.version}</span>,
  onSelect: () =>
    run(
      navigator.clipboard.writeText(diagnosticBlock(build)),
      'Copy failed',
      'The version could not be copied to the clipboard',   // see below
    ),
}
```

The `shortcut` slot is already `ReactNode`, already right-aligned, already muted, and already
rendered in a slot the eye reads as "the secondary fact about this row". Putting the numerals there
gets `.type-numeric` with no component surgery and no new `MenuItem` kind.

Two things this gets right that a `kind: 'label'` row would not:

- **It is visible in normal use.** The number is on screen every time the menu opens, which is often,
  because that menu also holds Save, Open, Export and Theme.
- **It is copyable in one press**, which is the requirement. A label is not focusable, cannot be
  selected with the keyboard, and cannot be copied at all.

**Accessibility.** `Menu.tsx` renders the shortcut slot as
`<span className="ve-menu-item-shortcut type-label">` with **no** `aria-hidden` (the icon slot on
line 203 is the one that is hidden), so the item's accessible name is already
`Copy version 0.1.0` — which is correct and needs nothing added. If that ever changes, the item must
gain an explicit `aria-label` of the same string; it must never announce as bare `Copy version`,
because the number is the information.

**What is copied.** Not the bare version — the block a bug report actually needs, built in the
renderer from `api.build` and nothing else:

```
Video Editor 0.1.0
win32 10.0.26200 x64
Electron 33.3.1 · Chromium 130.0.6723.191
```

Three lines, `\n`-joined, no trailing newline. `packaged: false` appends ` (development build)` to
the first line, because a bug reported from a dev run and a bug reported from an installer are
different bugs.

**Confirmation.** None, and deliberately. `Notice.tone` is `'danger' | 'warning'` — there is no
success tone in this palette by design (`DESIGN.md` §2 Status), and inventing one for a clipboard
write would be a fourth status role bought with a single string. The menu closes on select, which is
the same feedback every other item in that menu gives.

If `navigator.clipboard.writeText` rejects (it can, if the window is not focused), the failure goes
through `AppMenu.tsx`'s existing `run()` helper — **which gains a third parameter to say so
truthfully.** `run(work, title)` today hardcodes its message: *"The editor could not reach the file
system"*, which is right for `openProject` and `saveProject` and is a false and confusing thing to
tell someone whose clipboard write was refused. The change is one line and no existing call site
moves:

```ts
function run(
  work: Promise<unknown>,
  title: string,
  message = 'The editor could not reach the file system',   // ← new, defaulted
): void {
  void work.catch(() => readStore().setNotice({ tone: 'danger', title, message }));
}
```

and the `version` item calls
`run(navigator.clipboard.writeText(diagnosticBlock(build)), 'Copy failed', 'The version could not be copied to the clipboard')`.
A defaulted parameter rather than a local `.catch()` because there is then still exactly one place in
this component that turns a rejected promise into a notice.

### 2. The splash footer

Bottom-left, `Version 0.1.0`, `.type-numeric` on the numerals. §3.7.

### 3. The update strip

`Version 0.2.0 is available.` — the *other* version, which is the only reason anyone reads the
first one. §1.6.

**Not a fourth surface.** No About dialog, no window title suffix, no console banner. An About dialog
is a modal where an inline affordance already works, which `PRODUCT.md` rules out; a version in the
window title spends the one line that carries the project name and its dirty state.

## 2.4 `.type-numeric`, and an honest note on the Tabular Rule

`DESIGN.md`'s Tabular Rule scopes the mono to *"every numeral that can change while the interface is
live"*. The application's own version does not change while the interface is live. The rule does not
require `.type-numeric` here.

It is used anyway, for two reasons that are worth stating rather than smuggling:

1. **It is a version number, not prose.** `0.1.0` in a proportional sans has three different digit
   widths and two full stops that kern differently; in tabular mono it is a token you can read once
   and retype correctly. The person reading it is about to type it into a bug report.
2. **The consistency runs the other way.** Every other place in the app where a number is a *value*
   rather than a word already uses this class. A version rendered in Inter would be the only bare
   numeral in the interface that is not, and the exception would need its own explanation.

The update strip's `0.2.0` and its `62 %` *are* covered by the rule outright, since both change while
the strip is on screen. Only the menu row and the splash footer are this note's subject.

---

# §3 The start-up splash

## 3.1 The tension, resolved honestly

The user asked for a splash. Three places in this codebase currently promise there will not be one.
The user's call overrides the documents — but the documents then have to say something true, and
"we changed our mind" is not a design principle. So the splash is specified in a form that **keeps
the promise it appears to break**, and the edits in §3.13 say so.

**First, precisely what is written today**, because the brief's paraphrase is not quite what is on
disk:

| File | Text |
|---|---|
| `electron/main.ts:399` | `// The app opens directly into the task: no entrance sequence, no flash.` |
| `DESIGN.md` §5 Motion | *"No bounce, no elastic, no orchestrated load sequence: the app opens directly into the task."* |
| `DESIGN.md` §6 Don'ts | *"**Don't** animate an entrance sequence on launch. The app opens into the task."* |
| `PRODUCT.md` | **No such sentence exists.** The nearest carriers are principle 2 (*"the default screen shows only the editing loop"*) and principle 5 (*"no onboarding funnel"*). |

That last row matters: `PRODUCT.md` does not currently contradict a splash, it simply has nothing to
say about launch. The contradiction is `DESIGN.md`'s, twice, and a code comment.

**The resolution, which is a design decision and not a loophole:**

> The splash is not an entrance sequence. It does not animate, it is not held open for effect, and on
> a fast launch **it never appears at all**. It exists only in the window of time where the promise
> "the app opens directly into the task" was already going to be broken — by the machine, not by us —
> and it spends that window saying what the app is doing instead of showing an empty rectangle.

That is enforced by three mechanisms, each of which is a number in §3.4: it is not *shown* until the
launch is already known to be slow; it has **zero** animations and zero `@keyframes`, which is a
gate; and it is destroyed the instant the editor window is ready, with no floor on its lifetime.

`DESIGN.md`'s two sentences stay true as written — the *app* still opens directly into the task and
still animates no entrance. What changes is that the sentences now scope themselves, and `PRODUCT.md`
gains the principle that makes the splash's own constraints binding rather than optional. §3.13 is
the exact wording.

## 3.2 The anatomy, adopted

From the reference recording (`Medrak Recorder`, frames in the scratchpad). The **structure** is
adopted wholesale; **none** of the styling is.

| Reference | Here |
|---|---|
| landscape rounded card ≈ 950 × 580, dark | 960 × 560, `--surface-well`, `--radius-lg` |
| left column ≈ 40 % | 384 px (40 %) |
| app mark, small, top | the app mark at 28 px, §3.8 |
| two-weight wordmark, product name split across two lines | `Video` 400 / `Editor` 600, §3.7 |
| short tagline | two lines, §3.7 |
| live status line: dot + text | dot + text, **shown only when a real phase is slow**, §3.9 |
| thin progress rule beneath it | a **phase** rule: completed / total, discrete, §3.9 |
| footer: copyright + `Version 1.0.141` | `© 2026` + `Version 0.1.0` in `.type-numeric`, §3.7 |
| right column ≈ 60 %: one large signature graphic | 575 px (60 %): §3.8 |
| mint→peach gradient waveform over a radial glow | **nothing of the kind.** No gradient, no glow, no hue at all. |

**What replaces the waveform, and why.** A waveform is an audio product's mark; this is a video
editor, and drawing one would be borrowing a stranger's identity. The graphic here is this system's
own thesis, drawn in this system's own tokens: **six lanes of clips, dim; one clip lit; one vertical
cut through all six.** It is `PRODUCT.md` principle 1 (*the frame is the only lit thing*), principle
4 (*forty clips across six tracks, not a three-clip screenshot* — the graphic draws forty-one), and
the app icon's own signature gesture (`ICON.md` §2, Direction C, *the cut*), in one static image.

## 3.3 The one thing the reference does that this system will not: colour

`ICON.md` §2 Direction B — *one lit clip among dim clips* — was **rejected for the icon**, on a
measurement: no neutral in this palette is ≥ 3 : 1 from both the tile **and** `--accent`.
`--text-muted` and `--accent` are within 7 % of each other in luminance, so under deuteranopia the
lit clip and the dim clip become the same object.

**The splash spends no accent, and that is exactly what makes Direction B shippable here.**
`PLAN.md` §7.4's budget is four families and six uses, closed; a splash is not one of them, and a
seventh use would be a bug. Removing the accent removes the constraint that killed the direction:

| pair | ratio | floor | verdict |
|---|---|---|---|
| lit clip `--text-on-well` on the card `--surface-well` | **18.3 : 1** | 3 : 1 | pass |
| dim clip `--border-structural` on the card | **4.80 : 1** | 3 : 1 | pass |
| lit clip on dim clip | **3.82 : 1** | 3 : 1 | pass |
| the cut (`--surface-well`) through a lit clip | **18.3 : 1** | 3 : 1 | pass |
| the cut through a dim clip | **4.80 : 1** | 3 : 1 | pass |
| wordmark `--text-on-well` on the card | 18.3 : 1 | 4.5 : 1 | pass |
| tagline line 2, footer, status dot `--text-on-well-muted` on the card | **8.33 : 1** | 4.5 : 1 | pass |
| card keyline `--border-structural` vs `#ffffff` / `#202020` | 4.30 / 3.79 : 1 | 3 : 1 | pass — the card sits on an unknown desktop |

The `--border-structural` figures are `ICON.md` §5's, measured; the rest are computed from the same
`signal` token values against the same relative-luminance formula. Every pair clears its floor, and
every one of them is a **lightness** separation, so the whole image survives desaturation and every
colour-vision deficiency intact. **Desaturate the splash and nothing is lost, because there is
nothing to desaturate.**

**The theme.** The splash renders in `signal`, unconditionally, by carrying
`data-theme="signal"` on its own `<html>` — the same literal attribute `index.html` already carries.
It does not follow the user's theme, for a reason and with a mitigation:

- **The reason:** the theme lives in `localStorage['ve.ui.v1']`, in the renderer's origin, and is
  read by the renderer at boot. The splash exists *before* the renderer. Making main know the theme
  means a second persistence path — a file in `userData` written on every `setTheme` — which is real
  machinery for four hundred milliseconds of screen time. `ICON.md` §5 already settled the same
  question the same way for the same reason: *"An OS icon is written to disk once at package time and
  cannot follow a runtime theme switch."* A splash cannot follow one it has not been told about yet.
- **The mitigation:** the splash's ground is `--surface-well`, the one plane `DESIGN.md` keeps dark
  in **all three** themes by explicit design. So under `daylight` the splash is a dark card giving
  way to a light shell whose preview well is still the darkest thing on screen. It is a change of
  surround, not a contradiction.
- §3.12 states the escape hatch, and states that it is out of scope.

## 3.4 The lifecycle, which is the whole feature

Four constants, in `electron/splash.ts`:

```ts
/** Do not SHOW the splash until the launch is already known to be slow. */
const SPLASH_SHOW_DELAY_MS = 250;
/** Do not draw a status LINE until a phase has actually been in flight this long. */
const SPLASH_STATUS_DELAY_MS = 400;
/** Hard ceiling. Past this the splash is destroyed and the main window is shown regardless. */
const SPLASH_MAX_MS = 20_000;
/** How long main waits for `splash:ready` after the splash window's own
 *  ready-to-show before treating the splash as ready anyway. */
const SPLASH_READY_FALLBACK_MS = 300;
```

### The deferred show — one rule, three conditions

The splash window is created early and **`show: false`**. `splash.show()` is called from exactly one
place, a `maybeShow()` that runs on each of the events below and **does nothing unless all three of
these hold**:

| # | Condition | Signal | Why |
|---|---|---|---|
| 1 | the launch is already known to be slow | the `SPLASH_SHOW_DELAY_MS` timer, armed at `whenReady()`, has fired | a splash on a warm start is the flash this design exists to prevent |
| 2 | the splash has painted and its fonts have settled | `splash:ready` (§3.10) has arrived, **or** `SPLASH_READY_FALLBACK_MS` has elapsed since the *splash window's own* `ready-to-show` | showing before this composites a blank or half-laid-out rectangle — the exact failure §3.14 gate 3 hunts |
| 3 | the editor is not ready yet | the **main** window has not emitted `ready-to-show` | if the editor is ready, there is nothing to cover |

Whichever of the three becomes true last is the one that triggers the show. If condition 3 goes false
first — the editor won — the splash is **destroyed without ever having been composited**: zero
frames, zero flash, and on a fast machine the app opens directly into the task exactly as `DESIGN.md`
says it does.

**What the splash window's `ready-to-show` is for: only condition 2's fallback.** It is not the show
signal. `splash:ready` is, because `ready-to-show` means *first paint is possible*, not *the fonts
have settled* — and §3.7's `document.fonts.ready` race is what stops the 44 px wordmark reflowing
while the user looks at it. The fallback exists because `splash:ready` comes from a renderer, and a
renderer that fails to boot must not be able to hold the splash hostage. 300 ms is §3.7's 120 ms font
ceiling plus slack for the module to evaluate.

If **neither** signal ever arrives — the splash renderer is broken outright — condition 2 is never
satisfied, the splash is never shown, and `SPLASH_MAX_MS` destroys it and shows the main window. A
launch with no splash is the correct failure mode; a launch with a blank rectangle is not.

This is the inverse of the usual splash: the forbidden thing is *holding it open* after the app is
ready. A deferred show is the opposite — it costs nothing and it prevents the 200 ms flash that a
naive implementation produces on a warm start.

`SPLASH_SHOW_DELAY_MS = 250` is a starting value and is **required to be measured on the shipping
target** — §3.14 gate 2. If the installed app's `ready-to-show` lands consistently under 250 ms,
raise it and the splash correctly disappears from the product; if it lands at 900 ms, 250 ms is
right.

### The phases

Three, always three, decided before the splash can be shown so the denominator is honest:

| # | id | label | begins | ends |
|---|---|---|---|---|
| 1 | `ffmpeg` | `Resolving ffmpeg` | before `describeFfmpegResolution()` | after it returns |
| 2 | `recovery` | `Checking for recovered work` | at `registerProjectIpc(ipcMain)` | when the launch scan settles |
| 3 | `editor` | `Preparing the editor`, **or** `Opening beach.veproj` | at `createWindow()` | at the main window's `ready-to-show` |

Every one of these is a real piece of work that already exists:

- **`ffmpeg`** is `describeFfmpegResolution()`, two `accessSync` calls. It is typically under a
  millisecond and will therefore essentially never be shown — which is correct, and is the point.
- **`recovery`** is the launch scan in `electron/ipc/project.ts`, which is *already* started at
  registration and deliberately not awaited (`SAFETY.md` §2.7). It is `readdir` + N × `readFile` +
  `stat`. On a machine with no autosave directory it settles in under a millisecond; on one with a
  large snapshot from a long session it is real I/O. It is a phase whether or not it is slow.
- **`editor`** is `loadFile` → renderer boot → React mount → `ready-to-show`. This is the phase that
  is actually slow, and it is the one the splash exists for.

`recovery` is counted unconditionally rather than probed first, because the denominator has to be
known before the numerator moves and *whether the directory exists* is not knowable until the
`readdir` has already run. A phase that settles instantly simply never reaches
`SPLASH_STATUS_DELAY_MS` and is never named.

**The `editor` label is conditional on the launch's own argv.** `veprojFromArgv(process.argv)` is
already computed in `main.ts`; the one required change is to compute it **once, before
`createWindow()`**, into a `const launchProject`, and use it both for the splash label and for the
existing `requestOpen` call that follows. `path.basename(launchProject)` is the label. That is one
reordered line and it makes the splash say something specific and true on the launch where the user
most wants to know what is happening.

### The close, and every way out

```ts
/* electron/splash.ts */
/** Idempotent. destroy(), not close() — there is nothing to prompt about and a
 *  splash must never be able to refuse. Nulls the module ref. Safe on a window
 *  that was never shown, and safe to call twice. */
export function closeSplash(): void;
```

`closeSplash()` is called from **six** places, and the list is exhaustive on purpose:

1. the main window's `ready-to-show` — **before** `win.show()`, so the two never overlap;
2. the main window's `closed`;
3. `webContents.on('render-process-gone')`;
4. `app.on('before-quit')`;
5. the `SPLASH_MAX_MS` watchdog;
6. `maybeShow()` itself (§3.4), when it runs and finds the main window already ready — the splash is
   destroyed rather than shown, having never been composited.

**The watchdog is not belt-and-braces; it is the difference between a bug and a disaster.** The
splash is frameless, has no close button, is not in the taskbar, and cannot be focused. If
`loadFile` fails, or the renderer never reaches `ready-to-show`, a naive implementation leaves a
rectangle on the user's screen that they cannot get rid of without Task Manager. At `SPLASH_MAX_MS`
the splash is destroyed **and the main window is shown regardless** (`if (!win.isVisible())
win.show()`), which also fixes an exposure the current `main.ts` already has: today, a renderer that
never reaches `ready-to-show` leaves an invisible window and an app with no UI at all.

> **The `window-all-closed` hazard, named.** `app.on('window-all-closed')` fires when the last
> `BrowserWindow` is destroyed. **The splash is a BrowserWindow.** If the main window is closed while
> the splash is still alive, `window-all-closed` does not fire, `app.quit()` is never called, and the
> process stays alive with an invisible splash and no way back. Path 2 above closes it — the splash
> is destroyed *inside* the main window's `closed` handler, so both windows are gone by the time the
> handler returns and `window-all-closed` fires normally. §3.14 gate 4 measures this rather than
> assuming it.

**No taskbar ghost.** `skipTaskbar: true`, and `focusable: false` on win32 keeps it out of Alt-Tab as
well. Nothing on the splash is interactive, so a window that can never take focus loses nothing and
guarantees it can never steal the caret from whatever the user was typing in while the app launched.

## 3.5 The window

```ts
/* electron/splash.ts */
new BrowserWindow({
  width: 960,
  height: 560,
  show: false,              // §3.4 — shown by a timer, or never
  frame: false,
  transparent: true,        // the 10px card corners
  backgroundColor: '#00000000',
  resizable: false,
  movable: false,
  minimizable: false,
  maximizable: false,
  fullscreenable: false,
  focusable: false,         // never steals focus; also keeps it out of Alt-Tab on win32
  skipTaskbar: true,
  alwaysOnTop: false,       // see below
  hasShadow: false,         // see below
  center: true,
  title: 'Video Editor',    // if any tool enumerates it, it says the right thing
  webPreferences: {
    preload: path.join(__dirname, 'splash-preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    webSecurity: true,
    spellcheck: false,
    additionalArguments: [`${BUILD_ARG}${encodeURIComponent(JSON.stringify(appBuild()))}`],
  },
});
```

Three of those need their reasons on the record:

- **`alwaysOnTop: false`.** A splash that floats above every other application asserts that this
  launch is more important than what the user is currently doing. It is not. If they alt-tabbed away
  during launch, the splash goes behind with the rest of the app, and the editor window appears
  normally when it is ready.
- **`hasShadow: false`.** `DESIGN.md`'s Shadow Vocabulary permits a shadow on a genuinely floating
  layer, and a splash qualifies — but a native shadow on a *transparent* frameless window on Windows
  renders inconsistently (a rectangular shadow behind rounded corners, on some compositor settings).
  The card's 1 px `--border-structural` keyline is what separates it from the desktop, and §3.3
  measures that keyline against both a white and a dark background for exactly this reason.
- **`transparent: true` has a real, statable cost:** Chromium disables subpixel antialiasing on
  transparent windows, so all text on the splash renders with greyscale AA. On a near-black ground
  at 44 px and 13 px the difference is not perceptible in practice, and it is the price of the
  rounded card. It is recorded here so nobody spends an afternoon hunting a "font rendering bug".

**Loading.** `splash.loadFile(path.join(__dirname, '../../dist/splash.html'))` in a packaged build,
and `${VITE_DEV_SERVER_URL}/splash.html` under `npm run dev` — the same two-branch shape
`createWindow()` already uses, so the splash is reachable in development and can actually be worked
on.

## 3.6 How it is built

**A second Vite entry, not a hand-written HTML file.** `vite.config.ts` gains a second rollup input,
and — because the splash's CSP differs between `serve` and `build` (below) — its default export moves
to the function form so it can see `command`:

```ts
export default defineConfig(({ command }) => ({
  base: './',
  plugins: [react(), devMediaPlugin(), veSplashCsp(command)],
  /* …resolve, server, define: { __VE_VERSION__ } unchanged… */
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        splash: fileURLToPath(new URL('./splash.html', import.meta.url)),
      },
    },
  },
}));
```

Four things follow, and each of them is why this is worth a build-config change rather than a static
file:

1. **`src/splash/splash.css` is under `src/`, so `scripts/check-contract.mjs` already walks it.** A
   hardcoded colour on the splash fails the existing contract gate with no new rule written. This is
   the single strongest argument for this layout. (One rule *is* amended — the accent allowance for
   the 28 px mark. §1.12 gate 2 states it; nothing else about the checker moves.)
2. `tokens.css` is imported by the splash entry, so the splash uses the same token values as the app
   by construction rather than by a copied hex.
3. The two entries share emitted assets — Inter and JetBrains Mono are emitted once and referenced by
   both, so the splash costs no extra bytes in the installer. **This is only true because the splash
   entry imports the font packages itself**; see the import list below.
4. `base: './'` is already set, so both HTML files reference their assets relatively and
   `loadFile` works.

**Files:**

```
splash.html                    # root, beside index.html
src/splash/splash.ts           # the entry; the exact import list is below
src/splash/splash.css          # every splash-specific rule; contract-checked
src/splash/graphic.ts          # the 28px mark and the right-hand SVG (§3.8)
src/styles/type.css            # NEW — the six type utilities, moved out of base.css
src/styles/base.css            # loses those six rules, gains one @import
electron/splash.ts             # the window, the phases, the lifecycle
electron/splash-preload.ts     # ~25 lines, §3.10
```

### What the splash entry imports, exactly

```ts
/* src/splash/splash.ts */
import '../styles/tokens.css';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '../styles/type.css';
import './splash.css';
```

**Naming only `tokens.css` would ship a broken splash, in two ways at once.** The two webfonts are
`@import`ed by `src/styles/base.css`, not by `tokens.css` — so a splash that imports tokens alone
renders with no Inter and no JetBrains Mono, falls back to system-ui, and falsifies claim 3 above and
§3.7's whole `document.fonts.ready` race, which would then be racing nothing. And all six type
utilities live in `base.css` too, so `.type-numeric`, `.type-label` and `.type-body` — which §3.7's
layout table and the `Version 0.1.0` footer are built on — would resolve to nothing at all.

**Importing `base.css` unmodified is not the answer either.** It sets `body { background:
var(--surface-chrome) }`, which paints the whole 960 × 560 transparent window opaque and destroys the
rounded card that §3.5's `transparent: true` / `hasShadow: false` / keyline design exists to produce.
It also brings a reset, scrollbars and `#root` sizing the splash has no use for.

**So the six utilities move to their own file.** `src/styles/type.css` holds `.type-headline`,
`.type-title`, `.type-body`, `.type-label`, `.type-numeric` and `.type-numeric-sm` verbatim;
`base.css` gains `@import './type.css';` immediately after its two font imports and drops its own
copies. Nothing about the app changes — `@import` must precede other rules, so the utilities move to
the top of the emitted sheet, and they compete with nothing at their own specificity — and there is
still exactly **one** definition of `.type-numeric` in the project. `PLAN.md` §7.2's sentence
*"`base.css` ships six utility classes"* stays true: `base.css` still ships them, through one import.

**`splash.css` owns the transparency, and it must say so out loud:**

```css
/* Nothing from base.css reaches this window. The card IS the splash; the window
   around it must stay see-through or §3.5's rounded corners paint black. */
html,
body {
  margin: 0;
  height: 100%;
  background: transparent;
}
```

§3.14 gate 1's visual check includes it: screenshot the splash over a light desktop and a dark one
and confirm the corners are the desktop, not a black square.

### `splash.html` and its CSP

`splash.html` carries `data-theme="signal"` on `<html>` (§3.3) and a **tighter** CSP than
`index.html`, because the splash needs strictly less — but the policy is **environment-dependent**,
for the same reason the loader is:

```html
<meta http-equiv="Content-Security-Policy" content="%VE_SPLASH_CSP%" />
```

```ts
/* vite.config.ts — a ~10-line plugin beside devMediaPlugin() */
const PROD_CSP =
  "default-src 'self'; connect-src 'none'; img-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:;";
const DEV_CSP =
  "default-src 'self'; connect-src 'self' ws://localhost:5173 http://localhost:5173; " +
  "img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
  "script-src 'self' 'unsafe-inline'; font-src 'self' data:;";

function veSplashCsp(command: 'build' | 'serve') {
  return {
    name: 've-splash-csp',
    transformIndexHtml(html: string, ctx: { path: string }) {
      if (!ctx.path.endsWith('splash.html')) return html;
      return html.replace('%VE_SPLASH_CSP%', command === 'build' ? PROD_CSP : DEV_CSP);
    },
  };
}
```

**Why the production policy cannot simply be used in development.** `@vitejs/plugin-react` is applied
to *every* HTML entry (`vite.config.ts` line 82), and it injects an **inline** react-refresh preamble
module into each one; Vite's client then opens an HMR WebSocket. `script-src 'self'` blocks the
preamble and `connect-src 'none'` blocks the socket, so under `npm run dev` the splash console fills
with CSP violations and the page cannot hot-reload — which falsifies §3.5's stated reason for the
two-branch loader, *"so the splash is reachable in development and can actually be worked on"*.

`connect-src 'none'` in production is the notable one: the splash makes no network request, ever, and
saying so in the header means it cannot start making one by accident. `script-src` drops
`'unsafe-inline'` because the built splash has no inline script. **The production policy is the one
that ships and the one §1.12 and §3.14 verify** — check it by reading `dist/splash.html`, not the dev
server's response.

**No React on the splash.** It is a handful of DOM nodes and one subscription. Pulling React,
ReactDOM and the store into a window whose entire job is to appear quickly would be the opposite of
the point. `src/splash/splash.ts` is plain TypeScript against `document`.

## 3.7 The card — layout and copy

960 × 560. `overflow: hidden`, `border-radius: var(--radius-lg)` (10 px), `border: 1px solid
var(--border-structural)`, `background: var(--surface-well)` edge to edge — one plane, because the
splash *is* the well: the surround behind the frame, and the frame is what is lit.

10 px is the largest radius token in the system, and the reference's larger corner is one of the
styling decisions being declined. A bigger radius here would be a geometry value that exists nowhere
else in the application.

Layout variables are declared **local to the splash**, following the precedent `.shell-body` already
sets (`PLAN.md` §8.2 — *"Local layout variables… Not colours, not `:root`."*):

```css
.ve-splash { --splash-pad: 32px; --splash-gap: 56px; --splash-col: 384px; }
```

The two columns are separated by a 1 px `--border-structural` vertical rule at x = 384 — the same
carrier `PLAN.md` §7.5 mandates for every major-region boundary in the app, used here for the same
job.

### Left column, top to bottom (content width 328 px)

| | Element | Type | Token | Height |
|---|---|---|---|---|
| 32 px pad | | | | |
| 1 | app mark, §3.8 | — | — | 28 |
| 56 px | | | | |
| 2 | `Video` | `--type-wordmark-size` / **400** / 1.05 / −0.02em | `--text-on-well` | 46 |
| 3 | `Editor` | same size / **600** | `--text-on-well` | 46 |
| 20 px | | | | |
| 4 | `Open it and start cutting.` | body, 600 | `--text-on-well` | 19 |
| 5 | `Full timeline editing. No accounts, no cloud.` | body, 400 | `--text-on-well-muted` | 19 |
| *flex spacer, ≈ 204 px* | | | | |
| 6 | status line, §3.9 — **reserved height, may be empty** | label | — | **34** |
| 24 px | | | | |
| 7 | `© 2026` | label | `--text-on-well-muted` | 14 |
| 8 | `Version` + `0.1.0` | label + `.type-numeric` | `--text-on-well-muted` | 16 |
| 32 px pad | | | | |

**Row 6's height is reserved unconditionally.** The status line appears 400 ms into a phase; if its
block collapsed when empty, the footer and the wordmark would move at that instant. A splash whose
layout twitches while you look at it is worse than one with no status at all.

**The wordmark needs three new tokens, and only three.** `DESIGN.md`'s type scale tops out at 18 px
because it is scaled for a dense instrument; a 44 px wordmark is identity typography, not UI
typography, and pretending otherwise by rendering it at 18 px would produce a splash that looks like
a tooltip. Declaring it as tokens rather than as literals keeps it visible, singular and
contract-checked. They go in `tokens.css`'s **theme-invariant** block, beside the rest of the type
scale, because type is theme-invariant by the Palette-Only Rule:

```css
  /* The splash wordmark, and nothing else. docs/RELEASE.md §3.7. */
  --type-wordmark-size: 44px;
  --type-wordmark-line: 1.05;
  --type-wordmark-track: -0.02em;
```

Weights are **400 and 600** — the reference's light/bold contrast, rendered inside this system's
ceiling (`DESIGN.md`: *"no weight above 600"*, *"no second sans family"*). Inter Variable carries
both.

**Copy.** Every string is the product's own voice, sentence case, no exclamation marks, no
encouragement (`PRODUCT.md`, Brand Personality). *"Open it and start cutting."* is lifted verbatim
from `PRODUCT.md`'s Product Purpose. *"Full timeline editing. No accounts, no cloud."* is principle 5
stated as a fact rather than as a sales point. The footer is `© 2026`, matching
`electron-builder.yml`'s `copyright` field — **not** "All rights reserved", which is corporate
ceremony in a tool that answers to one person.

### Fonts, and the one flash worth preventing

The splash is on screen for 250–1200 ms. A webfont swapping in at 400 ms would resize the wordmark
while the user is looking at it — visible motion at rest, which `PRODUCT.md` forbids outright.

`src/splash/splash.ts` therefore does this before telling main it is ready:

```ts
await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 120))]);
api.ready();
```

The 120 ms race is a ceiling, not a delay: fonts that are already in Chromium's cache resolve in
single-digit milliseconds, and a cold first launch is capped rather than blocked.

`api.ready()` sends `splash:ready`, which is **condition 2 of §3.4's show rule** — the single place
the show condition is stated. The splash window's own `ready-to-show` is not the signal; it only
starts the `SPLASH_READY_FALLBACK_MS` clock that keeps a broken splash renderer from holding the
launch. §3.4 is normative here; this section only says what the splash does before it reports ready.

Belt and braces: rows 2–3 sit in a **fixed 92 px block**, so even if a substitution happens, the
metrics change inside a box that does not, and nothing below moves.

## 3.8 The graphics

### The mark, top-left, 28 × 28

Inline SVG, three elements in paint order, structurally identical to `ICON.md` §3: the tile, the
lanes, the cut. **Three lanes**, not the 32 px ladder's one — 28 px of *vector* is not 28 px of
bitmap, and the three-lane form is the mark's full statement.

It is drawn in `--accent`, exactly as the taskbar icon is, because it **is** the taskbar icon. That
requires a scoping amendment rather than a silent exception: `ICON.md` §2 already fenced the accent
budget away from the OS icons, and §3.13 extends that fence, in `DESIGN.md` and `PLAN.md` §7.4, by
one clause to cover the mark's reproduction at identity scale (≤ 32 px). That is the **only**
accent in the entire splash, it is bounded by a number, and it is checkable.

**Checkable means one file.** The `var(--accent)` read lives in `src/splash/graphic.ts` and nowhere
else — not in `splash.css`, not in `splash.ts`. §1.12 gate 2's amendment to
`scripts/check-contract.mjs` allows exactly that path, so the machine enforces the same fence the
documents describe: the mark may spend the accent, and the rest of the splash still fails the build
if it so much as names it.

The alternative — drawing the mark in `--text-on-well` — was rejected: it would put a second white
object on a card whose entire argument is that exactly one thing is lit, and it would make the
product's own mark unrecognisable against the icon the user just clicked.

### The right panel — "the bench"

Inline SVG, `viewBox="0 0 575 560"`, `preserveAspectRatio="xMidYMid slice"`, bleeding to the card's
top, right and bottom edges and clipped by the card's `overflow: hidden`.

**Six lanes, forty-one clips, one cut, one lit clip.**

```
pitch      94        (6 × 94 = 564, bleeding 2px top and bottom)
lane h     60        (0.64 × pitch)
lane gap   34
clip r     3         (--radius-clip; clips abut, so a large radius reads as a cut — DESIGN.md §5)
lane y     -2, 92, 186, 280, 374, 468
cut        x 236, width 26          fill --surface-well, painted OVER the clips
```

Clip spans, `[x, width]` in viewBox px. Authored, fixed, and **not** randomised — a splash that
differs between launches is decoration, and this one is a diagram.

| lane | y | clips |
|---|---|---|
| 1 | −2 | `[-20,96] [84,72] [164,48] [220,64] [292,148] [448,64] [520,96]` |
| 2 | 92 | `[-20,56] [44,160] [212,88] [308,52] [368,112] [488,76] [572,48]` |
| 3 | 186 | `[-20,140] [128,64]` **`[200,148]`** `[356,72] [436,56] [500,64] [572,48]` |
| 4 | 280 | `[-20,72] [60,100] [168,120] [300,88] [400,56] [468,64] [544,72]` |
| 5 | 374 | `[-20,108] [96,56] [160,128] [296,68] [372,96] [476,52] [536,80]` |
| 6 | 468 | `[-20,84] [72,136] [216,60] [284,92] [384,120] [512,104]` |

7 + 7 + 7 + 7 + 7 + 6 = **41 clips across 6 lanes** — the density `PRODUCT.md` principle 4 names, and
the same count as the `dev:web` fixture project, which is the timeline this app is actually developed
against.

**The lit clip is lane 3, `[200,148]`, in `--text-on-well`.** Every other clip is
`--border-structural`. It is vertically central, horizontally left-of-centre where the eye lands
first, and **it is crossed by the cut** — which is not a preference but the reason the cut is
legible: the cut is a `--surface-well` void, so it reads at 18.3 : 1 through the lit clip and at
4.80 : 1 through the dim ones. The lit clip is what makes the cut visible, and the cut is what makes
the image a non-linear editor rather than a bar chart.

**Two constraints inherited verbatim from `ICON.md` §2, and satisfied:**

1. *The cut must intersect every lane, with material on both sides.* Measured remnants against the
   cut span `[236, 262]`, left / right in px:

   | lane | clip | left | right |
   |---|---|---|---|
   | 1 | `[220,64]` | 16 | 22 |
   | 2 | `[212,88]` | 24 | 38 |
   | 3 | `[200,148]` | 36 | 86 |
   | 4 | `[168,120]` | 68 | 26 |
   | 5 | `[160,128]` | 76 | 26 |
   | 6 | `[216,60]` | 20 | 14 |

   Minimum 14 px against `ICON.md`'s floor of 3. Ample.

2. *The cut must be wider than the gap between lanes*, or it reads as the gutter of a grid rather
   than as a channel. Lane gap 34, cut 26 — **this one does not hold, and it does not need to.**
   `ICON.md`'s constraint exists because at 16–256 px the cut and the gaps are the only two negative
   spaces and the eye cannot tell a narrow vertical one from a wide horizontal one. At 575 px the cut
   is a 26 px continuous channel running 564 px top to bottom, unbroken, while the gaps are 34 px
   bands running only 575 px across a field whose clips are of every length; the channel's
   *continuity* carries it, which is a signal the 16 px icon cannot use. This is a deliberate,
   reasoned departure and §3.14 gate 1 is a visual check on it: if the contact sheet reads as a grid,
   widen the cut to 44 and re-check the remnant table.

**No lane rules.** `PLAN.md` §7.5 puts a 1 px `--border-structural` boundary on every track lane in
the app — here the *clips themselves* are `--border-structural`, so a rule of the same colour would
merge with them and turn six lanes into six solid bands. The clips are the structure.

**No playhead.** A playhead is `--accent` (`PLAN.md` §7.4, use 1) and the splash spends no accent
beyond the 28 px mark. The cut says the same thing without spending it.

## 3.9 The status line, which must not lie

Two rules govern this section, and they are the reason it is short.

> **If startup is instant, show no status.** A status line that says something in order to have
> something to say is worse than an empty space.
>
> **A progress rule not driven by real progress is a lie.** No indeterminate shimmer, no timed
> sweep, no "almost there".

### The status text

Rendered **only** when the current phase has been in flight for ≥ `SPLASH_STATUS_DELAY_MS` (400 ms).
Before that, and between phases, the reserved 34 px block is empty. On the overwhelmingly common
launch this means the splash carries **no status at all** — identity, footer, graphic, and nothing
else — because `ffmpeg` and `recovery` both settle in under a millisecond and `editor` may finish
before 400 ms.

Layout: a 6 px dot, `--space-md` gap, then the label in **label type** (11 px / 500) in
`--text-on-well`. The dot is `--text-on-well-muted`, filled, no ring, **no pulse** — it is a bullet
that says "this line is a status", not an animation. The reference's dot is amber; this one is not,
because the accent budget is closed.

### The phase rule

Directly below, 12 px down, spanning the full 328 px column: a **1 px** rule.

- track: `--border-hairline` — a decorative region marker, which is exactly what `PLAN.md` §7.5 says
  that token is for, and the one place in this design where the sub-3:1 hairline is correct.
- fill: `--text-on-well-muted`, width `done / total × 328 px`.

`total` is 3, decided before the splash can be shown (§3.4). `done` is the number of phases that have
settled. **It is a step counter, and the document says so out loud:** it measures phases completed,
not bytes and not time. The three phases have wildly unequal durations, so the rule does not advance
smoothly — it sits at 2/3 for most of a visible splash and then the splash is gone. That is honest,
and it is the only kind of progress this launch actually has.

The rule appears and disappears with the status text, on the same 400 ms gate. Neither is ever drawn
alone: a fill with no label is a bar with no meaning, and a label with no fill loses the one piece of
structure that says how much is left.

### What it says

| Phase | Label | Reachable when |
|---|---|---|
| `ffmpeg` | `Resolving ffmpeg` | a slow or unavailable network path in `VE_FFMPEG_DIR`; essentially never otherwise |
| `recovery` | `Checking for recovered work` | a large snapshot from a long session, or a slow disk |
| `editor` | `Preparing the editor` | the common slow case |
| `editor` | `Opening beach.veproj` | the launch came from a double-clicked `.veproj` (§3.4) |

Every one names work that is genuinely in flight at the moment it is on screen. There is no
`Loading…`, no `Starting up`, and no `Checking license` — this application has no license to check,
and the reference's own status line is the clearest example of the thing to *not* copy.

## 3.10 The contract

```ts
/* src/types/api.ts */

/** What main pushes to the splash. `label: null` means draw nothing at all. */
export interface SplashStatus {
  label: string | null;
  /** Phases settled so far. */
  done: number;
  /** Phases this launch will run. Fixed before the splash can be shown (§3.4). */
  total: number;
}

/** Exposed on the SPLASH window only, by electron/splash-preload.ts.
 *  It is deliberately NOT part of EditorAPI: the splash gets the smallest
 *  surface that does its job, and the editor's bridge has no business being
 *  reachable from a window with no user in it. */
export interface SplashAPI {
  build: AppBuild;
  onStatus(cb: (s: SplashStatus) => void): () => void;
  /** The splash telling main it has painted and its fonts have settled (§3.7).
   *  This is condition 2 of §3.4's show rule — not the splash window's own
   *  ready-to-show, which is only that condition's timed fallback. */
  ready(): void;
}
```

```ts
/* src/types/api.ts — added to CH */
  splashStatus: 'splash:status',   // main -> splash, send
  splashReady:  'splash:ready',    // splash -> main, send
```

```ts
/* declare global — beside Window.editorAPI */
interface Window { splashAPI?: SplashAPI; }
```

```ts
/* electron/splash.ts — the surface main.ts uses */
export function createSplash(launchProjectName: string | null): void;
export function beginPhase(id: 'ffmpeg' | 'recovery' | 'editor'): void;
export function endPhase(id: 'ffmpeg' | 'recovery' | 'editor'): void;
export function closeSplash(): void;
```

`beginPhase` / `endPhase` are no-ops when no splash exists, so `main.ts` calls them unconditionally
and never branches on whether a splash is up.

### One cross-area requirement

`electron/ipc/project.ts` starts the launch scan inside `registerProjectIpc` as a local
`const scan = scanAutosaveDir().catch(() => null)`. The `recovery` phase needs to know when that
settles. **One export, and the promise is hoisted to module scope:**

```ts
/* electron/ipc/project.ts */
/** Resolves when the launch scan (SAFETY §2.7) has settled, whatever it found.
 *  Never rejects. Resolves immediately when called after it has already settled,
 *  and immediately when registerProjectIpc has not run. */
export function whenRecoveryScanSettled(): Promise<void>;
```

Nothing else in that file changes, the scan's existing timing and semantics are untouched, and the
handler keeps returning the same promise it returns today.

## 3.11 Accessibility, stated rather than claimed

**Motion: there is none.** No transition, no animation, no `@keyframes`, no fade-in of the card, no
crossfade on the status text, no easing on the phase rule — it jumps from 1/3 to 2/3 instantly.
Under `prefers-reduced-motion: reduce` **nothing differs**, because there is nothing to reduce, and
that is the strongest form the requirement can take. It is a gate, not a promise: §1.12 gate 1.6
asserts that `src/splash/splash.css` declares no `transition`, no `animation` and no `@keyframes`.
That gate strips comments before it matches, which is not pedantry — the sentence you are reading
belongs in that file's header, and a gate that matched bare words would fail the build on its own
justification.

**Contrast:** every pair in §3.3, all above their floor, all separated by lightness.

**Colour-blindness:** the splash contains one hue (the 28 px mark's amber) and it carries no
information. Desaturate the entire splash and every element remains exactly as legible.

**Screen readers — the honest answer.** The splash is a non-focusable, `skipTaskbar` window that
never takes focus. Narrator and NVDA do not reliably announce such a window, and a `role="status"`
live region inside one that has never been focused is a live region nobody is subscribed to. So:

> **A screen-reader user hears nothing during launch. That is exactly what they hear today, and the
> splash does not make it worse.** The first thing announced is the editor window, when it appears
> and takes focus, exactly as it is announced now.

The alternative — making the splash focusable so it can announce — was rejected because a window that
takes focus for 400 ms and then vanishes moves the reading cursor twice and interrupts whatever the
user was doing in another application while this one launched. Silence is better than that.

**Deliberately out of scope, and named:** for a pathological launch (`editor` still in flight after
several seconds) the splash could un-set `skipTaskbar` and set its window title to the current status
label, which is the one string assistive technology reads from a window without focusing it. It is
specified here so it is not re-invented, and it is **not** in v1, because it trades the simple,
absolute guarantee "the splash is never in the taskbar" for a case the `SPLASH_MAX_MS` watchdog
already bounds.

## 3.12 The theme escape hatch, out of scope

If the splash is ever required to follow the user's theme, this is the whole of it, and it is
recorded so the decision does not have to be re-derived:

1. `electron/ipc/project.ts` (or a new `electron/ipc/shell.ts`) gains a fire-and-forget
   `CH.appThemeChanged` receiver that writes `{ theme }` to
   `path.join(app.getPath('userData'), 'shell.json')`, atomically, on every `setTheme`.
2. `electron/splash.ts` reads that file synchronously at `createSplash()`, falling back to `signal`.
3. The value is appended to the splash URL as `?theme=instrument`, and `src/splash/splash.ts` writes
   it to `document.documentElement.dataset.theme`.

It is out of scope for v1 because it is a new persistence path, a new channel and a new failure mode,
bought for a difference in surround that lasts less than a second and that §3.3's mitigation already
softens.

## 3.13 The exact edits to `PRODUCT.md`, `DESIGN.md` and `PLAN.md`

The splash is not permitted to exist alongside documents that say it does not. **Five** edits, all
small, all of which make the documents *more* specific rather than weaker.

### 1. `DESIGN.md` §5, Motion

The sentence:

> No bounce, no elastic, no orchestrated load sequence: the app opens directly into the task.

becomes:

> No bounce, no elastic, no orchestrated load sequence: the app opens directly into the task. The
> start-up splash is not an exception to this — it does not animate at all, and on a launch fast
> enough to open directly into the task it is never shown. See docs/RELEASE.md §3.

### 2. `DESIGN.md` §6, Don'ts

The bullet:

> - **Don't** animate an entrance sequence on launch. The app opens into the task.

becomes:

> - **Don't** animate an entrance sequence on launch. The app opens into the task. The start-up
>   splash carries no transition, no animation and no `@keyframes` — a gate asserts it
>   (docs/RELEASE.md §3.11) — and it is never held open for effect.

### 3. `DESIGN.md`, the Three Uses Rule

The sentence added by `ICON.md` §10:

> This governs rendered interface surfaces only; the OS application icon and the `.veproj` document
> icon are specified in docs/ICON.md §2.

gains one clause:

> …are specified in docs/ICON.md §2, as is the application mark's reproduction at identity scale
> (≤ 32 px), which appears in exactly one rendered surface: the start-up splash (docs/RELEASE.md
> §3.8).

The same clause is appended to **`docs/PLAN.md` §7.4**, to the paragraph that already carries
`ICON.md`'s scoping sentence. Both documents, not just the one that benefits.

**`scripts/check-contract.mjs` is amended in this same change**, with the one `ACCENT_ALLOWED` entry
§1.12 gate 2 specifies. A scoping clause written into two documents while the machine that enforces
the budget still says no is a rule that exists twice on paper and nowhere in the build.

### 4. `PRODUCT.md`, Design Principles — principle 2

`PRODUCT.md` contains no sentence that a splash contradicts, so nothing is retracted. What it lacks
is the principle that makes the splash's constraints *binding* rather than a matter of taste. Append
to principle 2, **Depth on demand**:

> The same rule governs launch. The application shows nothing before the editing loop that it has
> not been forced to: the start-up splash appears only when the machine has already made the launch
> slow, closes the instant the editor is ready, and is never held open to be looked at. If the app
> can open directly into the task, it does, and the splash is never drawn.

That sentence is what §3.4's constants implement, and it is what makes a future "let's hold it for
1.5 seconds so people see the logo" a violation rather than a preference.

### 5. `docs/PLAN.md` §7.2, Type

§3.7 adds `--type-wordmark-size`, `--type-wordmark-line` and `--type-wordmark-track` to `tokens.css`'s
theme-invariant block. **`PLAN.md` §8.2 declares §7 to be the complete list** — *"§7 is the complete
list. No slice adds a custom property to `:root`"* — so three tokens landing in `:root` with no entry
in the document that claims to be exhaustive would break the one contract §8.2 exists to hold. It is
not enough that the tokens are justified; the register has to be right, or the next person greps §7,
does not find them, and reports them as drift.

The three rows are appended to §7.2's type scale, below `--type-numeric-*`, with the scope stated on
the line so nobody reaches for them in the app:

```
--type-wordmark-size 44px  --type-wordmark-line 1.05  --type-wordmark-track -0.02em
```

> Identity typography, not UI typography: the type scale tops out at 18 px because it is scaled for a
> dense instrument. These three are used by exactly one surface — the start-up splash's wordmark
> (docs/RELEASE.md §3.7) — and by nothing in the editor. There is no `.type-wordmark` utility class,
> deliberately: one rule in `src/splash/splash.css` reads them, and a seventh utility in `base.css`
> would invite a second caller.

## 3.14 Verification

**Gate 1 — the graphic and the card, by eye.** `src/splash/splash.ts` gains a `?proof` query parameter
(dev only) that renders the right-hand panel alone at 1× and at 2×, saved with `cdp-shot.mjs`. Look
for two things and only two: does the cut read as one continuous channel or as the gutter of a grid
(§3.8's departure from `ICON.md`'s width constraint), and is the lit clip unmistakably the only lit
thing.

Then one check on the whole window, which the proof view cannot show: launch the splash over a
**white** desktop background and over a **dark** one and screenshot each. The four corners must be
the desktop, not black. Black corners mean `splash.css`'s `html, body { background: transparent }`
(§3.6) is missing or has been overridden, and it is the single most likely way the card design in
§3.5 and §3.7 gets silently undone.

**Gate 2 — `SPLASH_SHOW_DELAY_MS` is measured, not assumed.** On the **installed** build at
`E:/Video Editor`, instrument `whenReady()` and the main window's `ready-to-show` with
`Date.now()` and log the delta to a file in `userData`. Ten cold launches (reboot between) and ten
warm. If the warm median is under 250 ms, raise the constant until the splash does not appear on a
warm start; if the cold median is over 900 ms, 250 ms is right and no change is needed. This is a
manual step and it is the only way the number can be correct.

**Gate 3 — no flash.** Launch the installed app twenty times warm. The splash must appear zero times
on any launch whose `ready-to-show` beat `SPLASH_SHOW_DELAY_MS`, and it must never be visible for
less than roughly 80 ms on any launch where it does appear. A splash that blinks is the failure this
design is built to avoid.

**Gate 4 — the splash never outlives anything.** Six assertions, each corresponding to one entry in
§3.4's close list:

1. Normal launch → the splash is gone **before** the editor window is visible; never both on screen.
2. Close the editor window while the splash is somehow still up (force it by pausing the renderer in
   DevTools) → the splash is destroyed, `window-all-closed` fires, `app.quit()` runs, and
   `Video Editor.exe` leaves Task Manager. **This is the §3.4 hazard and it must be measured.**
3. Crash the renderer during launch → the splash is destroyed and the watchdog shows the main window.
4. `SPLASH_MAX_MS` → break `loadFile` (rename `dist/index.html`), launch, and assert that at 20 s the
   splash disappears and the main window is shown.
5. Task Manager shows exactly one `Video Editor.exe` tree after every one of the above.
6. The splash never appears in the taskbar or in Alt-Tab, at any point, in any of the above.

**Gate 5 — the status line tells the truth.** Set `VE_FFMPEG_DIR` to a path on a disconnected network
share and launch: the splash must show `Resolving ffmpeg` and the rule at 0/3. Restore it, plant a
large snapshot in `%APPDATA%\Video Editor\autosave\`, and launch: `Checking for recovered work`, rule
at 1/3. Launch by double-clicking a `.veproj`: `Opening <name>.veproj`. In each case, assert by
screenshot that the label matches the work actually in flight — and on a normal launch, assert that
**no status line is drawn at all**.

**Gate 6 — `npm run contract` and `npm run check` pass**, covering the splash's tokens, its theme
parity and its absence of animation. Two amendments ship with this feature and both must be in place
before the gate means anything: `scripts/check-contract.mjs` gains the single `ACCENT_ALLOWED` entry
for `src/splash/graphic.ts` (§1.12 gate 2, §3.13), and `scripts/check-release.mjs` gains the two
comment-stripping splash assertions (§1.12 gate 1.6). The checker is **amended, not unchanged** —
running the old checker against the new splash fails on the 28 px mark, and that failure is correct
until the §3.13 edits land beside it.

Also read `dist/splash.html` after `npm run build` and confirm it carries the **production** CSP from
§3.6 — `connect-src 'none'`, `script-src 'self'`, no `%VE_SPLASH_CSP%` placeholder left behind. The
dev policy is deliberately looser and must never be the one that ships.

**Gate 7 — the version agrees with itself.** In the installed build: the application menu's
`Copy version` row, the splash footer, and `dist-release/latest.yml`'s `version` field must all read
the same string, and it must equal `package.json`'s. Three surfaces, one number, checked by eye
once per release because it is the number every bug report is anchored to.
