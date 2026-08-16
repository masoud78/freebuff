import { Outlet, useOutletContext } from 'react-router-dom';
import { useSystemStatus, type SystemStatusState } from '../features/system-status/useSystemStatus';
import { Sidebar } from './Sidebar';

interface AppShellContext {
  status: SystemStatusState;
  retry: () => void;
}

export function useAppShellContext(): AppShellContext {
  return useOutletContext<AppShellContext>();
}

export function AppShell() {
  const { status, retry } = useSystemStatus();

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <a
        href="#main-content"
        className="sr-only rounded-md bg-surface px-3 py-2 text-sm font-medium text-text-primary focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-50 focus:shadow-popover"
      >
        پرش به محتوای اصلی
      </a>

      <Sidebar status={status} />

      <main id="main-content" className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-8 md:px-10">
          <Outlet context={{ status, retry }} />
        </div>
      </main>
    </div>
  );
}
