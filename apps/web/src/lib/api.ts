import type {
  AiReadinessResponse,
  AllTimeUsageResponse,
  ApiErrorCode,
  ApiErrorResponse,
  AppSettings,
  AudioRetryResponse,
  BatchDeltaResponse,
  BatchDetailResponse,
  BatchDestinationSummaryInfo,
  BatchGeneratedContentsResponse,
  BatchJobsResponse,
  BatchListResponse,
  BatchRetryResponse,
  BatchSummary,
  BatchUsageResponse,
  CancelBatchResponse,
  CandidateRetrievalDebugResponse,
  ConflictResolveResponse,
  ContentRegenerateResponse,
  DestinationConflictsResponse,
  DestinationContentHistoryResponse,
  DestinationDetailResponse,
  DestinationListResponse,
  DestinationMasterKnowledgeResponse,
  GeminiCredentialStatusResponse,
  GeminiModelsResponse,
  GeminiTestConnectionResponse,
  HealthResponse,
  KnowledgeDecisionsResponse,
  KnowledgeDetailResponse,
  KnowledgeChangeInfo,
  ModelConfigResponse,
  ModelConfigsResponse,
  OverviewResponse,
  PipelinePreflightResponse,
  PromptTemplatesResponse,
  PromptVersionsResponse,
  TranscriptKnowledgeInfo,
  TranscriptResponse,
} from '@freebuff/contracts';
import { API_BASE_URL } from './env';

const GENERIC_ERROR = 'خطای غیرمنتظره رخ داد. دوباره تلاش کنید.';

/** Error carrying the API error code and a user-facing message. */
export class ApiError extends Error {
  readonly code: ApiErrorCode | null;

  constructor(message: string, code: ApiErrorCode | null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

async function parseError(response: Response): Promise<ApiError> {
  let message = GENERIC_ERROR;
  let code: ApiErrorCode | null = null;
  try {
    const body = (await response.json()) as ApiErrorResponse;
    if (body.error?.message) {
      message = body.error.message;
    }
    if (body.error?.code) {
      code = body.error.code;
    }
  } catch {
    // Non-JSON error body — keep the generic message.
  }
  return new ApiError(message, code);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw await parseError(response);
  }
  return (await response.json()) as T;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>(`${API_BASE_URL}/api/health`);
}

export function fetchSettings(): Promise<AppSettings> {
  return request<AppSettings>(`${API_BASE_URL}/api/settings`);
}

export function updateSettings(settings: AppSettings): Promise<AppSettings> {
  return request<AppSettings>(`${API_BASE_URL}/api/settings`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(settings),
  });
}

// ---------------------------------------------------------------------------
// Gemini credentials
// ---------------------------------------------------------------------------

export function fetchCredentialStatus(): Promise<GeminiCredentialStatusResponse> {
  return request<GeminiCredentialStatusResponse>(`${API_BASE_URL}/api/gemini/credential`);
}

export function saveApiKey(apiKey: string): Promise<GeminiCredentialStatusResponse> {
  return request<GeminiCredentialStatusResponse>(`${API_BASE_URL}/api/gemini/credential`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ apiKey }),
  });
}

export function deleteApiKey(): Promise<GeminiCredentialStatusResponse> {
  return request<GeminiCredentialStatusResponse>(`${API_BASE_URL}/api/gemini/credential`, {
    method: 'DELETE',
  });
}

export function testGeminiConnection(): Promise<GeminiTestConnectionResponse> {
  return request<GeminiTestConnectionResponse>(`${API_BASE_URL}/api/gemini/test`, {
    method: 'POST',
  });
}

// ---------------------------------------------------------------------------
// Gemini models
// ---------------------------------------------------------------------------

export function fetchModels(): Promise<GeminiModelsResponse> {
  return request<GeminiModelsResponse>(`${API_BASE_URL}/api/gemini/models`);
}

export function refreshModels(): Promise<GeminiModelsResponse> {
  return request<GeminiModelsResponse>(`${API_BASE_URL}/api/gemini/models/refresh`, {
    method: 'POST',
  });
}

