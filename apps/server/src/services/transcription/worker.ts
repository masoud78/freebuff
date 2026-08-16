import { statSync } from 'node:fs';
import type { ApiUsageStatus, GeminiUsage } from '@freebuff/contracts';
import { and, eq } from 'drizzle-orm';
import { getDatabase } from '../../core/database/client.js';
import { apiUsage, audioFiles, transcripts, transcriptSegments, type JobRow } from '../../core/database/schema.js';
import { DomainError } from '../errors.js';
import { GeminiGatewayError, geminiGateway, type GeminiGatewayLike } from '../gemini/gateway.js';
import { credentialStore } from '../gemini/credentials.store.js';
import { jobService, type DbExecutor } from '../jobs.service.js';
import { modelsService } from '../models.service.js';
import { promptsService } from '../prompts.service.js';
import { batchService } from '../batches.service.js';
import { settingsService } from '../settings.service.js';
import { hashText, normalizeText, segmentTranscript } from './normalize.js';

const POLL_INTERVAL_MS = 2000;
const MAX_BACKOFF_MS = 60_000;

/** Exponential backoff with jitter for retryable failures. */
export function computeRetryDelayMs(attempt: number): number {
  const base = Math.min(Math.pow(2, attempt) * 1000, MAX_BACKOFF_MS);
  return base / 2 + Math.floor(Math.random() * (base / 2));
}

/**
 * Persistent transcription worker. Polls the SQLite job queue, atomically
 * claims PENDING jobs of started batches, and executes the Gemini
 * transcription pipeline. Concurrency comes from `processing_concurrency`.
 */
export class TranscriptionWorker {
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

  /** Stop claiming new jobs. In-flight jobs run to completion. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Trigger an immediate poll pass (e.g. after a batch start). */
  wake(): void {
    void this.tick();
  }

