import { useCallback, useEffect, useRef, useState } from 'react';
import type { BatchDetailResponse } from '@freebuff/contracts';
import { fetchBatch, scanBatch, startBatch } from '../../lib/api';

const ACTIVE_STATUSES = new Set([
  'CREATED',
  'SCANNING',
  'READY',
  'PROCESSING',
  'TRANSCRIBING',
  'ANALYZING',
  'ANALYSIS_COMPLETED',
]);

export function useBatch(batchId: number) {
  const [batch, setBatch] = useState<BatchDetailResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isRescanning, setIsRescanning] = useState(false);
  const [rescanError, setRescanError] = useState<string | null>(null);
  const [rescanMessage, setRescanMessage] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    const result = await fetchBatch(batchId);
    setBatch(result);
    return result;
  }, [batchId]);

  useEffect(() => {
    let cancelled = false;
    fetchBatch(batchId)
      .then((result) => {
        if (cancelled) return;
        setBatch(result);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : 'خطا در دریافت Batch.');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [batchId]);

  // While the batch is being processed, poll every 2s so progress, job
  // states and transcripts appear without a manual refresh.
  const status = batch?.status ?? null;
  useEffect(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (!status || !ACTIVE_STATUSES.has(status)) return;

    const tick = () => {
      void load().catch(() => {
        // Transient poll failures are silent; the next tick retries.
      });
    };
    timerRef.current = window.setInterval(tick, 2000);
    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [status, load]);

  const retryLoad = useCallback(() => {
    setIsLoading(true);
    setLoadError(null);
    void load()
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : 'خطا در دریافت Batch.');
      })
      .finally(() => setIsLoading(false));
  }, [load]);

  const rescan = useCallback(async () => {
    setIsRescanning(true);
    setRescanError(null);
    setRescanMessage(null);
    try {
      const result = await scanBatch(batchId);
      const detail = await fetchBatch(batchId);
      setBatch(detail);
      if (result.stats.newAudio > 0) {
        setRescanMessage(`${result.stats.newAudio} فایل جدید و ${result.stats.duplicates} تکراری ثبت شد.`);
      } else if (result.stats.duplicates > 0) {
        setRescanMessage('فایل جدیدی برای پردازش وجود ندارد؛ همه فایل‌ها تکراری هستند.');
      } else {
        setRescanMessage('هیچ فایل صوتی قابل پردازشی پیدا نشد.');
      }
    } catch (error) {
      setRescanError(error instanceof Error ? error.message : 'خطا در Scan پوشه صوتی.');
    } finally {
      setIsRescanning(false);
    }
  }, [batchId]);

  const start = useCallback(async () => {
    setIsStarting(true);
    setStartError(null);
    try {
      const detail = await startBatch(batchId);
      setBatch(detail);
    } catch (error) {
      setStartError(error instanceof Error ? error.message : 'خطا در شروع پردازش.');
    } finally {
      setIsStarting(false);
    }
  }, [batchId]);

  return {
    batch,
    isLoading,
    loadError,
    isRescanning,
    rescanError,
    rescanMessage,
    isStarting,
    startError,
    retryLoad,
    rescan,
    start,
  };
}
