import type {
  BatchDestinationSummaryInfo,
  BatchDeltaItem,
  BatchDeltaResponse,
  KnowledgeChangeType,
} from '@freebuff/contracts';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDatabase } from '../../core/database/client.js';
import {
  batchDestinationSummaries,
  destinations,
  knowledgeChanges,
  knowledgeCandidates,
  knowledgeDeltaDecisions,
  knowledgeItems,
  knowledgeVersions,
} from '../../core/database/schema.js';

/**
 * Batch Knowledge Delta (Phase 10): the publishable NEW/UPDATE master changes
 * of a batch per destination. CONFIRMATION / CONFLICT / IGNORE never appear —
 * only ACTIVE master NEW/UPDATE (PROVISIONAL excluded by default, §45).
 */
export class BatchDeltaService {
  /** Publishable delta for one destination of a batch. */
  async getDestinationDelta(
    batchId: number,
    destinationId: number | null,
  ): Promise<BatchDeltaItem[]> {
    const db = getDatabase();
    const rows = await db
      .select({
        changeId: knowledgeChanges.id,
        changeType: knowledgeChanges.changeType,
        knowledgeId: knowledgeItems.id,
        versionId: knowledgeVersions.id,
        canonicalText: knowledgeVersions.canonicalText,
        currentValue: knowledgeVersions.valueText,
        unit: knowledgeVersions.unit,
        entityName: knowledgeItems.entityName,
        attribute: knowledgeItems.attribute,
        knowledgeType: knowledgeItems.knowledgeType,
        status: knowledgeItems.status,
      })
      .from(knowledgeChanges)
      .innerJoin(knowledgeItems, eq(knowledgeItems.id, knowledgeChanges.knowledgeId))
      .innerJoin(knowledgeVersions, eq(knowledgeVersions.id, knowledgeChanges.newVersionId))
      .where(
        and(
          eq(knowledgeChanges.batchId, batchId),
          destinationId === null
            ? sql`${knowledgeChanges.destinationId} IS NULL`
            : eq(knowledgeChanges.destinationId, destinationId),
          // Publishable = ACTIVE only (conservative default, §45).
          eq(knowledgeItems.status, 'ACTIVE'),
        ),
      )
      .orderBy(knowledgeChanges.id);
    return rows.map((row) => ({
      changeId: row.changeId,
      changeType: row.changeType as KnowledgeChangeType,
      knowledgeId: row.knowledgeId,
      versionId: row.versionId,
      canonicalText: row.canonicalText,
      currentValue: row.currentValue,
      unit: row.unit,
      entityName: row.entityName,
      attribute: row.attribute,
      knowledgeType: row.knowledgeType as BatchDeltaItem['knowledgeType'],
    }));
  }

  /** All destinations touched by publishable changes in a batch. */
  async listChangedDestinations(batchId: number): Promise<number[]> {
    const db = getDatabase();
    const rows = await db
      .select({ destinationId: knowledgeChanges.destinationId })
      .from(knowledgeChanges)
      .where(eq(knowledgeChanges.batchId, batchId));
    return [...new Set(rows.map((r) => r.destinationId).filter((id): id is number => id !== null))];
  }

  /** Full publishable delta of a batch (all destinations). */
  async getBatchDelta(batchId: number): Promise<BatchDeltaResponse> {
    const destinationIds = await this.listChangedDestinations(batchId);
    const db = getDatabase();
    const destNames = new Map<number, string>();
    if (destinationIds.length > 0) {
      const rows = await db
        .select({ id: destinations.id, canonicalName: destinations.canonicalName })
        .from(destinations)
        .where(inArray(destinations.id, destinationIds));
      for (const row of rows) destNames.set(row.id, row.canonicalName);
    }
    const destinationsList: BatchDeltaResponse['destinations'] = [];
    for (const destinationId of destinationIds) {
      destinationsList.push({
        destinationId,
        destinationName: destNames.get(destinationId) ?? null,
        items: await this.getDestinationDelta(batchId, destinationId),
      });
    }
    return { batchId, destinations: destinationsList };
  }

  /** True when the batch has no publishable (ACTIVE NEW/UPDATE) changes. */
  async isPublishableDeltaEmpty(batchId: number): Promise<boolean> {
    const db = getDatabase();
    const row = await db
      .select({ count: sql<number>`count(${knowledgeChanges.id})` })
      .from(knowledgeChanges)
      .innerJoin(knowledgeItems, eq(knowledgeItems.id, knowledgeChanges.knowledgeId))
      .where(
        and(
          eq(knowledgeChanges.batchId, batchId),
          eq(knowledgeItems.status, 'ACTIVE'),
        ),
      )
      .get();
    return Number(row?.count ?? 0) === 0;
  }

