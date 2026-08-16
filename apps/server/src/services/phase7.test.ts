import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import type { TranscribeAudioResult } from './gemini/gateway.js';
import { GeminiGatewayError, type GeminiGatewayLike } from './gemini/gateway.js';
import { credentialStore } from './gemini/credentials.store.js';
import { closeDatabase, getDatabase, initDatabase } from '../core/database/index.js';
import {
  apiUsage,
  audioFiles,
  batches,
  destinationAliases,
  destinations,
  jobs,
  knowledgeAnalysisRuns,
  knowledgeEvidence,
  knowledgeItems,
  knowledgeVersions,
  modelConfigs,
  transcriptDestinations,
  transcripts,
  transcriptSegments,
} from '../core/database/schema.js';
import { batchService } from './batches.service.js';
import { jobService } from './jobs.service.js';
import { KnowledgeWorker } from './knowledge/knowledge.worker.js';
import { modelsService } from './models.service.js';
import { promptsService } from './prompts.service.js';
import { settingsService } from './settings.service.js';
import { hashText, normalizeText } from './transcription/normalize.js';
import { TranscriptionWorker } from './transcription/worker.js';

const MODEL_ID = 'gemini-2.5-flash';
const TRANSCRIPT_TEXT = 'متن نمونه ترنسکریپشن برای تست.';

type Behavior = 'success' | 'rate-limit' | 'network' | 'api-error';

class MockGateway implements GeminiGatewayLike {
  calls = 0;

  constructor(
    private readonly behavior: Behavior = 'success',
    private readonly texts: string[] = [],
  ) {}

  async testConnection(): Promise<void> {}

  async listModels() {
    return [];
  }

  async transcribeAudio(): Promise<TranscribeAudioResult> {
    this.calls += 1;
    if (this.behavior === 'rate-limit') {
      throw new GeminiGatewayError('GEMINI_RATE_LIMIT', 'محدودیت نرخ');
    }
    if (this.behavior === 'network') {
      throw new GeminiGatewayError('GEMINI_NETWORK_ERROR', 'خطای شبکه');
    }
    if (this.behavior === 'api-error') {
      throw new GeminiGatewayError('GEMINI_API_ERROR', 'خطای API');
    }
    const text = this.texts[this.calls - 1] ?? TRANSCRIPT_TEXT;
    return {
      text,
      usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, totalTokens: 15 },
      durationMs: 42,
    };
  }

  async analyzeKnowledge() {
    this.calls += 1;
    if (this.behavior === 'rate-limit') {
      throw new GeminiGatewayError('GEMINI_RATE_LIMIT', 'محدودیت نرخ');
    }
    return {
      analysis: { destinations: [], knowledge: [] },
      usage: { inputTokens: 3, outputTokens: 4, cachedTokens: 0, totalTokens: 7 },
      durationMs: 21,
    };
  }

  async analyzeNotes(): Promise<never> {
    throw new Error('not used in this test suite');
  }

  async compareNote(): Promise<never> {
    throw new Error('not used in this test suite');
  }

  async createEmbedding() {
    this.calls += 1;
    if (this.behavior === 'rate-limit') {
      throw new GeminiGatewayError('GEMINI_RATE_LIMIT', 'محدودیت نرخ');
    }
    return {
      embedding: [0.1, 0.2, 0.3],
      usage: { inputTokens: 1, outputTokens: 0, cachedTokens: 0, totalTokens: 1 },
      durationMs: 5,
    };
  }

  async classifyDelta() {
    this.calls += 1;
    if (this.behavior === 'rate-limit') {
      throw new GeminiGatewayError('GEMINI_RATE_LIMIT', 'محدودیت نرخ');
    }
    return {
      classification: { decision: 'NEW' as const, matchedKnowledgeId: 0, confidence: 0.8, reasonCode: 'NEW_FACT' },
      usage: { inputTokens: 2, outputTokens: 2, cachedTokens: 0, totalTokens: 4 },
      durationMs: 9,
    };
  }

  async generateContent() {
    this.calls += 1;
    if (this.behavior === 'rate-limit') {
      throw new GeminiGatewayError('GEMINI_RATE_LIMIT', 'محدودیت نرخ');
    }
    return {
      text: 'محتوا',
      usage: { inputTokens: 3, outputTokens: 5, cachedTokens: 0, totalTokens: 8 },
      durationMs: 10,
    };
  }
}

let dir: string;

