import { ApiError, GoogleGenAI, type File as GeminiFile } from '@google/genai';
import type {
  DeltaClassification,
  GeminiErrorCode,
  GeminiModelCapabilities,
  GeminiModelInfo,
  GeminiModelQuotaStatus,
  GeminiUsage,
  KnowledgeAnalysis,
  NoteExtraction,
} from '@freebuff/contracts';
import { z } from 'zod';
import { DomainError } from '../errors.js';
import { deltaClassificationSchema, knowledgeAnalysisSchema, noteExtractionSchema } from '@freebuff/contracts';
import { NEWSROOM_REPORTER_PROMPT } from '../newsroom-prompt.js';

/** Internal contract for one ambiguous note comparison (notes vs notes). */
export const noteComparisonSchema = z.object({
  decision: z.enum(['ADD', 'UPDATE', 'MARK_OUTDATED', 'NO_CHANGE']),
  matchedNoteId: z.number().int().min(0).default(0),
  logReason: z.string().default(''),
});

export type NoteComparison = z.infer<typeof noteComparisonSchema>;

export interface NoteComparisonPayload {
  candidate: { title: string; description: string; relevantDate: string | null };
  destination: string | null;
  existingNotes: { id: number; title: string; description: string; relevantDate: string | null }[];
}

/** The note-comparison contract appended to the user's knowledge prompt. */
export const NOTE_COMPARISON_INTERNAL_CONTRACT = `
--- Internal note comparison contract (system, non-negotiable) ---
You are comparing ONE extracted note against a small set of EXISTING notes of
the same destination. Only notes listed under "existingNotes" may be
referenced by matchedNoteId.

Decide exactly one:
- ADD: a genuinely new, useful note with no existing equivalent.
- UPDATE: the same topic already exists but the new note is newer, more
  accurate or more complete. A new version should replace it.
- MARK_OUTDATED: the new information reliably shows an existing note is no
  longer valid (superseded, expired, or contradicted) AND there is no
  replacement to store. Only use this when the evidence is clear; otherwise
  prefer NO_CHANGE.
- NO_CHANGE: the new note only repeats existing knowledge — store nothing new.

The logReason must be a short, human, grounded Persian sentence that cites
what actually changed (only facts present in the candidate or the existing
note). Never mention scores, similarity, embeddings or that "AI decided".
For NO_CHANGE the logReason may be empty.

Return JSON only:
{"decision":"ADD|UPDATE|MARK_OUTDATED|NO_CHANGE","matchedNoteId":<id from the list, or 0 for ADD>,"logReason":"<short grounded Persian reason>"}
`;

/** Quality gate appended to the extraction contract. */
export const NOTE_EXTRACTION_INTERNAL_CONTRACT = `
--- Internal note extraction contract (system, non-negotiable) ---
Extract ONLY useful, actionable, decision-relevant, customer-relevant or
content-worthy information. Do NOT extract greetings, small talk, obvious or
repeated statements, irrelevant personal details, or trivial facts. Quality
over quantity: a few genuinely useful notes beat many weak ones. For every
note, before output ask: will this meaningfully help a future decision,
answer, sale or destination understanding? If not, omit it.

Empty is better than filler. If the call is about something else, has no
decision-relevant travel information, or only repeats what is already known,
return empty notes and empty audienceInsights. NEVER invent a generic note or
insight just to make the output look complete.

Every note must have a kind:
- TOUR_INFO: operational facts about a tour/product of the destination
  (hotels, stay length, transport, flights, trains, transfers, package terms,
  schedule changes, tour limits, practical pros/cons, package comparisons).
- DESTINATION_INFO: facts about the destination itself (areas, access, hotel
  locations, transport, practical travel conditions, key features, limits,
  accommodation notes).
- TRAVELER_GUIDANCE: practical decision guidance the seller gave (e.g. "if
  proximity to the shrine matters, the entrance matters more than raw
  distance"). Only when the conversation genuinely supports the reasoning.

Each description must be COMPLETE and self-contained: explain the knowledge,
keep the necessary context, mention the practical effect/condition when
present, and be understandable without reading the transcript. Do not
abbreviate, truncate or summarize the note into a short snippet. Never invent
facts to complete it.

For each factual note set scopeType:
- TOUR when the note is about a specific tour (and set tourSubject to a short
  searchable label, e.g. «تور آنتالیا از تبریز»).
- DESTINATION otherwise.

For each note set the destination to the place the information is ABOUT (the
travel destination or subject of the information) and set its role:
- DESTINATION: the place the note is about.
- ORIGIN: only where the traveler comes from — never create a destination for it.
- TRANSIT / COMPARISON / OTHER: contextual only.

Separately, extract audienceInsights (inferred traveler concerns — NOT facts):
- An insight is a grounded inference about what the traveler cares about (a
  repeated question, returning to a topic, comparing options on one criterion,
  asking for reassurance, the real reason a choice was rejected).
- Each insight needs an inferenceBasis: a short, concrete explanation of what
  in the conversation supports it.
- Never turn an inference into a fact about the destination. E.g. a traveler
  asking repeatedly about cleanliness is an insight about the traveler, never
  "the hotels are unclean".
- Use language scoped to the call ("در این تماس…"), never "مشتریان معمولاً…".
- A single weak signal is not enough for an insight; omit it.
- Do not turn ordinary questions into fake "concerns". If the traveler just
  asked a routine question, that is not an insight; leave audienceInsights
  empty instead of padding with a generic worry.
- Optionally attach ONE contentOpportunity {title, reason} derived from the
  actual concern. Never invent generic topics.

Also return a conversationTopic: a very short phrase (a few words) naming the
main topic of the call (e.g. «بررسی هتل‌های نزدیک حرم در مشهد»), never a long
summary.

Return JSON only (camelCase keys):
{"conversationTopic":"<short topic phrase>","voiceReport":"<short Persian summary of the whole conversation>","notes":[{"title":"...","description":"...","destination":{"name":"...","role":"DESTINATION|ORIGIN|TRANSIT|COMPARISON|OTHER"},"relevantDate":null,"kind":"TOUR_INFO|DESTINATION_INFO|TRAVELER_GUIDANCE","scopeType":"DESTINATION|TOUR","tourSubject":null}],"audienceInsights":[{"title":"...","description":"...","destination":{"name":"...","role":"DESTINATION"},"inferenceBasis":"...","confidence":0.0,"contentOpportunity":{"title":"...","reason":"..."}}]}
`;

