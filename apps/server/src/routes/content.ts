import type { FastifyInstance } from 'fastify';
import type {
  ApiErrorResponse,
  BatchGeneratedContentsResponse,
  BatchUsageResponse,
  ContentRegenerateResponse,
  DestinationContentHistoryResponse,
  GeneratedContentDetailResponse,
} from '@freebuff/contracts';
import { eq } from 'drizzle-orm';
import { getDatabase } from '../core/database/client.js';
import { generatedContents } from '../core/database/schema.js';
import { batchContentGenerationService } from '../services/content/batch-content-generation.service.js';
import { contentReadService } from '../services/content/content-read.service.js';
import { toErrorResponse } from './error-response.js';

const NOT_FOUND: ApiErrorResponse = {
  error: { code: 'CONTENT_GENERATION_FAILED', message: 'محتوای تولیدشده یافت نشد.' },
};

export async function contentRoutes(app: FastifyInstance): Promise<void> {
  // Generations grouped per destination for a batch.
  app.get(
    '/api/batches/:id/generated-contents',
    async (request, reply): Promise<BatchGeneratedContentsResponse | ApiErrorResponse> => {
      try {
        const { id } = request.params as { id: string };
        return await contentReadService.getBatchGeneratedContents(Number(id));
      } catch (error) {
        request.log.error({ err: error }, 'Failed to load batch generated contents');
        return toErrorResponse(reply, error);
      }
    },
  );

  // Content history of a destination, grouped per batch.
  app.get(
    '/api/destinations/:id/generated-contents',
    async (request, reply): Promise<DestinationContentHistoryResponse | ApiErrorResponse> => {
      try {
        const { id } = request.params as { id: string };
        return await contentReadService.getDestinationContentHistory(Number(id));
      } catch (error) {
        request.log.error({ err: error }, 'Failed to load destination content history');
        return toErrorResponse(reply, error);
      }
    },
  );

  // Full detail: content + source knowledge links.
  app.get(
    '/api/generated-contents/:id',
    async (request, reply): Promise<GeneratedContentDetailResponse | ApiErrorResponse> => {
      try {
        const { id } = request.params as { id: string };
        const detail = await contentReadService.getGeneratedContentDetail(Number(id));
        if (!detail) {
          reply.code(404);
          return NOT_FOUND;
        }
        return detail;
      } catch (error) {
        request.log.error({ err: error }, 'Failed to load generated content detail');
        return toErrorResponse(reply, error);
      }
    },
  );

  // Explicit regenerate: queues a new generation (history preserved).
  app.post(
    '/api/generated-contents/:id/regenerate',
    async (request, reply): Promise<ContentRegenerateResponse | ApiErrorResponse> => {
      try {
        const { id } = request.params as { id: string };
        const row = await getDatabase()
          .select()
          .from(generatedContents)
          .where(eq(generatedContents.id, Number(id)))
          .get();
        if (!row || row.destinationId === null) {
          reply.code(404);
          return NOT_FOUND;
        }
        return await batchContentGenerationService.regenerate(row.batchId, row.destinationId);
      } catch (error) {
        request.log.error({ err: error }, 'Failed to queue content regeneration');
        return toErrorResponse(reply, error);
      }
    },
  );

  // Per-stage usage aggregate of a batch (real api_usage data).
  app.get(
    '/api/batches/:id/usage',
    async (request, reply): Promise<BatchUsageResponse | ApiErrorResponse> => {
      try {
        const { id } = request.params as { id: string };
        return await contentReadService.getBatchUsage(Number(id));
      } catch (error) {
        request.log.error({ err: error }, 'Failed to load batch usage');
        return toErrorResponse(reply, error);
      }
    },
  );
}
