import { createHash } from 'node:crypto';
import type { ApiUsageStatus, GeminiUsage, KnowledgeAnalysis } from '@freebuff/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import { getDatabase } from '../../core/database/client.js';
import type { DbExecutor } from '../jobs.service.js';
import { apiUsage, knowledgeAnalysisRuns, transcriptSegments, transcripts, type JobRow } from '../../core/database/schema.js';
import { DomainError } from '../errors.js';
import { credentialStore } from '../gemini/credentials.store.js';
import { modelsService } from '../models.service.js';
import { promptsService } from '../prompts.service.js';
import { jobService } from '../jobs.service.js';
import { batchService } from '../batches.service.js';
import { candidatesService } from './candidates.service.js';
import { destinationService } from './destinations.service.js';
import { buildKnowledgeIdentityKey, buildKnowledgeValueHash } from './identity.js';
import { KNOWLEDGE_CONFIDENCE_MIN } from './knowledge.service.js';

interface AnalyzeResult {
  analysis: KnowledgeAnalysis;
  usage: GeminiUsage | null;
  durationMs: number;
}

/** The subset of the gateway surface the analyzer needs. */
export interface KnowledgeGatewayLike {
  analyzeKnowledge(input: {
    apiKey: string;
    modelId: string;
    systemPrompt: string;
    transcriptText: string;
  }): Promise<AnalyzeResult>;
}

const DEFAULT_SCOPE = '';

/**
 * Orchestrates one knowledge-analysis run for a transcript:
 * load config → Gemini structured analysis → validation → destination
 * resolution → atomic persistence (knowledge + V1 + evidence + run + job).
 */
export class KnowledgeAnalysisService {
  /** Stable signature: transcript hash + model + prompt version. */
  buildInputSignature(transcript: { normalizedHash: string }, modelId: string, promptVersionId: number): string {
    return createHash('sha256')
      .update(`${transcript.normalizedHash}|${modelId}|${promptVersionId}`)
      .digest('hex');
  }

