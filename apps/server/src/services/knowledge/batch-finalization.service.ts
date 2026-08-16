import { eq, sql } from 'drizzle-orm';
import { getDatabase } from '../../core/database/client.js';
import { batches, jobs } from '../../core/database/schema.js';
import { batchDeltaService } from './batch-delta.service.js';

const PROCESSING_JOB_TYPES = ['TRANSCRIPTION', 'KNOWLEDGE_ANALYSIS', 'KNOWLEDGE_DELTA', 'KNOWLEDGE_RECONCILIATION'] as const;

/**
 * BatchFinalizationService (Phase 10, §41–43). When every processing job of a
 * batch is terminal, rebuilds the per-destination summaries from canonical
 * data and stamps the batch KNOWLEDGE_READY (clean) or PARTIAL_FAILED.
 * Affected destinations are always derived from the database — never from
 * memory — so a server restart can rebuild everything.
 */
export class BatchFinalizationService {
  /** Terminal states a processing job may be in. */
  private async terminalJobCounts(batchId: number): Promise<{
    total: number;
    terminal: number;
    failed: number;
  }> {
    const db = getDatabase();
    const rows = await db
      .select({ status: jobs.status, count: sql<number>`count(${jobs.id})` })
      .from(jobs)
      .where(
        sql`${jobs.batchId} = ${batchId} AND ${jobs.jobType} IN (${sql.join(
          PROCESSING_JOB_TYPES.map((t) => sql`${t}`),
          sql`, `,
        )})`,
      )
      .groupBy(jobs.status);
    let total = 0;
    let terminal = 0;
    let failed = 0;
    for (const row of rows) {
      const count = Number(row.count);
      total += count;
      if (row.status === 'COMPLETED' || row.status === 'FAILED' || row.status === 'CANCELLED') {
        terminal += count;
        if (row.status === 'FAILED') failed += count;
      }
    }
    return { total, terminal, failed };
  }

  /** Whether every processing job of the batch has reached a terminal state. */
  async isFullyTerminal(batchId: number): Promise<boolean> {
    const { total, terminal } = await this.terminalJobCounts(batchId);
    return total > 0 && terminal === total;
  }

  /**
   * Rebuild destination summaries and move the batch to its final
   * knowledge state. No-op unless all processing jobs are terminal.
   */
  async finalizeIfComplete(batchId: number): Promise<boolean> {
    const db = getDatabase();
    const batch = await db.select().from(batches).where(eq(batches.id, batchId)).get();
    if (!batch) return false;
    // Truly-final states need no further work. Knowledge-terminal states
    // (ANALYSIS_COMPLETED / PARTIAL_FAILED / KNOWLEDGE_READY) still run the
    // (idempotent) summary rebuild as a safety net after restart.
    const terminalOnly = ['COMPLETED', 'FAILED', 'CANCELLED'];
    if (terminalOnly.includes(batch.status)) return false;
    if (!(await this.isFullyTerminal(batchId))) return false;

    // Rebuild summaries from canonical data (idempotent by design).
    try {
      await batchDeltaService.rebuildBatchDestinationSummary(batchId);
    } catch (error) {
      console.error('[batch-finalization] summary rebuild failed', { batchId, err: error });
      throw error;
    }

    const { failed } = await this.terminalJobCounts(batchId);
    const status = failed > 0 ? 'PARTIAL_FAILED' : 'KNOWLEDGE_READY';
    await db
      .update(batches)
      .set({ status, completedAt: new Date(), updatedAt: new Date() })
      .where(eq(batches.id, batchId));
    return true;
  }
}

export const batchFinalizationService = new BatchFinalizationService();
