import type {
  AudioFileInfo,
  BatchDetailResponse,
  BatchProgress,
  BatchStats,
  BatchStatus,
  BatchSummary,
  ScanResult,
  StageProgress,
} from '@freebuff/contracts';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDatabase } from '../core/database/client.js';
import {
  audioFiles,
  batches,
  jobs,
  knowledgeItems,
  transcriptDestinations,
  transcripts,
} from '../core/database/schema.js';
import { audioIngestionService } from './audio-ingestion.service.js';
import { candidatesService } from './knowledge/candidates.service.js';
import { DomainError } from './errors.js';
import { jobService } from './jobs.service.js';
import { getWorkspaceAudioDir } from './workspace-paths.js';
import { pipelinePreflightService } from './pipeline-preflight.service.js';

const MESSAGES = {
  notFound: 'Batch پیدا نشد.',
  database: 'خطا در ذخیره Batch. دوباره تلاش کنید.',
  scan: 'خطا در Scan پوشه صوتی. دوباره تلاش کنید.',
} as const;

const STAGE_BY_STATUS: Partial<Record<BatchStatus, string>> = {
  PROCESSING: 'TRANSCRIPTION',
  TRANSCRIBING: 'TRANSCRIPTION',
  ANALYZING: 'KNOWLEDGE_ANALYSIS',
  DELTA_PROCESSING: 'DELTA_ANALYSIS',
  RECONCILING: 'RECONCILIATION',
  KNOWLEDGE_READY: 'KNOWLEDGE_READY',
  ANALYSIS_COMPLETED: 'KNOWLEDGE_READY',
  GENERATING_CONTENT: 'CONTENT_GENERATION',
  COMPLETED: 'COMPLETED',
  PARTIAL_FAILED: 'PARTIAL_FAILED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
};

/** Human stage label of a batch status (Phase 12 §5). */
export function currentStageOf(status: BatchStatus): string | null {
  return STAGE_BY_STATUS[status] ?? null;
}

/** Real per-stage progress of a batch, derived only from database counts. */
async function computeProgress(batchId: number): Promise<BatchProgress> {
  const db = getDatabase();
  const countByTypeStatus = async (jobType: string): Promise<{ done: number; total: number }> => {
    const rows = await db
      .select({ status: jobs.status, count: sql<number>`count(${jobs.id})` })
      .from(jobs)
      .where(and(eq(jobs.batchId, batchId), eq(jobs.jobType, jobType)))
      .groupBy(jobs.status);
    let done = 0;
    let total = 0;
    for (const row of rows) {
      const count = Number(row.count);
      total += count;
      if (row.status === 'COMPLETED') done += count;
    }
    return { done, total };
  };

  const audio = await db
    .select({ status: audioFiles.status, count: sql<number>`count(${audioFiles.id})` })
    .from(audioFiles)
    .where(eq(audioFiles.batchId, batchId))
    .groupBy(audioFiles.status);
  let audioTotal = 0;
  let audioDone = 0;
  for (const row of audio) {
    const count = Number(row.count);
    if (row.status === 'REGISTERED' || row.status === 'QUEUED' || row.status === 'TRANSCRIBING' || row.status === 'TRANSCRIBED' || row.status === 'FAILED') {
      audioTotal += count;
      if (row.status === 'TRANSCRIBED') audioDone += count;
    }
  }

  const transcription = await countByTypeStatus('TRANSCRIPTION');
  const knowledge = await countByTypeStatus('KNOWLEDGE_ANALYSIS');
  const delta = await countByTypeStatus('KNOWLEDGE_DELTA');
  const reconciliation = await countByTypeStatus('KNOWLEDGE_RECONCILIATION');
  const content = await countByTypeStatus('CONTENT_GENERATION');

  const sp = (p: { done: number; total: number }): StageProgress => ({ done: p.done, total: p.total });
  return {
    audio: { done: audioDone, total: audioTotal },
    transcription: sp(transcription),
    knowledge: sp(knowledge),
    delta: sp(delta),
    reconciliation: sp(reconciliation),
    content: sp(content),
  };
}

