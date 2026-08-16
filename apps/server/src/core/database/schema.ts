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
  /** User-facing stage of the simplified product flow (UPLOAD → … → COMMITTED). */
  sessionStage: text('session_stage').notNull().default('UPLOAD'),
  /** Soft-delete marker: committed sessions are soft-deleted so committed
   * source transcripts keep a valid batch/audio FK chain. */
  deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
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
    /** Soft-delete marker: set when a voice is deleted so transcripts that
     * reference it (committed-note audit trail) keep a valid FK target. */
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
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
export const apiUsage = sqliteTable(
  'api_usage',
  {
    id: integer('id').primaryKey(),
    batchId: integer('batch_id'),
    jobId: integer('job_id'),
    audioId: integer('audio_id'),
    /** Destination-scoped stage (e.g. CONTENT generations). Null when N/A. */
    destinationId: integer('destination_id'),
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
  },
  (table) => [
    // Phase 12: usage is queried per batch (and per stage) from the UI.
    index('api_usage_batch_stage_idx').on(table.batchId, table.stage),
    index('api_usage_destination_idx').on(table.destinationId),
  ],
);

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
    /** Stable backend-computed identity for dedup — never from Gemini. */
    identityKey: text('identity_key').notNull(),
    canonicalText: text('canonical_text').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    firstSeenBatchId: integer('first_seen_batch_id'),
    firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }),
    lastSeenBatchId: integer('last_seen_batch_id'),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('knowledge_items_identity_key_idx').on(table.identityKey),
    index('knowledge_items_destination_idx').on(table.destinationId),
    // One canonical master identity per destination scope (Phase 10).
    uniqueIndex('knowledge_items_canonical_unique_idx')
      .on(table.destinationId, table.identityKey)
      .where(sql`status IN ('ACTIVE', 'PROVISIONAL')`),
  ],
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
    // Exactly one current version per knowledge item (Phase 10).
    uniqueIndex('knowledge_versions_one_current_idx')
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
  (table) => [
    index('knowledge_evidence_knowledge_id_idx').on(table.knowledgeId),
    index('knowledge_evidence_transcript_idx').on(table.transcriptId),
    // One source may evidence a knowledge version only once (Phase 10 replay safety).
    uniqueIndex('knowledge_evidence_source_unique_idx').on(
      table.knowledgeId,
      table.knowledgeVersionId,
      table.transcriptId,
      table.segmentId,
    ),
  ],
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
    /** Source segment for reconciliation evidence (Phase 10). */
    sourceSegmentId: integer('source_segment_id'),
    sourceText: text('source_text'),
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
    /** Optional link to a destination note (simplified product model). */
    noteId: integer('note_id'),
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
    /** Set when Phase 10 reconciliation applied this decision. */
    reconciledAt: integer('reconciled_at', { mode: 'timestamp_ms' }),
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

/**
 * Master knowledge change — the publishable Batch Delta (NEW/UPDATE only).
 * CONFIRMATION/CONFLICT/IGNORE never appear here.
 */
export const knowledgeChanges = sqliteTable(
  'knowledge_changes',
  {
    id: integer('id').primaryKey(),
    batchId: integer('batch_id').notNull(),
    destinationId: integer('destination_id'),
    knowledgeId: integer('knowledge_id')
      .notNull()
      .references(() => knowledgeItems.id),
    changeType: text('change_type').notNull(), // NEW | UPDATE
    oldVersionId: integer('old_version_id').references(() => knowledgeVersions.id),
    newVersionId: integer('new_version_id')
      .notNull()
      .references(() => knowledgeVersions.id),
    sourceDecisionId: integer('source_decision_id')
      .notNull()
      .references(() => knowledgeDeltaDecisions.id),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    // Replay safety: one change record per decision.
    uniqueIndex('knowledge_changes_decision_unique_idx').on(table.sourceDecisionId),
    index('knowledge_changes_batch_destination_idx').on(table.batchId, table.destinationId),
    index('knowledge_changes_knowledge_idx').on(table.knowledgeId),
  ],
);

export type KnowledgeChangeRow = typeof knowledgeChanges.$inferSelect;
export type NewKnowledgeChangeRow = typeof knowledgeChanges.$inferInsert;

