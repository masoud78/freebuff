import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import type {
  ApiErrorResponse,
  CleanTranscriptResponse,
  CommitResponse,
  SessionDetail,
  SessionSummary,
} from '@freebuff/contracts';
import { eq } from 'drizzle-orm';
import { getDatabase } from '../core/database/client.js';
import { audioFiles, transcripts, transcriptSegments } from '../core/database/schema.js';
import { noteExtractionWorker } from '../services/knowledge/note-extraction.worker.js';
import { sessionsService, type UploadedFile } from '../services/sessions.service.js';
import { transcriptionWorker } from '../services/transcription/worker.js';
import { toErrorResponse } from './error-response.js';

const MAX_FILE_BYTES = 200 * 1024 * 1024; // 200 MB per file.

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  await app.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: 200 } });

  app.post('/api/sessions', async (request, reply): Promise<SessionSummary | ApiErrorResponse> => {
    try {
      return await sessionsService.createSession();
    } catch (error) {
      request.log.error({ err: error }, 'Failed to create session');
      return toErrorResponse(reply, error);
    }
  });

  // Lazy processing creation: the session is only persisted together with the
  // first successful upload. No empty session is ever created in advance.
  app.post('/api/sessions/upload', async (request, reply): Promise<unknown | ApiErrorResponse> => {
    try {
      if (!request.isMultipart()) {
        reply.code(400);
        return { error: { code: 'AUDIO_FORMAT_UNSUPPORTED', message: 'درخواست باید Multipart باشد.' } };
      }
      const files: UploadedFile[] = [];
      for await (const part of request.parts()) {
        if (part.type !== 'file') continue;
        files.push({
          filename: part.filename,
          mimeType: part.mimetype,
          data: await part.toBuffer(),
        });
      }
      if (files.length === 0) {
        reply.code(400);
        return { error: { code: 'AUDIO_FILE_NOT_FOUND', message: 'هیچ فایلی آپلود نشد.' } };
      }
      const { session, upload } = await sessionsService.createSessionWithFirstUpload(files);
      return { session, ...upload };
    } catch (error) {
      request.log.error({ err: error }, 'Failed to create session with first upload');
      return toErrorResponse(reply, error);
    }
  });

  app.get('/api/sessions', async (request, reply): Promise<SessionSummary[] | ApiErrorResponse> => {
    try {
      return await sessionsService.listSessions();
    } catch (error) {
      request.log.error({ err: error }, 'Failed to list sessions');
      return toErrorResponse(reply, error);
    }
  });

  app.get('/api/sessions/:id', async (request, reply): Promise<SessionDetail | ApiErrorResponse> => {
    try {
      const { id } = request.params as { id: string };
      return await sessionsService.getSession(Number(id));
    } catch (error) {
      request.log.error({ err: error }, 'Failed to load session');
      return toErrorResponse(reply, error);
    }
  });

  // Real browser file upload (multipart). Files land in `{workspace}/audio/{sessionId}/`.
  app.post('/api/sessions/:id/upload', async (request, reply): Promise<unknown | ApiErrorResponse> => {
    try {
      const { id } = request.params as { id: string };
      if (!request.isMultipart()) {
        reply.code(400);
        return { error: { code: 'AUDIO_FORMAT_UNSUPPORTED', message: 'درخواست باید Multipart باشد.' } };
      }
      const files: UploadedFile[] = [];
      for await (const part of request.parts()) {
        if (part.type !== 'file') continue;
        files.push({
          filename: part.filename,
          mimeType: part.mimetype,
          data: await part.toBuffer(),
        });
      }
      if (files.length === 0) {
        reply.code(400);
        return { error: { code: 'AUDIO_FILE_NOT_FOUND', message: 'هیچ فایلی آپلود نشد.' } };
      }
      const result = await sessionsService.uploadFiles(Number(id), files);
      return result;
    } catch (error) {
      request.log.error({ err: error }, 'Failed to upload files');
      return toErrorResponse(reply, error);
    }
  });

  // «تبدیل همه به متن» — queue transcription jobs, then wake the worker.
  app.post('/api/sessions/:id/transcribe', async (request, reply): Promise<SessionDetail | ApiErrorResponse> => {
    try {
      const { id } = request.params as { id: string };
      const session = await sessionsService.startTranscription(Number(id));
      transcriptionWorker.wake();
      return session;
    } catch (error) {
      request.log.error({ err: error }, 'Failed to start transcription');
      return toErrorResponse(reply, error);
    }
  });

  // Retry one permanently failed audio («تلاش مجدد»).
  app.post(
    '/api/sessions/:id/audio/:audioId/retry',
    async (request, reply): Promise<SessionDetail | ApiErrorResponse> => {
      try {
        const { id, audioId } = request.params as { id: string; audioId: string };
        const session = await sessionsService.retryTranscription(Number(id), Number(audioId));
        transcriptionWorker.wake();
        return session;
      } catch (error) {
        request.log.error({ err: error }, 'Failed to retry transcription');
        return toErrorResponse(reply, error);
      }
    },
  );

  // «رفتن برای پردازش» — queue note-extraction jobs, then wake the worker.
  app.post('/api/sessions/:id/process', async (request, reply): Promise<SessionDetail | ApiErrorResponse> => {
    try {
      const { id } = request.params as { id: string };
      const session = await sessionsService.startProcessing(Number(id));
      noteExtractionWorker.wake();
      return session;
    } catch (error) {
      request.log.error({ err: error }, 'Failed to start processing');
      return toErrorResponse(reply, error);
    }
  });

  // «اعمال تغییرات در دیتابیس» — apply proposals transactionally.
  app.post('/api/sessions/:id/commit', async (request, reply): Promise<CommitResponse | ApiErrorResponse> => {
    try {
      const { id } = request.params as { id: string };
      return await sessionsService.commit(Number(id));
    } catch (error) {
      request.log.error({ err: error }, 'Failed to commit session');
      return toErrorResponse(reply, error);
    }
  });

  // حذف ویس — safe cascade (uncommitted: full delete; committed: audit-safe).
  app.delete(
    '/api/sessions/:id/audio/:audioId',
    async (request, reply): Promise<{ deleted: boolean; committed: boolean } | ApiErrorResponse> => {
      try {
        const { id, audioId } = request.params as { id: string; audioId: string };
        return await sessionsService.deleteVoice(Number(id), Number(audioId));
      } catch (error) {
        request.log.error({ err: error }, 'Failed to delete voice');
        return toErrorResponse(reply, error);
      }
    },
  );

  // حذف پردازش — full session deletion (committed knowledge preserved).
  app.delete('/api/sessions/:id', async (request, reply): Promise<{ deleted: boolean; committed: boolean } | ApiErrorResponse> => {
    try {
      const { id } = request.params as { id: string };
      return await sessionsService.deleteSession(Number(id));
    } catch (error) {
      request.log.error({ err: error }, 'Failed to delete session');
      return toErrorResponse(reply, error);
    }
  });

  // Clean, user-facing transcript (speaker segments + plain text, nothing else).
  app.get(
    '/api/sessions/:id/audio/:audioId/transcript',
    async (request, reply): Promise<CleanTranscriptResponse | ApiErrorResponse> => {
      try {
        const { audioId } = request.params as { id: string; audioId: string };
        const db = getDatabase();
        const audio = await db
          .select({ id: audioFiles.id, originalName: audioFiles.originalName })
          .from(audioFiles)
          .where(eq(audioFiles.id, Number(audioId)))
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