/** Compute per-batch statistics from the database. */
async function computeStats(batchId: number): Promise<BatchStats> {
  const db = getDatabase();
  const totalAudio = await db
    .select({ count: sql<number>`count(${audioFiles.id})` })
    .from(audioFiles)
    .where(eq(audioFiles.batchId, batchId))
    .get();

  const countBy = async (status: string): Promise<number> => {
    const row = await db
      .select({ count: sql<number>`count(${audioFiles.id})` })
      .from(audioFiles)
      .where(and(eq(audioFiles.batchId, batchId), eq(audioFiles.status, status)))
      .get();
    return Number(row?.count ?? 0);
  };

  const queuedJobs = await jobService.countByStatus(batchId, 'PENDING');
  const knowledgePending = await jobService.countByTypeStatus(batchId, 'KNOWLEDGE_ANALYSIS', 'PENDING');
  const knowledgeAnalyzing = await jobService.countByTypeStatus(batchId, 'KNOWLEDGE_ANALYSIS', 'RUNNING');
  const knowledgeAnalyzed = await jobService.countByTypeStatus(batchId, 'KNOWLEDGE_ANALYSIS', 'COMPLETED');

  // Distinct destinations detected in this batch's transcripts.
  const detectedDestinations = await db
    .select({ count: sql<number>`count(distinct ${transcriptDestinations.destinationId})` })
    .from(transcriptDestinations)
    .innerJoin(transcripts, eq(transcripts.id, transcriptDestinations.transcriptId))
    .innerJoin(audioFiles, eq(audioFiles.id, transcripts.audioId))
    .where(eq(audioFiles.batchId, batchId))
    .get();

  // Knowledge items whose first batch is this one.
  const extractedKnowledge = await db
    .select({ count: sql<number>`count(${knowledgeItems.id})` })
    .from(knowledgeItems)
    .where(eq(knowledgeItems.firstSeenBatchId, batchId))
    .get();

  // Delta phase: candidates + KNOWLEDGE_DELTA jobs.
  const candidateCounts = await candidatesService.countByBatchStatus(batchId);
  const deltaPending = await jobService.countByTypeStatus(batchId, 'KNOWLEDGE_DELTA', 'PENDING');
  const deltaComparing = await jobService.countByTypeStatus(batchId, 'KNOWLEDGE_DELTA', 'RUNNING');
  const deltaDecided = await jobService.countByTypeStatus(batchId, 'KNOWLEDGE_DELTA', 'COMPLETED');
  const deltaFailed = await jobService.countByTypeStatus(batchId, 'KNOWLEDGE_DELTA', 'FAILED');

  // Reconciliation phase: KNOWLEDGE_RECONCILIATION jobs (Phase 10).
  const reconcilePending = await jobService.countByTypeStatus(batchId, 'KNOWLEDGE_RECONCILIATION', 'PENDING');
  const reconcileRunning = await jobService.countByTypeStatus(batchId, 'KNOWLEDGE_RECONCILIATION', 'RUNNING');
  const reconcileCompleted = await jobService.countByTypeStatus(batchId, 'KNOWLEDGE_RECONCILIATION', 'COMPLETED');
  const reconcileFailed = await jobService.countByTypeStatus(batchId, 'KNOWLEDGE_RECONCILIATION', 'FAILED');

  // Content phase: CONTENT_GENERATION jobs (Phase 11).
  const contentPending = await jobService.countByTypeStatus(batchId, 'CONTENT_GENERATION', 'PENDING');
  const contentGenerating = await jobService.countByTypeStatus(batchId, 'CONTENT_GENERATION', 'RUNNING');
  const contentGenerated = await jobService.countByTypeStatus(batchId, 'CONTENT_GENERATION', 'COMPLETED');
  const contentFailed = await jobService.countByTypeStatus(batchId, 'CONTENT_GENERATION', 'FAILED');

  return {
    totalAudio: Number(totalAudio?.count ?? 0),
    newAudio: (await countBy('QUEUED')) + (await countBy('REGISTERED')) + (await countBy('TRANSCRIBING')) + (await countBy('TRANSCRIBED')),
    duplicates: await countBy('DUPLICATE'),
    queuedJobs,
    transcribing: await countBy('TRANSCRIBING'),
    transcribed: await countBy('TRANSCRIBED'),
    failedItems: await countBy('FAILED'),
    knowledgePending,
    knowledgeAnalyzing,
    knowledgeAnalyzed,
    detectedDestinations: Number(detectedDestinations?.count ?? 0),
    extractedKnowledge: Number(extractedKnowledge?.count ?? 0),
    candidatesPending: candidateCounts.PENDING,
    candidatesDecided: candidateCounts.DECIDED,
    candidatesFailed: candidateCounts.FAILED,
    deltaPending,
    deltaComparing,
    deltaDecided,
    deltaFailed,
    reconcilePending,
    reconcileRunning,
    reconcileCompleted,
    reconcileFailed,
    contentPending,
    contentGenerating,
    contentGenerated,
    contentFailed,
  };
}

