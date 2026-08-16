import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getDatabase } from '../../core/database/client.js';
import {
  knowledgeCandidates,
  knowledgeChanges,
  knowledgeConflicts,
  knowledgeDeltaDecisions,
  knowledgeEvidence,
  knowledgeItems,
  knowledgeVersions,
  type KnowledgeCandidateRow,
  type KnowledgeDeltaDecisionRow,
} from '../../core/database/schema.js';
import type { DbExecutor } from '../jobs.service.js';
import { DomainError } from '../errors.js';

/** Same threshold as Phase 8: at/above → ACTIVE, below → PROVISIONAL. */
export const RECONCILIATION_CONFIDENCE_ACTIVE = 0.7;

interface CanonicalHit {
  knowledgeId: number;
  versionId: number;
  valueText: string | null;
  unit: string | null;
}

interface EvidenceInput {
  knowledgeId: number;
  versionId: number;
  candidate: KnowledgeCandidateRow;
}

/**
 * Phase 10 — applies delta decisions onto Master Knowledge transactionally.
 * Deterministic and database-driven: NO Gemini calls here. Every decision
 * maps to a fixed behavior:
 *
 *   NEW          → item + V1 + evidence + change (or resolve to confirm/conflict)
 *   CONFIRMATION → evidence only + last_seen
 *   UPDATE       → new version + evidence + change
 *   CONFLICT     → conflict record (OPEN), truth untouched
 *   IGNORE       → nothing
 *
 * All writes are idempotent (unique constraints + per-decision checks), so
 * replays can never duplicate data.
 */
export class KnowledgeReconciliationService {
  /** Reconcile one decision. Safe to call repeatedly. */
  async reconcileDecision(
    decision: KnowledgeDeltaDecisionRow,
    candidate: KnowledgeCandidateRow,
  ): Promise<void> {
    if (decision.decision === 'NEW' || decision.decision === 'UPDATE') {
      // Replay guard: the change record for this decision already exists.
      const change = await getDatabase()
        .select({ id: knowledgeChanges.id })
        .from(knowledgeChanges)
        .where(eq(knowledgeChanges.sourceDecisionId, decision.id))
        .get();
      if (change) {
        await this.finalizeCandidate(decision.id);
        return;
      }
      // Unique-constraint races (concurrent NEW/UPDATE on the same identity)
      // are resolved inside a fresh transaction on retry.
      try {
        await getDatabase().transaction(async (tx) => {
          await this.applyMasterChange(tx, decision, candidate);
        });
      } catch (error) {
        if (this.isUniqueConstraintError(error)) {
          await getDatabase().transaction(async (tx) => {
            await this.applyMasterChange(tx, decision, candidate);
          });
        } else {
          throw error;
        }
      }
    } else if (decision.decision === 'CONFIRMATION') {
      await this.applyConfirmation(decision, candidate);
    } else if (decision.decision === 'CONFLICT') {
      await this.applyConflict(decision, candidate);
    }
    // IGNORE mutates nothing.

    await this.finalizeCandidate(decision.id);
  }

  /** Mark the decision as reconciled (idempotent). */
  async finalizeCandidate(decisionId: number): Promise<void> {
    await getDatabase()
      .update(knowledgeDeltaDecisions)
      .set({ reconciledAt: new Date() })
      .where(eq(knowledgeDeltaDecisions.id, decisionId));
  }

  /** All decisions (with their candidates) of one transcript, stable order. */
  async decisionsForTranscript(transcriptId: number): Promise<
    { decision: KnowledgeDeltaDecisionRow; candidate: KnowledgeCandidateRow }[]
  > {
    const db = getDatabase();
    const rows = await db
      .select({
        decision: knowledgeDeltaDecisions,
        candidate: knowledgeCandidates,
      })
      .from(knowledgeDeltaDecisions)
      .innerJoin(knowledgeCandidates, eq(knowledgeCandidates.id, knowledgeDeltaDecisions.candidateId))
      .where(eq(knowledgeCandidates.transcriptId, transcriptId))
      .orderBy(knowledgeDeltaDecisions.candidateId);
    return rows.map((row) => ({ decision: row.decision, candidate: row.candidate }));
  }

  // -------------------------------------------------------------------------
  // NEW / UPDATE
  // -------------------------------------------------------------------------

