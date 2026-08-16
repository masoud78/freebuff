import { AudioLines, MapPin, Settings, Sparkles } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import type { ComponentStatus, SystemStatusState } from '../features/system-status/useSystemStatus';

const NAV_ITEMS = [
  { to: '/', label: 'پردازش جدید', icon: AudioLines, end: true },
  { to: '/destinations', label: 'مقاصد', icon: MapPin, end: false },
  { to: '/settings', label: 'تنظیمات', icon: Settings, end: false },
] as const;

const STATUS_TONE: Record<ComponentStatus, string> = {
  checking: 'bg-warning',
  connected: 'bg-success',
  unavailable: 'bg-danger',
};

const STATUS_TEXT: Record<ComponentStatus, string> = {
  checking: 'در حال بررسی',
  connected: 'Connected',
  unavailable: 'Unavailable',
};

function SidebarStatusRow({ label, status }: { label: string; status: ComponentStatus }) {
  return (
    <li className="flex items-center gap-2">
      <span className={`size-1.5 shrink-0 rounded-full ${STATUS_TONE[status]}`} aria-hidden="true" />
      <span className="hidden text-xs text-text-secondary md:inline">{label}</span>
      <span className="hidden text-xs font-medium text-text-primary md:inline">{STATUS_TEXT[status]}</span>
      <span className="sr-only">
        {label} {STATUS_TEXT[status]}
      </span>
    </li>
  );
}

interface SidebarProps {
  status: SystemStatusState;
}

export function Sidebar({ status }: SidebarProps) {
  return (
    <aside className="flex w-14 shrink-0 flex-col border-e border-border bg-surface md:w-60">
      <div className="flex h-16 items-center gap-2.5 border-b border-border px-3 md:px-5">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-md bg-text-primary text-white"
          aria-hidden="true"
        >
          <Sparkles className="size-4" />
        </span>
        <span className="hidden truncate text-sm font-bold text-text-primary md:inline">
          Freebuff
        </span>
      </div>

      <nav aria-label="ناوبری اصلی" className="flex-1 overflow-y-auto px-2 py-3 md:px-3">
        <ul className="space-y-1">
          {NAV_ITEMS.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.end}
                aria-label={item.label}
                className={({ isActive }) =>
                  `flex items-center justify-center gap-2.5 rounded-md px-2 py-2 text-sm transition-colors md:justify-start md:px-3 ${
                    isActive
                      ? 'bg-surface-muted font-medium text-text-primary'
                      : 'text-text-secondary hover:bg-surface-muted hover:text-text-primary'
                  }`
                }
              >
                <item.icon className="size-4 shrink-0" aria-hidden="true" />
                <span className="hidden truncate md:inline">{item.label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="border-t border-border px-3 py-3 md:px-5">
        <p className="mb-2 hidden text-[11px] font-medium uppercase tracking-wide text-text-muted md:block">
          وضعیت سیستم
        </p>
        <ul className="flex flex-col items-center gap-2 md:items-start">
          <SidebarStatusRow label="Backend" status={status.backend} />
          <SidebarStatusRow label="Database" status={status.database} />
        </ul>
      </div>
    </aside>
  );
}
