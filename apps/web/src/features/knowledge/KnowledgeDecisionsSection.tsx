import { BrainCircuit, ChevronDown, ChevronUp, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CandidateRetrievalDebugResponse,
  DeltaDecision,
  KnowledgeCandidateInfo,
} from '@freebuff/contracts';
import { SectionCard } from '../../components/SectionCard';
import { StatusBadge, type StatusTone } from '../../components/StatusBadge';
import { fetchCandidateRetrievalDebug, fetchDeltaMetrics, fetchKnowledgeDecisions } from '../../lib/api';

const DECISION_TONE: Record<DeltaDecision, StatusTone> = {
  NEW: 'success',
  CONFIRMATION: 'neutral',
  UPDATE: 'warning',
  CONFLICT: 'danger',
  IGNORE: 'neutral',
};

const DECISION_LABEL: Record<DeltaDecision, string> = {
  NEW: 'جدید',
  CONFIRMATION: 'تأیید',
  UPDATE: 'به‌روزرسانی',
  CONFLICT: 'تناقض',
  IGNORE: 'نادیده',
};

interface DeltaStateInfo {
  label: string;
  tone: StatusTone;
}

function deltaState(
  stats: {
    candidatesPending: number;
    candidatesDecided: number;
    candidatesFailed: number;
    deltaPending: number;
    deltaComparing: number;
    deltaFailed: number;
  },
): DeltaStateInfo {
  if (stats.candidatesFailed > 0 || stats.deltaFailed > 0) {
    return { label: 'Failed', tone: 'danger' };
  }
  if (stats.deltaComparing > 0) {
    return { label: 'Comparing', tone: 'warning' };
  }
  if (stats.deltaPending > 0) {
    return { label: 'Delta pending', tone: 'warning' };
  }
  if (stats.candidatesPending > 0) {
    return { label: 'Knowledge extracted', tone: 'warning' };
  }
  if (stats.candidatesDecided > 0) {
    return { label: 'Delta decided', tone: 'success' };
  }
  return { label: '—', tone: 'neutral' };
}

const METRIC_LABELS: Record<string, string> = {
  exact_confirmation_count: 'تأیید دقیق (بدون AI)',
  embedding_cache_hit_count: 'Embedding از کش',
  delta_ai_call_skipped_count: 'Call صرفه‌جویی‌شده',
};

function formatConfidence(value: number | null): string {
  if (value === null) return '—';
  return `${Math.round(value * 100)}%`;
}