  /**
   * Rebuild per-destination summaries from canonical data (retry-safe: it
   * recomputes, never increments). Affected destinations come from both
   * changes AND decisions (confirmations/conflicts/ignores count too).
   */
  async rebuildBatchDestinationSummary(batchId: number): Promise<BatchDestinationSummaryInfo[]> {
    const db = getDatabase();

    // Destination ids mentioned by this batch's changes or decisions.
    const changeRows = await db
      .select({ destinationId: knowledgeChanges.destinationId })
      .from(knowledgeChanges)
      .where(eq(knowledgeChanges.batchId, batchId));
    const decisionRows = await db
      .select({ destinationId: knowledgeCandidates.destinationId })
      .from(knowledgeCandidates)
      .innerJoin(knowledgeDeltaDecisions, eq(knowledgeDeltaDecisions.candidateId, knowledgeCandidates.id))
      .where(eq(knowledgeCandidates.batchId, batchId));
    const destinationIds = [
      ...new Set([
        ...changeRows.map((r) => r.destinationId).filter((id): id is number => id !== null),
        ...decisionRows.map((r) => r.destinationId).filter((id): id is number => id !== null),
      ]),
    ];

    const summaries: BatchDestinationSummaryInfo[] = [];
    for (const destinationId of destinationIds) {
      const changes = await db
        .select({
          changeType: knowledgeChanges.changeType,
          status: knowledgeItems.status,
        })
        .from(knowledgeChanges)
        .innerJoin(knowledgeItems, eq(knowledgeItems.id, knowledgeChanges.knowledgeId))
        .where(
          and(
            eq(knowledgeChanges.batchId, batchId),
            eq(knowledgeChanges.destinationId, destinationId),
          ),
        );
      const newCount = changes.filter((c) => c.changeType === 'NEW').length;
      const updatedCount = changes.filter((c) => c.changeType === 'UPDATE').length;
      const publishable = changes.filter((c) => c.status === 'ACTIVE').length;

      const decisionTypes = await db
        .select({ decision: knowledgeDeltaDecisions.decision })
        .from(knowledgeDeltaDecisions)
        .innerJoin(knowledgeCandidates, eq(knowledgeCandidates.id, knowledgeDeltaDecisions.candidateId))
        .where(
          and(
            eq(knowledgeCandidates.batchId, batchId),
            eq(knowledgeCandidates.destinationId, destinationId),
          ),
        );
      const confirmationCount = decisionTypes.filter((d) => d.decision === 'CONFIRMATION').length;
      const conflictCount = decisionTypes.filter((d) => d.decision === 'CONFLICT').length;
      const ignoredCount = decisionTypes.filter((d) => d.decision === 'IGNORE').length;

      const name = (
        await db
          .select({ canonicalName: destinations.canonicalName })
          .from(destinations)
          .where(eq(destinations.id, destinationId))
          .get()
      )?.canonicalName ?? `#${destinationId}`;

      const now = new Date();
      await db
        .insert(batchDestinationSummaries)
        .values({
          batchId,
          destinationId,
          newCount,
          updatedCount,
          confirmationCount,
          conflictCount,
          ignoredCount,
          publishableDeltaCount: publishable,
          status: 'FINALIZED',
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [batchDestinationSummaries.batchId, batchDestinationSummaries.destinationId],
          set: {
            newCount,
            updatedCount,
            confirmationCount,
            conflictCount,
            ignoredCount,
            publishableDeltaCount: publishable,
            status: 'FINALIZED',
            updatedAt: now,
          },
        });

      summaries.push({
        batchId,
        destinationId,
        destinationName: name,
        newCount,
        updatedCount,
        confirmationCount,
        conflictCount,
        ignoredCount,
        publishableDeltaCount: publishable,
        status: 'FINALIZED',
      });
    }
    return summaries;
  }

  /** Stored summaries for a batch (or null when not yet finalized). */
  async getBatchSummaries(batchId: number): Promise<BatchDestinationSummaryInfo[]> {
    const db = getDatabase();
    const rows = await db
      .select({
        batchId: batchDestinationSummaries.batchId,
        destinationId: batchDestinationSummaries.destinationId,
        newCount: batchDestinationSummaries.newCount,
        updatedCount: batchDestinationSummaries.updatedCount,
        confirmationCount: batchDestinationSummaries.confirmationCount,
        conflictCount: batchDestinationSummaries.conflictCount,
        ignoredCount: batchDestinationSummaries.ignoredCount,
        publishableDeltaCount: batchDestinationSummaries.publishableDeltaCount,
        status: batchDestinationSummaries.status,
        canonicalName: destinations.canonicalName,
      })
      .from(batchDestinationSummaries)
      .innerJoin(destinations, eq(destinations.id, batchDestinationSummaries.destinationId))
      .where(eq(batchDestinationSummaries.batchId, batchId))
      .orderBy(destinations.canonicalName);
    return rows.map((row) => ({
      batchId: row.batchId,
      destinationId: row.destinationId,
      destinationName: row.canonicalName,
      newCount: row.newCount,
      updatedCount: row.updatedCount,
      confirmationCount: row.confirmationCount,
      conflictCount: row.conflictCount,
      ignoredCount: row.ignoredCount,
      publishableDeltaCount: row.publishableDeltaCount,
      status: row.status,
    }));
  }
}

export const batchDeltaService = new BatchDeltaService();
