import type {
  GeminiCredentialStatus,
  GeminiCredentialStatusResponse,
  GeminiModelInfo,
  GeminiModelsResponse,
  GeminiTestOutcome,
} from '@freebuff/contracts';
import { getDatabase } from '../../core/database/client.js';
import { getMeta, setMeta } from '../../core/database/helpers/system-meta.js';
import { geminiModels } from '../../core/database/schema.js';
import { DomainError } from '../errors.js';
import { credentialStore } from './credentials.store.js';
import { GeminiGatewayError, geminiGateway, type GeminiGatewayLike } from './gateway.js';

const META_LAST_TESTED_AT = 'gemini_last_tested_at';
const META_LAST_TEST_OUTCOME = 'gemini_last_test_outcome';
const META_MODELS_REFRESHED_AT = 'gemini_models_refreshed_at';

const MESSAGES = {
  notConfigured: 'کلید Gemini تنظیم نشده است. ابتدا API Key را ذخیره کنید.',
} as const;

function toStatusResponse(
  status: GeminiCredentialStatus,
  lastTestedAt: string | null,
  lastTestOutcome: GeminiTestOutcome | null,
): GeminiCredentialStatusResponse {
  return { status, lastTestedAt, lastTestOutcome };
}

/**
 * Coordinates credentials, connection tests and the local model-discovery
 * cache. All Gemini API calls go through `geminiGateway` — never through the
 * SDK directly. The API key never leaves this layer.
 */
export class GeminiService {
  constructor(private readonly gateway: GeminiGatewayLike = geminiGateway) {}

  async getCredentialStatus(): Promise<GeminiCredentialStatusResponse> {
    const db = getDatabase();
    const key = await credentialStore.getKey();
    const lastTestedAt = (await getMeta(db, META_LAST_TESTED_AT)) || null;
    const lastTestOutcomeRaw = (await getMeta(db, META_LAST_TEST_OUTCOME)) || null;
    const lastTestOutcome = lastTestOutcomeRaw as GeminiTestOutcome | null;

    let status: GeminiCredentialStatus = 'NOT_CONFIGURED';
    if (key) {
      // A rejected key is INVALID; a valid-but-blocked key (region,
      // restriction, disabled API) is BLOCKED — not "invalid".
      if (lastTestOutcome === 'auth_error') status = 'INVALID';
      else if (lastTestOutcome === 'blocked') status = 'BLOCKED';
      else status = 'CONFIGURED';
    }
    return toStatusResponse(status, lastTestedAt, lastTestOutcome);
  }

  /** Replace the stored credential and invalidate dependent state. */
  async saveApiKey(apiKey: string): Promise<void> {
    await credentialStore.saveKey(apiKey);
    const db = getDatabase();
    // A new key makes previous test results and the model cache meaningless.
    await setMeta(db, META_LAST_TESTED_AT, '');
    await setMeta(db, META_LAST_TEST_OUTCOME, '');
    await setMeta(db, META_MODELS_REFRESHED_AT, '');
    await db.delete(geminiModels);
  }

  async deleteCredential(): Promise<void> {
    await credentialStore.deleteKey();
    const db = getDatabase();
    await setMeta(db, META_LAST_TESTED_AT, '');
    await setMeta(db, META_LAST_TEST_OUTCOME, '');
    await setMeta(db, META_MODELS_REFRESHED_AT, '');
    await db.delete(geminiModels);
  }

  /**
   * Perform a real, cheap request to Gemini to validate the stored key.
   * On failure the outcome is recorded and a normalized error is rethrown.
   */
  async testConnection(): Promise<void> {
    const key = await credentialStore.getKey();
    if (!key) {
      throw new DomainError('GEMINI_NOT_CONFIGURED', MESSAGES.notConfigured);
    }
    const db = getDatabase();
    try {
      await this.gateway.testConnection(key);
      await setMeta(db, META_LAST_TESTED_AT, new Date().toISOString());
      await setMeta(db, META_LAST_TEST_OUTCOME, 'success');
    } catch (error) {
      const outcome = outcomeFromGatewayError(error);
      await setMeta(db, META_LAST_TESTED_AT, new Date().toISOString());
      await setMeta(db, META_LAST_TEST_OUTCOME, outcome);
      throw error;
    }
  }

  /** Cached discovery result, or null when never refreshed. */
  async getCachedModels(): Promise<GeminiModelsResponse> {
    const db = getDatabase();
    const refreshedAt = await getMeta(db, META_MODELS_REFRESHED_AT);
    if (!refreshedAt) {
      return { models: [], refreshedAt: null };
    }
    const rows = await db
      .select({
        modelId: geminiModels.modelId,
        displayName: geminiModels.displayName,
        description: geminiModels.description,
        capabilitiesJson: geminiModels.capabilitiesJson,
        quotaStatus: geminiModels.quotaStatus,
        quotaDetail: geminiModels.quotaDetail,
      })
      .from(geminiModels)
      .orderBy(geminiModels.modelId);
    return {
      models: rows.map((row) => ({
        id: row.modelId,
        displayName: row.displayName,
        description: row.description,
        capabilities: JSON.parse(row.capabilitiesJson) as GeminiModelInfo['capabilities'],
        quotaStatus: (row.quotaStatus as GeminiModelInfo['quotaStatus']) ?? 'unknown',
        quotaDetail: row.quotaDetail ?? null,
      })),
      refreshedAt,
    };
  }

  /**
   * Fetch models from Gemini and replace the local cache. On failure the old
   * cache is kept (selections must not be auto-removed) and the error rethrown.
   */
  async refreshModels(): Promise<GeminiModelsResponse> {
    const key = await credentialStore.getKey();
    if (!key) {
      throw new DomainError('GEMINI_NOT_CONFIGURED', MESSAGES.notConfigured);
    }
    // probeQuota: true runs a tiny live probe per voice-capable model so the
    // UI can show real per-model quota state and block exhausted models.
    const models = await this.gateway.listModels(key, { probeQuota: true });

    const db = getDatabase();
    await db.delete(geminiModels);
    if (models.length > 0) {
      const now = new Date();
      await db
        .insert(geminiModels)
        .values(
          models.map((model) => ({
            modelId: model.id,
            displayName: model.displayName,
            description: model.description,
            capabilitiesJson: JSON.stringify(model.capabilities),
            quotaStatus: model.quotaStatus ?? null,
            quotaDetail: model.quotaDetail ?? null,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .onConflictDoNothing({ target: geminiModels.modelId });
    }
    await setMeta(db, META_MODELS_REFRESHED_AT, new Date().toISOString());
    return this.getCachedModels();
  }
}

function outcomeFromGatewayError(error: unknown): GeminiTestOutcome {
  if (error instanceof GeminiGatewayError) {
    switch (error.code) {
      case 'GEMINI_AUTH_ERROR':
        return 'auth_error';
      case 'GEMINI_FORBIDDEN':
        return 'blocked';
      case 'GEMINI_NETWORK_ERROR':
        return 'network_error';
      case 'GEMINI_RATE_LIMIT':
        return 'rate_limit';
      case 'GEMINI_QUOTA_EXHAUSTED':
        return 'quota_exhausted';
      default:
        return 'api_error';
    }
  }
  return 'api_error';
}

export const geminiService = new GeminiService();