function writeFixture(name: string): string {
  const path = join(dir, 'audio', name);
  writeFileSync(path, randomBytes(96));
  return path;
}

async function setupBatch(fileNames: string[]): Promise<number> {
  for (const name of fileNames) writeFixture(name);
  const batch = await batchService.createBatch();
  await batchService.scanBatch(batch.id);
  await batchService.startBatch(batch.id);
  return batch.id;
}

async function jobIdsForBatch(batchId: number, jobType?: string): Promise<number[]> {
  const db = getDatabase();
  const rows = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(jobType ? and(eq(jobs.batchId, batchId), eq(jobs.jobType, jobType)) : eq(jobs.batchId, batchId));
  return rows.map((row) => row.id);
}

async function setModelConfig(modelId: string | null): Promise<void> {
  const db = getDatabase();
  const now = new Date();
  // All four stages must be configured so the Phase 12 preflight lets the
  // batch start; tests that exercise a missing model delete it explicitly.
  for (const stage of ['TRANSCRIPTION', 'KNOWLEDGE_PROCESSING', 'EMBEDDING', 'CONTENT_GENERATION'] as const) {
    if (modelId === null) {
      await db.delete(modelConfigs).where(eq(modelConfigs.stage, stage));
      continue;
    }
    await db
      .insert(modelConfigs)
      .values({
        stage,
        provider: 'GEMINI',
        modelId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: modelConfigs.stage,
        set: { modelId, provider: 'GEMINI', updatedAt: now },
      });
  }
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'freebuff-transcription-test-'));
  mkdirSync(join(dir, 'audio'), { recursive: true });
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.GEMINI_CREDENTIALS_FILE = join(dir, 'gemini.key');
  await initDatabase();
  await promptsService.ensureDefaultTemplates();
  await settingsService.updateSettings({ workspacePath: dir, processingConcurrency: 2 });
  await setModelConfig(MODEL_ID);
  await promptsService.saveVersion('TRANSCRIPTION', { content: 'پرامپت تست تبدیل صوت' });
  await promptsService.saveVersion('KNOWLEDGE_PROCESSING', { content: 'پرامپت تست تحلیل دانش' });
  // Phase 12 preflight requires the content prompt so the batch can start.
  await promptsService.saveVersion('CONTENT_GENERATION', { content: 'پرامپت تست تولید محتوا' });
  await credentialStore.saveKey('test-key-abc');
});

/**
 * Each test is self-contained: wipe the domain tables and reset the audio
 * folder so scans only ever see that test's own fixtures. Configuration
 * (model config, prompts, credentials, settings) survives.
 */
beforeEach(async () => {
  const db = getDatabase();
  await db.delete(apiUsage);
  await db.delete(knowledgeEvidence);
  await db.delete(knowledgeVersions);
  await db.delete(knowledgeItems);
  await db.delete(knowledgeAnalysisRuns);
  await db.delete(transcriptDestinations);
  await db.delete(destinationAliases);
  await db.delete(destinations);
  await db.delete(transcriptSegments);
  await db.delete(transcripts);
  await db.delete(jobs);
  await db.delete(audioFiles);
  await db.delete(batches);
  rmSync(join(dir, 'audio'), { recursive: true, force: true });
  mkdirSync(join(dir, 'audio'), { recursive: true });
});

after(async () => {
  await closeDatabase();
  delete process.env.DB_PATH;
  delete process.env.GEMINI_CREDENTIALS_FILE;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may hold the SQLite handle; temp dirs are harmless.
  }
});

// ---------------------------------------------------------------------------
// Job claiming
// ---------------------------------------------------------------------------

test('a pending transcription job can be claimed', async () => {
  const batchId = await setupBatch(['claim-a.mp3']);
  const [jobId] = await jobIdsForBatch(batchId);
  assert.ok(jobId);
  const claimed = await jobService.claimNextJob();
  assert.equal(claimed?.id, jobId);
  assert.equal(claimed?.status, 'RUNNING');
  assert.equal(claimed?.attempt, 1);
});

test('two workers cannot claim the same job', async () => {
  const batchId = await setupBatch(['claim-b.mp3']);
  const [jobId] = await jobIdsForBatch(batchId);
  const first = await jobService.claimNextJob();
  assert.equal(first?.id, jobId);
  const second = await jobService.claimNextJob();
  assert.equal(second, null, 'second worker must not receive an already-claimed job');
});

