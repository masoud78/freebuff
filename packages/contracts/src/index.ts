/**
 * Shared contracts between `@freebuff/web` and `@freebuff/server`.
 *
 * Contains the shared Zod schema for validation plus plain types. Type-only
 * imports stay free of runtime code; value imports (e.g. `appSettingsSchema`)
 * bundle the schema so both ends validate identically.
 */
import { z } from 'zod';

/** Health status of the backend as a whole. */
export type BackendStatus = 'ok' | 'degraded';

/** Health status of the SQLite database. */
export interface DatabaseHealth {
  status: 'connected' | 'unavailable';
}

/** Response of `GET /api/health`. */
export interface HealthResponse {
  status: BackendStatus;
  database: DatabaseHealth;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Shared Zod schema for application settings. Used for validation on both ends. */
export const appSettingsSchema = z.object({
  workspacePath: z.string().min(1, 'مسیر Workspace نمی‌تواند خالی باشد.'),
  processingConcurrency: z
    .number()
    .int('تعداد پردازش همزمان باید عدد صحیح باشد.')
    .min(1, 'تعداد پردازش همزمان باید حداقل ۱ باشد.')
    .max(10, 'تعداد پردازش همزمان باید حداکثر ۱۰ باشد.'),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const settingsErrorCodes = [
  'SETTINGS_VALIDATION_ERROR',
  'WORKSPACE_PATH_INVALID',
  'DATABASE_ERROR',
] as const;

export type SettingsErrorCode = (typeof settingsErrorCodes)[number];

export const geminiErrorCodes = [
  'GEMINI_NOT_CONFIGURED',
  'GEMINI_AUTH_ERROR',
  'GEMINI_NETWORK_ERROR',
  'GEMINI_RATE_LIMIT',
  'GEMINI_API_ERROR',
] as const;

export type GeminiErrorCode = (typeof geminiErrorCodes)[number];

export const batchErrorCodes = [
  'AUDIO_FILE_NOT_FOUND',
  'AUDIO_FILE_READ_ERROR',
  'AUDIO_FORMAT_UNSUPPORTED',
  'AUDIO_HASH_ERROR',
  'BATCH_SCAN_ERROR',
  'JOB_CREATION_ERROR',
  'BATCH_NOT_FOUND',
  'BATCH_NOT_STARTABLE',
] as const;

export type BatchErrorCode = (typeof batchErrorCodes)[number];

export const transcriptionErrorCodes = [
  'TRANSCRIPTION_MODEL_NOT_CONFIGURED',
  'TRANSCRIPTION_PROMPT_NOT_CONFIGURED',
  'AUDIO_READ_ERROR',
  'TRANSCRIPTION_FAILED',
  'TRANSCRIPTION_EMPTY_RESPONSE',
  'TRANSCRIPT_SAVE_FAILED',
] as const;

export type TranscriptionErrorCode = (typeof transcriptionErrorCodes)[number];

export const knowledgeErrorCodes = [
  'KNOWLEDGE_MODEL_NOT_CONFIGURED',
  'KNOWLEDGE_PROMPT_NOT_CONFIGURED',
  'KNOWLEDGE_ANALYSIS_FAILED',
  'KNOWLEDGE_INVALID_OUTPUT',
  'KNOWLEDGE_INVALID_SEGMENT',
  'KNOWLEDGE_SAVE_FAILED',
  'TRANSCRIPT_NOT_FOUND',
] as const;

export type KnowledgeErrorCode = (typeof knowledgeErrorCodes)[number];

export const deltaErrorCodes = [
  'DELTA_MODEL_NOT_CONFIGURED',
  'EMBEDDING_MODEL_NOT_CONFIGURED',
  'EMBEDDING_FAILED',
  'DELTA_CLASSIFICATION_INVALID',
  'DELTA_PROCESSING_FAILED',
  'CANDIDATE_NOT_FOUND',
] as const;

export type DeltaErrorCode = (typeof deltaErrorCodes)[number];

export const reconciliationErrorCodes = [
  'RECONCILIATION_TARGET_NOT_FOUND',
  'RECONCILIATION_VERSION_CONFLICT',
  'RECONCILIATION_DUPLICATE',
  'KNOWLEDGE_TRANSACTION_FAILED',
  'CONFLICT_CREATE_FAILED',
  'BATCH_DELTA_FINALIZATION_FAILED',
] as const;

export type ReconciliationErrorCode = (typeof reconciliationErrorCodes)[number];

export const contentErrorCodes = [
  'CONTENT_MODEL_NOT_CONFIGURED',
  'CONTENT_PROMPT_NOT_CONFIGURED',
  'CONTENT_DELTA_EMPTY',
  'CONTENT_INPUT_TOO_LARGE',
  'CONTENT_GENERATION_FAILED',
  'CONTENT_EMPTY_RESPONSE',
  'CONTENT_SAVE_FAILED',
  'CONTENT_TRACEABILITY_FAILED',
] as const;

export type ContentErrorCode = (typeof contentErrorCodes)[number];

export const apiErrorCodes = [
  ...settingsErrorCodes,
  ...geminiErrorCodes,
  'MODEL_CONFIG_INVALID',
  'PROMPT_NOT_FOUND',
  'PROMPT_INVALID',
  ...batchErrorCodes,
  ...transcriptionErrorCodes,
  ...knowledgeErrorCodes,
  ...deltaErrorCodes,
  ...reconciliationErrorCodes,
  ...contentErrorCodes,
] as const;

export type ApiErrorCode = (typeof apiErrorCodes)[number];

/** Error payload returned by API endpoints on failure. */
export interface ApiErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}

// ---------------------------------------------------------------------------
// Gemini credentials
// ---------------------------------------------------------------------------

export const geminiCredentialStatuses = ['NOT_CONFIGURED', 'CONFIGURED', 'INVALID'] as const;
export type GeminiCredentialStatus = (typeof geminiCredentialStatuses)[number];

export const geminiTestOutcomes = [
  'success',
  'auth_error',
  'network_error',
  'rate_limit',
  'api_error',
] as const;
export type GeminiTestOutcome = (typeof geminiTestOutcomes)[number];

export const geminiApiKeyInputSchema = z.object({
  apiKey: z.string().trim().min(1, 'API Key نمی‌تواند خالی باشد.'),
});

export type GeminiApiKeyInput = z.infer<typeof geminiApiKeyInputSchema>;

export interface GeminiCredentialStatusResponse {
  status: GeminiCredentialStatus;
  lastTestedAt: string | null;
  lastTestOutcome: GeminiTestOutcome | null;
}

export interface GeminiTestConnectionResponse extends GeminiCredentialStatusResponse {
  message: string;
}

// ---------------------------------------------------------------------------
// Gemini models
// ---------------------------------------------------------------------------

export interface GeminiModelCapabilities {
  generative: boolean;
  embedding: boolean;
  audio: boolean;
}

export interface GeminiModelInfo {
  id: string;
  displayName: string;
  description: string;
  capabilities: GeminiModelCapabilities;
}

export interface GeminiModelsResponse {
  models: GeminiModelInfo[];
  refreshedAt: string | null;
}

// ---------------------------------------------------------------------------
// Model configuration
// ---------------------------------------------------------------------------

export const modelStages = [
  'TRANSCRIPTION',
  'KNOWLEDGE_PROCESSING',
  'CONTENT_GENERATION',
  'EMBEDDING',
] as const;

export type ModelStage = (typeof modelStages)[number];

export const modelProviders = ['GEMINI'] as const;
export type ModelProvider = (typeof modelProviders)[number];

export const modelConfigSchema = z.object({
  stage: z.enum(modelStages, { message: 'Stage نامعتبر است.' }),
  modelId: z.string().trim().min(1, 'مدل انتخاب نشده است.'),
});

export type ModelConfigInput = z.infer<typeof modelConfigSchema>;

export interface ModelConfigResponse {
  stage: ModelStage;
  provider: ModelProvider;
  modelId: string;
  /** Whether the model id is present in the latest discovery result. */
  available: boolean;
}

export type ModelConfigsResponse = ModelConfigResponse[];

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const promptTypes = [
  'TRANSCRIPTION',
  'KNOWLEDGE_PROCESSING',
  'CONTENT_GENERATION',
] as const;

export type PromptType = (typeof promptTypes)[number];

/** Prompt content — may be empty, but empty content is never processing-ready. */
export const promptContentSchema = z.object({
  content: z.string(),
});

export type PromptContentInput = z.infer<typeof promptContentSchema>;

export interface PromptVersionInfo {
  id: number;
  versionNumber: number;
  content: string;
  isActive: boolean;
  createdAt: string;
}

export interface PromptTemplateInfo {
  promptType: PromptType;
  displayName: string;
  activeVersion: PromptVersionInfo | null;
  versionCount: number;
}

export type PromptTemplatesResponse = PromptTemplateInfo[];

export interface PromptVersionsResponse {
  promptType: PromptType;
  displayName: string;
  versions: PromptVersionInfo[];
}

// ---------------------------------------------------------------------------
// AI configuration readiness
// ---------------------------------------------------------------------------

export interface AiReadinessCheck {
  key: string;
  ready: boolean;
}

export interface AiReadinessResponse {
  ready: boolean;
  checks: AiReadinessCheck[];
}

// ---------------------------------------------------------------------------
// Batches / audio ingestion / jobs
// ---------------------------------------------------------------------------

export const batchStatuses = [
  'CREATED',
  'SCANNING',
  'READY',
  'PROCESSING',
  'TRANSCRIBING',
  'ANALYZING',
  'DELTA_PROCESSING',
  'RECONCILING',
  'ANALYSIS_COMPLETED',
  'KNOWLEDGE_READY',
  'GENERATING_CONTENT',
  'COMPLETED',
  'PARTIAL_FAILED',
  'FAILED',
  'CANCELLED',
] as const;

export type BatchStatus = (typeof batchStatuses)[number];

export const audioStatuses = [
  'DISCOVERED',
  'REGISTERED',
  'DUPLICATE',
  'QUEUED',
  'TRANSCRIBING',
  'TRANSCRIBED',
  'FAILED',
] as const;

export type AudioStatus = (typeof audioStatuses)[number];

export const jobStatuses = ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type JobStatus = (typeof jobStatuses)[number];

export const jobTypes = ['TRANSCRIPTION', 'KNOWLEDGE_ANALYSIS', 'KNOWLEDGE_DELTA', 'KNOWLEDGE_RECONCILIATION', 'CONTENT_GENERATION'] as const;
export type JobType = (typeof jobTypes)[number];

/** Extensions accepted for audio ingestion. */
export const SUPPORTED_AUDIO_EXTENSIONS = [
  '.mp3',
  '.wav',
  '.m4a',
  '.aac',
  '.ogg',
  '.flac',
  '.webm',
] as const;

export interface BatchStats {
  totalAudio: number;
  newAudio: number;
  duplicates: number;
  queuedJobs: number;
  transcribing: number;
  transcribed: number;
  failedItems: number;
  /** Knowledge analysis jobs waiting or running. */
  knowledgePending: number;
  knowledgeAnalyzing: number;
  /** Transcripts that finished knowledge analysis. */
  knowledgeAnalyzed: number;
  /** Distinct destinations detected in this batch. */
  detectedDestinations: number;
  /** Total extracted knowledge items from this batch. */
  extractedKnowledge: number;
  /** Knowledge candidates waiting for delta comparison. */
  candidatesPending: number;
  /** Knowledge candidates with a delta decision. */
  candidatesDecided: number;
  /** Knowledge candidates that failed delta processing. */
  candidatesFailed: number;
  /** KNOWLEDGE_DELTA jobs waiting to run. */
  deltaPending: number;
  /** KNOWLEDGE_DELTA jobs currently comparing. */
  deltaComparing: number;
  /** KNOWLEDGE_DELTA jobs completed. */
  deltaDecided: number;
  /** KNOWLEDGE_DELTA jobs failed. */
  deltaFailed: number;
  /** KNOWLEDGE_RECONCILIATION jobs waiting to run. */
  reconcilePending: number;
  /** KNOWLEDGE_RECONCILIATION jobs currently applying. */
  reconcileRunning: number;
  /** KNOWLEDGE_RECONCILIATION jobs completed. */
  reconcileCompleted: number;
  /** KNOWLEDGE_RECONCILIATION jobs failed. */
  reconcileFailed: number;
  /** CONTENT_GENERATION jobs waiting to run. */
  contentPending: number;
  /** CONTENT_GENERATION jobs currently generating. */
  contentGenerating: number;
  /** CONTENT_GENERATION jobs completed. */
  contentGenerated: number;
  /** CONTENT_GENERATION jobs failed. */
  contentFailed: number;
}

export interface BatchSummary {
  id: number;
  status: BatchStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  stats: BatchStats;
}

export type BatchListResponse = BatchSummary[];

/** Audio file as exposed to the UI — the local absolute path never leaves the server. */
export interface AudioFileInfo {
  id: number;
  originalName: string;
  size: number;
  status: AudioStatus;
  duplicateOfAudioId: number | null;
  createdAt: string;
  /** Current attempt count of the audio's transcription job (0 when none). */
  attempt: number;
  jobStatus: JobStatus | null;
  /** Whether a completed transcript exists for this audio. */
  hasTranscript: boolean;
}

export interface BatchDetailResponse extends BatchSummary {
  audio: AudioFileInfo[];
}

export interface ScanResult {
  discoveredFiles: number;
  newAudio: number;
  duplicates: number;
  unsupported: number;
  queuedJobs: number;
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

export const transcriptStatuses = ['COMPLETED', 'FAILED'] as const;
export type TranscriptStatus = (typeof transcriptStatuses)[number];

export const apiUsageStages = ['TRANSCRIPTION', 'KNOWLEDGE', 'EMBEDDING', 'CONTENT'] as const;
export type ApiUsageStage = (typeof apiUsageStages)[number];

export const apiUsageStatuses = ['SUCCESS', 'FAILED'] as const;
export type ApiUsageStatus = (typeof apiUsageStatuses)[number];

/** Normalized Gemini usage metadata. Unknown values stay null — never estimated. */
export interface GeminiUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  totalTokens: number | null;
}

export interface TranscriptSegmentInfo {
  id: number;
  sequence: number;
  speaker: string | null;
  text: string;
  normalizedText: string;
  startTime: number | null;
  endTime: number | null;
}

export interface TranscriptInfo {
  id: number;
  audioId: number;
  fullText: string;
  normalizedText: string;
  normalizedHash: string;
  language: string | null;
  modelId: string;
  promptVersionId: number;
  status: TranscriptStatus;
  duplicateOfTranscriptId: number | null;
  createdAt: string;
}

export interface TranscriptResponse {
  audioId: number;
  audioName: string;
  transcript: TranscriptInfo;
  segments: TranscriptSegmentInfo[];
}

// ---------------------------------------------------------------------------
// Destinations & knowledge (Phase 8)
// ---------------------------------------------------------------------------

export const destinationTypes = ['CITY', 'COUNTRY', 'REGION', 'OTHER'] as const;
export type DestinationType = (typeof destinationTypes)[number];

export const destinationStatuses = ['PROVISIONAL', 'CONFIRMED', 'MERGED'] as const;
export type DestinationStatus = (typeof destinationStatuses)[number];

/** Gemini's confidence signal for a detected destination. */
export const destinationConfidenceLevels = ['CONFIRMED', 'PROVISIONAL', 'UNKNOWN'] as const;
export type DestinationConfidence = (typeof destinationConfidenceLevels)[number];

export const knowledgeTypes = [
  'FACT',
  'CUSTOMER_QUESTION',
  'CUSTOMER_OBJECTION',
  'CUSTOMER_NEED',
  'SALES_INSIGHT',
  'RECOMMENDATION',
  'OTHER',
] as const;
export type KnowledgeType = (typeof knowledgeTypes)[number];

export const knowledgeStatuses = ['ACTIVE', 'PROVISIONAL', 'ARCHIVED'] as const;
export type KnowledgeStatus = (typeof knowledgeStatuses)[number];

/** Structured analysis output Gemini returns (also used for validation). */
export const knowledgeAnalysisSchema = z.object({
  destinations: z
    .array(
      z.object({
        name: z.string().min(1),
        type: z.enum(destinationTypes, { message: 'نوع مقصد نامعتبر است.' }).default('OTHER'),
        confidence: z.enum(destinationConfidenceLevels).default('PROVISIONAL'),
        aliases: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  knowledge: z
    .array(
      z.object({
        destinationReference: z.string().nullable().default(null),
        knowledgeType: z.enum(knowledgeTypes, { message: 'نوع دانش نامعتبر است.' }).default('OTHER'),
        category: z.string().nullable().default(null),
        entityType: z.string().nullable().default(null),
        entityName: z.string().nullable().default(null),
        attribute: z.string().nullable().default(null),
        value: z.string().nullable().default(null),
        unit: z.string().nullable().default(null),
        qualifiers: z.array(z.string()).default([]),
        canonicalText: z.string().min(1, 'متن دانش نمی‌تواند خالی باشد.'),
        sourceSegmentIds: z.array(z.number().int().positive()).default([]),
        confidence: z.number().min(0).max(1).default(0.5),
      }),
    )
    .default([]),
});

export type KnowledgeAnalysis = z.infer<typeof knowledgeAnalysisSchema>;

export interface DestinationSummary {
  id: number;
  canonicalName: string;
  type: DestinationType;
  status: DestinationStatus;
  aliases: string[];
  knowledgeCount: number;
  sourceTranscriptCount: number;
  firstSeenBatchId: number | null;
  createdAt: string;
}

export type DestinationListResponse = DestinationSummary[];

export interface KnowledgeSummary {
  id: number;
  destinationId: number | null;
  knowledgeType: KnowledgeType;
  category: string | null;
  entityType: string | null;
  entityName: string | null;
  attribute: string | null;
  currentValue: string | null;
  unit: string | null;
  status: KnowledgeStatus;
  confidence: number;
  canonicalText: string;
  sourceCount: number;
  createdAt: string;
}

export interface DestinationDetailResponse extends DestinationSummary {
  knowledge: KnowledgeSummary[];
  sources: {
    transcriptId: number;
    audioId: number;
    audioName: string;
    batchId: number;
    analyzedAt: string;
  }[];
}

/** Knowledge attached to a transcript, for the transcript viewer. */
// ---------------------------------------------------------------------------
// Knowledge Delta (Phase 9)
// ---------------------------------------------------------------------------

export const deltaDecisionValues = ['NEW', 'CONFIRMATION', 'UPDATE', 'CONFLICT', 'IGNORE'] as const;
export type DeltaDecision = (typeof deltaDecisionValues)[number];

export const candidateStatuses = ['PENDING', 'DECIDED', 'FAILED'] as const;
export type CandidateStatus = (typeof candidateStatuses)[number];

/**
 * Structured Gemini output for one delta comparison. `matchedKnowledgeId`
 * uses 0 on the wire for "no existing knowledge" (structured output cannot
 * express null reliably); the backend maps 0 → null before persisting.
 */
export const deltaClassificationSchema = z.object({
  decision: z.enum(deltaDecisionValues, { message: 'تصمیم نامعتبر است.' }),
  matchedKnowledgeId: z.number().int().min(0).default(0),
  confidence: z.number().min(0).max(1).default(0.5),
  reasonCode: z.string().max(60).default(''),
});

export type DeltaClassification = z.infer<typeof deltaClassificationSchema>;

/** Stable metric keys for token/API savings (Phase 11 surfaces them in the UI). */
export const deltaMetricKeys = [
  'exact_confirmation_count',
  'embedding_cache_hit_count',
  'delta_ai_call_skipped_count',
  'destinations_no_publishable_delta_count',
  'content_generation_call_count',
  'content_generation_reuse_count',
] as const;
export type DeltaMetricKey = (typeof deltaMetricKeys)[number];

/** One knowledge candidate with its delta decision, for the batch UI. */
export interface KnowledgeCandidateInfo {
  id: number;
  transcriptId: number;
  destinationId: number | null;
  destinationName: string | null;
  knowledgeType: KnowledgeType;
  entityName: string | null;
  attribute: string | null;
  valueText: string | null;
  unit: string | null;
  canonicalText: string;
  status: CandidateStatus;
  createdAt: string;
  decision: {
    decision: DeltaDecision | null;
    confidence: number | null;
    reasonCode: string | null;
    matchedKnowledgeId: number | null;
    matchedKnowledgeText: string | null;
    matchedCandidateId: number | null;
  };
}

export interface KnowledgeDecisionsResponse {
  batchId: number;
  candidates: KnowledgeCandidateInfo[];
}

/** One retrieval hit, exposed for debuggable retrieval in the UI. */
export interface CandidateRetrievalMatch {
  knowledgeId: number;
  canonicalText: string;
  matchType: 'identity' | 'entity_attribute' | 'lexical' | 'semantic';
  similarity: number | null;
}

export interface CandidateRetrievalDebugResponse {
  candidateId: number;
  destinationId: number | null;
  destinationName: string | null;
  matches: CandidateRetrievalMatch[];
}

// ---------------------------------------------------------------------------
// Master knowledge, conflicts, changes & batch delta (Phase 10)
// ---------------------------------------------------------------------------

export const conflictStatuses = ['OPEN', 'RESOLVED', 'DISMISSED'] as const;
export type ConflictStatus = (typeof conflictStatuses)[number];

export const knowledgeChangeTypes = ['NEW', 'UPDATE'] as const;
export type KnowledgeChangeType = (typeof knowledgeChangeTypes)[number];

/** One master knowledge item with its current value (destination-scoped). */
export interface MasterKnowledgeItem {
  id: number;
  destinationId: number | null;
  knowledgeType: KnowledgeType;
  category: string | null;
  entityType: string | null;
  entityName: string | null;
  attribute: string | null;
  canonicalText: string;
  currentValue: string | null;
  unit: string | null;
  versionNumber: number;
  status: KnowledgeStatus;
  evidenceCount: number;
  firstSeenBatchId: number | null;
  firstSeenAt: string | null;
  lastSeenBatchId: number | null;
  lastSeenAt: string | null;
}

export interface KnowledgeVersionInfo {
  id: number;
  versionNumber: number;
  valueText: string | null;
  unit: string | null;
  qualifiersJson: string | null;
  canonicalText: string;
  isCurrent: boolean;
  createdAt: string;
  evidenceCount: number;
}

export interface KnowledgeEvidenceInfo {
  id: number;
  knowledgeId: number;
  knowledgeVersionId: number;
  versionNumber: number;
  batchId: number | null;
  audioId: number | null;
  transcriptId: number;
  audioName: string | null;
  segmentId: number | null;
  sourceText: string;
  createdAt: string;
}

export interface KnowledgeChangeInfo {
  id: number;
  batchId: number;
  destinationId: number | null;
  knowledgeId: number;
  changeType: KnowledgeChangeType;
  oldVersionId: number | null;
  newVersionId: number;
  oldValue: string | null;
  newValue: string | null;
  canonicalText: string;
  createdAt: string;
}

export interface KnowledgeConflictInfo {
  id: number;
  destinationId: number | null;
  destinationName: string | null;
  knowledgeId: number | null;
  candidateId: number;
  existingVersionId: number | null;
  existingValue: string | null;
  candidateCanonicalText: string;
  candidateValue: string | null;
  status: ConflictStatus;
  conflictType: string | null;
  conflictGroupKey: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface KnowledgeDetailResponse {
  item: MasterKnowledgeItem;
  versions: KnowledgeVersionInfo[];
  evidence: KnowledgeEvidenceInfo[];
  changes: KnowledgeChangeInfo[];
}

export interface DestinationMasterKnowledgeResponse {
  destinationId: number;
  items: MasterKnowledgeItem[];
  total: number;
}

export interface DestinationConflictsResponse {
  destinationId: number;
  conflicts: KnowledgeConflictInfo[];
}

export interface DestinationChangesResponse {
  destinationId: number;
  changes: KnowledgeChangeInfo[];
}

export interface BatchDestinationSummaryInfo {
  batchId: number;
  destinationId: number;
  destinationName: string;
  newCount: number;
  updatedCount: number;
  confirmationCount: number;
  conflictCount: number;
  ignoredCount: number;
  publishableDeltaCount: number;
  status: string;
}

export interface BatchDeltaItem {
  changeId: number;
  changeType: KnowledgeChangeType;
  knowledgeId: number;
  versionId: number;
  canonicalText: string;
  currentValue: string | null;
  /** Previous value for UPDATE changes (context only — never the current fact). */
  oldValue: string | null;
  unit: string | null;
  entityName: string | null;
  attribute: string | null;
  knowledgeType: KnowledgeType;
}

export interface BatchDestinationDelta {
  destinationId: number | null;
  destinationName: string | null;
  items: BatchDeltaItem[];
}

export interface BatchDeltaResponse {
  batchId: number;
  destinations: BatchDestinationDelta[];
}

// ---------------------------------------------------------------------------
// Generated content (Phase 11)
// ---------------------------------------------------------------------------

export const generatedContentStatuses = ['GENERATED', 'FAILED', 'SUPERSEDED'] as const;
export type GeneratedContentStatus = (typeof generatedContentStatuses)[number];

/** One content generation (a version/attempt for one batch+destination). */
export interface GeneratedContentInfo {
  id: number;
  batchId: number;
  destinationId: number | null;
  destinationName: string | null;
  content: string;
  modelId: string;
  promptVersionId: number;
  generationNumber: number;
  status: GeneratedContentStatus;
  deltaSignature: string;
  knowledgeCount: number;
  createdAt: string;
}

/** One knowledge item a generated content is based on (traceability). */
export interface GeneratedContentKnowledgeLink {
  generatedContentId: number;
  knowledgeId: number;
  knowledgeVersionId: number;
  changeId: number;
  changeType: KnowledgeChangeType;
  canonicalText: string;
  currentValue: string | null;
  oldValue: string | null;
}

export interface GeneratedContentDetailResponse extends GeneratedContentInfo {
  knowledge: GeneratedContentKnowledgeLink[];
}

/** Generations grouped per destination for a batch (UI). */
export interface BatchGeneratedContentDestination {
  destinationId: number | null;
  destinationName: string | null;
  generations: GeneratedContentInfo[];
  /** True when the destination existed in the batch but had no publishable delta. */
  noPublishableDelta: boolean;
}

export interface BatchGeneratedContentsResponse {
  batchId: number;
  destinations: BatchGeneratedContentDestination[];
}

/** History grouped per batch for a destination (UI). */
export interface DestinationContentHistoryResponse {
  destinationId: number;
  batches: {
    batchId: number;
    generations: GeneratedContentInfo[];
  }[];
}

export interface ContentRegenerateRequest {
  /** Optional: force regeneration even when the same generation exists. */
  force?: boolean;
}

export interface ContentRegenerateResponse {
  destinationId: number;
  generationNumber: number;
  queued: boolean;
}

/** Per-stage usage aggregate of a batch (from real api_usage data). */
export interface UsageStageSummary {
  calls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
}

export type BatchUsageResponse = Partial<Record<ApiUsageStage, UsageStageSummary>>;

export interface TranscriptKnowledgeInfo {
  destinations: {
    id: number;
    canonicalName: string;
    type: DestinationType;
    confidence: number;
  }[];
  knowledge: {
    id: number;
    knowledgeType: KnowledgeType;
    entityType: string | null;
    entityName: string | null;
    attribute: string | null;
    currentValue: string | null;
    unit: string | null;
    status: KnowledgeStatus;
    canonicalText: string;
  }[];
}

