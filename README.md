# Video Editor

A desktop video editor for one person. Multi-track timeline, keyboard-driven editing, ffmpeg
export. No accounts, no cloud, no telemetry, no project that lives anywhere but on your disk.

It is built as a tool, not as a product to sell: there is no onboarding, no upsell and nothing to
sign in to. The chrome stays dark and quiet so the frame is the only lit thing on screen.

![The editor with a five-source cut open: media rail, preview, inspector, and four timeline tracks](docs/screenshot.png)

## What it does

- Import video and audio; ffprobe reads duration, size, rate and codec, ffmpeg extracts a poster
  frame. Anything Chromium cannot decode is refused on the row that failed, with the reason.
- Multi-track timeline with drag, trim, split, ripple delete, snapping, markers and 100 steps of
  undo.
- Preview with real transport: play/pause, J-K-L shuttle, frame stepping, in and out points.
- Per-clip transform (scale, position, rotation, opacity), speed and volume in the inspector.
- Rename a source file on disk, from the media rail's context menu or the inspector's `Name`
  field. The extension is preserved, and every clip cut from the file keeps playing from it — clips
  reference media by id, so nothing goes offline. A clip's own label on the timeline is a separate,
  display-only name and is left alone, so one gesture only ever does one thing.
- Detach a clip's audio onto its own track — `Shift+D`, or the clip's context menu. The picture
  keeps its place and goes silent, the sound lands beside it, and the two stay **linked**: selecting
  either selects both, and every move, trim, split and delete applies to the pair in one undo step.
  Link any two or more clips with `Ctrl+L`, break a group with `Ctrl+Shift+L`. A linked clip carries
  a rule along its bottom edge.
- Export to H.264, H.265 or ProRes at a chosen size, rate and quality, over the whole timeline or
  the in–out range. Or export the mix alone as AAC, MP3 or WAV, through the same verified audio
  chain — the resolution and frame rate rows leave the form rather than greying out. One ffmpeg
  process, real progress, working cancel.
- Projects save as `.veproj` — plain JSON you can read, diff and keep in version control. An
  installed build owns the extension, so double-clicking one opens it in the running window.
- Closing with unsaved changes stops and asks — save, do not save, or cancel — and so does opening
  another project over one, whether it arrives by `Ctrl+O` or from a double-clicked `.veproj`.
  Cancel genuinely cancels, and a save that needs a filename gets one before the window goes.
- Three themes — `signal`, `instrument`, `daylight` — from the `…` menu in the title bar. Every
  palette is contrast-verified and none of them encodes state in hue alone.

## Running it

Requires Node 20+ and, for development, ffmpeg and ffprobe on `PATH`. A packaged build carries its
own copy and needs neither.

```
npm install
npm run dev          # vite + the real Electron app
```

Other entry points:

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server plus Electron. The real main process: real files, real ffmpeg. |
| `npm run dev:web` | Browser only, no main process. Loads fixtures so the UI can be worked on without Electron. Import, save and export are stubs there. |
| `npm run build` | Typecheck, build the renderer, compile the main process. |
| `npm start` | Run the built app without packaging it. |
| `npm run typecheck` | Both tsconfigs, no emit. |
| `npm run contract` | The design-contract checker: hardcoded colours, undefined tokens, missing theme values, removed focus rings, accent budget. |
| `npm run fixtures:media` | Rebuild `dev-media/` — synthetic clips to edit against. Needs ffmpeg. |

`dev-media/` is gitignored, so a clean checkout has none of it: run `npm run fixtures:media`
once and every file appears. The command rebuilds all nine from scratch on every run rather
than skipping what already exists, so a stale fixture cannot survive a regeneration, and the
encodes are bit-exact — two runs produce byte-identical files.

Each fixture carries **audible, identifiable audio**, which is the only reason any claim about
the mixer can be checked. The six video clips are steady sine tones at 300, 500, 700, 1100,
1300 and 1700 Hz — distinct primes × 100, so no clip's tone is a harmonic of another and a mix
can be taken apart by frequency. The three audio files differ in shape as well as pitch: brown
noise for the room tone, an A minor chord under a tremolo for the music bed, and 850 Hz in
syllable-shaped bursts for the voice-over. `scripts/make-dev-media.mjs` documents every
signature and the exact ffmpeg command that reads one back, then measures what it just wrote
and fails if anything comes back near silence.

