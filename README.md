# Freebuff

یک اپلیکیشن Local-first AI برای پردازش محتوای صوتی و متنی با Gemini.

فازهای تکمیل‌شده: زیرساخت پروژه، Database (SQLite + Drizzle)، Application Shell، Settings عمومی، پیکربندی کامل Gemini (کلید امن، کش مدل‌ها، انتخاب مدل هر Stage، پرامپت‌های نسخه‌دار)، Batch/Audio Ingestion با Job Engine پایدار (SHA-256 Dedup، صف Job داخل SQLite، Recovery بعد از Restart)، **Pipeline واقعی Transcription** (Worker پایدار با Concurrency، Retry با Backoff، ذخیره Transcript و Segments، Idempotency، ثبت مصرف API و نمایش پیشرفت زنده در UI)، **Knowledge Extraction به صورت Candidate**، و **Knowledge Delta Engine (Phase 9)** — مقایسهٔ هر Candidate با دانش قبلی مقصد (Exact Gate قطعی، Embedding با Cache، Retrieval هیبرید مقصد-محور و محدود، مقایسهٔ ساخت‌یافته Gemini، تصمیم‌های NEW/CONFIRMATION/UPDATE/CONFLICT/IGNORE، Dedup داخل Batch، ثبت مصرف و متریک‌های صرفه‌جویی Token) — و **Master Reconciliation & Batch Delta (Phase 10)** — اعمال Transactional و Versioned تصمیم‌ها روی Master Knowledge هر Destination (Item + نسخه‌ها + شواهد + تغییرات، Conflict Registry با گروه‌بندی، Idempotency کامل با constraintهای یکتا، Reconciliation Job پایدار بدون هیچ Gemini Call، Batch Delta فقط شامل NEW/UPDATE معتبر ACTIVE، Summary قابل Rebuild، وضعیت KNOWLEDGE_READY و UI کامل Master Knowledge/Conflicts/Batch Delta) — و **Batch Delta Content Generation (Phase 11)** — تولید محتوای نهایی فقط از دانش جدید/به‌روزشدهٔ همان Batch (ورودی محدود: پرامپت کاربر + Delta بدون Transcript/Evidence/Master کامل، Job پایدار CONTENT_GENERATION به ازای هر مقصد دارای Delta، Idempotency با Delta Signature، Regenerate صریح با حفظ History نسخه‌ها، Traceability کامل به knowledge_versionها، ثبت Usage با stage=CONTENT، متریک‌های صرفه‌جویی واقعی در UI، و تکمیل Batch تا COMPLETED) — و **Integration & Reliability (Phase 12)** — اتصال کامل خودکار تمام مراحل (فقط Scan + Start)، Restart Recovery در Startup (بازسازی Jobها و Batchهای نیمه‌کاره از DB، کار موفق هرگز تکرار نمی‌شود)، Preflight پیکربندی قبل از Start (`PIPELINE_NOT_READY` با پیام‌های Actionable)، Retry همهٔ Jobهای ناموفق و لغو امن Batch، Progress واقعی ۶ مرحله از DB (بدون درصد جعلی)، جستجو/فیلتر Master Knowledge بدون Gemini، Resolve/Dismiss تعارض، صفحهٔ Overview با آمار واقعی و Usage همه‌زمان، و تست‌های End-to-End (Pipeline کامل، Multi-Batch، Restart، Duplicate، Retry، Preflight، Cancel).

مستندات: [PIPELINE.md](docs/PIPELINE.md) · [KNOWLEDGE-MODEL.md](docs/KNOWLEDGE-MODEL.md) · [DATABASE.md](docs/DATABASE.md) · [OPERATIONS.md](docs/OPERATIONS.md) · [architecture.md](docs/architecture.md)

## پیش‌نیازها

- Node.js نسخه ۲۴ یا بالاتر
- pnpm نسخه ۱۱ (یا نسخه‌ای که در `packageManager` ریشه مشخص شده)

## نصب و اجرا

```bash
pnpm install
pnpm dev
```

بعد از اجرای `pnpm dev`:

- **Web:** `http://localhost:5173`
- **API:** `http://localhost:8787/api/health`

در حالت توسعه، Vite درخواست‌های `/api` را به سرور Fastify پراکسی می‌کند، پس مرورگر درخواست cross-origin ندارد.

## اسکریپت‌ها