/** One structured editorial story produced by the reporter. */
export interface NewsroomStory {
  headline: string;
  paragraphs: string[];
  /** Optional H3 subheading for structured sections. */
  subheading?: string | null;
}

/** Shared Zod contract for the reporter's structured output. */
export const newsroomStoriesSchema = z.object({
  stories: z.array(
    z.object({
      headline: z.string().min(1, 'عنوان خبر نمی‌تواند خالی باشد.'),
      paragraphs: z.array(z.string().min(1)).default([]),
      subheading: z.string().nullable().optional(),
    }),
  ).default([]),
  /** Honest Persian reason when stories is empty (no invention). */
  noNewsReason: z.string().nullable().optional(),
});

export type NewsroomStories = z.infer<typeof newsroomStoriesSchema>;

/**
 * Structured input the backend builds for the reporter (one destination).
 * Full detail of each changed item is supplied — never the whole database.
 */
export interface NewsroomPayload {
  destination: string;
  /** Real distinct source-voice count for this destination (grounded counts only). */
  sourceVoiceCount: number;
  /** Short conversation topics of the voices that touched this destination. */
  conversationTopics: string[];
  newNotes: { title: string; description: string }[];
  updatedNotes: {
    title: string;
    previousTitle: string;
    previousDescription: string;
    newDescription: string;
  }[];
  outdatedNotes: { title: string; previousDescription: string; reason: string }[];
  newInsights: {
    title: string;
    description: string;
    inferenceBasis: string;
    contentOpportunityTitle: string | null;
    contentOpportunityReason: string | null;
  }[];
}

/**
 * Error thrown by the Gemini gateway. `code` is a stable, normalized
 * `GeminiErrorCode`; `message` is a safe, user-facing Persian message.
 * `detail` (when present) is the precise underlying reason from Google —
 * sanitized so an API key can never leak into it.
 * The API key never appears in the message or in the logged cause chain.
 * Extends DomainError so API routes map it to a controlled 400 response.
 * `retryable` tells the job engine whether a retry makes sense.
 */
export class GeminiGatewayError extends DomainError {
  readonly retryable: boolean;
  readonly durationMs: number | null;
  readonly detail: string | null;

  constructor(
    code: GeminiErrorCode,
    message: string,
    options?: { cause?: unknown; retryable?: boolean; durationMs?: number; detail?: string | null },
  ) {
    super(code, message, options);
    this.name = 'GeminiGatewayError';
    this.retryable = options?.retryable ?? (code === 'GEMINI_RATE_LIMIT' || code === 'GEMINI_NETWORK_ERROR');
    this.durationMs = options?.durationMs ?? null;
    this.detail = options?.detail ?? null;
  }
}

/** Messages that really mean "the key itself was rejected". */
const API_KEY_MESSAGE = /api key|apikey|invalid key/i;
/** Messages that mean "authenticated but not allowed" (region, restriction, permission). */
const ACCESS_MESSAGE =
  /permission denied|unauthorized|forbidden|user location|unsupported (country|region)|not supported for the api|geofenc|restricted|blocked|not enabled/i;
const NETWORK_MESSAGE = /fetch failed|socket|econn|etimedout|enotfound|eai_again|tls/i;

const DETAIL_MAX_LENGTH = 300;

/** Pull Google's human-readable reason out of the raw (possibly JSON) message. */
function extractReadable(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    if (parsed?.error?.message) return parsed.error.message;
  } catch {
    // Not JSON — use the raw text as-is.
  }
  return raw;
}

/**
 * Sanitize a raw detail string: redact anything that looks like an API key
 * and cap the length so a runaway server message never floods the UI.
 */
