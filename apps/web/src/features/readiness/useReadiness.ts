import { useCallback, useEffect, useState } from 'react';
import type { AiReadinessResponse } from '@freebuff/contracts';
import { fetchReadiness } from '../../lib/api';

export function useReadiness() {
  const [readiness, setReadiness] = useState<AiReadinessResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetchReadiness()
      .then((result) => {
        if (cancelled) return;
        setReadiness(result);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : 'خطا در دریافت وضعیت پیکربندی.');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const retry = useCallback(() => {
    setIsLoading(true);
    setLoadError(null);
    void fetchReadiness()
      .then(setReadiness)
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : 'خطا در دریافت وضعیت پیکربندی.');
      })
      .finally(() => setIsLoading(false));
  }, []);

  return { readiness, isLoading, loadError, retry };
}
