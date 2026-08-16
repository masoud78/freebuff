import type { FastifyInstance } from 'fastify';
import type { AiReadinessResponse, ApiErrorResponse } from '@freebuff/contracts';
import { readinessService } from '../services/readiness.service.js';
import { toErrorResponse } from './error-response.js';

export async function readinessRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/readiness',
    async (request, reply): Promise<AiReadinessResponse | ApiErrorResponse> => {
      try {
        return await readinessService.getReadiness();
      } catch (error) {
        request.log.error({ err: error }, 'Failed to compute readiness');
        return toErrorResponse(reply, error);
      }
    },
  );
}
