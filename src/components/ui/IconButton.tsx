/* ---------------------------------------------------------------------------
   IconButton — PLAN §5.

   `label` is REQUIRED and becomes the aria-label; there is no icon-only escape
   hatch. It is always wrapped in a Tooltip, so every icon control in the app
   teaches its own name and its own shortcut (PRODUCT.md principle 3).

   `pressed` alone renders as an --text-ink glyph on a persistent
   --surface-raised-hover background: a lightness change plus a distinct glyph,
   which carries a binary state without spending accent. Only track-head
   mute / lock / visibility toggles set `accentWhenPressed` (PLAN §7.4 use 5).
--------------------------------------------------------------------------- */

import './ui.css';
import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, MouseEvent, ReactElement, ReactNode } from 'react';
import { Spinner } from './Spinner';
import { Tooltip } from './Tooltip';

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: ReactNode;
  label: string;
  /** default 'ghost' */
  variant?: 'ghost' | 'secondary';
  /** 24px | 28px square */
  size?: 'sm' | 'md';
  /** Toggle semantics. Sets aria-pressed and swaps the icon glyph. Does NOT tint anything. */
  pressed?: boolean;
  /** Opt-in accent for the pressed state. Default FALSE. */
  accentWhenPressed?: boolean;
  /** 'danger' turns the HOVER background --status-danger. Used only by the titlebar close. */
  tone?: 'default' | 'danger';
  loading?: boolean;
  disabledReason?: string;
  /** Rendered in the tooltip; pass <ShortcutHint id="..." />. */
  shortcut?: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    icon,
    label,
    variant = 'ghost',
    size = 'md',
    pressed,
    accentWhenPressed = false,
    tone = 'default',
    loading = false,
    disabled = false,
    disabledReason,
    shortcut,
    className,
    onClick,
    type = 'button',
    ...rest
  },
  ref,
): ReactElement {
  if (import.meta.env.DEV && disabled && !disabledReason) {
    throw new Error(
      `IconButton "${label}": \`disabled\` requires a \`disabledReason\` (PLAN §5).`,
    );
  }

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (disabled || loading) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onClick?.(event);
  };

  const button = (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={className ? `ve-iconbtn ${className}` : 've-iconbtn'}
      data-variant={variant}
      data-size={size}
      data-tone={tone}
      data-accent-pressed={accentWhenPressed || undefined}
      data-loading={loading || undefined}
      data-disabled={disabled || undefined}
      aria-label={label}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      aria-busy={loading || undefined}
      onClick={handleClick}
    >
      {loading ? (
        <Spinner />
      ) : (
        <span className="ve-icon-slot" aria-hidden="true">
          {icon}
        </span>
      )}
    </button>
  );

  return (
    <Tooltip content={disabled && disabledReason ? disabledReason : label} shortcut={shortcut}>
      {button}
    </Tooltip>
  );
});
