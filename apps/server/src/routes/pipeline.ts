import type { FastifyInstance } from 'fastify';
import type { AllTimeUsageResponse, ApiErrorResponse, OverviewResponse, PipelinePreflightResponse } from '@freebuff/contracts';
import { overviewService } from '../services/overview.service.js';
import { pipelinePreflightService } from '../services/pipeline-preflight.service.js';
import { toErrorResponse } from './error-response.js';

export async function pipelineRoutes(app: FastifyInstance): Promise<void> {
  // Configuration readiness for STARTING a batch (Phase 12 §11–12).
  app.get(
    '/api/pipeline/preflight',
    async (request, reply): Promise<PipelinePreflightResponse | ApiErrorResponse> => {
      try {
        return await pipelinePreflightService.checkPreflight();
      } catch (error) {
        request.log.error({ err: error }, 'Failed to compute pipeline preflight');
        return toErrorResponse(reply, error);
      }
    },
  );

  // Concise system overview (Phase 12 §28) — real DB statistics only.
  app.get(
    '/api/overview',
    async (request, reply): Promise<OverviewResponse | ApiErrorResponse> => {
      try {
        return await overviewService.getOverview();
      } catch (error) {
        request.log.error({ err: error }, 'Failed to load overview');
        return toErrorResponse(reply, error);
      }
    },
  );

  // All-time usage across every batch, per stage (Phase 12 §29).
  app.get(
    '/api/usage',
    async (request, reply): Promise<AllTimeUsageResponse | ApiErrorResponse> => {
      try {
        return await overviewService.getAllTimeUsage();
      } catch (error) {
        request.log.error({ err: error }, 'Failed to load all-time usage');
        return toErrorResponse(reply, error);
      }
    },
  );
}
