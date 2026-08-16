import type { FastifyInstance } from 'fastify';
import type {
  ApiErrorResponse,
  ModelConfigResponse,
  ModelConfigsResponse,
} from '@freebuff/contracts';
import { modelsService } from '../services/models.service.js';
import { toErrorResponse } from './error-response.js';

export async function modelConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/model-configs',
    async (request, reply): Promise<ModelConfigsResponse | ApiErrorResponse> => {
      try {
        return await modelsService.getModelConfigs();
      } catch (error) {
        request.log.error({ err: error }, 'Failed to load model configurations');
        return toErrorResponse(reply, error);
      }
    },
  );

  app.put(
    '/api/model-configs',
    async (request, reply): Promise<ModelConfigResponse | ApiErrorResponse> => {
      try {
        return await modelsService.updateModelConfig(request.body);
      } catch (error) {
        request.log.error({ err: error }, 'Failed to update model configuration');
        return toErrorResponse(reply, error);
      }
    },
  );
}
