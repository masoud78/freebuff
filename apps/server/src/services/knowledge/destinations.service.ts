import type {
  DestinationConfidence,
  DestinationStatus,
  DestinationType,
  KnowledgeStatus,
  KnowledgeType,
} from '@freebuff/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { getDatabase } from '../../core/database/client.js';
import type { DbExecutor } from '../jobs.service.js';
import {
  audioFiles,
  destinationAliases,
  destinations,
  knowledgeEvidence,
  knowledgeItems,
  knowledgeVersions,
  transcriptDestinations,
  transcripts,
} from '../../core/database/schema.js';
import { normalizeDestinationName } from './destination-normalize.js';

export interface DestinationProposal {
  name: string;
  type?: DestinationType;
  confidence?: DestinationConfidence;
  aliases?: string[];
}

/** Confidence as percent for the many-to-many link. */
function confidencePercent(confidence: DestinationConfidence | undefined): number {
  if (confidence === 'CONFIRMED') return 90;
  if (confidence === 'UNKNOWN') return 30;
  return 60;
}

/**
 * Destination discovery & matching. The backend never invents destinations:
 * a new one is created only when no exact normalized-name or alias match
 * exists, and only from Gemini's proposals (UNKNOWN is dropped by the caller).
 */
export class DestinationService {
  /**
   * Role-aware destination resolution for the simplified note model. Only a
   * place whose role is DESTINATION (the note is about it) creates or reuses
   * a destination row. ORIGIN / TRANSIT / COMPARISON / OTHER are never stored
   * as destinations — a note about "from Tabriz to Mashhad" yields Mashhad
   * only. Returns null when the note must not create a destination.
   */
  async resolveOrCreateNoteDestination(
    proposal: { name: string; role?: string },
    batchId: number | null,
    db: DbExecutor = getDatabase(),
  ): Promise<{ id: number; created: boolean } | null> {
    const role = (proposal.role ?? 'DESTINATION').toUpperCase();
    if (role !== 'DESTINATION') return null;
    const name = proposal.name.trim();
    if (name.length === 0) return null;

    const normalized = normalizeDestinationName(name);
    const existing = await this.findByNormalizedName(normalized, db);
    if (existing) return { id: existing.id, created: false };

    const now = new Date();
    const inserted = await db
      .insert(destinations)
      .values({
        canonicalName: name,
        normalizedName: normalized,
        type: 'OTHER',
        status: 'CONFIRMED',
        firstSeenBatchId: batchId,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: destinations.id });
    const id = inserted[0]?.id;
    if (id === undefined) return null;
    return { id, created: true };
  }

  /**
   * Resolve a destination proposal to an existing row or create a new one.
   * Returns null for UNKNOWN confidence — no fake destinations.
   */
  async resolveOrCreateDestination(
    proposal: DestinationProposal,
    batchId: number | null,
    db: DbExecutor = getDatabase(),
  ): Promise<{ id: number; created: boolean; confidence: number } | null> {
    if (proposal.confidence === 'UNKNOWN') return null;
    const name = proposal.name.trim();
    if (name.length === 0) return null;

    const normalized = normalizeDestinationName(name);
    const existing = await this.findByNormalizedName(normalized, db);
    if (existing) {
      return { id: existing.id, created: false, confidence: confidencePercent(proposal.confidence) };
    }

    const now = new Date();
    const inserted = await db
      .insert(destinations)
      .values({
        canonicalName: name,
        normalizedName: normalized,
        type: proposal.type ?? 'OTHER',
        status: proposal.confidence === 'CONFIRMED' ? 'CONFIRMED' : 'PROVISIONAL',
        firstSeenBatchId: batchId,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: destinations.id });
    const id = inserted[0]?.id;
    if (id === undefined) return null;

    for (const alias of proposal.aliases ?? []) {
      if (alias.trim().length === 0) continue;
      await this.addAlias(id, alias, db);
    }
    return { id, created: true, confidence: confidencePercent(proposal.confidence) };
  }

  async findByNormalizedName(normalizedName: string, db: DbExecutor = getDatabase()) {
    const row = await db
      .select()
      .from(destinations)
      .where(eq(destinations.normalizedName, normalizedName))
      .get();
    return row ?? null;
  }

  async findByAlias(normalizedAlias: string, db: DbExecutor = getDatabase()) {
    const row = await db
      .select({ destinationId: destinationAliases.destinationId })
      .from(destinationAliases)
      .where(eq(destinationAliases.normalizedAlias, normalizedAlias))
      .get();
    if (!row) return null;
    return db.select().from(destinations).where(eq(destinations.id, row.destinationId)).get();
  }

  async addAlias(destinationId: number, alias: string, db: DbExecutor = getDatabase()): Promise<void> {
    const normalized = normalizeDestinationName(alias);
    const exists = await db
      .select({ id: destinationAliases.id })
      .from(destinationAliases)
      .where(
        and(
          eq(destinationAliases.destinationId, destinationId),
          eq(destinationAliases.normalizedAlias, normalized),
        ),
      )
      .get();
    if (exists) return;
    await db.insert(destinationAliases).values({
      destinationId,
      alias: alias.trim(),
      normalizedAlias: normalized,
      createdAt: new Date(),
    });
  }

  /** Link a transcript to a destination (many-to-many, idempotent). */
  async linkTranscript(
    transcriptId: number,
    destinationId: number,
    confidence: number,
    db: DbExecutor = getDatabase(),
  ): Promise<void> {
    const exists = await db
      .select({ id: transcriptDestinations.id })
      .from(transcriptDestinations)
      .where(
        and(
          eq(transcriptDestinations.transcriptId, transcriptId),
          eq(transcriptDestinations.destinationId, destinationId),
        ),
      )
      .get();
    if (exists) return;
    await db.insert(transcriptDestinations).values({
      transcriptId,
      destinationId,
      confidence,
      createdAt: new Date(),
    });
  }

