import type {
  AudienceInsightItem,
  DestinationNoteListResponse,
  DestinationNoteSourceItem,
  DestinationNoteStatus,
  DestinationSourceVoiceNotesResponse,
} from '@freebuff/contracts';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { getDatabase } from '../core/database/client.js';
import {
  audioFiles,
  batchDestinationSummaries,
  destinationAliases,
  destinationAudienceInsights,
  destinationInsightSources,
  destinationNoteLogs,
  destinationNotes,
  destinationNoteSources,
  destinationNoteVersions,
  destinations,
  generatedContentKnowledge,
  generatedContents,
  insightProposals,
  knowledgeCandidates,
  knowledgeChanges,
  knowledgeConflicts,
  knowledgeDeltaDecisions,
  knowledgeEmbeddings,
  knowledgeEvidence,
  knowledgeItems,
  knowledgeVersions,
  noteProposals,
  processingDestinationNews,
  transcriptDestinations,
} from '../core/database/schema.js';

/**
 * Read model for the simplified destination page: current/outdated notes,
 * source voices (deduplicated) and the change-log timeline. Also owns
 * destination deletion so the full cascade lives in one transaction.
 */
export class DestinationNotesService {
  async getDetail(
    destinationId: number,
    statusFilter: 'CURRENT' | 'OUTDATED' | 'ALL',
  ): Promise<DestinationNoteListResponse | null> {
    const db = getDatabase();
    const dest = await db.select().from(destinations).where(eq(destinations.id, destinationId)).get();
    if (!dest) return null;

    const notes = await db
      .select()
      .from(destinationNotes)
      .where(eq(destinationNotes.destinationId, destinationId))
      .orderBy(desc(destinationNotes.updatedAt));

    const filteredNotes =
      statusFilter === 'ALL' ? notes : notes.filter((n) => n.status === statusFilter);

    const noteIds = filteredNotes.map((n) => n.id);
    const sourceCounts = new Map<number, number>();
    if (noteIds.length > 0) {
      const rows = await db
        .select({ noteId: destinationNoteSources.noteId })
        .from(destinationNoteSources)
        .where(inArray(destinationNoteSources.noteId, noteIds));
      for (const row of rows) {
        sourceCounts.set(row.noteId, (sourceCounts.get(row.noteId) ?? 0) + 1);
      }
    }

    const sources = await this.listDestinationSourceVoices(destinationId);
    const insights = await this.listDestinationInsights(destinationId);

    const logs = await db
      .select({
        id: destinationNoteLogs.id,
        eventType: destinationNoteLogs.eventType,
        noteId: destinationNoteLogs.noteId,
        reason: destinationNoteLogs.reason,
        sourceAudioIds: destinationNoteLogs.sourceAudioIds,
        createdAt: destinationNoteLogs.createdAt,
        noteTitle: destinationNotes.currentTitle,
      })
      .from(destinationNoteLogs)
      .leftJoin(destinationNotes, eq(destinationNotes.id, destinationNoteLogs.noteId))
      .where(eq(destinationNoteLogs.destinationId, destinationId))
      .orderBy(desc(destinationNoteLogs.createdAt));

    return {
      destinationId,
      canonicalName: dest.canonicalName,
      notes: filteredNotes.map((n) => ({
        id: n.id,
        title: n.currentTitle,
        description: n.currentDescription,
        status: n.status as DestinationNoteStatus,
        relevantDate: n.relevantDate,
        firstObservedAt: n.firstObservedAt.toISOString(),
        lastUpdatedAt: n.lastUpdatedAt.toISOString(),
        sourceCount: sourceCounts.get(n.id) ?? 0,
        kind: n.noteKind as DestinationNoteListResponse['notes'][number]['kind'],
        scopeType: n.scopeType as DestinationNoteListResponse['notes'][number]['scopeType'],
        tourSubject: n.tourSubject,
      })),
      insights,
      sources,
      logs: logs.map((l) => ({
        id: l.id,
        eventType: l.eventType as DestinationNoteListResponse['logs'][number]['eventType'],
        noteId: l.noteId,
        noteTitle: l.noteTitle,
        reason: l.reason,
        sourceAudioIds: l.sourceAudioIds ? (JSON.parse(l.sourceAudioIds) as number[]) : [],
        createdAt: l.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Source voices of a destination, grouped by transcript (one audio = one
   * transcript). A voice appears exactly once even when it sources many notes.
   */
  async listDestinationSourceVoices(destinationId: number): Promise<DestinationNoteSourceItem[]> {
    const db = getDatabase();
    const rows = await db
      .select({
        audioId: destinationNoteSources.audioId,
        transcriptId: destinationNoteSources.transcriptId,
        audioNameSnapshot: destinationNoteSources.audioNameSnapshot,
        audioName: audioFiles.originalName,
        createdAt: destinationNoteSources.createdAt,
      })
      .from(destinationNoteSources)
      .innerJoin(destinationNotes, eq(destinationNotes.id, destinationNoteSources.noteId))
      .leftJoin(audioFiles, eq(audioFiles.id, destinationNoteSources.audioId))
      .where(eq(destinationNotes.destinationId, destinationId));

    const byTranscript = new Map<number, DestinationNoteSourceItem>();
    for (const row of rows) {
      const existing = byTranscript.get(row.transcriptId);
      const fileName = row.audioNameSnapshot ?? row.audioName ?? `صوت #${row.transcriptId}`;
      if (existing) {
        existing.noteCount += 1;
        if (row.createdAt.getTime() > new Date(existing.processedAt).getTime()) {
          existing.processedAt = row.createdAt.toISOString();
        }
      } else {
        byTranscript.set(row.transcriptId, {
          audioId: row.audioId,
          transcriptId: row.transcriptId,
          fileName,
          processedAt: row.createdAt.toISOString(),
          transcriptAvailable: true,
          noteCount: 1,
        });
      }
    }

    return [...byTranscript.values()].sort(
      (a, b) => new Date(b.processedAt).getTime() - new Date(a.processedAt).getTime(),
    );
  }

  /**
   * Full extracted notes of one source voice for one destination (source
   * detail). Every note a voice produced for this destination is returned with
   * its complete title and description — never summarized.
   */
  async listSourceVoiceNotes(
    destinationId: number,
    transcriptId: number,
  ): Promise<DestinationSourceVoiceNotesResponse | null> {
    const db = getDatabase();
    const rows = await db
      .select({
        title: destinationNotes.currentTitle,
        description: destinationNotes.currentDescription,
        relevantDate: destinationNotes.relevantDate,
        status: destinationNotes.status,
        sourceCreatedAt: destinationNoteSources.createdAt,
        audioNameSnapshot: destinationNoteSources.audioNameSnapshot,
        audioName: audioFiles.originalName,
      })
      .from(destinationNoteSources)
      .innerJoin(destinationNotes, eq(destinationNotes.id, destinationNoteSources.noteId))
      .leftJoin(audioFiles, eq(audioFiles.id, destinationNoteSources.audioId))
      .where(
        and(
          eq(destinationNotes.destinationId, destinationId),
          eq(destinationNoteSources.transcriptId, transcriptId),
        ),
      )
      .orderBy(destinationNoteSources.id);
    if (rows.length === 0) return null;

    const fileName = rows[0]?.audioNameSnapshot ?? rows[0]?.audioName ?? `صوت #${transcriptId}`;
    const processedAt = rows[0]?.sourceCreatedAt.toISOString() ?? new Date().toISOString();
    return {
      destinationId,
      transcriptId,
      fileName,
      processedAt,
      notes: rows.map((row) => ({
        title: row.title,
        description: row.description,
        relevantDate: row.relevantDate,
        status: row.status as DestinationNoteStatus,
      })),
    };
  }

  /**
   * Inferred audience insights of a destination (deduplicated, evidence-backed).
   */
  async listDestinationInsights(destinationId: number): Promise<AudienceInsightItem[]> {
    const db = getDatabase();
    const rows = await db
      .select()
      .from(destinationAudienceInsights)
      .where(eq(destinationAudienceInsights.destinationId, destinationId))
      .orderBy(desc(destinationAudienceInsights.updatedAt));

    const ids = rows.map((row) => row.id);
    const sourceCounts = new Map<number, number>();
    if (ids.length > 0) {
      const sourceRows = await db
        .select({ insightId: destinationInsightSources.insightId })
        .from(destinationInsightSources)
        .where(inArray(destinationInsightSources.insightId, ids));
      for (const row of sourceRows) {
        sourceCounts.set(row.insightId, (sourceCounts.get(row.insightId) ?? 0) + 1);
      }
    }

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      inferenceBasis: row.inferenceBasis,
      confidence: row.confidence,
      contentOpportunityTitle: row.contentOpportunityTitle,
      contentOpportunityReason: row.contentOpportunityReason,
      status: row.status as AudienceInsightItem['status'],
      firstObservedAt: row.firstObservedAt.toISOString(),
      lastUpdatedAt: row.lastUpdatedAt.toISOString(),
      sourceCount: sourceCounts.get(row.id) ?? 0,
    }));
  }

  /**
   * Delete a destination and every destination-scoped row. Shared audio,
   * transcripts and sessions are preserved so a voice that sourced several
   * destinations keeps its other destinations intact.
   */
  async deleteDestination(destinationId: number): Promise<{ deleted: boolean }> {
    const db = getDatabase();
    const dest = await db.select().from(destinations).where(eq(destinations.id, destinationId)).get();
    if (!dest) throw new Error('destination not found');

    const noteIds = (
      await db
        .select({ id: destinationNotes.id })
        .from(destinationNotes)
        .where(eq(destinationNotes.destinationId, destinationId))
    ).map((row) => row.id);
    const knowledgeIds = (
      await db
        .select({ id: knowledgeItems.id })
        .from(knowledgeItems)
        .where(eq(knowledgeItems.destinationId, destinationId))
    ).map((row) => row.id);
    const candidateIds = (
      await db
        .select({ id: knowledgeCandidates.id })
        .from(knowledgeCandidates)
        .where(eq(knowledgeCandidates.destinationId, destinationId))
    ).map((row) => row.id);
    const contentIds = (
      await db
        .select({ id: generatedContents.id })
        .from(generatedContents)
        .where(eq(generatedContents.destinationId, destinationId))
    ).map((row) => row.id);
    const insightIds = (
      await db
        .select({ id: destinationAudienceInsights.id })
        .from(destinationAudienceInsights)
        .where(eq(destinationAudienceInsights.destinationId, destinationId))
    ).map((row) => row.id);

    await db.transaction(async (tx) => {
      // Legacy content/change traceability (children first).
      if (contentIds.length > 0) {
        await tx
          .delete(generatedContentKnowledge)
          .where(inArray(generatedContentKnowledge.generatedContentId, contentIds));
        await tx.delete(generatedContents).where(inArray(generatedContents.id, contentIds));
      }
      if (knowledgeIds.length > 0) {
        await tx
          .delete(generatedContentKnowledge)
          .where(inArray(generatedContentKnowledge.knowledgeId, knowledgeIds));
        await tx
          .delete(knowledgeChanges)
          .where(
            or(
              inArray(knowledgeChanges.knowledgeId, knowledgeIds),
              eq(knowledgeChanges.destinationId, destinationId),
            ),
          );
        await tx.delete(knowledgeEvidence).where(inArray(knowledgeEvidence.knowledgeId, knowledgeIds));
        await tx.delete(knowledgeVersions).where(inArray(knowledgeVersions.knowledgeId, knowledgeIds));
      } else {
        await tx.delete(knowledgeChanges).where(eq(knowledgeChanges.destinationId, destinationId));
      }
      await tx.delete(knowledgeConflicts).where(eq(knowledgeConflicts.destinationId, destinationId));
      if (candidateIds.length > 0) {
        await tx.delete(knowledgeDeltaDecisions).where(inArray(knowledgeDeltaDecisions.candidateId, candidateIds));
        await tx.delete(knowledgeCandidates).where(inArray(knowledgeCandidates.id, candidateIds));
      }
      if (knowledgeIds.length > 0) {
        await tx.delete(knowledgeItems).where(inArray(knowledgeItems.id, knowledgeIds));
      }

      // Loosely-linked embedding cache rows (no FK constraint).
      if (noteIds.length > 0) {
        await tx.delete(knowledgeEmbeddings).where(inArray(knowledgeEmbeddings.noteId, noteIds));
      }
      if (knowledgeIds.length > 0) {
        await tx.delete(knowledgeEmbeddings).where(inArray(knowledgeEmbeddings.knowledgeId, knowledgeIds));
      }
      if (candidateIds.length > 0) {
        await tx.delete(knowledgeEmbeddings).where(inArray(knowledgeEmbeddings.candidateId, candidateIds));
      }

      // Destination link/summary tables (NOT NULL FKs to destinations).
      await tx.delete(batchDestinationSummaries).where(eq(batchDestinationSummaries.destinationId, destinationId));
      await tx.delete(transcriptDestinations).where(eq(transcriptDestinations.destinationId, destinationId));

      // Simplified note model.
      if (noteIds.length > 0) {
        await tx.delete(destinationNoteSources).where(inArray(destinationNoteSources.noteId, noteIds));
        await tx.delete(destinationNoteVersions).where(inArray(destinationNoteVersions.noteId, noteIds));
      }
      await tx.delete(destinationNoteLogs).where(eq(destinationNoteLogs.destinationId, destinationId));
      await tx.delete(destinationNotes).where(eq(destinationNotes.destinationId, destinationId));
      await tx.delete(noteProposals).where(eq(noteProposals.destinationId, destinationId));

      // Audience insights, their sources, proposals and processing news.
      if (insightIds.length > 0) {
        await tx.delete(destinationInsightSources).where(inArray(destinationInsightSources.insightId, insightIds));
        await tx.delete(destinationAudienceInsights).where(inArray(destinationAudienceInsights.id, insightIds));
      }
      await tx.delete(insightProposals).where(eq(insightProposals.destinationId, destinationId));
      await tx.delete(processingDestinationNews).where(eq(processingDestinationNews.destinationId, destinationId));

      await tx.delete(destinationAliases).where(eq(destinationAliases.destinationId, destinationId));
      await tx.delete(destinations).where(eq(destinations.id, destinationId));
    });

    return { deleted: true };
  }
}

export const destinationNotesService = new DestinationNotesService();
