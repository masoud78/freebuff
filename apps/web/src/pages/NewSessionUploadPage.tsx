import { ArrowLeft, FileUp, LoaderCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ErrorState } from '../components/ErrorState';
import { PageHeader } from '../components/PageHeader';
import { uploadNewSession } from '../lib/api';

/**
 * Lazy processing creation: opening this page creates no database session.
 * The session is only persisted once the first audio upload succeeds.
 */
export function NewSessionUploadPage() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: File[]) => {
    if (files.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await uploadNewSession(files);
      navigate(`/sessions/${result.sessionId}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'آپلود ممکن نشد.');
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="پردازش جدید"
        description="ویس‌ها را آپلود کنید؛ پردازش پس از اولین آپلود موفق شروع می‌شود."
        actions={
          <Link
            to="/"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-muted"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            بازگشت
          </Link>
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorState message={error} />
        </div>
      )}

      <section className="rounded-lg border border-border bg-surface p-5 shadow-card">
        <h2 className="text-sm font-semibold text-text-primary">آپلود ویس‌ها</h2>
        <p className="mt-1 text-xs text-text-secondary">
          فایل‌های صوتی را اینجا بکشید یا انتخاب کنید. (mp3, wav, m4a, aac, ogg, flac, webm)
        </p>
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            void handleFiles([...event.dataTransfer.files]);
          }}
          className={`mt-4 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-6 py-10 text-center transition-colors ${
            dragOver ? 'border-accent bg-accent-muted' : 'border-border bg-surface-muted/40 hover:bg-surface-muted'
          } ${busy ? 'pointer-events-none opacity-60' : ''}`}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
          }}
        >
          {busy ? (
            <LoaderCircle className="size-6 animate-spin text-accent" aria-hidden="true" />
          ) : (
            <FileUp className="size-6 text-text-muted" aria-hidden="true" />
          )}
          <p className="text-sm font-medium text-text-primary">
            {busy ? 'در حال آپلود…' : 'فایل‌ها را اینجا رها کنید'}
          </p>
          <p className="text-xs text-text-secondary">یا برای انتخاب فایل کلیک کنید</p>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".mp3,.wav,.m4a,.aac,.ogg,.flac,.webm,audio/*"
            className="hidden"
            onChange={(event) => {
              void handleFiles([...(event.target.files ?? [])]);
              event.target.value = '';
            }}
          />
        </div>
      </section>
    </>
  );
}
