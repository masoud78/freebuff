import type { FastifyInstance } from 'fastify';
import type {
  ApiErrorResponse,
  PromptTemplatesResponse,
  PromptVersionsResponse,
} from '@freebuff/contracts';
import { promptsService } from '../services/prompts.service.js';
import { toErrorResponse } from './error-response.js';

export async function promptRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/prompts/templates',
    async (request, reply): Promise<PromptTemplatesResponse | ApiErrorResponse> => {
      try {
        return await promptsService.getTemplates();
      } catch (error) {
        request.log.error({ err: error }, 'Failed to load prompt templates');
        return toErrorResponse(reply, error);
      }
    },
  );

  app.get(
    '/api/prompts/:promptType/versions',
    async (request, reply): Promise<PromptVersionsResponse | ApiErrorResponse> => {
      try {
        const { promptType } = request.params as { promptType: string };
        return await promptsService.getVersions(promptType);
      } catch (error) {
        request.log.error({ err: error }, 'Failed to load prompt versions');
        return toErrorResponse(reply, error);
      }
    },
  );

  app.post(
    '/api/prompts/:promptType/versions',
    async (request, reply): Promise<PromptVersionsResponse | ApiErrorResponse> => {
      try {
        const { promptType } = request.params as { promptType: string };
        return await promptsService.saveVersion(promptType, request.body);
      } catch (error) {
        request.log.error({ err: error }, 'Failed to save prompt version');
        return toErrorResponse(reply, error);
      }
    },
  );

  app.post(
    '/api/prompts/:promptType/activate',
    async (request, reply): Promise<PromptVersionsResponse | ApiErrorResponse> => {
      try {
        const { promptType } = request.params as { promptType: string };
        const { versionId } = request.body as { versionId: number };
        return await promptsService.activateVersion(promptType, Number(versionId));
      } catch (error) {
        request.log.error({ err: error }, 'Failed to activate prompt version');
        return toErrorResponse(reply, error);
      }
    },
  );
}
