import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import type { KnowledgeAnalysis } from '@freebuff/contracts';
import { closeDatabase, getDatabase, initDatabase } from '../core/database/index.js';
import {
  apiUsage,
  audioFiles,
  batches,
  deltaMetrics,
  destinationAliases,
  destinations,
  jobs,
  knowledgeAnalysisRuns,
  knowledgeCandidates,
  knowledgeDeltaDecisions,
  knowledgeEmbeddings,
  knowledgeEvidence,
  knowledgeItems,
  knowledgeVersions,
  modelConfigs,
  transcriptDestinations,
  transcriptSegments,
  transcripts,
} from '../core/database/schema.js';
import { batchService } from './batches.service.js';
import { credentialStore } from './gemini/credentials.store.js';
import { GeminiGatewayError, type GeminiGatewayLike } from './gemini/gateway.js';
import { jobService } from './jobs.service.js';
import { buildKnowledgeIdentityKey } from './knowledge/identity.js';
import { knowledgeAnalysisService } from './knowledge/knowledge-analysis.service.js';
import { KnowledgeWorker } from './knowledge/knowledge.worker.js';
import { destinationService } from './knowledge/destinations.service.js';
import { modelsService } from './models.service.js';
import { promptsService } from './prompts.service.js';
import { settingsService } from './settings.service.js';
import { TranscriptionWorker } from './transcription/worker.js';

const KNOWLEDGE_MODEL = 'gemini-2.5-flash';

function buildAnalysis(segmentId: number): KnowledgeAnalysis {
  return {
    destinations: [
      {
        name: 'مشهد',
        type: 'CITY',
        confidence: 'CONFIRMED',
        aliases: ['مشهد مقدس', 'Mashhad'],
      },
    ],
    knowledge: [
      {
        destinationReference: 'مشهد',
        knowledgeType: 'FACT',
        category: null,
        entityType: 'هتل',
        entityName: 'هتل پارس',
        attribute: 'فاصله تا حرم',
        value: '۵ دقیقه',
        unit: null,
        qualifiers: [],
        canonicalText: 'هتل پارس پنج دقیقه با حرم فاصله دارد.',
        sourceSegmentIds: [segmentId],
        confidence: 0.9,
      },
    ],
  };
}

type Behavior = 'success' | 'rate-limit' | 'api-error';

class MockGateway implements GeminiGatewayLike {
  calls = 0;

  constructor(
    private readonly behavior: Behavior = 'success',
    private readonly analysis: KnowledgeAnalysis = {
      destinations: [],
      knowledge: [],
    },
  ) {}

  async testConnection(): Promise<void> {}

  async listModels() {
    return [];
  }

  async transcribeAudio() {
    return {
      text: 'متن ترنسکریپشن برای تحلیل دانش.',
      usage: { inputTokens: 5, outputTokens: 8, cachedTokens: 0, totalTokens: 13 },
      durationMs: 11,
    };
  }

