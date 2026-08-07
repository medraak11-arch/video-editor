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

   The encode itself is stubbed in this build (see exportStub.ts) — but every UI
   state below is real: the progress bar is determinate and driven purely by
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
import { KNOWN_FPS } from '../../state/playbackSlice';
import { getEditorAPI } from '../../lib/editorApi';
import { CONTAINER } from '../../lib/constants';
import { framesToDuration, framesToSeconds } from '../../lib/time';
import type { ExportProgressEvent, ExportSettings } from '../../types/api';
import { exportStub } from './exportStub';
import { estimateBytes, formatBytes, formatFps, resolveExportRange } from './exportMath';

const CODEC_OPTIONS: ReadonlyArray<{ value: ExportSettings['codec']; label: string }> = [
  { value: 'h264', label: 'H.264' },
  { value: 'h265', label: 'H.265' },
  { value: 'prores', label: 'ProRes' },
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

const PHASE_LABEL: Record<ExportProgressEvent['phase'], string> = {
  preparing: 'Preparing',
  encoding: 'Encoding',
  finalizing: 'Finalizing',
  done: 'Export complete',
  cancelled: 'Export cancelled',
  error: 'Export failed',
};

const PRESET_SIZES: ReadonlyArray<[number, number]> = [
  [3840, 2160],
  [1920, 1080],
  [1280, 720],
  [854, 480],
];

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
  const inPoint = useEditorStore((s) => s.inPoint);
  const outPoint = useEditorStore((s) => s.outPoint);
  const clipsById = useEditorStore((s) => s.clips);

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
    };
  });
  const [event, setEvent] = useState<ExportProgressEvent | null>(null);
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
      width: s.width,
      height: s.height,
      fps: s.fps,
      codec: 'h264',
      quality: 'good',
      range: s.inPoint !== null || s.outPoint !== null ? 'inout' : 'entire',
    });
    setEvent(null);
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

  const sizeOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ value: string; label: string }> = [];
    for (const [w, h] of [[settings.width, settings.height] as [number, number], ...PRESET_SIZES]) {
      const value = `${w}x${h}`;
      if (seen.has(value)) continue;
      seen.add(value);
      out.push({ value, label: `${w} × ${h}` });
    }
    return out;
  }, [settings.width, settings.height]);

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
    jobRef.current = null;
    awaitingJob.current = true;

    const resolved = resolveExportRange(readStore(), settings.range);
    try {
      const { jobId } = await bridge.start({
        ...settings,
        filename,
        folder,
        startFrame: resolved.startFrame,
        durationFrames: resolved.durationFrames,
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
      title="Export video"
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
              <p className="ve-export-frames type-numeric">
                Frame {event?.framesDone ?? 0} of {event?.framesTotal ?? range.durationFrames}
              </p>
            </>
          ) : null}

          {phase === 'done' ? (
            <p className="ve-export-result type-body">
              <span className="ve-export-result-icon" aria-hidden="true">
                <Check size={16} strokeWidth={1.75} />
              </span>
              Written to {settings.folder}
              {settings.folder.endsWith('/') || settings.folder.endsWith('\\') ? '' : '/'}
              {outputName}
            </p>
          ) : null}

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

          <PropertyRow label="Resolution" htmlFor="ve-export-resolution">
            {/* numeric: the dimensions change as the setting changes, and §7.2
                names "dimension" in the tabular rule. */}
            <Select
              id="ve-export-resolution"
              label="Resolution"
              numeric
              value={`${settings.width}x${settings.height}`}
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

          <PropertyRow label="Codec" htmlFor="ve-export-codec">
            <Select
              id="ve-export-codec"
              label="Codec"
              value={settings.codec}
              options={CODEC_OPTIONS}
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
              <span className="ve-summary-label type-label">Estimated size</span>
              <span className="ve-summary-value type-numeric">{formatBytes(estimatedBytes)}</span>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
