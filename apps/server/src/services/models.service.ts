import {
  modelConfigSchema,
  modelStages,
  type GeminiModelCapabilities,
  type GeminiModelQuotaStatus,
  type ModelConfigInput,
  type ModelConfigResponse,
  type ModelConfigsResponse,
  type ModelStage,
} from '@freebuff/contracts';
import { eq } from 'drizzle-orm';
import { getDatabase } from '../core/database/client.js';
import { geminiModels, modelConfigs } from '../core/database/schema.js';
import { DomainError } from './errors.js';

const PROVIDER = 'GEMINI';

const MESSAGES = {
  notFound: 'مدل انتخاب‌شده در فهرست مدل‌های Gemini نیست.',
  capability: 'مدل انتخاب‌شده برای این مرحله مناسب نیست.',
  quotaExhausted:
    'سهمیه این مدل در حساب Gemini شما تمام شده است. مدل دیگری انتخاب کنید یا بعداً دوباره تلاش کنید.',
  database: 'خطا در ذخیره پیکربندی مدل. دوباره تلاش کنید.',
} as const;

function capabilityFits(stage: ModelStage, capabilities: GeminiModelCapabilities): boolean {
  if (stage === 'EMBEDDING') return capabilities.embedding;
  // Voice-to-text requires a model that accepts audio input — no generative
  // fallback, so text-only/image/TTS models are never offered for this stage.
  if (stage === 'TRANSCRIPTION') return capabilities.audio;
  return capabilities.generative;
}

/** Per-stage model assignments, persisted in SQLite. */
export class ModelsService {
  /** All four stages with their current assignment (empty string = unset). */
  async getModelConfigs(): Promise<ModelConfigsResponse> {
    const db = getDatabase();
    const rows = await db
      .select({
        stage: modelConfigs.stage,
        modelId: modelConfigs.modelId,
      })
      .from(modelConfigs);

    const cache = await this.cachedModelIds();
    const byStage = new Map(rows.map((row) => [row.stage, row.modelId]));

    return modelStages.map((stage) => {
      const modelId = byStage.get(stage) ?? '';
      return {
        stage,
        provider: PROVIDER,
        modelId,
        available: modelId === '' ? false : cache.has(modelId),
      };
    });
  }

  /** Assign a model to a stage. The model must exist in the discovery cache. */
  async updateModelConfig(input: unknown): Promise<ModelConfigResponse> {
    const result = modelConfigSchema.safeParse(input);
    if (!result.success) {
      const message = result.error.issues[0]?.message ?? 'پیکربندی مدل نامعتبر است.';
      throw new DomainError('MODEL_CONFIG_INVALID', message);
    }
    const { stage, modelId } = result.data as ModelConfigInput;

    const db = getDatabase();
    const cached = await db
      .select({
        modelId: geminiModels.modelId,
        capabilitiesJson: geminiModels.capabilitiesJson,
        quotaStatus: geminiModels.quotaStatus,
      })
      .from(geminiModels)
      .where(eq(geminiModels.modelId, modelId))
      .get();

    if (!cached) {
      throw new DomainError('MODEL_CONFIG_INVALID', MESSAGES.notFound);
    }
    const capabilities = JSON.parse(cached.capabilitiesJson) as GeminiModelCapabilities;
    if (!capabilityFits(stage, capabilities)) {
      throw new DomainError('MODEL_CONFIG_INVALID', MESSAGES.capability);
    }
    // Block selecting a model whose live quota probe already failed.
    if (cached.quotaStatus === 'exhausted') {
      throw new DomainError('GEMINI_QUOTA_EXHAUSTED', MESSAGES.quotaExhausted);
    }

    const now = new Date();
    try {
      await db
        .insert(modelConfigs)
        .values({ stage, provider: PROVIDER, modelId, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: modelConfigs.stage,
          set: { modelId, provider: PROVIDER, updatedAt: now },
        });
    } catch (error) {
      throw new DomainError('DATABASE_ERROR', MESSAGES.database, { cause: error });
    }

    return { stage, provider: PROVIDER, modelId, available: true };
  }

  /** The configured model id for a stage, or null when unset. */
  async getConfiguredModelId(stage: ModelStage): Promise<string | null> {
    const db = getDatabase();
    const row = await db
      .select({ modelId: modelConfigs.modelId })
      .from(modelConfigs)
      .where(eq(modelConfigs.stage, stage))
      .get();
    return row?.modelId ?? null;
  }

  /** The configured model's id + last quota probe, or null when unset. */
  async getConfiguredModelQuota(
    stage: ModelStage,
  ): Promise<{ modelId: string; quotaStatus: GeminiModelQuotaStatus } | null> {
    const db = getDatabase();
    const row = await db
      .select({ modelId: modelConfigs.modelId })
      .from(modelConfigs)
      .where(eq(modelConfigs.stage, stage))
      .get();
    if (!row?.modelId) return null;
    const cached = await db
      .select({ quotaStatus: geminiModels.quotaStatus })
      .from(geminiModels)
      .where(eq(geminiModels.modelId, row.modelId))
      .get();
    return {
      modelId: row.modelId,
      quotaStatus: (cached?.quotaStatus as GeminiModelQuotaStatus | null | undefined) ?? 'unknown',
    };
  }

  private async cachedModelIds(): Promise<Set<string>> {
    const db = getDatabase();
    const rows = await db.select({ modelId: geminiModels.modelId }).from(geminiModels);
    return new Set(rows.map((row) => row.modelId));
  }
}

export const modelsService = new ModelsService();