  async analyzeKnowledge() {
    this.calls += 1;
    if (this.behavior === 'rate-limit') {
      throw new GeminiGatewayError('GEMINI_RATE_LIMIT', 'محدودیت نرخ');
    }
    if (this.behavior === 'api-error') {
      throw new GeminiGatewayError('GEMINI_API_ERROR', 'خطای API');
    }
    return {
      analysis: this.analysis,
      usage: { inputTokens: 7, outputTokens: 9, cachedTokens: 0, totalTokens: 16 },
      durationMs: 33,
    };
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
  writeFileSync(path, new Uint8Array([1, 2, 3, 4]));
  return path;
}

/** Create a batch, scan one audio, transcribe it with the success gateway. */
async function transcribedBatch(
  fileName: string,
): Promise<{ batchId: number; audioId: number; transcriptId: number; segmentId: number }> {
  writeFixture(fileName);
  const batch = await batchService.createBatch();
  await batchService.scanBatch(batch.id);
  await batchService.startBatch(batch.id);

  const audio = await getDatabase()
    .select({ id: audioFiles.id })
    .from(audioFiles)
    .where(eq(audioFiles.batchId, batch.id))
    .get();
  assert.ok(audio);

  const worker = new TranscriptionWorker(new MockGateway('success'));
  const job = await jobService.claimNextJob('TRANSCRIPTION');
  assert.ok(job);
  await worker.processJob(job);

  const transcript = await getDatabase()
    .select()
    .from(transcripts)
    .where(eq(transcripts.audioId, audio.id))
    .get();
  assert.ok(transcript);
  const segment = await getDatabase()
    .select({ id: transcriptSegments.id })
    .from(transcriptSegments)
    .where(eq(transcriptSegments.transcriptId, transcript.id))
    .limit(1)
    .get();
  assert.ok(segment);

  return {
    batchId: batch.id,
    audioId: audio.id,
    transcriptId: transcript.id,
    segmentId: segment.id,
  };
}

async function setupKnowledgeConfig(): Promise<void> {
  const db = getDatabase();
  const now = new Date();
  for (const stage of ['TRANSCRIPTION', 'KNOWLEDGE_PROCESSING'] as const) {
    await db
      .insert(modelConfigs)
      .values({ stage, provider: 'GEMINI', modelId: KNOWLEDGE_MODEL, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: modelConfigs.stage,
        set: { modelId: KNOWLEDGE_MODEL, provider: 'GEMINI', updatedAt: now },
      });
  }
  await promptsService.saveVersion('TRANSCRIPTION', { content: 'پرامپت تبدیل صوت تست' });
  await promptsService.saveVersion('KNOWLEDGE_PROCESSING', { content: 'پرامپت تحلیل دانش تست' });
  await credentialStore.saveKey('test-key');
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'freebuff-phase8-test-'));
  mkdirSync(join(dir, 'audio'), { recursive: true });
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.GEMINI_CREDENTIALS_FILE = join(dir, 'gemini.key');
  await initDatabase();
  await promptsService.ensureDefaultTemplates();
  await settingsService.updateSettings({ workspacePath: dir, processingConcurrency: 2 });
  await setupKnowledgeConfig();
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

beforeEach(async () => {
  const db = getDatabase();
  // Phase 9 tables first (FK parents: candidates → runs/transcripts).
  await db.delete(deltaMetrics);
  await db.delete(knowledgeDeltaDecisions);
  await db.delete(knowledgeEmbeddings);
  await db.delete(knowledgeCandidates);
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
  // Reset the audio folder so scans only see this test's fixtures.
  rmSync(join(dir, 'audio'), { recursive: true, force: true });
  mkdirSync(join(dir, 'audio'), { recursive: true });
});

// ---------------------------------------------------------------------------
// Destination matching
// ---------------------------------------------------------------------------

test('destination exact normalized match reuses the existing row', async () => {
  const db = getDatabase();
  const first = await destinationService.resolveOrCreateDestination(
    { name: 'مشهد', type: 'CITY', confidence: 'CONFIRMED' },
    null,
  );
  assert.ok(first?.created);

  const second = await destinationService.resolveOrCreateDestination(
    { name: 'مشهد', type: 'CITY', confidence: 'CONFIRMED' },
    null,
  );
  assert.equal(second?.created, false);
  assert.equal(second?.id, first?.id);

  const count = await db.select({ id: destinations.id }).from(destinations);
  assert.equal(count.length, 1);
});

test('destination alias match reuses the destination', async () => {
  const created = await destinationService.resolveOrCreateDestination(
    { name: 'مشهد', type: 'CITY', confidence: 'CONFIRMED', aliases: ['Mashhad'] },
    null,
  );
  assert.ok(created);

  const alias = await destinationService.findByAlias('mashhad');
  assert.equal(alias?.id, created.id);
});

test('new destination creation stores aliases and first batch', async () => {
  const created = await destinationService.resolveOrCreateDestination(
    { name: 'کیش', type: 'REGION', confidence: 'PROVISIONAL', aliases: ['جزیره کیش'] },
    7,
  );
  assert.ok(created);
  const db = getDatabase();
  const aliases = await db
    .select()
    .from(destinationAliases)
    .where(eq(destinationAliases.destinationId, created.id));
  assert.equal(aliases.length, 1);
  assert.equal(aliases[0]?.alias, 'جزیره کیش');
  const dest = await db.select().from(destinations).where(eq(destinations.id, created.id)).get();
  assert.equal(dest?.firstSeenBatchId, 7);
});

test('UNKNOWN confidence never creates a destination', async () => {
  const result = await destinationService.resolveOrCreateDestination(
    { name: 'مقصد نامشخص', confidence: 'UNKNOWN' },
    null,
  );
  assert.equal(result, null);
  const db = getDatabase();
  const count = await db.select({ id: destinations.id }).from(destinations);
  assert.equal(count.length, 0);
});

