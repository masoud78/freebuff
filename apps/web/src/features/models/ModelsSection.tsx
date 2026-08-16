import { CheckCircle2, ChevronDown, RefreshCw, TriangleAlert } from 'lucide-react';
import type { ModelStage } from '@freebuff/contracts';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { StatusBadge, type StatusTone } from '../../components/StatusBadge';
import { useModels } from './useModels';

const STAGE_LABELS: Record<ModelStage, string> = {
  TRANSCRIPTION: 'مدل تبدیل ویس به متن',
  KNOWLEDGE_PROCESSING: 'مدل پردازش و استخراج نکات',
  CONTENT_GENERATION: 'مدل تولید محتوا (Legacy)',
  EMBEDDING: 'مدل Embedding',
};

/** Main workflow models — always visible. */
const MAIN_STAGES: ModelStage[] = ['TRANSCRIPTION', 'KNOWLEDGE_PROCESSING'];
/** Secondary/advanced models — collapsed by default. */
const ADVANCED_STAGES: ModelStage[] = ['EMBEDDING'];

const SELECT_CLASSES =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary transition-colors hover:border-border-strong focus:border-accent';

const BUTTON_CLASSES =
  'inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50';

interface StageCardProps {
  stage: ModelStage;
  hasModels: boolean;
  saving: boolean;
  selectedId: string;
  unavailable: boolean;
  onSelect: (stage: ModelStage, modelId: string) => void;
  models: { id: string; displayName: string }[];
}

function StageCard({ stage, hasModels, saving, selectedId, unavailable, onSelect, models }: StageCardProps) {
  let tone: StatusTone = 'neutral';
  let statusLabel = 'انتخاب نشده';
  if (selectedId !== '') {
    if (unavailable) {
      tone = 'danger';
      statusLabel = 'نامعتبر';
    } else {
      tone = 'success';
      statusLabel = 'انتخاب شده';
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-border p-4">
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
        onChange={(event) => onSelect(stage, event.target.value)}
        className={`${SELECT_CLASSES} font-mono`}
      >
        <option value="">{hasModels ? '— انتخاب مدل —' : '—'}</option>
        {models.map((model) => (
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
}

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
  const cardProps = (stage: ModelStage) => {
    const config = configs.find((c) => c.stage === stage);
    const selectedId = config?.modelId ?? '';
    const unavailable = config ? !config.available && selectedId !== '' : false;
    return {
      hasModels,
      saving: savingStage === stage,
      selectedId,
      unavailable,
      onSelect: (s: ModelStage, modelId: string) => void selectModel(s, modelId),
      models: modelsForStage(stage),
    };
  };

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
        {MAIN_STAGES.map((stage) => (
          <StageCard key={stage} stage={stage} {...cardProps(stage)} />
        ))}
      </div>

      <details className="group rounded-md border border-border">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary">
          <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden="true" />
          پیشرفته
        </summary>
        <div className="grid gap-4 border-t border-border p-4 sm:grid-cols-2">
          {ADVANCED_STAGES.map((stage) => (
            <StageCard key={stage} stage={stage} {...cardProps(stage)} />
          ))}
        </div>
      </details>

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