const EMPTY_PROGRESS: BatchProgress = {
  audio: { done: 0, total: 0 },
  transcription: { done: 0, total: 0 },
  knowledge: { done: 0, total: 0 },
  delta: { done: 0, total: 0 },
  reconciliation: { done: 0, total: 0 },
  content: { done: 0, total: 0 },
};

function toSummary(
  row: typeof batches.$inferSelect,
  stats: BatchStats,
  progress: BatchProgress = EMPTY_PROGRESS,
): BatchSummary {
  const status = row.status as BatchStatus;
  return {
    id: row.id,
    status,
    currentStage: currentStageOf(status),
    progress,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    stats,
  };
}

/** Batch lifecycle: creation, scanning, registration, and state calculation. */
export class BatchService {
  async createBatch(): Promise<BatchSummary> {
    const db = getDatabase();
    const now = new Date();
    try {
      const inserted = await db
        .insert(batches)
        .values({ status: 'CREATED', createdAt: now, updatedAt: now })
        .returning({ id: batches.id, status: batches.status, createdAt: batches.createdAt, updatedAt: batches.updatedAt });
      const row = inserted[0];
      if (!row) throw new Error('batch insert returned no row');
      return toSummary(
        { ...row, startedAt: null, completedAt: null },
        {
          totalAudio: 0,
          newAudio: 0,
          duplicates: 0,
          queuedJobs: 0,
          transcribing: 0,
          transcribed: 0,
          failedItems: 0,
          knowledgePending: 0,
          knowledgeAnalyzing: 0,
          knowledgeAnalyzed: 0,
          detectedDestinations: 0,
          extractedKnowledge: 0,
          candidatesPending: 0,
          candidatesDecided: 0,
          candidatesFailed: 0,
          deltaPending: 0,
          deltaComparing: 0,
          deltaDecided: 0,
          deltaFailed: 0,
          reconcilePending: 0,
          reconcileRunning: 0,
          reconcileCompleted: 0,
          reconcileFailed: 0,
          contentPending: 0,
          contentGenerating: 0,
          contentGenerated: 0,
          contentFailed: 0,
        },
      );
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('DATABASE_ERROR', MESSAGES.database, { cause: error });
    }
  }

