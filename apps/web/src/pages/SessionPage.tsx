import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  FileAudio,
  FileUp,
  LoaderCircle,
  Newspaper,
  FileText,
  RefreshCw,
  Sparkles,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { ProposedNoteAction, ProcessedVoice, SessionDetail } from '@freebuff/contracts';
import { CleanTranscriptModal } from '../components/CleanTranscriptModal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge, type StatusTone } from '../components/StatusBadge';
import { formatJalaliDate } from '../lib/format';
import {
  ApiError,
  commitSession,
  deleteSession,
  deleteSessionVoice,
  fetchSession,
  fetchSessionTranscript,
  retrySessionAudio,
  startSessionProcessing,
  startSessionTranscription,
  uploadSessionFiles,
} from '../lib/api';

const STEPS = ['آپلود', 'تبدیل به متن', 'پردازش', 'اعمال در دیتابیس', 'خبرهای پردازش'] as const;

const STAGE_INDEX: Record<SessionDetail['stage'], number> = {
  UPLOAD: 0,
  TRANSCRIBE: 1,
  PROCESS: 2,
  REVIEW: 3,
  COMMITTED: 4,
  NEWSROOM: 4,
};

const ACTION_TONE: Record<ProposedNoteAction, StatusTone> = {
  ADD: 'success',
  UPDATE: 'warning',
  MARK_OUTDATED: 'danger',
  NO_CHANGE: 'neutral',
};

const ACTION_LABEL: Record<ProposedNoteAction, string> = {
  ADD: 'جدید',
  UPDATE: 'بروزرسانی',
  MARK_OUTDATED: 'قدیمی می‌شود',
  NO_CHANGE: 'بدون تغییر',
};

const APPLIED_LABEL: Record<ProposedNoteAction, string> = {
  ADD: 'اضافه شد',
  UPDATE: 'بروزرسانی شد',
  MARK_OUTDATED: 'قدیمی شد',
  NO_CHANGE: 'بدون تغییر',
};

const KIND_LABEL: Record<string, string> = {
  TOUR_INFO: 'تور',
  DESTINATION_INFO: 'مقصد',
  TRAVELER_GUIDANCE: 'راهنمای مسافر',
};

interface TranscriptTarget {
  audioId: number;
  sessionId: number;
  title: string;
}

type ConfirmTarget =
  | { kind: 'session'; sessionId: number }
  | { kind: 'voice'; sessionId: number; audioId: number; fileName: string };

function topicMessage(topic: string | null, fallback: string): string {
  return topic ? `${fallback} دربارهٔ «${topic}» بود` : fallback;
}

function voiceStatusLine(voice: ProcessedVoice): string {
  if (voice.resultStatus === 'ACTIONABLE') {
    return `پردازش شد · ${voice.notes.length} نکته`;
  }
  if (voice.resultStatus === 'NO_USEFUL_KNOWLEDGE') {
    return 'بدون اطلاعات قابل استفاده';
  }
  return 'اطلاعات جدیدی به دیتابیس اضافه نمی‌کند';
}

