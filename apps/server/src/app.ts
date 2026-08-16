import Fastify, { type FastifyInstance } from 'fastify';
import type { LoggerOptions } from 'pino';
import { healthRoutes } from './routes/health.js';
import { settingsRoutes } from './routes/settings.js';
import { geminiRoutes } from './routes/gemini.js';
import { modelRoutes } from './routes/models.js';
import { modelConfigRoutes } from './routes/model-configs.js';
import { promptRoutes } from './routes/prompts.js';
import { readinessRoutes } from './routes/readiness.js';
import { batchRoutes } from './routes/batches.js';
import { destinationRoutes } from './routes/destinations.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { contentRoutes } from './routes/content.js';
import { pipelineRoutes } from './routes/pipeline.js';
import { sessionRoutes } from './routes/sessions.js';
import { destinationNoteRoutes } from './routes/destination-notes.js';

export interface BuildAppOptions {
  /** Pino options passed to Fastify's built-in logger (which is pino). */
  loggerOptions?: LoggerOptions;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.loggerOptions ?? true });
  app.register(healthRoutes);
  app.register(settingsRoutes);
  app.register(geminiRoutes);
  app.register(modelRoutes);
  app.register(modelConfigRoutes);
  app.register(promptRoutes);
  app.register(readinessRoutes);
  app.register(batchRoutes);
  app.register(destinationRoutes);
  app.register(knowledgeRoutes);
  app.register(contentRoutes);
  app.register(pipelineRoutes);
  app.register(sessionRoutes);
  app.register(destinationNoteRoutes);
  return app;
}
