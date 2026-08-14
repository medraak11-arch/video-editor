/* ---------------------------------------------------------------------------
   ExportDialog — the one place in the app that spends the primary action.

   Mounted unconditionally by App.tsx; it reads ui.exportDialogOpen and renders
   nothing when closed (PLAN §8.1). The Dialog primitive is a native <dialog>,
   so the focus trap, focus restore, the Escape `cancel` event and the scrim are
   the platform's — Dialog keeps the element mounted across close so the close
   steps actually run and focus returns to whatever opened it.

   Every control here is a scaffold primitive (PLAN §5: "No slice defines its
   own button, input, tooltip, notice or dialog"). The dialog owns its layout
   and its copy and nothing else — hover, focus, disabled, loading and error
   styling are the primitives' to implement once.

   The bridge is `getEditorAPI().export` in Electron — a real ffmpeg process —
   and exportStub under `dev:web`, which has no main process. The dialog cannot
   tell them apart and must not try: every UI state below is driven purely by
   ExportProgressEvent, cancel actually stops the job, and the dialog never runs
   a timer, never interpolates and never shows a percentage the bridge did not
   report. A bridge that refuses to start, or that starts and then goes silent,
   lands in a stated state the user can leave — never in a modal that cannot be
   closed.
--------------------------------------------------------------------------- */

import './export.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Ban, Check } from 'lucide-react';
import { Button, Dialog, InlineNotice, Select, TextField } from '../ui';
import { PropertyRow } from '../inspector/PropertyRow';
import { readStore, useEditorStore } from '../../state/store';
import {
  KNOWN_FPS,
  evenUp,
  projectResolutionValue,
  resolutionLadder,
} from '../../state/playbackSlice';
import { getEditorAPI } from '../../lib/editorApi';
import { CONTAINER } from '../../lib/constants';
import { framesToDuration, framesToSeconds } from '../../lib/time';
import type { ExportProgressEvent, ExportSettings } from '../../types/api';
import { isAudioOnlyCodec } from '../../types/api';
import { exportStub } from './exportStub';
import { buildExportDocument } from './exportDocument';
import { estimateBytes, formatBytes, formatFps, resolveExportRange } from './exportMath';

/**
 * The control now chooses an output KIND, not a video compressor, so the row is
 * `Format`. Video first, audio second, and the one-word suffix carries the
 * grouping — the `Select` primitive has no `<optgroup>` and adding one to a
 * shared primitive for a single call site is out of proportion.
 */
const FORMAT_OPTIONS: ReadonlyArray<{ value: ExportSettings['codec']; label: string }> = [
  { value: 'h264', label: 'H.264 video' },
  { value: 'h265', label: 'H.265 video' },
  { value: 'prores', label: 'ProRes video' },
  { value: 'aac', label: 'AAC audio' },
  { value: 'mp3', label: 'MP3 audio' },
  { value: 'wav', label: 'WAV audio' },
];

const QUALITY_OPTIONS: ReadonlyArray<{ value: ExportSettings['quality']; label: string }> = [
  { value: 'draft', label: 'Draft' },
  { value: 'good', label: 'Good' },
  { value: 'best', label: 'Best' },
];

const RANGE_OPTIONS: ReadonlyArray<{ value: ExportSettings['range']; label: string }> = [
  { value: 'entire', label: 'Entire timeline' },
  { value: 'inout', label: 'In to out' },
];

/**
 * CREATIVE §6.3. A two-value `Select` and not a hand-rolled checkbox: PLAN §5
 * closes the primitive inventory at twelve and none of them is a checkbox, and
 * `Select` is the one that already carries `disabled` + `disabledReason` —
 * which this control needs, because it is unusable for an audio format and for a
 * project with no cues, and a control that is dead for a stated reason beats one
 * that is live and does nothing.
 */
const SUBTITLE_OPTIONS: ReadonlyArray<{ value: 'off' | 'burn'; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'burn', label: 'Burn in' },
];

const PHASE_LABEL: Record<ExportProgressEvent['phase'], string> = {
  preparing: 'Preparing',
  encoding: 'Encoding',
  finalizing: 'Finalizing',
  done: 'Export complete',
  cancelled: 'Export cancelled',
  error: 'Export failed',
};

