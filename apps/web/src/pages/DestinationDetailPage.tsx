import { ArrowRight, MapPin, RefreshCw, Search, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  DestinationContentHistoryResponse,
  DestinationDetailResponse,
  KnowledgeChangeInfo,
  KnowledgeConflictInfo,
  KnowledgeType,
  MasterKnowledgeItem,
} from '@freebuff/contracts';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import { SectionCard } from '../components/SectionCard';
import { StatusBadge, type StatusTone } from '../components/StatusBadge';
import { KnowledgeDetailDrawer } from '../features/knowledge/KnowledgeDetailDrawer';
import {
  fetchDestination,
  fetchDestinationChanges,
  fetchDestinationConflicts,
  fetchDestinationContentHistory,
  fetchMasterKnowledge,
  resolveConflict,
} from '../lib/api';

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
  const [masterItems, setMasterItems] = useState<MasterKnowledgeItem[]>([]);
  const [masterTotal, setMasterTotal] = useState(0);
  const [changes, setChanges] = useState<KnowledgeChangeInfo[]>([]);
  const [conflicts, setConflicts] = useState<KnowledgeConflictInfo[]>([]);
  const [contentHistory, setContentHistory] = useState<DestinationContentHistoryResponse | null>(null);
  const [selectedKnowledgeId, setSelectedKnowledgeId] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [isMasterLoading, setIsMasterLoading] = useState(false);
  const [conflictActionId, setConflictActionId] = useState<number | null>(null);

  const loadMaster = useCallback(async (q = '', type = '', status = '') => {
    setIsMasterLoading(true);
    try {
      const master = await fetchMasterKnowledge(destinationId, 100, 0, {
        q: q || undefined,
        knowledgeType: type || undefined,
        status: status || undefined,
      });
      setMasterItems(master.items);
      setMasterTotal(master.total);
    } catch {
      // Silent — the page-level error already covers initial load failures.
    } finally {
      setIsMasterLoading(false);
    }
  }, [destinationId]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchDestination(destinationId),
      fetchMasterKnowledge(destinationId, 100),
      fetchDestinationChanges(destinationId),
      fetchDestinationConflicts(destinationId),
      fetchDestinationContentHistory(destinationId),
    ])
      .then(([dest, master, changeRes, conflictRes, historyRes]) => {
        if (cancelled) return;
        setDestination(dest);
        setMasterItems(master.items);
        setMasterTotal(master.total);
        setChanges(changeRes.changes);
        setConflicts(conflictRes.conflicts);
        setContentHistory(historyRes);
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
    Promise.all([
      fetchDestination(destinationId),
      fetchMasterKnowledge(destinationId, 100),
      fetchDestinationChanges(destinationId),
      fetchDestinationConflicts(destinationId),
      fetchDestinationContentHistory(destinationId),
    ])
      .then(([dest, master, changeRes, conflictRes, historyRes]) => {
        setDestination(dest);
        setMasterItems(master.items);
        setMasterTotal(master.total);
        setChanges(changeRes.changes);
        setConflicts(conflictRes.conflicts);
        setContentHistory(historyRes);
      })
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : 'خطا در دریافت مقصد.');
      })
      .finally(() => setIsLoading(false));
  }, [destinationId]);

  // Debounced master-knowledge search (never a Gemini call).
  useEffect(() => {
    if (isLoading) return;
    const timer = window.setTimeout(() => {
      void loadMaster(search, typeFilter, statusFilter);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search, typeFilter, statusFilter, isLoading, loadMaster]);

  const dismissConflict = async (conflictId: number) => {
    setConflictActionId(conflictId);
    try {
      await resolveConflict(conflictId, 'DISMISS', 'رد دستی توسط کاربر');
      const updated = await fetchDestinationConflicts(destinationId);
      setConflicts(updated.conflicts);
    } catch (error) {
      // Surface a light inline error via the page state.
      setLoadError(error instanceof Error ? error.message : 'رد تعارض با خطا مواجه شد.');
    } finally {
      setConflictActionId(null);
    }
  };

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
          title="Master Knowledge"
          description={`${masterTotal} مورد دانش نهایی و معتبر این مقصد — برای مشاهده نسخه‌ها و شواهد کلیک کنید`}
        >
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-text-muted" aria-hidden="true" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="جستجو در دانش…"
                className="w-full rounded-md border border-border bg-surface py-1.5 pe-8 ps-8 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
                aria-label="جستجو در دانش"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute end-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
                  aria-label="پاک کردن جستجو"
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
            <select
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value)}
              className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none"
              aria-label="فیلتر نوع دانش"
            >
              <option value="">همهٔ انواع</option>
              {(Object.keys(KNOWLEDGE_TYPE_LABEL) as KnowledgeType[]).map((type) => (
                <option key={type} value={type}>
                  {KNOWLEDGE_TYPE_LABEL[type]}
                </option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none"
              aria-label="فیلتر وضعیت"
            >
              <option value="">همهٔ وضعیت‌ها</option>
              <option value="ACTIVE">ACTIVE</option>
              <option value="PROVISIONAL">PROVISIONAL</option>
              <option value="ARCHIVED">ARCHIVED</option>
            </select>
            {isMasterLoading && (
              <span className="text-xs text-text-muted" role="status">
                در حال جستجو…
              </span>
            )}
          </div>
          {masterItems.length === 0 ? (
            <p className="py-6 text-center text-sm text-text-secondary">
              هنوز دانش نهایی (Reconciled) برای این مقصد وجود ندارد.
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
                    <th className="px-3 py-2 text-start font-medium">شواهد</th>
                    <th className="px-3 py-2 text-start font-medium">اولین دیده</th>
                    <th className="px-3 py-2 text-start font-medium">آخرین دیده</th>
                    <th className="px-3 py-2 text-start font-medium">وضعیت</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {masterItems.map((item) => (
                    <tr
                      key={item.id}
                      className="cursor-pointer transition-colors hover:bg-surface-muted/50"
                      onClick={() => setSelectedKnowledgeId(item.id)}
                    >
                      <td className="px-3 py-2.5 text-text-primary">
                        {KNOWLEDGE_TYPE_LABEL[item.knowledgeType]}
                      </td>
                      <td className="px-3 py-2.5 text-text-primary">{item.entityName ?? '—'}</td>
                      <td className="px-3 py-2.5 text-text-primary">{item.attribute ?? '—'}</td>
                      <td className="px-3 py-2.5 text-text-primary">
                        {item.currentValue}
                        {item.unit && <span className="text-xs text-text-muted"> {item.unit}</span>}
                      </td>
                      <td className="px-3 py-2.5 text-text-secondary">{item.evidenceCount}</td>
                      <td className="px-3 py-2.5 text-xs text-text-secondary">
                        {item.firstSeenAt ? formatDate(item.firstSeenAt) : '—'}
                        {item.firstSeenBatchId ? ` (B${item.firstSeenBatchId})` : ''}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-text-secondary">
                        {item.lastSeenAt ? formatDate(item.lastSeenAt) : '—'}
                        {item.lastSeenBatchId ? ` (B${item.lastSeenBatchId})` : ''}
                      </td>
                      <td className="px-3 py-2.5">
                        <StatusBadge
                          tone={item.status === 'ACTIVE' ? 'success' : item.status === 'PROVISIONAL' ? 'warning' : 'neutral'}
                          label={item.status}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="تغییرات اخیر"
          description="تغییرات Publishable (NEW/UPDATE) این مقصد"
        >
          {changes.length === 0 ? (
            <p className="py-6 text-center text-sm text-text-secondary">تغییری ثبت نشده است.</p>
          ) : (
            <ul className="divide-y divide-border">
              {changes.slice(0, 10).map((change) => (
                <li key={change.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-text-primary">{change.canonicalText}</p>
                    <p className="text-xs text-text-muted">
                      {change.changeType === 'NEW' ? (
                        <span className="text-emerald-600">جدید</span>
                      ) : (
                        <span className="text-amber-600">
                          به‌روزرسانی: {change.oldValue ?? '—'} ← {change.newValue ?? '—'}
                        </span>
                      )}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs text-text-primary hover:bg-surface-muted"
                    onClick={() => setSelectedKnowledgeId(change.knowledgeId)}
                  >
                    مشاهده
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="Generated Content"
          description="تاریخچهٔ محتوای تولیدشده از دانش جدید/به‌روزشدهٔ هر Batch"
        >
          {contentHistory === null || contentHistory.batches.length === 0 ? (
            <p className="py-6 text-center text-sm text-text-secondary">
              هنوز محتوایی برای این مقصد تولید نشده است.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {contentHistory.batches.map((batch) => (
                <li key={batch.batchId} className="py-3">
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary" dir="ltr">
                        Batch #{batch.batchId}
                      </p>
                      <p className="mt-0.5 text-xs text-text-muted">
                        {batch.generations.length} نسخه · آخرین:{' '}
                        {batch.generations[0] ? formatDate(batch.generations[0].createdAt) : '—'}
                      </p>
                    </div>
                    <Link
                      to={`/batches/${batch.batchId}`}
                      className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs text-text-primary hover:bg-surface-muted"
                    >
                      مشاهده محتوا
                    </Link>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap rounded-md bg-surface-muted px-3 py-2 text-xs leading-relaxed text-text-secondary" dir="auto">
                    {batch.generations[batch.generations.length - 1]?.content.slice(0, 220)}
                    {(batch.generations[batch.generations.length - 1]?.content.length ?? 0) > 220 ? '…' : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="تعارضات"
          description="ادعاهای متناقضی که به‌صورت خودکار جایگزین نشده‌اند"
        >
          {conflicts.length === 0 ? (
            <p className="py-6 text-center text-sm text-text-secondary">تعارضی ثبت نشده است.</p>
          ) : (
            <ul className="divide-y divide-border">
              {conflicts.map((conflict) => (
                <li key={conflict.id} className="py-3">
                  <div className="flex items-center justify-between gap-4">
                    <p className="text-sm text-text-primary" dir="auto">
                      {conflict.candidateCanonicalText}
                    </p>
                    <div className="flex shrink-0 items-center gap-2">
                      {conflict.status === 'OPEN' && (
                        <button
                          type="button"
                          onClick={() => void dismissConflict(conflict.id)}
                          disabled={conflictActionId === conflict.id}
                          className="rounded-md border border-border px-2.5 py-1 text-xs text-text-primary transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {conflictActionId === conflict.id ? 'در حال رد…' : 'رد این تعارض'}
                        </button>
                      )}
                      <StatusBadge
                        tone={conflict.status === 'OPEN' ? 'danger' : conflict.status === 'RESOLVED' ? 'success' : 'neutral'}
                        label={conflict.status}
                      />
                    </div>
                  </div>
                  <p className="mt-1 text-xs text-text-muted">
                    {conflict.existingValue !== null && (
                      <span>ارزش موجود: {conflict.existingValue} · </span>
                    )}
                    ارزش ادعا: {conflict.candidateValue ?? '—'} · {formatDate(conflict.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

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

      {selectedKnowledgeId !== null && (
        <KnowledgeDetailDrawer
          knowledgeId={selectedKnowledgeId}
          onClose={() => setSelectedKnowledgeId(null)}
        />
      )}
    </>
  );
}