export function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const sessionId = Number(id);
  const navigate = useNavigate();
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptTarget | null>(null);
  const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchSession(sessionId);
      setSession(result);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'خطا در دریافت جلسه.');
    }
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    fetchSession(sessionId)
      .then((result) => {
        if (cancelled) return;
        setSession(result);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : 'خطا در دریافت جلسه.');
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Poll while a stage is actively running, and keep polling briefly after the
  // processing finishes until the newsroom has arrived (it is produced by a
  // Gemini call right after the last job completes), so the page comes fully
  // online without a manual refresh.
  const [settlePolls, setSettlePolls] = useState(0);
  const isActive = session?.derived.isTranscribing || session?.derived.isKnowledgeProcessing;
  const awaitingNewsroom =
    !isActive &&
    session != null &&
    (session.stage === 'PROCESS' || session.stage === 'REVIEW') &&
    session.newsroom.length === 0 &&
    settlePolls < 12;
  const shouldPoll = isActive || awaitingNewsroom;
  useEffect(() => {
    if (!shouldPoll) return;
    const timer = setInterval(() => {
      if (!isActive) setSettlePolls((n) => n + 1);
      void load();
    }, 2000);
    return () => clearInterval(timer);
  }, [shouldPoll, isActive, load]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setActionError(null);
    try {
      await fn();
      await load();
    } catch (error) {
      if (error instanceof ApiError) {
        setActionError(
          error.detail ? `${error.message} (${error.code ?? 'خطا'}) — ${error.detail}` : `${error.message} (${error.code ?? 'خطا'})`,
        );
      } else {
        setActionError(error instanceof Error ? error.message : 'خطا در انجام عملیات.');
      }
    } finally {
      setBusy(null);
    }
  };

  const handleFiles = async (files: File[]) => {
    if (files.length === 0) return;
    await run('آپلود', async () => {
      await uploadSessionFiles(sessionId, files);
    });
  };

  const handleDeleteConfirm = async () => {
    if (!confirm) return;
    await run('حذف', async () => {
      if (confirm.kind === 'session') {
        await deleteSession(confirm.sessionId);
        navigate('/');
        return;
      }
      await deleteSessionVoice(confirm.sessionId, confirm.audioId);
      setConfirm(null);
    });
  };

  if (loadError && !session) {
    return (
      <ErrorState
        message={loadError}
        action={
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-muted"
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            تلاش مجدد
          </button>
        }
      />
    );
  }

  if (!session) {
    return <LoadingState label="در حال دریافت پردازش…" />;
  }

  const derived = session.derived;
  const currentStep = STAGE_INDEX[session.stage];
  const failedCount = session.audio.filter((a) => a.status === 'FAILED').length;
  const completedCount = session.audio.filter((a) => a.hasTranscript).length;
  const isApplied = session.stage === 'COMMITTED' || session.stage === 'NEWSROOM';
  const isNewsroom = isApplied;
  const postProcessing = session.stage === 'REVIEW';

  return (
    <>
      <PageHeader
        title={formatJalaliDate(session.createdAt)}
        description={`${session.totalAudio} ویس · ${session.transcribed} متن`}
        actions={
          <div className="flex items-center gap-2">
            <Link
              to="/"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-muted"
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
              بازگشت
            </Link>
            <button
              type="button"
              onClick={() => setConfirm({ kind: 'session', sessionId })}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-muted hover:text-text-primary"
            >
              <Trash2 className="size-4" aria-hidden="true" />
              حذف پردازش
            </button>
          </div>
        }
      />

      {/* Processing header meta: status + real destinations */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <StatusBadge
          tone={isNewsroom ? 'success' : session.stage === 'REVIEW' ? 'success' : 'warning'}
          label={isNewsroom ? 'خبرهای پردازش' : session.stage === 'REVIEW' ? 'آمادهٔ اعمال' : 'در حال پردازش'}
        />
        {session.destinations.length > 0 ? (
          session.destinations.map((dest) => (
            <span
              key={dest.id}
              className="rounded-full border border-border bg-surface-muted px-2.5 py-0.5 text-xs text-text-secondary"
            >
              {dest.name}
            </span>
          ))
        ) : (
          <span className="text-xs text-text-muted">مقصدی هنوز شناسایی نشده است</span>
        )}
      </div>

      {/* Step indicator */}
      <ol className="mb-6 flex flex-wrap items-center gap-2 text-sm">
        {STEPS.map((step, index) => (
          <li key={step} className="flex items-center gap-2">
            {index > 0 && <span className="text-text-muted">←</span>}
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 ${
                index === currentStep
                  ? 'border-accent bg-accent-muted font-medium text-accent'
                  : index < currentStep
                    ? 'border-border bg-surface text-text-secondary'
                    : 'border-border bg-surface text-text-muted'
              }`}
            >
              {index < currentStep && <CheckCircle2 className="size-3.5" aria-hidden="true" />}
              {index + 1}. {step}
            </span>
          </li>
        ))}
      </ol>

      {actionError && (
        <div className="mb-4">
          <ErrorState message={actionError} />
        </div>
      )}

      <div className="space-y-6">
        {/* Upload */}
        {session.stage === 'UPLOAD' && (
          <section className="rounded-lg border border-border bg-surface p-5 shadow-card">
            <h2 className="text-sm font-semibold text-text-primary">آپلود ویس‌ها</h2>
            <p className="mt-1 text-xs text-text-secondary">
              فایل‌های صوتی را اینجا بکشید یا انتخاب کنید. (mp3, wav, m4a, aac, ogg, flac, webm)
            </p>
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragOver(false);
                void handleFiles([...event.dataTransfer.files]);
              }}
              className={`mt-4 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-6 py-10 text-center transition-colors ${
                dragOver ? 'border-accent bg-accent-muted' : 'border-border bg-surface-muted/40 hover:bg-surface-muted'
              }`}
              onClick={() => inputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
              }}
            >
              <FileUp className="size-6 text-text-muted" aria-hidden="true" />
              <p className="text-sm font-medium text-text-primary">
                {busy === 'آپلود' ? 'در حال آپلود…' : 'فایل‌ها را اینجا رها کنید'}
              </p>
              <p className="text-xs text-text-secondary">یا برای انتخاب فایل کلیک کنید</p>
              <input
                ref={inputRef}
                type="file"
                multiple
                accept=".mp3,.wav,.m4a,.aac,.ogg,.flac,.webm,audio/*"
                className="hidden"
                onChange={(event) => {
                  void handleFiles([...(event.target.files ?? [])]);
                  event.target.value = '';
                }}
              />
            </div>
          </section>
        )}

        {/* Pre-processing audio list (transcription progress) */}
        {!postProcessing && session.audio.length > 0 && (
          <section className="overflow-hidden rounded-lg border border-border bg-surface shadow-card">
            <header className="flex items-center justify-between border-b border-border px-5 py-3">
              <h2 className="text-sm font-semibold text-text-primary">ویس‌ها</h2>
              <span className="text-xs text-text-secondary">
                {completedCount}/{session.audio.length} تکمیل شد
                {failedCount > 0 && <span className="ms-2 text-danger">{failedCount} خطا</span>}
              </span>
            </header>
            {failedCount > 0 && (
              <div className="border-b border-danger-muted bg-danger-muted/30 px-5 py-3">
                <p className="flex items-center gap-2 text-sm font-medium text-danger">
                  <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
                  تبدیل {failedCount} ویس به متن با خطا مواجه شد
                </p>
                <ul className="mt-2 space-y-1.5">
                  {session.audio
                    .filter((audio) => audio.status === 'FAILED')
                    .map((audio) => (
                      <li key={audio.id} className="text-xs leading-5 text-danger">
                        <span className="font-mono" dir="ltr">
                          {audio.fileName}
                        </span>
                        {audio.errorMessage && <span> — {audio.errorMessage}</span>}
                      </li>
                    ))}
                </ul>
              </div>
            )}
            <ul className="divide-y divide-border">
              {session.audio.map((audio) => (
                <li key={audio.id} className="flex items-center justify-between gap-4 px-5 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <FileAudio className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
                    <div className="min-w-0">
                      <span className="block truncate text-sm text-text-primary" dir="ltr">
                        {audio.fileName}
                      </span>
                      {audio.status === 'FAILED' && audio.errorMessage && (
                        <span className="block truncate text-xs text-danger" title={audio.errorMessage}>
                          {audio.errorMessage}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {audio.queueState && (
                      <span className={`text-xs ${audio.status === 'FAILED' ? 'text-danger' : 'text-text-secondary'}`}>
                        {audio.queueState}
                      </span>
                    )}
                    {audio.status === 'FAILED' && (
                      <button
                        type="button"
                        onClick={() => void run('تلاش مجدد', () => retrySessionAudio(sessionId, audio.id))}
                        disabled={busy !== null}
                        className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-muted disabled:opacity-50"
                      >
                        تلاش مجدد
                      </button>
                    )}
                    {audio.hasTranscript && (
                      <button
                        type="button"
                        onClick={() => setTranscript({ audioId: audio.id, sessionId, title: audio.fileName })}
                        className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-muted"
                      >
                        نمایش متن
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={`حذف ${audio.fileName}`}
                      onClick={() =>
                        setConfirm({ kind: 'voice', sessionId, audioId: audio.id, fileName: audio.fileName })
                      }
                      className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-danger-muted hover:text-danger"
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Stage actions */}
        {!postProcessing && (
          <div className="flex flex-wrap items-center gap-3">
            {derived.transcriptionBlockedReason && session.stage === 'UPLOAD' && (
              <div className="flex items-start gap-2 rounded-md border border-danger-muted bg-danger-muted/30 px-4 py-3 text-sm text-danger">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>{derived.transcriptionBlockedReason}</span>
              </div>
            )}

            {session.stage === 'UPLOAD' &&
              session.audio.some((a) => a.status === 'REGISTERED' || a.status === 'QUEUED') &&
              !derived.transcriptionBlockedReason && (
                <button
                  type="button"
                  onClick={() => void run('تبدیل', () => startSessionTranscription(sessionId))}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy === 'تبدیل' ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Sparkles className="size-4" aria-hidden="true" />}
                  تبدیل همه به متن
                </button>
              )}

            {derived.isTranscribing && (
              <div className="inline-flex items-center gap-2 rounded-md border border-border bg-surface px-4 py-2 text-sm text-text-secondary">
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                در حال تبدیل به متن…
              </div>
            )}

            {derived.canStartProcessing && (
              <button
                type="button"
                onClick={() => void run('پردازش', () => startSessionProcessing(sessionId))}
                disabled={busy !== null}
                className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === 'پردازش' ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Sparkles className="size-4" aria-hidden="true" />}
                رفتن برای پردازش
              </button>
            )}

            {derived.isKnowledgeProcessing && (
              <div className="inline-flex items-center gap-2 rounded-md border border-border bg-surface px-4 py-2 text-sm text-text-secondary">
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                در حال پردازش…
              </div>
            )}
          </div>
        )}

        {/* Stage 5: newsroom is intentionally hidden during review and appears only after Apply. */}
        {isNewsroom && session.newsroom.length > 0 && (
          <section className="rounded-lg border border-border bg-surface p-5 shadow-card">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
              <Newspaper className="size-4 text-accent" aria-hidden="true" />
              خبرهای این پردازش
            </h2>
            <div className="mt-4 space-y-7">
              {session.newsroom.map((item) => (
                <div key={item.destinationId}>
                  <h3 className="text-sm font-bold text-text-primary">{item.destinationName}</h3>
                  <div className="mt-1 border-s-2 border-border ps-4">
                    {item.stories.length > 0 ? (
                      <div className="space-y-6">
                        {item.stories.map((story, index) => (
                          <article key={index}>
                            <h4 className="text-lg font-bold leading-8 text-text-primary">
                              {story.headline}
                            </h4>
                            {story.subheading && (
                              <h5 className="mt-3 border-b border-border pb-1 text-sm font-bold leading-7 text-text-primary">
                                {story.subheading}
                              </h5>
                            )}
                            {story.paragraphs.map((paragraph, pIndex) => (
                              <p
                                key={pIndex}
                                className="mt-2 whitespace-pre-wrap text-[15px] leading-8 text-text-primary"
                              >
                                {paragraph}
                              </p>
                            ))}
                          </article>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-md bg-surface-muted/50 px-4 py-3">
                        <p className="text-xs font-semibold text-text-secondary">چرا خبری تولید نشد؟</p>
                        <p className="mt-1 whitespace-pre-wrap text-[15px] leading-8 text-text-secondary">
                          {item.reason ?? item.content}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {isNewsroom && session.newsroom.length === 0 && (
          <EmptyState
            icon={<Newspaper className="size-5" />}
            title="خبری برای این پردازش ثبت نشد"
            description={
              session.newsroomReason ?? 'برای این پردازش محتوای خبری قابل ارائه‌ای تولید نشده است.'
            }
          />
        )}

        {/* 2. Compact summary */}
        {derived.canApplyToDatabase && (
          <section className="rounded-lg border border-border bg-surface px-5 py-4 shadow-card">
            <h2 className="text-sm font-semibold text-text-primary">خلاصه تغییرات دیتابیس</h2>
            <ul className="mt-3 space-y-2">
              {session.commitSummary.destinations.map((dest) => (
                <li key={dest.destinationId ?? 0} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium text-text-primary">{dest.destinationName}</span>
                  {dest.addCount > 0 && <span className="text-xs text-text-secondary">{dest.addCount} جدید</span>}
                  {dest.updateCount > 0 && <span className="text-xs text-text-secondary">{dest.updateCount} بروزرسانی</span>}
                  {dest.outdatedCount > 0 && <span className="text-xs text-text-secondary">{dest.outdatedCount} قدیمی</span>}
                </li>
              ))}
            </ul>
            {session.commitSummary.noChangeCount > 0 && (
              <p className="mt-2 text-xs text-text-muted">{session.commitSummary.noChangeCount} ویس بدون تغییر جدید</p>
            )}
            {session.commitSummary.insightCount > 0 && (
              <p className="mt-1 text-xs text-text-secondary">
                {session.commitSummary.insightCount} دغدغه/فرصت محتوای جدید
              </p>
            )}
          </section>
        )}

        {/* 3. Voices — collapsed accordion by default */}
        {postProcessing && session.voices.length > 0 && (
          <section className="rounded-lg border border-border bg-surface shadow-card">
            <header className="border-b border-border px-5 py-3">
              <h2 className="text-sm font-semibold text-text-primary">ویس‌ها</h2>
            </header>
            <div className="divide-y divide-border">
              {session.voices.map((voice) => {
                const label = isApplied ? undefined : voiceStatusLine(voice);
                return (
                  <details key={voice.audioId} className="group px-5 py-3">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
                      <div className="flex min-w-0 items-center gap-3">
                        <FileAudio className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
                        <span className="truncate text-sm font-medium text-text-primary" dir="ltr">
                          {voice.fileName}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {label && (
                          <span className="hidden text-xs text-text-secondary sm:inline">{label}</span>
                        )}
                        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface-muted px-2.5 py-1.5 text-xs font-medium text-text-primary transition-colors group-hover:border-border-strong group-hover:bg-surface-muted group-open:border-accent group-open:bg-accent-muted group-open:text-accent">
                          <FileText className="size-3.5" aria-hidden="true" />
                          {isApplied ? 'مشاهده گزارش و نکات' : 'نمایش گزارش و نکات'}
                          <ChevronDown
                            className="size-3.5 text-text-muted transition-transform group-open:rotate-180"
                            aria-hidden="true"
                          />
                        </span>
                      </div>
                    </summary>

                    <div className="mt-4 space-y-4 border-t border-border pt-4">
                      {voice.report && (
                        <div>
                          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
                            گزارش تماس
                          </h4>
                          <p className="whitespace-pre-wrap text-sm leading-7 text-text-primary">{voice.report}</p>
                        </div>
                      )}

                      {voice.resultStatus === 'NO_USEFUL_KNOWLEDGE' && (
                        <p className="rounded-md bg-surface-muted/60 px-4 py-3 text-sm leading-7 text-text-secondary">
                          {topicMessage(
                            voice.conversationTopic,
                            'این تماس اطلاعات قابل استفاده‌ای برای افزودن به دیتابیس مقصد نداشت.',
                          )}
                        </p>
                      )}

                      {voice.resultStatus === 'NO_NEW_KNOWLEDGE' && (
                        <p className="rounded-md bg-surface-muted/60 px-4 py-3 text-sm leading-7 text-text-secondary">
                          {topicMessage(
                            voice.conversationTopic,
                            'اطلاعات این تماس قبلاً در دیتابیس مقصد ثبت شده و نکته جدید یا تغییری برای اعمال پیدا نشد.',
                          )}
                        </p>
                      )}

                      {voice.notes.length > 0 && (
                        <div>
                          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
                            نکات قابل اعمال
                          </h4>
                          <div className="space-y-3">
                            {voice.notes.map((note) => (
                              <div key={note.id} className="rounded-md border border-border bg-surface-muted/40 p-4">
                                <div className="flex flex-wrap items-center gap-2">
                                  <StatusBadge
                                    tone={ACTION_TONE[note.proposedAction]}
                                    label={(isApplied ? APPLIED_LABEL : ACTION_LABEL)[note.proposedAction]}
                                  />
                                  {note.destinationName && (
                                    <span className="text-xs font-medium text-text-secondary">
                                      {note.destinationName}
                                    </span>
                                  )}
                                  {KIND_LABEL[note.kind] && (
                                    <span className="rounded-full border border-border bg-surface-muted px-2 py-0.5 text-[11px] text-text-muted">
                                      {KIND_LABEL[note.kind]}
                                    </span>
                                  )}
                                </div>
                                <h5 className="mt-2 text-sm font-semibold text-text-primary">{note.title}</h5>
                                <p className="mt-1 whitespace-pre-wrap text-sm leading-7 text-text-primary">
                                  {note.description}
                                </p>
                                {note.relevantDate && (
                                  <p className="mt-2 text-xs text-text-secondary">مرتبط با: {note.relevantDate}</p>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <button
                        type="button"
                        onClick={() => setTranscript({ audioId: voice.audioId, sessionId, title: voice.fileName })}
                        className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-muted"
                      >
                        نمایش متن کامل
                      </button>
                    </div>
                  </details>
                );
              })}
            </div>
          </section>
        )}

        {/* 4. Apply — final, prominent */}
        {derived.canApplyToDatabase && (
          <section className="rounded-lg border border-accent-muted bg-accent-muted/30 px-5 py-4">
            <p className="text-sm text-text-secondary">
              تغییرات پیشنهادی فقط با تأیید شما روی دیتابیس مقصدها اعمال می‌شود.
            </p>
            <button
              type="button"
              onClick={() => void run('اعمال', () => commitSession(sessionId))}
              disabled={busy !== null}
              className="mt-3 inline-flex items-center gap-2 rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === 'اعمال' ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="size-4" aria-hidden="true" />}
              اعمال تغییرات در دیتابیس
            </button>
          </section>
        )}

        {session.stage === 'REVIEW' && session.voices.length === 0 && session.commitSummary.totalProposals === 0 && (
          <EmptyState
            icon={<Sparkles className="size-5" />}
            title="نکته قابل استخراجی یافت نشد"
            description="در این ویس‌ها نکته کاربردی جدیدی برای مقصدها پیدا نشد."
          />
        )}
      </div>

      {transcript && (
        <CleanTranscriptModal
          title={transcript.title}
          load={() => fetchSessionTranscript(transcript.sessionId, transcript.audioId)}
          onClose={() => setTranscript(null)}
        />
      )}

      {confirm && (
        <ConfirmDialog
          title={
            confirm.kind === 'session'
              ? 'حذف پردازش'
              : `حذف «${confirm.fileName}»`
          }
          description={
            confirm.kind === 'session'
              ? isApplied
                ? 'این پردازش قبلاً در دیتابیس مقصدها اعمال شده است. حذف پردازش، نکات ثبت‌شده در مقصدها را حذف نمی‌کند.'
                : 'این پردازش و همهٔ داده‌های مربوط به آن (فایل‌ها، متن‌ها و نتایج) حذف می‌شود.'
              : isApplied
                ? 'این ویس قبلاً به‌عنوان منبع اطلاعات مقصد استفاده شده است. با حذف ویس، نکات ثبت‌شده در دیتابیس حذف نمی‌شوند.'
                : 'این ویس و همهٔ داده‌های مربوط به آن حذف می‌شود.'
          }
          confirmLabel="حذف"
          busy={busy === 'حذف'}
          onConfirm={() => void handleDeleteConfirm()}
          onCancel={() => setConfirm(null)}
        />
      )}
    </>
  );
}