  /** One full pipeline run for a single job. Testable in isolation. */
  async processJob(job: JobRow): Promise<void> {
    const db = getDatabase();
    const { batchId, entityId } = job;

    try {
      const audio = await db.select().from(audioFiles).where(eq(audioFiles.id, entityId)).get();
      if (!audio) {
        await this.failJob(job, 'AUDIO_FILE_NOT_FOUND', 'فایل صوتی یافت نشد.', false, batchId);
        return;
      }
      if (audio.status === 'DUPLICATE') {
        // Defensive: duplicates never receive jobs, but complete harmlessly.
        await jobService.markCompleted(job.id);
        await batchService.refreshBatchState(batchId);
        return;
      }

      // 1. Model configuration.
      const modelId = await modelsService.getConfiguredModelId('TRANSCRIPTION');
      if (!modelId) {
        await this.failJob(
          job,
          'TRANSCRIPTION_MODEL_NOT_CONFIGURED',
          'مدل تبدیل صوت به متن تنظیم نشده است.',
          false,
          batchId,
        );
        return;
      }

      // 2. Active transcription prompt.
      const prompt = await promptsService.getActiveVersion('TRANSCRIPTION');
      if (!prompt) {
        await this.failJob(
          job,
          'TRANSCRIPTION_PROMPT_NOT_CONFIGURED',
          'پرامپت تبدیل صوت به متن تنظیم نشده است.',
          false,
          batchId,
        );
        return;
      }

      // 3. Credential.
      const apiKey = await credentialStore.getKey();
      if (!apiKey) {
        await this.failJob(job, 'GEMINI_NOT_CONFIGURED', 'کلید Gemini تنظیم نشده است.', false, batchId);
        return;
      }

      // 4. Idempotency: an existing COMPLETED transcript with the same
      //    configuration means zero Gemini calls for this audio.
      const existing = await db
        .select({ id: transcripts.id })
        .from(transcripts)
        .where(
          and(
            eq(transcripts.audioId, audio.id),
            eq(transcripts.modelId, modelId),
            eq(transcripts.promptVersionId, prompt.id),
            eq(transcripts.status, 'COMPLETED'),
          ),
        )
        .get();
      if (existing) {
        await this.finalizeWithoutCall(job, audio.id, batchId);
        return;
      }

      // 5. File must exist on disk.
      try {
        if (!statSync(audio.absolutePath).isFile()) {
          throw new Error(`${audio.absolutePath} is not a file`);
        }
      } catch (error) {
        await this.failJob(job, 'AUDIO_FILE_NOT_FOUND', 'فایل صوتی روی دیسک یافت نشد.', false, batchId, error);
        return;
      }

      // 6. Mark in progress so the UI reflects it.
      await db
        .update(audioFiles)
        .set({ status: 'TRANSCRIBING', updatedAt: new Date() })
        .where(eq(audioFiles.id, audio.id));

      // 7. Real Gemini transcription.
      const { text, usage, durationMs } = await this.gateway.transcribeAudio({
        apiKey,
        modelId,
        audioPath: audio.absolutePath,
        mimeType: audio.mimeType,
        systemPrompt: prompt.content,
      });

      if (text.trim().length === 0) {
        await this.recordUsage(batchId, job.id, audio.id, modelId, usage, durationMs, 'FAILED', 'TRANSCRIPTION_EMPTY_RESPONSE');
        await this.failJob(job, 'TRANSCRIPTION_EMPTY_RESPONSE', 'Gemini متن خالی برگرداند.', false, batchId);
        return;
      }

      // 8. Normalize, hash, segment, detect transcript duplicates.
      const normalizedText = normalizeText(text);
      const normalizedHash = hashText(normalizedText);
      const segments = segmentTranscript(text);
      const dupOf = await this.detectTranscriptDuplicate(normalizedHash, audio.id);

      // 9. Atomic storage: transcript + segments + audio status + job + usage.
      await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(transcripts)
          .values({
            audioId: audio.id,
            fullText: text,
            normalizedText,
            normalizedHash,
            language: null,
            modelId,
            promptVersionId: prompt.id,
            status: 'COMPLETED',
            duplicateOfTranscriptId: dupOf,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .returning({ id: transcripts.id });
        const transcriptId = inserted[0]?.id;
        if (transcriptId === undefined) {
          throw new DomainError('TRANSCRIPT_SAVE_FAILED', 'ذخیره Transcript ممکن نشد.');
        }

        const now = new Date();
        for (const [index, segment] of segments.entries()) {
          await tx.insert(transcriptSegments).values({
            transcriptId,
            sequence: index + 1,
            speaker: segment.speaker,
            text: segment.text,
            normalizedText: segment.normalizedText,
            textHash: segment.textHash,
            startTime: null,
            endTime: null,
            createdAt: now,
          });
        }

        await tx
          .update(audioFiles)
          .set({ status: 'TRANSCRIBED', updatedAt: now })
          .where(eq(audioFiles.id, audio.id));

        await this.insertUsage(
          tx,
          batchId,
          job.id,
          audio.id,
          modelId,
          usage,
          durationMs,
          'SUCCESS',
          null,
        );
        await jobService.markCompleted(job.id, tx);

        // Non-duplicate transcripts get exactly one knowledge-analysis job
        // (created in the same transaction; duplicates skip it entirely).
        if (dupOf === null) {
          await jobService.createJob(
            {
              batchId,
              jobType: 'KNOWLEDGE_ANALYSIS',
              entityId: transcriptId,
              idempotencyKey: `KNOWLEDGE_ANALYSIS:${transcriptId}`,
            },
            tx,
          );
        }
      });

      await batchService.refreshBatchState(batchId);
    } catch (error) {
      await this.handleExecutionError(job, error);
    }
  }

