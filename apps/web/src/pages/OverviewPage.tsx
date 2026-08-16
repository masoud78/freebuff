import { AlertTriangle, CheckCircle2, Layers, MapPin, RefreshCw, ShieldAlert, Sparkles, WalletCards } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ApiUsageStage, OverviewResponse } from '@freebuff/contracts';
import { useAppShellContext } from '../components/AppShell';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import { SectionCard } from '../components/SectionCard';
import { StatusBadge, type StatusTone } from '../components/StatusBadge';
import { fetchOverview } from '../lib/api';

const BATCH_TONE: Record<string, StatusTone> = {
  CREATED: 'neutral',
  SCANNING: 'warning',
  READY: 'success',
  PROCESSING: 'warning',
  TRANSCRIBING: 'warning',
  ANALYZING: 'warning',
  DELTA_PROCESSING: 'warning',
  RECONCILING: 'warning',
  ANALYSIS_COMPLETED: 'success',
  KNOWLEDGE_READY: 'success',
  GENERATING_CONTENT: 'warning',
  COMPLETED: 'success',
  PARTIAL_FAILED: 'warning',
  FAILED: 'danger',
  CANCELLED: 'neutral',
};

const STAGE_LABEL: Record<string, string> = {
  TRANSCRIPTION: 'تبدیل صوت به متن',
  KNOWLEDGE_ANALYSIS: 'تحلیل دانش',
  DELTA_ANALYSIS: 'مقایسهٔ دانش',
  RECONCILIATION: 'اعمال روی دانش نهایی',
  KNOWLEDGE_READY: 'آمادهٔ تولید محتوا',
  CONTENT_GENERATION: 'تولید محتوا',
  COMPLETED: 'تکمیل شده',
  PARTIAL_FAILED: 'ناقص',
  FAILED: 'ناموفق',
  CANCELLED: 'لغو شده',
};

const USAGE_STAGE_LABEL: Record<ApiUsageStage, string> = {
  TRANSCRIPTION: 'تبدیل صوت به متن',
  KNOWLEDGE: 'تحلیل دانش',
  EMBEDDING: 'Embedding',
  CONTENT: 'تولید محتوا',
};

function formatNumber(value: number): string {
  return value.toLocaleString('fa-IR');
}

function Stat({ icon, label, value, tone = 'text-text-primary' }: { icon: React.ReactNode; label: string; value: number | string; tone?: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-muted px-4 py-3">
      <div className="flex items-center gap-2 text-text-secondary">
        {icon}
        <p className="text-xs">{label}</p>
      </div>
      <p className={`mt-1 text-2xl font-semibold ${tone}`}>{value}</p>
    </div>
  );
}