// ---------------------------------------------------------------------------
// Model configuration
// ---------------------------------------------------------------------------

export function fetchModelConfigs(): Promise<ModelConfigsResponse> {
  return request<ModelConfigsResponse>(`${API_BASE_URL}/api/model-configs`);
}

export function updateModelConfig(input: {
  stage: string;
  modelId: string;
}): Promise<ModelConfigResponse> {
  return request<ModelConfigResponse>(`${API_BASE_URL}/api/model-configs`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export function fetchPromptTemplates(): Promise<PromptTemplatesResponse> {
  return request<PromptTemplatesResponse>(`${API_BASE_URL}/api/prompts/templates`);
}

export function fetchPromptVersions(promptType: string): Promise<PromptVersionsResponse> {
  return request<PromptVersionsResponse>(`${API_BASE_URL}/api/prompts/${promptType}/versions`);
}

export function savePromptVersion(promptType: string, content: string): Promise<PromptVersionsResponse> {
  return request<PromptVersionsResponse>(`${API_BASE_URL}/api/prompts/${promptType}/versions`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ content }),
  });
}

export function activatePromptVersion(promptType: string, versionId: number): Promise<PromptVersionsResponse> {
  return request<PromptVersionsResponse>(`${API_BASE_URL}/api/prompts/${promptType}/activate`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ versionId }),
  });
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export function fetchReadiness(): Promise<AiReadinessResponse> {
  return request<AiReadinessResponse>(`${API_BASE_URL}/api/readiness`);
}

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

export function fetchBatches(): Promise<BatchListResponse> {
  return request<BatchListResponse>(`${API_BASE_URL}/api/batches`);
}

export function createBatch(): Promise<BatchSummary> {
  return request<BatchSummary>(`${API_BASE_URL}/api/batches`, { method: 'POST' });
}

export function fetchBatch(id: number): Promise<BatchDetailResponse> {
  return request<BatchDetailResponse>(`${API_BASE_URL}/api/batches/${id}`);
}

/** Trigger an (idempotent) folder scan for the batch. */
export function scanBatch(id: number): Promise<BatchSummary> {
  return request<BatchSummary>(`${API_BASE_URL}/api/batches/${id}/scan`, { method: 'POST' });
}

/** Mark a READY batch PROCESSING and wake the worker. */
export function startBatch(id: number): Promise<BatchDetailResponse> {
  return request<BatchDetailResponse>(`${API_BASE_URL}/api/batches/${id}/start`, { method: 'POST' });
}

export function fetchTranscript(batchId: number, audioId: number): Promise<TranscriptResponse> {
  return request<TranscriptResponse>(
    `${API_BASE_URL}/api/batches/${batchId}/audio/${audioId}/transcript`,
  );
}

// ---------------------------------------------------------------------------
// Destinations & knowledge
// ---------------------------------------------------------------------------

export function fetchDestinations(): Promise<DestinationListResponse> {
  return request<DestinationListResponse>(`${API_BASE_URL}/api/destinations`);
}

export function fetchDestination(id: number): Promise<DestinationDetailResponse> {
  return request<DestinationDetailResponse>(`${API_BASE_URL}/api/destinations/${id}`);
}

/** Destinations and knowledge extracted from a transcript (traceability). */
export function fetchTranscriptKnowledge(
  batchId: number,
  audioId: number,
): Promise<TranscriptKnowledgeInfo> {
  return request<TranscriptKnowledgeInfo>(
    `${API_BASE_URL}/api/batches/${batchId}/audio/${audioId}/knowledge`,
  );
}

// ---------------------------------------------------------------------------
// Knowledge delta (Phase 9)
// ---------------------------------------------------------------------------

/** Candidates + delta decisions of a batch. */
export function fetchKnowledgeDecisions(batchId: number): Promise<KnowledgeDecisionsResponse> {
  return request<KnowledgeDecisionsResponse>(
    `${API_BASE_URL}/api/batches/${batchId}/knowledge-decisions`,
  );
}

