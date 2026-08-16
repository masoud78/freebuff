import { Check, Copy, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type {
  BatchGeneratedContentsResponse,
  BatchUsageResponse,
  GeneratedContentInfo,
} from '@freebuff/contracts';
import { SectionCard } from '../../components/SectionCard';
import {
  fetchBatchGeneratedContents,
  fetchBatchUsage,
  fetchDeltaMetrics,
  regenerateContent,
} from '../../lib/api';

const STAGE_LABEL: Record<string, string> = {
  TRANSCRIPTION: 'تبدیل صوت به متن',
  KNOWLEDGE: 'تحلیل دانش',
  EMBEDDING: 'Embedding',
  CONTENT: 'تولید محتوا',
};

const METRIC_LABEL: Record<string, string> = {
  exact_confirmation_count: 'تأییدهای قطعی (بدون AI)',
  embedding_cache_hit_count: 'Cache Hit های Embedding',
  delta_ai_call_skipped_count: 'مقایسه‌های AI ذخیره‌شده',
  destinations_no_publishable_delta_count: 'مقصدهای بدون دانش جدید',
  content_generation_call_count: 'فراخوانی‌های تولید محتوا',
  content_generation_reuse_count: 'بازاستفادهٔ محتوای قبلی',
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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-text-primary hover:bg-surface-muted"
    >
      {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
      {copied ? 'کپی شد' : 'کپی'}
    </button>
  );
}

function GenerationCard({
  generation,
  latest,
  onRegenerate,
  busy,
}: {
  generation: GeneratedContentInfo;
  latest: boolean;
  onRegenerate: (id: number) => void;
  busy: boolean;
}) {
  return (
    <div className={`rounded-lg border p-3 ${latest ? 'border-accent/40 bg-surface-muted/40' : 'border-border'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <span className="font-medium text-text-primary">نسخهٔ {generation.generationNumber}</span>
          {latest && (
            <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">جدیدترین</span>
          )}
          {generation.status === 'SUPERSEDED' && (
            <span className="rounded bg-surface-muted px-1.5 py-0.5 text-[10px] text-text-muted">قبلی</span>
          )}
          <span>{formatDate(generation.createdAt)}</span>
          <span dir="ltr" className="font-mono text-[10px]">{generation.modelId}</span>
          <span>از {generation.knowledgeCount} دانش</span>
        </div>
        <div className="flex items-center gap-1.5">
          <CopyButton text={generation.content} />
          {latest && (
            <button
              type="button"
              onClick={() => onRegenerate(generation.id)}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-text-primary hover:bg-surface-muted disabled:opacity-50"
            >
              <RefreshCw className={`size-3 ${busy ? 'animate-spin' : ''}`} />
              {busy ? 'در حال صف…' : 'Regenerate'}
            </button>
          )}
        </div>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-text-primary" dir="auto">
        {generation.content}
      </p>
    </div>
  );
}

interface BatchGeneratedContentSectionProps {
  batchId: number;
}

/**
 * Phase 11 — Generated Content + Usage + Optimization for a batch. Content is
 * explicitly scoped to THIS batch's new/updated knowledge (never the whole
 * destination). Usage and metrics show only real DB data — no estimated costs.
 */
export function BatchGeneratedContentSection({ batchId }: BatchGeneratedContentSectionProps) {
  const [contents, setContents] = useState<BatchGeneratedContentsResponse | null>(null);
  const [usage, setUsage] = useState<BatchUsageResponse | null>(null);
  const [metrics, setMetrics] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState<number | null>(null);

  const load = () => {
    Promise.all([
      fetchBatchGeneratedContents(batchId),
      fetchBatchUsage(batchId),
      fetchDeltaMetrics(batchId),
    ])
      .then(([contentsRes, usageRes, metricsRes]) => {
        setContents(contentsRes);
        setUsage(usageRes);
        setMetrics(metricsRes);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'خطا در دریافت محتوای تولیدشده.');
      });
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId]);

  const handleRegenerate = async (contentId: number) => {
    setRegenerating(contentId);
    try {
      await regenerateContent(contentId);
      setTimeout(load, 1200);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'خطا در Regenerate محتوا.');
    } finally {
      setRegenerating(null);
    }
  };

  if (error) {
    return (
      <SectionCard title="Generated Content" description="محتوای تولیدشده از دانش جدید همین Batch">
        <p className="py-4 text-center text-sm text-danger">{error}</p>
      </SectionCard>
    );
  }

  if (contents === null) {
    return (
      <SectionCard title="Generated Content" description="محتوای تولیدشده از دانش جدید همین Batch">
        <p className="py-4 text-center text-sm text-text-secondary">در حال دریافت…</p>
      </SectionCard>
    );
  }

  const shownMetrics = Object.entries(metrics).filter(([, value]) => value > 0);

  return (
    <div className="space-y-4">
      <SectionCard
        title="Generated Content"
        description="این محتوا فقط از دانش جدید/به‌روزشدهٔ همین Batch تولید شده است — محتوای کامل مقصد نیست."
      >
        {contents.destinations.length === 0 ? (
          <p className="py-6 text-center text-sm text-text-secondary">
            هنوز محتوایی برای این Batch تولید نشده است.
          </p>
        ) : (
          <div className="space-y-4">
            {contents.destinations.map((dest) => (
              <div key={dest.destinationId ?? 'null'} className="rounded-lg border border-border p-3">
                <h4 className="mb-2 text-sm font-semibold text-text-primary">
                  {dest.destinationName ?? 'بدون مقصد'}
                </h4>
                {dest.noPublishableDelta || dest.generations.length === 0 ? (
                  <p className="rounded-md bg-surface-muted px-3 py-2 text-xs text-text-secondary">
                    دانش جدید قابل انتشار برای این مقصد در این Batch پیدا نشد.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {dest.generations.map((generation, index) => (
                      <GenerationCard
                        key={generation.id}
                        generation={generation}
                        latest={index === dest.generations.length - 1}
                        onRegenerate={handleRegenerate}
                        busy={regenerating === generation.id}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {usage && Object.keys(usage).length > 0 && (
        <SectionCard title="Usage" description="مصرف واقعی API این Batch بر اساس Stage">
          <div className="overflow-x-auto">
            <table className="w-full text-start text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-text-secondary">
                  <th className="px-3 py-2 text-start font-medium">Stage</th>
                  <th className="px-3 py-2 text-start font-medium">Calls</th>
                  <th className="px-3 py-2 text-start font-medium">Input tokens</th>
                  <th className="px-3 py-2 text-start font-medium">Output tokens</th>
                  <th className="px-3 py-2 text-start font-medium">Cached tokens</th>
                  <th className="px-3 py-2 text-start font-medium">Total tokens</th>
                  <th className="px-3 py-2 text-start font-medium">ناموفق</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {Object.entries(usage).map(([stage, summary]) => (
                  <tr key={stage}>
                    <td className="px-3 py-2.5 text-text-primary">{STAGE_LABEL[stage] ?? stage}</td>
                    <td className="px-3 py-2.5 text-text-primary">{summary.calls}</td>
                    <td className="px-3 py-2.5 text-text-primary" dir="ltr">{summary.inputTokens}</td>
                    <td className="px-3 py-2.5 text-text-primary" dir="ltr">{summary.outputTokens}</td>
                    <td className="px-3 py-2.5 text-text-primary" dir="ltr">{summary.cachedTokens}</td>
                    <td className="px-3 py-2.5 text-text-primary" dir="ltr">{summary.totalTokens}</td>
                    <td className="px-3 py-2.5 text-text-primary">{summary.failedCalls}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      {shownMetrics.length > 0 && (
        <SectionCard title="Optimization" description="صرفه‌جویی واقعی — بدون تخمین قیمت">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {shownMetrics.map(([key, value]) => (
              <div key={key} className="rounded-md border border-border bg-surface-muted px-4 py-3">
                <p className="text-2xl font-semibold text-text-primary">{value}</p>
                <p className="mt-0.5 text-xs text-text-secondary">{METRIC_LABEL[key] ?? key}</p>
              </div>
            ))}
          </div>
        </SectionCard>
      )}
    </div>
  );
}
