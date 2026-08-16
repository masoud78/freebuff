import type { FastifyInstance } from 'fastify';
import type {
  ApiErrorResponse,
  AudioRetryResponse,
  BatchDetailResponse,
  BatchJobsResponse,
  BatchListResponse,
  BatchRetryResponse,
  BatchSummary,
  CancelBatchResponse,
  TranscriptKnowledgeInfo,
  TranscriptResponse,
} from '@freebuff/contracts';
import { batchService } from '../services/batches.service.js';
import { transcriptsService } from '../services/transcripts.service.js';
import { transcriptionWorker } from '../services/transcription/worker.js';
import { knowledgeWorker } from '../services/knowledge/knowledge.worker.js';
import { deltaWorker } from '../services/knowledge/delta.worker.js';
import { reconciliationWorker } from '../services/knowledge/reconciliation.worker.js';
import { contentWorker } from '../services/content/content.worker.js';
import { toErrorResponse } from './error-response.js';

/** Wake every persistent worker so a retried batch starts immediately. */
function wakeAllWorkers(): void {
  transcriptionWorker.wake();
  knowledgeWorker.wake();
  deltaWorker.wake();
  reconciliationWorker.wake();
  contentWorker.wake();
}

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
        wakeAllWorkers();
        return batch;
      } catch (error) {
        request.log.error({ err: error }, 'Failed to start batch');
        return toErrorResponse(reply, error);
      }
    },
  );

  // Retry every permanently-failed job of a batch (Phase 12 §9).
  app.post(
    '/api/batches/:id/retry-failed',
    async (request, reply): Promise<BatchRetryResponse | ApiErrorResponse> => {
      try {
        const { id } = request.params as { id: string };
        const result = await batchService.retryFailedJobs(Number(id));
        wakeAllWorkers();
        return { batchId: Number(id), ...result };
      } catch (error) {
        request.log.error({ err: error }, 'Failed to retry batch jobs');
        return toErrorResponse(reply, error);
      }
    },
  );

  // Retry one failed audio (Phase 12 §9).
  app.post(
    '/api/batches/:batchId/audio/:audioId/retry',
    async (request, reply): Promise<AudioRetryResponse | ApiErrorResponse> => {
      try {
        const { batchId, audioId } = request.params as { batchId: string; audioId: string };
        const result = await batchService.retryAudio(Number(batchId), Number(audioId));
        wakeAllWorkers();
        return { batchId: Number(batchId), audioId: Number(audioId), ...result };
      } catch (error) {
        request.log.error({ err: error }, 'Failed to retry audio');
        return toErrorResponse(reply, error);
      }
    },
  );

  // Cancel a batch: pending jobs cancelled, master knowledge intact (Phase 12 §36).
  app.post(
    '/api/batches/:id/cancel',
    async (request, reply): Promise<CancelBatchResponse | ApiErrorResponse> => {
      try {
        const { id } = request.params as { id: string };
        const result = await batchService.cancelBatch(Number(id));
        return { batchId: Number(id), cancelled: true, ...result };
      } catch (error) {
        request.log.error({ err: error }, 'Failed to cancel batch');
        return toErrorResponse(reply, error);
      }
    },
  );

  // Failed jobs of a batch (actionable failure details for the Batch UI).
  app.get(
    '/api/batches/:id/jobs',
    async (request, reply): Promise<BatchJobsResponse | ApiErrorResponse> => {
      try {
        const { id } = request.params as { id: string };
        const batchId = Number(id);
        const rows = await batchService.listBatchJobs(batchId);
        return {
          batchId,
          jobs: rows.map((row) => ({
            id: row.id,
            jobType: row.jobType as BatchJobsResponse['jobs'][number]['jobType'],
            entityId: row.entityId,
            status: row.status as BatchJobsResponse['jobs'][number]['status'],
            attempt: row.attempt,
            maxAttempts: row.maxAttempts,
            errorCode: row.errorCode,
            errorMessage: row.errorMessage,
            createdAt: row.createdAt.toISOString(),
            completedAt: row.completedAt?.toISOString() ?? null,
          })),
        };
      } catch (error) {
        request.log.error({ err: error }, 'Failed to load batch jobs');
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
