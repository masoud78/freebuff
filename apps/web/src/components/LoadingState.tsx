import { LoaderCircle } from 'lucide-react';

interface LoadingStateProps {
  label?: string;
}

export function LoadingState({ label = 'در حال بارگذاری…' }: LoadingStateProps) {
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 py-10 text-sm text-text-secondary"
    >
      <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
