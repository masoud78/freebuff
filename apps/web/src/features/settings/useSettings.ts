import { useCallback, useEffect, useState } from 'react';
import type { AppSettings } from '@freebuff/contracts';
import { appSettingsSchema } from '@freebuff/contracts';
import { fetchSettings, updateSettings } from '../../lib/api';

const GENERIC_LOAD_ERROR = 'خطا در دریافت تنظیمات. دوباره تلاش کنید.';

export interface SettingsFormValues {
  workspacePath: string;
  concurrency: string;
}

export function useSettings() {
  const [loaded, setLoaded] = useState<AppSettings | null>(null);
  const [values, setValues] = useState<SettingsFormValues>({
    workspacePath: '',
    concurrency: '2',
  });
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetchSettings()
      .then((settings) => {
        if (cancelled) return;
        setLoaded(settings);
        setValues({
          workspacePath: settings.workspacePath,
          concurrency: String(settings.processingConcurrency),
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : GENERIC_LOAD_ERROR);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const retryLoad = useCallback(() => {
    setIsLoading(true);
    setLoadError(null);
    void fetchSettings()
      .then((settings) => {
        setLoaded(settings);
        setValues({
          workspacePath: settings.workspacePath,
          concurrency: String(settings.processingConcurrency),
        });
      })
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : GENERIC_LOAD_ERROR);
      })
      .finally(() => setIsLoading(false));
  }, []);

  const setField = useCallback((patch: Partial<SettingsFormValues>) => {
    setValues((prev) => ({ ...prev, ...patch }));
    setSaveError(null);
    setSaveSuccess(false);
  }, []);

  const isDirty =
    loaded !== null &&
    (values.workspacePath !== loaded.workspacePath ||
      Number(values.concurrency) !== loaded.processingConcurrency);

  const save = useCallback(async () => {
    const parsed = appSettingsSchema.safeParse({
      workspacePath: values.workspacePath,
      processingConcurrency: Number(values.concurrency),
    });
    if (!parsed.success) {
      setSaveError(parsed.error.issues[0]?.message ?? 'مقادیر واردشده معتبر نیستند.');
      return;
    }

    setIsSaving(true);
    setSaveError(null);
    try {
      const updated = await updateSettings(parsed.data);
      setLoaded(updated);
      setValues({
        workspacePath: updated.workspacePath,
        concurrency: String(updated.processingConcurrency),
      });
      setSaveSuccess(true);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'خطا در ذخیره تنظیمات. دوباره تلاش کنید.');
    } finally {
      setIsSaving(false);
    }
  }, [values]);

  return {
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
  };
}
