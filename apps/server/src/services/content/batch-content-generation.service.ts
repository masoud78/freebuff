import { createHash } from 'node:crypto';
import type { ContentRegenerateResponse, DeltaMetricKey, GeminiUsage } from '@freebuff/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { getDatabase } from '../../core/database/client.js';
import {
  apiUsage,
  batches,
  batchDestinationSummaries,
  deltaMetrics,
  destinations,
  generatedContentKnowledge,
  generatedContents,
  type GeneratedContentRow,
  type JobRow,
} from '../../core/database/schema.js';
import type { DbExecutor } from '../jobs.service.js';
import { DomainError } from '../errors.js';
import { GeminiGatewayError, type GeminiGatewayLike } from '../gemini/gateway.js';
import { credentialStore } from '../gemini/credentials.store.js';
import { jobService } from '../jobs.service.js';
import { modelsService } from '../models.service.js';
import { promptsService } from '../prompts.service.js';
import { batchService } from '../batches.service.js';
import { batchDeltaService } from '../knowledge/batch-delta.service.js';
import { contentInputBuilder, CONTENT_INTERNAL_CONTRACT } from './content-input-builder.js';

/**
 * BatchContentGenerationService (Phase 11 §38). Orchestrates content
 * generation per (batch, destination): publishable delta only → signature →
 * reuse-or-generate → persist with full traceability. Stateless Gemini calls;
 * the user's CONTENT_GENERATION prompt controls style and length.
 */
export class BatchContentGenerationService {
  /** Destinations with a publishable (ACTIVE NEW/UPDATE) delta in the batch. */
  async findChangedDestinations(batchId: number): Promise<number[]> {
    return batchDeltaService.listChangedDestinations(batchId);
  }

  /**
   * Create one CONTENT_GENERATION job per destination with a publishable
   * delta. Idempotent (CONTENT:{batch}:{dest}:{gen}); records the
   * "no publishable delta" metric for destinations without changes.
   */
  async ensureContentJobs(batchId: number): Promise<number> {
    const db = getDatabase();
    const changed = await this.findChangedDestinations(batchId);

    // Metric: destinations present in this batch that had nothing publishable.
    const summaryRows = await db
      .select({ destinationId: batchDestinationSummaries.destinationId })
      .from(batchDestinationSummaries)
      .where(eq(batchDestinationSummaries.batchId, batchId));
    const known = new Set(summaryRows.map((r) => r.destinationId));
    const noDelta = [...known].filter((id) => !changed.includes(id)).length;
    if (noDelta > 0) {
      await this.incrementMetric(batchId, 'destinations_no_publishable_delta_count', noDelta);
    }

    // Skip destinations that already have a successful generation for the
    // CURRENT delta signature (replay/restart safety — never regenerate
    // automatically). Missing model/prompt config is left to the worker,
    // which reports the proper permanent error code.
    const modelId = await modelsService.getConfiguredModelId('CONTENT_GENERATION').catch(() => null);
    const prompt = await promptsService.getActiveVersion('CONTENT_GENERATION').catch(() => null);
    const configReady = modelId !== null && prompt !== null && prompt.content.trim().length > 0;

    let created = 0;
    for (const destinationId of changed) {
      if (configReady) {
        const signature = await this.buildSignature(batchId, destinationId, prompt.id, modelId);
        const alreadyGenerated = await this.findBySignature(batchId, destinationId, signature);
        if (alreadyGenerated) {
          await this.incrementMetric(batchId, 'content_generation_reuse_count');
          continue;
        }
      }
      const nextGen = await this.nextGenerationNumber(batchId, destinationId);
      const { created: ok } = await jobService.createJob({
        batchId,
        jobType: 'CONTENT_GENERATION',
        entityId: destinationId,
        idempotencyKey: `CONTENT:${batchId}:${destinationId}:${nextGen}`,
      });
      if (ok) created += 1;
    }
    return created;
  }

  /** Stable signature: sorted delta versions + change types + prompt + model. */
  async buildSignature(
    batchId: number,
    destinationId: number,
    promptVersionId: number,
    modelId: string,
  ): Promise<string> {
    const items = await batchDeltaService.getDestinationDelta(batchId, destinationId);
    const delta = items
      .map((item) => `${item.versionId}:${item.changeType}`)
      .sort()
      .join('|');
    return createHash('sha256')
      .update([batchId, destinationId ?? '', delta, promptVersionId, modelId].join('|'))
      .digest('hex');
  }

  /**
   * Explicit regenerate: bump the generation number and queue a new job. The
   * batch is reopened as GENERATING_CONTENT so the worker picks the job up
   * even when the batch had already reached COMPLETED; when the new
   * generation finishes, refreshBatchState settles it back to COMPLETED.
   */
  async regenerate(
    batchId: number,
    destinationId: number,
  ): Promise<ContentRegenerateResponse> {
    const nextGen = await this.nextGenerationNumber(batchId, destinationId);
    await jobService.createJob({
      batchId,
      jobType: 'CONTENT_GENERATION',
      entityId: destinationId,
      idempotencyKey: `CONTENT:${batchId}:${destinationId}:${nextGen}`,
    });
    await getDatabase()
      .update(batches)
      .set({ status: 'GENERATING_CONTENT', completedAt: null, updatedAt: new Date() })
      .where(eq(batches.id, batchId));
    return { destinationId, generationNumber: nextGen, queued: true };
  }

