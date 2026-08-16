import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ApiErrorResponse, AppSettings } from '@freebuff/contracts';
import { DatabaseError } from '../core/database/helpers/errors.js';
import { settingsService } from '../services/settings.service.js';
import { SettingsError } from '../services/settings.errors.js';

const GENERIC_MESSAGE = 'خطای غیرمنتظره رخ داد. دوباره تلاش کنید.';

function toErrorResponse(reply: FastifyReply, error: unknown): ApiErrorResponse {
  if (error instanceof SettingsError) {
    const status = error.code === 'DATABASE_ERROR' ? 500 : 400;
    reply.code(status);
    return { error: { code: error.code, message: error.message } };
  }
  if (error instanceof DatabaseError) {
    reply.code(500);
    return { error: { code: 'DATABASE_ERROR', message: 'خطا در دسترسی به Database. دوباره تلاش کنید.' } };
  }
  reply.code(500);
  return { error: { code: 'DATABASE_ERROR', message: GENERIC_MESSAGE } };
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async (request, reply): Promise<AppSettings | ApiErrorResponse> => {
    try {
      return await settingsService.getSettings();
    } catch (error) {
      request.log.error({ err: error }, 'Failed to load settings');
      return toErrorResponse(reply, error);
    }
  });

  app.put('/api/settings', async (request, reply): Promise<AppSettings | ApiErrorResponse> => {
    try {
      return await settingsService.updateSettings(request.body);
    } catch (error) {
      request.log.error({ err: error }, 'Failed to update settings');
      return toErrorResponse(reply, error);
    }
  });
}
