import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CleanTranscriptResponse, DestinationSourceVoiceNotesResponse } from '@freebuff/contracts';
import { formatJalaliDateTime } from '../lib/format';
import { ErrorState } from './ErrorState';
import { LoadingState } from './LoadingState';

interface SourceVoiceDetailModalProps {
  destinationId: number;
  transcriptId: number;
  fileName: string;
  loadTranscript: () => Promise<CleanTranscriptResponse>;
  loadNotes: () => Promise<DestinationSourceVoiceNotesResponse>;
  onClose: () => void;
}

const formatDate = formatJalaliDateTime;

/**
 * Source voice detail: the full conversation plus every note this voice
 * extracted for the destination, rendered complete (never summarized).
 */
export function SourceVoiceDetailModal({
  fileName,
  loadTranscript,
  loadNotes,
  onClose,
}: SourceVoiceDetailModalProps) {
  const [transcript, setTranscript] = useState<CleanTranscriptResponse | null>(null);
  const [notes, setNotes] = useState<DestinationSourceVoiceNotesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([loadTranscript(), loadNotes()])
      .then(([transcriptResult, notesResult]) => {
        if (cancelled) return;
        setTranscript(transcriptResult);
        setNotes(notesResult);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'خطا در دریافت جزئیات ویس منبع.');
      });
    return () => {
      cancelled = true;
    };
  }, [loadTranscript, loadNotes]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={fileName}
    >
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-popover">
        <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-text-primary" dir="ltr">
              {fileName}
            </h2>
            {notes?.processedAt && (
              <p className="mt-0.5 text-xs text-text-secondary">{formatDate(notes.processedAt)}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="بستن"
            className="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-surface-muted hover:text-text-primary"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        <div className="overflow-y-auto px-6 py-5">
          {error ? (
            <ErrorState message={error} />
          ) : !transcript || !notes ? (
            <LoadingState label="در حال دریافت جزئیات…" />
          ) : (
            <div className="space-y-8">
              <section>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
                  متن کامل گفتگو
                </h3>
                {transcript.segments.length === 0 ? (
                  <p className="whitespace-pre-wrap text-sm leading-7 text-text-primary">
                    {transcript.text}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {transcript.segments.map((segment) => (
                      <div key={segment.sequence}>
                        {segment.speaker && (
                          <p className="mb-1 text-xs font-semibold text-text-secondary">
                            {segment.speaker}
                          </p>
                        )}
                        <p className="whitespace-pre-wrap text-sm leading-7 text-text-primary">
                          {segment.text}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
                  نکات استخراج‌شده از این ویس برای این مقصد
                </h3>
                {notes.notes.length === 0 ? (
                  <p className="text-sm text-text-secondary">نکته‌ای برای این مقصد ثبت نشده است.</p>
                ) : (
                  <div className="space-y-5">
                    {notes.notes.map((note, index) => (
                      <article key={index} className="border-b border-border pb-5 last:border-b-0">
                        <h4 className="text-base font-bold leading-8 text-text-primary">{note.title}</h4>
                        <p className="mt-1 whitespace-pre-wrap text-[15px] leading-8 text-text-primary">
                          {note.description}
                        </p>
                        {note.relevantDate && (
                          <p className="mt-2 text-xs text-text-muted">مرتبط با: {note.relevantDate}</p>
                        )}
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
