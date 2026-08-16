import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Internal application metadata (e.g. schema version, feature flags).
 *
 * Not for business data — business tables will get their own migrations.
 */
export const systemMeta = sqliteTable('system_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export type SystemMeta = typeof systemMeta.$inferSelect;
export type NewSystemMeta = typeof systemMeta.$inferInsert;

/**
 * General application settings, stored as a single row (id = 1).
 * No secrets or API keys live here.
 */
export const appSettings = sqliteTable('app_settings', {
  id: integer('id').primaryKey(),
  workspacePath: text('workspace_path').notNull(),
  processingConcurrency: integer('processing_concurrency').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export type AppSettingsRow = typeof appSettings.$inferSelect;
export type NewAppSettingsRow = typeof appSettings.$inferInsert;

/** Model selected per processing stage (one row per stage). */
export const modelConfigs = sqliteTable('model_configs', {
  id: integer('id').primaryKey(),
  stage: text('stage').notNull().unique(),
  provider: text('provider').notNull(),
  modelId: text('model_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export type ModelConfigRow = typeof modelConfigs.$inferSelect;
export type NewModelConfigRow = typeof modelConfigs.$inferInsert;

/** Local cache of the last Gemini model discovery result. */
export const geminiModels = sqliteTable('gemini_models', {
  id: integer('id').primaryKey(),
  modelId: text('model_id').notNull().unique(),
  displayName: text('display_name').notNull(),
  description: text('description').notNull().default(''),
  capabilitiesJson: text('capabilities_json').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export type GeminiModelsRow = typeof geminiModels.$inferSelect;
export type NewGeminiModelsRow = typeof geminiModels.$inferInsert;

/** Prompt templates (one per prompt type). */
export const promptTemplates = sqliteTable('prompt_templates', {
  id: integer('id').primaryKey(),
  promptType: text('prompt_type').notNull().unique(),
  displayName: text('display_name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export type PromptTemplateRow = typeof promptTemplates.$inferSelect;
export type NewPromptTemplateRow = typeof promptTemplates.$inferInsert;

/** Versioned prompt content. Exactly one active version per template. */
export const promptVersions = sqliteTable('prompt_versions', {
  id: integer('id').primaryKey(),
  promptTemplateId: integer('prompt_template_id')
    .notNull()
    .references(() => promptTemplates.id),
  versionNumber: integer('version_number').notNull(),
  content: text('content').notNull().default(''),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export type PromptVersionRow = typeof promptVersions.$inferSelect;
export type NewPromptVersionRow = typeof promptVersions.$inferInsert;

/** Processing boundary — one import round of audio files. */
export const batches = sqliteTable('batches', {
  id: integer('id').primaryKey(),
  status: text('status').notNull().default('CREATED'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }),
  completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
});

export type BatchRow = typeof batches.$inferSelect;
export type NewBatchRow = typeof batches.$inferInsert;

/** Audio files discovered in the workspace input folder. */
export const audioFiles = sqliteTable(
  'audio_files',
  {
    id: integer('id').primaryKey(),
    batchId: integer('batch_id')
      .notNull()
      .references(() => batches.id),
    originalName: text('original_name').notNull(),
    absolutePath: text('absolute_path').notNull(),
    extension: text('extension').notNull(),
    mimeType: text('mime_type').notNull(),
    fileSize: integer('file_size').notNull(),
    sha256: text('sha256').notNull(),
    status: text('status').notNull().default('DISCOVERED'),
    // No FK constraint: a self-reference here creates a circular table
    // definition. Referential integrity is enforced by the service layer.
    duplicateOfAudioId: integer('duplicate_of_audio_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('audio_files_sha256_idx').on(table.sha256),
    index('audio_files_batch_id_idx').on(table.batchId),
  ],
);

export type AudioFileRow = typeof audioFiles.$inferSelect;
export type NewAudioFileRow = typeof audioFiles.$inferInsert;

/** Persistent job queue stored in SQLite (no external queue). */
export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey(),
    batchId: integer('batch_id')
      .notNull()
      .references(() => batches.id),
    jobType: text('job_type').notNull(),
    entityId: integer('entity_id').notNull(),
    status: text('status').notNull().default('PENDING'),
    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    idempotencyKey: text('idempotency_key').notNull(),
    lockedAt: integer('locked_at', { mode: 'timestamp_ms' }),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    nextAttemptAt: integer('next_attempt_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('jobs_idempotency_key_unique_idx').on(table.idempotencyKey),
    index('jobs_status_idx').on(table.status),
    index('jobs_batch_id_idx').on(table.batchId),
  ],
);

export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;

/** Completed/current transcript of an audio file. */
export const transcripts = sqliteTable(
  'transcripts',
  {
    id: integer('id').primaryKey(),
    audioId: integer('audio_id')
      .notNull()
      .references(() => audioFiles.id),
    fullText: text('full_text').notNull(),
    normalizedText: text('normalized_text').notNull(),
    normalizedHash: text('normalized_hash').notNull(),
    language: text('language'),
    modelId: text('model_id').notNull(),
    promptVersionId: integer('prompt_version_id')
      .notNull()
      .references(() => promptVersions.id),
    status: text('status').notNull().default('COMPLETED'),
    // No FK constraint — self-references create circular table definitions;
    // integrity is enforced by the service layer (same pattern as audio_files).
    duplicateOfTranscriptId: integer('duplicate_of_transcript_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    // One current COMPLETED transcript per audio; reprocessing adds rows later.
    uniqueIndex('transcripts_audio_completed_idx')
      .on(table.audioId)
      .where(sql`status = 'COMPLETED'`),
    index('transcripts_normalized_hash_idx').on(table.normalizedHash),
  ],
);

export type TranscriptRow = typeof transcripts.$inferSelect;
export type NewTranscriptRow = typeof transcripts.$inferInsert;

/** Time-ordered segments of a transcript (prepared for knowledge phases). */
export const transcriptSegments = sqliteTable(
  'transcript_segments',
  {
    id: integer('id').primaryKey(),
    transcriptId: integer('transcript_id')
      .notNull()
      .references(() => transcripts.id),
    sequence: integer('sequence').notNull(),
    speaker: text('speaker'),
    text: text('text').notNull(),
    normalizedText: text('normalized_text').notNull(),
    textHash: text('text_hash').notNull(),
    startTime: integer('start_time'),
    endTime: integer('end_time'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('transcript_segments_transcript_id_idx').on(table.transcriptId)],
);

export type TranscriptSegmentRow = typeof transcriptSegments.$inferSelect;
export type NewTranscriptSegmentRow = typeof transcriptSegments.$inferInsert;

/** Real Gemini API usage records (source of truth for future usage UI). */
export const apiUsage = sqliteTable('api_usage', {
  id: integer('id').primaryKey(),
  batchId: integer('batch_id'),
  jobId: integer('job_id'),
  audioId: integer('audio_id'),
  stage: text('stage').notNull(),
  modelId: text('model_id'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  cachedTokens: integer('cached_tokens'),
  totalTokens: integer('total_tokens'),
  durationMs: integer('duration_ms').notNull(),
  status: text('status').notNull().default('SUCCESS'),
  errorCode: text('error_code'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export type ApiUsageRow = typeof apiUsage.$inferSelect;
export type NewApiUsageRow = typeof apiUsage.$inferInsert;

/** A discovered destination (city, region, country, …). */
export const destinations = sqliteTable(
  'destinations',
  {
    id: integer('id').primaryKey(),
    canonicalName: text('canonical_name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    type: text('type').notNull().default('OTHER'),
    status: text('status').notNull().default('PROVISIONAL'),
    firstSeenBatchId: integer('first_seen_batch_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('destinations_normalized_name_idx').on(table.normalizedName)],
);

export type DestinationRow = typeof destinations.$inferSelect;
export type NewDestinationRow = typeof destinations.$inferInsert;

/** Aliases for a destination, matched before creating a new destination. */
export const destinationAliases = sqliteTable(
  'destination_aliases',
  {
    id: integer('id').primaryKey(),
    destinationId: integer('destination_id')
      .notNull()
      .references(() => destinations.id),
    alias: text('alias').notNull(),
    normalizedAlias: text('normalized_alias').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('destination_aliases_normalized_alias_idx').on(table.normalizedAlias)],
);

export type DestinationAliasRow = typeof destinationAliases.$inferSelect;
export type NewDestinationAliasRow = typeof destinationAliases.$inferInsert;

/** Many-to-many: a transcript may discuss several destinations. */
export const transcriptDestinations = sqliteTable(
  'transcript_destinations',
  {
    id: integer('id').primaryKey(),
    transcriptId: integer('transcript_id')
      .notNull()
      .references(() => transcripts.id),
    destinationId: integer('destination_id')
      .notNull()
      .references(() => destinations.id),
    confidence: integer('confidence').notNull().default(50),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('transcript_destinations_transcript_id_idx').on(table.transcriptId),
    index('transcript_destinations_destination_id_idx').on(table.destinationId),
  ],
);

export type TranscriptDestinationRow = typeof transcriptDestinations.$inferSelect;
export type NewTranscriptDestinationRow = typeof transcriptDestinations.$inferInsert;

/** One atomic, self-contained knowledge item extracted from a transcript. */
export const knowledgeItems = sqliteTable(
  'knowledge_items',
  {
    id: integer('id').primaryKey(),
    destinationId: integer('destination_id').references(() => destinations.id),
    knowledgeType: text('knowledge_type').notNull(),
    category: text('category'),
    entityType: text('entity_type'),
    entityName: text('entity_name'),
    attribute: text('attribute'),
    /** Stable backend-computed identity for future dedup — never from Gemini. */
    identityKey: text('identity_key').notNull(),
    canonicalText: text('canonical_text').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    firstSeenBatchId: integer('first_seen_batch_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('knowledge_items_identity_key_idx').on(table.identityKey)],
);

export type KnowledgeItemRow = typeof knowledgeItems.$inferSelect;
export type NewKnowledgeItemRow = typeof knowledgeItems.$inferInsert;

/** Versioned knowledge value — new items start at V1; updates come in Phase 9. */
export const knowledgeVersions = sqliteTable(
  'knowledge_versions',
  {
    id: integer('id').primaryKey(),
    knowledgeId: integer('knowledge_id')
      .notNull()
      .references(() => knowledgeItems.id),
    versionNumber: integer('version_number').notNull(),
    valueText: text('value_text'),
    valueJson: text('value_json'),
    unit: text('unit'),
    qualifiersJson: text('qualifiers_json'),
    canonicalText: text('canonical_text').notNull(),
    isCurrent: integer('is_current', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('knowledge_versions_knowledge_id_idx').on(table.knowledgeId),
    index('knowledge_versions_current_idx')
      .on(table.knowledgeId)
      .where(sql`is_current = 1`),
  ],
);

export type KnowledgeVersionRow = typeof knowledgeVersions.$inferSelect;
export type NewKnowledgeVersionRow = typeof knowledgeVersions.$inferInsert;

/** Evidence tying a knowledge item to the exact source transcript/segment. */
export const knowledgeEvidence = sqliteTable(
  'knowledge_evidence',
  {
    id: integer('id').primaryKey(),
    knowledgeId: integer('knowledge_id')
      .notNull()
      .references(() => knowledgeItems.id),
    knowledgeVersionId: integer('knowledge_version_id')
      .notNull()
      .references(() => knowledgeVersions.id),
    batchId: integer('batch_id'),
    audioId: integer('audio_id'),
    transcriptId: integer('transcript_id')
      .notNull()
      .references(() => transcripts.id),
    segmentId: integer('segment_id').references(() => transcriptSegments.id),
    sourceText: text('source_text').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('knowledge_evidence_knowledge_id_idx').on(table.knowledgeId)],
);

export type KnowledgeEvidenceRow = typeof knowledgeEvidence.$inferSelect;
export type NewKnowledgeEvidenceRow = typeof knowledgeEvidence.$inferInsert;

/** Traceability record of one knowledge-analysis Gemini run. */
export const knowledgeAnalysisRuns = sqliteTable('knowledge_analysis_runs', {
  id: integer('id').primaryKey(),
  transcriptId: integer('transcript_id')
    .notNull()
    .references(() => transcripts.id),
  modelId: text('model_id').notNull(),
  promptVersionId: integer('prompt_version_id').notNull(),
  inputSignature: text('input_signature').notNull(),
  status: text('status').notNull().default('COMPLETED'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
});

export type KnowledgeAnalysisRunRow = typeof knowledgeAnalysisRuns.$inferSelect;
export type NewKnowledgeAnalysisRunRow = typeof knowledgeAnalysisRuns.$inferInsert;

/**
 * One knowledge candidate extracted from a transcript. Candidates are the
 * unit of delta comparison (Phase 9): Gemini output never mutates master
 * knowledge directly — it always produces candidates first.
 */
export const knowledgeCandidates = sqliteTable(
  'knowledge_candidates',
  {
    id: integer('id').primaryKey(),
    analysisRunId: integer('analysis_run_id')
      .notNull()
      .references(() => knowledgeAnalysisRuns.id),
    batchId: integer('batch_id').notNull(),
    transcriptId: integer('transcript_id')
      .notNull()
      .references(() => transcripts.id),
    destinationId: integer('destination_id').references(() => destinations.id),
    knowledgeType: text('knowledge_type').notNull(),
    category: text('category'),
    entityType: text('entity_type'),
    entityName: text('entity_name'),
    attribute: text('attribute'),
    valueText: text('value_text'),
    valueJson: text('value_json'),
    unit: text('unit'),
    qualifiersJson: text('qualifiers_json'),
    canonicalText: text('canonical_text').notNull(),
    /** Stable backend-computed identity (same builder as knowledge_items). */
    identityKey: text('identity_key').notNull(),
    /** Hash of value parts — exact-gate comparisons use identity+value. */
    valueHash: text('value_hash').notNull(),
    confidence: integer('confidence').notNull().default(0.5),
    status: text('status').notNull().default('PENDING'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('knowledge_candidates_destination_identity_idx').on(table.destinationId, table.identityKey),
    index('knowledge_candidates_status_idx').on(table.status),
    index('knowledge_candidates_transcript_idx').on(table.transcriptId),
    index('knowledge_candidates_batch_idx').on(table.batchId),
  ],
);

export type KnowledgeCandidateRow = typeof knowledgeCandidates.$inferSelect;
export type NewKnowledgeCandidateRow = typeof knowledgeCandidates.$inferInsert;

/**
 * Cached embedding vectors (JSON array in `embedding`). One row per
 * (model_id, source_hash) — re-embedding identical text is forbidden.
 */
export const knowledgeEmbeddings = sqliteTable(
  'knowledge_embeddings',
  {
    id: integer('id').primaryKey(),
    knowledgeId: integer('knowledge_id'),
    knowledgeVersionId: integer('knowledge_version_id'),
    candidateId: integer('candidate_id'),
    modelId: text('model_id').notNull(),
    sourceHash: text('source_hash').notNull(),
    dimensions: integer('dimensions').notNull(),
    embedding: text('embedding').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('knowledge_embeddings_model_source_unique_idx').on(table.modelId, table.sourceHash),
    index('knowledge_embeddings_knowledge_id_idx').on(table.knowledgeId),
  ],
);

export type KnowledgeEmbeddingRow = typeof knowledgeEmbeddings.$inferSelect;
export type NewKnowledgeEmbeddingRow = typeof knowledgeEmbeddings.$inferInsert;

/** One persisted delta decision for a knowledge candidate. */
export const knowledgeDeltaDecisions = sqliteTable(
  'knowledge_delta_decisions',
  {
    id: integer('id').primaryKey(),
    candidateId: integer('candidate_id')
      .notNull()
      .references(() => knowledgeCandidates.id),
    destinationId: integer('destination_id'),
    decision: text('decision').notNull(),
    matchedKnowledgeId: integer('matched_knowledge_id'),
    matchedVersionId: integer('matched_version_id'),
    /** Candidate in the same batch that this decision aligns with. */
    matchedCandidateId: integer('matched_candidate_id'),
    reasonCode: text('reason_code'),
    confidence: integer('confidence').notNull().default(0.5),
    /** Short, safe summary — never chain-of-thought. */
    reasoningSummary: text('reasoning_summary'),
    inputSignature: text('input_signature').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('knowledge_delta_decisions_candidate_unique_idx').on(table.candidateId),
    index('knowledge_delta_decisions_destination_idx').on(table.destinationId),
  ],
);

export type KnowledgeDeltaDecisionRow = typeof knowledgeDeltaDecisions.$inferSelect;
export type NewKnowledgeDeltaDecisionRow = typeof knowledgeDeltaDecisions.$inferInsert;

/**
 * Lightweight per-batch counters for token/API savings (exact confirmations,
 * embedding cache hits, skipped AI calls). Foundation for the Phase 11 UI.
 */
export const deltaMetrics = sqliteTable(
  'delta_metrics',
  {
    id: integer('id').primaryKey(),
    batchId: integer('batch_id'),
    metricKey: text('metric_key').notNull(),
    value: integer('value').notNull().default(0),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [uniqueIndex('delta_metrics_batch_key_unique_idx').on(table.batchId, table.metricKey)],
);

export type DeltaMetricRow = typeof deltaMetrics.$inferSelect;
export type NewDeltaMetricRow = typeof deltaMetrics.$inferInsert;
