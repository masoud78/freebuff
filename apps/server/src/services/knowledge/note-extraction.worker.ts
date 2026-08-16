import type { JobRow } from '../../core/database/schema.js';
import { GeminiGatewayError, geminiGateway, type GeminiGatewayLike } from '../gemini/gateway.js';
import { DomainError } from '../errors.js';
import { jobService } from '../jobs.service.js';
import { settingsService } from '../settings.service.js';
import { computeRetryDelayMs } from '../transcription/worker.js';
import { noteExtractionService } from './note-extraction.service.js';

const POLL_INTERVAL_MS = 2000;

/**
 * Persistent note-extraction worker (simplified product flow). Claims
 * NOTE_EXTRACTION jobs of started sessions and runs one Gemini call per
 * transcript to produce a voice report plus useful notes, then reconciles
 * each note into a PENDING proposal. No destination mutation happens here.
 */
export class NoteExtractionWorker {
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
      await noteExtractionService.processJob(job, this.gateway);
    } catch (error) {
      await this.handleExecutionError(job, error);
    }
  }

  private async handleExecutionError(job: JobRow, error: unknown): Promise<void> {
    const { batchId } = job;
    if (error instanceof GeminiGatewayError) {
      await this.failJob(job, error.code, error.message, error.retryable, batchId, error);
      return;
    }
    if (error instanceof DomainError) {
      await this.failJob(job, error.code, error.message, false, batchId, error);
      return;
    }
    await this.failJob(job, 'KNOWLEDGE_ANALYSIS_FAILED', 'پردازش ویس با خطای غیرمنتظره مواجه شد.', true, batchId, error);
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
    console.error(`[note-worker] job ${job.id} failed`, {
      batchId,
      jobId: job.id,
      transcriptId: job.entityId,
      operation: 'note_extraction',
      errorCode,
      err: cause ?? errorCode,
    });
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      const concurrency = (await settingsService.getSettings()).processingConcurrency;
      while (this.activeCount < concurrency) {
        const job = await jobService.claimNextJob('NOTE_EXTRACTION');
        if (!job) break;
        this.activeCount += 1;
        void this.processJob(job)
          .catch((error) => {
            console.error('[note-worker] unhandled job error', { jobId: job.id, err: error });
          })
          .finally(() => {
            this.activeCount -= 1;
          });
      }
    } catch (error) {
      console.error('[note-worker] poll error', { err: error });
    }
  }
}

export const noteExtractionWorker = new NoteExtractionWorker();
