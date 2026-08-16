# Database — SQLite & Drizzle

## کجاست؟

فایل اصلی Database در مسیر زیر است (نسبت به ریشه Repository):

```text
workspace/system/database/app.db
```

Backend هنگام Startup، اگر Directory وجود نداشته باشد آن را می‌سازد (`mkdir -p`). مسیر را می‌توان با متغیر محیطی `DB_PATH` تغییر داد (مثلاً برای تست‌ها).

## Stack

- **SQLite** — به‌صورت Local و تک‌فایلی (`workspace/system/database/app.db`).
- **Driver:** `@libsql/client` (client سازگار با SQLite) در حالت Embedded با `file:` URL. دلیل انتخاب: روی stable بودن Drizzle ORM 0.45 کار می‌کند، بدون نیاز به کامپایل native module روی ویندوز (برخلاف better-sqlite3)، و هم برای runtime و هم برای Drizzle Kit یکی است.
- **ORM:** `drizzle-orm` — مدل‌ها در `apps/server/src/core/database/schema.ts`.
- **Migration tool:** `drizzle-kit` (فقط برای `generate` و `studio`؛ اجرای Migration در runtime با migrator خود Drizzle انجام می‌شود).

همه اتصال‌ها از لایه مرکزی `apps/server/src/core/database/` انجام می‌شوند (client، schema، migrations، helpers) — در Routeها Connection جدید ساخته نمی‌شود.

## تنظیمات SQLite

هنگام Initialization این pragmaها به‌صورت مرکزی (`client.ts`) اعمال می‌شوند:

```text
PRAGMA foreign_keys = ON
PRAGMA journal_mode = WAL
PRAGMA busy_timeout = 5000
PRAGMA synchronous = NORMAL
```

## Migration — ساخت

بعد از تغییر `schema.ts`:

```bash
pnpm db:generate
```

خروجی در `apps/server/src/core/database/migrations/` تولید می‌شود (یک فایل SQL به‌همراه `meta/`). فایل‌های تولیدشده را review و در Git commit کن.

## Migration — اجرا

Migration ها هنگام **Startup خود Backend** به‌صورت خودکار و deterministic اجرا می‌شوند (با `migrate()` خود Drizzle — همان مسیر کد هم در runtime و هم در اسکریپت CLI):

```bash
pnpm db:migrate
```

هر دو مسیر idempotent هستند (Migration اعمال‌شده در جدول `__drizzle_migrations` ثبت می‌شود و دوباره اجرا نمی‌شود). اگر Migration شکست بخورد، Backend با خطای واضح از Startup خارج می‌شود.

## Studio

```bash
pnpm db:studio
```

روی `local.drizzle.studio` باز می‌شود (در حالت Beta است).

## چرا `app.db` داخل Git نیست؟

فایل Database داده‌ی runtime است و هر کاربر/محیط باید Database خودش را داشته باشد (همان‌طور که `node_modules` را commit نمی‌کنیم). در `.gitignore`:

```text
workspace/system/database/
```

این پوشه شامل `app.db` و فایل‌های WAL (`-wal`، `-shm`) می‌شود. Migration ها (Schema) تنها چیزی هستند که در Git نگه داشته می‌شوند و ساختار Database را بازسازی می‌کنند.

## جدول‌ها

| جدول                | نقش                                                       |
| ------------------- | --------------------------------------------------------- |
| `system_meta`       | Metadata داخلی (timestamp تست Gemini، زمان کش مدل‌ها و…)  |
| `app_settings`      | تنظیمات عمومی (workspace_path، processing_concurrency)    |
| `model_configs`     | انتخاب مدل هر Stage (TRANSCRIPTION و…)                    |
| `gemini_models`     | کش نتایج کشف مدل‌های Gemini                               |
| `prompt_templates`  | سه پرامپت اصلی                                            |
| `prompt_versions`   | نسخه‌های غیرقابل‌تغییر پرامپت‌ها                          |
| `batches`           | مرز پردازش — هر دور وارد کردن فایل‌های صوتی               |
| `audio_files`       | فایل‌های صوتی ثبت‌شده + SHA-256 + وضعیت Duplicate         |
| `jobs`              | صف Jobهای پایدار داخل SQLite (TRANSCRIPTION + retry)      |
| `transcripts`       | Transcript نرمال‌شده هر فایل (full_text + hash)            |
| `transcript_segments` | قطعات زمانی/گوینده‌محور Transcript (برای فاز Knowledge) |
| `api_usage`         | مصرف واقعی Gemini (tokenها، duration، SUCCESS/FAILED)     |

جداول Batch: `audio_files.sha256` (تشخیص Duplicate محتوایی)، `audio_files.batch_id`، `jobs.status`، `jobs.batch_id` و `jobs.idempotency_key` (UNIQUE) ایندکس‌شده‌اند. Jobهای RUNNING مانده از Crash قبلی در Startup به PENDING برگردانده می‌شوند.

## Transcription

- `transcripts`: برای هر Audio یک Transcript فعلی (unique index روی `audio_id` وقتی `status='COMPLETED'`)؛ `normalized_hash` (SHA-256) برای جلوگیری از پردازش مجدد و تشخیص Transcript تکراری ایندکس شده و `duplicate_of_transcript_id` آن را به نسخه قبلی وصل می‌کند.
- `transcript_segments`: قطعات مرتب‌شده (sequence، speaker، متن + hash هر قطعه) برای فازهای Knowledge بعدی.
- `jobs.next_attempt_at`: زمان Retry بعدی (Backoff) — Worker فقط Jobهای Batchهای `PROCESSING` را Claim می‌کند.
- `api_usage`: فقط مصرف واقعی ثبت می‌شود؛ مقادیر ناموجود `null` هستند و عدد جعلی/تخمینی ذخیره نمی‌شود.

## نکات

- `system_meta` فقط برای Metadata داخلی Application است؛ Business Data در جدول‌های اختصاصی خودش است.
- `@libsql/client` روی ویندوز handle فایل را تا پایان عمر فرایند نگه می‌دارد؛ این برای سرور بلندمدت مشکلی نیست، فقط حذف هم‌زمان فایل DB توسط ابزارهای بیرونی ممکن است قفل شود.
