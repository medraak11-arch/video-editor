/* ---------------------------------------------------------------------------
   TitleGroup — the TitleSpec of a title clip. CREATIVE §5.

   Shown only when the selection is a title clip, which is `clipIsTitle` from
   model.ts and never `kind === 'title'` written out here (model.ts §5.1 names
   that helper THE reader). A media clip has no TitleSpec at all, so this is a
   group that is absent rather than empty — PLAN's rule that the answer to an
   inapplicable control is to not render it, never to disable it.

   ONE CLIP AT A TIME, like transitions and for a plainer reason:
   `setClipTitle` takes a single clip id. Two titles selected together is a
   selection with two different strings in it, and there is no patch that means
   "keep each one's own text but change the size" without a second, fanning
   action that does not exist.

   ORDER IS THE ORDER OF WORK: what it says, how big, what face, what colour,
   what plate, where. Text sits first and takes the most vertical space in the
   group, because it is the only field here whose value is the content and the
   rest are all treatments of it.

   SIZE READS AS A PERCENTAGE OF FRAME HEIGHT because that is what `sizePct` IS
   — cap height as a fraction of the frame (§5.1), which is what makes a title
   resolution-independent. A px face would be a lie at every resolution but the
   one it was authored at, and the whole reason the field is a fraction is that
   the same project exports at 1080 and at 4K.

   ANCHOR IS 0..1, SHOWN AS A PERCENTAGE OF THE FRAME, with 50 the centre. Not
   pixels: a pixel anchor would need the project resolution to mean anything and
   would move when the project resolution changed.
--------------------------------------------------------------------------- */

import './inspector.css';
import { useId } from 'react';
import type { ReactElement } from 'react';
import { NumericField, Select } from '../ui';
import { readStore } from '../../state/store';
import type { Clip, TitleSpec } from '../../types/model';
import { DEFAULT_TITLE } from '../../types/model';
import { ColorField } from './ColorField';
import { MultilineField } from './MultilineField';
import { PropertyRow } from './PropertyRow';
import { ToggleControl } from './ToggleControl';

type Align = TitleSpec['align'];

const ALIGN_OPTIONS: ReadonlyArray<{ value: Align; label: string }> = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Centre' },
  { value: 'right', label: 'Right' },
];

/**
 * The faces `drawTitle` can rely on being present on this platform. A free-text
 * font box would let the user type a family that resolves on their machine and
 * silently substitutes on any other — and since the SAME rasteriser draws the
 * preview and the exported PNG (§5.2), a substitution would be consistent but
 * still not what was asked for. A closed list is honest about what is available.
 */
const FONT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: DEFAULT_TITLE.fontFamily, label: 'Inter' },
  { value: 'Georgia, Times New Roman, serif', label: 'Georgia' },
  { value: 'Segoe UI, system-ui, sans-serif', label: 'Segoe UI' },
  { value: 'Arial, Helvetica, sans-serif', label: 'Arial' },
  { value: 'Courier New, ui-monospace, monospace', label: 'Courier' },
  { value: 'JetBrains Mono, ui-monospace, monospace', label: 'JetBrains Mono' },
];

const toPercent = (stored: number): number => stored * 100;
const fromPercent = (shown: number): number => shown / 100;

export interface TitleGroupProps {
  clips: readonly Clip[];
}

