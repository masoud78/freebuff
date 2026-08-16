import { ArrowRight, FileAudio, FileText, Play, RefreshCw, ScanLine } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import { SectionCard } from '../components/SectionCard';
import { StatusBadge, type StatusTone } from '../components/StatusBadge';
import type { AudioStatus, BatchStatus } from '@freebuff/contracts';
import { useBatch } from '../features/batches/useBatch';
import { BatchDeltaSection } from '../features/knowledge/BatchDeltaSection';
import { KnowledgeDecisionsSection } from '../features/knowledge/KnowledgeDecisionsSection';
import { TranscriptModal } from '../features/transcripts/TranscriptModal';

const BATCH_TONE: Record<BatchStatus, StatusTone> = {
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

const AUDIO_TONE: Record<AudioStatus, StatusTone> = {
  DISCOVERED: 'neutral',
  REGISTERED: 'neutral',
  DUPLICATE: 'warning',
  QUEUED: 'success',
  TRANSCRIBING: 'warning',
  TRANSCRIBED: 'success',
  FAILED: 'danger',
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('fa-IR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-surface-muted px-4 py-3">
      <p className="text-2xl font-semibold text-text-primary">{value}</p>
      <p className="mt-0.5 text-xs text-text-secondary">{label}</p>
    </div>
  );
}

export function BatchDetailPage() {
  const { id } = useParams<{ id: string }>();
  const batchId = Number(id);
  const {
    batch,
    isLoading,
    loadError,
    isRescanning,
    rescanError,
    rescanMessage,
    isStarting,
    startError,
    retryLoad,
    rescan,
    start,
  } = useBatch(batchId);
  const [viewingTranscript, setViewingTranscript] = useState<{ audioId: number; audioName: string } | null>(null);

  if (isLoading) {
    return <LoadingState label="در حال دریافت جزئیات Batch…" />;
  }

  if (loadError || !batch) {
    return (
      <ErrorState
        message={loadError ?? 'Batch پیدا نشد.'}
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
    );
  }

  const { stats } = batch;
  const processable = stats.transcribed + stats.transcribing + stats.queuedJobs + stats.failedItems;
  const done = stats.transcribed;
  const progressPct =
    processable > 0 ? Math.round((done / processable) * 100) : 0;
  const canStart = batch.status === 'READY' || batch.status === 'CREATED';

  return (
    <>
      {viewingTranscript && (
        <TranscriptModal
          batchId={batchId}
          audioId={viewingTranscript.audioId}
          audioName={viewingTranscript.audioName}
          onClose={() => setViewingTranscript(null)}
        />
      )}

      <PageHeader
        title={
          <span className="inline-flex items-center gap-3">
            <Link
              to="/batches"
              className="inline-flex items-center gap-1 text-sm font-normal text-text-secondary transition-colors hover:text-text-primary"
            >
              <ArrowRight className="size-4" aria-hidden="true" />
              Batches
            </Link>
            <span dir="ltr" className="font-mono">
              #{batch.id}
            </span>
          </span>
        }
        description={`ایجاد شده: ${formatDate(batch.createdAt)}`}
        actions={
          <div className="flex items-center gap-2">
            {canStart && (
              <button
                type="button"
                onClick={() => void start()}
                disabled={isStarting}
                className="inline-flex shrink-0 items-center gap-2 rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-accent-contrast transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Play className={`size-4 ${isStarting ? 'animate-pulse' : ''}`} aria-hidden="true" />
                {isStarting ? 'در حال شروع…' : 'شروع پردازش'}
              </button>
            )}
            <button
              type="button"
              onClick={() => void rescan()}
              disabled={isRescanning}
              className="inline-flex shrink-0 items-center gap-2 rounded-md border border-border bg-surface px-3.5 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ScanLine className={`size-4 ${isRescanning ? 'animate-pulse' : ''}`} aria-hidden="true" />
              {isRescanning ? 'در حال Scan…' : 'Scan دوباره'}
            </button>
          </div>
        }
      />

      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <StatusBadge tone={BATCH_TONE[batch.status]} label={batch.status} />
          {startError && (
            <p className="text-sm text-danger" role="alert">
              {startError}
            </p>
          )}
          {rescanMessage && (
            <p className="text-sm text-success" role="status">
              {rescanMessage}
            </p>
          )}
          {rescanError && (
            <p className="text-sm text-danger" role="alert">
              {rescanError}
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-6">
          <Stat label="کل فایل‌ها" value={stats.totalAudio} />
          <Stat label="در صف تبدیل" value={stats.queuedJobs} />
          <Stat label="در حال تبدیل" value={stats.transcribing} />
          <Stat label="تبدیل شده" value={stats.transcribed} />
          <Stat label="تکراری" value={stats.duplicates} />
          <Stat label="ناموفق" value={stats.failedItems} />
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-6">
          <Stat label="تحلیل دانش در صف" value={stats.knowledgePending} />
          <Stat label="در حال تحلیل" value={stats.knowledgeAnalyzing} />
          <Stat label="تحلیل شده" value={stats.knowledgeAnalyzed} />
          <Stat label="مقصدهای شناسایی‌شده" value={stats.detectedDestinations} />
          <Stat label="دانش استخراج‌شده" value={stats.extractedKnowledge} />
          <Stat label="ناموفق" value={stats.failedItems} />
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-6">
          <Stat label="Candidate در انتظار Delta" value={stats.candidatesPending} />
          <Stat label="Candidate تصمیم‌گرفته" value={stats.candidatesDecided} />
          <Stat label="Delta در صف" value={stats.deltaPending} />
          <Stat label="در حال مقایسه" value={stats.deltaComparing} />
          <Stat label="Delta کامل" value={stats.deltaDecided} />
          <Stat label="Delta ناموفق" value={stats.deltaFailed} />
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Reconcile در صف" value={stats.reconcilePending} />
          <Stat label="در حال اعمال" value={stats.reconcileRunning} />
          <Stat label="اعمال شده" value={stats.reconcileCompleted} />
          <Stat label="ناموفق" value={stats.reconcileFailed} />
        </div>

        {processable > 0 && (
          <SectionCard title="پیشرفت پردازش" description={`${done} از ${processable} فایل قابل پردازش تکمیل شده`}>
            <div className="flex items-center gap-4">
              <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-surface-muted">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-500"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <span className="shrink-0 text-sm font-semibold text-text-primary" dir="ltr">
                {progressPct}%
              </span>
            </div>
          </SectionCard>
        )}

        <KnowledgeDecisionsSection batchId={batchId} stats={stats} />

        <BatchDeltaSection batchId={batchId} />

        <SectionCard
          title="فایل‌های صوتی"
          description={batch.audio.length > 0 ? `${batch.audio.length} فایل ثبت شده` : undefined}
        >
          {batch.audio.length === 0 ? (
            <p className="py-6 text-center text-sm text-text-secondary">
              هیچ فایل صوتی قابل پردازشی پیدا نشد.
            </p>
          ) : (
            <div className="space-y-3">
              {stats.newAudio === 0 && stats.duplicates > 0 && (
                <p className="rounded-md border border-border bg-surface-muted px-4 py-3 text-sm text-text-secondary">
                  فایل جدیدی برای پردازش وجود ندارد؛ همه فایل‌ها تکراری هستند و Job جدیدی ساخته نمی‌شود.
                </p>
              )}
              <ul className="divide-y divide-border">
                {batch.audio.map((audio) => (
                  <li
                    key={audio.id}
                    className="flex items-center justify-between gap-4 py-3"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <FileAudio className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
                      <div className="min-w-0">
                        <p className="truncate text-sm text-text-primary" dir="ltr">
                          {audio.originalName}
                        </p>
                        <p className="text-xs text-text-muted" dir="ltr">
                          {formatSize(audio.size)} · {formatDate(audio.createdAt)}
                          {audio.attempt > 0 && ` · ${audio.attempt} تلاش`}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {audio.duplicateOfAudioId !== null && (
                        <span className="text-xs text-text-muted" dir="ltr">
                          ← #{audio.duplicateOfAudioId}
                        </span>
                      )}
                      <StatusBadge tone={AUDIO_TONE[audio.status]} label={audio.status} />
                      {audio.hasTranscript && (
                        <button
                          type="button"
                          onClick={() =>
                            setViewingTranscript({
                              audioId: audio.id,
                              audioName: audio.originalName,
                            })
                          }
                          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-muted"
                        >
                          <FileText className="size-3.5" aria-hidden="true" />
                          مشاهده Transcript
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </SectionCard>
      </div>
    </>
  );
}
