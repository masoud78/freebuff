import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDatabase } from '../../core/database/client.js';
import { jobs, knowledgeCandidates, knowledgeDeltaDecisions, type JobRow } from '../../core/database/schema.js';
import { DomainError } from '../errors.js';
import { jobService } from '../jobs.service.js';
import { settingsService } from '../settings.service.js';
import { batchService } from '../batches.service.js';
import { computeRetryDelayMs } from '../transcription/worker.js';
import { knowledgeReconciliationService } from './knowledge-reconciliation.service.js';
import { batchFinalizationService } from './batch-finalization.service.js';

const POLL_INTERVAL_MS = 2000;

/**
 * Persistent reconciliation worker (Phase 10). Purely deterministic and
 * database-driven — NO Gemini calls. Each KNOWLEDGE_RECONCILIATION job
 * applies one delta decision onto Master Knowledge inside a transaction.
 *
 * A recovery sweep at the top of each tick re-creates missing reconciliation
 * jobs for decided-but-unreconciled decisions of started batches, so a crash
 * between "decision persisted" and "job created" can never strand a decision.
 */
export class ReconciliationWorker {
  private activeCount = 0;
  private running = false;
  private timer: NodeJS.Timeout | null = null;

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

  /** Recreate missing reconciliation jobs for decided decisions (restart-safe). */
  async ensureReconciliationJobs(): Promise<number> {
    const db = getDatabase();
    const missing = await db
      .select({ decisionId: knowledgeDeltaDecisions.id, batchId: knowledgeCandidates.batchId })
      .from(knowledgeDeltaDecisions)
      .innerJoin(knowledgeCandidates, eq(knowledgeCandidates.id, knowledgeDeltaDecisions.candidateId))
      .leftJoin(jobs, sql`${jobs.idempotencyKey} = 'RECONCILE:' || ${knowledgeDeltaDecisions.id}`)
      .where(
        and(
          isNull(knowledgeDeltaDecisions.reconciledAt),
          isNull(jobs.id),
          sql`${knowledgeCandidates.batchId} IN (SELECT id FROM batches WHERE status IN ('DELTA_PROCESSING', 'RECONCILING'))`,
        ),
      )
      .limit(200);
    let created = 0;
    for (const row of missing) {
      const { created: ok } = await jobService.createJob({
        batchId: row.batchId,
        jobType: 'KNOWLEDGE_RECONCILIATION',
        entityId: row.decisionId,
        idempotencyKey: `RECONCILE:${row.decisionId}`,
      });
      if (ok) created += 1;
    }
    return created;
  }

  async processJob(job: JobRow): Promise<void> {
    const db = getDatabase();
    const decision = await db
      .select()
      .from(knowledgeDeltaDecisions)
      .where(eq(knowledgeDeltaDecisions.id, job.entityId))
      .get();
    if (!decision) {
      await this.failJob(job, 'RECONCILIATION_TARGET_NOT_FOUND', 'تصمیم دلتا یافت نشد.', false);
      return;
    }
    const candidate = await db
      .select()
      .from(knowledgeCandidates)
      .where(eq(knowledgeCandidates.id, decision.candidateId))
      .get();
    if (!candidate) {
      await this.failJob(job, 'RECONCILIATION_TARGET_NOT_FOUND', 'دانش کاندیدا یافت نشد.', false);
      return;
    }

    // Idempotent: a replay of an already-reconciled decision is a no-op.
    if (decision.reconciledAt) {
      await jobService.markCompleted(job.id);
      return;
    }

    try {
      await knowledgeReconciliationService.reconcileDecision(decision, candidate);
      await jobService.markCompleted(job.id);
      await batchService.refreshBatchState(job.batchId);
    } catch (error) {
      await this.handleExecutionError(job, error);
    }
  }

  private async handleExecutionError(job: JobRow, error: unknown): Promise<void> {
    // Permanent domain failures (missing target, version conflict, corrupt
    // data) must not loop forever — mark the job failed, never retry.
    if (error instanceof DomainError) {
      await this.failJob(job, error.code, error.message, false);
      return;
    }
    await this.failJob(
      job,
      'KNOWLEDGE_TRANSACTION_FAILED',
      'اعمال تصمیم دانش با خطای غیرمنتظره مواجه شد.',
      true,
      error,
    );
  }

  private async failJob(
    job: JobRow,
    errorCode: string,
    errorMessage: string,
    retryable: boolean,
    cause?: unknown,
  ): Promise<void> {
    const nextAttemptAt = retryable ? new Date(Date.now() + computeRetryDelayMs(job.attempt)) : null;
    await jobService.markFailed(job.id, errorCode, errorMessage, { retryable, nextAttemptAt });
    console.error(`[reconcile-worker] job ${job.id} failed`, {
      batchId: job.batchId,
      jobId: job.id,
      decisionId: job.entityId,
      operation: 'knowledge_reconciliation',
      errorCode,
      err: cause ?? errorCode,
    });
    await batchService.refreshBatchState(job.batchId);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      await this.ensureReconciliationJobs();
      const concurrency = (await settingsService.getSettings()).processingConcurrency;
      while (this.activeCount < concurrency) {
        const job = await jobService.claimNextJob('KNOWLEDGE_RECONCILIATION');
        if (!job) break;
        this.activeCount += 1;
        void this.processJob(job)
          .catch((error) => {
            console.error('[reconcile-worker] unhandled job error', { jobId: job.id, err: error });
          })
          .finally(() => {
            this.activeCount -= 1;
            void batchFinalizationService.finalizeIfComplete(job.batchId).catch((error) => {
              console.error('[reconcile-worker] finalization failed', { batchId: job.batchId, err: error });
            });
          });
      }
    } catch (error) {
      console.error('[reconcile-worker] poll error', { err: error });
    }
  }
}

export const reconciliationWorker = new ReconciliationWorker();