test('multi-destination transcript links both destinations', async () => {
  const { transcriptId } = await transcribedBatch('multi.mp3');
  const analysis: KnowledgeAnalysis = {
    destinations: [
      { name: 'مشهد', type: 'CITY', confidence: 'CONFIRMED', aliases: [] },
      { name: 'کیش', type: 'REGION', confidence: 'CONFIRMED', aliases: [] },
    ],
    knowledge: [],
  };
  const gateway = new MockGateway('success', analysis);
  const job = await jobService.claimNextJob('KNOWLEDGE_ANALYSIS');
  assert.ok(job);
  await knowledgeAnalysisService.analyze(job, gateway);

  const links = await getDatabase()
    .select()
    .from(transcriptDestinations)
    .where(eq(transcriptDestinations.transcriptId, transcriptId));
  assert.equal(links.length, 2);
});

// ---------------------------------------------------------------------------
// Knowledge analyzer configuration
// ---------------------------------------------------------------------------

test('knowledge analyzer uses configured model and active prompt', async () => {
  const modelId = await modelsService.getConfiguredModelId('KNOWLEDGE_PROCESSING');
  assert.equal(modelId, KNOWLEDGE_MODEL);
  const prompt = await promptsService.getActiveVersion('KNOWLEDGE_PROCESSING');
  assert.equal(prompt?.content, 'پرامپت تحلیل دانش تست');
});

test('missing model prevents any Gemini call', async () => {
  await transcribedBatch('nomodel-k.mp3');
  await getDatabase().delete(modelConfigs).where(eq(modelConfigs.stage, 'KNOWLEDGE_PROCESSING'));
  const gateway = new MockGateway();
  const job = await jobService.claimNextJob('KNOWLEDGE_ANALYSIS');
  assert.ok(job);
  await knowledgeAnalysisService.analyze(job, gateway);
  assert.equal(gateway.calls, 0);
  const done = await jobService.getJob(job.id);
  assert.equal(done?.status, 'FAILED');
  assert.equal(done?.errorCode, 'KNOWLEDGE_MODEL_NOT_CONFIGURED');
  await setupKnowledgeConfig();
});

// ---------------------------------------------------------------------------
// Structured output & segment validation
// ---------------------------------------------------------------------------

test('invalid segment id is rejected', async () => {
  await transcribedBatch('badseg.mp3');
  const analysis: KnowledgeAnalysis = {
    destinations: [],
    knowledge: [
      {
        destinationReference: null,
        knowledgeType: 'FACT',
        category: null,
        entityType: null,
        entityName: null,
        attribute: null,
        value: null,
        unit: null,
        qualifiers: [],
        canonicalText: 'دانش نامعتبر',
        sourceSegmentIds: [999999],
        confidence: 0.9,
      },
    ],
  };
  const gateway = new MockGateway('success', analysis);
  const job = await jobService.claimNextJob('KNOWLEDGE_ANALYSIS');
  assert.ok(job);
  await knowledgeAnalysisService.analyze(job, gateway);

  const done = await jobService.getJob(job.id);
  assert.equal(done?.status, 'FAILED');
  assert.equal(done?.errorCode, 'KNOWLEDGE_INVALID_SEGMENT');
});

// ---------------------------------------------------------------------------
// Knowledge candidates (Phase 9: extraction → candidates, never master)
// ---------------------------------------------------------------------------

test('analysis creates candidates, not master knowledge, plus a delta job', async () => {
  const { batchId, transcriptId, segmentId } = await transcribedBatch('atomic.mp3');
  const gateway = new MockGateway('success', buildAnalysis(segmentId));
  const job = await jobService.claimNextJob('KNOWLEDGE_ANALYSIS');
  assert.ok(job);
  await knowledgeAnalysisService.analyze(job, gateway);

  const db = getDatabase();
  // Master knowledge is NOT mutated by extraction since Phase 9.
  const items = await db.select().from(knowledgeItems);
  assert.equal(items.length, 0);

  const candidates = await db.select().from(knowledgeCandidates);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.knowledgeType, 'FACT');
  assert.equal(candidates[0]?.entityName, 'هتل پارس');
  assert.equal(candidates[0]?.valueText, '۵ دقیقه');
  assert.equal(candidates[0]?.status, 'PENDING');
  assert.equal(candidates[0]?.identityKey.length, 64);
  assert.equal(candidates[0]?.valueHash.length, 64);
  assert.equal(candidates[0]?.transcriptId, transcriptId);

  const links = await db.select().from(transcriptDestinations);
  assert.equal(links.length, 1);

  const run = await db.select().from(knowledgeAnalysisRuns);
  assert.equal(run.length, 1);
  assert.equal(run[0]?.status, 'COMPLETED');

  const usage = await db.select().from(apiUsage).where(eq(apiUsage.stage, 'KNOWLEDGE'));
  assert.equal(usage.length, 1);
  assert.equal(usage[0]?.status, 'SUCCESS');
  assert.equal(usage[0]?.inputTokens, 7);
  assert.equal(usage[0]?.totalTokens, 16);

  // Exactly one delta job for this transcript, created in the same txn.
  const deltaJobs = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.batchId, batchId), eq(jobs.jobType, 'KNOWLEDGE_DELTA')));
  assert.equal(deltaJobs.length, 1);
  assert.equal(deltaJobs[0]?.entityId, transcriptId);
  assert.equal(deltaJobs[0]?.status, 'PENDING');

  const done = await jobService.getJob(job.id);
  assert.equal(done?.status, 'COMPLETED');
});

