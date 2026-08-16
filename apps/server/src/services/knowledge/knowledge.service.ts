import type { KnowledgeStatus, KnowledgeType } from '@freebuff/contracts';
import { and, eq } from 'drizzle-orm';
import { getDatabase } from '../../core/database/client.js';
import type { DbExecutor } from '../jobs.service.js';
import { knowledgeEvidence, knowledgeItems, knowledgeVersions } from '../../core/database/schema.js';
import { DomainError } from '../errors.js';

/** Central confidence threshold (0–1) — at/above → ACTIVE. */
export const KNOWLEDGE_CONFIDENCE_ACTIVE = 0.7;
/** Below this the knowledge is rejected entirely by the analyzer. */
export const KNOWLEDGE_CONFIDENCE_MIN = 0.35;

export interface CreateKnowledgeInput {
  destinationId: number | null;
  knowledgeType: KnowledgeType;
  category: string | null;
  entityType: string | null;
  entityName: string | null;
  attribute: string | null;
  value: string | null;
  unit: string | null;
  qualifiers: string[];
  canonicalText: string;
  identityKey: string;
  confidence: number;
  firstSeenBatchId: number | null;
  /** Evidence must be present — knowledge without evidence is invalid. */
  evidence: {
    batchId: number | null;
    audioId: number | null;
    transcriptId: number;
    segmentId: number | null;
    sourceText: string;
  };
  db: DbExecutor;
}

/**
 * Persistence of atomic knowledge items. A knowledge item is only committed
 * together with its V1 version AND its evidence in the same transaction —
 * knowledge without evidence never exists.
 */
export class KnowledgeService {
  async createKnowledge(input: CreateKnowledgeInput): Promise<number> {
    const now = new Date();
    const status: KnowledgeStatus =
      input.confidence >= KNOWLEDGE_CONFIDENCE_ACTIVE ? 'ACTIVE' : 'PROVISIONAL';

    const inserted = await input.db
      .insert(knowledgeItems)
      .values({
        destinationId: input.destinationId,
        knowledgeType: input.knowledgeType,
        category: input.category,
        entityType: input.entityType,
        entityName: input.entityName,
        attribute: input.attribute,
        identityKey: input.identityKey,
        canonicalText: input.canonicalText,
        status,
        firstSeenBatchId: input.firstSeenBatchId,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: knowledgeItems.id });
    const knowledgeId = inserted[0]?.id;
    if (knowledgeId === undefined) {
      throw new DomainError('KNOWLEDGE_SAVE_FAILED', 'ذخیره دانش ممکن نشد.');
    }

    const version = await input.db
      .insert(knowledgeVersions)
      .values({
        knowledgeId,
        versionNumber: 1,
        valueText: input.value,
        valueJson: null,
        unit: input.unit,
        qualifiersJson: input.qualifiers.length > 0 ? JSON.stringify(input.qualifiers) : null,
        canonicalText: input.canonicalText,
        isCurrent: true,
        createdAt: now,
      })
      .returning({ id: knowledgeVersions.id });
    const versionId = version[0]?.id;
    if (versionId === undefined) {
      throw new DomainError('KNOWLEDGE_SAVE_FAILED', 'ذخیره نسخه دانش ممکن نشد.');
    }

    await input.db.insert(knowledgeEvidence).values({
      knowledgeId,
      knowledgeVersionId: versionId,
      batchId: input.evidence.batchId,
      audioId: input.evidence.audioId,
      transcriptId: input.evidence.transcriptId,
      segmentId: input.evidence.segmentId,
      sourceText: input.evidence.sourceText,
      createdAt: now,
    });

    return knowledgeId;
  }

  /** Current value of a knowledge item (V-current) for UI display. */
  async getCurrentValue(knowledgeId: number): Promise<{ value: string | null; unit: string | null } | null> {
    const db = getDatabase();
    const row = await db
      .select({ valueText: knowledgeVersions.valueText, unit: knowledgeVersions.unit })
      .from(knowledgeVersions)
      .where(
        and(
          eq(knowledgeVersions.knowledgeId, knowledgeId),
          eq(knowledgeVersions.isCurrent, true),
        ),
      )
      .get();
    if (!row) return null;
    return { value: row.valueText, unit: row.unit };
  }
}

export const knowledgeService = new KnowledgeService();