test('jobs of a READY (unstarted) batch are not claimed', async () => {
  // Scan but never start: the worker must not pick these jobs up.
  writeFixture('unstarted.mp3');
  const batch = await batchService.createBatch();
  await batchService.scanBatch(batch.id);
  assert.equal((await batchService.getBatch(batch.id)).status, 'READY');

  const claimed = await jobService.claimNextJob();
  assert.equal(claimed, null, 'unstarted batches must stay untouched');
  const [jobId] = await jobIdsForBatch(batch.id);
  assert.ok(jobId);
  const job = await jobService.getJob(jobId);
  assert.equal(job?.status, 'PENDING');
});

// ---------------------------------------------------------------------------
// Configuration loading
// ---------------------------------------------------------------------------

test('configured transcription model is loaded', async () => {
  const modelId = await modelsService.getConfiguredModelId('TRANSCRIPTION');
  assert.equal(modelId, MODEL_ID);
});

test('active transcription prompt is loaded', async () => {
  const prompt = await promptsService.getActiveVersion('TRANSCRIPTION');
  assert.ok(prompt);
  assert.equal(prompt.content, 'پرامپت تست تبدیل صوت');
});

// ---------------------------------------------------------------------------
// Pipeline execution
// ---------------------------------------------------------------------------

test('successful transcription creates transcript, segments, usage and completes the job', async () => {
  const gateway = new MockGateway('success');
  const worker = new TranscriptionWorker(gateway);
  await setupBatch(['ok-a.mp3']);
  const claimed = await jobService.claimNextJob();
  assert.ok(claimed);

  await worker.processJob(claimed);

  const db = getDatabase();
  const transcript = await db.select().from(transcripts).get();
  assert.ok(transcript, 'transcript row exists');
  assert.equal(transcript.fullText, TRANSCRIPT_TEXT);
  assert.equal(transcript.modelId, MODEL_ID);
  assert.equal(transcript.status, 'COMPLETED');

  const segments = await db.select().from(transcriptSegments);
  assert.ok(segments.length >= 1, 'segments are stored');

  const audio = await db.select().from(audioFiles).where(eq(audioFiles.id, claimed.entityId)).get();
  assert.equal(audio?.status, 'TRANSCRIBED');

  const done = await jobService.getJob(claimed.id);
  assert.equal(done?.status, 'COMPLETED');

  const usage = await db.select().from(apiUsage).get();
  assert.equal(usage?.status, 'SUCCESS');
  assert.equal(usage?.inputTokens, 10);
  assert.equal(usage?.totalTokens, 15);
  assert.equal(gateway.calls, 1);
});

test('normalized hash is deterministic', () => {
  const first = hashText(normalizeText('متن تست'));
  const second = hashText(normalizeText('متن تست'));
  assert.equal(first, second);
  // Arabic forms normalize to Persian forms, producing the same hash.
  assert.equal(hashText(normalizeText('\u0645\u062A\u0646')), hashText(normalizeText('متن')));
});

test('missing model prevents any Gemini call', async () => {
  const gateway = new MockGateway('success');
  const worker = new TranscriptionWorker(gateway);
  await setupBatch(['nomodel.mp3']);
  const claimed = await jobService.claimNextJob();
  assert.ok(claimed);

  await setModelConfig(null);
  await worker.processJob(claimed);
  await setModelConfig(MODEL_ID);

  const done = await jobService.getJob(claimed.id);
  assert.equal(done?.status, 'FAILED');
  assert.equal(done?.errorCode, 'TRANSCRIPTION_MODEL_NOT_CONFIGURED');
  assert.equal(gateway.calls, 0);
});

test('missing prompt prevents any Gemini call', async () => {
  const gateway = new MockGateway('success');
  const worker = new TranscriptionWorker(gateway);
  await setupBatch(['noprompt.mp3']);
  const claimed = await jobService.claimNextJob();
  assert.ok(claimed);

  await promptsService.saveVersion('TRANSCRIPTION', { content: '' });
  await worker.processJob(claimed);
  await promptsService.saveVersion('TRANSCRIPTION', { content: 'پرامپت تست تبدیل صوت' });

  const done = await jobService.getJob(claimed.id);
  assert.equal(done?.status, 'FAILED');
  assert.equal(done?.errorCode, 'TRANSCRIPTION_PROMPT_NOT_CONFIGURED');
  assert.equal(gateway.calls, 0);
});

