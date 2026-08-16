import type { AiReadinessCheck, AiReadinessResponse } from '@freebuff/contracts';
import { modelStages, promptTypes } from '@freebuff/contracts';
import { getDatabase } from '../core/database/client.js';
import { geminiModels, modelConfigs } from '../core/database/schema.js';
import { credentialStore } from './gemini/credentials.store.js';
import { promptsService } from './prompts.service.js';

/**
 * Configuration readiness — whether the app is fully configured to run AI
 * processing. Pure configuration state; no processing is ever started here.
 */
export class ReadinessService {
  async getReadiness(): Promise<AiReadinessResponse> {
    const db = getDatabase();

    // 1. Credential: present and not known-invalid.
    const key = await credentialStore.getKey();
    const credentialReady = key !== null;
    const checks: AiReadinessCheck[] = [
      { key: 'gemini_credential', ready: credentialReady },
    ];

    // 2. Model selections: present and still available in the discovery cache.
    const cachedIds = new Set(
      (await db.select({ modelId: geminiModels.modelId }).from(geminiModels)).map(
        (row) => row.modelId,
      ),
    );
    const configRows = await db
      .select({ stage: modelConfigs.stage, modelId: modelConfigs.modelId })
      .from(modelConfigs);
    const byStage = new Map(configRows.map((row) => [row.stage, row.modelId]));

    for (const stage of modelStages) {
      const modelId = byStage.get(stage);
      checks.push({
        key: `model_${stage.toLowerCase()}`,
        ready: Boolean(modelId && cachedIds.has(modelId)),
      });
    }

    // 3. Prompts: active version with non-empty content.
    for (const promptType of promptTypes) {
      const content = await promptsService.getActivePromptContent(promptType);
      checks.push({
        key: `prompt_${promptType.toLowerCase()}`,
        ready: content !== null,
      });
    }

    return { ready: checks.every((check) => check.ready), checks };
  }
}

export const readinessService = new ReadinessService();