function DebugRetrieval({ candidateId }: { candidateId: number }) {
  const [debug, setDebug] = useState<CandidateRetrievalDebugResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDebug(await fetchCandidateRetrievalDebug(candidateId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در دریافت اطلاعات بازیابی.');
    } finally {
      setLoading(false);
    }
  }, [candidateId]);

  const toggle = () => {
    if (!open) void load();
    setOpen((value) => !value);
  };

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={toggle}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary"
      >
        <Search className="size-3.5" aria-hidden="true" />
        بازیابی (Retrieval)
        {open ? <ChevronUp className="size-3.5" aria-hidden="true" /> : <ChevronDown className="size-3.5" aria-hidden="true" />}
      </button>
      {open && (
        <div className="mt-2 rounded-md border border-border bg-surface-muted p-3">
          {loading && <p className="text-xs text-text-secondary">در حال دریافت…</p>}
          {error && <p className="text-xs text-danger">{error}</p>}
          {!loading && debug && (
            <>
              {debug.destinationName && (
                <p className="mb-2 text-xs text-text-secondary">
                  مقصد: <strong className="text-text-primary">{debug.destinationName}</strong>
                </p>
              )}
              {debug.matches.length === 0 ? (
                <p className="text-xs text-text-secondary">هیچ دانش مرتبطی یافت نشد.</p>
              ) : (
                <ul className="space-y-1.5">
                  {debug.matches.map((match) => (
                    <li key={match.knowledgeId} className="flex items-start justify-between gap-3 text-xs">
                      <span className="min-w-0 flex-1 text-text-primary">{match.canonicalText}</span>
                      <span className="shrink-0 text-text-muted" dir="ltr">
                        {match.matchType}
                        {match.similarity !== null ? ` · ${match.similarity.toFixed(3)}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CandidateRow({ candidate }: { candidate: KnowledgeCandidateInfo }) {
  const decision = candidate.decision.decision;
  return (
    <li className="py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-text-primary">{candidate.canonicalText}</p>
          <p className="mt-0.5 text-xs text-text-secondary">
            {candidate.destinationName ? (
              `مقصد: ${candidate.destinationName} · `
            ) : (
              <span className="text-amber-600">مقصد: نامشخص (Unresolved) · </span>
            )}
            <span dir="ltr">#{candidate.id}</span>
            {candidate.valueText ? ` · مقدار: ${candidate.valueText}` : ''}
            {candidate.unit ? ` ${candidate.unit}` : ''}
          </p>
          {decision && (
            <p className="mt-0.5 text-xs text-text-secondary">
              {candidate.decision.reasonCode ? `کد: ${candidate.decision.reasonCode} · ` : ''}
              اطمینان: {formatConfidence(candidate.decision.confidence)}
              {candidate.decision.matchedKnowledgeId !== null && (
                <>
                  {' · '}
                  دانش تطبیق‌شده: {candidate.decision.matchedKnowledgeText ?? `#${candidate.decision.matchedKnowledgeId}`}
                </>
              )}
              {candidate.decision.matchedCandidateId !== null && (
                <> · تأیید Candidate #{candidate.decision.matchedCandidateId}</>
              )}
            </p>
          )}
          <DebugRetrieval candidateId={candidate.id} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {decision ? (
            <StatusBadge tone={DECISION_TONE[decision]} label={DECISION_LABEL[decision]} />
          ) : (
            <StatusBadge tone="neutral" label={candidate.status} />
          )}
        </div>
      </div>
    </li>
  );
}

interface KnowledgeDecisionsSectionProps {
  batchId: number;
  stats: {
    candidatesPending: number;
    candidatesDecided: number;
    candidatesFailed: number;
    deltaPending: number;
    deltaComparing: number;
    deltaFailed: number;
  };
}

export function KnowledgeDecisionsSection({ batchId, stats }: KnowledgeDecisionsSectionProps) {
  const [candidates, setCandidates] = useState<KnowledgeCandidateInfo[]>([]);
  const [metrics, setMetrics] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const active = stats.deltaPending > 0 || stats.deltaComparing > 0 || stats.candidatesPending > 0;

  const load = useCallback(async () => {
    try {
      const [decisions, metricRows] = await Promise.all([
        fetchKnowledgeDecisions(batchId),
        fetchDeltaMetrics(batchId),
      ]);
      setCandidates(decisions.candidates);
      setMetrics(metricRows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در دریافت تصمیم‌های دانش.');
    } finally {
      setIsLoading(false);
    }
  }, [batchId]);

  useEffect(() => {
    let cancelled = false;
    fetchKnowledgeDecisions(batchId)
      .then((result) => {
        if (!cancelled) setCandidates(result.candidates);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'خطا در دریافت تصمیم‌های دانش.');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    void fetchDeltaMetrics(batchId)
      .then((rows) => {
        if (!cancelled) setMetrics(rows);
      })
      .catch(() => {
        // Metrics are optional in the UI.
      });
    return () => {
      cancelled = true;
    };
  }, [batchId]);

  // Poll while delta work is in flight so decisions appear live.
  useEffect(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (!active) return;
    const tick = () => {
      void load().catch(() => {
        // Transient poll failures are silent.
      });
    };
    timerRef.current = window.setInterval(tick, 2000);
    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [active, load]);

  const state = deltaState(stats);
  const decidedCount = candidates.filter((c) => c.decision.decision !== null).length;
  const metricEntries = Object.entries(metrics).filter(([, value]) => value > 0);

  return (
    <SectionCard
      title="Knowledge Decisions"
      description={
        candidates.length > 0
          ? `${candidates.length} Candidate · ${decidedCount} تصمیم`
          : undefined
      }
      icon={<BrainCircuit className="size-4" />}
      actions={<StatusBadge tone={state.tone} label={state.label} />}
    >
      {isLoading ? (
        <p className="py-6 text-center text-sm text-text-secondary">در حال دریافت تصمیم‌ها…</p>
      ) : error && candidates.length === 0 ? (
        <p className="py-6 text-center text-sm text-danger">{error}</p>
      ) : candidates.length === 0 ? (
        <p className="py-6 text-center text-sm text-text-secondary">
          هنوز دانشی برای این Batch استخراج نشده است.
        </p>
      ) : (
        <>
          {metricEntries.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-2">
              {metricEntries.map(([key, value]) => (
                <span
                  key={key}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-muted px-2.5 py-1 text-xs text-text-secondary"
                >
                  {METRIC_LABELS[key] ?? key}: <strong className="text-text-primary">{value}</strong>
                </span>
              ))}
            </div>
          )}
          <ul className="divide-y divide-border">
            {candidates.map((candidate) => (
              <CandidateRow key={candidate.id} candidate={candidate} />
            ))}
          </ul>
        </>
      )}
    </SectionCard>
  );
}