test('duplicate transcript is detected across audio files', async () => {
  const gateway = new MockGateway('success');
  const worker = new TranscriptionWorker(gateway);
  const batchId = await setupBatch(['dup-a.mp3', 'dup-b.mp3']);
  const ids = await jobIdsForBatch(batchId);
  assert.equal(ids.length, 2);

  for (let i = 0; i < ids.length; i += 1) {
    const claimed = await jobService.claimNextJob();
    assert.ok(claimed);
    await worker.processJob(claimed);
  }

  const db = getDatabase();
  const rows = await db.select().from(transcripts).orderBy(transcripts.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[1]?.duplicateOfTranscriptId, rows[0]?.id, 'second transcript points at the first');
  assert.equal(rows[1]?.normalizedHash, rows[0]?.normalizedHash);
});

// ---------------------------------------------------------------------------
// Retry behavior
// ---------------------------------------------------------------------------

test('a retryable failure schedules a retry with next_attempt_at', async () => {
  const gateway = new MockGateway('rate-limit');
  const worker = new TranscriptionWorker(gateway);
  await setupBatch(['retry-a.mp3']);
  const claimed = await jobService.claimNextJob();
  assert.ok(claimed);

  await worker.processJob(claimed);

  const job = await jobService.getJob(claimed.id);
  assert.equal(job?.status, 'PENDING', 'retryable failure requeues');
  assert.ok(job?.nextAttemptAt, 'next attempt is scheduled');
  assert.equal(job?.errorCode, 'GEMINI_RATE_LIMIT');
  assert.equal(job?.attempt, 1);
});

test('a non-retryable failure does not loop', async () => {
  const gateway = new MockGateway('api-error');
  const worker = new TranscriptionWorker(gateway);
  await setupBatch(['fail-a.mp3']);
  const claimed = await jobService.claimNextJob();
  assert.ok(claimed);

  await worker.processJob(claimed);

  const job = await jobService.getJob(claimed.id);
  assert.equal(job?.status, 'FAILED');
  assert.equal(job?.nextAttemptAt, null);
  assert.equal(job?.errorCode, 'GEMINI_API_ERROR');
  assert.equal(gateway.calls, 1);
});

test('retry max attempts is respected', async () => {
  const gateway = new MockGateway('network');
  const worker = new TranscriptionWorker(gateway);
  await setupBatch(['maxattempts.mp3']);
  const claimed = await jobService.claimNextJob();
  assert.ok(claimed);
  await jobService.markFailed(claimed.id, '', '', { retryable: false }); // reset state
  const db = getDatabase();
  await db.update(jobs).set({ maxAttempts: 2, attempt: 0, status: 'PENDING', nextAttemptAt: null }).where(eq(jobs.id, claimed.id));

  // Attempt 1 → retryable → PENDING.
  const firstRetry = await jobService.claimNextJob();
  assert.ok(firstRetry);
  await worker.processJob(firstRetry);
  let job = await jobService.getJob(claimed.id);
  assert.equal(job?.status, 'PENDING');
  assert.equal(job?.attempt, 1);

  // Attempt 2 → retryable but max reached → FAILED. The retry was scheduled
  // in the future, so clear the schedule before claiming again.
  await db.update(jobs).set({ nextAttemptAt: null }).where(eq(jobs.id, claimed.id));
  const claimed2 = await jobService.claimNextJob();
  assert.equal(claimed2?.id, claimed.id);
  await worker.processJob(claimed2);
  job = await jobService.getJob(claimed.id);
  assert.equal(job?.status, 'FAILED');
  assert.equal(job?.attempt, 2);
});

// ---------------------------------------------------------------------------
// Recovery & idempotency
// ---------------------------------------------------------------------------

test('startup recovers stale RUNNING jobs to PENDING', async () => {
  const batchId = await setupBatch(['stale.mp3']);
  const [jobId] = await jobIdsForBatch(batchId);
  assert.ok(jobId, 'a job exists');
  await jobService.markRunning(jobId);
  assert.equal((await jobService.getJob(jobId))?.status, 'RUNNING');

  const recovered = await jobService.recoverStaleJobs();
  assert.ok(recovered >= 1);
  const job = await jobService.getJob(jobId);
  assert.ok(job);
  assert.equal(job?.status, 'PENDING');
  assert.equal(job?.lockedAt, null);
});