export function TitleGroup({ clips }: TitleGroupProps): ReactElement {
  const base = useId();
  const clip = clips.length === 1 ? clips[0] : undefined;
  const title = clip?.title;

  if (!clip || !title) {
    return (
      <p className="ve-group-note ve-group-note-block type-label">
        Titles are edited one at a time.
      </p>
    );
  }

  /** Every write in this group. One patch, one history entry, one shape. */
  const patch = (p: Partial<TitleSpec>, historyLabel: string): void => {
    readStore().beginHistory(historyLabel);
    readStore().setClipTitle(clip.id, p);
    readStore().commitHistory();
  };

  const id = (suffix: string): string => `${base}-${suffix}`;

  return (
    <>
      <PropertyRow label="Text" htmlFor={id('text')}>
        <MultilineField
          id={id('text')}
          label="Title text"
          value={title.text}
          rows={3}
          placeholder="Title"
          onCommit={(next) => patch({ text: next }, 'Edit title text')}
        />
      </PropertyRow>

      <PropertyRow label="Size" htmlFor={id('size')}>
        <NumericField
          id={id('size')}
          label="Title size"
          value={toPercent(title.sizePct)}
          min={2}
          max={40}
          step={0.5}
          precision={1}
          scrubSensitivity={0.25}
          suffix="%"
          onChange={() => undefined}
          onCommit={(next) => patch({ sizePct: fromPercent(next) }, 'Adjust title size')}
        />
      </PropertyRow>

      <PropertyRow label="Font" htmlFor={id('font')}>
        <Select
          id={id('font')}
          label="Title font"
          value={title.fontFamily}
          options={
            // A project made elsewhere can carry a family this list does not
            // hold. Showing it keeps the select truthful; omitting it would make
            // a native <select> display its FIRST option and quietly report a
            // font the title is not set in.
            FONT_OPTIONS.some((o) => o.value === title.fontFamily)
              ? FONT_OPTIONS
              : [...FONT_OPTIONS, { value: title.fontFamily, label: title.fontFamily }]
          }
          onChange={(next: string) => patch({ fontFamily: next }, 'Change title font')}
        />
      </PropertyRow>

      <PropertyRow label="Bold" htmlFor={id('bold')}>
        <ToggleControl
          id={id('bold')}
          label="Bold"
          value={title.bold}
          onChange={(next) => patch({ bold: next }, 'Toggle bold')}
        />
      </PropertyRow>

      <PropertyRow label="Italic" htmlFor={id('italic')}>
        <ToggleControl
          id={id('italic')}
          label="Italic"
          value={title.italic}
          onChange={(next) => patch({ italic: next }, 'Toggle italic')}
        />
      </PropertyRow>

      <PropertyRow label="Colour" htmlFor={id('color')}>
        <ColorField
          id={id('color')}
          label="Title colour"
          value={title.color}
          fallback={DEFAULT_TITLE.color}
          onCommit={(next) => patch({ color: next }, 'Change title colour')}
        />
      </PropertyRow>

      <PropertyRow label="Plate" htmlFor={id('bg')}>
        <ColorField
          id={id('bg')}
          label="Title background colour"
          value={title.background}
          fallback={DEFAULT_TITLE.background}
          onCommit={(next) => patch({ background: next }, 'Change title plate')}
        />
      </PropertyRow>

      <PropertyRow label="Plate opacity" htmlFor={id('bgo')}>
        <NumericField
          id={id('bgo')}
          label="Title background opacity"
          value={toPercent(title.backgroundOpacity)}
          min={0}
          max={100}
          step={1}
          precision={0}
          scrubSensitivity={0.5}
          suffix="%"
          onChange={() => undefined}
          onCommit={(next) =>
            patch({ backgroundOpacity: fromPercent(next) }, 'Adjust plate opacity')
          }
        />
      </PropertyRow>

      <PropertyRow label="Align" htmlFor={id('align')}>
        <Select
          id={id('align')}
          label="Title alignment"
          value={title.align}
          options={ALIGN_OPTIONS}
          onChange={(next: Align) => patch({ align: next }, 'Change title alignment')}
        />
      </PropertyRow>

      <PropertyRow label="Anchor X" htmlFor={id('ax')}>
        <NumericField
          id={id('ax')}
          label="Title anchor X"
          value={toPercent(title.anchorX)}
          min={0}
          max={100}
          step={1}
          precision={0}
          scrubSensitivity={0.5}
          suffix="%"
          onChange={() => undefined}
          onCommit={(next) => patch({ anchorX: fromPercent(next) }, 'Move title')}
        />
      </PropertyRow>

      <PropertyRow label="Anchor Y" htmlFor={id('ay')}>
        <NumericField
          id={id('ay')}
          label="Title anchor Y"
          value={toPercent(title.anchorY)}
          min={0}
          max={100}
          step={1}
          precision={0}
          scrubSensitivity={0.5}
          suffix="%"
          onChange={() => undefined}
          onCommit={(next) => patch({ anchorY: fromPercent(next) }, 'Move title')}
        />
      </PropertyRow>
    </>
  );
}
