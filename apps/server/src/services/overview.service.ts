import type {
  AllTimeUsageResponse,
  ApiUsageStage,
  BatchStatus,
  OverviewBatchInfo,
  OverviewResponse,
  UsageStageSummary,
} from '@freebuff/contracts';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { getDatabase } from '../core/database/client.js';
import {
  apiUsage,
  audioFiles,
  batches,
  generatedContents,
  knowledgeConflicts,
  knowledgeItems,
  destinations,
} from '../core/database/schema.js';
import { currentStageOf } from './batches.service.js';
import { pipelinePreflightService } from './pipeline-preflight.service.js';

const ACTIVE_STATES: BatchStatus[] = [
  'PROCESSING',
  'TRANSCRIBING',
  'ANALYZING',
  'DELTA_PROCESSING',
  'RECONCILING',
  'GENERATING_CONTENT',
];

/**
 * OverviewService (Phase 12 §28–29). Real, concise system statistics for the
 * Overview page: configuration readiness, batch processing state, destination
 * and master-knowledge totals, open conflicts, and all-time API usage. No
 * fabricated numbers or decorative charts.
 */
export class OverviewService {
  async getOverview(): Promise<OverviewResponse> {
    const db = getDatabase();

    const preflight = await pipelinePreflightService.checkPreflight();

    const [destinationsCount, masterKnowledgeCount, openConflictsCount, totalBatches] = await Promise.all([
      db.select({ count: sql<number>`count(${destinations.id})` }).from(destinations).get().then((row) => Number(row?.count ?? 0)),
      db.select({ count: sql<number>`count(${knowledgeItems.id})` }).from(knowledgeItems).get().then((row) => Number(row?.count ?? 0)),
      db
        .select({ count: sql<number>`count(${knowledgeConflicts.id})` })
        .from(knowledgeConflicts)
        .where(eq(knowledgeConflicts.status, 'OPEN'))
        .get()
        .then((row) => Number(row?.count ?? 0)),
      db.select({ count: sql<number>`count(${batches.id})` }).from(batches).get().then((row) => Number(row?.count ?? 0)),
    ]);

    const activeRows = await db
      .select({ id: batches.id })
      .from(batches)
      .where(
        sql`${batches.status} IN (${sql.join(ACTIVE_STATES.map((s) => sql`${s}`), sql`, `)})`,
      );
    const processingBatches = activeRows.length;

    const recent = await db
      .select()
      .from(batches)
      .orderBy(desc(batches.id))
      .limit(5);
    const recentBatches: OverviewBatchInfo[] = [];
    if (recent.length > 0) {
      const ids = recent.map((row) => row.id);
      const audioRows = await db
        .select({
          batchId: audioFiles.batchId,
          transcribed: sql<number>`sum(case when ${audioFiles.status} = 'TRANSCRIBED' then 1 else 0 end)`,
          total: sql<number>`count(${audioFiles.id})`,
        })
        .from(audioFiles)
        .where(inArray(audioFiles.batchId, ids))
        .groupBy(audioFiles.batchId);
      const audioByBatch = new Map(audioRows.map((row) => [row.batchId, row]));
      const contentRows = await db
        .select({
          batchId: generatedContents.batchId,
          count: sql<number>`count(${generatedContents.id})`,
        })
        .from(generatedContents)
        .where(inArray(generatedContents.batchId, ids))
        .groupBy(generatedContents.batchId);
      const contentByBatch = new Map(contentRows.map((row) => [row.batchId, Number(row.count)]));
      for (const row of recent) {
        const status = row.status as BatchStatus;
        const audio = audioByBatch.get(row.id);
        recentBatches.push({
          id: row.id,
          status,
          currentStage: currentStageOf(status),
          createdAt: row.createdAt.toISOString(),
          startedAt: row.startedAt?.toISOString() ?? null,
          completedAt: row.completedAt?.toISOString() ?? null,
          totalAudio: Number(audio?.total ?? 0),
          transcribed: Number(audio?.transcribed ?? 0),
          contentGenerated: contentByBatch.get(row.id) ?? 0,
        });
      }
    }

    // All-time usage per stage (real api_usage data).
    const usage = await this.getAllTimeUsage();

    return {
      ready: preflight.ready,
      readinessIssues: preflight.issues,
      destinationsCount,
      masterKnowledgeCount,
      openConflictsCount,
      totalBatches,
      processingBatches,
      recentBatches,
      usage,
    };
  }

  /** All-time per-stage usage aggregates across every batch. */
  async getAllTimeUsage(): Promise<AllTimeUsageResponse> {
    const db = getDatabase();
    const rows = await db
      .select({
        stage: apiUsage.stage,
        status: apiUsage.status,
        inputTokens: sql<number>`coalesce(sum(${apiUsage.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${apiUsage.outputTokens}), 0)`,
        cachedTokens: sql<number>`coalesce(sum(${apiUsage.cachedTokens}), 0)`,
        totalTokens: sql<number>`coalesce(sum(${apiUsage.totalTokens}), 0)`,
        calls: sql<number>`count(${apiUsage.id})`,
        failed: sql<number>`sum(case when ${apiUsage.status} = 'FAILED' then 1 else 0 end)`,
      })
      .from(apiUsage)
      .groupBy(apiUsage.stage, apiUsage.status);
    const result: AllTimeUsageResponse = {};
    for (const row of rows) {
      const stage = row.stage as ApiUsageStage;
      const current: UsageStageSummary = result[stage] ?? {
        calls: 0,
        failedCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
      };
      current.calls += Number(row.calls);
      current.failedCalls += Number(row.failed);
      current.inputTokens += Number(row.inputTokens);
      current.outputTokens += Number(row.outputTokens);
      current.cachedTokens += Number(row.cachedTokens);
      current.totalTokens += Number(row.totalTokens);
      result[stage] = current;
    }
    return result;
  }
}

export const overviewService = new OverviewService();
