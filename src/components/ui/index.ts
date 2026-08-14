/* ---------------------------------------------------------------------------
   The shared UI primitive barrel. PLAN §5.

   The inventory is TWELVE: Button, IconButton, NumericField, TimecodeField,
   TextField, Select, Fader, InlineNotice, Panel, Tooltip, Dialog, Menu (with
   MenuItem).

   PLAN §5 closed it at nine. Integration extended it by two — TextField and
   Select — because none of the nine holds free text or an enumeration, and the
   export dialog needs both. CREATIVE §1.4 adds the twelfth, Fader: nothing in
   the eleven holds a continuous bounded value by direct manipulation, and the
   track head has no room for a numeric recess. Each new file states the
   reasoning in its own header. The extension is deliberate and recorded; it is
   not a licence to add a thirteenth.

   No slice defines its own button, input, tooltip, notice or dialog. If a
   primitive lacks a prop you need, state the exact declaration you need in your
   final message (PLAN §0.2) — scaffold is the only editor of this directory.
--------------------------------------------------------------------------- */

export { Button } from './Button';
export type { ButtonProps } from './Button';

export { IconButton } from './IconButton';
export type { IconButtonProps } from './IconButton';

export { NumericField } from './NumericField';
export type { NumericFieldProps } from './NumericField';

export { TimecodeField } from './TimecodeField';
export type { TimecodeFieldProps } from './TimecodeField';

export { TextField } from './TextField';
export type { TextFieldProps } from './TextField';

export { Select } from './Select';
export type { SelectProps, SelectOption } from './Select';

export { Fader, faderValueText } from './Fader';
export type { FaderProps } from './Fader';

export { InlineNotice } from './InlineNotice';
export type { InlineNoticeProps } from './InlineNotice';

export { Panel } from './Panel';
export type { PanelProps } from './Panel';

export { Tooltip } from './Tooltip';
export type { TooltipProps } from './Tooltip';

export { Dialog } from './Dialog';
export type { DialogProps } from './Dialog';

export { Menu } from './Menu';
export type { MenuProps, MenuItem } from './Menu';

/** Internal, but exported so a slice never re-implements a loading glyph. */
export { Spinner } from './Spinner';
