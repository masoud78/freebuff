import type { ReactNode } from 'react';

interface LtrProps {
  children: ReactNode;
  className?: string;
}

/**
 * Renders technical content (identifiers, paths, API endpoints, code) in LTR
 * inside the RTL layout. `translate="no"` keeps auto-translation from mangling
 * identifiers.
 */
export function Ltr({ children, className }: LtrProps) {
  return (
    <span dir="ltr" translate="no" className={className}>
      {children}
    </span>
  );
}