/** Debuggable retrieval hits for one candidate (expandable in the UI). */
export function fetchCandidateRetrievalDebug(
  candidateId: number,
): Promise<CandidateRetrievalDebugResponse> {
  return request<CandidateRetrievalDebugResponse>(
    `${API_BASE_URL}/api/knowledge-candidates/${candidateId}/retrieval`,
  );
}

/** Token/API savings metrics for a batch. */
export function fetchDeltaMetrics(batchId: number): Promise<Record<string, number>> {
  return request<Record<string, number>>(`${API_BASE_URL}/api/batches/${batchId}/delta-metrics`);
}

// ---------------------------------------------------------------------------
// Master knowledge, conflicts, changes & batch delta (Phase 10)
// ---------------------------------------------------------------------------

/** Bounded master knowledge list of a destination (search + filters). */
export function fetchMasterKnowledge(
  destinationId: number,
  limit = 50,
  offset = 0,
  options: { q?: string; knowledgeType?: string; status?: string } = {},
): Promise<DestinationMasterKnowledgeResponse> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (options.q) params.set('q', options.q);
  if (options.knowledgeType) params.set('knowledgeType', options.knowledgeType);
  if (options.status) params.set('status', options.status);
  return request<DestinationMasterKnowledgeResponse>(
    `${API_BASE_URL}/api/destinations/${destinationId}/master-knowledge?${params.toString()}`,
  );
}

/** Full knowledge detail: current + versions + evidence + changes. */
export function fetchKnowledgeDetail(knowledgeId: number): Promise<KnowledgeDetailResponse> {
  return request<KnowledgeDetailResponse>(`${API_BASE_URL}/api/knowledge/${knowledgeId}`);
}

/** Open + resolved conflicts of a destination. */
export function fetchDestinationConflicts(
  destinationId: number,
): Promise<DestinationConflictsResponse> {
  return request<DestinationConflictsResponse>(
    `${API_BASE_URL}/api/destinations/${destinationId}/conflicts`,
  );
}

/** Publishable change records (NEW/UPDATE) of a destination. */
export function fetchDestinationChanges(destinationId: number): Promise<{
  destinationId: number;
  changes: KnowledgeChangeInfo[];
}> {
  return request<{ destinationId: number; changes: KnowledgeChangeInfo[] }>(
    `${API_BASE_URL}/api/destinations/${destinationId}/changes`,
  );
}

/** Publishable batch delta (NEW/UPDATE per destination — Phase 11 input). */
export function fetchBatchDelta(batchId: number): Promise<BatchDeltaResponse> {
  return request<BatchDeltaResponse>(`${API_BASE_URL}/api/batches/${batchId}/delta`);
}

/** Per-destination summaries of a batch. */
export function fetchBatchDestinationSummaries(
  batchId: number,
): Promise<{ batchId: number; summaries: BatchDestinationSummaryInfo[] }> {
  return request<{ batchId: number; summaries: BatchDestinationSummaryInfo[] }>(
    `${API_BASE_URL}/api/batches/${batchId}/destination-summaries`,
  );
}

/** Rebuild summaries + advance batch state (idempotent, no Gemini). */
export function finalizeBatch(batchId: number): Promise<{ batchId: number; finalized: boolean }> {
  return request<{ batchId: number; finalized: boolean }>(
    `${API_BASE_URL}/api/batches/${batchId}/finalize`,
    { method: 'POST' },
  );
}

// ---------------------------------------------------------------------------
// Generated content, usage & optimization (Phase 11)
// ---------------------------------------------------------------------------

/** Generated contents of a batch, grouped per destination. */
export function fetchBatchGeneratedContents(batchId: number): Promise<BatchGeneratedContentsResponse> {
  return request<BatchGeneratedContentsResponse>(
    `${API_BASE_URL}/api/batches/${batchId}/generated-contents`,
  );
}

