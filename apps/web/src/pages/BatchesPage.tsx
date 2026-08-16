import { FolderPlus, LoaderCircle, Plus, RefreshCw, ScanLine } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge, type StatusTone } from '../components/StatusBadge';
import type { BatchStatus } from '@freebuff/contracts';
import { useBatches } from '../features/batches/useBatches';

const STATUS_TONE: Record<BatchStatus, StatusTone> = {
  CREATED: 'neutral',
  SCANNING: 'warning',
  READY: 'success',
  PROCESSING: 'warning',
  TRANSCRIBING: 'warning',
  ANALYZING: 'warning',
  DELTA_PROCESSING: 'warning',
  RECONCILING: 'warning',
  ANALYSIS_COMPLETED: 'success',
  KNOWLEDGE_READY: 'success',
  COMPLETED: 'success',
  PARTIAL_FAILED: 'warning',
  FAILED: 'danger',
  CANCELLED: 'neutral',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('fa-IR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function BatchesPage() {
  const { batches, isLoading, loadError, newBatch, retryLoad, createAndScan, resetNewBatch } =
    useBatches();
  const navigate = useNavigate();

  const handleCreate = async () => {
    const scanned = await createAndScan();
    if (scanned) {
      navigate(`/batches/${scanned.id}`);
    }
  };

  return (
    <>
      <PageHeader
        title="Batches"
        description="وارد کردن فایل‌های صوتی و مدیریت پردازش دسته‌ای"
        actions={
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={newBatch.phase === 'creating' || newBatch.phase === 'scanning'}
            className="inline-flex shrink-0 items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="size-4" aria-hidden="true" />
            {newBatch.phase === 'scanning' ? 'در حال Scan…' : 'ایجاد Batch جدید'}
          </button>
        }
      />

      {newBatch.phase === 'creating' && (
        <div
          role="status"
          className="mb-4 flex items-center gap-2 rounded-md border border-border bg-surface px-4 py-3 text-sm text-text-secondary"
        >
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          در حال ایجاد Batch…
        </div>
      )}

      {newBatch.phase === 'scanning' && (
        <div
          role="status"
          className="mb-4 flex items-center gap-2 rounded-md border border-border bg-surface px-4 py-3 text-sm text-text-secondary"
        >
          <ScanLine className="size-4 animate-pulse" aria-hidden="true" />
          در حال Scan پوشه صوتی Workspace…
        </div>
      )}

      {newBatch.phase === 'error' && newBatch.message && (
        <div className="mb-4">
          <ErrorState
            message={newBatch.message}
            action={
              <button
                type="button"
                onClick={resetNewBatch}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-muted"
              >
                بستن
              </button>
            }
          />
        </div>
      )}

      {isLoading ? (
        <LoadingState label="در حال دریافت Batchها…" />
      ) : loadError ? (
        <ErrorState
          message={loadError}
          action={
            <button
              type="button"
              onClick={retryLoad}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-muted"
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
              تلاش مجدد
            </button>
          }
        />
      ) : batches.length === 0 ? (
        <EmptyState
          icon={<FolderPlus className="size-5" />}
          title="هنوز Batchی ساخته نشده است"
          description="فایل‌های صوتی را در پوشه audio داخل Workspace قرار دهید و یک Batch جدید بسازید."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-card">
          <ul className="divide-y divide-border">
            {batches.map((batch) => (
              <li key={batch.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/batches/${batch.id}`)}
                  className="flex w-full items-center justify-between gap-4 px-5 py-4 text-start transition-colors hover:bg-surface-muted"
                >
                  <div className="flex min-w-0 items-center gap-4">
                    <span className="shrink-0 text-sm font-semibold text-text-primary" dir="ltr">
                      #{batch.id}
                    </span>
                    <span className="hidden text-xs text-text-muted sm:inline">
                      {formatDate(batch.createdAt)}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-5 text-xs text-text-secondary">
                    <span>
                      کل: <strong className="text-text-primary">{batch.stats.totalAudio}</strong>
                    </span>
                    <span>
                      جدید: <strong className="text-text-primary">{batch.stats.newAudio}</strong>
                    </span>
                    <span>
                      تکراری: <strong className="text-text-primary">{batch.stats.duplicates}</strong>
                    </span>
                    <StatusBadge tone={STATUS_TONE[batch.status]} label={batch.status} />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
