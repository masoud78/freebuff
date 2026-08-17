import { useCallback, useEffect, useState } from 'react';
import type { HealthResponse } from '@freebuff/contracts';
import { fetchHealth } from '../../lib/api';

export type ComponentStatus = 'checking' | 'connected' | 'unavailable';

export interface SystemStatusState {
  backend: ComponentStatus;
  database: ComponentStatus;
}

const UNAVAILABLE_STATE: SystemStatusState = { backend: 'unavailable', database: 'unavailable' };

function stateFromHealth(health: HealthResponse): SystemStatusState {
  return {
    backend: 'connected',
    database: health.database.status === 'connected' ? 'connected' : 'unavailable',
  };
}

const POLL_MS = 3000;

export function useSystemStatus(): { status: SystemStatusState; retry: () => void } {
  const [status, setStatus] = useState<SystemStatusState>({
    backend: 'checking',
    database: 'checking',
  });

  // Keep polling so the status goes online by itself the moment the backend
  // and database come up — no manual refresh needed.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const check = async (): Promise<void> => {
      try {
        const health = await fetchHealth();
        if (!cancelled) setStatus(stateFromHealth(health));
      } catch {
        if (!cancelled) setStatus(UNAVAILABLE_STATE);
      }
      if (!cancelled) timer = setTimeout(() => void check(), POLL_MS);
    };

    void check();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const retry = useCallback(() => {
    setStatus({ backend: 'checking', database: 'checking' });
    void fetchHealth()
      .then((health) => setStatus(stateFromHealth(health)))
      .catch(() => setStatus(UNAVAILABLE_STATE));
  }, []);

  return { status, retry };
}