  /** Body of a CONTENT_GENERATION job (called by the content worker). */
  async generateForJob(job: JobRow, gateway: GeminiGatewayLike): Promise<void> {
    const destinationId = job.entityId;
    const generationNumber = this.parseGenerationNumber(job);

    const modelId = await modelsService.getConfiguredModelId('CONTENT_GENERATION');
    if (!modelId) {
      throw new DomainError('CONTENT_MODEL_NOT_CONFIGURED', 'مدل تولید محتوا تنظیم نشده است.');
    }
    const prompt = await promptsService.getActiveVersion('CONTENT_GENERATION');
    if (!prompt || prompt.content.trim().length === 0) {
      throw new DomainError('CONTENT_PROMPT_NOT_CONFIGURED', 'پرامپت تولید محتوا تنظیم نشده است.');
    }
    const apiKey = await credentialStore.getKey();
    if (!apiKey) {
      throw new DomainError('GEMINI_NOT_CONFIGURED', 'کلید Gemini تنظیم نشده است.');
    }

    const items = await batchDeltaService.getDestinationDelta(job.batchId, destinationId);
    contentInputBuilder.validateBudget(items);

    const signature = await this.buildSignature(job.batchId, destinationId, prompt.id, modelId);

    // Idempotency: a successful generation for this (batch, dest, gen) is
    // reused — no second Gemini call on retry/replay.
    const existing = await this.findGeneration(job.batchId, destinationId, generationNumber);
    if (existing && existing.status === 'GENERATED') {
      await this.incrementMetric(job.batchId, 'content_generation_reuse_count');
      await jobService.markCompleted(job.id);
      await batchService.refreshBatchState(job.batchId);
      return;
    }

    const destinationName = await this.destinationName(destinationId);
    const userText = contentInputBuilder.buildUserText(destinationName, items);
    const systemPrompt = `${prompt.content}\n${CONTENT_INTERNAL_CONTRACT}`;

    let result: { text: string; usage: GeminiUsage; durationMs: number };
    try {
      result = await gateway.generateContent({
        apiKey,
        modelId,
        systemPrompt,
        userText,
      });
    } catch (error) {
      if (error instanceof GeminiGatewayError) {
        await this.recordUsage(job, destinationId, modelId, null, error.durationMs, 'FAILED', this.mapGatewayErrorCode(error));
      }
      throw error;
    }
    if (result.text.trim().length === 0) {
      await this.recordUsage(job, destinationId, modelId, null, result.durationMs, 'FAILED', 'CONTENT_EMPTY_RESPONSE');
      throw new GeminiGatewayError('GEMINI_API_ERROR', 'تولید محتوا خروجی خالی برگرداند.', {
        retryable: true,
        durationMs: result.durationMs,
      });
    }

    await this.recordUsage(job, destinationId, modelId, result.usage, result.durationMs, 'SUCCESS', null);
    await this.incrementMetric(job.batchId, 'content_generation_call_count');

    await this.persistGeneration({
      batchId: job.batchId,
      destinationId,
      content: result.text,
      modelId,
      promptVersionId: prompt.id,
      deltaSignature: signature,
      generationNumber,
    });

    await jobService.markCompleted(job.id);
    await batchService.refreshBatchState(job.batchId);
  }

  /** Save content + traceability transactionally; supersede older generations. */
  async persistGeneration(input: {
    batchId: number;
    destinationId: number;
    content: string;
    modelId: string;
    promptVersionId: number;
    deltaSignature: string;
    generationNumber: number;
  }): Promise<GeneratedContentRow> {
    const db = getDatabase();
    const now = new Date();
    try {
      return await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(generatedContents)
          .values({
            batchId: input.batchId,
            destinationId: input.destinationId,
            content: input.content,
            modelId: input.modelId,
            promptVersionId: input.promptVersionId,
            deltaSignature: input.deltaSignature,
            generationNumber: input.generationNumber,
            status: 'GENERATED',
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        const row = inserted[0];
        if (!row) {
          throw new DomainError('CONTENT_SAVE_FAILED', 'ذخیره محتوای تولیدشده ممکن نشد.');
        }
        await this.insertTraceability(tx, row.id, input.batchId, input.destinationId);
        await tx
          .update(generatedContents)
          .set({ status: 'SUPERSEDED', updatedAt: now })
          .where(
            and(
              eq(generatedContents.batchId, input.batchId),
              eq(generatedContents.destinationId, input.destinationId),
              sql`${generatedContents.generationNumber} < ${input.generationNumber}`,
              eq(generatedContents.status, 'GENERATED'),
            ),
          );
        return row;
      });
    } catch (error) {
      // Unique (batch, dest, gen) race with a concurrent retry — reuse winner.
      if (this.isUniqueConstraintError(error)) {
        const winner = await this.findGeneration(input.batchId, input.destinationId, input.generationNumber);
        if (winner) return winner;
        throw new DomainError('CONTENT_SAVE_FAILED', 'ذخیره محتوای تولیدشده ممکن نشد.', { cause: error });
      }
      if (error instanceof DomainError) throw error;
      throw new DomainError('CONTENT_SAVE_FAILED', 'ذخیره محتوای تولیدشده ممکن نشد.', { cause: error });
    }
  }

