import { MapPin, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DestinationListResponse, DestinationSummary } from '@freebuff/contracts';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge, type StatusTone } from '../components/StatusBadge';
import { fetchDestinations } from '../lib/api';

const TYPE_TONE: Record<DestinationSummary['type'], StatusTone> = {
  CITY: 'success',
  COUNTRY: 'neutral',
  REGION: 'warning',
  OTHER: 'neutral',
};

const STATUS_TONE: Record<DestinationSummary['status'], StatusTone> = {
  PROVISIONAL: 'warning',
  CONFIRMED: 'success',
  MERGED: 'neutral',
};

const TYPE_LABEL: Record<DestinationSummary['type'], string> = {
  CITY: 'شهر',
  COUNTRY: 'کشور',
  REGION: 'منطقه',
  OTHER: 'سایر',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('fa-IR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

export function DestinationsPage() {
  const [destinations, setDestinations] = useState<DestinationListResponse>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    fetchDestinations()
      .then((result) => {
        if (!cancelled) setDestinations(result);
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setLoadError(error instanceof Error ? error.message : 'خطا در دریافت مقصدها.');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const retry = () => {
    setIsLoading(true);
    setLoadError(null);
    void fetchDestinations()
      .then(setDestinations)
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : 'خطا در دریافت مقصدها.');
      })
      .finally(() => setIsLoading(false));
  };

  return (
    <>
      <PageHeader
        title="مقصدها"
        description="مقصدهای شناسایی‌شده از Transcriptها و دانش استخراج‌شده برای هر یک"
      />

      {isLoading ? (
        <LoadingState label="در حال دریافت مقصدها…" />
      ) : loadError ? (
        <ErrorState
          message={loadError}
          action={
            <button
              type="button"
              onClick={retry}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-muted"
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
              تلاش مجدد
            </button>
          }
        />
      ) : destinations.length === 0 ? (
        <EmptyState
          icon={<MapPin className="size-5" />}
          title="هنوز مقصدی شناسایی نشده است"
          description="پس از تکمیل تحلیل دانش، مقصدهای هر Transcript در اینجا نمایش داده می‌شوند."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-card">
          <ul className="divide-y divide-border">
            {destinations.map((destination) => (
              <li key={destination.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/destinations/${destination.id}`)}
                  className="flex w-full items-center justify-between gap-4 px-5 py-4 text-start transition-colors hover:bg-surface-muted"
                >
                  <div className="flex min-w-0 items-center gap-4">
                    <span className="shrink-0 text-sm font-semibold text-text-primary">
                      {destination.canonicalName}
                    </span>
                    <StatusBadge tone={TYPE_TONE[destination.type]} label={TYPE_LABEL[destination.type]} />
                    {destination.aliases.length > 0 && (
                      <span className="hidden truncate text-xs text-text-muted md:inline" dir="ltr">
                        {destination.aliases.join('، ')}
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-5 text-xs text-text-secondary">
                    <StatusBadge tone={STATUS_TONE[destination.status]} label={destination.status} />
                    <span>
                      دانش: <strong className="text-text-primary">{destination.knowledgeCount}</strong>
                    </span>
                    <span>
                      منبع: <strong className="text-text-primary">{destination.sourceTranscriptCount}</strong>
                    </span>
                    <span className="hidden text-text-muted sm:inline">
                      {formatDate(destination.createdAt)}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