  /** All destinations with aggregated knowledge/source counts. */
  async listDestinations() {
    const db = getDatabase();
    const rows = await db.select().from(destinations).orderBy(destinations.canonicalName);
    const aliases = await db.select().from(destinationAliases);
    const aliasByDest = new Map<number, string[]>();
    for (const alias of aliases) {
      const list = aliasByDest.get(alias.destinationId) ?? [];
      list.push(alias.alias);
      aliasByDest.set(alias.destinationId, list);
    }

    const knowledgeCounts = await db
      .select({ destinationId: knowledgeItems.destinationId, count: sql<number>`count(${knowledgeItems.id})` })
      .from(knowledgeItems)
      .where(sql`${knowledgeItems.destinationId} IS NOT NULL`)
      .groupBy(knowledgeItems.destinationId);
    const knowledgeByDest = new Map(knowledgeCounts.map((row) => [row.destinationId, Number(row.count)]));

    const sourceCounts = await db
      .select({ destinationId: transcriptDestinations.destinationId, count: sql<number>`count(distinct ${transcriptDestinations.transcriptId})` })
      .from(transcriptDestinations)
      .groupBy(transcriptDestinations.destinationId);
    const sourcesByDest = new Map(sourceCounts.map((row) => [row.destinationId, Number(row.count)]));

    return rows.map((row) => ({
      id: row.id,
      canonicalName: row.canonicalName,
      type: row.type as DestinationType,
      status: row.status as DestinationStatus,
      aliases: aliasByDest.get(row.id) ?? [],
      knowledgeCount: knowledgeByDest.get(row.id) ?? 0,
      sourceTranscriptCount: sourcesByDest.get(row.id) ?? 0,
      firstSeenBatchId: row.firstSeenBatchId,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /** Detail view: destination + its knowledge + source transcripts. */
  async getDestination(id: number) {
    const db = getDatabase();
    const dest = await db.select().from(destinations).where(eq(destinations.id, id)).get();
    if (!dest) return null;

    const aliases = await db
      .select({ alias: destinationAliases.alias })
      .from(destinationAliases)
      .where(eq(destinationAliases.destinationId, id));

    const items = await db
      .select({
        id: knowledgeItems.id,
        knowledgeType: knowledgeItems.knowledgeType,
        category: knowledgeItems.category,
        entityType: knowledgeItems.entityType,
        entityName: knowledgeItems.entityName,
        attribute: knowledgeItems.attribute,
        status: knowledgeItems.status,
        canonicalText: knowledgeItems.canonicalText,
        createdAt: knowledgeItems.createdAt,
      })
      .from(knowledgeItems)
      .where(eq(knowledgeItems.destinationId, id));

    // Current value (V-current) and evidence source count per knowledge item.
    const versions = await db
      .select({
        knowledgeId: knowledgeVersions.knowledgeId,
        valueText: knowledgeVersions.valueText,
        unit: knowledgeVersions.unit,
      })
      .from(knowledgeVersions)
      .where(eq(knowledgeVersions.isCurrent, true));
    const versionByItem = new Map(versions.map((v) => [v.knowledgeId, v]));

    const evidenceCounts = await db
      .select({ knowledgeId: knowledgeEvidence.knowledgeId, count: sql<number>`count(${knowledgeEvidence.id})` })
      .from(knowledgeEvidence)
      .groupBy(knowledgeEvidence.knowledgeId);
    const sourcesByItem = new Map(evidenceCounts.map((row) => [row.knowledgeId, Number(row.count)]));

    const knowledge = items.map((item) => {
      const version = versionByItem.get(item.id);
      return {
        id: item.id,
        destinationId: id,
        knowledgeType: item.knowledgeType as KnowledgeType,
        category: item.category,
        entityType: item.entityType,
        entityName: item.entityName,
        attribute: item.attribute,
        currentValue: version?.valueText ?? null,
        unit: version?.unit ?? null,
        status: item.status as KnowledgeStatus,
        confidence: 0,
        canonicalText: item.canonicalText,
        sourceCount: sourcesByItem.get(item.id) ?? 0,
        createdAt: item.createdAt.toISOString(),
      };
    });

    const sourceRows = await db
      .select({
        transcriptId: transcriptDestinations.transcriptId,
        audioId: transcripts.audioId,
        audioName: audioFiles.originalName,
        batchId: audioFiles.batchId,
        analyzedAt: transcripts.updatedAt,
      })
      .from(transcriptDestinations)
      .innerJoin(transcripts, eq(transcripts.id, transcriptDestinations.transcriptId))
      .innerJoin(audioFiles, eq(audioFiles.id, transcripts.audioId))
      .where(eq(transcriptDestinations.destinationId, id));

    return {
      id: dest.id,
      canonicalName: dest.canonicalName,
      type: dest.type as DestinationType,
      status: dest.status as DestinationStatus,
      aliases: aliases.map((a) => a.alias),
      knowledgeCount: knowledge.length,
      sourceTranscriptCount: sourceRows.length,
      firstSeenBatchId: dest.firstSeenBatchId,
      createdAt: dest.createdAt.toISOString(),
      knowledge,
      sources: sourceRows.map((row) => ({
        ...row,
        analyzedAt: row.analyzedAt.toISOString(),
      })),
    };
  }
}

export const destinationService = new DestinationService();
