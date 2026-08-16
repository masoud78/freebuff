import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
}

export function EmptyState({ icon, title, description }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border px-6 py-10 text-center">
      {icon && <span className="text-text-muted" aria-hidden="true">{icon}</span>}
      <p className="text-sm font-medium text-text-primary">{title}</p>
      {description && <p className="max-w-md text-xs leading-relaxed text-text-secondary">{description}</p>}
    </div>
  );
}
