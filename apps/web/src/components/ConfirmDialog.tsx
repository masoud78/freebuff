import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';

interface ConfirmDialogProps {
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Minimal, calm confirmation modal for destructive actions. */
export function ConfirmDialog({
  title,
  description,
  confirmLabel = 'حذف',
  cancelLabel = 'انصراف',
  danger = true,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-surface p-5 shadow-card">
        <div className="flex items-start gap-3">
          {danger && (
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-danger-muted text-danger">
              <AlertTriangle className="size-4" aria-hidden="true" />
            </span>
          )}
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
            <div className="mt-2 text-sm leading-7 text-text-secondary">{description}</div>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary transition-colors hover:bg-surface-muted disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`rounded-md px-3 py-2 text-sm font-medium text-on-accent transition-colors disabled:opacity-50 ${
              danger ? 'bg-danger hover:bg-danger/90' : 'bg-accent hover:bg-accent/90'
            }`}
          >
            {busy ? 'در حال انجام…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
