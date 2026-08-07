/* ---------------------------------------------------------------------------
   Button — PLAN §5. All seven states, implemented once.

   Disabled is token-based, never opacity-based: the control keeps its
   background, drops its text to --text-muted, stays in the tab order and keeps
   its focus ring, and states its reason in the tooltip. In development,
   `disabled` without a `disabledReason` throws — a control that cannot state a
   reason must stay enabled and explain on use.
--------------------------------------------------------------------------- */

import './ui.css';
import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, MouseEvent, ReactElement, ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { Spinner } from './Spinner';
import { Tooltip } from './Tooltip';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** default 'secondary' */
  variant?: 'primary' | 'secondary' | 'ghost';
  /** 24px | 28px, default 'md' */
  size?: 'sm' | 'md';
  loading?: boolean;
  invalid?: boolean;
  /** REQUIRED whenever `disabled` is set. Rendered in the tooltip. */
  disabledReason?: string;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  /** Sentence case, always. */
  children: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    invalid = false,
    disabled = false,
    disabledReason,
    iconLeft,
    iconRight,
    children,
    className,
    onClick,
    type = 'button',
    ...rest
  },
  ref,
): ReactElement {
  if (import.meta.env.DEV && disabled && !disabledReason) {
    throw new Error(
      'Button: `disabled` requires a `disabledReason` (PLAN §5). Keep the control enabled and explain on use instead.',
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
      className={className ? `ve-btn ${className}` : 've-btn'}
      data-variant={variant}
      data-size={size}
      data-loading={loading || undefined}
      data-disabled={disabled || undefined}
      data-invalid={invalid || undefined}
      aria-disabled={disabled || undefined}
      aria-busy={loading || undefined}
      aria-invalid={invalid || undefined}
      onClick={handleClick}
    >
      {loading ? (
        <Spinner />
      ) : iconLeft ? (
        <span className="ve-icon-slot" aria-hidden="true">
          {iconLeft}
        </span>
      ) : null}
      <span>{children}</span>
      {invalid && !loading ? (
        <span className="ve-icon-slot" aria-hidden="true">
          <AlertCircle size={14} strokeWidth={1.75} />
        </span>
      ) : iconRight ? (
        <span className="ve-icon-slot" aria-hidden="true">
          {iconRight}
        </span>
      ) : null}
    </button>
  );

  if (disabled && disabledReason) {
    return <Tooltip content={disabledReason}>{button}</Tooltip>;
  }
  return button;
});
