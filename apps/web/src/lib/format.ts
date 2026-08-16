/**
 * Shared Jalali (Persian) date formatters. The application renders dates via
 * `Intl` with the `fa-IR` locale; these helpers keep that formatting in one
 * place instead of duplicating it across pages.
 */

/** Date only, e.g. «۲۵ مرداد ۱۴۰۵». */
export function formatJalaliDate(iso: string | Date): string {
  const value = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(value.getTime())) return '—';
  return value.toLocaleDateString('fa-IR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/** Date and time, e.g. «۲۵ مرداد ۱۴۰۵، ۱۴:۳۰». */
export function formatJalaliDateTime(iso: string | Date): string {
  const value = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(value.getTime())) return '—';
  return value.toLocaleDateString('fa-IR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
