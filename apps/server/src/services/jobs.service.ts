import type { ResultSet } from '@libsql/client';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { SQLiteTransaction } from 'drizzle-orm/sqlite-core';
import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { JobStatus, JobType } from '@freebuff/contracts';
import { getClient, getDatabase } from '../core/database/client.js';
import { jobs, type JobRow } from '../core/database/schema.js';
import { DomainError } from './errors.js';

type Schema = typeof import('../core/database/schema.js');

/** Accepts either the app database or a live transaction handle. */
export type DbExecutor =
  | LibSQLDatabase<Schema>
  | SQLiteTransaction<'async', ResultSet, Schema, ExtractTablesWithRelations<Schema>>;

const MESSAGES = {
  database: 'خطا در ثبت Job. دوباره تلاش کنید.',
} as const;

export interface CreateJobInput {
  batchId: number;
  jobType: JobType;
  /** The domain entity this job processes (e.g. an audio file id). */
  entityId: number;
  /** Stable key making creation idempotent across scans/restarts. */
  idempotencyKey: string;
  maxAttempts?: number;
}

/**
 * Persistent job queue stored in SQLite. No external queue; worker execution
 * (Phase 7+) will consume jobs via getPendingJobs/markRunning.
 */
export class JobService {
  /**
   * Create a job unless one with the same idempotency key already exists.
   * Returns the existing row in that case — idempotent by construction.
   */
  async createJob(
    input: CreateJobInput,
    db: DbExecutor = getDatabase(),
  ): Promise<{ id: number; created: boolean }> {
    const now = new Date();
    try {
      const existing = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(eq(jobs.idempotencyKey, input.idempotencyKey))
        .get();
      if (existing) {
        return { id: existing.id, created: false };
      }
      const inserted = await db
        .insert(jobs)
        .values({
          batchId: input.batchId,
          jobType: input.jobType,
          entityId: input.entityId,
          status: 'PENDING',
          attempt: 0,
          maxAttempts: input.maxAttempts ?? 3,
          idempotencyKey: input.idempotencyKey,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: jobs.idempotencyKey })
        .returning({ id: jobs.id });
      if (inserted[0] !== undefined) {
        return { id: inserted[0].id, created: true };
      }
      // A concurrent insert won the race — return the existing job.
      const again = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(eq(jobs.idempotencyKey, input.idempotencyKey))
        .get();
      return { id: again?.id ?? -1, created: false };
    } catch (error) {
      throw new DomainError('JOB_CREATION_ERROR', MESSAGES.database, { cause: error });
    }
  }

  /** Pending jobs that are due (next_attempt_at passed or not set). */
  async getPendingJobs(limit = 10): Promise<JobRow[]> {
    const db = getDatabase();
    return db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.status, 'PENDING'),
          or(isNull(jobs.nextAttemptAt), lte(jobs.nextAttemptAt, new Date())),
        ),
      )
      .limit(limit);
  }

  async getJob(jobId: number): Promise<JobRow | null> {
    const db = getDatabase();
    const row = await db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    return row ?? null;
  }

  /**
   * Atomically claim the next due PENDING job of a started batch, optionally
   * restricted to one job type (single UPDATE…RETURNING). Two concurrent
   * workers can never claim the same job, and jobs of unstarted batches are
   * never picked up. Active phases are PROCESSING, TRANSCRIBING and ANALYZING.
   */
  async claimNextJob(jobType?: JobType): Promise<JobRow | null> {
    const client = getClient();
    const now = Date.now();
    const result = await client.execute({
      sql: `UPDATE jobs
            SET status = 'RUNNING', locked_at = ?, started_at = ?, updated_at = ?, attempt = attempt + 1
            WHERE id = (
              SELECT j.id FROM jobs j
              INNER JOIN batches b ON b.id = j.batch_id
              WHERE j.status = 'PENDING'
                AND b.status IN ('PROCESSING', 'TRANSCRIBING', 'ANALYZING', 'DELTA_PROCESSING', 'RECONCILING')
                ${jobType ? 'AND j.job_type = ?' : ''}
                AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= ?)
              ORDER BY j.id LIMIT 1
            )
            RETURNING id`,
      args: jobType ? [now, now, now, jobType, now] : [now, now, now, now],
    });
    const claimed = result.rows[0] as { id?: number } | undefined;
    if (!claimed?.id) return null;
    return this.getJob(claimed.id);
  }

  async markRunning(jobId: number): Promise<void> {
    const db = getDatabase();
    const now = new Date();
    const current = await db
      .select({ attempt: jobs.attempt })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .get();
    await db
      .update(jobs)
      .set({
        status: 'RUNNING',
        attempt: (current?.attempt ?? 0) + 1,
        lockedAt: now,
        startedAt: now,
        updatedAt: now,
      })
      .where(eq(jobs.id, jobId));
  }

  async markCompleted(jobId: number, db: DbExecutor = getDatabase()): Promise<void> {
    await db
      .update(jobs)
      .set({
        status: 'COMPLETED',
        lockedAt: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, jobId));
  }

  /**
   * Mark a job failed. Retryable failures requeue as PENDING with an
   * exponential-backoff `next_attempt_at` until max_attempts is reached;
   * non-retryable failures become FAILED immediately.
   */
  async markFailed(
    jobId: number,
    errorCode: string,
    errorMessage: string,
    options: { retryable?: boolean; nextAttemptAt?: Date | null; db?: DbExecutor } = {},
  ): Promise<void> {
    const db = options.db ?? getDatabase();
    const current = await db
      .select({ attempt: jobs.attempt, maxAttempts: jobs.maxAttempts })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .get();
    const attempt = current?.attempt ?? 0;
    const maxAttempts = current?.maxAttempts ?? 3;
    const willRetry = (options.retryable ?? false) && attempt < maxAttempts;
    await db
      .update(jobs)
      .set({
        status: willRetry ? 'PENDING' : 'FAILED',
        lockedAt: null,
        errorCode,
        errorMessage,
        nextAttemptAt: willRetry ? (options.nextAttemptAt ?? new Date()) : null,
        completedAt: willRetry ? null : new Date(),
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, jobId));
  }

  /**
   * Return stale RUNNING jobs (e.g. from a crash) to PENDING so the next
   * worker run can pick them up. Call once at startup.
   */
  async recoverStaleJobs(): Promise<number> {
    const db = getDatabase();
    const stale = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.status, 'RUNNING'));
    if (stale.length === 0) return 0;
    const ids = stale.map((row) => row.id);
    await db
      .update(jobs)
      .set({ status: 'PENDING', lockedAt: null, nextAttemptAt: null, updatedAt: new Date() })
      .where(inArray(jobs.id, ids));
    return ids.length;
  }

  async countByStatus(batchId: number, status: JobStatus): Promise<number> {
    const db = getDatabase();
    const row = await db
      .select({ count: sql<number>`count(${jobs.id})` })
      .from(jobs)
      .where(and(eq(jobs.batchId, batchId), eq(jobs.status, status)))
      .get();
    return Number(row?.count ?? 0);
  }

  /** Count jobs of a specific type+status (e.g. KNOWLEDGE_ANALYSIS pending). */
  async countByTypeStatus(batchId: number, jobType: JobType, status: JobStatus): Promise<number> {
    const db = getDatabase();
    const row = await db
      .select({ count: sql<number>`count(${jobs.id})` })
      .from(jobs)
      .where(and(eq(jobs.batchId, batchId), eq(jobs.jobType, jobType), eq(jobs.status, status)))
      .get();
    return Number(row?.count ?? 0);
  }
}

export const jobService = new JobService();
