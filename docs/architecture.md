# معماری — Freebuff

## چیدمان

| مسیر                 | نقش                                                        |
| -------------------- | ---------------------------------------------------------- |
| `apps/web`           | UI مرورگر — React 19، Vite، Tailwind CSS v4، Lucide        |
| `apps/server`        | API — Fastify 5، pino (logging)، zod (validation)، SQLite + Drizzle |
| `packages/contracts` | Schemaهای مشترک (Zod) و تایپ‌های API بین web و server      |

## لایه سرویس‌های سرور

| مسیر                     | نقش                                              |
| ------------------------ | ------------------------------------------------ |
| `services/settings.*`    | تنظیمات عمومی (workspace، concurrency)           |
| `services/gemini/`       | CredentialStore، GeminiGateway و GeminiService   |
| `services/models.service`| انتخاب مدل هر Stage (کش‌شده از Gemini)           |
| `services/prompts.service` | پرامپت‌های نسخه‌دار (تاریخچه + فعال‌سازی)      |
| `services/readiness.service` | آمادگی کامل پیکربندی AI                      |
| `services/batches.service`   | چرخه Batch: ساخت، Scan، محاسبه State          |
| `services/audio-ingestion.service` | کشف فایل، هش SHA-256، تشخیص Duplicate |
| `services/jobs.service`      | صف Job پایدار در SQLite + Recovery           |
| `services/transcripts.service` | خواندن Transcript و Segments برای UI        |
| `services/transcription/`    | نرمال‌سازی/تقسیم‌بندی متن + Worker واقعی Transcription |
| `services/workspace-paths`   | مسیرهای مرکزی Workspace (`{ws}/audio`)       |

همه ارتباط با Gemini فقط از `GeminiGateway` عبور می‌کند؛ خطاها به کدهای پایدار (`GEMINI_*`) نرمال می‌شوند و SDK هرگز در Feature Moduleها استفاده نمی‌شود. کلید API در `workspace/system/secrets/gemini.key` (خارج از Git) نگهداری می‌شود و هیچ‌وقت در پاسخ‌ها یا Logها ظاهر نمی‌شود.

## قراردادهای اصلی

- **Contracts:** هر دو سمت، شکل Response را فقط از `packages/contracts` می‌گیرند؛ هیچ تایپ API جداگانه/تکراری در web یا server تعریف نمی‌شود. این پکیج کد runtime دارد (Zod) تا هر دو سمت با یک Schema اعتبارسنجی کنند؛ برای تایپ‌های خالص همچنان `import type` استفاده می‌شود.
- **تنظیمات توسعه (web):** آدرس Backend هرگز داخل کامپوننت‌ها hardcode نمی‌شود. مقدار از `VITE_API_BASE_URL` (فایل `apps/web/.env.development`) خوانده می‌شود؛ مقدار خالی یعنی same-origin و Vite درخواست `/api` را به `http://127.0.0.1:8787` پراکسی می‌کند (`vite.config.ts`).
- **تنظیمات توسعه (server):** پورت، host و سطح log با متغیرهای محیطی `PORT`، `HOST` و `LOG_LEVEL` قابل تغییر هستند (پیش‌فرض: `8787`، `127.0.0.1`، `info`).

## تصمیم‌ها

- **Logging:** لاگر اصلی، pino است (لاگر داخلی Fastify). سطح لاگ از `LOG_LEVEL` خوانده می‌شود و به‌صورت صریح به Fastify داده می‌شود (`apps/server/src/index.ts`). خروجی JSON به stdout است تا در آینده قابل انتقال به هر مقصدی باشد.
- **Zod:** اعتبارسنجی همه ورودی‌ها (settings، API Key، انتخاب مدل، محتوای پرامپت) از طریق Schemaهای مشترک `packages/contracts` انجام می‌شود.
- **TypeScript:** همه پکیج‌ها از `tsconfig.base.json` ریشه ارث می‌برند (`strict`، `noUncheckedIndexedAccess`، `verbatimModuleSyntax` و …). نسخه TypeScript عمداً روی خط ۵.۹ نگه داشته شده (نسخه ۷ هنوز توسط `typescript-eslint` پشتیبانی نمی‌شود).
- **Database:** SQLite محلی با Drizzle ORM. لایه مرکزی `apps/server/src/core/database/` (client، schema، migrations، helpers) تنها محل اتصال به Database است. Migrationها با Drizzle Kit تولید و هنگام Startup به‌صورت خودکار اجرا می‌شوند؛ جدول‌ها: `system_meta`، `app_settings`، `model_configs`، `gemini_models` (کش کشف مدل)، `prompt_templates` و `prompt_versions`، `batches`، `audio_files`، `jobs`، `transcripts`، `transcript_segments` و `api_usage`. جزئیات: [DATABASE.md](DATABASE.md).
- **مسیرهای نسبی server:** طبق `moduleResolution: NodeNext`، ایمپورت‌های نسبی با پسوند `.js` نوشته می‌شوند (در dev با `tsx` و در build با `tsc` resolve می‌شوند).