  private async handleExecutionError(job: JobRow, error: unknown): Promise<void> {
    const { batchId } = job;
    const db = getDatabase();
    const audio = await db
      .select({ id: audioFiles.id, mimeType: audioFiles.mimeType })
      .from(audioFiles)
      .where(eq(audioFiles.id, job.entityId))
      .get();

    if (error instanceof GeminiGatewayError) {
      const modelId = await modelsService.getConfiguredModelId('TRANSCRIPTION').catch(() => null);
      await this.recordUsage(
        batchId,
        job.id,
        audio?.id ?? null,
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
      await this.failJob(job, error.code, error.message, false, batchId, error);
      return;
    }
    await this.failJob(job, 'TRANSCRIPTION_FAILED', 'اجرای ترنسکریپشن با خطای غیرمنتظره مواجه شد.', true, batchId, error);
  }

  private async failJob(
    job: JobRow,
    errorCode: string,
    errorMessage: string,
    retryable: boolean,
    batchId: number,
    cause?: unknown,
  ): Promise<void> {
    const retryDelay = computeRetryDelayMs(job.attempt);
    const nextAttemptAt = retryable ? new Date(Date.now() + retryDelay) : null;
    await jobService.markFailed(job.id, errorCode, errorMessage, {
      retryable,
      nextAttemptAt,
    });
    // Reflect the outcome on the audio row: permanently failed audios are
    // terminal FAILED; retryable failures go back to QUEUED until the retry.
    await getDatabase()
      .update(audioFiles)
      .set({ status: retryable ? 'QUEUED' : 'FAILED', updatedAt: new Date() })
      .where(eq(audioFiles.id, job.entityId));
    console.error(`[worker] job ${job.id} failed`, {
      batchId,
      jobId: job.id,
      audioId: job.entityId,
      operation: 'transcription',
      errorCode,
      err: cause ?? errorCode,
    });
    await batchService.refreshBatchState(batchId);
  }

  /** Complete the job without a Gemini call when a valid transcript exists. */
  private async finalizeWithoutCall(job: JobRow, audioId: number, batchId: number): Promise<void> {
    const db = getDatabase();
    await db.transaction(async (tx) => {
      await tx
        .update(audioFiles)
        .set({ status: 'TRANSCRIBED', updatedAt: new Date() })
        .where(eq(audioFiles.id, audioId));
      await jobService.markCompleted(job.id, tx);
    });
    await batchService.refreshBatchState(batchId);
  }

  private async detectTranscriptDuplicate(normalizedHash: string, ownAudioId: number): Promise<number | null> {
    const db = getDatabase();
    const row = await db
      .select({ id: transcripts.id })
      .from(transcripts)
      .where(and(eq(transcripts.normalizedHash, normalizedHash), eq(transcripts.status, 'COMPLETED')))
      .limit(1)
      .get();
    if (!row) return null;
    // Never mark a transcript as a duplicate of itself.
    const own = await db
      .select({ id: transcripts.id })
      .from(transcripts)
      .where(eq(transcripts.audioId, ownAudioId))
      .get();
    return row.id === own?.id ? null : row.id;
  }

  private async recordUsage(
    batchId: number,
    jobId: number | null,
    audioId: number | null,
    modelId: string | null,
    usage: GeminiUsage | null,
    durationMs: number | null,
    status: ApiUsageStatus,
    errorCode: string | null,
  ): Promise<void> {
    await this.insertUsage(
      getDatabase(),
      batchId,
      jobId,
      audioId,
      modelId,
      usage,
      durationMs,
      status,
      errorCode,
    );
  }

  private async insertUsage(
    db: DbExecutor,
    batchId: number,
    jobId: number | null,
    audioId: number | null,
    modelId: string | null,
    usage: GeminiUsage | null,
    durationMs: number | null,
    status: ApiUsageStatus,
    errorCode: string | null,
  ): Promise<void> {
    await db.insert(apiUsage).values({
      batchId,
      jobId,
      audioId,
      stage: 'TRANSCRIPTION',
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
        const job = await jobService.claimNextJob('TRANSCRIPTION');
        if (!job) break;
        this.activeCount += 1;
        void this.processJob(job)
          .catch((error) => {
            console.error('[worker] unhandled job error', { jobId: job.id, err: error });
          })
          .finally(() => {
            this.activeCount -= 1;
          });
      }
    } catch (error) {
      console.error('[worker] poll error', { err: error });
    }
  }
}

export const transcriptionWorker = new TranscriptionWorker();