  /**
   * Scan the workspace audio folder and register everything for this batch.
   * Idempotent: re-scanning the same batch never re-registers files or
   * recreates jobs. Runs in a single transaction.
   */
  async scanBatch(
    batchId: number,
    logger?: { error(obj: Record<string, unknown>, msg: string): void },
  ): Promise<BatchSummary> {
    const db = getDatabase();
    await this.requireBatch(batchId);
    const now = new Date();

    await db
      .update(batches)
      .set({ status: 'SCANNING', startedAt: now, updatedAt: now })
      .where(eq(batches.id, batchId));

    const result: ScanResult = {
      discoveredFiles: 0,
      newAudio: 0,
      duplicates: 0,
      unsupported: 0,
      queuedJobs: 0,
    };

    try {
      const audioDir = await getWorkspaceAudioDir();
      const discovered = await audioIngestionService.discoverFiles(audioDir);
      result.discoveredFiles = discovered.length;

      // Hashing is I/O-bound — do it before opening the transaction.
      const hashed = new Map<string, { file: (typeof discovered)[number]; sha256: string | null; error: unknown }>();
      for (const file of discovered) {
        try {
          const sha256 = await audioIngestionService.calculateHash(file.absolutePath);
          hashed.set(file.absolutePath, { file, sha256, error: null });
        } catch (error) {
          hashed.set(file.absolutePath, { file, sha256: null, error });
        }
      }

      await db.transaction(async (tx) => {
        const seenInBatch = new Map<string, number>();
        const registeredPaths = new Set<string>();

        const existingRows = await tx.select().from(audioFiles).where(eq(audioFiles.batchId, batchId));
        for (const row of existingRows) {
          seenInBatch.set(row.sha256, row.id);
          registeredPaths.add(row.absolutePath);
        }

        for (const { file, sha256, error } of hashed.values()) {
          if (registeredPaths.has(file.absolutePath)) continue;

          if (error !== null || sha256 === null) {
            // Controlled failure: record the file as failed, never crash the scan.
            const audioId = await audioIngestionService.insertAudio(
              {
                batchId,
                absolutePath: file.absolutePath,
                originalName: file.originalName,
                extension: file.extension,
                mimeType: file.mimeType,
                fileSize: file.fileSize,
                sha256: '',
                status: 'FAILED',
              },
              tx,
            );
            registeredPaths.add(file.absolutePath);
            logger?.error(
              { batchId, audioId, operation: 'scan', fileName: file.originalName, err: error },
              'Failed to hash audio file during scan',
            );
            continue;
          }

          if (seenInBatch.has(sha256)) continue;

          const duplicateOf = await audioIngestionService.detectDuplicate(sha256, tx);
          if (duplicateOf !== null) {
            const audioId = await audioIngestionService.insertAudio(
              {
                batchId,
                absolutePath: file.absolutePath,
                originalName: file.originalName,
                extension: file.extension,
                mimeType: file.mimeType,
                fileSize: file.fileSize,
                sha256,
                status: 'DUPLICATE',
                duplicateOfAudioId: duplicateOf,
              },
              tx,
            );
            seenInBatch.set(sha256, audioId);
            registeredPaths.add(file.absolutePath);
            result.duplicates += 1;
            continue;
          }

          const audioId = await audioIngestionService.insertAudio(
            {
              batchId,
              absolutePath: file.absolutePath,
              originalName: file.originalName,
              extension: file.extension,
              mimeType: file.mimeType,
              fileSize: file.fileSize,
              sha256,
              status: 'REGISTERED',
            },
            tx,
          );
          seenInBatch.set(sha256, audioId);
          registeredPaths.add(file.absolutePath);

          // Exactly one transcription job per new audio file.
          const { created } = await jobService.createJob(
            {
              batchId,
              jobType: 'TRANSCRIPTION',
              entityId: audioId,
              idempotencyKey: `TRANSCRIPTION:${audioId}`,
            },
            tx,
          );
          if (created) result.queuedJobs += 1;
          await audioIngestionService.markQueued(audioId, tx);
          result.newAudio += 1;
        }
      });

      const finalStatus = await this.calculateBatchState(batchId);
      await db
        .update(batches)
        .set({ status: finalStatus, completedAt: new Date(), updatedAt: new Date() })
        .where(eq(batches.id, batchId));

      return this.getBatch(batchId);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      await db
        .update(batches)
        .set({ status: 'FAILED', completedAt: new Date(), updatedAt: new Date() })
        .where(eq(batches.id, batchId));
      throw new DomainError('BATCH_SCAN_ERROR', MESSAGES.scan, { cause: error });
    }
  }

  /**
   * Derive the batch state from its registered files and jobs.
   * No new files (only duplicates/nothing) → COMPLETED; new files with
   * pending jobs → READY (awaiting start).
   */
  async calculateBatchState(batchId: number): Promise<BatchStatus> {
    const stats = await computeStats(batchId);
    if (stats.failedItems > 0 && stats.newAudio === 0) return 'FAILED';
    if (stats.newAudio === 0) return 'COMPLETED';
    return 'READY';
  }

