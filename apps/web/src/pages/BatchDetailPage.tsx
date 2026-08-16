import { ArrowRight, Ban, FileAudio, FileText, Play, RefreshCw, RotateCcw, ScanLine, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import { SectionCard } from '../components/SectionCard';
import { StatusBadge, type StatusTone } from '../components/StatusBadge';
import type { AudioStatus, BatchJobInfo, BatchStatus, StageProgress } from '@freebuff/contracts';
import { useBatch } from '../features/batches/useBatch';
import { BatchDeltaSection } from '../features/knowledge/BatchDeltaSection';
import { BatchGeneratedContentSection } from '../features/knowledge/BatchGeneratedContentSection';
import { KnowledgeDecisionsSection } from '../features/knowledge/KnowledgeDecisionsSection';
import { TranscriptModal } from '../features/transcripts/TranscriptModal';
import { cancelBatch, fetchBatchJobs, fetchPreflight, retryFailedBatchJobs } from '../lib/api';

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
  GENERATING_CONTENT: 'warning',
  COMPLETED: 'success',
  PARTIAL_FAILED: 'warning',
  FAILED: 'danger',
  TRANSCRIBED: 'success',
  COMMITTED: 'success',
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

const STAGE_LABEL: Record<string, string> = {
  TRANSCRIPTION: 'تبدیل صوت به متن',
  KNOWLEDGE_ANALYSIS: 'تحلیل دانش',
  DELTA_ANALYSIS: 'مقایسهٔ دانش',
  RECONCILIATION: 'اعمال روی دانش نهایی',
  KNOWLEDGE_READY: 'آمادهٔ تولید محتوا',
  CONTENT_GENERATION: 'تولید محتوا',
  COMPLETED: 'تکمیل شده',
  PARTIAL_FAILED: 'ناقص',
  FAILED: 'ناموفق',
  CANCELLED: 'لغو شده',
};

function ProgressRow({ label, progress }: { label: string; progress: StageProgress }) {
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : null;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-text-secondary">{label}</span>
        <span className="text-text-primary">
          {progress.total > 0 ? `${progress.done} / ${progress.total}` : '—'}
        </span>
      </div>
      {progress.total > 0 && (
        <div className="h-2 overflow-hidden rounded-full bg-surface-muted">
          <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

const JOB_TYPE_LABEL: Record<string, string> = {
  TRANSCRIPTION: 'تبدیل صوت به متن',
  KNOWLEDGE_ANALYSIS: 'تحلیل دانش',
  KNOWLEDGE_DELTA: 'مقایسهٔ دانش',
  KNOWLEDGE_RECONCILIATION: 'اعمال دانش',
  CONTENT_GENERATION: 'تولید محتوا',
};

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
  const [failedJobs, setFailedJobs] = useState<BatchJobInfo[]>([]);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [preflightIssues, setPreflightIssues] = useState<string[]>([]);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadJobs = useCallback(() => {
    fetchBatchJobs(batchId)
      .then((result) => setFailedJobs(result.jobs))
      .catch((error: unknown) => {
        setJobsError(error instanceof Error ? error.message : 'خطا در دریافت وضعیت Jobها.');
      });
  }, [batchId]);

  // Preflight: show actionable configuration issues before the user starts.
  useEffect(() => {
    let cancelled = false;
    fetchPreflight()
      .then((result) => {
        if (!cancelled && !result.ready) {
          setPreflightIssues(result.issues.map((issue) => issue.message));
        } else if (!cancelled) {
          setPreflightIssues([]);
        }
      })
      .catch(() => {
        // Preflight is advisory — failures here never block the page.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

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
  const canStart = batch.status === 'READY' || batch.status === 'CREATED';
  const hasFailures = stats.failedItems > 0 || stats.deltaFailed > 0 || stats.reconcileFailed > 0 || stats.contentFailed > 0 || failedJobs.length > 0;
  const canRetry = hasFailures && batch.status !== 'CANCELLED';
  const canCancel =
    ['CREATED', 'SCANNING', 'READY', 'PROCESSING', 'TRANSCRIBING', 'ANALYZING', 'DELTA_PROCESSING', 'RECONCILING', 'GENERATING_CONTENT'].includes(batch.status);

  const handleRetry = async () => {
    setIsRetrying(true);
    setActionMessage(null);
    setActionError(null);
    try {
      const result = await retryFailedBatchJobs(batchId);
      setActionMessage(`Retry شد: ${result.retriedJobs} Job و ${result.retriedAudios} فایل صوتی دوباره به صف اضافه شد.`);
      await retryLoad();
      loadJobs();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Retry با خطا مواجه شد.');
    } finally {
      setIsRetrying(false);
    }
  };

  const handleCancel = async () => {
    if (!window.confirm('این Batch لغو شود؟ Jobهای در صف لغو می‌شوند؛ دانش نهایی قبلی حذف نمی‌شود.')) return;
    setIsCancelling(true);
    setActionMessage(null);
    setActionError(null);
    try {
      await cancelBatch(batchId);
      setActionMessage('Batch لغو شد. Jobهای در صف لغو شدند.');
      await retryLoad();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'لغو Batch با خطا مواجه شد.');
    } finally {
      setIsCancelling(false);
    }
  };

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
          <div className="flex flex-wrap items-center gap-2">
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
            {canRetry && (
              <button
                type="button"
                onClick={() => void handleRetry()}
                disabled={isRetrying}
                className="inline-flex shrink-0 items-center gap-2 rounded-md border border-border bg-surface px-3.5 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RotateCcw className={`size-4 ${isRetrying ? 'animate-pulse' : ''}`} aria-hidden="true" />
                {isRetrying ? 'در حال Retry…' : 'Retry موارد ناموفق'}
              </button>
            )}
            {canCancel && (
              <button
                type="button"
                onClick={() => void handleCancel()}
                disabled={isCancelling}
                className="inline-flex shrink-0 items-center gap-2 rounded-md border border-border bg-surface px-3.5 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Ban className={`size-4 ${isCancelling ? 'animate-pulse' : ''}`} aria-hidden="true" />
                {isCancelling ? 'در حال لغو…' : 'لغو Batch'}
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
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge tone={BATCH_TONE[batch.status]} label={batch.status} />
          {batch.currentStage && STAGE_LABEL[batch.currentStage] && (
            <span className="rounded-md border border-border bg-surface-muted px-2.5 py-1 text-xs text-text-secondary">
              مرحله: {STAGE_LABEL[batch.currentStage]}
            </span>
          )}
          {startError && (
            <p className="text-sm text-danger" role="alert">
              {startError}
            </p>
          )}
          {actionMessage && (
            <p className="text-sm text-success" role="status">
              {actionMessage}
            </p>
          )}
          {actionError && (
            <p className="text-sm text-danger" role="alert">
              {actionError}
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

        {preflightIssues.length > 0 && canStart && (
          <div className="rounded-md border border-warning/30 bg-warning/5 px-4 py-3" role="alert">
            <div className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
              <div>
                <p className="text-sm font-medium text-text-primary">پیکربندی کامل نیست — ابتدا این موارد را رفع کنید:</p>
                <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs text-text-secondary">
                  {preflightIssues.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}

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

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Content در صف" value={stats.contentPending} />
          <Stat label="در حال تولید" value={stats.contentGenerating} />
          <Stat label="تولید شده" value={stats.contentGenerated} />
          <Stat label="ناموفق" value={stats.contentFailed} />
        </div>

        <SectionCard
          title="پیشرفت Pipeline"
          description="پیشرفت واقعی هر مرحله بر اساس دادهٔ Database"
        >
          <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <ProgressRow label="صوت‌ها (Transcription)" progress={batch.progress.transcription} />
            <ProgressRow label="تحلیل دانش" progress={batch.progress.knowledge} />
            <ProgressRow label="مقایسهٔ دانش (Delta)" progress={batch.progress.delta} />
            <ProgressRow label="اعمال روی دانش نهایی" progress={batch.progress.reconciliation} />
            <ProgressRow label="تولید محتوا" progress={batch.progress.content} />
          </div>
        </SectionCard>

        {failedJobs.length > 0 && (
          <SectionCard
            title="خطاها"
            description="Jobهای ناموفق با کد خطا — برای Retry از دکمهٔ بالا استفاده کنید"
          >
            {jobsError && <p className="text-sm text-danger">{jobsError}</p>}
            <ul className="divide-y divide-border">
              {failedJobs.slice(0, 20).map((job) => (
                <li key={job.id} className="flex items-start justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary">
                      {JOB_TYPE_LABEL[job.jobType] ?? job.jobType}
                      <span className="ms-2 text-xs font-normal text-text-muted" dir="ltr">#{job.entityId}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-text-secondary">
                      {job.errorMessage ?? 'خطای نامشخص'}
                      {job.errorCode && (
                        <span className="ms-2 font-mono text-text-muted" dir="ltr">
                          {job.errorCode} · {job.attempt}/{job.maxAttempts}
                        </span>
                      )}
                    </p>
                  </div>
                  <StatusBadge tone="danger" label={job.status} />
                </li>
              ))}
            </ul>
          </SectionCard>
        )}

        <KnowledgeDecisionsSection batchId={batchId} stats={stats} />

        <BatchDeltaSection batchId={batchId} />

        <BatchGeneratedContentSection batchId={batchId} />

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
