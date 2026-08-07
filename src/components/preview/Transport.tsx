/* ---------------------------------------------------------------------------
   Transport — DESIGN.md §5, PLAN §7.0.

   Sits directly beneath the frame, ON the well surface, in --text-on-well: in
   the daylight theme --text-ink is dark and would be invisible here.

   Every control is a shared IconButton (ghost), so all seven states, the
   accessible name and the tooltip come from the primitive. The shortcut hint in
   each tooltip is read from the keyboard registry, never typed as a string.

   The playhead read-out is a real control, not a readout: TimecodeField parses
   what you type, Enter jumps the playhead, Escape reverts.

   The row is DESIGN.md §5's list in full: in / out markers, skip, step, and
   play / pause. The markers are here and nowhere else — PLAN §8.16 gives the
   timeline toolbar a different, closed control list.

   No accent anywhere in here. The play button is on PLAN §7.4's not-permitted
   list, and so are the mute and marker pressed states — which is why every
   toggle ships `pressed` without `accentWhenPressed`.
--------------------------------------------------------------------------- */

import './preview.css';
import type { KeyboardEvent, ReactElement } from 'react';
import {
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { IconButton, TimecodeField } from '../ui';
import { ShortcutHint } from '../../keyboard/ShortcutHint';
import { readStore, useEditorStore } from '../../state/store';
import { framesToTimecode } from '../../lib/time';
import { selectTimelineDurationFrames } from '../../state/timelineSlice';

const ICON_SIZE = 16;
const ICON_STROKE = 1.75;

/**
 * A focused button already activates on Space, and Space is also the global play
 * toggle — without this, clicking Play and then pressing Space toggles twice and
 * looks broken, and Space on a focused Step button would step AND start playback.
 * Stopping propagation (rather than preventing the default) keeps the focused
 * button's own activation, which is what a keyboard user expects.
 */
const keepSpaceOnTheButton = (event: KeyboardEvent<HTMLButtonElement>): void => {
  if (event.key === ' ' || event.code === 'Space') event.stopPropagation();
};

/** The live playhead. Isolated so a playing timeline re-renders this and nothing else. */
function TransportTimecode(): ReactElement {
  const playhead = useEditorStore((s) => s.playhead);
  const fps = useEditorStore((s) => s.fps);

  return (
    <div className="ve-transport-timecode">
      <TimecodeField
        value={playhead}
        fps={fps}
        label="Playhead position"
        surface="well"
        onCommit={(frames) => readStore().seek(frames)}
      />
    </div>
  );
}

/** Total length of the assembly. Changes only when the timeline does. */
function TransportDuration(): ReactElement {
  const fps = useEditorStore((s) => s.fps);
  const duration = useEditorStore((s) => selectTimelineDurationFrames(s));

  return (
    <p className="ve-transport-duration">
      <span className="sr-only">Timeline duration </span>
      {/* One step down from the playhead field: hierarchy by size, not by colour —
          --text-muted is below the floor on the well in the daylight theme. */}
      <span className="type-numeric-sm">{framesToTimecode(duration, fps)}</span>
    </p>
  );
}

/** Only present while shuttling. Silent at 1×, so the strip stays quiet at rest. */
function TransportRate(): ReactElement | null {
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const rate = useEditorStore((s) => s.rate);

  if (!isPlaying || rate === 1) return null;
  const magnitude = Math.abs(rate);
  const text = `${rate < 0 ? '-' : ''}${magnitude}×`;

  return (
    <p className="ve-transport-rate">
      <span className="sr-only">Playback rate </span>
      <span className="type-numeric-sm">{text}</span>
    </p>
  );
}

/**
 * The in / out markers DESIGN.md §5 puts in this row. Without them `mark.in` and
 * `mark.out` are keyboard-only and nothing in the app shows whether a range exists,
 * which is the opposite of PRODUCT.md principle 3 — the shortcut is supposed to be
 * TAUGHT by a control, not to be the only way in.
 *
 * State is carried by the label first and the pressed lightness second, never by hue:
 * 'Set in point' with no mark, 'Move in point here' when one exists elsewhere, 'Clear
 * in point' when it is already on this frame — so the word alone tells you both that a
 * mark exists and what the click will do. No `accentWhenPressed`: PLAN §7.4 does not
 * permit accent in the preview.
 */
function TransportMarker({ edge }: { edge: 'in' | 'out' }): ReactElement {
  const playhead = useEditorStore((s) => s.playhead);
  const mark = useEditorStore((s) => (edge === 'in' ? s.inPoint : s.outPoint));

  const atPlayhead = mark !== null && mark === playhead;
  const noun = edge === 'in' ? 'in point' : 'out point';
  const label = mark === null ? `Set ${noun}` : atPlayhead ? `Clear ${noun}` : `Move ${noun} here`;

  const onClick = (): void => {
    const s = readStore();
    if (!atPlayhead) {
      if (edge === 'in') s.setInPoint();
      else s.setOutPoint();
      return;
    }
    // Clear THIS mark only. PLAN §3.3's action list has clearInOut() and no per-edge
    // clear, so drop both and put the survivor back rather than adding an action.
    const survivor = edge === 'in' ? s.outPoint : s.inPoint;
    s.clearInOut();
    if (survivor === null) return;
    if (edge === 'in') s.setOutPoint(survivor);
    else s.setInPoint(survivor);
  };

  return (
    <IconButton
      icon={
        edge === 'in' ? (
          <ChevronFirst size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        ) : (
          <ChevronLast size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        )
      }
      label={label}
      pressed={mark !== null}
      shortcut={<ShortcutHint id={edge === 'in' ? 'mark.in' : 'mark.out'} />}
      onClick={onClick}
      onKeyDown={keepSpaceOnTheButton}
    />
  );
}

export function Transport(): ReactElement {
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const muted = useEditorStore((s) => s.muted);

  const skipToStart = (): void => readStore().seek(0);
  const stepBack = (): void => readStore().step(-1);
  const toggle = (): void => readStore().togglePlay();
  const stepForward = (): void => readStore().step(1);
  const skipToEnd = (): void => {
    const s = readStore();
    // clipEnd is exclusive, so the duration frame itself has no content (PLAN §3.3).
    s.seek(Math.max(0, selectTimelineDurationFrames(s) - 1));
  };
  const toggleOutput = (): void => readStore().setMuted(!muted);

  return (
    <div className="ve-transport">
      <div className="ve-transport-side">
        <TransportTimecode />
      </div>

      <div className="ve-transport-controls">
        <TransportMarker edge="in" />

        <div className="ve-transport-group">
          <IconButton
            icon={<SkipBack size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />}
            label="Skip to start"
            shortcut={<ShortcutHint id="nav.start" />}
            onClick={skipToStart}
            onKeyDown={keepSpaceOnTheButton}
          />
          <IconButton
            icon={<ChevronLeft size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />}
            label="Step back one frame"
            shortcut={<ShortcutHint id="nav.stepBack" />}
            onClick={stepBack}
            onKeyDown={keepSpaceOnTheButton}
          />
          <IconButton
            icon={
              isPlaying ? (
                <Pause size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              ) : (
                <Play size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              )
            }
            label={isPlaying ? 'Pause' : 'Play'}
            shortcut={<ShortcutHint id="play.toggle" />}
            onClick={toggle}
            onKeyDown={keepSpaceOnTheButton}
          />
          <IconButton
            icon={<ChevronRight size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />}
            label="Step forward one frame"
            shortcut={<ShortcutHint id="nav.stepForward" />}
            onClick={stepForward}
            onKeyDown={keepSpaceOnTheButton}
          />
          <IconButton
            icon={<SkipForward size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />}
            label="Skip to end"
            shortcut={<ShortcutHint id="nav.end" />}
            onClick={skipToEnd}
            onKeyDown={keepSpaceOnTheButton}
          />
        </div>

        <TransportMarker edge="out" />
      </div>

      <div className="ve-transport-side ve-transport-side-end">
        <TransportRate />
        <TransportDuration />
        <IconButton
          icon={
            muted ? (
              <VolumeX size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            ) : (
              <Volume2 size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            )
          }
          label={muted ? 'Unmute preview' : 'Mute preview'}
          pressed={muted}
          onClick={toggleOutput}
          onKeyDown={keepSpaceOnTheButton}
        />
      </div>
    </div>
  );
}
