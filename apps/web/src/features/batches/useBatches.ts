import { useCallback, useEffect, useState } from 'react';
import type { BatchSummary } from '@freebuff/contracts';
import { createBatch, fetchBatches, scanBatch } from '../../lib/api';

export interface NewBatchState {
  phase: 'idle' | 'creating' | 'scanning' | 'done' | 'error';
  message: string | null;
  batchId: number | null;
}

const IDLE: NewBatchState = { phase: 'idle', message: null, batchId: null };

export function useBatches() {
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [newBatch, setNewBatch] = useState<NewBatchState>(IDLE);

  useEffect(() => {
    let cancelled = false;
    fetchBatches()
      .then((result) => {
        if (cancelled) return;
        setBatches(result);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : 'خطا در دریافت Batchها.');
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
    void fetchBatches()
      .then(setBatches)
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : 'خطا در دریافت Batchها.');
      })
      .finally(() => setIsLoading(false));
  }, []);

  /** Create a batch and scan the workspace audio folder in one flow. */
  const createAndScan = useCallback(async (): Promise<BatchSummary | null> => {
    setNewBatch({ phase: 'creating', message: null, batchId: null });
    try {
      const created = await createBatch();
      setNewBatch({ phase: 'scanning', message: null, batchId: created.id });
      const scanned = await scanBatch(created.id);
      setNewBatch({ phase: 'done', message: null, batchId: scanned.id });
      setBatches((prev) => [scanned, ...prev.filter((b) => b.id !== scanned.id)]);
      return scanned;
    } catch (error) {
      setNewBatch({
        phase: 'error',
        message: error instanceof Error ? error.message : 'خطا در ایجاد Batch.',
        batchId: null,
      });
      return null;
    }
  }, []);

  const resetNewBatch = useCallback(() => setNewBatch(IDLE), []);

  return { batches, isLoading, loadError, newBatch, retryLoad, createAndScan, resetNewBatch };
}
