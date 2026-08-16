import type { FastifyInstance } from 'fastify';
import type {
  ApiErrorResponse,
  CleanTranscriptResponse,
  DestinationListItem,
  DestinationNoteListResponse,
  DestinationSourceVoiceNotesResponse,
} from '@freebuff/contracts';
import { eq } from 'drizzle-orm';
import { getDatabase } from '../core/database/client.js';
import { audioFiles, transcripts, transcriptSegments } from '../core/database/schema.js';
import { destinationNotesService } from '../services/destination-notes.service.js';
import { sessionsService } from '../services/sessions.service.js';
import { toErrorResponse } from './error-response.js';

export async function destinationNoteRoutes(app: FastifyInstance): Promise<void> {
  // Simplified destination list (notes-based, no legacy knowledge counts).
  app.get('/api/destination-notes', async (request, reply): Promise<DestinationListItem[] | ApiErrorResponse> => {
    try {
      return await sessionsService.listDestinations();
    } catch (error) {
      request.log.error({ err: error }, 'Failed to list destinations');
      return toErrorResponse(reply, error);
    }
  });

  // Destination detail: notes (filtered), source voices and change-log timeline.
  app.get(
    '/api/destination-notes/:id',
    async (request, reply): Promise<DestinationNoteListResponse | ApiErrorResponse> => {
      try {
        const { id } = request.params as { id: string };
        const { status } = request.query as { status?: string };
        const filter = status === 'OUTDATED' || status === 'ALL' ? status : 'CURRENT';
        const detail = await destinationNotesService.getDetail(Number(id), filter);
        if (!detail) {
          reply.code(404);
          return { error: { code: 'BATCH_NOT_FOUND', message: 'مقصد پیدا نشد.' } };
        }
        return detail;
      } catch (error) {
        request.log.error({ err: error }, 'Failed to load destination notes');
        return toErrorResponse(reply, error);
      }
    },
  );

  // Full extracted notes of one source voice for one destination (source detail).
  app.get(
    '/api/destination-notes/:id/sources/:transcriptId/notes',
    async (request, reply): Promise<DestinationSourceVoiceNotesResponse | ApiErrorResponse> => {
      try {
        const { id, transcriptId } = request.params as { id: string; transcriptId: string };
        const result = await destinationNotesService.listSourceVoiceNotes(Number(id), Number(transcriptId));
        if (!result) {
          reply.code(404);
          return { error: { code: 'BATCH_NOT_FOUND', message: 'نکته‌ای برای این ویس منبع یافت نشد.' } };
        }
        return result;
      } catch (error) {
        request.log.error({ err: error }, 'Failed to load source voice notes');
        return toErrorResponse(reply, error);
      }
    },
  );

  // حذف مقصد — destination-scoped cascade, shared audio/transcripts preserved.
  app.delete(
    '/api/destination-notes/:id',
    async (request, reply): Promise<{ deleted: boolean } | ApiErrorResponse> => {
      try {
        const { id } = request.params as { id: string };
        const result = await destinationNotesService.deleteDestination(Number(id));
        return result;
      } catch (error) {
        request.log.error({ err: error }, 'Failed to delete destination');
        return toErrorResponse(reply, error);
      }
    },
  );

  // Clean transcript for a source voice (works even after the audio is deleted).
  app.get(
    '/api/transcripts/:id',
    async (request, reply): Promise<CleanTranscriptResponse | ApiErrorResponse> => {
      try {
        const { id } = request.params as { id: string };
        const db = getDatabase();
        const transcript = await db
          .select()
          .from(transcripts)
          .where(eq(transcripts.id, Number(id)))
          .get();
        if (!transcript) {
          reply.code(404);
          return { error: { code: 'TRANSCRIPT_NOT_FOUND', message: 'Transcript برای این فایل یافت نشد.' } };
        }
        const audio = await db
          .select({ id: audioFiles.id, originalName: audioFiles.originalName })
          .from(audioFiles)
          .where(eq(audioFiles.id, transcript.audioId))
          .get();
        const segments = await db
          .select({
            sequence: transcriptSegments.sequence,
            speaker: transcriptSegments.speaker,
            text: transcriptSegments.text,
          })
          .from(transcriptSegments)
          .where(eq(transcriptSegments.transcriptId, transcript.id))
          .orderBy(transcriptSegments.sequence);
        return {
          audioId: transcript.audioId,
          audioName: audio?.originalName ?? 'ویس حذف‌شده',
          processedAt: transcript.createdAt.toISOString(),
          segments: segments.map((segment) => ({
            sequence: segment.sequence,
            speaker: segment.speaker,
            text: segment.text,
          })),
          text: transcript.fullText,
        };
      } catch (error) {
        request.log.error({ err: error }, 'Failed to load transcript');
        return toErrorResponse(reply, error);
      }
    },
  );

  // Clean transcript for any audio (used by the destination "source voices" tab).
  app.get(
    '/api/audio/:id/transcript',
    async (request, reply): Promise<CleanTranscriptResponse | ApiErrorResponse> => {
      try {
        const { id } = request.params as { id: string };
        const db = getDatabase();
        const audio = await db
          .select({ id: audioFiles.id, originalName: audioFiles.originalName })
          .from(audioFiles)
          .where(eq(audioFiles.id, Number(id)))
          .get();
        if (!audio) {
          reply.code(404);
          return { error: { code: 'TRANSCRIPT_NOT_FOUND', message: 'فایل صوتی یافت نشد.' } };
        }
        const transcript = await db
          .select()
          .from(transcripts)
          .where(eq(transcripts.audioId, audio.id))
          .orderBy(transcripts.createdAt)
          .get();
        if (!transcript) {
          reply.code(404);
          return { error: { code: 'TRANSCRIPT_NOT_FOUND', message: 'Transcript برای این فایل یافت نشد.' } };
        }
        const segments = await db
          .select({
            sequence: transcriptSegments.sequence,
            speaker: transcriptSegments.speaker,
            text: transcriptSegments.text,
          })
          .from(transcriptSegments)
          .where(eq(transcriptSegments.transcriptId, transcript.id))
          .orderBy(transcriptSegments.sequence);
        return {
          audioId: audio.id,
          audioName: audio.originalName,
          processedAt: transcript.createdAt.toISOString(),
          segments: segments.map((segment) => ({
            sequence: segment.sequence,
            speaker: segment.speaker,
            text: segment.text,
          })),
          text: transcript.fullText,
        };
      } catch (error) {
        request.log.error({ err: error }, 'Failed to load transcript');
        return toErrorResponse(reply, error);
      }
    },
  );
}
