import type { ApiUsageStatus, GeminiUsage } from '@freebuff/contracts';
import { eq } from 'drizzle-orm';
import { getDatabase } from '../../core/database/client.js';
import { apiUsage, transcripts, type JobRow } from '../../core/database/schema.js';
import { DomainError } from '../errors.js';
import { GeminiGatewayError, geminiGateway, type GeminiGatewayLike } from '../gemini/gateway.js';
import { jobService, type DbExecutor } from '../jobs.service.js';
import { modelsService } from '../models.service.js';
import { settingsService } from '../settings.service.js';
import { batchService } from '../batches.service.js';
import { computeRetryDelayMs } from '../transcription/worker.js';
import { knowledgeAnalysisService } from './knowledge-analysis.service.js';

const POLL_INTERVAL_MS = 2000;

/**
 * Persistent knowledge-analysis worker. Polls the SQLite job queue for
 * KNOWLEDGE_ANALYSIS jobs of started batches and runs the structured
 * Gemini analysis. Shares the job engine with the transcription worker.
 */
export class KnowledgeWorker {
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
      await knowledgeAnalysisService.analyze(job, this.gateway);
    } catch (error) {
      await this.handleExecutionError(job, error);
    }
  }

  private async handleExecutionError(job: JobRow, error: unknown): Promise<void> {
    const { batchId } = job;
    const db = getDatabase();
    const transcript = await db
      .select({ id: transcripts.id, audioId: transcripts.audioId })
      .from(transcripts)
      .where(eq(transcripts.id, job.entityId))
      .get();

    if (error instanceof GeminiGatewayError) {
      const modelId = await modelsService.getConfiguredModelId('KNOWLEDGE_PROCESSING').catch(() => null);
      await this.insertUsage(
        batchId,
        job.id,
        transcript?.audioId ?? null,
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
      // Structured-output / segment / persistence failures are permanent.
      await this.failJob(job, error.code, error.message, false, batchId, error);
      return;
    }
    await this.failJob(
      job,
      'KNOWLEDGE_ANALYSIS_FAILED',
      'تحلیل دانش با خطای غیرمنتظره مواجه شد.',
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

  private async insertUsage(
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

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      const concurrency = (await settingsService.getSettings()).processingConcurrency;
      while (this.activeCount < concurrency) {
        const job = await jobService.claimNextJob('KNOWLEDGE_ANALYSIS');
        if (!job) break;
        this.activeCount += 1;
        void this.processJob(job)
          .catch((error) => {
            console.error('[knowledge-worker] unhandled job error', { jobId: job.id, err: error });
          })
          .finally(() => {
            this.activeCount -= 1;
          });
      }
    } catch (error) {
      console.error('[knowledge-worker] poll error', { err: error });
    }
  }
}

export const knowledgeWorker = new KnowledgeWorker();
