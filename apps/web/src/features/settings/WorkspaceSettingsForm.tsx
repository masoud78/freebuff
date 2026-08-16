import { RefreshCw, Save } from 'lucide-react';
import type { ReactNode } from 'react';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { useSettings } from './useSettings';

interface FieldProps {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}

function Field({ id, label, hint, children }: FieldProps) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-text-primary">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

const INPUT_CLASSES =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-muted transition-colors hover:border-border-strong focus:border-accent';

export function WorkspaceSettingsForm() {
  const {
    values,
    isDirty,
    isLoading,
    loadError,
    isSaving,
    saveError,
    saveSuccess,
    setField,
    save,
    retryLoad,
  } = useSettings();

  if (isLoading) {
    return <LoadingState label="در حال دریافت تنظیمات…" />;
  }

  if (loadError) {
    return (
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
    );
  }

  return (
    <div className="space-y-5">
      <div className="space-y-4">
        <Field id="workspace-path" label="مسیر Workspace">
          <input
            id="workspace-path"
            type="text"
            dir="ltr"
            spellCheck={false}
            autoComplete="off"
            placeholder="./workspace"
            value={values.workspacePath}
            onChange={(event) => setField({ workspacePath: event.target.value })}
            className={`${INPUT_CLASSES} font-mono text-start`}
          />
        </Field>

        <Field
          id="processing-concurrency"
          label="تعداد پردازش همزمان"
          hint="این مقدار برای مدیریت پردازش همزمان در Pipeline آینده استفاده خواهد شد."
        >
          <input
            id="processing-concurrency"
            type="number"
            dir="ltr"
            min={1}
            max={10}
            step={1}
            value={values.concurrency}
            onChange={(event) => setField({ concurrency: event.target.value })}
            className={`${INPUT_CLASSES} w-32 text-start`}
          />
        </Field>
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
        <div className="min-w-0 text-sm">
          {saveSuccess && <p className="text-success">تنظیمات ذخیره شد</p>}
          {saveError && <p className="text-danger">{saveError}</p>}
        </div>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!isDirty || isSaving}
          className="inline-flex shrink-0 items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Save className="size-4" aria-hidden="true" />
          {isSaving ? 'در حال ذخیره…' : 'ذخیره تنظیمات'}
        </button>
      </div>
    </div>
  );
}