### If Electron will not start

`npm install` can leave `node_modules/electron` without its `path.txt` when the postinstall
download fails, and it fails **silently** — the install reports success and `npm start` then dies
with an unhelpful error. This has already happened once in this repo. The fix:

```
node node_modules/electron/install.js
```

## Keyboard

`Ctrl` is the platform accelerator: it is Cmd on macOS and Ctrl everywhere else. Every binding
below is generated from `src/keyboard/shortcuts.ts` by `npm run readme:keymap`, which is the same
registry the tooltips and the in-app overlay read — press `?` in the app for the same list.

Scope is focus containment, not hover: a timeline binding fires only while focus is inside the
timeline, which is why `Delete` in the media rail cannot remove a clip. Text fields and focused
buttons keep their own keys.

<!-- BEGIN KEYMAP: generated by scripts/gen-keymap.mjs — do not edit -->

**Anywhere**

| Keys | Action |
| --- | --- |
| `Space` | Play or pause |
| `J` | Shuttle backward |
| `K` | Stop shuttle |
| `L` | Shuttle forward |
| `Left` | Step back one frame |
| `Right` | Step forward one frame |
| `Shift+Left` | Step back one second |
| `Shift+Right` | Step forward one second |
| `Home` | Go to start |
| `End` | Go to end |
| `I` | Mark in |
| `O` | Mark out |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` | Redo |
| `Escape` | Clear selection |
| `Ctrl+I` | Import media |
| `Ctrl+S` | Save project |
| `Ctrl+O` | Open project |
| `Ctrl+E` | Export |
| `?` | Show keyboard shortcuts |

**Timeline**

| Keys | Action |
| --- | --- |
| `S` | Split at playhead |
| `Delete` | Lift selection |
| `Shift+Delete` | Ripple delete selection |
| `M` | Add marker at playhead |
| `Shift+D` | Detach audio |
| `Ctrl+L` | Link selected clips |
| `Ctrl+Shift+L` | Unlink selected clips |
| `+` or `=` | Zoom in |
| `-` | Zoom out |
| `Shift+Z` | Zoom to fit |

<!-- END KEYMAP -->

## Packaging

```
npm run dist
```

Produces, in `dist-release/`:

| Artifact | Size |
| --- | --- |
| `Video Editor 0.1.0 Setup.exe` | ~136 MB — NSIS installer, per-user, no administrator needed |
| `Video Editor 0.1.0 Portable.exe` | ~136 MB — runs without installing |
| `win-unpacked/` | ~463 MB — the installed layout, useful for testing |

The target is Windows x64. Configuration is in [`electron-builder.yml`](electron-builder.yml), and
every non-default setting there carries its reason.

The installer claims the `.veproj` extension, which is the only way the OS ever hands a project to
the app. `npm start` and `npm run dev` do not register anything, so from a checkout the same path is
reached by passing the file on the command line: `npm start -- "path/to/project.veproj"`. Either
way a second launch does not open a second window — the single-instance lock hands the path to the
window already open.

Two things happen before the packager runs. `npm run icon` redraws **both marks** — the application
icon and the `.veproj` document icon — from the palette in `src/styles/tokens.css`, so neither can
drift from the theme, and writes `build/icon.png`, `build/icon.ico` and `build/veproj.ico`. Each
`.ico` carries seven separately authored sizes rather than one image scaled down, so the 16 px
Explorer entry is drawn for 16 px instead of being a blurred 256. The script then reads both files
back and measures them — entry table, payload formats, and the contrast of each mark against a
light and a dark Explorer background — and exits non-zero if anything fails. `npm run
stage:ffmpeg` copies ffmpeg and ffprobe into `build/ffmpeg/` — see below.

**The installer is not code-signed.** There is no certificate, so Windows SmartScreen will say
"Windows protected your PC" the first time you run it; *More info → Run anyway*. Signing it means
buying a certificate and adding `win.certificateFile` to the config. Nothing else has to change.

Two consequences worth knowing before that changes. **SmartScreen reputation accrues to a publisher
certificate, not to a filename or a URL** — with no certificate there is no publisher, so no
reputation ever accumulates and version 0.9.0 is warned about exactly as loudly as 0.1.0 was. If
updates are ever switched on, that warning arrives on *every* version rather than once. And **the
only integrity check on an update is the sha512 published in `latest.yml`**: it proves the bytes
arrived intact, and nothing at all about who wrote them, because whoever can serve `latest.yml` can
serve a hash that matches whatever executable they also serve. The security of the update channel is
therefore exactly the security of the host and its TLS — which is why a generic feed over plain
`http://` is refused outright rather than warned about (docs/RELEASE.md §1.9).

