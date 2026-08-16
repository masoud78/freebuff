# PIPELINE — جریان کامل پردازش

این سند کل زنجیرهٔ پردازش Freebuff را از فایل صوتی تا محتوای نهایی توضیح می‌دهد و مشخص می‌کند هر مرحله چه چیزی را **Source of Truth** می‌داند.

## نمای کلی

```text
Audio Ingestion
      ↓
Transcription (Gemini)
      ↓
Destination Detection
      ↓
Knowledge Extraction → Candidates
      ↓
Embedding / Retrieval (cache-aware)
      ↓
Delta Decision (NEW / CONFIRMATION / UPDATE / CONFLICT / IGNORE)
      ↓
Master Knowledge Reconciliation (Transactional, بدون Gemini)
      ↓
Batch Knowledge Delta (فقط NEW/UPDATE معتبر ACTIVE)
      ↓
Content Generation (فقط از همان Delta)
      ↓
COMPLETED
```

## مراحل به تفکیک

### 1. Audio Ingestion

- فایل‌های صوتی در `{workspace_path}/audio` قرار می‌گیرند؛ Scan فقط از Backend انجام می‌شود.
- برای هر فایل SHA-256 محاسبه می‌شود؛ فایل تکراری (`audio_files.sha256` ایندکس‌شده) با وضعیت `DUPLICATE` ثبت می‌شود و **هیچ Job و هیچ Gemini Call** نمی‌گیرد.
- برای هر فایل جدید دقیقاً یک Job `TRANSCRIPTION` ساخته می‌شود (Idempotency Key `TRANSCRIPTION:{audio_id}`).
- **Source of Truth:** فایل روی دیسک + ردیف `audio_files`.

### 2. Transcription

- Worker پایدار Jobها را با توجه به `processing_concurrency` اجرا می‌کند؛ همهٔ درخواست‌ها فقط از `GeminiGateway.transcribeAudio` عبور می‌کنند.
- مدل فقط از `model_configs` (stage=TRANSCRIPTION) و پرامپت فقط از نسخهٔ فعال `TRANSCRIPTION` خوانده می‌شود — هیچ Hardcode.
- خروجی نرمال‌سازی می‌شود (`normalized_text` + `normalized_hash`). اگر Transcript معتبر با همان Hash قبلاً موجود باشد، Transcript جدید به‌عنوان Duplicate ثبت می‌شود (`duplicate_of_transcript_id`) و **Knowledge Analysis برای آن ساخته نمی‌شود**.
- ذخیره (transcript + segments + وضعیت audio + Job + `api_usage`) در یک Transaction انجام می‌شود.
- **Source of Truth:** جدول `transcripts` + `transcript_segments` (متن نهایی در SQLite).

### 3. Destination Detection

- داخل همان خروجی ساخت‌یافتهٔ Knowledge، Gemini مقصدها را پیشنهاد می‌کند (با aliases و confidence).
- Backend با نام نرمال‌شده و aliasها، مقصد موجود را پیدا می‌کند یا مقصد جدید می‌سازد. UNKNOWN هرگز ساخته نمی‌شود.
- Candidate بدون مقصد قابل تشخیص، `destination_id = null` می‌گیرد (در UI به‌عنوان «نامشخص / Unresolved» نمایش داده می‌شود) — هرگز به مقصد اشتباه وصل نمی‌شود.
- **Source of Truth:** جدول `destinations` + `destination_aliases` + `transcript_destinations`.

### 4. Knowledge Extraction → Candidates

- از فاز ۹ به بعد، خروجی Gemini هرگز مستقیماً Master نمی‌سازد — ابتدا ردیف‌های `knowledge_candidates` ساخته می‌شوند.
- `identity_key` و `value_hash` سمت Backend محاسبه می‌شوند (هیچ‌وقت از Gemini).
- برای هر Transcript با Candidate، یک Job `KNOWLEDGE_DELTA` در همان Transaction ساخته می‌شود.
- **Source of Truth:** جدول `knowledge_candidates` (Staging — هرگز Master محسوب نمی‌شود).

### 5. Embedding / Retrieval

- فقط در صورت نیاز (مقایسه با دانش موجود) Embedding گرفته می‌شود؛ Cache روی `(model_id, source_hash)` — متن یکسان هرگز دوباره Embed نمی‌شود.
- Retrieval فقط **داخل همان Destination** و محدود (`maxRetrievedItems=6`، سقف کاراکتر و سقف کاندیدای Similarity) — کل پایگاه هرگز در Memory نمی‌آید.
- **Source of Truth:** جدول `knowledge_embeddings` (cache).

