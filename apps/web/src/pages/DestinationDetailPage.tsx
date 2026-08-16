import { ArrowRight, MapPin, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { DestinationDetailResponse, KnowledgeType } from '@freebuff/contracts';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import { SectionCard } from '../components/SectionCard';
import { StatusBadge, type StatusTone } from '../components/StatusBadge';
import { fetchDestination } from '../lib/api';

const STATUS_TONE: Record<DestinationDetailResponse['status'], StatusTone> = {
  PROVISIONAL: 'warning',
  CONFIRMED: 'success',
  MERGED: 'neutral',
};

const TYPE_LABEL: Record<DestinationDetailResponse['type'], string> = {
  CITY: 'شهر',
  COUNTRY: 'کشور',
  REGION: 'منطقه',
  OTHER: 'سایر',
};

const KNOWLEDGE_TYPE_LABEL: Record<KnowledgeType, string> = {
  FACT: 'واقعیت',
  CUSTOMER_QUESTION: 'سوال مشتری',
  CUSTOMER_OBJECTION: 'اعتراض مشتری',
  CUSTOMER_NEED: 'نیاز مشتری',
  SALES_INSIGHT: 'بینش فروش',
  RECOMMENDATION: 'پیشنهاد',
  OTHER: 'سایر',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('fa-IR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function confidenceLabel(confidence: number): string {
  const pct = Math.round(confidence * 100);
  return `${pct}%`;
}

export function DestinationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const destinationId = Number(id);
  const [destination, setDestination] = useState<DestinationDetailResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchDestination(destinationId)
      .then((result) => {
        if (!cancelled) setDestination(result);
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setLoadError(error instanceof Error ? error.message : 'خطا در دریافت مقصد.');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [destinationId]);

  const retry = useCallback(() => {
    setIsLoading(true);
    setLoadError(null);
    void fetchDestination(destinationId)
      .then(setDestination)
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : 'خطا در دریافت مقصد.');
      })
      .finally(() => setIsLoading(false));
  }, [destinationId]);

  if (isLoading) {
    return <LoadingState label="در حال دریافت مقصد…" />;
  }

  if (loadError || !destination) {
    return (
      <ErrorState
        message={loadError ?? 'مقصد پیدا نشد.'}
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
    );
  }

  return (
    <>
      <PageHeader
        title={
          <span className="inline-flex items-center gap-3">
            <Link
              to="/destinations"
              className="inline-flex items-center gap-1 text-sm font-normal text-text-secondary transition-colors hover:text-text-primary"
            >
              <ArrowRight className="size-4" aria-hidden="true" />
              مقصدها
            </Link>
            <span>{destination.canonicalName}</span>
          </span>
        }
        description={`${TYPE_LABEL[destination.type]} · اولین مشاهده: ${
          destination.firstSeenBatchId ? `Batch #${destination.firstSeenBatchId}` : '—'
        }`}
      />

      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-4 text-xs text-text-secondary">
          <StatusBadge tone={STATUS_TONE[destination.status]} label={destination.status} />
          <span>
            دانش: <strong className="text-text-primary">{destination.knowledgeCount}</strong>
          </span>
          <span>
            Transcript منبع:{' '}
            <strong className="text-text-primary">{destination.sourceTranscriptCount}</strong>
          </span>
        </div>

        {destination.aliases.length > 0 && (
          <SectionCard
            title="Aliasها"
            description="نام‌های دیگر این مقصد که به‌صورت خودکار شناسایی شده‌اند"
            icon={<MapPin className="size-4" />}
          >
            <div className="flex flex-wrap gap-2">
              {destination.aliases.map((alias) => (
                <span
                  key={alias}
                  dir="ltr"
                  className="rounded-md border border-border bg-surface-muted px-2.5 py-1 text-xs text-text-primary"
                >
                  {alias}
                </span>
              ))}
            </div>
          </SectionCard>
        )}

        <SectionCard
          title="دانش استخراج‌شده"
          description={`${destination.knowledge.length} مورد دانش برای این مقصد`}
        >
          {destination.knowledge.length === 0 ? (
            <p className="py-6 text-center text-sm text-text-secondary">
              هنوز دانشی برای این مقصد استخراج نشده است.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-text-secondary">
                    <th className="px-3 py-2 text-start font-medium">نوع</th>
                    <th className="px-3 py-2 text-start font-medium">موجودیت</th>
                    <th className="px-3 py-2 text-start font-medium">ویژگی</th>
                    <th className="px-3 py-2 text-start font-medium">مقدار فعلی</th>
                    <th className="px-3 py-2 text-start font-medium">اطمینان</th>
                    <th className="px-3 py-2 text-start font-medium">منبع</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {destination.knowledge.map((item) => (
                    <tr key={item.id}>
                      <td className="px-3 py-2.5 text-text-primary">
                        {KNOWLEDGE_TYPE_LABEL[item.knowledgeType]}
                      </td>
                      <td className="px-3 py-2.5 text-text-primary">
                        {item.entityName ?? '—'}
                        {item.entityType && (
                          <span className="text-xs text-text-muted"> ({item.entityType})</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-text-primary">{item.attribute ?? '—'}</td>
                      <td className="px-3 py-2.5 text-text-primary">
                        {item.currentValue}
                        {item.unit && (
                          <span className="text-xs text-text-muted"> {item.unit}</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-text-primary">{confidenceLabel(item.confidence)}</td>
                      <td className="px-3 py-2.5 text-text-secondary">{item.sourceCount} منبع</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Transcriptهای منبع"
          description="مکالماتی که این مقصد در آن‌ها شناسایی شده است"
        >
          {destination.sources.length === 0 ? (
            <p className="py-6 text-center text-sm text-text-secondary">منبعی ثبت نشده است.</p>
          ) : (
            <ul className="divide-y divide-border">
              {destination.sources.map((source) => (
                <li key={source.transcriptId} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-text-primary" dir="ltr">
                      {source.audioName}
                    </p>
                    <p className="text-xs text-text-muted">
                      Batch #{source.batchId} · {formatDate(source.analyzedAt)}
                    </p>
                  </div>
                  <Link
                    to={`/batches/${source.batchId}`}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-muted"
                  >
                    مشاهده Batch
                    <ArrowRight className="size-3.5" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </>
  );
}