## Batch / Job Engine

- هر دور ورود صدا یک `batch` است (مرز پردازش؛ نه «روز»). Scan فقط از Backend انجام می‌شود؛ مرورگر File System را لمس نمی‌کند.
- Dedup محتوایی با SHA-256 (`audio_files.sha256` ایندکس‌شده) — نه بر اساس نام فایل. Duplicate ها Job نمی‌گیرند.
- صف Job داخل SQLite (`jobs`) با `idempotency_key` یکتا است؛ ساخت Job ایدم‌پوتنت است و Scan تکراری هیچ ردیف/Job تکراری نمی‌سازد.
- ثبت Batch در یک Transaction انجام می‌شود؛ Jobهای RUNNING مانده از Crash در Startup به PENDING برمی‌گردند.

## Transcription Pipeline (Phase 7)

- Worker پایدار (`services/transcription/worker.ts`) با Polling هر ۲ ثانیه، فقط Jobهای Batchهایی را که `PROCESSING` شده‌اند Claim می‌کند (UPDATE…RETURNING اتمیک؛ دو Worker هرگز یک Job نمی‌گیرند). Concurrency از تنظیم `processing_concurrency` خوانده می‌شود.
- همه Calls فقط از `GeminiGateway.transcribeAudio` می‌گذرند: آپلود فایل (`ai.files.upload`)، انتظار ACTIVE با Timeout، ارسال با System Prompt فعال و مدل Stage TRANSCRIPTION، و Normalize Usage (توکن‌های واقعی؛ مقادیر ناموجود `null`). فایل‌های آپلودشده موقت پس از اتمام پاک می‌شوند.
- مدل فقط از `model_configs` (stage=TRANSCRIPTION) و پرامپت فقط از نسخه فعال `TRANSCRIPTION` خوانده می‌شود؛ هیچ Model ID یا متن Prompt ثابتی در کد نیست. اگر یکی پیکربندی نشده باشد، Job بدون هیچ Gemini Call با خطای کنترل‌شده `TRANSCRIPTION_MODEL_NOT_CONFIGURED` / `TRANSCRIPTION_PROMPT_NOT_CONFIGURED` پایان می‌یابد.
- Idempotency: اگر Transcript معتبر با همان `audio.sha256 + model_id + prompt_version_id` موجود باشد، Gemini Call صفر می‌شود.
- ذخیره Transactional: insert transcript + segments + به‌روزرسانی audio → TRANSCRIBED + کامل‌کردن Job + ثبت `api_usage` در یک Transaction؛ شکست در هر مرحله یعنی ROLLBACK و Job COMPLETED نمی‌شود.
- Retry: خطاهای موقت (429، 5xx موقت، شبکه) با Exponential Backoff + Jitter در `jobs.next_attempt_at` زمان‌بندی می‌شوند و `max_attempts` رعایت می‌شود؛ خطاهای دائمی بلافاصله FAILED می‌شوند و Audio به‌صورت FAILED ثبت می‌شود.
- Batch State: READY → PROCESSING با `/api/batches/:id/start`؛ وقتی همه Jobها Terminal شوند: همه موفق → COMPLETED، بخشی → PARTIAL_FAILED، هیچ‌کدام → FAILED.
- Transcript متنی در SQLite Source of Truth است؛ خروجی Gemini نگه داشته می‌شود (`full_text`) و نسخه نرمال‌شده فارسی (`normalized_text` + `normalized_hash` SHA-256) برای جلوگیری از پردازش مجدد/تشخیص تکراری ذخیره می‌شود.

## خارج از محدوده فعلی

عمداً ساخته نشده‌اند: Authentication، Docker، Redis، Microservices، Vector Database، Destination Detection، Knowledge Extraction/Reconciliation، Embeddings و Content Generation. زیرساخت لازم (GeminiGateway، model config، پرامپت‌ها، readiness، Batch/Job، Worker، Transcript) آماده است؛ فقط Transcription اجرا می‌شود و بقیه Pipelineها در فازهای بعد ساخته می‌شوند.
