import type {
  ApiUsageStage,
  BatchGeneratedContentDestination,
  BatchGeneratedContentsResponse,
  BatchUsageResponse,
  DestinationContentHistoryResponse,
  GeneratedContentDetailResponse,
  GeneratedContentInfo,
  GeneratedContentKnowledgeLink,
  KnowledgeChangeType,
  UsageStageSummary,
} from '@freebuff/contracts';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { getDatabase } from '../../core/database/client.js';
import {
  apiUsage,
  batchDestinationSummaries,
  destinations,
  generatedContentKnowledge,
  generatedContents,
  knowledgeChanges,
  knowledgeVersions,
  type GeneratedContentRow,
} from '../../core/database/schema.js';

function toInfo(row: GeneratedContentRow, destinationName: string | null, knowledgeCount: number): GeneratedContentInfo {
  return {
    id: row.id,
    batchId: row.batchId,
    destinationId: row.destinationId,
    destinationName,
    content: row.content,
    modelId: row.modelId,
    promptVersionId: row.promptVersionId,
    generationNumber: row.generationNumber,
    status: row.status as GeneratedContentInfo['status'],
    deltaSignature: row.deltaSignature,
    knowledgeCount,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Read-only access to generated content (Phase 11 §46). */
export class ContentReadService {
  /** Generations grouped per destination for one batch. */
  async getBatchGeneratedContents(batchId: number): Promise<BatchGeneratedContentsResponse> {
    const db = getDatabase();
    const rows = await db
      .select()
      .from(generatedContents)
      .where(eq(generatedContents.batchId, batchId))
      .orderBy(generatedContents.destinationId, generatedContents.generationNumber);

    const destIds = [...new Set(rows.map((r) => r.destinationId).filter((id): id is number => id !== null))];
    const names = new Map<number, string>();
    if (destIds.length > 0) {
      const dRows = await db
        .select({ id: destinations.id, canonicalName: destinations.canonicalName })
        .from(destinations)
        .where(inArray(destinations.id, destIds));
      for (const row of dRows) names.set(row.id, row.canonicalName);
    }
    const counts = await this.knowledgeCounts(rows.map((r) => r.id));

    const summaryRows = await db
      .select({ destinationId: batchDestinationSummaries.destinationId })
      .from(batchDestinationSummaries)
      .where(eq(batchDestinationSummaries.batchId, batchId));
    const summarized = new Set(summaryRows.map((r) => r.destinationId));

    const byDest = new Map<number | null, GeneratedContentRow[]>();
    for (const row of rows) {
      const list = byDest.get(row.destinationId) ?? [];
      list.push(row);
      byDest.set(row.destinationId, list);
    }

    const destinationsList: BatchGeneratedContentDestination[] = [];
    for (const [destId, genRows] of byDest) {
      destinationsList.push({
        destinationId: destId,
        destinationName: destId !== null ? (names.get(destId) ?? null) : null,
        generations: genRows.map((row) => toInfo(row, destId !== null ? (names.get(destId) ?? null) : null, counts.get(row.id) ?? 0)),
        noPublishableDelta: false,
      });
    }
    // Destinations present in the batch without any generated content (no delta).
    for (const destId of summarized) {
      if (!byDest.has(destId)) {
        destinationsList.push({
          destinationId: destId,
          destinationName: names.get(destId) ?? null,
          generations: [],
          noPublishableDelta: true,
        });
      }
    }
    return { batchId, destinations: destinationsList };
  }

  /** Content history of a destination, grouped per batch (newest first). */
  async getDestinationContentHistory(destinationId: number): Promise<DestinationContentHistoryResponse> {
    const db = getDatabase();
    const rows = await db
      .select()
      .from(generatedContents)
      .where(eq(generatedContents.destinationId, destinationId))
      .orderBy(desc(generatedContents.batchId), desc(generatedContents.generationNumber));
    const counts = await this.knowledgeCounts(rows.map((r) => r.id));
    const name =
      (await db
        .select({ canonicalName: destinations.canonicalName })
        .from(destinations)
        .where(eq(destinations.id, destinationId))
        .get())?.canonicalName ?? null;

    const byBatch = new Map<number, GeneratedContentRow[]>();
    for (const row of rows) {
      const list = byBatch.get(row.batchId) ?? [];
      list.push(row);
      byBatch.set(row.batchId, list);
    }
    return {
      destinationId,
      batches: [...byBatch.entries()].map(([batchIdValue, genRows]) => ({
        batchId: batchIdValue,
        generations: genRows.map((row) => toInfo(row, name, counts.get(row.id) ?? 0)),
      })),
    };
  }

  /** Full detail: content + the exact knowledge versions it was built from. */
  async getGeneratedContentDetail(id: number): Promise<GeneratedContentDetailResponse | null> {
    const db = getDatabase();
    const row = await db.select().from(generatedContents).where(eq(generatedContents.id, id)).get();
    if (!row) return null;

    const links = await db
      .select({
        generatedContentId: generatedContentKnowledge.generatedContentId,
        knowledgeId: generatedContentKnowledge.knowledgeId,
        knowledgeVersionId: generatedContentKnowledge.knowledgeVersionId,
        changeId: generatedContentKnowledge.changeId,
        changeType: knowledgeChanges.changeType,
        canonicalText: knowledgeVersions.canonicalText,
        currentValue: knowledgeVersions.valueText,
      })
      .from(generatedContentKnowledge)
      .innerJoin(knowledgeChanges, eq(knowledgeChanges.id, generatedContentKnowledge.changeId))
      .innerJoin(knowledgeVersions, eq(knowledgeVersions.id, generatedContentKnowledge.knowledgeVersionId))
      .where(eq(generatedContentKnowledge.generatedContentId, id));

    const changeIds = links.map((l) => l.changeId);
    const oldValues = new Map<number, string | null>();
    if (changeIds.length > 0) {
      const changes = await db
        .select()
        .from(knowledgeChanges)
        .where(inArray(knowledgeChanges.id, changeIds));
      const vIds = [...new Set(changes.map((c) => c.oldVersionId).filter((v): v is number => v !== null))];
      if (vIds.length > 0) {
        const vRows = await db
          .select({ id: knowledgeVersions.id, valueText: knowledgeVersions.valueText })
          .from(knowledgeVersions)
          .where(inArray(knowledgeVersions.id, vIds));
        const byVersion = new Map(vRows.map((v) => [v.id, v.valueText]));
        for (const change of changes) {
          if (change.oldVersionId !== null) oldValues.set(change.id, byVersion.get(change.oldVersionId) ?? null);
        }
      }
    }

    const name =
      row.destinationId !== null
        ? ((await db
            .select({ canonicalName: destinations.canonicalName })
            .from(destinations)
            .where(eq(destinations.id, row.destinationId))
            .get())?.canonicalName ?? null)
        : null;

    const knowledge: GeneratedContentKnowledgeLink[] = links.map((link) => ({
      generatedContentId: link.generatedContentId,
      knowledgeId: link.knowledgeId,
      knowledgeVersionId: link.knowledgeVersionId,
      changeId: link.changeId,
      changeType: link.changeType as KnowledgeChangeType,
      canonicalText: link.canonicalText,
      currentValue: link.currentValue,
      oldValue: oldValues.get(link.changeId) ?? null,
    }));
    return {
      ...toInfo(row, name, knowledge.length),
      knowledge,
    };
  }

  /** Per-stage usage aggregates of a batch (real api_usage data only). */
  async getBatchUsage(batchId: number): Promise<BatchUsageResponse> {
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
      .where(eq(apiUsage.batchId, batchId))
      .groupBy(apiUsage.stage, apiUsage.status);
    const result: BatchUsageResponse = {};
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

  private async knowledgeCounts(ids: number[]): Promise<Map<number, number>> {
    const db = getDatabase();
    const counts = new Map<number, number>();
    if (ids.length === 0) return counts;
    const rows = await db
      .select({
        generatedContentId: generatedContentKnowledge.generatedContentId,
        count: sql<number>`count(${generatedContentKnowledge.id})`,
      })
      .from(generatedContentKnowledge)
      .where(inArray(generatedContentKnowledge.generatedContentId, ids))
      .groupBy(generatedContentKnowledge.generatedContentId);
    for (const row of rows) counts.set(row.generatedContentId, Number(row.count));
    return counts;
  }
}

export const contentReadService = new ContentReadService();