  /**
   * Recompute and persist the batch state after worker progress.
   * Phase-aware: TRANSCRIBING while transcription jobs run, ANALYZING while
   * knowledge jobs run; when everything is terminal the batch settles to
   * ANALYSIS_COMPLETED / COMPLETED / PARTIAL_FAILED / FAILED.
   */
  async refreshBatchState(batchId: number): Promise<BatchStatus> {
    const db = getDatabase();
    const current = await db
      .select({ status: batches.status })
      .from(batches)
      .where(eq(batches.id, batchId))
      .get();
    // CANCELLED is terminal: an in-flight job finishing after a cancel must
    // not resurrect the batch (Phase 12 §36).
    if (current?.status === 'CANCELLED') {
      return 'CANCELLED';
    }
    const stats = await computeStats(batchId);
    const counts = await this.jobStatusCounts(batchId);
    const knowledge = {
      pending: await jobService.countByTypeStatus(batchId, 'KNOWLEDGE_ANALYSIS', 'PENDING'),
      running: await jobService.countByTypeStatus(batchId, 'KNOWLEDGE_ANALYSIS', 'RUNNING'),
      completed: await jobService.countByTypeStatus(batchId, 'KNOWLEDGE_ANALYSIS', 'COMPLETED'),
      failed: await jobService.countByTypeStatus(batchId, 'KNOWLEDGE_ANALYSIS', 'FAILED'),
    };
    const knowledgeTotal = knowledge.pending + knowledge.running + knowledge.completed + knowledge.failed;
    const delta = {
      pending: await jobService.countByTypeStatus(batchId, 'KNOWLEDGE_DELTA', 'PENDING'),
      running: await jobService.countByTypeStatus(batchId, 'KNOWLEDGE_DELTA', 'RUNNING'),
      completed: await jobService.countByTypeStatus(batchId, 'KNOWLEDGE_DELTA', 'COMPLETED'),
      failed: await jobService.countByTypeStatus(batchId, 'KNOWLEDGE_DELTA', 'FAILED'),
    };
    const deltaTotal = delta.pending + delta.running + delta.completed + delta.failed;
    const reconcile = {
      pending: await jobService.countByTypeStatus(batchId, 'KNOWLEDGE_RECONCILIATION', 'PENDING'),
      running: await jobService.countByTypeStatus(batchId, 'KNOWLEDGE_RECONCILIATION', 'RUNNING'),
      completed: await jobService.countByTypeStatus(batchId, 'KNOWLEDGE_RECONCILIATION', 'COMPLETED'),
      failed: await jobService.countByTypeStatus(batchId, 'KNOWLEDGE_RECONCILIATION', 'FAILED'),
    };
    const reconcileTotal = reconcile.pending + reconcile.running + reconcile.completed + reconcile.failed;
    const content = {
      pending: await jobService.countByTypeStatus(batchId, 'CONTENT_GENERATION', 'PENDING'),
      running: await jobService.countByTypeStatus(batchId, 'CONTENT_GENERATION', 'RUNNING'),
      completed: await jobService.countByTypeStatus(batchId, 'CONTENT_GENERATION', 'COMPLETED'),
      failed: await jobService.countByTypeStatus(batchId, 'CONTENT_GENERATION', 'FAILED'),
    };
    const contentTotal = content.pending + content.running + content.completed + content.failed;

    let status: BatchStatus;
    if (stats.newAudio === 0) {
      // Nothing processable: all duplicates/empty (COMPLETED), or only
      // permanently failed files (FAILED).
      status = stats.failedItems > 0 ? 'FAILED' : 'COMPLETED';
    } else if (counts.PENDING > 0 || counts.RUNNING > 0) {
      // In progress — distinguish the active phase.
      if (delta.pending + delta.running > 0) {
        status = 'DELTA_PROCESSING';
      } else if (reconcile.pending + reconcile.running > 0) {
        status = 'RECONCILING';
      } else if (content.pending + content.running > 0) {
        status = 'GENERATING_CONTENT';
      } else if (knowledge.pending + knowledge.running > 0) {
        status = 'ANALYZING';
      } else {
        status = 'TRANSCRIBING';
      }
    } else if (contentTotal > 0) {
      // Content phase is terminal. Clean run → COMPLETED (§36–37); any
      // permanently failed content job makes the batch partial.
      if (content.failed > 0) {
        status = content.completed > 0 || reconcile.completed > 0 ? 'PARTIAL_FAILED' : 'FAILED';
      } else if (stats.failedItems > 0 || counts.FAILED > 0) {
        status = 'PARTIAL_FAILED';
      } else {
        status = 'COMPLETED';
      }
    } else if (reconcileTotal > 0) {
      // Reconciliation phase is terminal. Any failed job makes the batch
      // partial; a clean run is KNOWLEDGE_READY (§42).
      if (reconcile.failed > 0) {
        status = reconcile.completed > 0 || delta.completed > 0 || knowledge.completed > 0 ? 'PARTIAL_FAILED' : 'FAILED';
      } else if (stats.failedItems > 0 || counts.FAILED > 0) {
        status = 'PARTIAL_FAILED';
      } else {
        status = 'KNOWLEDGE_READY';
      }
    } else if (deltaTotal > 0) {
      // Delta phase is terminal with no reconciliation jobs (no decisions).
      if (delta.failed > 0) {
        status = delta.completed > 0 || knowledge.completed > 0 ? 'PARTIAL_FAILED' : 'FAILED';
      } else if (stats.failedItems > 0 || counts.FAILED > 0) {
        status = 'PARTIAL_FAILED';
      } else {
        status = 'ANALYSIS_COMPLETED';
      }
    } else if (knowledgeTotal > 0) {
      // Knowledge phase is terminal (no delta jobs, e.g. no candidates).
      if (knowledge.failed > 0) {
        status = knowledge.completed > 0 || stats.transcribed > 0 ? 'PARTIAL_FAILED' : 'FAILED';
      } else if (stats.failedItems > 0 || counts.FAILED > 0) {
        status = 'PARTIAL_FAILED';
      } else {
        status = 'ANALYSIS_COMPLETED';
      }
    } else if (counts.COMPLETED > 0 && counts.FAILED > 0) {
      status = 'PARTIAL_FAILED';
    } else if (counts.FAILED > 0) {
      status = 'FAILED';
    } else {
      status = 'COMPLETED';
    }

    const terminal = ['COMPLETED', 'ANALYSIS_COMPLETED', 'KNOWLEDGE_READY', 'PARTIAL_FAILED', 'FAILED', 'CANCELLED'].includes(status);
    await db
      .update(batches)
      .set({
        status,
        completedAt: terminal ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(batches.id, batchId));
    return status;
  }

  /**
   * Mark a READY batch as PROCESSING and return it (worker picks it up).
   * Refuses to start when the pipeline configuration is incomplete (Phase 12
   * §11–12) so permanent configuration failures never enter the job engine.
   */
  async startBatch(batchId: number): Promise<BatchDetailResponse> {
    const batch = await this.requireBatch(batchId);
    if (batch.status === 'CREATED') {
      throw new DomainError('BATCH_NOT_STARTABLE', 'ابتدا پوشه صوتی Scan شود.');
    }
    if (batch.status !== 'READY' && batch.status !== 'PROCESSING') {
      throw new DomainError(
        'BATCH_NOT_STARTABLE',
        'این Batch در وضعیتی نیست که بتوان پردازش را شروع کرد.',
      );
    }
    const preflight = await pipelinePreflightService.checkPreflight();
    if (!preflight.ready) {
      const first = preflight.issues[0];
      const message =
        first !== undefined
          ? `پیکربندی کامل نیست: ${first.message}`
          : 'پیکربندی کامل نیست؛ ابتدا تنظیمات را تکمیل کنید.';
      throw new DomainError('PIPELINE_NOT_READY', message);
    }
    const db = getDatabase();
    await db
      .update(batches)
      .set({
        status: 'PROCESSING',
        startedAt: batch.startedAt ?? new Date(),
        updatedAt: new Date(),
      })
      .where(eq(batches.id, batchId));
    return this.getBatch(batchId);
  }

  private async jobStatusCounts(batchId: number): Promise<{
    PENDING: number;
    RUNNING: number;
    COMPLETED: number;
    FAILED: number;
    CANCELLED: number;
  }> {
    const db = getDatabase();
    const rows = await db
      .select({ status: jobs.status, count: sql<number>`count(${jobs.id})` })
      .from(jobs)
      .where(eq(jobs.batchId, batchId))
      .groupBy(jobs.status);
    const counts = { PENDING: 0, RUNNING: 0, COMPLETED: 0, FAILED: 0, CANCELLED: 0 };
    for (const row of rows) {
      counts[row.status as keyof typeof counts] = Number(row.count);
    }
    return counts;
  }

  async getBatch(batchId: number): Promise<BatchDetailResponse> {
    const batch = await this.requireBatch(batchId);
    const stats = await computeStats(batchId);
    const db = getDatabase();
    const rows = await db
      .select()
      .from(audioFiles)
      .where(eq(audioFiles.batchId, batchId))
      .orderBy(audioFiles.id);

    // Join each audio's transcription job (attempt + status) and transcript flag.
    const audioJobs = await db
      .select({
        entityId: jobs.entityId,
        status: jobs.status,
        attempt: jobs.attempt,
      })
      .from(jobs)
      .where(eq(jobs.batchId, batchId));
    const jobByEntity = new Map(audioJobs.map((job) => [job.entityId, job]));

    const transcriptIds = new Set(
      (
        await db
          .select({ audioId: transcripts.audioId })
          .from(transcripts)
          .where(eq(transcripts.status, 'COMPLETED'))
      ).map((row) => row.audioId),
    );

    const audio: AudioFileInfo[] = rows.map((row) => {
      const job = jobByEntity.get(row.id);
      return {
        id: row.id,
        originalName: row.originalName,
        size: row.fileSize,
        status: row.status as AudioFileInfo['status'],
        duplicateOfAudioId: row.duplicateOfAudioId,
        createdAt: row.createdAt.toISOString(),
        attempt: job?.attempt ?? 0,
        jobStatus: (job?.status as AudioFileInfo['jobStatus']) ?? null,
        hasTranscript: transcriptIds.has(row.id),
      };
    });

    return { ...toSummary(batch, stats, await computeProgress(batchId)), audio };
  }

  async listBatches(): Promise<BatchSummary[]> {
    const db = getDatabase();
    const rows = await db.select().from(batches).orderBy(desc(batches.id));
    const summaries: BatchSummary[] = [];
    for (const row of rows) {
      summaries.push(toSummary(row, await computeStats(row.id), await computeProgress(row.id)));
    }
    return summaries;
  }

  /**
   * Retry every permanently-failed job of a batch (Phase 12 §9–10). Failed
   * audio rows go back to QUEUED so the UI reflects the new attempt; the
   * batch reopens as PROCESSING so workers pick the jobs up again. Never
   * touches COMPLETED jobs, master knowledge, or content history.
   */
  async retryFailedJobs(batchId: number): Promise<{ retriedJobs: number; retriedAudios: number; status: BatchStatus }> {
    const batch = await this.requireBatch(batchId);
    if (batch.status === 'CANCELLED') {
      throw new DomainError('BATCH_NOT_STARTABLE', 'این Batch لغو شده است و قابل Retry نیست.');
    }
    const db = getDatabase();
    const now = new Date();

    const failedJobs = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.batchId, batchId), eq(jobs.status, 'FAILED')));
    const retryableTypes = new Set([
      'TRANSCRIPTION',
      'KNOWLEDGE_ANALYSIS',
      'KNOWLEDGE_DELTA',
      'KNOWLEDGE_RECONCILIATION',
      'CONTENT_GENERATION',
    ]);
    const toRetry = failedJobs.filter((job) => retryableTypes.has(job.jobType));
    if (toRetry.length > 0) {
      await db
        .update(jobs)
        .set({
          status: 'PENDING',
          attempt: 0,
          errorCode: null,
          errorMessage: null,
          lockedAt: null,
          nextAttemptAt: null,
          completedAt: null,
          updatedAt: now,
        })
        .where(inArray(jobs.id, toRetry.map((job) => job.id)));
    }

    // Failed audio files become QUEUED again so their transcription job (now
    // PENDING) is picked up and the UI shows a fresh attempt.
    const failedAudios = await db
      .select({ id: audioFiles.id })
      .from(audioFiles)
      .where(and(eq(audioFiles.batchId, batchId), eq(audioFiles.status, 'FAILED')));
    const audioIds = failedAudios.map((row) => row.id);
    if (audioIds.length > 0) {
      await db
        .update(audioFiles)
        .set({ status: 'QUEUED', updatedAt: now })
        .where(inArray(audioFiles.id, audioIds));
    }

    // Nothing failed → no-op; never reopen a clean/terminal batch.
    if (toRetry.length === 0 && audioIds.length === 0) {
      return {
        retriedJobs: 0,
        retriedAudios: 0,
        status: batch.status as BatchStatus,
      };
    }

    // Reopen the batch so workers can claim the requeued jobs.
    await db
      .update(batches)
      .set({ status: 'PROCESSING', completedAt: null, updatedAt: now })
      .where(eq(batches.id, batchId));

    return {
      retriedJobs: toRetry.length,
      retriedAudios: audioIds.length,
      status: 'PROCESSING',
    };
  }

  /** Retry one failed audio: reset its audio status and requeue its job. */
  async retryAudio(batchId: number, audioId: number): Promise<{ retried: boolean; status: BatchStatus }> {
    const batch = await this.requireBatch(batchId);
    if (batch.status === 'CANCELLED') {
      throw new DomainError('BATCH_NOT_STARTABLE', 'این Batch لغو شده است و قابل Retry نیست.');
    }
    const db = getDatabase();
    const audio = await db
      .select()
      .from(audioFiles)
      .where(and(eq(audioFiles.id, audioId), eq(audioFiles.batchId, batchId)))
      .get();
    if (!audio) {
      throw new DomainError('AUDIO_FILE_NOT_FOUND', 'فایل صوتی یافت نشد.');
    }
    if (audio.status === 'DUPLICATE' || audio.status === 'TRANSCRIBED') {
      return { retried: false, status: batch.status as BatchStatus };
    }

    const now = new Date();
    await db
      .update(audioFiles)
      .set({ status: 'QUEUED', updatedAt: now })
      .where(eq(audioFiles.id, audioId));

    const failedJob = await db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.batchId, batchId),
          eq(jobs.jobType, 'TRANSCRIPTION'),
          eq(jobs.entityId, audioId),
          eq(jobs.status, 'FAILED'),
        ),
      )
      .get();
    if (failedJob) {
      await db
        .update(jobs)
        .set({
          status: 'PENDING',
          attempt: 0,
          errorCode: null,
          errorMessage: null,
          lockedAt: null,
          nextAttemptAt: null,
          completedAt: null,
          updatedAt: now,
        })
        .where(eq(jobs.id, failedJob.id));
    } else {
      // A failed audio without a transcription job (crash edge) gets one.
      await jobService.createJob({
        batchId,
        jobType: 'TRANSCRIPTION',
        entityId: audioId,
        idempotencyKey: `TRANSCRIPTION:${audioId}`,
      });
    }

    await db
      .update(batches)
      .set({ status: 'PROCESSING', completedAt: null, updatedAt: now })
      .where(eq(batches.id, batchId));
    return { retried: true, status: 'PROCESSING' };
  }

  /**
   * Cancel a batch (Phase 12 §36): cancel pending jobs, stop new ones, keep
   * already-completed master knowledge and content intact. Running requests
   * finish; their result is applied but the batch stays CANCELLED.
   */
  async cancelBatch(batchId: number): Promise<{ cancelledJobs: number; status: BatchStatus }> {
    const batch = await this.requireBatch(batchId);
    const terminal = ['COMPLETED', 'FAILED', 'PARTIAL_FAILED', 'CANCELLED'].includes(batch.status);
    if (terminal) {
      return { cancelledJobs: 0, status: batch.status as BatchStatus };
    }
    const db = getDatabase();
    const now = new Date();
    const cancelled = await db
      .update(jobs)
      .set({ status: 'CANCELLED', lockedAt: null, updatedAt: now })
      .where(and(eq(jobs.batchId, batchId), eq(jobs.status, 'PENDING')))
      .returning({ id: jobs.id });
    await db
      .update(batches)
      .set({ status: 'CANCELLED', completedAt: now, updatedAt: now })
      .where(eq(batches.id, batchId));
    return { cancelledJobs: cancelled.length, status: 'CANCELLED' };
  }

  /** Failed jobs of a batch (actionable failures for the Batch UI). */
  async listBatchJobs(batchId: number): Promise<{
    id: number;
    jobType: string;
    entityId: number;
    status: string;
    attempt: number;
    maxAttempts: number;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: Date;
    completedAt: Date | null;
  }[]> {
    const db = getDatabase();
    await this.requireBatch(batchId);
    return db
      .select()
      .from(jobs)
      .where(and(eq(jobs.batchId, batchId), eq(jobs.status, 'FAILED')))
      .orderBy(jobs.updatedAt);
  }

  private async requireBatch(batchId: number) {
    const db = getDatabase();
    const batch = await db.select().from(batches).where(eq(batches.id, batchId)).get();
    if (!batch) {
      throw new DomainError('BATCH_NOT_FOUND', MESSAGES.notFound);
    }
    return batch;
  }
}

export const batchService = new BatchService();