/** Generated content history of a destination, grouped per batch. */
export function fetchDestinationContentHistory(
  destinationId: number,
): Promise<DestinationContentHistoryResponse> {
  return request<DestinationContentHistoryResponse>(
    `${API_BASE_URL}/api/destinations/${destinationId}/generated-contents`,
  );
}

/** Full generated content detail with source knowledge links. */
export function fetchGeneratedContentDetail(contentId: number): Promise<{
  id: number;
  batchId: number;
  destinationId: number | null;
  destinationName: string | null;
  content: string;
  modelId: string;
  promptVersionId: number;
  generationNumber: number;
  status: string;
  deltaSignature: string;
  knowledgeCount: number;
  createdAt: string;
  knowledge: {
    generatedContentId: number;
    knowledgeId: number;
    knowledgeVersionId: number;
    changeId: number;
    changeType: string;
    canonicalText: string;
    currentValue: string | null;
    oldValue: string | null;
  }[];
}> {
  return request(`${API_BASE_URL}/api/generated-contents/${contentId}`);
}

/** Queue an explicit regeneration (history preserved). */
export function regenerateContent(contentId: number): Promise<ContentRegenerateResponse> {
  return request<ContentRegenerateResponse>(
    `${API_BASE_URL}/api/generated-contents/${contentId}/regenerate`,
    { method: 'POST' },
  );
}

/** Per-stage token/usage aggregate of a batch (real api_usage data). */
export function fetchBatchUsage(batchId: number): Promise<BatchUsageResponse> {
  return request<BatchUsageResponse>(`${API_BASE_URL}/api/batches/${batchId}/usage`);
}

// ---------------------------------------------------------------------------
// Pipeline preflight, overview, usage & batch operations (Phase 12)
// ---------------------------------------------------------------------------

/** Configuration readiness for starting batch processing. */
export function fetchPreflight(): Promise<PipelinePreflightResponse> {
  return request<PipelinePreflightResponse>(`${API_BASE_URL}/api/pipeline/preflight`);
}

/** Concise system overview (real statistics only). */
export function fetchOverview(): Promise<OverviewResponse> {
  return request<OverviewResponse>(`${API_BASE_URL}/api/overview`);
}

/** All-time usage across every batch, per stage. */
export function fetchAllTimeUsage(): Promise<AllTimeUsageResponse> {
  return request<AllTimeUsageResponse>(`${API_BASE_URL}/api/usage`);
}

/** Retry every permanently-failed job of a batch. */
export function retryFailedBatchJobs(batchId: number): Promise<BatchRetryResponse> {
  return request<BatchRetryResponse>(`${API_BASE_URL}/api/batches/${batchId}/retry-failed`, {
    method: 'POST',
  });
}

/** Retry one failed audio. */
export function retryAudio(batchId: number, audioId: number): Promise<AudioRetryResponse> {
  return request<AudioRetryResponse>(
    `${API_BASE_URL}/api/batches/${batchId}/audio/${audioId}/retry`,
    { method: 'POST' },
  );
}

/** Cancel a batch (pending jobs cancelled; master knowledge intact). */
export function cancelBatch(batchId: number): Promise<CancelBatchResponse> {
  return request<CancelBatchResponse>(`${API_BASE_URL}/api/batches/${batchId}/cancel`, {
    method: 'POST',
  });
}

/** Failed jobs of a batch (actionable failure details). */
export function fetchBatchJobs(batchId: number): Promise<BatchJobsResponse> {
  return request<BatchJobsResponse>(`${API_BASE_URL}/api/batches/${batchId}/jobs`);
}

/** Resolve or dismiss an open conflict (safe actions only). */
export function resolveConflict(
  conflictId: number,
  action: 'DISMISS' | 'RESOLVE',
  note?: string,
): Promise<ConflictResolveResponse> {
  return request<ConflictResolveResponse>(`${API_BASE_URL}/api/conflicts/${conflictId}/resolve`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ action, note }),
  });
}