test('low-confidence candidates are rejected entirely', async () => {
  const { segmentId } = await transcribedBatch('lowconf.mp3');
  const analysis: KnowledgeAnalysis = {
    destinations: [],
    knowledge: [
      {
        destinationReference: null,
        knowledgeType: 'FACT',
        category: null,
        entityType: null,
        entityName: 'هتل',
        attribute: 'کیفیت',
        value: 'خوب',
        unit: null,
        qualifiers: [],
        canonicalText: 'کیفیت خوب است.',
        sourceSegmentIds: [segmentId],
        confidence: 0.1,
      },
    ],
  };
  const gateway = new MockGateway('success', analysis);
  const job = await jobService.claimNextJob('KNOWLEDGE_ANALYSIS');
  assert.ok(job);
  await knowledgeAnalysisService.analyze(job, gateway);

  const db = getDatabase();
  const candidates = await db.select().from(knowledgeCandidates);
  assert.equal(candidates.length, 0, 'low confidence is never persisted');
  const deltaJobs = await db
    .select()
    .from(jobs)
    .where(eq(jobs.jobType, 'KNOWLEDGE_DELTA'));
  assert.equal(deltaJobs.length, 0, 'no candidates means no delta job');
});

// ---------------------------------------------------------------------------
// Identity key
// ---------------------------------------------------------------------------

test('identity key is deterministic', () => {
  const a = buildKnowledgeIdentityKey({
    destinationId: 3,
    knowledgeType: 'FACT',
    entityName: 'هتل پارس',
    attribute: 'فاصله تا حرم',
    scope: null,
  });
  const b = buildKnowledgeIdentityKey({
    destinationId: 3,
    knowledgeType: 'FACT',
    entityName: 'هتل پارس',
    attribute: 'فاصله تا حرم',
    scope: null,
  });
  assert.equal(a, b);
  assert.equal(a.length, 64);
  const c = buildKnowledgeIdentityKey({
    destinationId: 3,
    knowledgeType: 'FACT',
    entityName: 'هتل پارس',
    attribute: 'قیمت',
    scope: null,
  });
  assert.notEqual(a, c);
});

// ---------------------------------------------------------------------------
// Duplicate skip & idempotency
// ---------------------------------------------------------------------------

test('duplicate transcript skips knowledge analysis', async () => {
  // Two distinct audio files whose transcription yields the SAME normalized
  // text → same transcript hash → the second transcript is a duplicate and
  // gets no knowledge job (the mock always returns the same text).
  writeFixture('dup-k-1.mp3');
  const first = await batchService.createBatch();
  await batchService.scanBatch(first.id);
  await batchService.startBatch(first.id);
  const jobs1 = await jobService.claimNextJob('TRANSCRIPTION');
  assert.ok(jobs1);
  await new TranscriptionWorker(new MockGateway('success')).processJob(jobs1);

  // Add the second file only now, so the second batch sees a fresh audio.
  const secondBytes = join(dir, 'audio', 'dup-k-2.mp3');
  writeFileSync(secondBytes, new Uint8Array([9, 9, 9, 9]));
  const second = await batchService.createBatch();
  await batchService.scanBatch(second.id);
  await batchService.startBatch(second.id);
  const jobs2 = await jobService.claimNextJob('TRANSCRIPTION');
  assert.ok(jobs2);
  await new TranscriptionWorker(new MockGateway('success')).processJob(jobs2);

  const db = getDatabase();
  // The new file, not the re-scanned dup-k-1.mp3 DUPLICATE row.
  const secondAudio = await db
    .select({ id: audioFiles.id })
    .from(audioFiles)
    .where(and(eq(audioFiles.batchId, second.id), eq(audioFiles.absolutePath, secondBytes)))
    .get();
  assert.ok(secondAudio);
  const t2 = await db
    .select()
    .from(transcripts)
    .where(eq(transcripts.audioId, secondAudio.id))
    .get();
  assert.ok(t2);
  assert.ok(t2.duplicateOfTranscriptId !== null, 'second transcript is a duplicate');

  const knowledgeJobs = await db
    .select()
    .from(jobs)
    .where(eq(jobs.jobType, 'KNOWLEDGE_ANALYSIS'));
  assert.equal(knowledgeJobs.length, 1, 'only the non-duplicate transcript gets a knowledge job');
});

