import { AudioLines, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SessionStage, SessionSummary } from '@freebuff/contracts';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge, type StatusTone } from '../components/StatusBadge';
import { formatJalaliDate } from '../lib/format';
import { deleteSession, fetchSessions } from '../lib/api';

const STEPS = ['آپلود', 'تبدیل به متن', 'پردازش', 'اعمال در دیتابیس'] as const;

const STAGE_TONE: Record<SessionStage, StatusTone> = {
  UPLOAD: 'neutral',
  TRANSCRIBE: 'warning',
  PROCESS: 'warning',
  REVIEW: 'success',
  COMMITTED: 'success',
};

const STAGE_LABEL: Record<SessionStage, string> = {
  UPLOAD: 'آپلود',
  TRANSCRIBE: 'در حال تبدیل به متن',
  PROCESS: 'در حال پردازش',
  REVIEW: 'آمادهٔ اعمال',
  COMMITTED: 'اعمال شده',
};

export function NewProcessingPage() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<SessionSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    fetchSessions()
      .then(setSessions)
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : 'خطا در دریافت جلسه‌ها.');
      })
      .finally(() => setIsLoading(false));
  }, []);

  const handleDelete = async () => {
    if (!confirm) return;
    setDeleting(true);
    try {
      await deleteSession(confirm.id);
      setConfirm(null);
      setSessions((prev) => prev.filter((s) => s.id !== confirm.id));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'حذف پردازش ممکن نشد.');
      setConfirm(null);
    } finally {
      setDeleting(false);
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeader
        title="پردازش جدید"
        description="ویس‌ها را آپلود کنید، به متن تبدیل کنید و نکات کاربردی را به مقصدها اضافه کنید."
        actions={
          <button
            type="button"
            onClick={() => navigate('/sessions/new')}
            className="inline-flex shrink-0 items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent/90"
          >
            <Plus className="size-4" aria-hidden="true" />
            پردازش جدید
          </button>
        }
      />

      <div className="mb-6 flex items-center gap-2 text-sm text-text-secondary">
        <AudioLines className="size-4" aria-hidden="true" />
        <ol className="flex flex-wrap items-center gap-1.5">
          {STEPS.map((step, index) => (
            <li key={step} className="flex items-center gap-1.5">
              {index > 0 && <span className="text-text-muted">←</span>}
              <span className="text-text-primary">{index + 1}. {step}</span>
            </li>
          ))}
        </ol>
      </div>

      {isLoading ? (
        <LoadingState label="در حال دریافت پردازش‌های قبلی…" />
      ) : loadError ? (
        <ErrorState
          message={loadError}
          action={
            <button
              type="button"
              onClick={() => {
                setIsLoading(true);
                setLoadError(null);
                void load();
              }}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-muted"
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
              تلاش مجدد
            </button>
          }
        />
      ) : sessions.length === 0 ? (
        <EmptyState
          icon={<AudioLines className="size-5" />}
          title="هنوز پردازشی انجام نشده است"
          description="برای شروع، دکمه «پردازش جدید» را بزنید و ویس‌ها را آپلود کنید."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-card">
          <ul className="divide-y divide-border">
            {sessions.map((session) => (
              <li key={session.id} className="flex items-center gap-2 px-5 py-4">
                <button
                  type="button"
                  onClick={() => navigate(`/sessions/${session.id}`)}
                  className="flex min-w-0 flex-1 items-center justify-between gap-4 text-start"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-text-primary">
                      {formatJalaliDate(session.createdAt)}
                    </p>
                    {session.destinations.length > 0 ? (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {session.destinations.map((dest) => (
                          <span
                            key={dest.id}
                            className="rounded-full border border-border bg-surface-muted px-2 py-0.5 text-[11px] text-text-secondary"
                          >
                            {dest.name}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-1 text-xs text-text-muted">در انتظار تبدیل به متن</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-4 text-xs text-text-secondary">
                    <span>
                      {session.transcribed}/{session.totalAudio} متن
                    </span>
                    <StatusBadge tone={STAGE_TONE[session.stage]} label={STAGE_LABEL[session.stage]} />
                  </div>
                </button>
                <button
                  type="button"
                  aria-label={`حذف پردازش ${formatJalaliDate(session.createdAt)}`}
                  onClick={() => setConfirm(session)}
                  className="shrink-0 rounded-md p-1.5 text-text-muted transition-colors hover:bg-danger-muted hover:text-danger"
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title={`حذف پردازش ${formatJalaliDate(confirm.createdAt)}`}
          description={
            confirm.stage === 'COMMITTED'
              ? 'این پردازش قبلاً در دیتابیس مقصدها اعمال شده است. حذف پردازش، نکات ثبت‌شده در مقصدها را حذف نمی‌کند.'
              : 'این پردازش و همهٔ داده‌های مربوط به آن (فایل‌ها، متن‌ها و نتایج) حذف می‌شود.'
          }
          confirmLabel="حذف"
          busy={deleting}
          onConfirm={() => void handleDelete()}
          onCancel={() => setConfirm(null)}
        />
      )}
    </>
  );
}
