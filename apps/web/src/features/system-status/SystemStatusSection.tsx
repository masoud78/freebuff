import { RefreshCw } from 'lucide-react';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { StatusBadge, type StatusTone } from '../../components/StatusBadge';
import type { ComponentStatus, SystemStatusState } from './useSystemStatus';

interface SystemStatusSectionProps {
  status: SystemStatusState;
  retry: () => void;
}

interface StatusRow {
  key: string;
  label: string;
  tone: StatusTone;
  text: string;
}

const READY: StatusRow = {
  key: 'frontend',
  label: 'Frontend',
  tone: 'success',
  text: 'Ready',
};

function statusRow(label: string, status: ComponentStatus): StatusRow {
  if (status === 'checking') return { key: label, label, tone: 'warning', text: 'در حال بررسی…' };
  if (status === 'connected') return { key: label, label, tone: 'success', text: 'Connected' };
  return { key: label, label, tone: 'danger', text: 'Unavailable' };
}

export function SystemStatusSection({ status, retry }: SystemStatusSectionProps) {
  if (status.backend === 'checking') {
    return <LoadingState label="در حال بررسی وضعیت سیستم…" />;
  }

  const rows: StatusRow[] = [
    READY,
    statusRow('Backend', status.backend),
    statusRow('Database', status.database),
    { key: 'workspace', label: 'Workspace', tone: 'success', text: 'Ready' },
  ];

  return (
    <div className="space-y-4">
      <dl className="divide-y divide-border">
        {rows.map((row) => (
          <div key={row.key} className="flex min-w-0 items-center justify-between gap-4 py-3">
            <dt className="text-sm text-text-secondary">{row.label}</dt>
            <dd>
              <StatusBadge tone={row.tone} label={row.text} />
            </dd>
          </div>
        ))}
      </dl>

      {status.backend === 'unavailable' && (
        <ErrorState
          message="اتصال به سرور برقرار نیست. پس از اطمینان از اجرای Backend دوباره تلاش کنید."
          action={
            <button
              type="button"
              onClick={retry}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-muted"
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
              تلاش مجدد
            </button>
          }
        />
      )}
    </div>
  );
}
