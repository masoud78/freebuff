import {
  promptContentSchema,
  promptTypes,
  type PromptTemplatesResponse,
  type PromptType,
  type PromptVersionInfo,
  type PromptVersionsResponse,
} from '@freebuff/contracts';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { and, desc, eq } from 'drizzle-orm';
import { getDatabase } from '../core/database/client.js';
import { promptTemplates, promptVersions } from '../core/database/schema.js';
import { DomainError } from './errors.js';

const MESSAGES = {
  typeInvalid: 'نوع Prompt نامعتبر است.',
  notFound: 'Prompt یافت نشد.',
  database: 'خطا در ذخیره Prompt. دوباره تلاش کنید.',
} as const;

export const PROMPT_DISPLAY_NAMES: Record<PromptType, string> = {
  TRANSCRIPTION: 'تبدیل صوت به متن',
  KNOWLEDGE_PROCESSING: 'پردازش دانش',
  CONTENT_GENERATION: 'تولید محتوا',
};

function isPromptType(value: string): value is PromptType {
  return (promptTypes as readonly string[]).includes(value);
}

function toVersionInfo(row: typeof promptVersions.$inferSelect): PromptVersionInfo {
  return {
    id: row.id,
    versionNumber: row.versionNumber,
    content: row.content,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Immutable, versioned prompt management. Saves never modify old versions. */
export class PromptsService {
  /** Create the three default templates (each with one empty v1) if absent. */
  async ensureDefaultTemplates(): Promise<void> {
    const db = getDatabase();
    const now = new Date();
    for (const promptType of promptTypes) {
      const existing = await db
        .select({ id: promptTemplates.id })
        .from(promptTemplates)
        .where(eq(promptTemplates.promptType, promptType))
        .get();
      if (existing) continue;
      const inserted = await db
        .insert(promptTemplates)
        .values({
          promptType,
          displayName: PROMPT_DISPLAY_NAMES[promptType],
          createdAt: now,
        })
        .returning({ id: promptTemplates.id });
      const templateId = inserted[0]?.id;
      if (templateId == null) continue;
      // Empty v1 — never processing-ready until the user fills it in.
      await db.insert(promptVersions).values({
        promptTemplateId: templateId,
        versionNumber: 1,
        content: '',
        isActive: true,
        createdAt: now,
      });
    }
  }

  async getTemplates(): Promise<PromptTemplatesResponse> {
    const db = getDatabase();
    const templates = await db.select().from(promptTemplates);
    const versions = await db.select().from(promptVersions);

    const byTemplate = new Map<number, typeof versions>();
    for (const version of versions) {
      const list = byTemplate.get(version.promptTemplateId) ?? [];
      list.push(version);
      byTemplate.set(version.promptTemplateId, list);
    }

    return templates.map((template) => {
      const templateVersions = (byTemplate.get(template.id) ?? []).sort(
        (a, b) => b.versionNumber - a.versionNumber,
      );
      const active = templateVersions.find((v) => v.isActive) ?? null;
      return {
        promptType: template.promptType as PromptType,
        displayName: template.displayName,
        activeVersion: active ? toVersionInfo(active) : null,
        versionCount: templateVersions.length,
      };
    });
  }

  async getVersions(promptType: string): Promise<PromptVersionsResponse> {
    if (!isPromptType(promptType)) {
      throw new DomainError('PROMPT_NOT_FOUND', MESSAGES.typeInvalid);
    }
    const db = getDatabase();
    const template = await this.requireTemplate(db, promptType);
    const versions = await db
      .select()
      .from(promptVersions)
      .where(eq(promptVersions.promptTemplateId, template.id))
      .orderBy(desc(promptVersions.versionNumber));

    return {
      promptType,
      displayName: template.displayName,
      versions: versions.map(toVersionInfo),
    };
  }

  /** Save a new immutable version and make it the active one. */
  async saveVersion(promptType: string, input: unknown): Promise<PromptVersionsResponse> {
    if (!isPromptType(promptType)) {
      throw new DomainError('PROMPT_NOT_FOUND', MESSAGES.typeInvalid);
    }
    const result = promptContentSchema.safeParse(input);
    if (!result.success) {
      throw new DomainError('PROMPT_INVALID', 'محتوی Prompt نامعتبر است.');
    }
    const content = result.data.content;

    const db = getDatabase();
    const template = await this.requireTemplate(db, promptType);
    const now = new Date();
    try {
      const latest = await db
        .select({ versionNumber: promptVersions.versionNumber })
        .from(promptVersions)
        .where(eq(promptVersions.promptTemplateId, template.id))
        .orderBy(desc(promptVersions.versionNumber))
        .limit(1)
        .get();

      const nextNumber = (latest?.versionNumber ?? 0) + 1;
      await db.transaction(async (tx) => {
        await tx
          .update(promptVersions)
          .set({ isActive: false })
          .where(
            and(
              eq(promptVersions.promptTemplateId, template.id),
              eq(promptVersions.isActive, true),
            ),
          );
        await tx.insert(promptVersions).values({
          promptTemplateId: template.id,
          versionNumber: nextNumber,
          content,
          isActive: true,
          createdAt: now,
        });
      });
    } catch (error) {
      throw new DomainError('DATABASE_ERROR', MESSAGES.database, { cause: error });
    }
    return this.getVersions(promptType);
  }

  /** Activate an existing version; the previous active version is deactivated. */
  async activateVersion(promptType: string, versionId: number): Promise<PromptVersionsResponse> {
    if (!isPromptType(promptType)) {
      throw new DomainError('PROMPT_NOT_FOUND', MESSAGES.typeInvalid);
    }
    const db = getDatabase();
    const template = await this.requireTemplate(db, promptType);
    try {
      const target = await db
        .select({ id: promptVersions.id })
        .from(promptVersions)
        .where(
          and(
            eq(promptVersions.promptTemplateId, template.id),
            eq(promptVersions.id, versionId),
          ),
        )
        .get();
      if (!target) {
        throw new DomainError('PROMPT_NOT_FOUND', 'نسخه موردنظر یافت نشد.');
      }
      await db.transaction(async (tx) => {
        await tx
          .update(promptVersions)
          .set({ isActive: false })
          .where(eq(promptVersions.promptTemplateId, template.id));
        await tx
          .update(promptVersions)
          .set({ isActive: true })
          .where(eq(promptVersions.id, versionId));
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('DATABASE_ERROR', MESSAGES.database, { cause: error });
    }
    return this.getVersions(promptType);
  }

  /** The active, non-empty prompt content, or null when not ready. */
  async getActivePromptContent(promptType: PromptType): Promise<string | null> {
    const active = await this.getActiveVersion(promptType);
    return active?.content ?? null;
  }

  /** The active prompt version (id + content), or null when not ready. */
  async getActiveVersion(
    promptType: PromptType,
  ): Promise<{ id: number; content: string } | null> {
    const db = getDatabase();
    const template = await db
      .select({ id: promptTemplates.id })
      .from(promptTemplates)
      .where(eq(promptTemplates.promptType, promptType))
      .get();
    if (!template) return null;
    const active = await db
      .select({ id: promptVersions.id, content: promptVersions.content })
      .from(promptVersions)
      .where(
        and(
          eq(promptVersions.promptTemplateId, template.id),
          eq(promptVersions.isActive, true),
        ),
      )
      .get();
    if (!active) return null;
    const content = active.content.trim();
    return content.length > 0 ? { id: active.id, content } : null;
  }

  private async requireTemplate(db: LibSQLDatabase<typeof import('../core/database/schema.js')>, promptType: PromptType) {
    const template = await db
      .select()
      .from(promptTemplates)
      .where(eq(promptTemplates.promptType, promptType))
      .get();
    if (!template) {
      throw new DomainError('PROMPT_NOT_FOUND', MESSAGES.notFound);
    }
    return template;
  }
}

export const promptsService = new PromptsService();