test('an existing valid transcript prevents a duplicate Gemini call', async () => {
  const gateway = new MockGateway('success');
  const worker = new TranscriptionWorker(gateway);
  const batchId = await setupBatch(['idem.mp3']);
  const [jobId] = await jobIdsForBatch(batchId);

  // Process the job once — one Gemini call.
  const first = await jobService.claimNextJob();
  assert.ok(first);
  assert.equal(first.id, jobId);
  await worker.processJob(first);
  assert.equal(gateway.calls, 1);

  // Simulate a re-queued job for the same audio with the same config.
  const db = getDatabase();
  const now = new Date();
  await db
    .insert(jobs)
    .values({
      batchId,
      jobType: 'TRANSCRIPTION',
      entityId: first.entityId,
      status: 'PENDING',
      attempt: 0,
      maxAttempts: 3,
      idempotencyKey: `TRANSCRIPTION:${first.entityId}:requeue`,
      createdAt: now,
      updatedAt: now,
    });
  // Re-open the (completed) batch so the requeued job is claimable again.
  await db.update(batches).set({ status: 'PROCESSING' }).where(eq(batches.id, batchId));
  const requeued = await jobService.claimNextJob();
  assert.ok(requeued);
  await worker.processJob(requeued);

  assert.equal(gateway.calls, 1, 'no second Gemini call for an existing transcript');
  const done = await jobService.getJob(requeued.id);
  assert.equal(done?.status, 'COMPLETED');
});

// ---------------------------------------------------------------------------
// Batch state
// ---------------------------------------------------------------------------

test('a batch completes when all jobs (transcription + knowledge) finish', async () => {
  // Distinct texts so neither transcript is a duplicate (each gets its own
  // knowledge job).
  const gateway = new MockGateway('success', ['متن اول متمایز.', 'متن دوم متمایز.']);
  const worker = new TranscriptionWorker(gateway);
  const knowledgeWorker = new KnowledgeWorker(new MockGateway('success'));
  const batchId = await setupBatch(['batch-ok-1.mp3', 'batch-ok-2.mp3']);

  // Transcription phase.
  for (const id of await jobIdsForBatch(batchId, 'TRANSCRIPTION')) {
    const claimed = await jobService.claimNextJob('TRANSCRIPTION');
    assert.equal(claimed?.id, id);
    await worker.processJob(claimed);
  }
  // Knowledge phase (each successful transcript spawns one analysis job).
  for (const id of await jobIdsForBatch(batchId, 'KNOWLEDGE_ANALYSIS')) {
    const claimed = await jobService.claimNextJob('KNOWLEDGE_ANALYSIS');
    assert.equal(claimed?.id, id);
    await knowledgeWorker.processJob(claimed);
  }

  const batch = await batchService.getBatch(batchId);
  assert.equal(batch.status, 'ANALYSIS_COMPLETED');
  assert.equal(batch.stats.transcribed, 2);
  assert.equal(batch.stats.knowledgeAnalyzed, 2);
  assert.equal(batch.stats.queuedJobs, 0);
});

test('partial failure produces PARTIAL_FAILED batch state', async () => {
  const gateway = new MockGateway('api-error');
  const worker = new TranscriptionWorker(gateway);
  const batchId = await setupBatch(['partial-1.mp3']);
  const claimed = await jobService.claimNextJob();
  assert.ok(claimed);
  await worker.processJob(claimed);

  // One permanently failed job in a batch with no successes → FAILED.
  const batch = await batchService.getBatch(batchId);
  assert.equal(batch.status, 'FAILED');
});

test('mixed success and failure produces PARTIAL_FAILED', async () => {
  const batchId = await setupBatch(['mixed-1.mp3', 'mixed-2.mp3']);

  // First job: success → creates a knowledge job.
  const successWorker = new TranscriptionWorker(new MockGateway('success'));
  const first = await jobService.claimNextJob('TRANSCRIPTION');
  assert.ok(first);
  await successWorker.processJob(first);

  // Second job: permanent transcription failure.
  const failWorker = new TranscriptionWorker(new MockGateway('api-error'));
  const second = await jobService.claimNextJob('TRANSCRIPTION');
  assert.ok(second);
  await failWorker.processJob(second);

  // Knowledge job from the successful transcript completes.
  const knowledgeJob = await jobService.claimNextJob('KNOWLEDGE_ANALYSIS');
  assert.ok(knowledgeJob);
  await new KnowledgeWorker(new MockGateway('success')).processJob(knowledgeJob);

  const batch = await batchService.getBatch(batchId);
  assert.equal(batch.status, 'PARTIAL_FAILED');
  assert.equal(batch.stats.transcribed, 1);
  assert.equal(batch.stats.failedItems, 1);
});
