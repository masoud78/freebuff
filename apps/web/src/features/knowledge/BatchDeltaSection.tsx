import { useEffect, useState } from 'react';
import type {
  BatchDeltaResponse,
  BatchDestinationSummaryInfo,
  KnowledgeType,
} from '@freebuff/contracts';
import { SectionCard } from '../../components/SectionCard';
import { fetchBatchDelta, fetchBatchDestinationSummaries } from '../../lib/api';

const KNOWLEDGE_TYPE_LABEL: Record<KnowledgeType, string> = {
  FACT: 'واقعیت',
  CUSTOMER_QUESTION: 'سوال مشتری',
  CUSTOMER_OBJECTION: 'اعتراض مشتری',
  CUSTOMER_NEED: 'نیاز مشتری',
  SALES_INSIGHT: 'بینش فروش',
  RECOMMENDATION: 'پیشنهاد',
  OTHER: 'سایر',
};

interface BatchDeltaSectionProps {
  batchId: number;
}

/**
 * Phase 10 — Batch Knowledge Delta. Shows the per-destination summaries and
 * the exact publishable NEW/UPDATE list that Phase 11 content generation will
 * consume. CONFIRMATION / CONFLICT / IGNORE never appear here.
 */
export function BatchDeltaSection({ batchId }: BatchDeltaSectionProps) {
  const [summaries, setSummaries] = useState<BatchDestinationSummaryInfo[] | null>(null);
  const [delta, setDelta] = useState<BatchDeltaResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchBatchDestinationSummaries(batchId), fetchBatchDelta(batchId)])
      .then(([summaryRes, deltaRes]) => {
        if (cancelled) return;
        setSummaries(summaryRes.summaries);
        setDelta(deltaRes);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'خطا در دریافت Delta.');
      });
    return () => {
      cancelled = true;
    };
  }, [batchId]);

  if (error) {
    return (
      <SectionCard title="Batch Knowledge Delta" description="نتیجه اعمال تصمیم‌ها روی Master Knowledge">
        <p className="py-4 text-center text-sm text-danger">{error}</p>
      </SectionCard>
    );
  }

  if (summaries === null) {
    return (
      <SectionCard title="Batch Knowledge Delta" description="نتیجه اعمال تصمیم‌ها روی Master Knowledge">
        <p className="py-4 text-center text-sm text-text-secondary">در حال دریافت…</p>
      </SectionCard>
    );
  }

  const publishable =
    delta?.destinations.reduce((acc, dest) => acc + dest.items.length, 0) ?? 0;

  return (
    <SectionCard
      title="Batch Knowledge Delta"
      description={`${publishable} تغییر Publishable (NEW/UPDATE) — ورودی مستقیم تولید محتوا در فاز بعد`}
    >
      {summaries.length === 0 ? (
        <p className="py-6 text-center text-sm text-text-secondary">
          هنوز نتیجه‌ای برای این Batch ثبت نشده است.
        </p>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {summaries.map((summary) => (
              <div key={summary.destinationId} className="rounded-lg border border-border bg-surface-muted p-3">
                <p className="truncate text-sm font-medium text-text-primary">{summary.destinationName}</p>
                <div className="mt-2 space-y-0.5 text-xs text-text-secondary">
                  <p>
                    جدید: <strong className="text-text-primary">{summary.newCount}</strong> · به‌روز:{' '}
                    <strong className="text-text-primary">{summary.updatedCount}</strong>
                  </p>
                  <p>
                    تأیید: <strong className="text-text-primary">{summary.confirmationCount}</strong> · تعارض:{' '}
                    <strong className="text-text-primary">{summary.conflictCount}</strong> · نادیده:{' '}
                    <strong className="text-text-primary">{summary.ignoredCount}</strong>
                  </p>
                </div>
              </div>
            ))}
          </div>

          {delta && delta.destinations.length > 0 && (
            <div className="space-y-4">
              {delta.destinations.map((dest) => (
                <div key={dest.destinationId ?? 'null'} className="rounded-lg border border-border p-3">
                  <h4 className="mb-2 text-sm font-semibold text-text-primary">
                    {dest.destinationName ?? 'بدون مقصد'}
                  </h4>
                  {dest.items.length === 0 ? (
                    <p className="text-xs text-text-secondary">تغییری ندارد.</p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {dest.items.map((item) => (
                        <li key={item.changeId} className="flex items-center justify-between gap-3 py-2 text-sm">
                          <div className="min-w-0">
                            <p className="truncate text-text-primary" dir="auto">
                              {item.canonicalText}
                            </p>
                            <p className="text-xs text-text-muted">
                              {KNOWLEDGE_TYPE_LABEL[item.knowledgeType]}
                              {item.entityName ? ` · ${item.entityName}` : ''}
                              {item.attribute ? ` · ${item.attribute}` : ''}
                              {item.unit ? ` · ${item.currentValue} ${item.unit}` : ''}
                            </p>
                          </div>
                          <span
                            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                              item.changeType === 'NEW'
                                ? 'bg-emerald-100 text-emerald-700'
                                : 'bg-amber-100 text-amber-700'
                            }`}
                          >
                            {item.changeType === 'NEW' ? 'NEW' : 'UPDATE'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}

          {publishable === 0 && (
            <p className="py-2 text-center text-xs text-text-secondary">
              هیچ تغییر Publishable‌ای در این Batch وجود ندارد (همه تصمیم‌ها تأیید/تعارض/نادیده بودند).
            </p>
          )}
        </div>
      )}
    </SectionCard>
  );
}
