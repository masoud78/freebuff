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

export function useSystemStatus(): { status: SystemStatusState; retry: () => void } {
  const [status, setStatus] = useState<SystemStatusState>({
    backend: 'checking',
    database: 'checking',
  });

  useEffect(() => {
    let cancelled = false;

    fetchHealth()
      .then((health) => {
        if (!cancelled) setStatus(stateFromHealth(health));
      })
      .catch(() => {
        if (!cancelled) setStatus(UNAVAILABLE_STATE);
      });

    return () => {
      cancelled = true;
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
