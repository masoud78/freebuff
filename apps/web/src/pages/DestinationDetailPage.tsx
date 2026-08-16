import { FileAudio, History, Lightbulb, RefreshCw, StickyNote, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { DestinationNoteListResponse } from '@freebuff/contracts';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import { SourceVoiceDetailModal } from '../components/SourceVoiceDetailModal';
import { formatJalaliDate, formatJalaliDateTime } from '../lib/format';
import { deleteDestination, fetchDestinationNoteDetail, fetchSourceVoiceNotes, fetchTranscriptById } from '../lib/api';

type Tab = 'notes' | 'insights' | 'sources' | 'logs';
type Filter = 'CURRENT' | 'OUTDATED' | 'ALL';

const KIND_LABEL: Record<string, string> = {
  TOUR_INFO: 'تور',
  DESTINATION_INFO: 'مقصد',
  TRAVELER_GUIDANCE: 'راهنمای مسافر',
};

const FILTER_LABEL: Record<Filter, string> = {
  CURRENT: 'فعال',
  OUTDATED: 'قدیمی',
  ALL: 'همه',
};

const EVENT_LABEL: Record<string, string> = {
  NOTE_ADDED: 'نکته جدید اضافه شد',
  NOTE_UPDATED: 'نکته بروزرسانی شد',
  NOTE_MARKED_OUTDATED: 'نکته قدیمی شد',
};

const formatDate = formatJalaliDate;
const formatDateTime = formatJalaliDateTime;

export function DestinationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const destinationId = Number(id);
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('notes');
  const [filter, setFilter] = useState<Filter>('CURRENT');
  const [detail, setDetail] = useState<DestinationNoteListResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sourceDetail, setSourceDetail] = useState<{ transcriptId: number; fileName: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(
    async (status: Filter) => {
      setIsLoading(true);
      setLoadError(null);
      try {
        const result = await fetchDestinationNoteDetail(destinationId, status);
        setDetail(result);
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : 'خطا در دریافت مقصد.');
      } finally {
        setIsLoading(false);
      }
    },
    [destinationId],
  );

  useEffect(() => {
    let cancelled = false;
    fetchDestinationNoteDetail(destinationId, 'CURRENT')
      .then((result) => {
        if (cancelled) return;
        setDetail(result);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : 'خطا در دریافت مقصد.');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [destinationId]);

  const changeFilter = (next: Filter) => {
    setFilter(next);
    void load(next);
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteDestination(destinationId);
      navigate('/destinations');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'حذف مقصد ممکن نشد.');
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  if (isLoading && !detail) {
    return <LoadingState label="در حال دریافت مقصد…" />;
  }
  if (loadError || !detail) {
    return (
      <ErrorState
        message={loadError ?? 'مقصد در دسترس نیست.'}
        action={
          <button
            type="button"
            onClick={() => void load(filter)}
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
        title={detail.canonicalName}
        description="نکات کاربردی، ویس‌های منبع و تاریخچه تغییرات"
        actions={
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-muted hover:text-text-primary"
          >
            <Trash2 className="size-4" aria-hidden="true" />
            حذف مقصد
          </button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-md border border-border bg-surface p-1">
          {(
            [
              ['notes', 'نکات', StickyNote],
              ['insights', 'دغدغه‌ها و محتوا', Lightbulb],
              ['sources', 'ویس‌های منبع', FileAudio],
              ['logs', 'لاگ تغییرات', History],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm transition-colors ${
                tab === key ? 'bg-accent-muted font-medium text-accent' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              <Icon className="size-4" aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>

        {tab === 'notes' && (
          <div className="flex gap-1 rounded-md border border-border bg-surface p-1">
            {(['CURRENT', 'OUTDATED', 'ALL'] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => changeFilter(key)}
                className={`rounded px-3 py-1.5 text-xs transition-colors ${
                  filter === key ? 'bg-accent-muted font-medium text-accent' : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {FILTER_LABEL[key]}
              </button>
            ))}
          </div>
        )}
      </div>

      {tab === 'notes' && (
        <div className="space-y-6">
          {detail.notes.length === 0 ? (
            <p className="py-10 text-center text-sm text-text-secondary">هنوز نکته‌ای ثبت نشده است.</p>
          ) : (
            detail.notes.map((note) => (
              <article key={note.id} className="border-b border-border pb-6 last:border-b-0">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-bold leading-8 text-text-primary">{note.title}</h2>
                    {KIND_LABEL[note.kind] && (
                      <span className="rounded-full border border-border bg-surface-muted px-2.5 py-0.5 text-xs text-text-muted">
                        {KIND_LABEL[note.kind]}
                      </span>
                    )}
                  </div>
                  {note.status === 'OUTDATED' && (
                    <span className="shrink-0 rounded-full border border-border bg-surface-muted px-2.5 py-0.5 text-xs text-text-muted">
                      قدیمی
                    </span>
                  )}
                </div>
                <p className="mt-2 max-w-prose whitespace-pre-wrap text-[15px] leading-8 text-text-primary">
                  {note.description}
                </p>
                <p className="mt-3 text-xs text-text-muted">
                  {note.relevantDate && <>مرتبط با: {note.relevantDate} · </>}
                  {note.tourSubject && <>تور: {note.tourSubject} · </>}
                  آخرین بروزرسانی: {formatDate(note.lastUpdatedAt)}
                  {note.sourceCount > 0 && <> · {note.sourceCount} منبع</>}
                </p>
              </article>
            ))
          )}
        </div>
      )}

      {tab === 'insights' && (
        <div className="space-y-6">
          {detail.insights.length === 0 ? (
            <p className="py-10 text-center text-sm text-text-secondary">
              هنوز دغدغه یا فرصت محتوایی ثبت نشده است.
            </p>
          ) : (
            detail.insights.map((insight) => (
              <article key={insight.id} className="border-b border-border pb-6 last:border-b-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-bold leading-8 text-text-primary">{insight.title}</h2>
                  <span className="rounded-full border border-border bg-surface-muted px-2.5 py-0.5 text-xs text-text-muted">
                    دغدغه و محتوا
                  </span>
                </div>
                <p className="mt-2 max-w-prose whitespace-pre-wrap text-[15px] leading-8 text-text-primary">
                  {insight.description}
                </p>
                {insight.contentOpportunityTitle && (
                  <div className="mt-3 rounded-md border border-border bg-surface-muted/40 px-4 py-3">
                    <p className="text-xs font-semibold text-text-secondary">فرصت محتوا</p>
                    <p className="mt-1 text-sm font-medium text-text-primary">{insight.contentOpportunityTitle}</p>
                    {insight.contentOpportunityReason && (
                      <p className="mt-1 text-sm leading-7 text-text-secondary">
                        {insight.contentOpportunityReason}
                      </p>
                    )}
                  </div>
                )}
                <p className="mt-3 text-xs text-text-muted">
                  آخرین بروزرسانی: {formatDate(insight.lastUpdatedAt)}
                  {insight.sourceCount > 0 && <> · {insight.sourceCount} منبع</>}
                </p>
              </article>
            ))
          )}
        </div>
      )}

      {tab === 'sources' && (
        <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-card">
          {detail.sources.length === 0 ? (
            <p className="py-10 text-center text-sm text-text-secondary">هنوز ویس منبعی ثبت نشده است.</p>
          ) : (
            <ul className="divide-y divide-border">
              {detail.sources.map((source) => (
                <li key={source.transcriptId} className="flex items-center justify-between gap-4 px-5 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-text-primary" dir="ltr">
                      {source.fileName}
                    </p>
                    <p className="mt-0.5 text-xs text-text-muted">
                      {formatDate(source.processedAt)}
                      {source.noteCount > 0 && <> · {source.noteCount} نکته از این ویس</>}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setSourceDetail({ transcriptId: source.transcriptId, fileName: source.fileName })
                    }
                    className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-muted"
                  >
                    جزئیات و متن کامل
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === 'logs' && (
        <div className="space-y-0">
          {detail.logs.length === 0 ? (
            <p className="py-10 text-center text-sm text-text-secondary">هنوز تغییری ثبت نشده است.</p>
          ) : (
            detail.logs.map((log) => (
              <div key={log.id} className="relative border-s border-border ps-5 pb-6 last:pb-0">
                <span className="absolute -start-1 top-1.5 size-2 rounded-full bg-border-strong" aria-hidden="true" />
                <p className="text-sm font-medium text-text-primary">
                  {formatDateTime(log.createdAt)}
                  {log.noteTitle && <> — {log.noteTitle}</>}
                </p>
                <p className="mt-1 text-xs text-text-secondary">{EVENT_LABEL[log.eventType] ?? log.eventType}</p>
                {log.reason && <p className="mt-2 text-sm leading-7 text-text-primary">دلیل: {log.reason}</p>}
              </div>
            ))
          )}
        </div>
      )}

      {sourceDetail && (
        <SourceVoiceDetailModal
          destinationId={destinationId}
          transcriptId={sourceDetail.transcriptId}
          fileName={sourceDetail.fileName}
          loadTranscript={() => fetchTranscriptById(sourceDetail.transcriptId)}
          loadNotes={() => fetchSourceVoiceNotes(destinationId, sourceDetail.transcriptId)}
          onClose={() => setSourceDetail(null)}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="حذف مقصد"
          description={
            <>
              مقصد <strong className="text-text-primary">«{detail.canonicalName}»</strong> و همهٔ نکات، دغدغه‌ها،
              نسخه‌ها و لاگ‌های آن برای همیشه حذف می‌شوند. فایل‌های صوتی و متن‌های منبع حذف نمی‌شوند.
            </>
          }
          confirmLabel="حذف مقصد"
          busy={deleting}
          onConfirm={() => void handleDelete()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  );
}
