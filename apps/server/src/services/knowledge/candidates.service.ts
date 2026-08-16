import type { CandidateStatus, KnowledgeType } from '@freebuff/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { getClient, getDatabase } from '../../core/database/client.js';
import { knowledgeCandidates, knowledgeDeltaDecisions, type KnowledgeCandidateRow } from '../../core/database/schema.js';
import type { DbExecutor } from '../jobs.service.js';

export interface CreateCandidateInput {
  analysisRunId: number;
  batchId: number;
  transcriptId: number;
  destinationId: number | null;
  knowledgeType: KnowledgeType;
  category: string | null;
  entityType: string | null;
  entityName: string | null;
  attribute: string | null;
  valueText: string | null;
  valueJson: unknown;
  unit: string | null;
  qualifiers: string[];
  canonicalText: string;
  identityKey: string;
  valueHash: string;
  confidence: number;
  /** Source segment for reconciliation evidence (Phase 10). */
  sourceSegmentId: number | null;
  sourceText: string;
}

/**
 * Persistence and claiming of knowledge candidates. Candidates are the unit
 * of delta comparison: extraction always produces candidates, never master
 * knowledge. Claiming is atomic (single UPDATE…RETURNING) so two concurrent
 * delta jobs can never decide the same candidate twice.
 */
export class CandidatesService {
  async createCandidate(input: CreateCandidateInput, db: DbExecutor = getDatabase()): Promise<number> {
    const now = new Date();
    const inserted = await db
      .insert(knowledgeCandidates)
      .values({
        analysisRunId: input.analysisRunId,
        batchId: input.batchId,
        transcriptId: input.transcriptId,
        destinationId: input.destinationId,
        knowledgeType: input.knowledgeType,
        category: input.category,
        entityType: input.entityType,
        entityName: input.entityName,
        attribute: input.attribute,
        valueText: input.valueText,
        valueJson: input.valueJson !== null && input.valueJson !== undefined ? JSON.stringify(input.valueJson) : null,
        unit: input.unit,
        qualifiersJson: input.qualifiers.length > 0 ? JSON.stringify(input.qualifiers) : null,
        canonicalText: input.canonicalText,
        identityKey: input.identityKey,
        valueHash: input.valueHash,
        confidence: input.confidence,
        sourceSegmentId: input.sourceSegmentId,
        sourceText: input.sourceText,
        status: 'PENDING',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: knowledgeCandidates.id });
    const id = inserted[0]?.id;
    if (id === undefined) {
      throw new Error('candidate insert returned no row');
    }
    return id;
  }

  /** All candidates of a transcript in stable id order. */
  async listByTranscript(transcriptId: number): Promise<KnowledgeCandidateRow[]> {
    const db = getDatabase();
    return db
      .select()
      .from(knowledgeCandidates)
      .where(eq(knowledgeCandidates.transcriptId, transcriptId))
      .orderBy(knowledgeCandidates.id);
  }

  /** Pending candidates of a transcript in stable id order (deterministic). */
  async listPendingByTranscript(transcriptId: number): Promise<KnowledgeCandidateRow[]> {
    const db = getDatabase();
    return db
      .select()
      .from(knowledgeCandidates)
      .where(
        and(
          eq(knowledgeCandidates.transcriptId, transcriptId),
          eq(knowledgeCandidates.status, 'PENDING'),
        ),
      )
      .orderBy(knowledgeCandidates.id);
  }

  /**
   * Atomically claim one candidate (PENDING → DECIDED). Returns the row only
   * when this caller won the claim; concurrent claims get `null`. The status
   * flip is reverted to PENDING by the caller on retryable failure so the
   * job retry re-processes the candidate.
   */
  async claimCandidate(candidateId: number): Promise<KnowledgeCandidateRow | null> {
    const client = getClient();
    const result = await client.execute({
      sql: `UPDATE knowledge_candidates
            SET status = 'DECIDED', updated_at = ?
            WHERE id = ? AND status = 'PENDING'
            RETURNING id`,
      args: [Date.now(), candidateId],
    });
    const claimed = result.rows[0] as { id?: number } | undefined;
    if (!claimed?.id) return null;
    const row = await getDatabase()
      .select()
      .from(knowledgeCandidates)
      .where(eq(knowledgeCandidates.id, candidateId))
      .get();
    return row ?? null;
  }

  /** Revert a claimed candidate to PENDING (retryable failure path). */
  async revertClaim(candidateId: number): Promise<void> {
    await getDatabase()
      .update(knowledgeCandidates)
      .set({ status: 'PENDING', updatedAt: new Date() })
      .where(eq(knowledgeCandidates.id, candidateId));
  }

  /** Mark a candidate permanently failed. */
  async markFailed(candidateId: number): Promise<void> {
    await getDatabase()
      .update(knowledgeCandidates)
      .set({ status: 'FAILED', updatedAt: new Date() })
      .where(eq(knowledgeCandidates.id, candidateId));
  }

  /**
   * Candidates claimed by a previous run but never decided (crash between
   * claim and persist) are returned to PENDING so recovery reprocesses them.
   */
  async reconcileStaleClaims(): Promise<number> {
    const db = getDatabase();
    const stale = await db
      .select({ id: knowledgeCandidates.id })
      .from(knowledgeCandidates)
      .leftJoin(knowledgeDeltaDecisions, eq(knowledgeDeltaDecisions.candidateId, knowledgeCandidates.id))
      .where(
        and(
          eq(knowledgeCandidates.status, 'DECIDED'),
          sql`${knowledgeDeltaDecisions.id} IS NULL`,
        ),
      );
    if (stale.length === 0) return 0;
    const ids = stale.map((row) => row.id);
    await db
      .update(knowledgeCandidates)
      .set({ status: 'PENDING', updatedAt: new Date() })
      .where(
        and(
          eq(knowledgeCandidates.status, 'DECIDED'),
          sql`${knowledgeCandidates.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`,
        ),
      );
    return ids.length;
  }

  /** Count of candidates per status in a batch. */
  async countByBatchStatus(batchId: number): Promise<{ PENDING: number; DECIDED: number; FAILED: number }> {
    const db = getDatabase();
    const rows = await db
      .select({ status: knowledgeCandidates.status, count: sql<number>`count(${knowledgeCandidates.id})` })
      .from(knowledgeCandidates)
      .where(eq(knowledgeCandidates.batchId, batchId))
      .groupBy(knowledgeCandidates.status);
    const counts = { PENDING: 0, DECIDED: 0, FAILED: 0 };
    for (const row of rows) {
      if (row.status === 'PENDING' || row.status === 'DECIDED' || row.status === 'FAILED') {
        counts[row.status as keyof typeof counts] = Number(row.count);
      }
    }
    return counts;
  }

  /** Get a single candidate by id. */
  async getCandidate(candidateId: number): Promise<KnowledgeCandidateRow | null> {
    const db = getDatabase();
    const row = await db
      .select()
      .from(knowledgeCandidates)
      .where(eq(knowledgeCandidates.id, candidateId))
      .get();
    return row ?? null;
  }

  /** Set a candidate status (used for controlled FAILED transitions). */
  async setStatus(candidateId: number, status: CandidateStatus): Promise<void> {
    await getDatabase()
      .update(knowledgeCandidates)
      .set({ status, updatedAt: new Date() })
      .where(eq(knowledgeCandidates.id, candidateId));
  }
}

export const candidatesService = new CandidatesService();
