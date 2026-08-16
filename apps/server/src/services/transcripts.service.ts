import type {
  TranscriptInfo,
  TranscriptKnowledgeInfo,
  TranscriptResponse,
  TranscriptSegmentInfo,
} from '@freebuff/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { getDatabase } from '../core/database/client.js';
import {
  audioFiles,
  destinations,
  knowledgeEvidence,
  knowledgeItems,
  knowledgeVersions,
  transcriptDestinations,
  transcriptSegments,
  transcripts,
} from '../core/database/schema.js';
import { DomainError } from './errors.js';

function toTranscriptInfo(row: typeof transcripts.$inferSelect): TranscriptInfo {
  return {
    id: row.id,
    audioId: row.audioId,
    fullText: row.fullText,
    normalizedText: row.normalizedText,
    normalizedHash: row.normalizedHash,
    language: row.language,
    modelId: row.modelId,
    promptVersionId: row.promptVersionId,
    status: row.status as TranscriptInfo['status'],
    duplicateOfTranscriptId: row.duplicateOfTranscriptId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Read-side access to stored transcripts (the viewer backend). */
export class TranscriptsService {
  /**
   * The current COMPLETED transcript for an audio file, with its segments,
   * or null when none exists yet.
   */
  async getForAudio(audioId: number): Promise<TranscriptResponse | null> {
    const db = getDatabase();
    const audio = await db.select().from(audioFiles).where(eq(audioFiles.id, audioId)).get();
    if (!audio) {
      throw new DomainError('AUDIO_FILE_NOT_FOUND', 'فایل صوتی یافت نشد.');
    }
    const transcript = await db
      .select()
      .from(transcripts)
      .where(and(eq(transcripts.audioId, audioId), eq(transcripts.status, 'COMPLETED')))
      .orderBy(desc(transcripts.id))
      .limit(1)
      .get();
    if (!transcript) return null;

    const segments = await db
      .select()
      .from(transcriptSegments)
      .where(eq(transcriptSegments.transcriptId, transcript.id))
      .orderBy(transcriptSegments.sequence);

    const segmentInfos: TranscriptSegmentInfo[] = segments.map((segment) => ({
      id: segment.id,
      sequence: segment.sequence,
      speaker: segment.speaker,
      text: segment.text,
      normalizedText: segment.normalizedText,
      startTime: segment.startTime,
      endTime: segment.endTime,
    }));

    return {
      audioId,
      audioName: audio.originalName,
      transcript: toTranscriptInfo(transcript),
      segments: segmentInfos,
    };
  }

  /** Destinations and knowledge extracted from a transcript (traceability). */
  async getKnowledgeForAudio(audioId: number): Promise<TranscriptKnowledgeInfo | null> {
    const db = getDatabase();
    const transcript = await db
      .select()
      .from(transcripts)
      .where(and(eq(transcripts.audioId, audioId), eq(transcripts.status, 'COMPLETED')))
      .orderBy(desc(transcripts.id))
      .limit(1)
      .get();
    if (!transcript) return null;

    const destLinks = await db
      .select({
        id: destinations.id,
        canonicalName: destinations.canonicalName,
        type: destinations.type,
        confidence: transcriptDestinations.confidence,
      })
      .from(transcriptDestinations)
      .innerJoin(destinations, eq(destinations.id, transcriptDestinations.destinationId))
      .where(eq(transcriptDestinations.transcriptId, transcript.id));

    const joined = await db
      .select({
        id: knowledgeItems.id,
        knowledgeType: knowledgeItems.knowledgeType,
        category: knowledgeItems.category,
        entityType: knowledgeItems.entityType,
        entityName: knowledgeItems.entityName,
        attribute: knowledgeItems.attribute,
        status: knowledgeItems.status,
        canonicalText: knowledgeItems.canonicalText,
      })
      .from(knowledgeItems)
      .innerJoin(knowledgeEvidence, eq(knowledgeEvidence.knowledgeId, knowledgeItems.id))
      .where(eq(knowledgeEvidence.transcriptId, transcript.id));

    const versions = await db
      .select({
        knowledgeId: knowledgeVersions.knowledgeId,
        valueText: knowledgeVersions.valueText,
        unit: knowledgeVersions.unit,
      })
      .from(knowledgeVersions)
      .where(eq(knowledgeVersions.isCurrent, true));
    const versionByItem = new Map(versions.map((v) => [v.knowledgeId, v]));

    return {
      destinations: destLinks.map((d) => ({
        id: d.id,
        canonicalName: d.canonicalName,
        type: d.type as TranscriptKnowledgeInfo['destinations'][number]['type'],
        confidence: d.confidence,
      })),
      knowledge: joined.map((item) => {
        const version = versionByItem.get(item.id);
        return {
          id: item.id,
          knowledgeType: item.knowledgeType as TranscriptKnowledgeInfo['knowledge'][number]['knowledgeType'],
          entityType: item.entityType,
          entityName: item.entityName,
          attribute: item.attribute,
          currentValue: version?.valueText ?? null,
          unit: version?.unit ?? null,
          status: item.status as TranscriptKnowledgeInfo['knowledge'][number]['status'],
          canonicalText: item.canonicalText,
        };
      }),
    };
  }
}

export const transcriptsService = new TranscriptsService();
