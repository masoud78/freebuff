import { CheckCircle2, RefreshCw, Settings2, TriangleAlert } from 'lucide-react';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { StatusBadge } from '../../components/StatusBadge';
import { useReadiness } from './useReadiness';

const CHECK_LABELS: Record<string, string> = {
  gemini_credential: 'کلید Gemini',
  model_transcription: 'مدل تبدیل صوت به متن',
  model_knowledge_processing: 'مدل پردازش دانش',
  model_content_generation: 'مدل تولید محتوا',
  model_embedding: 'مدل Embedding',
  prompt_transcription: 'پرامپت تبدیل صوت',
  prompt_knowledge_processing: 'پرامپت پردازش دانش',
  prompt_content_generation: 'پرامپت تولید محتوا',
};

const BUTTON_CLASSES =
  'inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-muted';

export function ReadinessCard() {
  const { readiness, isLoading, loadError, retry } = useReadiness();

  if (isLoading) {
    return <LoadingState label="در حال بررسی وضعیت پیکربندی هوش مصنوعی…" />;
  }

  if (loadError || !readiness) {
    return (
      <ErrorState
        message={loadError ?? 'خطا در دریافت وضعیت پیکربندی.'}
        action={
          <button type="button" onClick={retry} className={BUTTON_CLASSES}>
            <RefreshCw className="size-3.5" aria-hidden="true" />
            تلاش مجدد
          </button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <StatusBadge
          tone={readiness.ready ? 'success' : 'warning'}
          label={readiness.ready ? 'Ready' : 'Needs Configuration'}
        />
        <span className="text-sm text-text-secondary">
          {readiness.ready
            ? 'پیکربندی هوش مصنوعی کامل است.'
            : 'برای شروع پردازش، موارد زیر را تکمیل کنید.'}
        </span>
      </div>

      <ul className="space-y-1.5">
        {readiness.checks.map((check) => {
          const label = CHECK_LABELS[check.key] ?? check.key;
          return (
            <li key={check.key} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-text-secondary">{label}</span>
              {check.ready ? (
                <span className="flex items-center gap-1.5 text-xs text-success">
                  <CheckCircle2 className="size-3.5" aria-hidden="true" />
                  آماده
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-xs text-warning">
                  <TriangleAlert className="size-3.5" aria-hidden="true" />
                  نیاز به تنظیم
                </span>
              )}
            </li>
          );
        })}
      </ul>

      <p className="flex items-center gap-1.5 text-xs text-text-muted">
        <Settings2 className="size-3.5" aria-hidden="true" />
        این فقط وضعیت پیکربندی است؛ هیچ پردازشی شروع نشده است.
      </p>
    </div>
  );
}
