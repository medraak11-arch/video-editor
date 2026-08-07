/* ---------------------------------------------------------------------------
   InlineNotice — PLAN §5. The ONLY error/warning presentation surface in the
   app. No toasts, no stacking, no status-tile row.

   Icon + word + colour, in that order. Title and message are always
   --text-ink: status colour is never a text colour, because --status-danger on
   --surface-raised falls to ~3.8:1 and the media row's error message sits on
   exactly that surface (PLAN §7.6).

   Three host sites and no others: the titlebar notice strip (shell), the export
   dialog body (inspector), and the media row (media).
--------------------------------------------------------------------------- */

import './ui.css';
import type { ReactElement } from 'react';
import { AlertCircle, TriangleAlert, X } from 'lucide-react';
import { Button } from './Button';
import { IconButton } from './IconButton';

export interface InlineNoticeProps {
  tone: 'danger' | 'warning';
  /** 'Save failed', 'Codec mismatch' — sentence case. */
  title: string;
  message: string;
  /** e.g. 'Retry' */
  action?: { label: string; onSelect(): void };
  onDismiss?(): void;
}

export function InlineNotice({
  tone,
  title,
  message,
  action,
  onDismiss,
}: InlineNoticeProps): ReactElement {
  const Icon = tone === 'danger' ? AlertCircle : TriangleAlert;

  return (
    <div className="ve-notice" data-tone={tone} role="alert">
      <span className="ve-notice-icon ve-icon-slot" aria-hidden="true">
        <Icon size={16} strokeWidth={1.75} />
      </span>
      <div className="ve-notice-body">
        <span className="ve-notice-title type-label">{title}</span>
        <span className="ve-notice-message type-body">{message}</span>
      </div>
      {action || onDismiss ? (
        <div className="ve-notice-actions">
          {action ? (
            <Button variant="secondary" size="sm" onClick={action.onSelect}>
              {action.label}
            </Button>
          ) : null}
          {onDismiss ? (
            <IconButton
              icon={<X size={14} strokeWidth={1.75} />}
              label="Dismiss"
              size="sm"
              onClick={onDismiss}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