  async analyze(
    job: JobRow,
    gateway: KnowledgeGatewayLike,
  ): Promise<void> {
    const db = getDatabase();
    const { batchId, entityId } = job;
    const transcript = await db.select().from(transcripts).where(eq(transcripts.id, entityId)).get();
    if (!transcript) {
      await this.failJob(job, 'TRANSCRIPT_NOT_FOUND', 'Transcript یافت نشد.', false, batchId);
      return;
    }
    if (transcript.status !== 'COMPLETED') {
      await this.failJob(job, 'TRANSCRIPT_NOT_FOUND', 'Transcript هنوز کامل نشده است.', false, batchId);
      return;
    }

    const modelId = await modelsService.getConfiguredModelId('KNOWLEDGE_PROCESSING');
    if (!modelId) {
      await this.failJob(
        job,
        'KNOWLEDGE_MODEL_NOT_CONFIGURED',
        'مدل تحلیل دانش تنظیم نشده است.',
        false,
        batchId,
      );
      return;
    }

    const prompt = await promptsService.getActiveVersion('KNOWLEDGE_PROCESSING');
    if (!prompt) {
      await this.failJob(
        job,
        'KNOWLEDGE_PROMPT_NOT_CONFIGURED',
        'پرامپت تحلیل دانش تنظیم نشده است.',
        false,
        batchId,
      );
      return;
    }

    const apiKey = await credentialStore.getKey();
    if (!apiKey) {
      await this.failJob(job, 'GEMINI_NOT_CONFIGURED', 'کلید Gemini تنظیم نشده است.', false, batchId);
      return;
    }

    // Idempotency: a COMPLETED run with the same signature means zero Gemini
    // calls (failed runs are retried, never skipped).
    const signature = this.buildInputSignature(transcript, modelId, prompt.id);
    const existingRun = await db
      .select({ id: knowledgeAnalysisRuns.id, status: knowledgeAnalysisRuns.status })
      .from(knowledgeAnalysisRuns)
      .where(eq(knowledgeAnalysisRuns.inputSignature, signature))
      .get();
    if (existingRun?.status === 'COMPLETED') {
      await jobService.markCompleted(job.id);
      await batchService.refreshBatchState(batchId);
      return;
    }

    const started = new Date();
    const runInserted = await db
      .insert(knowledgeAnalysisRuns)
      .values({
        transcriptId: transcript.id,
        modelId,
        promptVersionId: prompt.id,
        inputSignature: signature,
        status: 'RUNNING',
        createdAt: started,
      })
      .returning({ id: knowledgeAnalysisRuns.id });
    const analysisRunId = runInserted[0]?.id;
    if (analysisRunId === undefined) {
      await this.recordFailedRun(signature, 'FAILED');
      throw new DomainError('KNOWLEDGE_SAVE_FAILED', 'ثبت تحلیل دانش ممکن نشد.');
    }

    let result: AnalyzeResult;
    try {
      result = await gateway.analyzeKnowledge({
        apiKey,
        modelId,
        systemPrompt: prompt.content,
        transcriptText: transcript.fullText,
      });
    } catch (error) {
      await this.recordFailedRun(signature, 'FAILED');
      throw error;
    }

    const { analysis } = result;

    // The Gemini call itself succeeded — record its real usage regardless of
    // whether the structured output passes validation.
    await this.recordUsage(
      batchId,
      job.id,
      transcript.audioId,
      modelId,
      result.usage,
      result.durationMs,
      'SUCCESS',
      null,
    );

    // Segment validation: Gemini may only reference segments of this transcript.
    try {
      await this.validateSegments(transcript.id, analysis);
      await db.transaction(async (tx) => {
        await this.persistAnalysis(tx, job, transcript, analysis, analysisRunId);
      });
    } catch (error) {
      await this.recordFailedRun(signature, 'FAILED');
      if (error instanceof DomainError) {
        // Structured-output/segment/persistence failures are permanent.
        await this.failJob(job, error.code, error.message, false, batchId, error);
        return;
      }
      throw new DomainError('KNOWLEDGE_SAVE_FAILED', 'ذخیره تحلیل دانش ممکن نشد.', { cause: error });
    }

    await db
      .update(knowledgeAnalysisRuns)
      .set({ status: 'COMPLETED', completedAt: new Date() })
      .where(eq(knowledgeAnalysisRuns.inputSignature, signature));
    await jobService.markCompleted(job.id);
    await batchService.refreshBatchState(batchId);
  }

  /**
   * All persistence of one analysis happens in a single transaction. Since
   * Phase 9, extraction produces knowledge CANDIDATES — never direct master
   * knowledge. The delta job for this transcript is created in the same
   * transaction so a crash can never leave candidates without a delta job.
   */
  private async persistAnalysis(
    tx: DbExecutor,
    job: JobRow,
    transcript: typeof transcripts.$inferSelect,
    analysis: KnowledgeAnalysis,
    analysisRunId: number,
  ): Promise<void> {
    const { batchId } = job;
    const resolvedDestinations = new Map<string, number>();

    for (const proposal of analysis.destinations) {
      const resolved = await destinationService.resolveOrCreateDestination(
        proposal,
        batchId,
        tx,
      );
      if (!resolved) continue; // UNKNOWN — never invent a destination.
      resolvedDestinations.set(proposal.name, resolved.id);
      await destinationService.linkTranscript(transcript.id, resolved.id, resolved.confidence, tx);
    }

    const segmentText = new Map(
      (
        await tx
          .select({ id: transcriptSegments.id, text: transcriptSegments.text })
          .from(transcriptSegments)
          .where(eq(transcriptSegments.transcriptId, transcript.id))
      ).map((row) => [row.id, row.text]),
    );

    let createdAny = false;
    for (const candidate of analysis.knowledge) {
      // Low confidence → rejected, never persisted.
      if (candidate.confidence < KNOWLEDGE_CONFIDENCE_MIN) continue;

      const destinationId = candidate.destinationReference
        ? (resolvedDestinations.get(candidate.destinationReference) ?? null)
        : null;
      const firstSegmentId = candidate.sourceSegmentIds[0] ?? null;

      const identityKey = buildKnowledgeIdentityKey({
        destinationId,
        knowledgeType: candidate.knowledgeType,
        entityName: candidate.entityName,
        attribute: candidate.attribute,
        scope: candidate.category ?? DEFAULT_SCOPE,
      });
      const valueHash = buildKnowledgeValueHash({
        valueText: candidate.value,
        unit: candidate.unit,
        qualifiers: candidate.qualifiers,
      });

      await candidatesService.createCandidate(
        {
          analysisRunId,
          batchId,
          transcriptId: transcript.id,
          destinationId,
          knowledgeType: candidate.knowledgeType,
          category: candidate.category,
          entityType: candidate.entityType,
          entityName: candidate.entityName,
          attribute: candidate.attribute,
          valueText: candidate.value,
          valueJson: null,
          unit: candidate.unit,
          qualifiers: candidate.qualifiers,
          canonicalText: candidate.canonicalText,
          identityKey,
          valueHash,
          confidence: candidate.confidence,
          sourceSegmentId: firstSegmentId,
          sourceText: firstSegmentId !== null ? (segmentText.get(firstSegmentId) ?? '') : transcript.fullText.slice(0, 500),
        },
        tx,
      );
      createdAny = true;
    }

    // One persistent delta job per transcript, in the same transaction.
    if (createdAny) {
      await jobService.createJob(
        {
          batchId,
          jobType: 'KNOWLEDGE_DELTA',
          entityId: transcript.id,
          idempotencyKey: `KNOWLEDGE_DELTA:${transcript.id}`,
        },
        tx,
      );
    }
  }