/* PRESET_SIZES is gone. It was a hardcoded landscape list, so in a 1080 × 1920
   project the Resolution select offered four landscape options and picking one
   shipped a landscape file from a vertical edit — the preview letterboxing to
   9:16 while the encoder wrote 16:9. The export chooses a TIER, never a SHAPE:
   every entry now comes from `resolutionLadder(projectWidth, projectHeight)` and
   therefore carries the project's aspect (FORMAT §6.3). Changing the shape is
   done in the inspector, where the preview follows. */

/** Windows and macOS both reject these; strip rather than fail on write. */
const sanitiseFilename = (name: string): string =>
  name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'Untitled';

const RUNNING_PHASES: ReadonlySet<ExportProgressEvent['phase']> = new Set([
  'preparing',
  'encoding',
  'finalizing',
]);

export function ExportDialog(): ReactElement {
  const open = useEditorStore((s) => s.exportDialogOpen);
  const setExportDialogOpen = useEditorStore((s) => s.setExportDialogOpen);
  const projectFps = useEditorStore((s) => s.fps);
  const projectWidth = useEditorStore((s) => s.width);
  const projectHeight = useEditorStore((s) => s.height);
  const inPoint = useEditorStore((s) => s.inPoint);
  const outPoint = useEditorStore((s) => s.outPoint);
  const clipsById = useEditorStore((s) => s.clips);
  const cuesById = useEditorStore((s) => s.subtitles);

  const bridge = useMemo(() => getEditorAPI().export ?? exportStub, []);

  const filenameRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const jobRef = useRef<string | null>(null);
  /** True only between `start` being called and its job identifying itself. */
  const awaitingJob = useRef(false);
  /** The folder survives closing the dialog, so a second export is one click. */
  const rememberedFolder = useRef('');

  const [settings, setSettings] = useState<ExportSettings>(() => {
    const s = readStore();
    return {
      filename: sanitiseFilename(s.projectName),
      folder: '',
      width: s.width,
      height: s.height,
      fps: s.fps,
      codec: 'h264',
      quality: 'good',
      range: 'entire',
      // A SETTING, not a project property: the same edit ships once with open
      // captions and once clean beside a sidecar .srt, and off is the answer
      // that surprises nobody.
      burnSubtitles: false,
    };
  });
  const [event, setEvent] = useState<ExportProgressEvent | null>(null);
  /**
   * CREATIVE §4.3 — what the build could honour only in part. LATCHED, because
   * the contract sends it on exactly one mid-flight event and never repeats it
   * (api.ts, `ExportProgressEvent.notices`), while the place it needs to be read
   * is the completion screen several seconds later. Rendering straight off
   * `event` would show it for a quarter of a second during encoding and then
   * throw it away.
   */
  const [notices, setNotices] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [filenameError, setFilenameError] = useState<string | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);

  /* Opening resets everything the previous export left behind. */
  useEffect(() => {
    if (!open) return;
    const s = readStore();
    setSettings({
      filename: sanitiseFilename(s.projectName),
      folder: rememberedFolder.current,
      // EVEN. A project saved with an odd height would otherwise be exported odd —
      // electron/ipc/export.ts validates isPositiveInt and nothing else, and libx264
      // dies on it minutes into the render. The store keeps 1081; the export request
      // carries 1082; loading still rewrites nothing.
      width: evenUp(s.width),
      height: evenUp(s.height),
      fps: s.fps,
      codec: 'h264',
      quality: 'good',
      range: s.inPoint !== null || s.outPoint !== null ? 'inout' : 'entire',
      burnSubtitles: false,
    });
    setEvent(null);
    setNotices([]);
    setStarting(false);
    setFilenameError(null);
    setFolderError(null);
    jobRef.current = null;
    awaitingJob.current = false;
  }, [open]);

  /* The dialog's only source of progress. It subscribes once and filters by
     job. A job identifies itself with its FIRST event — `start` can report
     before its promise resolves — but only while this dialog is actually
     waiting for one, and only from an opening event. Otherwise a late event
     from a cancelled job would be adopted as the new job and the dialog would
     render the old job's progress and cancel the wrong id. */
  useEffect(() => {
    if (!open) return undefined;
    return bridge.onProgress((next) => {
      if (jobRef.current === null) {
        if (!awaitingJob.current) return;
        if (next.phase !== 'preparing' || next.progress !== 0) return;
        jobRef.current = next.jobId;
        awaitingJob.current = false;
      }
      if (next.jobId !== jobRef.current) return;
      // Latched rather than read off `event` at render — see `notices` above.
      if (next.notices && next.notices.length > 0) setNotices(next.notices);
      setEvent(next);
    });
  }, [open, bridge]);

  const phase = event?.phase ?? null;
  const running = starting || (phase !== null && RUNNING_PHASES.has(phase));
  const finished = phase === 'done' || phase === 'cancelled' || phase === 'error';

  const range = useMemo(
    () => resolveExportRange(readStore(), settings.range),
    // clipsById / inPoint / outPoint are what make the range move.
    [settings.range, clipsById, inPoint, outPoint],
  );

  const durationSeconds = framesToSeconds(range.durationFrames, projectFps);
  const estimatedBytes = estimateBytes(settings, durationSeconds);
  const outputName = `${settings.filename || 'Untitled'}.${CONTAINER[settings.codec]}`;
  const hasInOut = inPoint !== null || outPoint !== null;
  const audioOnly = isAudioOnlyCodec(settings.codec);
  const cueCount = Object.keys(cuesById ?? {}).length;
  const subtitlesDisabledReason = audioOnly
    ? 'An audio file has no picture to burn subtitles into'
    : cueCount === 0
      ? 'This project has no subtitles yet'
      : undefined;

  // Keyed on the PROJECT size, never on settings.width/height: the list must not
  // change shape when the user picks from it, and the project size is always in
  // the ladder (either as a tier or as its evened passthrough row).
  const sizeOptions = useMemo(
    () => resolutionLadder(projectWidth, projectHeight),
    [projectWidth, projectHeight],
  );

  /* The project size can move WHILE the dialog is open. The reachable path is not
     the inspector — it is inert behind the modal <dialog> — but `adoptSourceFormat`:
     a probe from an import begun before the dialog opened lands inside its lifetime
     (mediaSlice pools 3, so a multi-file import spans seconds), and hydrateMedia's
     re-probe-on-open does the same. The `open` effect runs on [open] only, so
     without this the select's value has no matching option, a native select then
     displays its FIRST option, and the dialog would read "4K vertical · 2160 × 3840"
     while settings still said 1920 × 1080 — the UI lying and Export writing a
     landscape file from a vertical project.

     It converges in one pass and cannot loop: `evenUp` is idempotent, so
     projectResolutionValue(evenUp(projectWidth), evenUp(projectHeight)) equals
     projectResolutionValue(projectWidth, projectHeight), which the ladder always
     contains — either as a tier or as its evened passthrough row. The second run
     takes the guard and returns. */
  useEffect(() => {
    if (!open) return;
    const v = projectResolutionValue(settings.width, settings.height);
    if (sizeOptions.some((o) => o.value === v)) return;
    setSettings((prev) => ({
      ...prev,
      width: evenUp(projectWidth),
      height: evenUp(projectHeight),
    }));
  }, [open, sizeOptions, settings.width, settings.height, projectWidth, projectHeight]);

  const fpsOptions = useMemo(() => {
    const values = new Set<number>([projectFps, ...KNOWN_FPS]);
    return [...values]
      .sort((a, b) => a - b)
      .map((value) => ({ value: String(value), label: `${formatFps(value)} fps` }));
  }, [projectFps]);

  const patch = (next: Partial<ExportSettings>): void =>
    setSettings((prev) => ({ ...prev, ...next }));

  const onResolution = (next: string): void => {
    const [w, h] = next.split('x').map(Number);
    if (Number.isFinite(w) && Number.isFinite(h)) {
      patch({ width: w as number, height: h as number });
    }
  };

  const browse = async (): Promise<void> => {
    const folder = await getEditorAPI().project.pickDirectory();
    if (folder === null) return;
    rememberedFolder.current = folder;
    setFolderError(null);
    patch({ folder });
  };

  const startExport = async (): Promise<void> => {
    const filename = settings.filename.trim();
    const folder = settings.folder.trim();
    let blocked = false;

    if (filename === '') {
      setFilenameError('Enter a file name');
      blocked = true;
    } else {
      setFilenameError(null);
    }
    if (folder === '') {
      setFolderError('Choose an output folder');
      blocked = true;
    } else {
      setFolderError(null);
    }
    if (blocked) {
      (filename === '' ? filenameRef.current : folderRef.current)?.focus();
      return;
    }

    setStarting(true);
    setEvent(null);
    setNotices([]);
    jobRef.current = null;
    awaitingJob.current = true;

    const resolved = resolveExportRange(readStore(), settings.range);
    try {
      // Awaited, because assembling the document now rasterises every title
      // clip through the same `drawTitle` the preview uses (CREATIVE §5.2) and
      // `convertToBlob` is async. It happens before `start` so the request the
      // bridge sees is complete; the dialog is already showing `Preparing`.
      const document = await buildExportDocument(readStore());
      const { jobId } = await bridge.start({
        ...settings,
        filename,
        folder,
        // Re-derived rather than trusted: the codec can have moved to an audio
        // format, or the last cue can have been deleted, since the row was last
        // rendered, and a setting that outlives its own precondition is the
        // shape of bug the dialog cannot see.
        burnSubtitles: settings.burnSubtitles && subtitlesDisabledReason === undefined,
        startFrame: resolved.startFrame,
        durationFrames: resolved.durationFrames,
        // A main-process bridge has no other way to see the timeline. Sent
        // unfiltered — range and track flags are the graph builder's to apply,
        // in one place (EXPORT §1.9, §6).
        document,
      });
      if (jobRef.current === null) jobRef.current = jobId;
      awaitingJob.current = false;
      setStarting(false);
    } catch {
      // The real ffmpeg-backed bridge can reject here (a missing binary, a
      // folder that vanished). Without this the dialog would stay `running`
      // forever with a cancel that no-ops and an Escape that refuses — an
      // unclosable modal with the focus trap still engaged.
      awaitingJob.current = false;
      setStarting(false);
      setEvent({
        jobId: '',
        phase: 'error',
        progress: 0,
        framesDone: 0,
        framesTotal: resolved.durationFrames,
        message: 'The encoder could not be started',
      });
    }
  };

  const cancelExport = async (): Promise<void> => {
    const id = jobRef.current;
    if (id === null) return;
    try {
      await bridge.cancel(id);
    } catch {
      // A bridge that cannot cancel still owes us a terminal event; if it never
      // sends one, `requestClose` below is what gets the user out.
    }
  };

  const backToSettings = (): void => {
    setEvent(null);
    setNotices([]);
    setStarting(false);
    jobRef.current = null;
    awaitingJob.current = false;
  };

  /* Escape during an export cancels the export rather than abandoning it behind
     a closed dialog. Escape at rest closes, as it should. A "running" state
     with no job to cancel is not a state worth trapping anyone in, so it
     closes too. */
  const requestClose = (): void => {
    if (running && jobRef.current !== null) {
      void cancelExport();
      return;
    }
    setExportDialogOpen(false);
  };

  const percent = event ? Math.round(event.progress * 100) : 0;

  const footer = running ? (
    <>
      <Button variant="secondary" onClick={requestClose}>
        Cancel export
      </Button>
      <Button variant="primary" loading>
        Export
      </Button>
    </>
  ) : phase === 'done' ? (
    // Not primary: §7.4 closes the accent budget at the Export button itself,
    // and Done is an acknowledgement. The check icon carries the completion.
    <Button variant="secondary" onClick={() => setExportDialogOpen(false)}>
      Done
    </Button>
  ) : finished ? (
    <>
      <Button variant="secondary" onClick={() => setExportDialogOpen(false)}>
        Close
      </Button>
      <Button
        variant="primary"
        onClick={() => {
          backToSettings();
          void startExport();
        }}
      >
        Export
      </Button>
    </>
  ) : (
    <>
      <Button variant="secondary" onClick={() => setExportDialogOpen(false)}>
        Cancel
      </Button>
      <Button variant="primary" onClick={() => void startExport()}>
        Export
      </Button>
    </>
  );

  return (
    <Dialog
      open={open}
      onClose={requestClose}
      title="Export"
      width={520}
      initialFocusRef={filenameRef}
      footer={footer}
    >
      {running || finished ? (
        <div className="ve-export-progress">
          <p className="ve-export-phase type-body" aria-live="polite">
            {phase ? PHASE_LABEL[phase] : PHASE_LABEL.preparing}
          </p>

          {running || phase === 'cancelled' ? (
            <>
              <div className="ve-progress">
                <div
                  className="ve-progress-track"
                  role="progressbar"
                  aria-label="Export progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                >
                  <div className="ve-progress-fill" style={{ width: `${percent}%` }} />
                </div>
                <span className="ve-progress-value type-numeric">{percent}%</span>
              </div>
              {/* There are no output frames in an audio-only export, so the
                  counter is not rendered at all — not "Frame 0 of 0", and not a
                  substituted seconds read-out, which would be derived rather
                  than reported. The percentage and the bar already state it. */}
              {audioOnly ? null : (
                <p className="ve-export-frames type-numeric">
                  Frame {event?.framesDone ?? 0} of {event?.framesTotal ?? range.durationFrames}
                </p>
              )}
            </>
          ) : null}

          {phase === 'done' ? (
            <p className="ve-export-result type-body">
              <span className="ve-export-result-icon" aria-hidden="true">
                <Check size={16} strokeWidth={1.75} />
              </span>
              {/* The path MAIN actually wrote, not the dialog's guess at it: main
                  joins with path.join, which normalises separators this fallback
                  does not, and it may reject a file name sanitiseFilename let
                  through. The fallback stays for the stub, which writes nothing
                  and so reports no outputPath. */}
              Written to{' '}
              {event?.outputPath ??
                `${settings.folder}${
                  settings.folder.endsWith('/') || settings.folder.endsWith('\\') ? '' : '/'
                }${outputName}`}
            </p>
          ) : null}

          {/* CREATIVE §4.3, §4.3d. Shown on completion and NOT on cancel or
              error, because a notice says "the file exists and is not quite the
              edit" — and on those two branches there is no file for it to be a
              statement about. `warning`, not `danger`: nothing failed.

              One InlineNotice per notice rather than a joined list: the
              primitive takes one message, and two degraded transitions are two
              separate facts about two separate clips. */}
          {phase === 'done'
            ? notices.map((note) => (
                <InlineNotice
                  key={note}
                  tone="warning"
                  title="Exported with a change"
                  message={note}
                />
              ))
            : null}

          {phase === 'cancelled' ? (
            <p className="ve-export-result type-body">
              <span className="ve-export-result-icon" aria-hidden="true">
                <Ban size={16} strokeWidth={1.75} />
              </span>
              No file was written
            </p>
          ) : null}

          {phase === 'error' ? (
            <InlineNotice
              tone="danger"
              title="Export failed"
              message={event?.message ?? 'The encoder stopped before it finished'}
            />
          ) : null}
        </div>
      ) : (
        <div className="ve-export-form">
          <PropertyRow label="File name" htmlFor="ve-export-filename">
            <TextField
              id="ve-export-filename"
              inputRef={filenameRef}
              label="File name"
              value={settings.filename}
              error={filenameError}
              onChange={(next: string) => {
                setFilenameError(null);
                patch({ filename: next });
              }}
              onCommit={(next: string) => patch({ filename: sanitiseFilename(next) })}
            />
          </PropertyRow>

          <PropertyRow label="Folder" htmlFor="ve-export-folder">
            <div className="ve-export-folder">
              <div className="ve-export-folder-field">
                <TextField
                  id="ve-export-folder"
                  inputRef={folderRef}
                  label="Output folder"
                  value={settings.folder}
                  placeholder="No folder chosen"
                  readOnly
                  error={folderError}
                  onChange={() => undefined}
                  onCommit={() => undefined}
                />
              </div>
              <Button variant="secondary" size="sm" onClick={() => void browse()}>
                Browse
              </Button>
            </div>
          </PropertyRow>

          {/* Not disabled — not rendered. An audio file has no resolution and no
              frame grid, and six greyed fields with six copies of "not used for
              audio" is the wall of dead controls PRODUCT.md §2 rules out. Both
              rows sit ABOVE Format, so the form collapses from the middle and
              the control the user just operated stays under the pointer. The
              values themselves are retained in state and still sent — see the
              retention note in AUDIO-FEATURES §2.4. */}
          {audioOnly ? null : (
            <>
              <PropertyRow label="Resolution" htmlFor="ve-export-resolution">
                {/* numeric: the dimensions change as the setting changes, and §7.2
                    names "dimension" in the tabular rule. */}
                <Select
                  id="ve-export-resolution"
                  label="Resolution"
                  numeric
                  /* Even by construction, so it always names a real option. */
                  value={projectResolutionValue(settings.width, settings.height)}
                  options={sizeOptions}
                  onChange={onResolution}
                />
              </PropertyRow>

              <PropertyRow label="Frame rate" htmlFor="ve-export-fps">
                <Select
                  id="ve-export-fps"
                  label="Frame rate"
                  numeric
                  value={String(settings.fps)}
                  options={fpsOptions}
                  onChange={(next: string) => patch({ fps: Number(next) })}
                />
              </PropertyRow>
            </>
          )}

          <PropertyRow label="Format" htmlFor="ve-export-format">
            <Select
              id="ve-export-format"
              label="Format"
              value={settings.codec}
              options={FORMAT_OPTIONS}
              onChange={(codec: ExportSettings['codec']) => patch({ codec })}
            />
          </PropertyRow>

          <PropertyRow label="Quality" htmlFor="ve-export-quality">
            <Select
              id="ve-export-quality"
              label="Quality"
              value={settings.quality}
              options={QUALITY_OPTIONS}
              onChange={(quality: ExportSettings['quality']) => patch({ quality })}
            />
          </PropertyRow>

          {/* Rendered even when it is unusable, unlike Resolution and Frame
              rate above: those are meaningless for an audio file, whereas this
              one is meaningful and merely unavailable, and its absence would
              read as "this build cannot burn subtitles". The reason is on the
              control. */}
          <PropertyRow label="Subtitles" htmlFor="ve-export-subtitles">
            <Select
              id="ve-export-subtitles"
              label="Burn in subtitles"
              value={settings.burnSubtitles ? 'burn' : 'off'}
              options={SUBTITLE_OPTIONS}
              disabled={subtitlesDisabledReason !== undefined}
              disabledReason={subtitlesDisabledReason}
              onChange={(next: 'off' | 'burn') => patch({ burnSubtitles: next === 'burn' })}
            />
          </PropertyRow>

          {hasInOut ? (
            <PropertyRow label="Range" htmlFor="ve-export-range">
              <Select
                id="ve-export-range"
                label="Range"
                value={settings.range}
                options={RANGE_OPTIONS}
                onChange={(nextRange: ExportSettings['range']) => patch({ range: nextRange })}
              />
            </PropertyRow>
          ) : null}

          <div className="ve-export-summary">
            <div className="ve-summary-row">
              <span className="ve-summary-label type-label">Output file</span>
              <span className="ve-summary-value type-body">{outputName}</span>
            </div>
            <div className="ve-summary-row">
              <span className="ve-summary-label type-label">Duration</span>
              <span className="ve-summary-value type-numeric">
                {framesToDuration(range.durationFrames, projectFps)}
              </span>
            </div>
            <div className="ve-summary-row">
              {/* The label follows the honesty of the number: WAV's size is
                  arithmetic, everything else's is a model. */}
              <span className="ve-summary-label type-label">
                {settings.codec === 'wav' ? 'Size' : 'Estimated size'}
              </span>
              <span className="ve-summary-value type-numeric">{formatBytes(estimatedBytes)}</span>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
