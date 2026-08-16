import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  geminiApiKeyInputSchema,
  type ApiErrorResponse,
  type GeminiCredentialStatusResponse,
  type GeminiTestConnectionResponse,
} from '@freebuff/contracts';
import { geminiService } from '../services/gemini/gemini.service.js';
import { toErrorResponse } from './error-response.js';

function sendError(reply: FastifyReply, error: unknown): ApiErrorResponse {
  return toErrorResponse(reply, error);
}

export async function geminiRoutes(app: FastifyInstance): Promise<void> {
  // Credential status — never exposes the key itself.
  app.get(
    '/api/gemini/credential',
    async (request, reply): Promise<GeminiCredentialStatusResponse | ApiErrorResponse> => {
      try {
        return await geminiService.getCredentialStatus();
      } catch (error) {
        request.log.error({ err: error }, 'Failed to read credential status');
        return sendError(reply, error);
      }
    },
  );

  app.put(
    '/api/gemini/credential',
    async (request, reply): Promise<GeminiCredentialStatusResponse | ApiErrorResponse> => {
      try {
        const parsed = geminiApiKeyInputSchema.safeParse(request.body);
        if (!parsed.success) {
          const message = parsed.error.issues[0]?.message ?? 'API Key نامعتبر است.';
          reply.code(400);
          return { error: { code: 'GEMINI_API_ERROR', message } };
        }
        await geminiService.saveApiKey(parsed.data.apiKey);
        return await geminiService.getCredentialStatus();
      } catch (error) {
        request.log.error({ err: error }, 'Failed to save credential');
        return sendError(reply, error);
      }
    },
  );

  app.delete(
    '/api/gemini/credential',
    async (request, reply): Promise<GeminiCredentialStatusResponse | ApiErrorResponse> => {
      try {
        await geminiService.deleteCredential();
        return await geminiService.getCredentialStatus();
      } catch (error) {
        request.log.error({ err: error }, 'Failed to delete credential');
        return sendError(reply, error);
      }
    },
  );

  app.post(
    '/api/gemini/test',
    async (request, reply): Promise<GeminiTestConnectionResponse | ApiErrorResponse> => {
      try {
        await geminiService.testConnection();
        const status = await geminiService.getCredentialStatus();
        return { ...status, message: 'اتصال با موفقیت برقرار شد.' };
      } catch (error) {
        request.log.error({ err: error }, 'Gemini connection test failed');
        return sendError(reply, error);
      }
    },
  );
}
