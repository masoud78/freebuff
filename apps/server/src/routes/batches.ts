import type { FastifyInstance } from 'fastify';
import type {
  ApiErrorResponse,
  BatchDetailResponse,
  BatchListResponse,
  BatchSummary,
  TranscriptKnowledgeInfo,
  TranscriptResponse,
} from '@freebuff/contracts';
import { batchService } from '../services/batches.service.js';
import { transcriptsService } from '../services/transcripts.service.js';
import { transcriptionWorker } from '../services/transcription/worker.js';
import { toErrorResponse } from './error-response.js';

export async function batchRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/batches',
    async (request, reply): Promise<BatchListResponse | ApiErrorResponse> => {
      try {
        return await batchService.listBatches();
      } catch (error) {
        request.log.error({ err: error }, 'Failed to list batches');
        return toErrorResponse(reply, error);
      }
    },
  );

  // Create a new batch (no scan yet — the UI then calls /scan).
  app.post('/api/batches', async (request, reply): Promise<BatchSummary | ApiErrorResponse> => {
    try {
      return await batchService.createBatch();
    } catch (error) {
      request.log.error({ err: error }, 'Failed to create batch');
      return toErrorResponse(reply, error);
    }
  });

  app.get(
    '/api/batches/:id',
    async (request, reply): Promise<BatchDetailResponse | ApiErrorResponse> => {
      try {
        const { id } = request.params as { id: string };
        return await batchService.getBatch(Number(id));
      } catch (error) {
        request.log.error({ err: error }, 'Failed to load batch');
        return toErrorResponse(reply, error);
      }
    },
  );

  app.post(
    '/api/batches/:id/scan',
    async (request, reply): Promise<BatchSummary | ApiErrorResponse> => {
      try {
        const { id } = request.params as { id: string };
        return await batchService.scanBatch(Number(id), request.log);
      } catch (error) {
        request.log.error({ err: error }, 'Failed to scan batch');
        return toErrorResponse(reply, error);
      }
    },
  );

  app.get(
    '/api/batches/:id/audio',
    async (request, reply): Promise<BatchDetailResponse | ApiErrorResponse> => {
      try {
        const { id } = request.params as { id: string };
        return await batchService.getBatch(Number(id));
      } catch (error) {
        request.log.error({ err: error }, 'Failed to load batch audio');
        return toErrorResponse(reply, error);
      }
    },
  );

  // Mark a ready batch PROCESSING and wake the worker (never synchronous).
  app.post(
    '/api/batches/:id/start',
    async (request, reply): Promise<BatchDetailResponse | ApiErrorResponse> => {
      try {
        const { id } = request.params as { id: string };
        const batch = await batchService.startBatch(Number(id));
        transcriptionWorker.wake();
        return batch;
      } catch (error) {
        request.log.error({ err: error }, 'Failed to start batch');
        return toErrorResponse(reply, error);
      }
    },
  );

  app.get(
    '/api/batches/:batchId/audio/:audioId/transcript',
    async (request, reply): Promise<TranscriptResponse | ApiErrorResponse> => {
      try {
        const { audioId } = request.params as { batchId: string; audioId: string };
        const transcript = await transcriptsService.getForAudio(Number(audioId));
        if (!transcript) {
          reply.code(404);
          return {
            error: { code: 'TRANSCRIPTION_FAILED', message: 'Transcript برای این فایل یافت نشد.' },
          };
        }
        return transcript;
      } catch (error) {
        request.log.error({ err: error }, 'Failed to load transcript');
        return toErrorResponse(reply, error);
      }
    },
  );

  // Destinations + knowledge extracted from a transcript (traceability).
  app.get(
    '/api/batches/:batchId/audio/:audioId/knowledge',
    async (request, reply): Promise<TranscriptKnowledgeInfo | ApiErrorResponse> => {
      try {
        const { audioId } = request.params as { batchId: string; audioId: string };
        const info = await transcriptsService.getKnowledgeForAudio(Number(audioId));
        if (!info) {
          reply.code(404);
          return {
            error: { code: 'TRANSCRIPT_NOT_FOUND', message: 'تحلیل دانش برای این فایل یافت نشد.' },
          };
        }
        return info;
      } catch (error) {
        request.log.error({ err: error }, 'Failed to load transcript knowledge');
        return toErrorResponse(reply, error);
      }
    },
  );
}
