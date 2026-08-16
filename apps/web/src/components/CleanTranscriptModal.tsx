import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CleanTranscriptResponse } from '@freebuff/contracts';
import { LoadingState } from './LoadingState';
import { ErrorState } from './ErrorState';

interface CleanTranscriptModalProps {
  title: string;
  load: () => Promise<CleanTranscriptResponse>;
  onClose: () => void;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('fa-IR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** One clean, user-facing transcript: file name, date and the conversation. */
export function CleanTranscriptModal({ title, load, onClose }: CleanTranscriptModalProps) {
  const [data, setData] = useState<CleanTranscriptResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void load()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'خطا در دریافت متن.');
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-popover">
        <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-text-primary" dir="ltr">
              {title}
            </h2>
            {data?.processedAt && (
              <p className="mt-0.5 text-xs text-text-secondary">{formatDate(data.processedAt)}</p>
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
          ) : !data ? (
            <LoadingState label="در حال دریافت متن…" />
          ) : data.segments.length === 0 ? (
            <p className="whitespace-pre-wrap text-sm leading-7 text-text-primary">{data.text}</p>
          ) : (
            <div className="space-y-4">
              {data.segments.map((segment) => (
                <div key={segment.sequence} className="max-w-[85%]">
                  {segment.speaker && (
                    <p className="mb-1 text-xs font-semibold text-text-secondary">{segment.speaker}</p>
                  )}
                  <p className="whitespace-pre-wrap rounded-md bg-surface-muted px-3 py-2 text-sm leading-7 text-text-primary">
                    {segment.text}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
