import { CheckCircle2, RefreshCw, TriangleAlert } from 'lucide-react';
import type { ModelStage } from '@freebuff/contracts';
import { modelStages } from '@freebuff/contracts';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { StatusBadge, type StatusTone } from '../../components/StatusBadge';
import { useModels } from './useModels';

const STAGE_LABELS: Record<ModelStage, string> = {
  TRANSCRIPTION: 'مدل تبدیل صوت به متن',
  KNOWLEDGE_PROCESSING: 'مدل پردازش دانش',
  CONTENT_GENERATION: 'مدل تولید محتوا',
  EMBEDDING: 'مدل Embedding',
};

const SELECT_CLASSES =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary transition-colors hover:border-border-strong focus:border-accent';

const BUTTON_CLASSES =
  'inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50';

export function ModelsSection() {
  const {
    models,
    refreshedAt,
    configs,
    isLoading,
    loadError,
    isRefreshing,
    savingStage,
    saveState,
    saveMessage,
    retryLoad,
    refresh,
    selectModel,
    modelsForStage,
  } = useModels();

  if (isLoading) {
    return <LoadingState label="در حال دریافت مدل‌ها…" />;
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

  const hasModels = models.length > 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-text-secondary">
            {hasModels
              ? `${models.length} مدل از Gemini دریافت شده است`
              : 'هنوز مدلی دریافت نشده است'}
          </span>
          {refreshedAt && (
            <span className="text-xs text-text-muted" dir="ltr">
              آخرین به‌روزرسانی: {new Date(refreshedAt).toLocaleString('fa-IR')}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={isRefreshing}
          className={BUTTON_CLASSES}
        >
          <RefreshCw className={`size-3.5 ${isRefreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
          {isRefreshing ? 'در حال دریافت…' : 'به‌روزرسانی مدل‌ها'}
        </button>
      </div>

      {!hasModels && (
        <div className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-text-secondary">
          برای مشاهده مدل‌های حساب خود، ابتدا کلید Gemini را در بخش «Gemini» ذخیره کنید و سپس
          «به‌روزرسانی مدل‌ها» را بزنید.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {modelStages.map((stage) => {
          const config = configs.find((c) => c.stage === stage);
          const selectedId = config?.modelId ?? '';
          const unavailable = config ? !config.available && selectedId !== '' : false;
          const saving = savingStage === stage;

          let tone: StatusTone = 'neutral';
          let statusLabel = 'انتخاب نشده';
          if (selectedId !== '') {
            if (unavailable) {
              tone = 'danger';
              statusLabel = 'Unavailable';
            } else {
              tone = 'success';
              statusLabel = 'انتخاب شده';
            }
          }

          return (
            <div key={stage} className="space-y-2 rounded-md border border-border p-4">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor={`model-${stage}`} className="text-sm font-medium text-text-primary">
                  {STAGE_LABELS[stage]}
                </label>
                <StatusBadge tone={tone} label={statusLabel} />
              </div>
              <select
                id={`model-${stage}`}
                dir="ltr"
                disabled={!hasModels || saving}
                value={selectedId}
                onChange={(event) => void selectModel(stage, event.target.value)}
                className={`${SELECT_CLASSES} font-mono`}
              >
                <option value="">{hasModels ? '— انتخاب مدل —' : '—'}</option>
                {modelsForStage(stage).map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName} ({model.id})
                  </option>
                ))}
              </select>
              {unavailable && (
                <p className="flex items-center gap-1.5 text-xs text-danger">
                  <TriangleAlert className="size-3.5" aria-hidden="true" />
                  مدل انتخاب‌شده دیگر در دسترس نیست؛ مدل دیگری انتخاب کنید.
                </p>
              )}
              {saving && <p className="text-xs text-text-secondary">در حال ذخیره…</p>}
            </div>
          );
        })}
      </div>

      {saveState === 'saved' && (
        <p className="flex items-center gap-1.5 text-sm text-success" role="status">
          <CheckCircle2 className="size-4" aria-hidden="true" />
          انتخاب مدل ذخیره شد.
        </p>
      )}
      {saveState === 'error' && saveMessage && (
        <p className="text-sm text-danger" role="alert">
          {saveMessage}
        </p>
      )}
    </div>
  );
}
