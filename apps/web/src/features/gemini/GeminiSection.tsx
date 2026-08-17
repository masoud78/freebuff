import { KeyRound, PlugZap, RefreshCw, Trash2 } from 'lucide-react';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { StatusBadge, type StatusTone } from '../../components/StatusBadge';
import { useGeminiCredentials } from './useGeminiCredentials';

const NOT_CONFIGURED_INFO: { tone: StatusTone; label: string } = {
  tone: 'neutral',
  label: 'تنظیم نشده',
};

const STATUS_LABELS: Record<string, { tone: StatusTone; label: string }> = {
  NOT_CONFIGURED: NOT_CONFIGURED_INFO,
  CONFIGURED: { tone: 'success', label: 'پیکربندی شده' },
  INVALID: { tone: 'danger', label: 'نامعتبر' },
  // Key is fine, but Google refuses requests from this system/region.
  BLOCKED: { tone: 'danger', label: 'دسترسی مسدود' },
};

const INPUT_CLASSES =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-muted transition-colors hover:border-border-strong focus:border-accent';

const BUTTON_CLASSES =
  'inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50';

export function GeminiSection() {
  const {
    status,
    apiKey,
    setApiKey,
    isLoading,
    loadError,
    isSaving,
    isTesting,
    message,
    save,
    test,
    remove,
    retryLoad,
  } = useGeminiCredentials();

  if (isLoading) {
    return <LoadingState label="در حال دریافت وضعیت کلید Gemini…" />;
  }

  if (loadError) {
    return (
      <ErrorState
        message={loadError}
        action={
          <button type="button" onClick={retryLoad} className={BUTTON_CLASSES}>
            <RefreshCw className="size-3.5" aria-hidden="true" />
            تلاش مجدد
          </button>
        }
      />
    );
  }

  const statusInfo = status ? (STATUS_LABELS[status.status] ?? NOT_CONFIGURED_INFO) : NOT_CONFIGURED_INFO;
  const configured = status?.status === 'CONFIGURED';
  const invalid = status?.status === 'INVALID';
  const blocked = status?.status === 'BLOCKED';

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <span className="text-sm text-text-secondary">وضعیت کلید:</span>
        <StatusBadge tone={statusInfo.tone} label={statusInfo.label} />
        {configured && status.lastTestedAt && (
          <span className="text-xs text-text-muted" dir="ltr">
            آخرین تست: {new Date(status.lastTestedAt).toLocaleString('fa-IR')}
          </span>
        )}
      </div>

      <div className="space-y-1.5">
        <label htmlFor="gemini-api-key" className="block text-sm font-medium text-text-primary">
          Gemini API Key
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <KeyRound
              className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-text-muted"
              aria-hidden="true"
            />
            <input
              id="gemini-api-key"
              type="password"
              dir="ltr"
              spellCheck={false}
              autoComplete="off"
              placeholder={configured ? 'کلید جدید برای جایگزینی…' : 'کلید API خود را وارد کنید'}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              className={`${INPUT_CLASSES} ps-9 font-mono text-start`}
            />
          </div>
          <button
            type="button"
            onClick={() => void save()}
            disabled={isSaving || apiKey.trim() === ''}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-3.5 py-2 text-xs font-medium text-on-accent transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSaving ? 'در حال ذخیره…' : 'ذخیره کلید'}
          </button>
        </div>
        <p className="text-xs text-text-secondary">
          کلید فقط روی همین سیستم ذخیره می‌شود و هرگز در مرورگر یا پاسخ‌های API نمایش داده نمی‌شود.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <button
          type="button"
          onClick={() => void test()}
          disabled={isTesting || !configured}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-2 text-xs font-medium text-on-accent transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <PlugZap className="size-3.5" aria-hidden="true" />
          {isTesting ? 'در حال تست…' : 'تست اتصال'}
        </button>
        {configured && (
          <button type="button" onClick={() => void remove()} className={BUTTON_CLASSES}>
            <Trash2 className="size-3.5" aria-hidden="true" />
            حذف کلید
          </button>
        )}
        {invalid && (
          <span className="text-xs text-danger">کلید قبلی نامعتبر است؛ کلید جدید وارد کنید.</span>
        )}
        {blocked && (
          <span className="text-xs text-danger">
            کلید قبلی معتبر است اما گوگل از این سیستم دسترسی نمی‌دهد (مسدودیت منطقه‌ای، محدودیت کلید یا API غیرفعال).
          </span>
        )}
      </div>

      {message && (
        <p
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={`text-sm ${message.tone === 'success' ? 'text-success' : 'text-danger'}`}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
