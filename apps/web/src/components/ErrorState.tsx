import type { ReactNode } from 'react';

interface ErrorStateProps {
  message: string;
  action?: ReactNode;
}

export function ErrorState({ message, action }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-4 rounded-md border border-danger-muted bg-danger-muted/40 px-4 py-3"
    >
      <p className="text-sm text-danger">{message}</p>
      {action}
    </div>
  );
}
