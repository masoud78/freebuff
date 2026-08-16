import type {
  AudioFileInfo,
  BatchDetailResponse,
  BatchStats,
  BatchStatus,
  BatchSummary,
  ScanResult,
} from '@freebuff/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
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
import { DomainError } from './errors.js';
import { jobService } from './jobs.service.js';
import { getWorkspaceAudioDir } from './workspace-paths.js';

const MESSAGES = {
  notFound: 'Batch پیدا نشد.',
  database: 'خطا در ذخیره Batch. دوباره تلاش کنید.',
  scan: 'خطا در Scan پوشه صوتی. دوباره تلاش کنید.',
} as const;

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
  };
}

function toSummary(row: typeof batches.$inferSelect, stats: BatchStats): BatchSummary {
  return {
    id: row.id,
    status: row.status as BatchStatus,
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
    const stats = await computeStats(batchId);
    const counts = await this.jobStatusCounts(batchId);
    const knowledge = {
      pending: await jobService.countByTypeStatus(batchId, 'KNOWLEDGE_ANALYSIS', 'PENDING'),
      running: await jobService.countByTypeStatus(batchId, 'KNOWLEDGE_ANALYSIS', 'RUNNING'),
      completed: await jobService.countByTypeStatus(batchId, 'KNOWLEDGE_ANALYSIS', 'COMPLETED'),
      failed: await jobService.countByTypeStatus(batchId, 'KNOWLEDGE_ANALYSIS', 'FAILED'),
    };
    const knowledgeTotal = knowledge.pending + knowledge.running + knowledge.completed + knowledge.failed;

    let status: BatchStatus;
    if (stats.newAudio === 0) {
      // Nothing processable: all duplicates/empty (COMPLETED), or only
      // permanently failed files (FAILED).
      status = stats.failedItems > 0 ? 'FAILED' : 'COMPLETED';
    } else if (counts.PENDING > 0 || counts.RUNNING > 0) {
      // In progress — distinguish the active phase.
      status = knowledge.pending + knowledge.running > 0 ? 'ANALYZING' : 'TRANSCRIBING';
    } else if (knowledgeTotal > 0) {
      // Knowledge phase is terminal. Any failed audio (transcription or
      // knowledge) makes the batch partial; a clean run is ANALYSIS_COMPLETED.
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

    const terminal = ['COMPLETED', 'ANALYSIS_COMPLETED', 'PARTIAL_FAILED', 'FAILED', 'CANCELLED'].includes(status);
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

  /** Mark a READY batch as PROCESSING and return it (worker picks it up). */
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

    return { ...toSummary(batch, stats), audio };
  }

  async listBatches(): Promise<BatchSummary[]> {
    const db = getDatabase();
    const rows = await db.select().from(batches).orderBy(desc(batches.id));
    const summaries: BatchSummary[] = [];
    for (const row of rows) {
      summaries.push(toSummary(row, await computeStats(row.id)));
    }
    return summaries;
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
