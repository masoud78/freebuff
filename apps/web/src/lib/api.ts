import type {
  AiReadinessResponse,
  ApiErrorCode,
  ApiErrorResponse,
  AppSettings,
  BatchDetailResponse,
  BatchListResponse,
  BatchSummary,
  CandidateRetrievalDebugResponse,
  DestinationDetailResponse,
  DestinationListResponse,
  GeminiCredentialStatusResponse,
  GeminiModelsResponse,
  GeminiTestConnectionResponse,
  HealthResponse,
  KnowledgeDecisionsResponse,
  ModelConfigResponse,
  ModelConfigsResponse,
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
