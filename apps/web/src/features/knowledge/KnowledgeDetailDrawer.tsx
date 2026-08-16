import { useEffect, useState } from 'react';
import type { KnowledgeDetailResponse, KnowledgeType } from '@freebuff/contracts';
import { fetchKnowledgeDetail } from '../../lib/api';
import { LoadingState } from '../../components/LoadingState';

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

interface KnowledgeDetailDrawerProps {
  knowledgeId: number;
  onClose: () => void;
}

/** Right-side drawer with full traceability of one master knowledge item. */
export function KnowledgeDetailDrawer({ knowledgeId, onClose }: KnowledgeDetailDrawerProps) {
  const [detail, setDetail] = useState<KnowledgeDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchKnowledgeDetail(knowledgeId)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'خطا در دریافت جزئیات دانش.');
      });
    return () => {
      cancelled = true;
    };
  }, [knowledgeId]);

  if (!detail) {
    return (
      <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
        <div
          className="h-full w-full max-w-md overflow-y-auto border-l border-border bg-surface p-5"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-text-primary">جزئیات دانش</h3>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-surface-muted"
            >
              بستن
            </button>
          </div>
          {error ? <p className="text-sm text-red-600">{error}</p> : <LoadingState label="در حال دریافت…" />}
        </div>
      </div>
    );
  }

  const { item, versions, evidence, changes } = detail;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="h-full w-full max-w-md overflow-y-auto border-l border-border bg-surface p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">جزئیات دانش #{item.id}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-2.5 py-1 text-xs text-text-primary hover:bg-surface-muted"
          >
            بستن
          </button>
        </div>

        <div className="space-y-4 text-sm">
          <div className="rounded-lg border border-border bg-surface-muted/50 p-3">
            <p className="text-xs text-text-secondary">{KNOWLEDGE_TYPE_LABEL[item.knowledgeType]}</p>
            <p className="mt-1 leading-relaxed text-text-primary">{item.canonicalText}</p>
            <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-text-secondary">
              {item.entityName && <span className="rounded bg-surface-muted px-1.5 py-0.5">موجودیت: {item.entityName}</span>}
              {item.attribute && <span className="rounded bg-surface-muted px-1.5 py-0.5">ویژگی: {item.attribute}</span>}
              <span className="rounded bg-surface-muted px-1.5 py-0.5">وضعیت: {item.status}</span>
            </div>
            <p className="mt-2 text-[11px] text-text-muted">
              اولین مشاهده: {item.firstSeenAt ? formatDate(item.firstSeenAt) : '—'}
              {item.firstSeenBatchId ? ` (Batch #${item.firstSeenBatchId})` : ''}
              {' · '}آخرین مشاهده: {item.lastSeenAt ? formatDate(item.lastSeenAt) : '—'}
              {item.lastSeenBatchId ? ` (Batch #${item.lastSeenBatchId})` : ''}
            </p>
          </div>

          <div>
            <h4 className="mb-2 text-xs font-semibold text-text-primary">نسخهها</h4>
            <div className="space-y-2">
              {versions.map((version) => (
                <div
                  key={version.id}
                  className="rounded-lg border border-border p-3"
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-text-primary">V{version.versionNumber}</span>
                    {version.isCurrent && (
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                        جاری
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-text-primary">
                    {version.valueText ?? '—'}
                    {version.unit && <span className="text-xs text-text-muted"> {version.unit}</span>}
                  </p>
                  <p className="mt-1 text-[11px] text-text-muted">
                    {formatDate(version.createdAt)} · {version.evidenceCount} منبع
                  </p>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h4 className="mb-2 text-xs font-semibold text-text-primary">تغییرات</h4>
            {changes.length === 0 ? (
              <p className="text-xs text-text-secondary">تغییری ثبت نشده است.</p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {changes.map((change) => (
                  <li key={change.id} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                    <span className="text-text-primary">
                      {change.changeType === 'NEW' ? (
                        <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                          جدید
                        </span>
                      ) : (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                          بهروزرسانی
                        </span>
                      )}
                      {change.oldValue !== null && (
                        <span className="mr-2 text-text-muted line-through">{change.oldValue}</span>
                      )}
                      {change.newValue !== null && <span className="mr-1">{change.newValue}</span>}
                    </span>
                    <span className="shrink-0 text-text-muted">Batch #{change.batchId}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h4 className="mb-2 text-xs font-semibold text-text-primary">شواهد ({evidence.length})</h4>
            {evidence.length === 0 ? (
              <p className="text-xs text-text-secondary">شواهدی ثبت نشده است.</p>
            ) : (
              <ul className="space-y-2">
                {evidence.map((itemEvidence) => (
                  <li key={itemEvidence.id} className="rounded-lg border border-border p-3">
                    <p className="text-xs leading-relaxed text-text-primary" dir="auto">
                      «{itemEvidence.sourceText}»
                    </p>
                    <p className="mt-1 text-[11px] text-text-muted">
                      V{itemEvidence.versionNumber} · {itemEvidence.audioName ?? `Transcript #${itemEvidence.transcriptId}`}
                      {itemEvidence.batchId ? ` · Batch #${itemEvidence.batchId}` : ''} · {formatDate(itemEvidence.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
