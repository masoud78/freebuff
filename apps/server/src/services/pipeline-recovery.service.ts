import { sql } from 'drizzle-orm';
import { getDatabase } from '../core/database/client.js';
import { batches } from '../core/database/schema.js';
import { batchService } from './batches.service.js';
import { jobService } from './jobs.service.js';
import { batchFinalizationService } from './knowledge/batch-finalization.service.js';

/**
 * PipelineRecoveryService (Phase 12 §7–8). Runs once at startup:
 *
 * 1. Recover stale RUNNING jobs back to PENDING (job engine idempotency
 *    already prevents duplicate work — each job body is replay-safe).
 * 2. Heal batches that were mid-flight when the server stopped: recompute
 *    their state from the database and, when the knowledge phase is terminal,
 *    resume finalization (summaries + content jobs) exactly once.
 *
 * Successful work is never repeated — recovery only touches jobs that were
 * interrupted and states that were never stamped.
 */
export class PipelineRecoveryService {
  /** States that indicate the pipeline was mid-flight on shutdown. */
  private readonly ACTIVE_STATES = [
    'PROCESSING',
    'TRANSCRIBING',
    'ANALYZING',
    'DELTA_PROCESSING',
    'RECONCILING',
    'KNOWLEDGE_READY',
    'ANALYSIS_COMPLETED',
    'GENERATING_CONTENT',
  ] as const;

  async recover(): Promise<{ recoveredJobs: number; healedBatches: number; finalizedBatches: number }> {
    const recoveredJobs = await jobService.recoverStaleJobs();
    let healedBatches = 0;
    let finalizedBatches = 0;

    const db = getDatabase();
    const rows = await db
      .select({ id: batches.id, status: batches.status })
      .from(batches)
      .where(sql`${batches.status} IN (${sql.join(this.ACTIVE_STATES.map((s) => sql`${s}`), sql`, `)})`);
    for (const row of rows) {
      try {
        const status = await batchService.refreshBatchState(row.id);
        healedBatches += 1;
        // Knowledge-terminal states still need finalization (content jobs /
        // completion). Idempotent — a replay never double-creates.
        if (status === 'KNOWLEDGE_READY' || status === 'ANALYSIS_COMPLETED' || status === 'PARTIAL_FAILED') {
          const finalized = await batchFinalizationService.finalizeIfComplete(row.id);
          if (finalized) finalizedBatches += 1;
        }
      } catch (error) {
        // A single bad batch must not block startup recovery for the rest.
        console.error('[pipeline-recovery] failed to heal batch', { batchId: row.id, err: error });
      }
    }

    return { recoveredJobs, healedBatches, finalizedBatches };
  }
}

export const pipelineRecoveryService = new PipelineRecoveryService();
