import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { KnowledgeType, TranscriptKnowledgeInfo, TranscriptResponse } from '@freebuff/contracts';
import { fetchTranscript, fetchTranscriptKnowledge } from '../../lib/api';
import { LoadingState } from '../../components/LoadingState';
import { ErrorState } from '../../components/ErrorState';

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
  return new Date(iso).toLocaleString('fa-IR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface TranscriptModalProps {
  batchId: number;
  audioId: number;
  audioName: string;
  onClose: () => void;
}

export function TranscriptModal({ batchId, audioId, audioName, onClose }: TranscriptModalProps) {
  const [data, setData] = useState<TranscriptResponse | null>(null);
  const [knowledge, setKnowledge] = useState<TranscriptKnowledgeInfo | null>(null);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchTranscript(batchId, audioId)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'خطا در دریافت Transcript.');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    // Knowledge analysis is optional for a transcript — missing means it was
    // not analyzed yet (or the transcript is a duplicate), which is fine.
    fetchTranscriptKnowledge(batchId, audioId)
      .then((result) => {
        if (!cancelled) setKnowledge(result);
      })
      .catch(() => {
        if (!cancelled) setKnowledgeError('تحلیل دانش هنوز انجام نشده است.');
      });
    return () => {
      cancelled = true;
    };
  }, [batchId, audioId]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Transcript ${audioName}`}
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-text-primary" dir="ltr">
              {audioName}
            </h2>
            {data && (
              <p className="mt-0.5 text-xs text-text-secondary">
                {data.transcript.modelId} · نسخه پرامپت #{data.transcript.promptVersionId} ·{' '}
                {formatDate(data.transcript.createdAt)}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-muted"
          >
            <X className="size-3.5" aria-hidden="true" />
            بستن
          </button>
        </div>

        <div className="overflow-y-auto p-5">
          {isLoading && <LoadingState label="در حال دریافت Transcript…" />}
          {error && !isLoading && <ErrorState message={error} />}
          {data && (
            <div className="space-y-5">
              {knowledge && (knowledge.destinations.length > 0 || knowledge.knowledge.length > 0) && (
                <div className="space-y-4 rounded-md border border-border bg-surface-muted p-4">
                  <div>
                    <p className="mb-2 text-xs font-medium text-text-secondary">مقصدهای شناسایی‌شده</p>
                    {knowledge.destinations.length === 0 ? (
                      <p className="text-sm text-text-secondary">مقصدی شناسایی نشده است.</p>
                    ) : (
                      <ul className="flex flex-wrap gap-2">
                        {knowledge.destinations.map((destination) => (
                          <li
                            key={destination.id}
                            className="rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-text-primary"
                          >
                            {destination.canonicalName}
                            <span className="text-text-muted"> · {Math.round(destination.confidence * 100)}%</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div>
                    <p className="mb-2 text-xs font-medium text-text-secondary">دانش استخراج‌شده</p>
                    {knowledge.knowledge.length === 0 ? (
                      <p className="text-sm text-text-secondary">دانشی استخراج نشده است.</p>
                    ) : (
                      <ul className="space-y-2">
                        {knowledge.knowledge.map((item) => (
                          <li key={item.id} className="rounded-md border border-border bg-surface px-3 py-2">
                            <p className="text-xs font-medium text-text-secondary">
                              {KNOWLEDGE_TYPE_LABEL[item.knowledgeType]}
                              {item.entityName && ` · ${item.entityName}`}
                              {item.attribute && ` · ${item.attribute}`}
                              {item.currentValue && (
                                <span className="text-text-primary"> = {item.currentValue}</span>
                              )}
                              {item.unit && <span className="text-text-muted"> {item.unit}</span>}
                            </p>
                            <p className="mt-1 text-sm leading-6 text-text-primary">{item.canonicalText}</p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
              {knowledgeError && (
                <p className="text-xs text-text-muted">{knowledgeError}</p>
              )}
              <div className="space-y-3">
                {data.segments.map((segment) => (
                  <div key={segment.id} className="rounded-md border border-border bg-surface-muted p-3">
                    {segment.speaker && (
                      <p className="mb-1 text-xs font-medium text-text-secondary">{segment.speaker}</p>
                    )}
                    <p className="text-sm leading-7 text-text-primary">{segment.text}</p>
                  </div>
                ))}
              </div>
              <div className="rounded-md border border-border bg-surface-muted p-4">
                <p className="mb-1 text-xs text-text-secondary">متن کامل</p>
                <p className="text-sm leading-7 whitespace-pre-wrap text-text-primary">{data.transcript.fullText}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
