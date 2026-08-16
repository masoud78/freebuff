# Freebuff

یک اپلیکیشن Local-first AI برای پردازش محتوای صوتی و متنی با Gemini.

فازهای تکمیل‌شده: زیرساخت پروژه، Database (SQLite + Drizzle)، Application Shell، Settings عمومی، پیکربندی کامل Gemini (کلید امن، کش مدل‌ها، انتخاب مدل هر Stage، پرامپت‌های نسخه‌دار)، Batch/Audio Ingestion با Job Engine پایدار (SHA-256 Dedup، صف Job داخل SQLite، Recovery بعد از Restart)، **Pipeline واقعی Transcription** (Worker پایدار با Concurrency، Retry با Backoff، ذخیره Transcript و Segments، Idempotency، ثبت مصرف API و نمایش پیشرفت زنده در UI)، **Knowledge Extraction به صورت Candidate**، و **Knowledge Delta Engine (Phase 9)** — مقایسهٔ هر Candidate با دانش قبلی مقصد (Exact Gate قطعی، Embedding با Cache، Retrieval هیبرید مقصد-محور و محدود، مقایسهٔ ساخت‌یافته Gemini، تصمیم‌های NEW/CONFIRMATION/UPDATE/CONFLICT/IGNORE، Dedup داخل Batch، ثبت مصرف و متریک‌های صرفه‌جویی Token) — بدون Mutation نهایی Master Knowledge (فاز ۱۰).

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

Database محلی SQLite با Drizzle ORM است — فایل در `workspace/system/database/app.db` (خارج از Git). جزئیات کامل: [docs/DATABASE.md](docs/DATABASE.md).

## ورود فایل‌های صوتی و Transcription

فایل‌های صوتی (`mp3`، `wav`، `m4a`، `aac`، `ogg`، `flac`، `webm`) را در پوشه `{workspace_path}/audio` قرار دهید، سپس از صفحه **Batches** یک Batch جدید بسازید:

- Backend فایل‌ها را Scan می‌کند، SHA-256 محاسبه می‌کند و محتوای تکراری را با status `DUPLICATE` ثبت می‌کند.
- برای هر فایل جدید دقیقاً یک Job ترنسکریپشن ساخته می‌شود. بعد از پیکربندی Gemini (کلید، مدل Stage ترنسکریپشن و System Prompt)، دکمه **شروع پردازش** Batch را اجرا می‌کند.
- Worker پایدار Jobها را با توجه به `processing_concurrency` اجرا می‌کند؛ خطاهای موقت با Backoff دوباره تلاش می‌شوند و Jobهای ناقص بعد از Restart Resume می‌شوند (RUNNING → PENDING در Startup).
- Transcript نرمال‌شده و Segments در SQLite ذخیره می‌شوند؛ مصرف واقعی Gemini در `api_usage` ثبت می‌شود. پیشرفت Batch به‌صورت زنده در صفحه جزئیات دیده می‌شود و هر فایل موفق دکمه **مشاهده Transcript** دارد.

## امنیت کلید Gemini

- کلید API در `workspace/system/secrets/gemini.key` (خارج از Git) ذخیره می‌شود — نه در SQLite و نه در localStorage مرورگر.
- کلید هرگز در پاسخ‌های API یا Logها ظاهر نمی‌شود؛ فقط وضعیت (تنظیم نشده / پیکربندی‌شده / نامعتبر) به UI می‌رسد.

## قراردادها

- TypeScript در حالت `strict` در کل workspace.
- Schema و تایپ‌های مشترک API فقط در `packages/contracts` تعریف می‌شوند تا Frontend و Backend یک‌سان اعتبارسنجی کنند.
- منطق Business داخل کامپوننت‌های React نوشته نمی‌شود.
- جزئیات بیشتر: [docs/architecture.md](docs/architecture.md)