test('knowledge analysis runs once per transcript (idempotency)', async () => {
  const { batchId, transcriptId } = await transcribedBatch('idem-k.mp3');
  const gateway = new MockGateway();
  const job = await jobService.claimNextJob('KNOWLEDGE_ANALYSIS');
  assert.ok(job);
  await knowledgeAnalysisService.analyze(job, gateway);
  assert.equal(gateway.calls, 1);

  // The completed run means a re-queued job would skip the Gemini call.
  const db = getDatabase();
  const runs = await db
    .select()
    .from(knowledgeAnalysisRuns)
    .where(eq(knowledgeAnalysisRuns.transcriptId, transcriptId));
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.status, 'COMPLETED');
  assert.equal(batchId, batchId);
});

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

test('retryable Gemini failure schedules a retry', async () => {
  await transcribedBatch('retry-k.mp3');
  const gateway = new MockGateway('rate-limit');
  const job = await jobService.claimNextJob('KNOWLEDGE_ANALYSIS');
  assert.ok(job);
  // Retry scheduling lives in the worker (the service re-throws to it).
  await new KnowledgeWorker(gateway).processJob(job);

  const done = await jobService.getJob(job.id);
  assert.equal(done?.status, 'PENDING');
  assert.ok(done?.nextAttemptAt, 'retry is scheduled');
  assert.equal(done?.errorCode, 'GEMINI_RATE_LIMIT');
});

test('invalid structured output is handled safely (no loop)', async () => {
  // A DomainError from validation is permanent — never retried forever.
  await transcribedBatch('invalid-k.mp3');
  const analysis: KnowledgeAnalysis = {
    destinations: [],
    knowledge: [
      {
        destinationReference: null,
        knowledgeType: 'FACT',
        category: null,
        entityType: null,
        entityName: null,
        attribute: null,
        value: null,
        unit: null,
        qualifiers: [],
        canonicalText: 'دانش نامعتبر',
        sourceSegmentIds: [999999],
        confidence: 0.9,
      },
    ],
  };
  const gateway = new MockGateway('success', analysis);
  const job = await jobService.claimNextJob('KNOWLEDGE_ANALYSIS');
  assert.ok(job);
  await knowledgeAnalysisService.analyze(job, gateway);
  const done = await jobService.getJob(job.id);
  assert.equal(done?.status, 'FAILED');
  assert.equal(gateway.calls, 1);
});

// ---------------------------------------------------------------------------
// Restart persistence
// ---------------------------------------------------------------------------

test('analysis survives database reopen', async () => {
  const { segmentId } = await transcribedBatch('persist-k.mp3');
  const gateway = new MockGateway('success', buildAnalysis(segmentId));
  const job = await jobService.claimNextJob('KNOWLEDGE_ANALYSIS');
  assert.ok(job);
  await knowledgeAnalysisService.analyze(job, gateway);

  await closeDatabase();
  await initDatabase();

  const db = getDatabase();
  const candidates = await db.select().from(knowledgeCandidates);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.valueHash.length, 64);
});

// ---------------------------------------------------------------------------
// Job creation wiring
// ---------------------------------------------------------------------------

test('successful transcription creates exactly one knowledge job', async () => {
  await transcribedBatch('wiring.mp3');
  const db = getDatabase();
  const knowledgeJobs = await db
    .select()
    .from(jobs)
    .where(eq(jobs.jobType, 'KNOWLEDGE_ANALYSIS'));
  assert.equal(knowledgeJobs.length, 1);
  assert.equal(knowledgeJobs[0]?.status, 'PENDING');
});
