import { mkdirSync, statSync } from 'node:fs';
import type { PipelinePreflightIssue, PipelinePreflightResponse } from '@freebuff/contracts';
import { getDatabase } from '../core/database/client.js';
import { modelConfigs } from '../core/database/schema.js';
import { credentialStore } from './gemini/credentials.store.js';
import { promptsService } from './prompts.service.js';
import { getWorkspaceAudioDir } from './workspace-paths.js';

/**
 * PipelinePreflightService (Phase 12 §11–12). Checks everything required to
 * START batch processing: Gemini credential, every model stage, every active
 * prompt, and a usable workspace. Pure configuration state — no processing is
 * ever started here, and the batch start endpoint refuses to run when not
 * ready so permanent configuration failures never enter the job engine.
 */
export class PipelinePreflightService {
  async checkPreflight(): Promise<PipelinePreflightResponse> {
    const issues: PipelinePreflightIssue[] = [];

    // 1. Gemini credential.
    const key = await credentialStore.getKey();
    if (!key) {
      issues.push({
        key: 'gemini_credential',
        label: 'اتصال Gemini',
        message: 'کلید API تنظیم نشده است. از صفحهٔ تنظیمات، بخش Gemini یک کلید معتبر وارد کنید.',
      });
    }

    // 2. Model selections — a configured model id is authoritative (saving a
    //    model already validates it against the discovery cache).
    const db = getDatabase();
    const configRows = await db
      .select({ stage: modelConfigs.stage, modelId: modelConfigs.modelId })
      .from(modelConfigs);
    const byStage = new Map(configRows.map((row) => [row.stage, row.modelId]));

    const stageMeta: Record<string, { label: string; message: string }> = {
      TRANSCRIPTION: {
        label: 'مدل تبدیل صوت به متن',
        message: 'مدل تبدیل صوت به متن (Transcription) انتخاب نشده است. از صفحهٔ تنظیمات، بخش Models آن را انتخاب کنید.',
      },
      KNOWLEDGE_PROCESSING: {
        label: 'مدل تحلیل دانش',
        message: 'مدل تحلیل دانش (Knowledge) انتخاب نشده است. از صفحهٔ تنظیمات، بخش Models آن را انتخاب کنید.',
      },
      EMBEDDING: {
        label: 'مدل Embedding',
        message: 'مدل Embedding انتخاب نشده است. از صفحهٔ تنظیمات، بخش Models آن را انتخاب کنید.',
      },
      CONTENT_GENERATION: {
        label: 'مدل تولید محتوا',
        message: 'مدل تولید محتوا (Content) انتخاب نشده است. از صفحهٔ تنظیمات، بخش Models آن را انتخاب کنید.',
      },
    };
    for (const [stage, meta] of Object.entries(stageMeta)) {
      const modelId = byStage.get(stage);
      if (!modelId) {
        issues.push({
          key: `model_${stage.toLowerCase()}`,
          label: meta.label,
          message: meta.message,
        });
      }
    }

    // 3. Active prompts with non-empty content.
    const promptMeta: Record<string, { label: string; message: string }> = {
      TRANSCRIPTION: {
        label: 'پرامپت تبدیل صوت به متن',
        message: 'پرامپت تبدیل صوت به متن تنظیم نشده است. از صفحهٔ تنظیمات، بخش Prompts یک نسخهٔ فعال با متن بسازید.',
      },
      KNOWLEDGE_PROCESSING: {
        label: 'پرامپت تحلیل دانش',
        message: 'پرامپت تحلیل دانش تنظیم نشده است. از صفحهٔ تنظیمات، بخش Prompts یک نسخهٔ فعال با متن بسازید.',
      },
      CONTENT_GENERATION: {
        label: 'پرامپت تولید محتوا',
        message: 'پرامپت تولید محتوا تنظیم نشده است. از صفحهٔ تنظیمات، بخش Prompts یک نسخهٔ فعال با متن بسازید.',
      },
    };
    for (const [promptType, meta] of Object.entries(promptMeta)) {
      const content = await promptsService.getActivePromptContent(
        promptType as 'TRANSCRIPTION' | 'KNOWLEDGE_PROCESSING' | 'CONTENT_GENERATION',
      );
      if (content === null || content.trim().length === 0) {
        issues.push({
          key: `prompt_${promptType.toLowerCase()}`,
          label: meta.label,
          message: meta.message,
        });
      }
    }

    // 4. Workspace usable (audio dir exists/creatable).
    try {
      const audioDir = await getWorkspaceAudioDir();
      // Ensure the folder exists and is a directory — same check the scanner does.
      mkdirSync(audioDir, { recursive: true });
      if (!statSync(audioDir).isDirectory()) {
        throw new Error(`${audioDir} is not a directory`);
      }
    } catch {
      issues.push({
        key: 'workspace_path',
        label: 'فضای کاری',
        message: 'پوشهٔ Workspace قابل استفاده نیست. از صفحهٔ تنظیمات، بخش Workspace مسیر معتبری وارد کنید.',
      });
    }

    return { ready: issues.length === 0, issues };
  }
}

export const pipelinePreflightService = new PipelinePreflightService();
