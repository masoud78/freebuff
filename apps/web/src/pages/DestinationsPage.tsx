import { MapPin, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DestinationListItem } from '@freebuff/contracts';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import { deleteDestination, fetchDestinationNotes } from '../lib/api';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('fa-IR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

export function DestinationsPage() {
  const [destinations, setDestinations] = useState<DestinationListItem[]>([]);
  const [query, setQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<DestinationListItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(() => {
    setIsLoading(true);
    setLoadError(null);
    void fetchDestinationNotes()
      .then(setDestinations)
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : 'خطا در دریافت مقصدها.');
      })
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchDestinationNotes()
      .then((result) => {
        if (cancelled) return;
        setDestinations(result);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : 'خطا در دریافت مقصدها.');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleDelete = async () => {
    if (!confirm) return;
    setDeleting(true);
    try {
      await deleteDestination(confirm.id);
      setConfirm(null);
      setDestinations((prev) => prev.filter((dest) => dest.id !== confirm.id));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'حذف مقصد ممکن نشد.');
      setConfirm(null);
    } finally {
      setDeleting(false);
    }
  };

  const filtered = destinations.filter((dest) =>
    dest.canonicalName.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <>
      <PageHeader title="مقاصد" description="نکات ذخیره‌شده برای هر مقصد" />

      <div className="relative mb-4">
        <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-text-muted" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="جستجوی مقصد…"
          className="w-full rounded-md border border-border bg-surface py-2 pe-3 ps-9 text-sm text-text-primary placeholder:text-text-muted focus:outline-2 focus:outline-accent"
        />
      </div>

      {isLoading ? (
        <LoadingState label="در حال دریافت مقصدها…" />
      ) : loadError ? (
        <ErrorState
          message={loadError}
          action={
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-muted"
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
              تلاش مجدد
            </button>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<MapPin className="size-5" />}
          title="هنوز مقصدی ثبت نشده است"
          description="پس از پردازش ویس‌ها و اعمال تغییرات، مقصدها اینجا ظاهر می‌شوند."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-card">
          <ul className="divide-y divide-border">
            {filtered.map((destination) => (
              <li key={destination.id} className="flex items-center gap-2 px-5 py-4">
                <button
                  type="button"
                  onClick={() => navigate(`/destinations/${destination.id}`)}
                  className="flex min-w-0 flex-1 items-center justify-between gap-4 text-start transition-colors"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-text-primary">{destination.canonicalName}</p>
                    {destination.lastUpdatedAt && (
                      <p className="mt-0.5 text-xs text-text-muted">
                        آخرین بروزرسانی: {formatDate(destination.lastUpdatedAt)}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 text-xs text-text-secondary">
                    {destination.currentNoteCount} نکته فعلی
                    {destination.outdatedNoteCount > 0 && (
                      <span className="ms-2 text-text-muted">· {destination.outdatedNoteCount} قدیمی</span>
                    )}
                  </div>
                </button>
                <button
                  type="button"
                  aria-label={`حذف ${destination.canonicalName}`}
                  onClick={() => setConfirm(destination)}
                  className="shrink-0 rounded-md p-1.5 text-text-muted transition-colors hover:bg-danger-muted hover:text-danger"
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title="حذف مقصد"
          description={
            <>
              مقصد <strong className="text-text-primary">«{confirm.canonicalName}»</strong> و همهٔ نکات،
              نسخه‌ها و لاگ‌های آن برای همیشه حذف می‌شوند. فایل‌های صوتی و متن‌های منبع حذف نمی‌شوند.
            </>
          }
          confirmLabel="حذف مقصد"
          busy={deleting}
          onConfirm={() => void handleDelete()}
          onCancel={() => setConfirm(null)}
        />
      )}
    </>
  );
}
