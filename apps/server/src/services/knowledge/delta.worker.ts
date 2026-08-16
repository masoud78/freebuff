import type { ApiUsageStatus, GeminiUsage } from '@freebuff/contracts';
import { and, eq } from 'drizzle-orm';
import { getDatabase } from '../../core/database/client.js';
import { apiUsage, knowledgeCandidates, type JobRow } from '../../core/database/schema.js';
import { DomainError } from '../errors.js';
import { GeminiGatewayError, geminiGateway, type GeminiGatewayLike } from '../gemini/gateway.js';
import { jobService, type DbExecutor } from '../jobs.service.js';
import { modelsService } from '../models.service.js';
import { settingsService } from '../settings.service.js';
import { batchService } from '../batches.service.js';
import { computeRetryDelayMs } from '../transcription/worker.js';
import { candidatesService } from './candidates.service.js';
import { knowledgeDeltaService } from './knowledge-delta.service.js';
import { batchFinalizationService } from './batch-finalization.service.js';

const POLL_INTERVAL_MS = 2000;

/**
 * Persistent delta worker. Polls the SQLite job queue for KNOWLEDGE_DELTA
 * jobs of started batches and runs the delta engine on each transcript's
 * pending candidates. Shares the job engine with the other workers.
 */
export class DeltaWorker {
  private activeCount = 0;
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly gateway: GeminiGatewayLike = geminiGateway) {}

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  wake(): void {
    void this.tick();
  }

  async processJob(job: JobRow): Promise<void> {
    try {
      // Claims left DECIDED by a crash (no decision row) are recovered.
      await candidatesService.reconcileStaleClaims();
      await knowledgeDeltaService.processTranscript(job, this.gateway);
      await batchFinalizationService.finalizeIfComplete(job.batchId);
    } catch (error) {
      await this.handleExecutionError(job, error);
    }
  }

  private async handleExecutionError(job: JobRow, error: unknown): Promise<void> {
    const { batchId } = job;
    const db = getDatabase();

    if (error instanceof GeminiGatewayError) {
      const modelId = await modelsService.getConfiguredModelId('KNOWLEDGE_PROCESSING').catch(() => null);
      await this.insertUsage(
        batchId,
        job.id,
        modelId,
        null,
        error.durationMs,
        'FAILED',
        error.code,
      );
      await this.failJob(job, error.code, error.message, error.retryable, batchId, error);
      return;
    }
    if (error instanceof DomainError) {
      // Permanent configuration/validation failures: the remaining pending
      // candidates of this transcript cannot be processed — mark them failed
      // so the batch reaches a consistent terminal state.
      await db
        .update(knowledgeCandidates)
        .set({ status: 'FAILED', updatedAt: new Date() })
        .where(
          and(
            eq(knowledgeCandidates.transcriptId, job.entityId),
            eq(knowledgeCandidates.status, 'PENDING'),
          ),
        );
      await this.failJob(job, error.code, error.message, false, batchId, error);
      return;
    }
    await this.failJob(
      job,
      'DELTA_PROCESSING_FAILED',
      'مقایسه دانش با خطای غیرمنتظره مواجه شد.',
      true,
      batchId,
      error,
    );
  }

  private async failJob(
    job: JobRow,
    errorCode: string,
    errorMessage: string,
    retryable: boolean,
    batchId: number,
    cause?: unknown,
  ): Promise<void> {
    const nextAttemptAt = retryable ? new Date(Date.now() + computeRetryDelayMs(job.attempt)) : null;
    await jobService.markFailed(job.id, errorCode, errorMessage, { retryable, nextAttemptAt });
    console.error(`[delta-worker] job ${job.id} failed`, {
      batchId,
      jobId: job.id,
      transcriptId: job.entityId,
      operation: 'knowledge_delta',
      errorCode,
      err: cause ?? errorCode,
    });
    await batchService.refreshBatchState(batchId);
  }

  private async insertUsage(
    batchId: number,
    jobId: number,
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
      audioId: null,
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

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      const concurrency = (await settingsService.getSettings()).processingConcurrency;
      while (this.activeCount < concurrency) {
        const job = await jobService.claimNextJob('KNOWLEDGE_DELTA');
        if (!job) break;
        this.activeCount += 1;
        void this.processJob(job)
          .catch((error) => {
            console.error('[delta-worker] unhandled job error', { jobId: job.id, err: error });
          })
          .finally(() => {
            this.activeCount -= 1;
          });
      }
    } catch (error) {
      console.error('[delta-worker] poll error', { err: error });
    }
  }
}

export const deltaWorker = new DeltaWorker();