  private async applyMasterChange(
    tx: DbExecutor,
    decision: KnowledgeDeltaDecisionRow,
    candidate: KnowledgeCandidateRow,
  ): Promise<void> {
    const canonical = await this.findCanonical(tx, candidate);

    if (decision.decision === 'NEW') {
      if (canonical) {
        // §9: a canonical item appeared between decision and reconciliation
        // (race) — never create a blind duplicate. Resolve to the safe behavior.
        if (this.valueMatches(candidate, canonical)) {
          await this.attachEvidenceAndTouch(tx, candidate, canonical.knowledgeId, canonical.versionId);
          await this.noteResolution(tx, decision.id, `NEW resolved as CONFIRMATION (canonical #${canonical.knowledgeId})`);
        } else {
          await this.createConflict(tx, decision, candidate, canonical);
          await this.noteResolution(tx, decision.id, `NEW resolved as CONFLICT (canonical #${canonical.knowledgeId})`);
        }
        return;
      }

      const now = new Date();
      const status = candidate.confidence >= RECONCILIATION_CONFIDENCE_ACTIVE ? 'ACTIVE' : 'PROVISIONAL';
      const inserted = await tx
        .insert(knowledgeItems)
        .values({
          destinationId: candidate.destinationId,
          knowledgeType: candidate.knowledgeType,
          category: candidate.category,
          entityType: candidate.entityType,
          entityName: candidate.entityName,
          attribute: candidate.attribute,
          identityKey: candidate.identityKey,
          canonicalText: candidate.canonicalText,
          status,
          firstSeenBatchId: candidate.batchId,
          firstSeenAt: now,
          lastSeenBatchId: candidate.batchId,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: knowledgeItems.id });
      const knowledgeId = inserted[0]?.id;
      if (knowledgeId === undefined) {
        throw new DomainError('KNOWLEDGE_TRANSACTION_FAILED', 'ایجاد دانش مرجع ممکن نشد.');
      }

      const version = await this.insertVersion(tx, {
        knowledgeId,
        versionNumber: 1,
        candidate,
        canonicalText: candidate.canonicalText,
        isCurrent: true,
      });
      await this.insertEvidence(tx, { knowledgeId, versionId: version.id, candidate });
      await this.insertChange(tx, {
        batchId: candidate.batchId,
        destinationId: candidate.destinationId,
        knowledgeId,
        changeType: 'NEW',
        oldVersionId: null,
        newVersionId: version.id,
        decisionId: decision.id,
      });
      return;
    }

    // UPDATE
    if (!canonical) {
      throw new DomainError(
        'RECONCILIATION_TARGET_NOT_FOUND',
        'دانش مرجع برای به‌روزرسانی یافت نشد.',
      );
    }
    const current = await tx
      .select({ id: knowledgeVersions.id, versionNumber: knowledgeVersions.versionNumber })
      .from(knowledgeVersions)
      .where(eq(knowledgeVersions.id, canonical.versionId))
      .get();
    if (!current) {
      throw new DomainError('RECONCILIATION_VERSION_CONFLICT', 'نسخه جاری دانش مرجع یافت نشد.');
    }

    // Archive the current version (append-only history — never overwritten).
    const now = new Date();
    await tx
      .update(knowledgeVersions)
      .set({ isCurrent: false })
      .where(eq(knowledgeVersions.id, canonical.versionId));
    const next = await this.insertVersion(tx, {
      knowledgeId: canonical.knowledgeId,
      versionNumber: current.versionNumber + 1,
      candidate,
      canonicalText: candidate.canonicalText,
      isCurrent: true,
    });
    await this.insertEvidence(tx, {
      knowledgeId: canonical.knowledgeId,
      versionId: next.id,
      candidate,
    });
    await tx
      .update(knowledgeItems)
      .set({
        canonicalText: candidate.canonicalText,
        lastSeenBatchId: candidate.batchId,
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(knowledgeItems.id, canonical.knowledgeId));
    await this.insertChange(tx, {
      batchId: candidate.batchId,
      destinationId: candidate.destinationId,
      knowledgeId: canonical.knowledgeId,
      changeType: 'UPDATE',
      oldVersionId: canonical.versionId,
      newVersionId: next.id,
      decisionId: decision.id,
    });
  }

  // -------------------------------------------------------------------------
  // CONFIRMATION
  // -------------------------------------------------------------------------

  private async applyConfirmation(
    decision: KnowledgeDeltaDecisionRow,
    candidate: KnowledgeCandidateRow,
  ): Promise<void> {
    await getDatabase().transaction(async (tx) => {
      const target = decision.matchedKnowledgeId
        ? await tx
            .select()
            .from(knowledgeItems)
            .where(eq(knowledgeItems.id, decision.matchedKnowledgeId))
            .get()
        : await this.findCanonicalItem(tx, candidate);
      if (!target) {
        throw new DomainError('RECONCILIATION_TARGET_NOT_FOUND', 'دانش مرجع برای تأیید یافت نشد.');
      }
      const current = await tx
        .select()
        .from(knowledgeVersions)
        .where(
          and(
            eq(knowledgeVersions.knowledgeId, target.id),
            eq(knowledgeVersions.isCurrent, true),
          ),
        )
        .get();
      if (!current) {
        throw new DomainError('RECONCILIATION_VERSION_CONFLICT', 'نسخه جاری دانش مرجع یافت نشد.');
      }
      // Evidence dedup (unique index + explicit check for NULL segment).
      await this.insertEvidence(tx, {
        knowledgeId: target.id,
        versionId: current.id,
        candidate,
      });
      const now = new Date();
      await tx
        .update(knowledgeItems)
        .set({
          lastSeenBatchId: candidate.batchId,
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(knowledgeItems.id, target.id));
    });
  }

  // -------------------------------------------------------------------------
  // CONFLICT
  // -------------------------------------------------------------------------

  private async applyConflict(
    decision: KnowledgeDeltaDecisionRow,
    candidate: KnowledgeCandidateRow,
  ): Promise<void> {
    await getDatabase().transaction(async (tx) => {
      const existing = await tx
        .select({ id: knowledgeConflicts.id })
        .from(knowledgeConflicts)
        .where(eq(knowledgeConflicts.candidateId, candidate.id))
        .get();
      if (existing) return; // replay-safe
      await this.createConflict(tx, decision, candidate, null);
    });
  }

  private async createConflict(
    tx: DbExecutor,
    decision: KnowledgeDeltaDecisionRow,
    candidate: KnowledgeCandidateRow,
    canonical: CanonicalHit | null,
  ): Promise<void> {
    const groupKey = createHash('sha256')
      .update(`${candidate.destinationId ?? ''}|${candidate.identityKey}`)
      .digest('hex');
    const now = new Date();
    await tx
      .insert(knowledgeConflicts)
      .values({
        destinationId: candidate.destinationId,
        knowledgeId: canonical?.knowledgeId ?? decision.matchedKnowledgeId,
        candidateId: candidate.id,
        existingVersionId: canonical?.versionId ?? decision.matchedVersionId,
        status: 'OPEN',
        conflictType: decision.reasonCode ?? 'CONFLICT',
        conflictGroupKey: groupKey,
        createdAt: now,
      })
      .onConflictDoNothing({ target: knowledgeConflicts.candidateId });
  }

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  /** Find the current canonical master item for the candidate's identity. */
  private async findCanonical(tx: DbExecutor, candidate: KnowledgeCandidateRow): Promise<CanonicalHit | null> {
    const row = await tx
      .select({
        knowledgeId: knowledgeItems.id,
        versionId: knowledgeVersions.id,
        valueText: knowledgeVersions.valueText,
        unit: knowledgeVersions.unit,
      })
      .from(knowledgeItems)
      .innerJoin(knowledgeVersions, eq(knowledgeVersions.knowledgeId, knowledgeItems.id))
      .where(
        and(
          candidate.destinationId === null
            ? sql`${knowledgeItems.destinationId} IS NULL`
            : eq(knowledgeItems.destinationId, candidate.destinationId),
          eq(knowledgeItems.identityKey, candidate.identityKey),
          eq(knowledgeVersions.isCurrent, true),
          sql`${knowledgeItems.status} IN ('ACTIVE', 'PROVISIONAL')`,
        ),
      )
      .get();
    return row ?? null;
  }

  private async findCanonicalItem(
    tx: DbExecutor,
    candidate: KnowledgeCandidateRow,
  ): Promise<typeof knowledgeItems.$inferSelect | null> {
    const row = await tx
      .select()
      .from(knowledgeItems)
      .where(
        and(
          candidate.destinationId === null
            ? sql`${knowledgeItems.destinationId} IS NULL`
            : eq(knowledgeItems.destinationId, candidate.destinationId),
          eq(knowledgeItems.identityKey, candidate.identityKey),
          sql`${knowledgeItems.status} IN ('ACTIVE', 'PROVISIONAL')`,
        ),
      )
      .get();
    return row ?? null;
  }

  private valueMatches(candidate: KnowledgeCandidateRow, canonical: CanonicalHit): boolean {
    const normalize = (v: string | null): string => (v ?? '').trim().toLowerCase();
    if (normalize(candidate.valueText) !== normalize(canonical.valueText)) return false;
    return normalize(candidate.unit) === normalize(canonical.unit);
  }

  private async insertVersion(
    tx: DbExecutor,
    input: {
      knowledgeId: number;
      versionNumber: number;
      candidate: KnowledgeCandidateRow;
      canonicalText: string;
      isCurrent: boolean;
    },
  ): Promise<{ id: number }> {
    const inserted = await tx
      .insert(knowledgeVersions)
      .values({
        knowledgeId: input.knowledgeId,
        versionNumber: input.versionNumber,
        valueText: input.candidate.valueText,
        valueJson: null,
        unit: input.candidate.unit,
        qualifiersJson: input.candidate.qualifiersJson,
        canonicalText: input.canonicalText,
        isCurrent: input.isCurrent,
        createdAt: new Date(),
      })
      .returning({ id: knowledgeVersions.id });
    const id = inserted[0]?.id;
    if (id === undefined) {
      throw new DomainError('KNOWLEDGE_TRANSACTION_FAILED', 'ایجاد نسخه دانش ممکن نشد.');
    }
    return { id };
  }

  /** Insert evidence with dedup — a source evidences a version only once. */
  private async insertEvidence(
    tx: DbExecutor,
    input: EvidenceInput,
  ): Promise<void> {
    const { candidate } = input;
    const segmentCondition =
      candidate.sourceSegmentId !== null
        ? eq(knowledgeEvidence.segmentId, candidate.sourceSegmentId)
        : sql`${knowledgeEvidence.segmentId} IS NULL`;
    const duplicate = await tx
      .select({ id: knowledgeEvidence.id })
      .from(knowledgeEvidence)
      .where(
        and(
          eq(knowledgeEvidence.knowledgeId, input.knowledgeId),
          eq(knowledgeEvidence.knowledgeVersionId, input.versionId),
          eq(knowledgeEvidence.transcriptId, candidate.transcriptId),
          segmentCondition,
        ),
      )
      .get();
    if (duplicate) return;

    await tx.insert(knowledgeEvidence).values({
      knowledgeId: input.knowledgeId,
      knowledgeVersionId: input.versionId,
      batchId: candidate.batchId,
      audioId: null,
      transcriptId: candidate.transcriptId,
      segmentId: candidate.sourceSegmentId,
      sourceText: candidate.sourceText ?? candidate.canonicalText,
      createdAt: new Date(),
    });
  }

  private async attachEvidenceAndTouch(
    tx: DbExecutor,
    candidate: KnowledgeCandidateRow,
    knowledgeId: number,
    versionId: number,
  ): Promise<void> {
    await this.insertEvidence(tx, { knowledgeId, versionId, candidate });
    await tx
      .update(knowledgeItems)
      .set({
        lastSeenBatchId: candidate.batchId,
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(knowledgeItems.id, knowledgeId));
  }

  private async insertChange(
    tx: DbExecutor,
    input: {
      batchId: number;
      destinationId: number | null;
      knowledgeId: number;
      changeType: 'NEW' | 'UPDATE';
      oldVersionId: number | null;
      newVersionId: number;
      decisionId: number;
    },
  ): Promise<void> {
    await tx.insert(knowledgeChanges).values({
      batchId: input.batchId,
      destinationId: input.destinationId,
      knowledgeId: input.knowledgeId,
      changeType: input.changeType,
      oldVersionId: input.oldVersionId,
      newVersionId: input.newVersionId,
      sourceDecisionId: input.decisionId,
      createdAt: new Date(),
    });
  }

  private async noteResolution(tx: DbExecutor, decisionId: number, note: string): Promise<void> {
    const decision = await tx
      .select({ reasoningSummary: knowledgeDeltaDecisions.reasoningSummary })
      .from(knowledgeDeltaDecisions)
      .where(eq(knowledgeDeltaDecisions.id, decisionId))
      .get();
    await tx
      .update(knowledgeDeltaDecisions)
      .set({
        reasoningSummary: decision?.reasoningSummary
          ? `${decision.reasoningSummary} | ${note}`
          : note,
      })
      .where(eq(knowledgeDeltaDecisions.id, decisionId));
  }

  private isUniqueConstraintError(error: unknown): boolean {
    if (error instanceof DomainError) return false;
    const raw = error instanceof Error ? `${error.name} ${error.message}` : String(error);
    return raw.includes('SQLITE_CONSTRAINT') && raw.includes('UNIQUE');
  }
}

export const knowledgeReconciliationService = new KnowledgeReconciliationService();