/** Open conflict registry — CONFLICT decisions never silently overwrite truth. */
export const knowledgeConflicts = sqliteTable(
  'knowledge_conflicts',
  {
    id: integer('id').primaryKey(),
    destinationId: integer('destination_id'),
    knowledgeId: integer('knowledge_id').references(() => knowledgeItems.id),
    candidateId: integer('candidate_id')
      .notNull()
      .references(() => knowledgeCandidates.id),
    existingVersionId: integer('existing_version_id').references(() => knowledgeVersions.id),
    status: text('status').notNull().default('OPEN'), // OPEN | RESOLVED | DISMISSED
    conflictType: text('conflict_type'),
    /** Groups same-identity conflicts (same destination + identity key). */
    conflictGroupKey: text('conflict_group_key').notNull(),
    resolutionNote: text('resolution_note'),
    resolvedVersionId: integer('resolved_version_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    uniqueIndex('knowledge_conflicts_candidate_unique_idx').on(table.candidateId),
    index('knowledge_conflicts_destination_status_idx').on(table.destinationId, table.status),
    index('knowledge_conflicts_group_idx').on(table.conflictGroupKey),
  ],
);

export type KnowledgeConflictRow = typeof knowledgeConflicts.$inferSelect;
export type NewKnowledgeConflictRow = typeof knowledgeConflicts.$inferInsert;

/**
 * Per-batch, per-destination summary of reconciliation results. Derived from
 * canonical data (recomputed), so retries can never double-count.
 */
export const batchDestinationSummaries = sqliteTable(
  'batch_destination_summaries',
  {
    id: integer('id').primaryKey(),
    batchId: integer('batch_id').notNull(),
    destinationId: integer('destination_id')
      .notNull()
      .references(() => destinations.id),
    newCount: integer('new_count').notNull().default(0),
    updatedCount: integer('updated_count').notNull().default(0),
    confirmationCount: integer('confirmation_count').notNull().default(0),
    conflictCount: integer('conflict_count').notNull().default(0),
    ignoredCount: integer('ignored_count').notNull().default(0),
    publishableDeltaCount: integer('publishable_delta_count').notNull().default(0),
    status: text('status').notNull().default('FINALIZED'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('batch_destination_summaries_unique_idx').on(table.batchId, table.destinationId),
    index('batch_destination_summaries_batch_idx').on(table.batchId),
  ],
);

export type BatchDestinationSummaryRow = typeof batchDestinationSummaries.$inferSelect;
export type NewBatchDestinationSummaryRow = typeof batchDestinationSummaries.$inferInsert;

/**
 * One generated content (Phase 11). A row per (batch, destination,
 * generation) — regenerate keeps history, never overwrites. SUPERSEDED marks
 * older generations once a newer one exists.
 */
export const generatedContents = sqliteTable(
  'generated_contents',
  {
    id: integer('id').primaryKey(),
    batchId: integer('batch_id').notNull(),
    destinationId: integer('destination_id').references(() => destinations.id),
    content: text('content').notNull(),
    modelId: text('model_id').notNull(),
    promptVersionId: integer('prompt_version_id').notNull(),
    /** Stable backend-computed hash of the publishable delta + config. */
    deltaSignature: text('delta_signature').notNull(),
    generationNumber: integer('generation_number').notNull().default(1),
    status: text('status').notNull().default('GENERATED'), // GENERATED | FAILED | SUPERSEDED
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    // One generation per (batch, destination, generation number) — retry/replay safe.
    uniqueIndex('generated_contents_batch_dest_gen_unique_idx').on(
      table.batchId,
      table.destinationId,
      table.generationNumber,
    ),
    index('generated_contents_batch_idx').on(table.batchId),
    index('generated_contents_destination_idx').on(table.destinationId),
  ],
);

export type GeneratedContentRow = typeof generatedContents.$inferSelect;
export type NewGeneratedContentRow = typeof generatedContents.$inferInsert;

/** Traceability: exactly which knowledge versions a content was built from. */
export const generatedContentKnowledge = sqliteTable(
  'generated_content_knowledge',
  {
    id: integer('id').primaryKey(),
    generatedContentId: integer('generated_content_id')
      .notNull()
      .references(() => generatedContents.id),
    knowledgeId: integer('knowledge_id')
      .notNull()
      .references(() => knowledgeItems.id),
    knowledgeVersionId: integer('knowledge_version_id')
      .notNull()
      .references(() => knowledgeVersions.id),
    changeId: integer('change_id')
      .notNull()
      .references(() => knowledgeChanges.id),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('generated_content_knowledge_unique_idx').on(table.generatedContentId, table.changeId),
    index('generated_content_knowledge_knowledge_idx').on(table.knowledgeId),
  ],
);

export type GeneratedContentKnowledgeRow = typeof generatedContentKnowledge.$inferSelect;
export type NewGeneratedContentKnowledgeRow = typeof generatedContentKnowledge.$inferInsert;

// ---------------------------------------------------------------------------
// Simplified product model: Destination Notes, Voice Reports, proposals & logs
// ---------------------------------------------------------------------------

/** A short, descriptive report of a whole audio conversation (not knowledge). */
export const voiceReports = sqliteTable(
  'voice_reports',
  {
    id: integer('id').primaryKey(),
    audioId: integer('audio_id')
      .notNull()
      .references(() => audioFiles.id),
    transcriptId: integer('transcript_id')
      .notNull()
      .references(() => transcripts.id),
    report: text('report').notNull(),
    /** Short topic phrase of the whole conversation (e.g. «بررسی هتل‌های مشهد»). */
    conversationTopic: text('conversation_topic'),
    /** ACTIONABLE | NO_USEFUL_KNOWLEDGE | NO_NEW_KNOWLEDGE */
    resultStatus: text('result_status').notNull().default('ACTIONABLE'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [uniqueIndex('voice_reports_audio_unique_idx').on(table.audioId)],
);

export type VoiceReportRow = typeof voiceReports.$inferSelect;
export type NewVoiceReportRow = typeof voiceReports.$inferInsert;

/**
 * A proposed note change, pending user review. Extraction never mutates the
 * destination database — proposals are committed only via the Apply action.
 */
export const noteProposals = sqliteTable(
  'note_proposals',
  {
    id: integer('id').primaryKey(),
    batchId: integer('batch_id')
      .notNull()
      .references(() => batches.id),
    transcriptId: integer('transcript_id')
      .notNull()
      .references(() => transcripts.id),
    audioId: integer('audio_id')
      .notNull()
      .references(() => audioFiles.id),
    destinationId: integer('destination_id').references(() => destinations.id),
    title: text('title').notNull(),
    description: text('description').notNull(),
    relevantDate: text('relevant_date'),
    /** TOUR_INFO | DESTINATION_INFO | TRAVELER_GUIDANCE */
    noteKind: text('note_kind').notNull().default('DESTINATION_INFO'),
    /** DESTINATION | TOUR */
    scopeType: text('scope_type').notNull().default('DESTINATION'),
    /** Optional free-text tour subject when scopeType = TOUR. */
    tourSubject: text('tour_subject'),
    /** ADD | UPDATE | MARK_OUTDATED | NO_CHANGE */
    proposedAction: text('proposed_action').notNull(),
    /** Target existing note for UPDATE / MARK_OUTDATED / NO_CHANGE. */
    matchedNoteId: integer('matched_note_id'),
    /** Short, safe Persian summary of why this action was proposed. */
    reasonSummary: text('reason_summary'),
    /** Human, grounded reason written to the destination change log on commit. */
    logReason: text('log_reason'),
    /** PENDING | COMMITTED | FAILED */
    status: text('status').notNull().default('PENDING'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('note_proposals_batch_idx').on(table.batchId),
    index('note_proposals_destination_idx').on(table.destinationId),
  ],
);

export type NoteProposalRow = typeof noteProposals.$inferSelect;
export type NewNoteProposalRow = typeof noteProposals.$inferInsert;

/** Master destination notes — the user-facing knowledge database. */
export const destinationNotes = sqliteTable(
  'destination_notes',
  {
    id: integer('id').primaryKey(),
    destinationId: integer('destination_id')
      .notNull()
      .references(() => destinations.id),
    currentTitle: text('current_title').notNull(),
    currentDescription: text('current_description').notNull(),
    /** TOUR_INFO | DESTINATION_INFO | TRAVELER_GUIDANCE */
    noteKind: text('note_kind').notNull().default('DESTINATION_INFO'),
    /** DESTINATION | TOUR */
    scopeType: text('scope_type').notNull().default('DESTINATION'),
    /** Optional free-text tour subject when scopeType = TOUR. */
    tourSubject: text('tour_subject'),
    /** CURRENT | OUTDATED */
    status: text('status').notNull().default('CURRENT'),
    relevantDate: text('relevant_date'),
    firstObservedAt: integer('first_observed_at', { mode: 'timestamp_ms' }).notNull(),
    lastUpdatedAt: integer('last_updated_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('destination_notes_destination_idx').on(table.destinationId),
    index('destination_notes_status_idx').on(table.status),
  ],
);

export type DestinationNoteRow = typeof destinationNotes.$inferSelect;
export type NewDestinationNoteRow = typeof destinationNotes.$inferInsert;

/** Version history of a destination note (append-only). */
export const destinationNoteVersions = sqliteTable(
  'destination_note_versions',
  {
    id: integer('id').primaryKey(),
    noteId: integer('note_id')
      .notNull()
      .references(() => destinationNotes.id),
    versionNumber: integer('version_number').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    relevantDate: text('relevant_date'),
    sourceProcessingId: integer('source_processing_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('destination_note_versions_note_idx').on(table.noteId)],
);

export type DestinationNoteVersionRow = typeof destinationNoteVersions.$inferSelect;
export type NewDestinationNoteVersionRow = typeof destinationNoteVersions.$inferInsert;

/** Which voices/transcripts a destination note came from. */
export const destinationNoteSources = sqliteTable(
  'destination_note_sources',
  {
    id: integer('id').primaryKey(),
    noteId: integer('note_id')
      .notNull()
      .references(() => destinationNotes.id),
    audioId: integer('audio_id').references(() => audioFiles.id),
    transcriptId: integer('transcript_id')
      .notNull()
      .references(() => transcripts.id),
    processingSessionId: integer('processing_session_id'),
    /** Filename snapshot so audit history survives voice deletion. */
    audioNameSnapshot: text('audio_name_snapshot'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    // A transcript evidences a note version only once (replay safety).
    uniqueIndex('destination_note_sources_unique_idx').on(table.noteId, table.transcriptId),
    index('destination_note_sources_note_idx').on(table.noteId),
  ],
);

export type DestinationNoteSourceRow = typeof destinationNoteSources.$inferSelect;
export type NewDestinationNoteSourceRow = typeof destinationNoteSources.$inferInsert;

/** Source of truth for the destination change-log timeline. */
export const destinationNoteLogs = sqliteTable(
  'destination_note_logs',
  {
    id: integer('id').primaryKey(),
    destinationId: integer('destination_id')
      .notNull()
      .references(() => destinations.id),
    noteId: integer('note_id').references(() => destinationNotes.id),
    /** NOTE_ADDED | NOTE_UPDATED | NOTE_MARKED_OUTDATED */
    eventType: text('event_type').notNull(),
    sourceAudioIds: text('source_audio_ids'),
    sourceProcessingSession: integer('source_processing_session'),
    reason: text('reason'),
    oldVersionId: integer('old_version_id'),
    newVersionId: integer('new_version_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('destination_note_logs_destination_idx').on(table.destinationId),
    index('destination_note_logs_note_idx').on(table.noteId),
  ],
);

export type DestinationNoteLogRow = typeof destinationNoteLogs.$inferSelect;
export type NewDestinationNoteLogRow = typeof destinationNoteLogs.$inferInsert;

/**
 * Master inferred audience insights — a knowledge type separate from factual
 * destination notes. Insights are grounded inferences about the traveler
 * (concerns, behaviors, decision factors), never facts about the destination.
 */
export const destinationAudienceInsights = sqliteTable(
  'destination_audience_insights',
  {
    id: integer('id').primaryKey(),
    destinationId: integer('destination_id')
      .notNull()
      .references(() => destinations.id),
    title: text('title').notNull(),
    description: text('description').notNull(),
    /** Short explanation of why this inference was made (traceable to voice). */
    inferenceBasis: text('inference_basis').notNull(),
    /** 0–100 confidence. */
    confidence: integer('confidence').notNull().default(50),
    contentOpportunityTitle: text('content_opportunity_title'),
    contentOpportunityReason: text('content_opportunity_reason'),
    /** CURRENT | OUTDATED */
    status: text('status').notNull().default('CURRENT'),
    firstObservedAt: integer('first_observed_at', { mode: 'timestamp_ms' }).notNull(),
    lastUpdatedAt: integer('last_updated_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('destination_audience_insights_destination_idx').on(table.destinationId),
    index('destination_audience_insights_status_idx').on(table.status),
  ],
);

export type DestinationAudienceInsightRow = typeof destinationAudienceInsights.$inferSelect;
export type NewDestinationAudienceInsightRow = typeof destinationAudienceInsights.$inferInsert;

/** Pending audience insight proposals — committed only via the Apply action. */
export const insightProposals = sqliteTable(
  'insight_proposals',
  {
    id: integer('id').primaryKey(),
    batchId: integer('batch_id')
      .notNull()
      .references(() => batches.id),
    transcriptId: integer('transcript_id')
      .notNull()
      .references(() => transcripts.id),
    audioId: integer('audio_id')
      .notNull()
      .references(() => audioFiles.id),
    destinationId: integer('destination_id').references(() => destinations.id),
    title: text('title').notNull(),
    description: text('description').notNull(),
    inferenceBasis: text('inference_basis').notNull(),
    confidence: integer('confidence').notNull().default(50),
    contentOpportunityTitle: text('content_opportunity_title'),
    contentOpportunityReason: text('content_opportunity_reason'),
    /** ADD | MERGE | NO_CHANGE */
    proposedAction: text('proposed_action').notNull(),
    matchedInsightId: integer('matched_insight_id'),
    /** PENDING | COMMITTED | FAILED */
    status: text('status').notNull().default('PENDING'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('insight_proposals_batch_idx').on(table.batchId),
    index('insight_proposals_destination_idx').on(table.destinationId),
  ],
);

export type InsightProposalRow = typeof insightProposals.$inferSelect;
export type NewInsightProposalRow = typeof insightProposals.$inferInsert;

/** Which voices/transcripts an audience insight came from (deduplicated). */
export const destinationInsightSources = sqliteTable(
  'destination_insight_sources',
  {
    id: integer('id').primaryKey(),
    insightId: integer('insight_id')
      .notNull()
      .references(() => destinationAudienceInsights.id),
    audioId: integer('audio_id').references(() => audioFiles.id),
    transcriptId: integer('transcript_id')
      .notNull()
      .references(() => transcripts.id),
    processingSessionId: integer('processing_session_id'),
    /** Short evidence summary traceable to the transcript (not shown raw). */
    evidenceSummary: text('evidence_summary'),
    /** Filename snapshot so audit history survives voice deletion. */
    audioNameSnapshot: text('audio_name_snapshot'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('destination_insight_sources_unique_idx').on(table.insightId, table.transcriptId),
    index('destination_insight_sources_insight_idx').on(table.insightId),
  ],
);

export type DestinationInsightSourceRow = typeof destinationInsightSources.$inferSelect;
export type NewDestinationInsightSourceRow = typeof destinationInsightSources.$inferInsert;

/**
 * Per-destination processing newsroom — the narrative of what this processing
 * session actually changed/adds, built from the backend's reconciliation diffs
 * (never re-derived by the reporter). Survives restart, kept after commit.
 */
export const processingDestinationNews = sqliteTable(
  'processing_destination_news',
  {
    id: integer('id').primaryKey(),
    processingSessionId: integer('processing_session_id')
      .notNull()
      .references(() => batches.id),
    destinationId: integer('destination_id')
      .notNull()
      .references(() => destinations.id),
    content: text('content').notNull(),
    /** Structured editorial stories (JSON: {stories:[{headline,paragraphs[]}]}).
     * Null for the deterministic "no news" narrative (plain `content` only). */
    storiesJson: text('stories_json'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('processing_destination_news_unique_idx').on(
      table.processingSessionId,
      table.destinationId,
    ),
    index('processing_destination_news_session_idx').on(table.processingSessionId),
  ],
);

export type ProcessingDestinationNewsRow = typeof processingDestinationNews.$inferSelect;
export type NewProcessingDestinationNewsRow = typeof processingDestinationNews.$inferInsert;