  /** Gemini may only reference segment ids that belong to this transcript. */
  private async validateSegments(
    transcriptId: number,
    analysis: KnowledgeAnalysis,
  ): Promise<void> {
    const referenced = new Set<number>();
    for (const item of analysis.knowledge) {
      for (const id of item.sourceSegmentIds) referenced.add(id);
    }
    if (referenced.size === 0) return;

    const db = getDatabase();
    // Segments must exist AND belong to this exact transcript.
    const valid = new Set(
      (
        await db
          .select({ id: transcriptSegments.id })
          .from(transcriptSegments)
          .where(
            and(
              eq(transcriptSegments.transcriptId, transcriptId),
              inArray(transcriptSegments.id, [...referenced]),
            ),
          )
      ).map((row) => row.id),
    );
    for (const id of referenced) {
      if (!valid.has(id)) {
        throw new DomainError(
          'KNOWLEDGE_INVALID_SEGMENT',
          'Segment نامعتبر در تحلیل دانش ارجاع شده است.',
        );
      }
    }
  }

  private async recordUsage(
    batchId: number,
    jobId: number,
    audioId: number | null,
    modelId: string | null,
    usage: GeminiUsage | null,
    durationMs: number | null,
    status: ApiUsageStatus,
    errorCode: string | null,
    db: DbExecutor = getDatabase(),
  ): Promise<void> {
    await db.insert(apiUsage).values({
      batchId,
      jobId,
      audioId,
      stage: 'KNOWLEDGE',
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

  private async recordFailedRun(signature: string, status: 'FAILED'): Promise<void> {
    await getDatabase()
      .update(knowledgeAnalysisRuns)
      .set({ status, completedAt: new Date() })
      .where(eq(knowledgeAnalysisRuns.inputSignature, signature));
  }

  private async failJob(
    job: JobRow,
    errorCode: string,
    errorMessage: string,
    retryable: boolean,
    batchId: number,
    cause?: unknown,
  ): Promise<void> {
    await jobService.markFailed(job.id, errorCode, errorMessage, { retryable });
    console.error(`[knowledge-worker] job ${job.id} failed`, {
      batchId,
      jobId: job.id,
      transcriptId: job.entityId,
      operation: 'knowledge_analysis',
      errorCode,
      err: cause ?? errorCode,
    });
    await batchService.refreshBatchState(batchId);
  }
}

export const knowledgeAnalysisService = new KnowledgeAnalysisService();
