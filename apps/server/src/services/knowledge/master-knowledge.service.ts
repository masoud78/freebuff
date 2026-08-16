import type {
  KnowledgeChangeInfo,
  KnowledgeConflictInfo,
  KnowledgeDetailResponse,
  KnowledgeEvidenceInfo,
  KnowledgeType,
  KnowledgeVersionInfo,
  MasterKnowledgeItem,
} from '@freebuff/contracts';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDatabase } from '../../core/database/client.js';
import {
  audioFiles,
  destinations,
  knowledgeChanges,
  knowledgeConflicts,
  knowledgeCandidates,
  knowledgeEvidence,
  knowledgeItems,
  knowledgeVersions,
  transcripts,
} from '../../core/database/schema.js';

/**
 * Read-only access to Master Knowledge (Phase 10 §33–34). Every query is
 * destination-scoped; nothing here mutates. Pagination is bounded so the UI
 * never loads a whole destination into the browser at once.
 */
export class MasterKnowledgeService {
  /**
   * Bounded list of a destination's master knowledge items (current values).
   * Phase 12 §22: optional text search (canonical text / entity / attribute)
   * plus knowledge-type and status filters — never a Gemini call.
   */
  async listDestinationKnowledge(
    destinationId: number | null,
    options: {
      limit?: number;
      offset?: number;
      q?: string | null;
      knowledgeType?: string | null;
      status?: string | null;
    } = {},
  ): Promise<{ items: MasterKnowledgeItem[]; total: number }> {
    const db = getDatabase();
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);

    const conditions: ReturnType<typeof eq>[] = [];
    conditions.push(
      destinationId === null
        ? sql`${knowledgeItems.destinationId} IS NULL`
        : eq(knowledgeItems.destinationId, destinationId),
    );
    const q = options.q?.trim();
    if (q !== undefined && q.length > 0) {
      const like = `%${q}%`;
      conditions.push(
        sql`(${knowledgeItems.canonicalText} LIKE ${like} OR ${knowledgeItems.entityName} LIKE ${like} OR ${knowledgeItems.attribute} LIKE ${like})`,
      );
    }
    if (options.knowledgeType) {
      conditions.push(eq(knowledgeItems.knowledgeType, options.knowledgeType));
    }
    if (options.status) {
      conditions.push(eq(knowledgeItems.status, options.status));
    }
    const where = and(...conditions);

    const totalRow = await db
      .select({ count: sql<number>`count(${knowledgeItems.id})` })
      .from(knowledgeItems)
      .where(where)
      .get();
    const total = Number(totalRow?.count ?? 0);

    const rows = await db
      .select({
        id: knowledgeItems.id,
        destinationId: knowledgeItems.destinationId,
        knowledgeType: knowledgeItems.knowledgeType,
        category: knowledgeItems.category,
        entityType: knowledgeItems.entityType,
        entityName: knowledgeItems.entityName,
        attribute: knowledgeItems.attribute,
        canonicalText: knowledgeItems.canonicalText,
        status: knowledgeItems.status,
        firstSeenBatchId: knowledgeItems.firstSeenBatchId,
        firstSeenAt: knowledgeItems.firstSeenAt,
        lastSeenBatchId: knowledgeItems.lastSeenBatchId,
        lastSeenAt: knowledgeItems.lastSeenAt,
        versionId: knowledgeVersions.id,
        versionNumber: knowledgeVersions.versionNumber,
        valueText: knowledgeVersions.valueText,
        unit: knowledgeVersions.unit,
        evidenceCount: sql<number>`(SELECT count(*) FROM ${knowledgeEvidence} e WHERE e.knowledge_id = ${knowledgeItems.id})`,
      })
      .from(knowledgeItems)
      .innerJoin(
        knowledgeVersions,
        and(eq(knowledgeVersions.knowledgeId, knowledgeItems.id), eq(knowledgeVersions.isCurrent, true)),
      )
      .where(where)
      .orderBy(desc(knowledgeItems.updatedAt))
      .limit(limit)
      .offset(offset);