## Updates

**This build ships with no update feed and therefore never contacts a server.** There is no
`publish:` target in `electron-builder.yml`, so the packaged app contains no
`resources/app-update.yml`, `electron-updater` is never even loaded, and the application menu has no
*Check for updates* item — because an item that always answers "you're up to date" on a build that
cannot update is a lie.

Configuring a feed is a single block in `electron-builder.yml`, documented in `docs/RELEASE.md` §1.2.
When one exists the app checks **ten minutes after launch and every six hours after that, never on
launch**, offers what it finds in a 32 px strip in the titlebar rather than a dialog, and **never
installs anything without a press** — the install goes out through the same unsaved-changes guard
the window's close button does, so *Cancel* on that dialog cancels the install too.

**There is no rollback.** Downgrades are disabled, so republishing an older release does nothing for
clients already on the newer one; the remedy for a bad release is a newer release.

**And the copy already installed can never receive one.** A build made with `publish: null` — the
0.1.0 at `E:/Video Editor` today included — has no `resources/app-update.yml`, so it can never be
updated no matter what is published later. The first version that carries a feed has to be installed
by hand, over the old one, with the NSIS installer; from that install onwards updates flow on their
own. This is the one thing that cannot be discovered from inside the application, because an app with
no update UI looks identical to an app that is up to date.

## ffmpeg

The app shells out to `ffmpeg` and `ffprobe`. It does not link them and does not depend on an npm
wrapper, which keeps the dependency list honest but leaves one question: where do the binaries come
from on a machine that is not this one?

**They ship with the app.** `scripts/stage-ffmpeg.mjs` copies both binaries into `build/ffmpeg/`,
electron-builder places them at `resources/ffmpeg/`, and `electron/ffmpeg.ts` resolves them at
runtime — bundled when packaged, `PATH` in development, `PATH` as the fallback in both.

That choice costs about 193 MB in the installer, which is most of its size. It was made anyway,
because the alternative is an installer that works on the machine that built it and fails on every
other one, and "install ffmpeg first" is not an installer. `PATH` remains a real fallback rather
than dead code: if the bundled copy is missing — a partial install, an antivirus quarantine, a
hand-assembled build — the app looks for a system ffmpeg before giving up, and only then reports
`ffmpeg-missing` on the affected row or in the export dialog.

Two details worth knowing:

- The staged binaries come from whatever is on the build machine's `PATH`, or from `FFMPEG_DIR` if
  you set it. There is no download step; a packaging script that needs the network fails on the
  machine that most needs it to work.
- **Licensing.** A typical Windows ffmpeg build (including the `gyan.dev` "essentials" build this
  was packaged against) is compiled with `--enable-gpl --enable-version3`. Shipping it means the
  distributed application is subject to GPLv3. That is fine for a personal tool; it is a real
  obligation if you redistribute. Build ffmpeg LGPL if you need to avoid it.

`npm run dist:nobundle` builds without ffmpeg: an 82 MB installer, ~54 MB smaller, that only runs
on machines which already have both binaries on `PATH`. It empties `build/ffmpeg/` rather than
merely skipping the copy, so it cannot accidentally ship the previous run's binaries.