| اسکریپت        | توضیح                                                     |
| -------------- | --------------------------------------------------------- |
| `pnpm dev`     | اجرای هم‌زمان Web و Server (با تغییرات خودکار reload)     |
| `pnpm build`   | ساخت نسخه تولید (web: Vite، server: tsc)                  |
| `pnpm typecheck` | بررسی تایپ کل workspace با `tsc`                         |
| `pnpm lint`    | اجرای ESLint روی کل پروژه                                  |
| `pnpm db:generate` | تولید Migration جدید از Schema (Drizzle Kit)           |
| `pnpm db:migrate`  | اجرای Migration های در انتظار روی Database            |
| `pnpm db:studio`   | باز کردن Drizzle Studio برای مشاهده Database           |
| `pnpm test`        | اجرای تست‌های سرور (node:test)                         |

> تست‌ها شامل سناریوهای End-to-End با Gateway Mock هستند (Pipeline کامل، چند Batch، Restart، Duplicate، Retry). بخشی که نیاز به Credential واقعی دارد فقط با کلید Gemini واقعی قابل اجراست — تست‌های خودکار هرگز به API واقعی دست نمی‌زنند.

## ساختار Repository

```text
/
├── apps/
│   ├── web/          # React + Vite + Tailwind (UI فارسی و RTL)
│   └── server/       # Fastify + pino + zod (API)
├── packages/
│   └── contracts/    # Schemaهای مشترک (Zod) و تایپ‌های API بین web و server
├── workspace/        # فایل‌های workspace محلی (database و secrets — خارج از Git)
├── docs/             # مستندات معماری و تصمیم‌ها
├── package.json
└── pnpm-workspace.yaml
```

## Database

Database محلی SQLite با Drizzle ORM است — فایل در `workspace/system/database/app.db` (خارج از Git). جزئیات کامل: [docs/DATABASE.md](docs/DATABASE.md). Migrationها در Startup خودکار اجرا می‌شوند؛ یک Database تازه همهٔ Migrationها را از ابتدا اعمال می‌کند.

## Pipeline کامل

```text
Audio → Transcription → Destination → Knowledge Candidates → Embedding/Retrieval →
Delta Decision (NEW/CONFIRMATION/UPDATE/CONFLICT/IGNORE) → Master Knowledge Reconciliation →
Batch Knowledge Delta (NEW/UPDATE) → Content Generation → COMPLETED
```

کل زنجیره خودکار است: فایل‌ها را در `{workspace}/audio` بگذارید، Batch بسازید و Start بزنید. جزئیات هر مرحله و Source of Truth آن: [docs/PIPELINE.md](docs/PIPELINE.md).

## راهنمای عملیاتی

شروع، پیکربندی Gemini، افزودن فایل، Retry، Recovery بعد از Restart، محل فایل‌ها و Backup: [docs/OPERATIONS.md](docs/OPERATIONS.md).

## ورود فایل‌های صوتی و Transcription

فایل‌های صوتی (`mp3`، `wav`، `m4a`، `aac`، `ogg`، `flac`، `webm`) را در پوشه `{workspace_path}/audio` قرار دهید، سپس از صفحه **Batches** یک Batch جدید بسازید:

- Backend فایل‌ها را Scan می‌کند، SHA-256 محاسبه می‌کند و محتوای تکراری را با status `DUPLICATE` ثبت می‌کند.
- برای هر فایل جدید دقیقاً یک Job ترنسکریپشن ساخته می‌شود. بعد از پیکربندی Gemini (کلید، مدل Stage ترنسکریپشن و System Prompt)، دکمه **شروع پردازش** Batch را اجرا می‌کند.
- Worker پایدار Jobها را با توجه به `processing_concurrency` اجرا می‌کند؛ خطاهای موقت با Backoff دوباره تلاش می‌شوند و Jobهای ناقص بعد از Restart Resume می‌شوند (RUNNING → PENDING در Startup).
- Transcript نرمال‌شده و Segments در SQLite ذخیره می‌شوند؛ مصرف واقعی Gemini در `api_usage` ثبت می‌شود. پیشرفت Batch به‌صورت زنده در صفحه جزئیات دیده می‌شود و هر فایل موفق دکمه **مشاهده Transcript** دارد.

## امنیت کلید Gemini

- کلید API در `workspace/system/secrets/gemini.key` (خارج از Git) ذخیره می‌شود — نه در SQLite و نه در localStorage مرورگر.
- کلید هرگز در پاسخ‌های API یا Logها ظاهر نمی‌شود؛ فقط وضعیت (تنظیم نشده / پیکربندی‌شده / نامعتبر / دسترسی مسدود) به UI می‌رسد.

## قراردادها

- TypeScript در حالت `strict` در کل workspace.
- Schema و تایپ‌های مشترک API فقط در `packages/contracts` تعریف می‌شوند تا Frontend و Backend یک‌سان اعتبارسنجی کنند.
- منطق Business داخل کامپوننت‌های React نوشته نمی‌شود.
- جزئیات بیشتر: [docs/architecture.md](docs/architecture.md)