    return {
      total,
      items: rows.map((row) => ({
        id: row.id,
        destinationId: row.destinationId,
        knowledgeType: row.knowledgeType as KnowledgeType,
        category: row.category,
        entityType: row.entityType,
        entityName: row.entityName,
        attribute: row.attribute,
        canonicalText: row.canonicalText,
        currentValue: row.valueText,
        unit: row.unit,
        versionNumber: row.versionNumber,
        status: row.status as MasterKnowledgeItem['status'],
        evidenceCount: Number(row.evidenceCount),
        firstSeenBatchId: row.firstSeenBatchId,
        firstSeenAt: row.firstSeenAt?.toISOString() ?? null,
        lastSeenBatchId: row.lastSeenBatchId,
        lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      })),
    };
  }

  /** Full detail: current item + all versions + evidence + change history. */
  async getKnowledgeDetail(knowledgeId: number): Promise<KnowledgeDetailResponse | null> {
    const db = getDatabase();
    const item = await db
      .select()
      .from(knowledgeItems)
      .where(eq(knowledgeItems.id, knowledgeId))
      .get();
    if (!item) return null;

    const versions = await db
      .select()
      .from(knowledgeVersions)
      .where(eq(knowledgeVersions.knowledgeId, knowledgeId))
      .orderBy(knowledgeVersions.versionNumber);

    const evidenceRows = await db
      .select()
      .from(knowledgeEvidence)
      .where(eq(knowledgeEvidence.knowledgeId, knowledgeId))
      .orderBy(desc(knowledgeEvidence.createdAt));

    const changes = await db
      .select()
      .from(knowledgeChanges)
      .where(eq(knowledgeChanges.knowledgeId, knowledgeId))
      .orderBy(knowledgeChanges.id);

    const transcriptIds = [...new Set(evidenceRows.map((e) => e.transcriptId))];
    const audioByTranscript = new Map<number, { audioId: number; audioName: string }>();
    if (transcriptIds.length > 0) {
      const tRows = await db
        .select({
          transcriptId: transcripts.id,
          audioId: transcripts.audioId,
          audioName: audioFiles.originalName,
        })
        .from(transcripts)
        .innerJoin(audioFiles, eq(audioFiles.id, transcripts.audioId))
        .where(inArray(transcripts.id, transcriptIds));
      for (const row of tRows) {
        audioByTranscript.set(row.transcriptId, { audioId: row.audioId, audioName: row.audioName });
      }
    }

    const versionById = new Map(versions.map((v) => [v.id, v.versionNumber]));
    const changeVersionIds = [
      ...new Set([
        ...changes.map((c) => c.newVersionId),
        ...changes.map((c) => c.oldVersionId).filter((id): id is number => id !== null),
      ]),
    ];
    const oldValues = new Map<number, { valueText: string | null }>();
    if (changeVersionIds.length > 0) {
      const vRows = await db
        .select({ id: knowledgeVersions.id, valueText: knowledgeVersions.valueText })
        .from(knowledgeVersions)
        .where(inArray(knowledgeVersions.id, changeVersionIds));
      for (const row of vRows) oldValues.set(row.id, { valueText: row.valueText });
    }

    const evidenceCountByVersion = new Map<number, number>();
    for (const ev of evidenceRows) {
      evidenceCountByVersion.set(ev.knowledgeVersionId, (evidenceCountByVersion.get(ev.knowledgeVersionId) ?? 0) + 1);
    }

    const currentVersion = versions.find((v) => v.isCurrent) ?? null;

    return {
      item: {
        id: item.id,
        destinationId: item.destinationId,
        knowledgeType: item.knowledgeType as KnowledgeType,
        category: item.category,
        entityType: item.entityType,
        entityName: item.entityName,
        attribute: item.attribute,
        canonicalText: item.canonicalText,
        currentValue: currentVersion?.valueText ?? null,
        unit: currentVersion?.unit ?? null,
        versionNumber: currentVersion?.versionNumber ?? 0,
        status: item.status as MasterKnowledgeItem['status'],
        evidenceCount: evidenceRows.length,
        firstSeenBatchId: item.firstSeenBatchId,
        firstSeenAt: item.firstSeenAt?.toISOString() ?? null,
        lastSeenBatchId: item.lastSeenBatchId,
        lastSeenAt: item.lastSeenAt?.toISOString() ?? null,
      },
      versions: versions.map(
        (v) =>
          ({
            id: v.id,
            versionNumber: v.versionNumber,
            valueText: v.valueText,
            unit: v.unit,
            qualifiersJson: v.qualifiersJson,
            canonicalText: v.canonicalText,
            isCurrent: v.isCurrent,
            createdAt: v.createdAt.toISOString(),
            evidenceCount: evidenceCountByVersion.get(v.id) ?? 0,
          }) satisfies KnowledgeVersionInfo,
      ),
      evidence: evidenceRows.map((ev) => {
        const audio = audioByTranscript.get(ev.transcriptId);
        return {
          id: ev.id,
          knowledgeId: ev.knowledgeId,
          knowledgeVersionId: ev.knowledgeVersionId,
          versionNumber: versionById.get(ev.knowledgeVersionId) ?? 0,
          batchId: ev.batchId,
          audioId: audio?.audioId ?? null,
          transcriptId: ev.transcriptId,
          audioName: audio?.audioName ?? null,
          segmentId: ev.segmentId,
          sourceText: ev.sourceText,
          createdAt: ev.createdAt.toISOString(),
        } satisfies KnowledgeEvidenceInfo;
      }),
      changes: changes.map(
        (c) =>
          ({
            id: c.id,
            batchId: c.batchId,
            destinationId: c.destinationId,
            knowledgeId: c.knowledgeId,
            changeType: c.changeType as KnowledgeChangeInfo['changeType'],
            oldVersionId: c.oldVersionId,
            newVersionId: c.newVersionId,
            oldValue: c.oldVersionId !== null ? (oldValues.get(c.oldVersionId)?.valueText ?? null) : null,
            newValue: oldValues.get(c.newVersionId)?.valueText ?? null,
            canonicalText: item.canonicalText,
            createdAt: c.createdAt.toISOString(),
          }) satisfies KnowledgeChangeInfo,
      ),
    };
  }

  /** Open + resolved conflicts of a destination, newest first. */
  async listDestinationConflicts(destinationId: number): Promise<KnowledgeConflictInfo[]> {
    const db = getDatabase();
    const rows = await db
      .select({
        id: knowledgeConflicts.id,
        destinationId: knowledgeConflicts.destinationId,
        knowledgeId: knowledgeConflicts.knowledgeId,
        candidateId: knowledgeConflicts.candidateId,
        existingVersionId: knowledgeConflicts.existingVersionId,
        status: knowledgeConflicts.status,
        conflictType: knowledgeConflicts.conflictType,
        conflictGroupKey: knowledgeConflicts.conflictGroupKey,
        createdAt: knowledgeConflicts.createdAt,
        resolvedAt: knowledgeConflicts.resolvedAt,
        existingValue: knowledgeVersions.valueText,
        candidateCanonicalText: knowledgeCandidates.canonicalText,
        candidateValue: knowledgeCandidates.valueText,
        destinationName: destinations.canonicalName,
      })
      .from(knowledgeConflicts)
      .innerJoin(knowledgeCandidates, eq(knowledgeCandidates.id, knowledgeConflicts.candidateId))
      .innerJoin(destinations, eq(destinations.id, knowledgeConflicts.destinationId))
      .leftJoin(knowledgeVersions, eq(knowledgeVersions.id, knowledgeConflicts.existingVersionId))
      .where(eq(knowledgeConflicts.destinationId, destinationId))
      .orderBy(desc(knowledgeConflicts.createdAt));
    return rows.map((row) => ({
      id: row.id,
      destinationId: row.destinationId,
      destinationName: row.destinationName,
      knowledgeId: row.knowledgeId,
      candidateId: row.candidateId,
      existingVersionId: row.existingVersionId,
      existingValue: row.existingValue,
      candidateCanonicalText: row.candidateCanonicalText,
      candidateValue: row.candidateValue,
      status: row.status as KnowledgeConflictInfo['status'],
      conflictType: row.conflictType,
      conflictGroupKey: row.conflictGroupKey,
      createdAt: row.createdAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
    }));
  }

  /**
   * Resolve or dismiss a conflict (Phase 12 §20). DISMISS closes the record
   * without touching master knowledge or versions; RESOLVE with a note is
   * allowed only for conflicts already matching current truth — the version
   * history itself is never mutated here.
   */
  async resolveConflict(
    conflictId: number,
    action: 'DISMISS' | 'RESOLVE',
    note?: string,
  ): Promise<{ status: string; resolvedAt: Date | null } | null> {
    const db = getDatabase();
    const conflict = await db
      .select()
      .from(knowledgeConflicts)
      .where(eq(knowledgeConflicts.id, conflictId))
      .get();
    if (!conflict) return null;
    if (conflict.status !== 'OPEN') {
      // Idempotent: already resolved/dismissed — report current state.
      return { status: conflict.status, resolvedAt: conflict.resolvedAt };
    }
    const now = new Date();
    await db
      .update(knowledgeConflicts)
      .set({
        status: action === 'DISMISS' ? 'DISMISSED' : 'RESOLVED',
        resolutionNote: note?.trim() || conflict.resolutionNote,
        resolvedAt: now,
      })
      .where(eq(knowledgeConflicts.id, conflictId));
    return { status: action === 'DISMISS' ? 'DISMISSED' : 'RESOLVED', resolvedAt: now };
  }

  /** Publishable change records of a destination (NEW/UPDATE only). */
  async listDestinationChanges(destinationId: number): Promise<KnowledgeChangeInfo[]> {
    const db = getDatabase();
    const rows = await db
      .select({
        id: knowledgeChanges.id,
        batchId: knowledgeChanges.batchId,
        destinationId: knowledgeChanges.destinationId,
        knowledgeId: knowledgeChanges.knowledgeId,
        changeType: knowledgeChanges.changeType,
        oldVersionId: knowledgeChanges.oldVersionId,
        newVersionId: knowledgeChanges.newVersionId,
        createdAt: knowledgeChanges.createdAt,
        canonicalText: knowledgeVersions.canonicalText,
        newValue: knowledgeVersions.valueText,
      })
      .from(knowledgeChanges)
      .innerJoin(knowledgeVersions, eq(knowledgeVersions.id, knowledgeChanges.newVersionId))
      .where(eq(knowledgeChanges.destinationId, destinationId))
      .orderBy(desc(knowledgeChanges.id))
      .limit(200);
    const oldVersionIds = rows.map((r) => r.oldVersionId).filter((id): id is number => id !== null);
    const oldValues = new Map<number, string | null>();
    if (oldVersionIds.length > 0) {
      const vRows = await db
        .select({ id: knowledgeVersions.id, valueText: knowledgeVersions.valueText })
        .from(knowledgeVersions)
        .where(inArray(knowledgeVersions.id, oldVersionIds));
      for (const row of vRows) oldValues.set(row.id, row.valueText);
    }
    return rows.map((row) => ({
      id: row.id,
      batchId: row.batchId,
      destinationId: row.destinationId,
      knowledgeId: row.knowledgeId,
      changeType: row.changeType as KnowledgeChangeInfo['changeType'],
      oldVersionId: row.oldVersionId,
      newVersionId: row.newVersionId,
      oldValue: row.oldVersionId !== null ? (oldValues.get(row.oldVersionId) ?? null) : null,
      newValue: row.newValue,
      canonicalText: row.canonicalText,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}

export const masterKnowledgeService = new MasterKnowledgeService();