### 6. Delta Decision

- **Exact Gate (قطعی):** Identity + Value یکسان → `CONFIRMATION` بدون هیچ Gemini Call.
- **Same-batch:** تکراری همان Batch → `CONFIRMATION`؛ متناقض همان Batch → `CONFLICT` (گروه‌بندی با `conflict_group_key`).
- **Gemini:** فقط موارد مبهم با مقایسهٔ ساخت‌یافته (Candidate + Top Relevant + Contract داخلی) — خروجی با Zod دوباره اعتبارسنجی می‌شود. مقادیر حساس هرگز با تشابه بالا خودکار تأیید نمی‌شوند.
- تصمیم در `knowledge_delta_decisions` ذخیره می‌شود؛ Master هنوز تغییر نمی‌کند.
- **Source of Truth:** جدول `knowledge_delta_decisions`.

### 7. Master Knowledge Reconciliation

- هر تصمیم یک Job پایدار `KNOWLEDGE_RECONCILIATION` می‌گیرد (`RECONCILE:{decision_id}`). **هیچ Gemini Call جدیدی** — کاملاً Deterministic و Transactional.
- `NEW` → Item + V1 + Evidence + Change. `CONFIRMATION` → فقط Evidence + `last_seen`. `UPDATE` → نسخهٔ قبلی بایگانی + نسخهٔ جدید Current. `CONFLICT` → ثبت OPEN در `knowledge_conflicts` بدون تغییر حقیقت. `IGNORE` → هیچ Mutation.
- Replay هر تصمیم ایدم‌پوتنت است (constraintهای یکتا + guard داخل Transaction).
- **Source of Truth:** `knowledge_items` + `knowledge_versions` + `knowledge_evidence` + `knowledge_changes` + `knowledge_conflicts`.

### 8. Batch Knowledge Delta

- `knowledge_changes` فقط شامل NEW/UPDATE با `status=ACTIVE` است (PROVISIONAL حذف، conservative).
- `batch_destination_summaries` از دادهٔ Canonical **Recompute** می‌شود (Retry-safe؛ Rebuild خروجی یکسان می‌دهد).
- وقتی همهٔ Jobهای Batch (شامل Content) Terminal شوند، Batch `COMPLETED` می‌شود؛ شکست → `PARTIAL_FAILED`.
- **Source of Truth:** `knowledge_changes` + `batch_destination_summaries`.

### 9. Content Generation

- فقط برای Destinationهایی که Delta Publishable دارند و فقط بعد از Finalization کامل.
- ورودی Gemini = پرامپت کاربر CONTENT + Contract داخلی + نام مقصد + Delta همان Batch. **Master کامل، Raw Transcript و Evidence هرگز ارسال نمی‌شوند.**
- `delta_signature` → Delta یکسان دوباره تولید نمی‌شود؛ Regenerate صریح نسخهٔ جدید می‌سازد.
- `generated_content_knowledge` محتوا را دقیقاً به knowledge_versionها وصل می‌کند.
- **Source of Truth:** `generated_contents` + `generated_content_knowledge`.

## زنجیرهٔ Source of Truth

```text
Audio (دیسک) → Transcript (SQLite) → Candidates (Staging) → Decisions →
Master Knowledge (SQLite) → Batch Delta (SQLite) → Generated Content (SQLite)
```

هر مرحله فقط از خروجی مرحلهٔ قبل می‌خواند و خروجی خودش را در SQLite می‌نویسد؛ هیچ Stage در Memory نگه داشته نمی‌شود و بعد از Restart همه‌چیز از DB بازسازی می‌شود (Pipeline Recovery در Startup).

## Orchestration

اتصال Stageها از طریق **SQLite Job Engine** انجام می‌شود (Kafka/Redis/Event Bus ساخته نشده است):

```text
transcription complete → create knowledge analysis jobs
knowledge analysis complete → create delta jobs
delta complete → create reconciliation jobs
reconciliation complete → finalize batch delta
publishable delta exists → create content jobs
content complete → batch completed
```

خودکارسازی کامل است: کاربر فقط فایل‌ها را می‌گذارد، Batch می‌سازد و Start می‌زند — بقیه مراحل بدون دخالت دستی ادامه می‌یابد.