export function OverviewPage() {
  const { status, retry: retryStatus } = useAppShellContext();
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchOverview()
      .then(setOverview)
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : 'خطا در دریافت نمای کلی.');
      })
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const retry = () => {
    retryStatus();
    setIsLoading(true);
    setLoadError(null);
    void load();
  };

  if (isLoading) {
    return <LoadingState label="در حال دریافت نمای کلی…" />;
  }

  if (loadError || !overview) {
    return (
      <ErrorState
        message={loadError ?? 'نمای کلی در دسترس نیست.'}
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

  const usageEntries = (Object.entries(overview.usage) as [ApiUsageStage, { calls: number; failedCalls: number; inputTokens: number; outputTokens: number }][]).filter(
    ([, value]) => value.calls > 0,
  );

  return (
    <>
      <PageHeader title="نمای کلی" description="وضعیت زیرساخت، پردازش و پیکربندی هوش مصنوعی" />

      <div className="space-y-4">
        <SectionCard
          title="وضعیت سیستم"
          description="بررسی زنده Backend و Database از طریق Health API"
        >
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <span className={`inline-flex items-center gap-2 font-medium ${status.backend === 'connected' ? 'text-success' : 'text-danger'}`}>
              <span className={`size-2 rounded-full ${status.backend === 'connected' ? 'bg-success' : 'bg-danger'}`} aria-hidden="true" />
              Backend: {status.backend === 'connected' ? 'متصل' : 'در دسترس نیست'}
            </span>
            <span className={`inline-flex items-center gap-2 font-medium ${status.database === 'connected' ? 'text-success' : 'text-danger'}`}>
              <span className={`size-2 rounded-full ${status.database === 'connected' ? 'bg-success' : 'bg-danger'}`} aria-hidden="true" />
              Database: {status.database === 'connected' ? 'متصل' : 'در دسترس نیست'}
            </span>
          </div>
        </SectionCard>

        <SectionCard
          title="پیکربندی پردازش"
          description={overview.ready ? 'همهٔ پیش‌نیازهای پردازش آماده است.' : 'برای شروع پردازش، موارد زیر را تکمیل کنید.'}
        >
          {overview.ready ? (
            <div className="flex items-center gap-2 text-sm font-medium text-success">
              <CheckCircle2 className="size-4" aria-hidden="true" />
              آمادهٔ پردازش — می‌توانید Batch جدید بسازید.
            </div>
          ) : (
            <ul className="space-y-2">
              {overview.readinessIssues.map((issue) => (
                <li key={issue.key} className="flex items-start gap-2 text-sm">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
                  <span className="text-text-primary">{issue.message}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat icon={<MapPin className="size-3.5" aria-hidden="true" />} label="مقصدها" value={formatNumber(overview.destinationsCount)} />
          <Stat icon={<Sparkles className="size-3.5" aria-hidden="true" />} label="دانش نهایی (Master)" value={formatNumber(overview.masterKnowledgeCount)} />
          <Stat
            icon={<ShieldAlert className="size-3.5" aria-hidden="true" />}
            label="تعارض باز"
            value={formatNumber(overview.openConflictsCount)}
            tone={overview.openConflictsCount > 0 ? 'text-warning' : 'text-text-primary'}
          />
          <Stat icon={<Layers className="size-3.5" aria-hidden="true" />} label="Batchها" value={formatNumber(overview.totalBatches)} />
        </div>

        <SectionCard
          title="Batchهای اخیر"
          description={overview.processingBatches > 0 ? `${formatNumber(overview.processingBatches)} Batch در حال پردازش` : undefined}
        >
          {overview.recentBatches.length === 0 ? (
            <EmptyState
              icon={<Layers className="size-5" />}
              title="هنوز Batchی ساخته نشده است"
              description="یک Batch جدید بسازید و پردازش را شروع کنید."
            />
          ) : (
            <ul className="divide-y divide-border">
              {overview.recentBatches.map((batch) => (
                <li key={batch.id}>
                  <Link
                    to={`/batches/${batch.id}`}
                    className="flex items-center justify-between gap-4 px-1 py-3 transition-colors hover:bg-surface-muted/50"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-text-primary" dir="ltr">
                        Batch #{batch.id}
                      </p>
                      <p className="mt-0.5 text-xs text-text-secondary">
                        {batch.currentStage ? STAGE_LABEL[batch.currentStage] ?? batch.currentStage : '—'} ·{' '}
                        {batch.transcribed}/{batch.totalAudio} صوت · {batch.contentGenerated} محتوا
                      </p>
                    </div>
                    <StatusBadge tone={BATCH_TONE[batch.status] ?? 'neutral'} label={batch.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="مصرف API (همه‌زمان)"
          description="توکن‌ها و تعداد فراخوانی‌های واقعی به تفکیک مرحله"
          icon={<WalletCards className="size-4" aria-hidden="true" />}
        >
          {usageEntries.length === 0 ? (
            <p className="py-6 text-center text-sm text-text-secondary">
              هنوز مصرف API ثبت نشده است.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-text-secondary">
                    <th className="px-3 py-2 text-start font-medium">مرحله</th>
                    <th className="px-3 py-2 text-start font-medium">فراخوانی</th>
                    <th className="px-3 py-2 text-start font-medium">ناموفق</th>
                    <th className="px-3 py-2 text-start font-medium">توکن ورودی</th>
                    <th className="px-3 py-2 text-start font-medium">توکن خروجی</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {usageEntries.map(([stage, value]) => (
                    <tr key={stage}>
                      <td className="px-3 py-2.5 text-text-primary">{USAGE_STAGE_LABEL[stage]}</td>
                      <td className="px-3 py-2.5 text-text-secondary">{formatNumber(value.calls)}</td>
                      <td className="px-3 py-2.5 text-text-secondary">{formatNumber(value.failedCalls)}</td>
                      <td className="px-3 py-2.5 text-text-secondary" dir="ltr">{formatNumber(value.inputTokens)}</td>
                      <td className="px-3 py-2.5 text-text-secondary" dir="ltr">{formatNumber(value.outputTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      </div>
    </>
  );
}
