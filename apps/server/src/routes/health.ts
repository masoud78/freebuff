import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '@freebuff/contracts';
import { checkDatabaseHealth } from '../core/database/helpers/health.js';
import { DatabaseError } from '../core/database/helpers/errors.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async (request): Promise<HealthResponse> => {
    try {
      await checkDatabaseHealth();
      return { status: 'ok', database: { status: 'connected' } };
    } catch (error) {
      if (error instanceof DatabaseError) {
        request.log.error({ err: error }, 'Database health check failed');
        return { status: 'degraded', database: { status: 'unavailable' } };
      }
      throw error;
    }
  });
}
