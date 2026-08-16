import type { FastifyInstance } from 'fastify';
import type { ApiErrorResponse, GeminiModelsResponse } from '@freebuff/contracts';
import { geminiService } from '../services/gemini/gemini.service.js';
import { toErrorResponse } from './error-response.js';

export async function modelRoutes(app: FastifyInstance): Promise<void> {
  // Cached discovery result — no live API call on page load.
  app.get(
    '/api/gemini/models',
    async (request, reply): Promise<GeminiModelsResponse | ApiErrorResponse> => {
      try {
        return await geminiService.getCachedModels();
      } catch (error) {
        request.log.error({ err: error }, 'Failed to read cached models');
        return toErrorResponse(reply, error);
      }
    },
  );

  // Explicit refresh against the live Gemini API.
  app.post(
    '/api/gemini/models/refresh',
    async (request, reply): Promise<GeminiModelsResponse | ApiErrorResponse> => {
      try {
        return await geminiService.refreshModels();
      } catch (error) {
        request.log.error({ err: error }, 'Failed to refresh Gemini models');
        return toErrorResponse(reply, error);
      }
    },
  );
}
