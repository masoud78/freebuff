# OPERATIONS — راهنمای اجرا و نگهداری

## شروع

```bash
pnpm install
pnpm dev
```

- **Web:** `http://localhost:5173`
- **API:** `http://localhost:8787/api/health`

برای Production:

```bash
pnpm build
pnpm --filter @freebuff/server start   # (با PORT/HOST/LOG_LEVEL دلخواه)
```

## پیکربندی Gemini

1. به صفحهٔ **تنظیمات → Gemini** بروید و کلید API را وارد کنید (دکمهٔ «تست اتصال»).
2. **Models:** برای هر Stage یک مدل انتخاب کنید — تبدیل صوت (Transcription)، تحلیل دانش (Knowledge)، Embedding و تولید محتوا (Content). مدل‌ها فقط از لیست کشف‌شدهٔ Gemini قابل انتخاب‌اند.
3. **Prompts:** برای هر سه نوع (Transcription، Knowledge، Content) یک نسخهٔ فعال با متن ذخیره کنید.
4. **Workspace:** مسیر فضای کاری (پیش‌فرض `./workspace`). پوشهٔ `{workspace}/audio` محل ورود فایل‌های صوتی است.

> صفحهٔ **نمای کلی** و **Preflight** دقیقاً نشان می‌دهند چه چیزی ناقص است. بدون پیکربندی کامل، دکمهٔ «شروع پردازش» Batch با پیام واضح blocked می‌شود (`PIPELINE_NOT_READY`).

## افزودن فایل صوتی و ساخت Batch

1. فایل‌های صوتی (`mp3`, `wav`, `m4a`, `aac`, `ogg`, `flac`, `webm`) را در `{workspace}/audio` بگذارید.
2. صفحهٔ **Batches → ساخت Batch جدید** → **Scan دوباره**.
3. **شروع پردازش** را بزنید. بقیهٔ مراحل (Transcription → Knowledge → Delta → Reconciliation → Batch Delta → Content) **به‌صورت خودکار** ادامه می‌یابد.

## چطور پردازش کار می‌کند

- صف Job پایدار داخل **SQLite** (`jobs`)؛ هیچ Broker خارجی نیست.
- Workerهای دائمی هر ۲ ثانیه Jobهای در انتظار Batchهای فعال را Claim می‌کنند (Concurrency از تنظیم `processing_concurrency`).
- خطاهای موقت (429، 5xx، شبکه) با Backoff تا `max_attempts` دوباره تلاش می‌شوند؛ خطاهای دائمی (کلید نامعتبر، مدل/پرامپت تنظیم‌نشده، دادهٔ ناسالم) FAILED می‌شوند و Loop نمی‌زنند.
- هر مرحله Idempotent است: Retry/Replay هرگز Transcript/Knowledge/Evidence/Version/Content تکراری نمی‌سازد.

## Retry خطاها

- صفحهٔ **Batch Detail** بخش «خطاها» را نشان می‌دهد (نوع Job، کد خطا، پیام، تعداد تلاش).
- دکمهٔ **«Retry موارد ناموفق»** همهٔ Jobهای FAILED و فایل‌های FAILED را به صف برمی‌گرداند و Batch را دوباره فعال می‌کند.
- برای یک فایل خاص هم می‌توانید Retry کنید.

## لغو Batch

- دکمهٔ **«لغو Batch»** فقط Jobهای در انتظار را CANCELLED می‌کند؛ دانش نهایی و محتوای قبلی دست‌نخورده می‌ماند و وضعیت Batch برنمی‌گردد.

## Restart Recovery

- اگر سرور وسط پردازش بسته شود: Jobهای RUNNING مانده در Startup به PENDING برمی‌گردند، Batchهای نیمه‌کاره بازسازی می‌شوند (State از DB Recompute) و Finalization (Summary + Content) دقیقاً یک بار ادامه می‌یابد. کار موفق هرگز دوباره اجرا نمی‌شود.
- Recovery کاملاً از دادهٔ SQLite انجام می‌شود — هیچ حافظهٔ موقتی وجود ندارد.

## فایل‌های مهم کجا ذخیره می‌شوند؟

- **Database:** `workspace/system/database/app.db` (+ فایل‌های WAL: `app.db-wal`, `app.db-shm`)
- **کلید Gemini:** `workspace/system/secrets/gemini.key`
- **فایل‌های صوتی:** `{workspace_path}/audio` (خودتان نگهداری می‌کنید)
- **محتوای تولیدشده/خروجی:** داخل همان Database

همهٔ اینها خارج از Git هستند (`.gitignore`).

## Backup

حداقل این موارد را Backup کنید:

1. **SQLite database** — `workspace/system/database/` (فایل اصلی + WAL)
2. **Credential store** — `workspace/system/secrets/gemini.key`
3. **Audio های Workspace** (اختیاری — با Re-scan دوباره اضافه می‌شوند)

### Backup امن SQLite با WAL

برای کپی یک‌به‌یک فایل DB در حالت WAL از دستور داخلی SQLite استفاده کنید (نه کپی مستقیم فایل در حال اجرا):

```bash
sqlite3 workspace/system/database/app.db "VACUUM INTO '/path/to/backup/app-backup.db'"
```

یا از `sqlite3 .backup` استفاده کنید. اگر بخواهید کپی فایل ساده بگیرید، اول سرور را متوقف کنید.

## عیب‌یابی سریع

| مشکل | اقدام |
|---|---|
| Start blocked با «پیکربندی کامل نیست» | صفحهٔ نمای کلی را ببینید؛ مورد ناقص را از تنظیمات رفع کنید |
| Batch PARTIAL_FAILED | بخش «خطاها» را ببینید؛ «Retry موارد ناموفق» بزنید |
| «کلید API نامعتبر» | در تنظیمات Gemini کلید جدید وارد کنید |
| فایل تکراری ثبت شد | عمدی است — همان SHA-256 قبلاً پردازش شده است |
| Restart وسط پردازش | خودکار ادامه می‌یابد؛ فقط صبر کنید |

## نکات

- هیچ Deployment ابری/CMS/چندکاربره در Scope فعلی نیست — Application محلی و تک‌کاربره است.
- Logging ساخت‌یافته (pino) به stdout: contextهای `batchId`/`audioId`/`jobId`/`destinationId`/`stage` ثبت می‌شوند؛ کلید API، پرامپت کامل و متن کامل Transcript/Content در Logها نمی‌آیند.
