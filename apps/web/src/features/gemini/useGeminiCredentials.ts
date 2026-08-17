import { useCallback, useEffect, useState } from 'react';
import type { GeminiCredentialStatusResponse } from '@freebuff/contracts';
import { ApiError, deleteApiKey, fetchCredentialStatus, saveApiKey, testGeminiConnection } from '../../lib/api';

export interface SectionMessage {
  tone: 'success' | 'error';
  text: string;
}

export function useGeminiCredentials() {
  const [status, setStatus] = useState<GeminiCredentialStatusResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [message, setMessage] = useState<SectionMessage | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCredentialStatus()
      .then((result) => {
        if (cancelled) return;
        setStatus(result);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : 'خطا در دریافت وضعیت کلید Gemini.');
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
    void fetchCredentialStatus()
      .then(setStatus)
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : 'خطا در دریافت وضعیت کلید Gemini.');
      })
      .finally(() => setIsLoading(false));
  }, []);

  const save = useCallback(async () => {
    const key = apiKey.trim();
    if (!key) {
      setMessage({ tone: 'error', text: 'API Key نمی‌تواند خالی باشد.' });
      return;
    }
    setIsSaving(true);
    setMessage(null);
    try {
      const result = await saveApiKey(key);
      setStatus(result);
      setApiKey('');
      setMessage({ tone: 'success', text: 'کلید API ذخیره شد.' });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'خطا در ذخیره کلید.' });
    } finally {
      setIsSaving(false);
    }
  }, [apiKey]);

  const test = useCallback(async () => {
    setIsTesting(true);
    setMessage(null);
    try {
      const result = await testGeminiConnection();
      setStatus(result);
      setMessage({ tone: 'success', text: result.message });
    } catch (error) {
      // Show the precise underlying reason (Google's own message) when the
      // backend provides it — a raw "invalid key" guess is never enough.
      const text =
        error instanceof ApiError && error.detail
          ? `${error.message} — ${error.detail}`
          : error instanceof Error
            ? error.message
            : 'اتصال ناموفق بود.';
      setMessage({ tone: 'error', text });
      const code = error instanceof Error && 'code' in error ? (error as { code: string }).code : null;
      if (code === 'GEMINI_AUTH_ERROR' || code === 'GEMINI_FORBIDDEN' || code === 'GEMINI_NOT_CONFIGURED') {
        const status =
          code === 'GEMINI_AUTH_ERROR' ? 'INVALID' : code === 'GEMINI_FORBIDDEN' ? 'BLOCKED' : 'NOT_CONFIGURED';
        setStatus((prev) => (prev ? { ...prev, status } : prev));
      }
    } finally {
      setIsTesting(false);
    }
  }, []);

  const remove = useCallback(async () => {
    setMessage(null);
    try {
      const result = await deleteApiKey();
      setStatus(result);
      setApiKey('');
      setMessage({ tone: 'success', text: 'کلید API حذف شد.' });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'خطا در حذف کلید.' });
    }
  }, []);

  return {
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
  };
}
