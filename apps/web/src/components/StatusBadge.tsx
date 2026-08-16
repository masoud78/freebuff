export type StatusTone = 'success' | 'warning' | 'danger' | 'neutral';

const TONE_CLASSES: Record<StatusTone, { pill: string; dot: string }> = {
  success: { pill: 'text-success', dot: 'bg-success' },
  warning: { pill: 'text-warning', dot: 'bg-warning' },
  danger: { pill: 'text-danger', dot: 'bg-danger' },
  neutral: { pill: 'text-text-secondary', dot: 'bg-text-muted' },
};

interface StatusBadgeProps {
  tone: StatusTone;
  label: string;
}

export function StatusBadge({ tone, label }: StatusBadgeProps) {
  const classes = TONE_CLASSES[tone];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs font-medium ${classes.pill}`}
    >
      <span className={`size-1.5 rounded-full ${classes.dot}`} aria-hidden="true" />
      {label}
    </span>
  );
}
