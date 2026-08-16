import { ChevronDown, History, RotateCcw, Save, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { PromptType } from '@freebuff/contracts';
import { promptTypes } from '@freebuff/contracts';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { StatusBadge } from '../../components/StatusBadge';
import { usePrompts } from './usePrompts';

const PROMPT_LABELS: Record<PromptType, string> = {
  TRANSCRIPTION: 'پرامپت تبدیل ویس به متن',
  KNOWLEDGE_PROCESSING: 'پرامپت پردازش و استخراج نکات',
  CONTENT_GENERATION: 'پرامپت تولید محتوا (Legacy)',
};

const TEXTAREA_CLASSES =
  'w-full rounded-md border border-border bg-surface px-3 py-2.5 text-sm leading-relaxed text-text-primary placeholder:text-text-muted transition-colors hover:border-border-strong focus:border-accent';

const BUTTON_CLASSES =
  'inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50';

export function PromptsSection() {
  const { templates, editor, isLoading, loadError, retryLoad, setDraft, save, activate } =
    usePrompts();
  const [expanded, setExpanded] = useState<Record<PromptType, boolean>>({
    TRANSCRIPTION: false,
    KNOWLEDGE_PROCESSING: false,
    CONTENT_GENERATION: false,
  });

  if (isLoading) {
    return <LoadingState label="در حال دریافت پرامپت‌ها…" />;
  }

  if (loadError || !templates) {
    return (
      <ErrorState
        message={loadError ?? 'خطا در دریافت پرامپت‌ها.'}
        action={
          <button type="button" onClick={retryLoad} className={BUTTON_CLASSES}>
            تلاش مجدد
          </button>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      {promptTypes.map((promptType) => {
        const versions = editor.versions[promptType];
        const active = versions.find((version) => version.isActive);
        const isSaving = editor.saving === promptType;
        const message = editor.messages[promptType];
        const isConfigured = Boolean(active && active.content.trim().length > 0);
        const isExpanded = expanded[promptType];

        return (
          <div key={promptType} className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-text-primary">{PROMPT_LABELS[promptType]}</h3>
                <StatusBadge
                  tone={isConfigured ? 'success' : 'warning'}
                  label={isConfigured ? 'پیکربندی شده' : 'Missing'}
                />
                {active && (
                  <span className="text-xs text-text-muted" dir="ltr">
                    نسخه فعال: v{active.versionNumber}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() =>
                  setExpanded((prev) => ({ ...prev, [promptType]: !prev[promptType] }))
                }
                className={`${BUTTON_CLASSES} gap-1`}
                aria-expanded={isExpanded}
              >
                <History className="size-3.5" aria-hidden="true" />
                تاریخچه نسخه‌ها ({versions.length})
                <ChevronDown
                  className={`size-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                  aria-hidden="true"
                />
              </button>
            </div>

            <textarea
              aria-label={`متن ${PROMPT_LABELS[promptType]}`}
              dir="rtl"
              rows={7}
              placeholder="متن پرامپت را اینجا وارد کنید…"
              value={editor.drafts[promptType]}
              onChange={(event) => setDraft(promptType, event.target.value)}
              className={TEXTAREA_CLASSES}
            />

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 text-sm">
                {message && (
                  <p
                    role={message.tone === 'error' ? 'alert' : 'status'}
                    className={message.tone === 'success' ? 'text-success' : 'text-danger'}
                  >
                    {message.text}
                  </p>
                )}
                {!isConfigured && (
                  <p className="flex items-center gap-1.5 text-xs text-warning">
                    <TriangleAlert className="size-3.5" aria-hidden="true" />
                    این پرامپت هنوز محتوای فعال ندارد و برای پردازش آماده نیست.
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => void save(promptType)}
                disabled={isSaving}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-3.5 py-2 text-xs font-medium text-on-accent transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Save className="size-3.5" aria-hidden="true" />
                {isSaving ? 'در حال ذخیره…' : 'ذخیره نسخه جدید'}
              </button>
            </div>

            {isExpanded && (
              <ul className="divide-y divide-border rounded-md border border-border">
                {versions.map((version) => (
                  <li
                    key={version.id}
                    className="flex items-center justify-between gap-3 px-4 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-xs font-medium text-text-primary">
                        <span dir="ltr" className="font-mono">
                          v{version.versionNumber}
                        </span>
                        {version.isActive && (
                          <StatusBadge tone="success" label="فعال" />
                        )}
                      </p>
                      <p
                        className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-xs text-text-secondary"
                        dir="rtl"
                      >
                        {version.content.trim() || '— خالی —'}
                      </p>
                    </div>
                    {!version.isActive && (
                      <button
                        type="button"
                        onClick={() => void activate(promptType, version.id)}
                        className={`${BUTTON_CLASSES} shrink-0`}
                      >
                        <RotateCcw className="size-3.5" aria-hidden="true" />
                        فعال‌سازی
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