  private async insertTraceability(
    tx: DbExecutor,
    generatedContentId: number,
    batchId: number,
    destinationId: number,
  ): Promise<void> {
    const items = await batchDeltaService.getDestinationDelta(batchId, destinationId);
    for (const item of items) {
      await tx
        .insert(generatedContentKnowledge)
        .values({
          generatedContentId,
          knowledgeId: item.knowledgeId,
          knowledgeVersionId: item.versionId,
          changeId: item.changeId,
          createdAt: new Date(),
        })
        .onConflictDoNothing({
          target: [generatedContentKnowledge.generatedContentId, generatedContentKnowledge.changeId],
        });
    }
  }

  /** Any successful generation for (batch, destination, signature). */
  async findBySignature(
    batchId: number,
    destinationId: number,
    deltaSignature: string,
  ): Promise<GeneratedContentRow | null> {
    const db = getDatabase();
    const row = await db
      .select()
      .from(generatedContents)
      .where(
        and(
          eq(generatedContents.batchId, batchId),
          eq(generatedContents.destinationId, destinationId),
          eq(generatedContents.deltaSignature, deltaSignature),
          eq(generatedContents.status, 'GENERATED'),
        ),
      )
      .get();
    return row ?? null;
  }

  async findGeneration(
    batchId: number,
    destinationId: number,
    generationNumber: number,
  ): Promise<GeneratedContentRow | null> {
    const db = getDatabase();
    const row = await db
      .select()
      .from(generatedContents)
      .where(
        and(
          eq(generatedContents.batchId, batchId),
          eq(generatedContents.destinationId, destinationId),
          eq(generatedContents.generationNumber, generationNumber),
        ),
      )
      .get();
    return row ?? null;
  }

  private async nextGenerationNumber(batchId: number, destinationId: number): Promise<number> {
    const db = getDatabase();
    const row = await db
      .select({ max: sql<number>`max(${generatedContents.generationNumber})` })
      .from(generatedContents)
      .where(
        and(
          eq(generatedContents.batchId, batchId),
          eq(generatedContents.destinationId, destinationId),
        ),
      )
      .get();
    return Number(row?.max ?? 0) + 1;
  }

  private parseGenerationNumber(job: JobRow): number {
    const match = /^CONTENT:\d+:(-?\d+):(\d+)$/.exec(job.idempotencyKey);
    if (match) return Number(match[2]);
    return 1;
  }

  private async destinationName(destinationId: number): Promise<string | null> {
    const db = getDatabase();
    const row = await db
      .select({ canonicalName: destinations.canonicalName })
      .from(destinations)
      .where(eq(destinations.id, destinationId))
      .get();
    return row?.canonicalName ?? null;
  }

  private mapGatewayErrorCode(error: GeminiGatewayError): string {
    if (error.message.includes('خالی')) return 'CONTENT_EMPTY_RESPONSE';
    return error.code;
  }

  private async recordUsage(
    job: JobRow,
    destinationId: number,
    modelId: string,
    usage: GeminiUsage | null,
    durationMs: number | null,
    status: 'SUCCESS' | 'FAILED',
    errorCode: string | null,
  ): Promise<void> {
    await getDatabase().insert(apiUsage).values({
      batchId: job.batchId,
      jobId: job.id,
      audioId: null,
      destinationId,
      stage: 'CONTENT',
      modelId,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      cachedTokens: usage?.cachedTokens ?? null,
      totalTokens: usage?.totalTokens ?? null,
      durationMs: durationMs ?? 0,
      status,
      errorCode,
      createdAt: new Date(),
    });
  }

  private async incrementMetric(batchId: number, metricKey: DeltaMetricKey, value = 1): Promise<void> {
    const now = new Date();
    await getDatabase()
      .insert(deltaMetrics)
      .values({ batchId, metricKey, value, updatedAt: now })
      .onConflictDoUpdate({
        target: [deltaMetrics.batchId, deltaMetrics.metricKey],
        set: { value: sql`${deltaMetrics.value} + ${value}`, updatedAt: now },
      });
  }

  private isUniqueConstraintError(error: unknown): boolean {
    if (error instanceof DomainError) return false;
    const raw = error instanceof Error ? `${error.name} ${error.message}` : String(error);
    return raw.includes('SQLITE_CONSTRAINT') && raw.includes('UNIQUE');
  }
}

export const batchContentGenerationService = new BatchContentGenerationService();