To point a development run at a specific ffmpeg — including at the copy inside a packaged build:

```
VE_FFMPEG_DIR=/path/to/folder-with-the-binaries npm run dev
```

The main process logs which one it resolved at startup: `[ffmpeg] ffmpeg=bundled:… ffprobe=bundled:…`

## Known limitations

These are design decisions and honest gaps, not bugs.

- **Windows x64 only.** Nothing in the code is Windows-specific and it runs under `npm run dev` on
  other platforms, but no macOS or Linux target is configured and neither has been packaged or
  tested.
- **The preview composites the topmost visible video clip, and so does the export.** Transform,
  opacity and speed apply to that clip against the background. Stacked video tracks decide *which*
  clip is on top; they do not blend. Audio tracks do mix.
- **No transitions, titles, effects or colour correction.** A cut is a cut.
- **Autosave is a crash net, not version history.** A snapshot of the open project is written to
  `%APPDATA%\Video Editor\autosave\` about two seconds after you stop editing, and never less often
  than every twenty seconds while there are unsaved changes — so a crash or a power cut costs at
  most twenty seconds of editing. While an export is running that becomes a minute, so the snapshot
  never stutters the encode. It never writes to your `.veproj`; only `Ctrl+S` does that. After a
  crash the next launch offers the work back in the title bar, but only the **newest** snapshot:
  there is no list to browse and no history to roll back through. A clean exit or a save retires it.
- **Linked clips move as one, and there is no drag modifier to slip one out.** Detaching audio
  links the picture and the sound, so selecting either selects both and every move, trim, split
  and delete applies to the pair in one undo step. To move one half on its own, unlink it
  (`Ctrl+Shift+L`), move it, and link it back (`Ctrl+L`) if you want to. Holding a modifier
  during the drag deliberately does not do this: `Alt` already suppresses snapping, and a chord
  that silently breaks sync is the thing linking exists to prevent. There is no re-attach either —
  linking two clips makes them move together, it does not merge them back into one.
- **Audio-only exports always produce a stereo 48 kHz file.** That is where the mix is built, and
  there are no sample-rate or channel-count controls. Quality picks the bitrate — or, for WAV, 16-
  against 24-bit.
- **One export at a time per window.** Starting a second reports that one is already running rather
  than queueing it.
- **Renaming a file is not undoable.** `Ctrl+Z` is a stack of timeline snapshots and a disk rename
  is deliberately not in it, so undoing an unrelated trim can never rename a file back behind your
  back. Rename fails safely — it never overwrites — but reversing one means renaming it again.
- **The installer is unsigned** — see above.
- **No update mechanism.** New version, new installer.
- **`dev:web` is not the app.** It exists so the interface can be worked on in a browser; its
  import, save and export are stubs. Anything involving real files has to be checked in Electron.

## Layout

```
electron/          main process — window, ve-media:// protocol, ffmpeg resolution, IPC
  ffmpeg.ts        the single answer to "which ffmpeg?"
  export/graph.ts  the timeline compiled to one ffmpeg filter graph
  ipc/             media probing, project read/write, the export job
src/
  components/      shell, media rail, preview, timeline, inspector, export dialog, ui primitives
  state/           one zustand store, four slices
  keyboard/        the shortcut registry every tooltip and the overlay read
  styles/          tokens.css — the only file allowed to contain a colour
scripts/           contract checker, icon, ffmpeg staging, keymap generation, media fixtures
docs/              PLAN.md (implementation), EXPORT.md (the ffmpeg contract),
                   AUDIO-MONITOR.md (how preview audio works),
                   AUDIO-FEATURES.md (detach audio, audio-only export),
                   LINKING.md (group and ungroup),
                   RENAME.md (renaming a source file on disk),
                   SAFETY.md (the close prompt and autosave),
                   ICON.md (the two marks and the .ico ladders)
```

`PRODUCT.md` and `DESIGN.md` at the root carry the design principles and the visual system. Read
them before touching the interface; `npm run contract` enforces the parts of them a machine can
check.