function sanitizeDetail(raw: string): string | null {
  const cleaned = raw
    .replace(/AIza[0-9A-Za-z_\-]{20,}/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.length > DETAIL_MAX_LENGTH ? `${cleaned.slice(0, DETAIL_MAX_LENGTH)}…` : cleaned;
}

/** Map any SDK/network failure to a normalized GeminiGatewayError. */
export function toGeminiGatewayError(error: unknown): GeminiGatewayError {
  if (error instanceof GeminiGatewayError) return error;

  if (error instanceof ApiError) {
    const status = error.status;
    const detail = sanitizeDetail(extractReadable(String(error.message)));

    // 401 = the key itself was rejected. Genuinely invalid key.
    if (status === 401) {
      return new GeminiGatewayError(
        'GEMINI_AUTH_ERROR',
        'کلید API نامعتبر است. کلید جدیدی وارد کنید.',
        { cause: error, detail },
      );
    }
    // 403 = authenticated but not allowed: region block (e.g. Iran), key
    // restrictions (IP/referrer) or the API not enabled on the project.
    // A valid key can absolutely hit this — it is NOT an invalid-key error.
    if (status === 403) {
      return new GeminiGatewayError(
        'GEMINI_FORBIDDEN',
        'گوگل دسترسی به Gemini API را رد کرد. کلید ممکن است سالم باشد؛ علت معمولاً مسدودیت منطقه‌ای، محدودیت کلید (IP/مرجع) یا فعال نبودن API است.',
        { cause: error, detail },
      );
    }
    // 400: the body decides — a key message means a bad key; an access
    // message (e.g. "user location is not supported") means blocked.
    if (status === 400) {
      if (API_KEY_MESSAGE.test(detail ?? '')) {
        return new GeminiGatewayError(
          'GEMINI_AUTH_ERROR',
          'کلید API نامعتبر است. کلید جدیدی وارد کنید.',
          { cause: error, detail },
        );
      }
      if (ACCESS_MESSAGE.test(detail ?? '')) {
        return new GeminiGatewayError(
          'GEMINI_FORBIDDEN',
          'گوگل دسترسی به Gemini API را رد کرد. کلید ممکن است سالم باشد؛ علت معمولاً مسدودیت منطقه‌ای، محدودیت کلید (IP/مرجع) یا فعال نبودن API است.',
          { cause: error, detail },
        );
      }
    }
    if (status === 429) {
      // Quota exhaustion (per-model RPM/TPM/RPD) is NOT a transient rate
      // limit: retrying won't help until the quota resets. Surface it as its
      // own non-retryable error so jobs fail fast instead of looking stuck.
      const quotaExhausted = /quota|resource[_ ]?exhausted|limit[_ ]?reached/i.test(detail ?? '');
      if (quotaExhausted) {
        return new GeminiGatewayError(
          'GEMINI_QUOTA_EXHAUSTED',
          'سهمیه این مدل Gemini تمام شده است. مدل دیگری انتخاب کنید یا بعداً دوباره تلاش کنید.',
          { cause: error, detail },
        );
      }
      return new GeminiGatewayError(
        'GEMINI_RATE_LIMIT',
        'محدودیت نرخ درخواست Gemini فعال شد. کمی بعد دوباره تلاش کنید.',
        { cause: error, detail },
      );
    }
    // Transient 5xx errors are safe to retry; permanent 4xx are not.
    return new GeminiGatewayError(
      'GEMINI_API_ERROR',
      'ارتباط با Gemini با خطا مواجه شد. وضعیت سرویس را بررسی کنید.',
      { cause: error, retryable: status >= 500, detail },
    );
  }

  if (error instanceof Error) {
    const raw = `${error.name} ${String(error.message)} ${String(error.cause ?? '')}`;
    if (NETWORK_MESSAGE.test(raw)) {
      return new GeminiGatewayError(
        'GEMINI_NETWORK_ERROR',
        'ارتباط با سرورهای Gemini برقرار نشد. اتصال اینترنت را بررسی کنید.',
        { cause: error, detail: sanitizeDetail(raw) },
      );
    }
  }

  return new GeminiGatewayError(
    'GEMINI_API_ERROR',
    'خطای غیرمنتظره‌ای در ارتباط با Gemini رخ داد.',
    { cause: error, detail: error instanceof Error ? sanitizeDetail(`${error.name} ${String(error.message)}`) : null },
  );
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

const FILE_ACTIVE_POLL_MS = 1000;
const FILE_ACTIVE_TIMEOUT_MS = 60_000;

export interface TranscribeAudioInput {
  apiKey: string;
  modelId: string;
  audioPath: string;
  mimeType: string;
  systemPrompt: string;
}

export interface TranscribeAudioResult {
  text: string;
  usage: GeminiUsage;
  durationMs: number;
}

/**
 * A stricter transcription contract appended to the user's transcription
 * prompt. It never changes the product contract — it only pushes the model to
 * transcribe more accurately: diarization, punctuation, proper nouns and
 * Persian spelling/grammar.
 */
export const TRANSCRIPTION_INTERNAL_CONTRACT = `
--- Internal transcription quality contract (system, non-negotiable) ---
This is a Persian phone conversation between a travel agent and a traveler.
Transcribe it completely and accurately.

Rules:
- Identify speakers as «فروشنده:» (agent) and «مشتری:» (traveler). Change the
  speaker only on clear evidence; do not flip mid-sentence.
- Write what was actually said. Never guess, fill gaps, reorder, summarize or
  correct the speaker's meaning. Keep colloquial Persian as-is.
- Preserve names, places, hotels, flight numbers, dates, prices and numbers
  exactly; spell Persian proper nouns carefully (ی/ک, half-spaces).
- Use correct Persian punctuation and paragraph breaks. Remove only meaningless
  fillers («اِ...») when it is safe.
- If a word or phrase is unclear, transcribe what you hear and keep the
  sentence; do not invent the missing part.
- Output the clean, complete transcript only.
`;

function normalizeUsage(metadata: {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
} | undefined): GeminiUsage {
  return {
    inputTokens: metadata?.promptTokenCount ?? null,
    outputTokens: metadata?.candidatesTokenCount ?? null,
    cachedTokens: metadata?.cachedContentTokenCount ?? null,
    totalTokens: metadata?.totalTokenCount ?? null,
  };
}

function stripModelsPrefix(name: string): string {
  return name.replace(/^models\//, '');
}

/**
 * Variants that generate another modality (audio/image output) or are
 * non-multimodal — they must never be offered for voice-to-text.
 */
const AUDIO_INPUT_EXCLUSIONS = /image|tts|audio|nano|banana|imagen|veo|video|embed|gemma|aqa/;

/**
 * Voice-to-text = accepts audio INPUT. The Gemini multimodal families
 * (flash/pro) do; image/TTS/native-audio variants and other families don't.
 * `generateAudio` is audio OUTPUT (TTS) and is deliberately excluded.
 */
function isAudioInputModel(id: string): boolean {
  const lower = id.toLowerCase();
  if (!lower.startsWith('gemini-')) return false;
  return !AUDIO_INPUT_EXCLUSIONS.test(lower);
}

/**
 * Derive capabilities from official metadata (`supportedActions`) when
 * available; fall back to a conservative name heuristic only when the
 * metadata is absent.
 */
function detectCapabilities(model: {
  id: string;
  supportedActions?: string[];
}): GeminiModelCapabilities {
  const actions = model.supportedActions ?? [];
  const id = model.id.toLowerCase();
  if (actions.length > 0) {
    return {
      generative: actions.includes('generateContent'),
      embedding: actions.includes('embedContent'),
      // `transcribeAudio` is the explicit signal; otherwise only the
      // multimodal Gemini families count. `generateAudio` (TTS output) is NOT
      // voice-to-text.
      audio: actions.includes('transcribeAudio') || isAudioInputModel(model.id),
    };
  }

  // Conservative name-based fallback when metadata is absent.
  if (id.includes('embed')) {
    return { generative: false, embedding: true, audio: false };
  }
  if (id.startsWith('gemini')) {
    return { generative: true, embedding: false, audio: isAudioInputModel(model.id) };
  }
  return { generative: false, embedding: false, audio: false };
}

/**
 * Central gateway for all Gemini communication. Future capabilities
 * (transcribeAudio, generateStructuredContent, generateContent,
 * createEmbedding) will be added here so the SDK never leaks into
 * feature modules.
 */
export class GeminiGateway {
  testConnection(apiKey: string): Promise<void> {
    return this.listModels(apiKey).then(() => undefined);
  }

  /**
   * Transcribe an audio file with Gemini. Uploads the file to the Gemini Files
   * API (handling the remote-file lifecycle), sends it with the configured
   * model and system prompt, and returns the raw text plus real usage data.
   */
  async transcribeAudio(input: TranscribeAudioInput): Promise<TranscribeAudioResult> {
    const ai = new GoogleGenAI({ apiKey: input.apiKey });
    const started = Date.now();
    let uploadedName: string | null = null;
    try {
      const uploaded = await ai.files.upload({
        file: input.audioPath,
        config: { mimeType: input.mimeType },
      });
      uploadedName = uploaded.name ?? null;
      const file = await this.waitForActiveFile(ai, uploaded);

      const response = await ai.models.generateContent({
        model: input.modelId,
        contents: [{ role: 'user', parts: [{ fileData: { fileUri: file.uri } }] }],
        config: {
          systemInstruction: {
            role: 'system',
            parts: [{ text: `${input.systemPrompt}\n${TRANSCRIPTION_INTERNAL_CONTRACT}` }],
          },
        },
      });

      const rawText = response.text ?? '';
      const firstUsage = normalizeUsage(response.usageMetadata);

      // Verification pass: a background refinement step that fixes Persian
      // spelling/grammar and speaker-label consistency without inventing
      // anything. A failure here never breaks the transcript — the raw text
      // is already usable.
      const refined = await this.refineTranscript(ai, input.modelId, rawText);

      return {
        text: refined.text,
        usage: this.mergeUsage(firstUsage, refined.usage),
        durationMs: Date.now() - started,
      };
    } catch (error) {
      const normalized = toGeminiGatewayError(error);
      throw new GeminiGatewayError(normalized.code as GeminiErrorCode, normalized.message, {
        cause: normalized.cause,
        retryable: normalized.retryable,
        durationMs: Date.now() - started,
        detail: normalized.detail,
      });
    } finally {
      // The remote file is temporary — release it regardless of outcome.
      if (uploadedName) {
        try {
          await ai.files.delete({ name: uploadedName });
        } catch {
          // Best-effort cleanup; Gemini expires files automatically.
        }
      }
    }
  }

  /**
   * Background transcription refinement: corrects Persian grammar/spelling and
   * speaker labels against the raw transcript only. Best-effort — the raw
   * transcript is returned unchanged if the model cannot improve it.
   */
  private async refineTranscript(
    ai: GoogleGenAI,
    modelId: string,
    rawText: string,
  ): Promise<{ text: string; usage: GeminiUsage }> {
    if (rawText.trim().length === 0) {
      return { text: rawText, usage: this.emptyUsage() };
    }
    try {
      const response = await ai.models.generateContent({
        model: modelId,
        contents: [
          {
            role: 'user',
            parts: [
              {
                text:
                  'متن زیر رونوشت یک مکالمهٔ فارسی است. فقط اشتباه‌های املایی/نگارشی، نیم‌فاصله، علائم نگارشی و برچسب گوینده‌ها (فروشنده/مشتری) را اصلاح کن. هیچ کلمه یا اطلاعاتی اضافه/حذف/خلاصه نکن. فقط متن اصلاح‌شده را برگردان.\n\n' +
                  rawText,
              },
            ],
          },
        ],
        config: {
          systemInstruction: {
            role: 'system',
            parts: [{ text: 'شما مصحح دقیق متن فارسی هستید. فقط متن اصلاح‌شده را برگردان، بدون توضیح.' }],
          },
        },
      });
      const text = response.text ?? '';
      if (text.trim().length === 0) return { text: rawText, usage: this.emptyUsage() };
      return { text, usage: normalizeUsage(response.usageMetadata) };
    } catch {
      // Refinement is best-effort — never fail transcription for it.
      return { text: rawText, usage: this.emptyUsage() };
    }
  }

  private emptyUsage(): GeminiUsage {
    return { inputTokens: null, outputTokens: null, cachedTokens: null, totalTokens: null };
  }

  private mergeUsage(a: GeminiUsage, b: GeminiUsage): GeminiUsage {
    const sum = (x: number | null, y: number | null): number | null =>
      x === null && y === null ? null : (x ?? 0) + (y ?? 0);
    return {
      inputTokens: sum(a.inputTokens, b.inputTokens),
      outputTokens: sum(a.outputTokens, b.outputTokens),
      cachedTokens: sum(a.cachedTokens, b.cachedTokens),
      totalTokens: sum(a.totalTokens, b.totalTokens),
    };
  }

  private async waitForActiveFile(ai: GoogleGenAI, file: GeminiFile): Promise<{ uri: string }> {
    if (!file.name) {
      if (file.uri) return { uri: file.uri };
      throw new GeminiGatewayError('GEMINI_API_ERROR', 'آپلود فایل صوتی ناتمام ماند.');
    }
    const deadline = Date.now() + FILE_ACTIVE_TIMEOUT_MS;
    let current: GeminiFile;
    while (Date.now() < deadline) {
      current = await ai.files.get({ name: file.name });
      if (current.state === 'ACTIVE' || current.state === undefined) {
        if (current.uri) return { uri: current.uri };
      }
      if (current.state === 'FAILED') {
        throw new GeminiGatewayError(
          'GEMINI_API_ERROR',
          'پردازش فایل صوتی توسط Gemini با خطا مواجه شد.',
          { cause: current.error?.message },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, FILE_ACTIVE_POLL_MS));
    }
    throw new GeminiGatewayError(
      'GEMINI_API_ERROR',
      'انتظار برای آماده‌شدن فایل صوتی در Gemini طولانی شد.',
    );
  }

  async listModels(
    apiKey: string,
    options: { probeQuota?: boolean } = {},
  ): Promise<GeminiModelInfo[]> {
    const ai = new GoogleGenAI({ apiKey });
    try {
      const pager = await ai.models.list({ config: { pageSize: 100 } });
      const models: GeminiModelInfo[] = [];
      const voiceModels: GeminiModelInfo[] = [];
      for await (const model of pager) {
        const id = stripModelsPrefix(model.name ?? '');
        if (!id) continue;
        const capabilities = detectCapabilities({
          id,
          supportedActions: model.supportedActions,
        });
        // Only expose models with at least one usable capability.
        if (!capabilities.generative && !capabilities.embedding && !capabilities.audio) {
          continue;
        }
        const info: GeminiModelInfo = {
          id,
          displayName: model.displayName ?? id,
          description: model.description ?? '',
          capabilities,
        };
        models.push(info);
        if (capabilities.audio) voiceModels.push(info);
      }
      if (options.probeQuota) {
        await this.attachQuotaStatuses(ai, voiceModels);
      }
      return models;
    } catch (error) {
      throw toGeminiGatewayError(error);
    }
  }

  /**
   * Probe each voice-capable model with a tiny request and attach the live
   * quota outcome. Bounded and concurrent so a refresh stays fast; a failed
   * probe never fails the whole refresh.
   */
  private async attachQuotaStatuses(ai: GoogleGenAI, models: GeminiModelInfo[]): Promise<void> {
    const MAX_PROBES = 12;
    const CONCURRENCY = 3;
    const targets = models.slice(0, MAX_PROBES);
    let index = 0;
    const worker = async (): Promise<void> => {
      while (index < targets.length) {
        const model = targets[index]!;
        index += 1;
        try {
          const result = await this.probeModelQuota(ai, model.id);
          model.quotaStatus = result.quotaStatus;
          model.quotaDetail = result.quotaDetail;
        } catch {
          model.quotaStatus = 'unknown';
          model.quotaDetail = null;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker()));
  }

  /** One tiny generateContent request to see whether a model accepts calls. */
  private async probeModelQuota(
    ai: GoogleGenAI,
    modelId: string,
  ): Promise<{ quotaStatus: GeminiModelQuotaStatus; quotaDetail: string | null }> {
    try {
      await ai.models.generateContent({
        model: modelId,
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        config: { maxOutputTokens: 1 },
      });
      return { quotaStatus: 'ok', quotaDetail: null };
    } catch (error) {
      const normalized = toGeminiGatewayError(error);
      switch (normalized.code) {
        case 'GEMINI_QUOTA_EXHAUSTED':
          return { quotaStatus: 'exhausted', quotaDetail: normalized.detail };
        case 'GEMINI_RATE_LIMIT':
          return { quotaStatus: 'rate_limited', quotaDetail: normalized.detail };
        default:
          return { quotaStatus: 'error', quotaDetail: normalized.detail };
      }
    }
  }

  /**
   * Create a text embedding with the configured embedding model. Returns the
   * raw vector plus real usage data. All embedding requests go through this
   * gateway — no feature module calls the SDK directly.
   */
  async createEmbedding(input: {
    apiKey: string;
    modelId: string;
    text: string;
  }): Promise<{ embedding: number[]; usage: GeminiUsage; durationMs: number }> {
    const ai = new GoogleGenAI({ apiKey: input.apiKey });
    const started = Date.now();
    try {
      const response = await ai.models.embedContent({
        model: input.modelId,
        contents: input.text,
      });
      const values = response.embeddings?.[0]?.values;
      if (!values || values.length === 0) {
        throw new GeminiGatewayError('GEMINI_API_ERROR', 'خروجی Embedding خالی بود.', {
          durationMs: Date.now() - started,
        });
      }
      // This SDK version does not expose usage metadata on embedContent —
      // null (never estimated) per project convention.
      return {
        embedding: values,
        usage: { inputTokens: null, outputTokens: null, cachedTokens: null, totalTokens: null },
        durationMs: Date.now() - started,
      };
    } catch (error) {
      if (error instanceof GeminiGatewayError) throw error;
      const normalized = toGeminiGatewayError(error);
      throw new GeminiGatewayError(normalized.code as GeminiErrorCode, normalized.message, {
        cause: normalized.cause,
        retryable: normalized.retryable,
        durationMs: Date.now() - started,
        detail: normalized.detail,
      });
    }
  }

  /**
   * One structured delta comparison: the candidate plus a small set of
   * relevant existing knowledge. Output is forced to the delta JSON schema
   * and re-validated with the shared Zod contract before any DB write.
   */
  async classifyDelta(input: {
    apiKey: string;
    modelId: string;
    systemPrompt: string;
    payload: {
      candidate: {
        canonicalText: string;
        knowledgeType: string;
        entityName: string | null;
        attribute: string | null;
        valueText: string | null;
        unit: string | null;
        confidence: number;
      };
      destination: string | null;
      existingKnowledge: {
        id: number;
        canonicalText: string;
        valueText: string | null;
        unit: string | null;
        sourceCount: number;
      }[];
    };
  }): Promise<{ classification: DeltaClassification; usage: GeminiUsage; durationMs: number }> {
    const ai = new GoogleGenAI({ apiKey: input.apiKey });
    const started = Date.now();
    try {
      const response = await ai.models.generateContent({
        model: input.modelId,
        contents: [
          { role: 'user', parts: [{ text: JSON.stringify(input.payload) }] },
        ],
        config: {
          systemInstruction: { role: 'system', parts: [{ text: input.systemPrompt }] },
          responseJsonSchema: {
            type: 'object',
            properties: {
              decision: {
                type: 'string',
                enum: ['NEW', 'CONFIRMATION', 'UPDATE', 'CONFLICT', 'IGNORE'],
              },
              matchedKnowledgeId: { type: 'integer' },
              confidence: { type: 'number' },
              reasonCode: { type: 'string' },
            },
            required: ['decision', 'matchedKnowledgeId', 'confidence', 'reasonCode'],
          },
        },
      });

      const raw = response.text ?? '';
      if (raw.trim().length === 0) {
        throw new GeminiGatewayError('GEMINI_API_ERROR', 'مقایسه دانش خروجی خالی برگرداند.', {
          durationMs: Date.now() - started,
        });
      }
      const jsonStart = raw.indexOf('{');
      const jsonEnd = raw.lastIndexOf('}');
      const json = jsonStart >= 0 && jsonEnd > jsonStart ? raw.slice(jsonStart, jsonEnd + 1) : raw;
      const parsed = JSON.parse(json) as unknown;
      const result = deltaClassificationSchema.safeParse(parsed);
      if (!result.success) {
        throw new GeminiGatewayError(
          'GEMINI_API_ERROR',
          'خروجی ساخت‌یافته مقایسه دانش نامعتبر بود.',
          { cause: result.error.message, durationMs: Date.now() - started },
        );
      }

      return {
        classification: result.data,
        usage: normalizeUsage(response.usageMetadata),
        durationMs: Date.now() - started,
      };
    } catch (error) {
      if (error instanceof GeminiGatewayError) throw error;
      const normalized = toGeminiGatewayError(error);
      throw new GeminiGatewayError(normalized.code as GeminiErrorCode, normalized.message, {
        cause: normalized.cause,
        retryable: normalized.retryable,
        durationMs: Date.now() - started,
        detail: normalized.detail,
      });
    }
  }

  /**
   * Structured knowledge analysis of a transcript. Uses the official JSON
   * schema support (responseJsonSchema) so the output is always structured;
   * the raw text is then validated again with the shared Zod contract before
   * any database write happens.
   */
  async analyzeKnowledge(input: {
    apiKey: string;
    modelId: string;
    systemPrompt: string;
    transcriptText: string;
  }): Promise<{ analysis: KnowledgeAnalysis; usage: GeminiUsage; durationMs: number }> {
    const ai = new GoogleGenAI({ apiKey: input.apiKey });
    const started = Date.now();
    try {
      const response = await ai.models.generateContent({
        model: input.modelId,
        contents: [{ role: 'user', parts: [{ text: input.transcriptText }] }],
        config: {
          systemInstruction: { role: 'system', parts: [{ text: input.systemPrompt }] },
          responseJsonSchema: {
            type: 'object',
            properties: {
              destinations: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    type: { type: 'string', enum: ['CITY', 'COUNTRY', 'REGION', 'OTHER'] },
                    confidence: { type: 'string', enum: ['CONFIRMED', 'PROVISIONAL', 'UNKNOWN'] },
                    aliases: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['name'],
                },
              },
              knowledge: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    destination_reference: { type: 'string' },
                    knowledge_type: {
                      type: 'string',
                      enum: [
                        'FACT',
                        'CUSTOMER_QUESTION',
                        'CUSTOMER_OBJECTION',
                        'CUSTOMER_NEED',
                        'SALES_INSIGHT',
                        'RECOMMENDATION',
                        'OTHER',
                      ],
                    },
                    category: { type: 'string' },
                    entity_type: { type: 'string' },
                    entity_name: { type: 'string' },
                    attribute: { type: 'string' },
                    value: { type: 'string' },
                    unit: { type: 'string' },
                    qualifiers: { type: 'array', items: { type: 'string' } },
                    canonical_text: { type: 'string' },
                    source_segment_ids: { type: 'array', items: { type: 'integer' } },
                    confidence: { type: 'number' },
                  },
                  required: ['canonical_text', 'knowledge_type'],
                },
              },
            },
          },
        },
      });

      const raw = response.text ?? '';
      if (raw.trim().length === 0) {
        throw new GeminiGatewayError('GEMINI_API_ERROR', 'تحلیل دانش خروجی خالی برگرداند.', {
          durationMs: Date.now() - started,
        });
      }
      const jsonStart = raw.indexOf('{');
      const jsonEnd = raw.lastIndexOf('}');
      const json = jsonStart >= 0 && jsonEnd > jsonStart ? raw.slice(jsonStart, jsonEnd + 1) : raw;
      const parsed = JSON.parse(json) as unknown;
      const result = knowledgeAnalysisSchema.safeParse(parsed);
      if (!result.success) {
        throw new GeminiGatewayError('GEMINI_API_ERROR', 'خروجی ساخت‌یافته تحلیل دانش نامعتبر بود.', {
          cause: result.error.message,
          durationMs: Date.now() - started,
        });
      }

      return {
        analysis: result.data,
        usage: normalizeUsage(response.usageMetadata),
        durationMs: Date.now() - started,
      };
    } catch (error) {
      if (error instanceof GeminiGatewayError) throw error;
      const normalized = toGeminiGatewayError(error);
      throw new GeminiGatewayError(normalized.code as GeminiErrorCode, normalized.message, {
        cause: normalized.cause,
        retryable: normalized.retryable,
        durationMs: Date.now() - started,
        detail: normalized.detail,
      });
    }
  }

  /**
   * One simplified processing call: a whole-voice report plus useful notes.
   * Replaces the legacy entity/attribute knowledge extraction for the new
   * product flow. Output is forced to the note schema and re-validated.
   */
  async analyzeNotes(input: {
    apiKey: string;
    modelId: string;
    systemPrompt: string;
    transcriptText: string;
  }): Promise<{ analysis: NoteExtraction; usage: GeminiUsage; durationMs: number }> {
    const ai = new GoogleGenAI({ apiKey: input.apiKey });
    const started = Date.now();
    try {
      const response = await ai.models.generateContent({
        model: input.modelId,
        contents: [{ role: 'user', parts: [{ text: input.transcriptText }] }],
        config: {
          systemInstruction: {
            role: 'system',
            parts: [{ text: `${input.systemPrompt}\n${NOTE_EXTRACTION_INTERNAL_CONTRACT}` }],
          },
          responseJsonSchema: {
            type: 'object',
            properties: {
              conversationTopic: { type: 'string' },
              voiceReport: { type: 'string' },
              notes: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    description: { type: 'string' },
                    destination: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        role: { type: 'string', enum: ['ORIGIN', 'DESTINATION', 'TRANSIT', 'COMPARISON', 'OTHER'] },
                      },
                      required: ['name'],
                    },
                    relevantDate: { type: ['string', 'null'] },
                    kind: { type: 'string', enum: ['TOUR_INFO', 'DESTINATION_INFO', 'TRAVELER_GUIDANCE'] },
                    scopeType: { type: 'string', enum: ['DESTINATION', 'TOUR'] },
                    tourSubject: { type: ['string', 'null'] },
                  },
                  required: ['title', 'description', 'destination'],
                },
              },
              audienceInsights: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    description: { type: 'string' },
                    destination: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        role: { type: 'string', enum: ['ORIGIN', 'DESTINATION', 'TRANSIT', 'COMPARISON', 'OTHER'] },
                      },
                      required: ['name'],
                    },
                    inferenceBasis: { type: 'string' },
                    confidence: { type: 'number' },
                    contentOpportunity: {
                      type: ['object', 'null'],
                      properties: {
                        title: { type: 'string' },
                        reason: { type: 'string' },
                      },
                      required: ['title', 'reason'],
                    },
                  },
                  required: ['title', 'description', 'destination', 'inferenceBasis'],
                },
              },
            },
            required: ['voiceReport', 'notes'],
          },
        },
      });

      const raw = response.text ?? '';
      if (raw.trim().length === 0) {
        throw new GeminiGatewayError('GEMINI_API_ERROR', 'پردازش ویس خروجی خالی برگرداند.', {
          durationMs: Date.now() - started,
        });
      }
      const jsonStart = raw.indexOf('{');
      const jsonEnd = raw.lastIndexOf('}');
      const json = jsonStart >= 0 && jsonEnd > jsonStart ? raw.slice(jsonStart, jsonEnd + 1) : raw;
      const parsed = JSON.parse(json) as unknown;
      const result = noteExtractionSchema.safeParse(parsed);
      if (!result.success) {
        throw new GeminiGatewayError('GEMINI_API_ERROR', 'خروجی ساخت‌یافته پردازش ویس نامعتبر بود.', {
          cause: result.error.message,
          durationMs: Date.now() - started,
        });
      }

      return {
        analysis: result.data,
        usage: normalizeUsage(response.usageMetadata),
        durationMs: Date.now() - started,
      };
    } catch (error) {
      if (error instanceof GeminiGatewayError) throw error;
      const normalized = toGeminiGatewayError(error);
      throw new GeminiGatewayError(normalized.code as GeminiErrorCode, normalized.message, {
        cause: normalized.cause,
        retryable: normalized.retryable,
        durationMs: Date.now() - started,
        detail: normalized.detail,
      });
    }
  }

  /** One ambiguous note comparison (used only when deterministic gates fail). */
  async compareNote(input: {
    apiKey: string;
    modelId: string;
    systemPrompt: string;
    payload: NoteComparisonPayload;
  }): Promise<{ comparison: NoteComparison; usage: GeminiUsage; durationMs: number }> {
    const ai = new GoogleGenAI({ apiKey: input.apiKey });
    const started = Date.now();
    try {
      const response = await ai.models.generateContent({
        model: input.modelId,
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(input.payload) }] }],
        config: {
          systemInstruction: {
            role: 'system',
            parts: [{ text: `${input.systemPrompt}\n${NOTE_COMPARISON_INTERNAL_CONTRACT}` }],
          },
          responseJsonSchema: {
            type: 'object',
            properties: {
              decision: { type: 'string', enum: ['ADD', 'UPDATE', 'MARK_OUTDATED', 'NO_CHANGE'] },
              matched_note_id: { type: 'integer' },
              log_reason: { type: 'string' },
            },
            required: ['decision', 'matched_note_id', 'log_reason'],
          },
        },
      });

      const raw = response.text ?? '';
      if (raw.trim().length === 0) {
        throw new GeminiGatewayError('GEMINI_API_ERROR', 'مقایسه نکته خروجی خالی برگرداند.', {
          durationMs: Date.now() - started,
        });
      }
      const jsonStart = raw.indexOf('{');
      const jsonEnd = raw.lastIndexOf('}');
      const json = jsonStart >= 0 && jsonEnd > jsonStart ? raw.slice(jsonStart, jsonEnd + 1) : raw;
      const parsed = JSON.parse(json) as unknown;
      const result = noteComparisonSchema.safeParse(parsed);
      if (!result.success) {
        throw new GeminiGatewayError('GEMINI_API_ERROR', 'خروجی ساخت‌یافته مقایسه نکته نامعتبر بود.', {
          cause: result.error.message,
          durationMs: Date.now() - started,
        });
      }
      return {
        comparison: result.data,
        usage: normalizeUsage(response.usageMetadata),
        durationMs: Date.now() - started,
      };
    } catch (error) {
      if (error instanceof GeminiGatewayError) throw error;
      const normalized = toGeminiGatewayError(error);
      throw new GeminiGatewayError(normalized.code as GeminiErrorCode, normalized.message, {
        cause: normalized.cause,
        retryable: normalized.retryable,
        durationMs: Date.now() - started,
        detail: normalized.detail,
      });
    }
  }

  /**
   * Generate batch-delta content (Phase 11). Plain-text output — the user's
   * CONTENT_GENERATION system prompt controls style, length and structure.
   * Stateless: system prompt + destination + current batch delta only.
   */
  async generateContent(input: {
    apiKey: string;
    modelId: string;
    systemPrompt: string;
    userText: string;
  }): Promise<{ text: string; usage: GeminiUsage; durationMs: number }> {
    const ai = new GoogleGenAI({ apiKey: input.apiKey });
    const started = Date.now();
    try {
      const response = await ai.models.generateContent({
        model: input.modelId,
        contents: [{ role: 'user', parts: [{ text: input.userText }] }],
        config: {
          systemInstruction: { role: 'system', parts: [{ text: input.systemPrompt }] },
        },
      });
      const text = response.text ?? '';
      if (text.trim().length === 0) {
        throw new GeminiGatewayError('GEMINI_API_ERROR', 'تولید محتوا خروجی خالی برگرداند.', {
          durationMs: Date.now() - started,
        });
      }
      return {
        text,
        usage: normalizeUsage(response.usageMetadata),
        durationMs: Date.now() - started,
      };
    } catch (error) {
      if (error instanceof GeminiGatewayError) throw error;
      const normalized = toGeminiGatewayError(error);
      throw new GeminiGatewayError(normalized.code as GeminiErrorCode, normalized.message, {
        cause: normalized.cause,
        retryable: normalized.retryable,
        durationMs: Date.now() - started,
        detail: normalized.detail,
      });
    }
  }

  /**
   * Processing newsroom reporter. Produces structured editorial stories (H2 +
   * paragraphs) for one destination from the backend-computed diffs — never
   * re-derives novelty and never consults external knowledge. Uses the fixed
   * internal reporter prompt (product logic, not a user-configurable setting).
   */
  async generateNewsroom(input: {
    apiKey: string;
    modelId: string;
    payload: NewsroomPayload;
  }): Promise<{ stories: NewsroomStory[]; noNewsReason: string | null; usage: GeminiUsage; durationMs: number }> {
    const ai = new GoogleGenAI({ apiKey: input.apiKey });
    const started = Date.now();
    try {
      const response = await ai.models.generateContent({
        model: input.modelId,
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(input.payload) }] }],
        config: {
          systemInstruction: { role: 'system', parts: [{ text: NEWSROOM_REPORTER_PROMPT }] },
          responseJsonSchema: {
            type: 'object',
            properties: {
              stories: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    headline: { type: 'string' },
                    subheading: { type: ['string', 'null'] },
                    paragraphs: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['headline', 'paragraphs'],
                },
              },
              noNewsReason: { type: ['string', 'null'] },
            },
            required: ['stories'],
          },
        },
      });
      const raw = response.text ?? '';
      if (raw.trim().length === 0) {
        throw new GeminiGatewayError('GEMINI_API_ERROR', 'تولید گزارش پردازش خروجی خالی برگرداند.', {
          durationMs: Date.now() - started,
        });
      }
      const jsonStart = raw.indexOf('{');
      const jsonEnd = raw.lastIndexOf('}');
      const json = jsonStart >= 0 && jsonEnd > jsonStart ? raw.slice(jsonStart, jsonEnd + 1) : raw;
      const parsed = JSON.parse(json) as unknown;
      const result = newsroomStoriesSchema.safeParse(parsed);
      if (!result.success) {
        throw new GeminiGatewayError('GEMINI_API_ERROR', 'خروجی ساخت‌یافته گزارش پردازش نامعتبر بود.', {
          cause: result.error.message,
          durationMs: Date.now() - started,
        });
      }
      return {
        stories: result.data.stories,
        noNewsReason: result.data.noNewsReason?.trim() || null,
        usage: normalizeUsage(response.usageMetadata),
        durationMs: Date.now() - started,
      };
    } catch (error) {
      if (error instanceof GeminiGatewayError) throw error;
      const normalized = toGeminiGatewayError(error);
      throw new GeminiGatewayError(normalized.code as GeminiErrorCode, normalized.message, {
        cause: normalized.cause,
        retryable: normalized.retryable,
        durationMs: Date.now() - started,
        detail: normalized.detail,
      });
    }
  }
}

export const geminiGateway = new GeminiGateway();

/** Public surface used by the worker and by test doubles. */
export type GeminiGatewayLike = Pick<
  GeminiGateway,
  | 'testConnection'
  | 'listModels'
  | 'transcribeAudio'
  | 'analyzeKnowledge'
  | 'analyzeNotes'
  | 'compareNote'
  | 'createEmbedding'
  | 'classifyDelta'
  | 'generateContent'
>;
