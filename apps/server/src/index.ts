import { buildApp } from './app.js';
import { initDatabase } from './core/database/index.js';
import { jobService } from './services/jobs.service.js';
import { deltaWorker } from './services/knowledge/delta.worker.js';
import { knowledgeWorker } from './services/knowledge/knowledge.worker.js';
import { reconciliationWorker } from './services/knowledge/reconciliation.worker.js';
import { promptsService } from './services/prompts.service.js';
import { settingsService } from './services/settings.service.js';
import { transcriptionWorker } from './services/transcription/worker.js';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

try {
  // Fail fast: if the database cannot be opened or migrated, do not start.
  await initDatabase();
  // Ensure default settings exist so the DB always has a settings row.
  await settingsService.ensureDefaultSettings();
  // Seed the three default prompt templates (idempotent).
  await promptsService.ensureDefaultTemplates();
  // Recover jobs left RUNNING by a previous crash back to PENDING.
  const recovered = await jobService.recoverStaleJobs();
  if (recovered > 0) {
    console.error(`[startup] recovered ${recovered} stale job(s)`);
  }
  const app = buildApp({ loggerOptions: { level: LOG_LEVEL } });
  await app.listen({ port: PORT, host: HOST });
  // Persistent workers: only started batches are picked up, so processing
  // begins when the user starts a batch (or resumes after a restart).
  transcriptionWorker.start();
  knowledgeWorker.start();
  deltaWorker.start();
  reconciliationWorker.start();

  // Graceful shutdown: stop claiming new jobs and close the HTTP server;
  // in-flight Gemini requests get a chance to finish.
  const shutdown = (): void => {
    transcriptionWorker.stop();
    knowledgeWorker.stop();
    deltaWorker.stop();
    reconciliationWorker.stop();
    void app.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (error) {
  console.error('Failed to start server', error);
  process.exit(1);
}
