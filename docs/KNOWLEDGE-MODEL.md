# KNOWLEDGE-MODEL — مدل دانش

این سند تفاوت دقیق هشت مفهوم کلیدی سیستم را ثبت می‌کند. درک این تفاوت‌ها برای هر توسعهٔ بعدی (مخصوصاً Content و UI) حیاتی است.

## ۱. Knowledge Candidate

- **چیست:** یک ادعای موقت که Gemini از یک Transcript استخراج کرده — Staging قبل از هر تصمیم.
- **جدول:** `knowledge_candidates`
- **ویژگی‌ها:** `identity_key` و `value_hash` سمت Backend؛ `destination_id` (nullable)، `source_segment_id` و `source_text` برای Traceability.
- **نقش:** هرگز Master محسوب نمی‌شود؛ واحد ورودی موتور Delta است.

## ۲. Delta Decision

- **چیست:** نتیجهٔ مقایسهٔ یک Candidate با دانش موجود همان Destination.
- **جدول:** `knowledge_delta_decisions`
- **مقادیر:** `NEW` / `CONFIRMATION` / `UPDATE` / `CONFLICT` / `IGNORE` + `reason_code` + `confidence` + `input_signature` (Idempotency).
- **نقش:** Master را مستقیم تغییر نمی‌دهد؛ ورودی Reconciliation است.

| تصمیم | معنی | در Master | در Batch Delta |
|---|---|---|---|
| NEW | دانش جدید بدون معادل | Item + V1 | ✅ |
| CONFIRMATION | همان واقعیت قبلاً ثبت شده | فقط Evidence + last_seen | ❌ |
| UPDATE | ارزش جدیدتر/معتبرتر | نسخهٔ جدید (Previous بایگانی) | ✅ |
| CONFLICT | ادعای متناقض | هیچ (ثبت Conflict OPEN) | ❌ |
| IGNORE | نویز/استخراج اشتباه | هیچ | ❌ |

## ۳. Master Knowledge Item

- **چیست:** دانش واقعی و دائمی یک Destination — Source of Truth نهایی.
- **جدول:** `knowledge_items`
- **قواعد غیرقابل مذاکره:**
  - یک Canonical به ازای هر `(destination_id, identity_key)` (constraint یکتا).
  - `first_seen` / `last_seen` روی Item.
  - وضعیت `ACTIVE` / `PROVISIONAL` / `ARCHIVED`.

## ۴. Knowledge Version

- **چیست:** یک مقدار مشخص از یک Item در یک بازهٔ زمانی.
- **جدول:** `knowledge_versions`
- **قواعد:**
  - تاریخچه Append-only — هیچ‌وقت Overwrite نمی‌شود.
  - دقیقاً یک `is_current = true` به ازای هر Item (constraint یکتا).
  - UPDATE = بایگانی نسخهٔ قبلی + ساخت نسخهٔ جدید (`version_number + 1`).

## ۵. Knowledge Evidence

- **چیست:** اتصال یک نسخه به منبع دقیق (transcript + segment).
- **جدول:** `knowledge_evidence`
- **قاعده:** یک Source فقط یک بار می‌تواند Evidence یک نسخه باشد (constraint یکتا روی `knowledge_id + version_id + transcript_id + segment_id`) — Replay هرگز count را مصنوعی زیاد نمی‌کند.
- **نقش:** پایهٔ Traceability کامل (محتوا ← دانش ← نسخه ← شواهد ← Transcript ← Audio).

## ۶. Conflict

- **چیست:** ادعای متناقضی که سیستم حق ندارد خودش جایگزین حقیقت فعلی کند.
- **جدول:** `knowledge_conflicts`
- **ویژگی‌ها:** `status` (OPEN/RESOLVED/DISMISSED)، `conflict_group_key` (گروه‌بندی ادعاهای همان Identity)، `existing_version_id`، `resolved_version_id` (nullable).
- **قاعده:** Conflict OPEN هرگز وارد Batch Delta و Content نمی‌شود و Master فعلی را تغییر نمی‌دهد.

## ۷. Batch Knowledge Delta

- **چیست:** فقط تغییرات **Publishable** (ACTIVE NEW/UPDATE) یک Batch برای یک Destination.
- **جدول‌ها:** `knowledge_changes` (NEW/UPDATE + old/new version) + `batch_destination_summaries` (countهای Derived/Recomputed).
- **قاعده:** CONFIRMATION/CONFLICT/IGNORE/PROVISIONAL هرگز در Delta نیستند. این دقیقاً ورودی Content Generation است.

## ۸. Generated Content

- **چیست:** خروجی نهایی Gemini بر اساس **فقط Delta همان Batch** — نه کل دانش Destination.
- **جدول‌ها:** `generated_contents` (content + model + prompt_version + delta_signature + generation) + `generated_content_knowledge` (لینک به knowledge_version/change).
- **قواعد:**
  - Delta یکسان → Gemini دوباره Call نمی‌شود (`delta_signature`).
  - Regenerate صریح → نسخهٔ جدید، نسخهٔ قبلی `SUPERSEDED` — هیچ Overwrite.
  - Content هرگز Transcript/Evidence/Master کامل را نمی‌بیند.

## نمودار رابطه

```text
Transcript
   └─ Knowledge Candidate ──► Delta Decision ──► Reconciliation
                                                      │
                                        ┌─────────────┴─────────────┐
                                        ▼                           ▼
                              Master Knowledge              Batch Knowledge Delta
                              (Item + Versions +                  (NEW/UPDATE ACTIVE)
                               Evidence + Conflicts)                 │
                                        ▲                             ▼
                                        │                    Generated Content
                                        └── Traceability ─────────┘
                                                      (generated_content_knowledge)
```

## پیامدهای مهم

- **Master Knowledge ≠ Batch Delta ≠ Generated Content.** هر کدام جدول، معنی و چرخهٔ عمر خودش را دارد.
- Reconciliation **بدون Gemini** است — تصمیم‌ها از Phase 9 می‌آیند و Phase 10 فقط Deterministic اعمال می‌کند.
- Content فقط از Delta همان Batch ساخته می‌شود؛ «محتوای کامل Destination» وجود ندارد — هر محتوا متعلق به یک Batch مشخص است.
