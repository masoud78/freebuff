import type { ReactNode } from 'react';

interface SectionCardProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

export function SectionCard({ title, description, icon, actions, children }: SectionCardProps) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-surface shadow-card">
      <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          {icon && (
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-muted text-text-secondary" aria-hidden="true">
              {icon}
            </span>
          )}
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-text-primary">{title}</h2>
            {description && <p className="mt-0.5 text-xs text-text-secondary">{description}</p>}
          </div>
        </div>
        {actions}
      </header>
      <div className="px-5 py-5">{children}</div>
    </section>
  );
}
