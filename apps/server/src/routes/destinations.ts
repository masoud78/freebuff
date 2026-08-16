import type { FastifyInstance } from 'fastify';
import type { ApiErrorResponse, DestinationDetailResponse, DestinationListResponse } from '@freebuff/contracts';
import { destinationService } from '../services/knowledge/destinations.service.js';
import { toErrorResponse } from './error-response.js';

export async function destinationRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/destinations',
    async (request, reply): Promise<DestinationListResponse | ApiErrorResponse> => {
      try {
        return await destinationService.listDestinations();
      } catch (error) {
        request.log.error({ err: error }, 'Failed to list destinations');
        return toErrorResponse(reply, error);
      }
    },
  );

  app.get(
    '/api/destinations/:id',
    async (request, reply): Promise<DestinationDetailResponse | ApiErrorResponse> => {
      try {
        const { id } = request.params as { id: string };
        const detail = await destinationService.getDestination(Number(id));
        if (!detail) {
          reply.code(404);
          return { error: { code: 'BATCH_NOT_FOUND', message: 'مقصد پیدا نشد.' } };
        }
        return detail;
      } catch (error) {
        request.log.error({ err: error }, 'Failed to load destination');
        return toErrorResponse(reply, error);
      }
    },
  );
}
