import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { eq } from 'drizzle-orm';
import type {
  DeltaClassification,
  GeminiUsage,
  KnowledgeAnalysis,
} from '@freebuff/contracts';
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
import { candidatesService } from './knowledge/candidates.service.js';
import { destinationService } from './knowledge/destinations.service.js';
import { buildKnowledgeIdentityKey } from './knowledge/identity.js';
import { knowledgeAnalysisService } from './knowledge/knowledge-analysis.service.js';
import { knowledgeRetrievalService } from './knowledge/knowledge-retrieval.service.js';
import { DeltaWorker } from './knowledge/delta.worker.js';
import { embeddingService } from './knowledge/embedding.js';
import { promptsService } from './prompts.service.js';
import { settingsService } from './settings.service.js';
import { TranscriptionWorker } from './transcription/worker.js';

const KNOWLEDGE_MODEL = 'gemini-2.5-flash';
const EMBEDDING_MODEL = 'text-embedding-004';

const ZERO_USAGE: GeminiUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0 };

type AnalysisItem = KnowledgeAnalysis['knowledge'][number];

function fact(overrides: Partial<AnalysisItem> = {}): AnalysisItem {
  return {
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
    sourceSegmentIds: [],
    confidence: 0.9,
    ...overrides,
  };
}

function analysisFor(items: AnalysisItem[]): KnowledgeAnalysis {
  return {
    destinations: [
      { name: 'مشهد', type: 'CITY', confidence: 'CONFIRMED', aliases: ['Mashhad'] },
    ],
    knowledge: items,
  };
}

type Mode = 'success' | 'rate-limit' | 'api-error' | 'embed-rate-limit' | 'classify-rate-limit';

/** Deterministic mock gateway with scriptable delta classifications. */
class MockDeltaGateway implements GeminiGatewayLike {
  analyzeCalls = 0;
  embedCalls = 0;
  classifyCalls = 0;
  mode: Mode;

  constructor(
    mode: Mode = 'success',
    private readonly analysis: KnowledgeAnalysis = { destinations: [], knowledge: [] },
    private readonly classifications: DeltaClassification[] = [
      { decision: 'NEW', matchedKnowledgeId: 0, confidence: 0.8, reasonCode: 'NEW_FACT' },
    ],
  ) {
    this.mode = mode;
  }

  async testConnection(): Promise<void> {}

  async listModels() {
    return [];
  }

  async transcribeAudio() {
    return {
      text: 'متن ترنسکریپشن.',
      usage: ZERO_USAGE,
      durationMs: 10,
    };
  }

  async analyzeKnowledge() {
    this.analyzeCalls += 1;
    if (this.mode === 'rate-limit' || this.mode === 'api-error') {
      throw new GeminiGatewayError('GEMINI_RATE_LIMIT', 'محدودیت نرخ');
    }
    return { analysis: this.analysis, usage: ZERO_USAGE, durationMs: 20 };
  }

  async createEmbedding() {
    this.embedCalls += 1;
    if (this.mode === 'rate-limit' || this.mode === 'embed-rate-limit' || this.mode === 'api-error') {
      throw new GeminiGatewayError('GEMINI_RATE_LIMIT', 'محدودیت نرخ');
    }
    return { embedding: [0.1, 0.2, 0.3], usage: ZERO_USAGE, durationMs: 5 };
  }

  async classifyDelta() {
    this.classifyCalls += 1;
    if (this.mode === 'rate-limit' || this.mode === 'classify-rate-limit' || this.mode === 'api-error') {
      throw new GeminiGatewayError('GEMINI_RATE_LIMIT', 'محدودیت نرخ');
    }
    const classification =
      this.classifications[this.classifyCalls - 1] ??
      this.classifications[this.classifications.length - 1];
    if (!classification) {
      throw new GeminiGatewayError('GEMINI_API_ERROR', 'بدون طبقه‌بندی');
    }
    return { classification, usage: ZERO_USAGE, durationMs: 9 };
  }
}

let dir: string;

function writeFixture(name: string): void {
  writeFileSync(join(dir, 'audio', name), new Uint8Array([1, 2, 3, 4]));
}

/**
 * Full pipeline: batch + transcription → knowledge analysis → candidates +
 * delta job. The gateway drives transcription, analysis AND (later) delta.
 */
async function analyzedTranscript(
  fileName: string,
  gateway: MockDeltaGateway,
): Promise<{ batchId: number; transcriptId: number }> {
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

  const transcriptionJob = await jobService.claimNextJob('TRANSCRIPTION');
  assert.ok(transcriptionJob);
  await new TranscriptionWorker(gateway).processJob(transcriptionJob);

  const transcript = await getDatabase()
    .select()
    .from(transcripts)
    .where(eq(transcripts.audioId, audio.id))
    .get();
  assert.ok(transcript);

  const analysisJob = await jobService.claimNextJob('KNOWLEDGE_ANALYSIS');
  assert.ok(analysisJob);
  await knowledgeAnalysisService.analyze(analysisJob, gateway);
  return { batchId: batch.id, transcriptId: transcript.id };
}

/** Seed existing master knowledge (baseline from Phase 8). Returns its id. */
async function seedMasterKnowledge(input: {
  destinationId: number | null;
  entityName: string | null;
  attribute: string | null;
  value: string | null;
  canonicalText: string;
}): Promise<number> {
  const identityKey = buildKnowledgeIdentityKey({
    destinationId: input.destinationId,
    knowledgeType: 'FACT',
    entityName: input.entityName,
    attribute: input.attribute,
    scope: null,
  });
  const db = getDatabase();
  const now = new Date();
  const item = await db
    .insert(knowledgeItems)
    .values({
      destinationId: input.destinationId,
      knowledgeType: 'FACT',
      entityName: input.entityName,
      attribute: input.attribute,
      identityKey,
      canonicalText: input.canonicalText,
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: knowledgeItems.id });
  const id = item[0]?.id;
  assert.ok(id);
  await db.insert(knowledgeVersions).values({
    knowledgeId: id,
    versionNumber: 1,
    valueText: input.value,
    unit: null,
    qualifiersJson: null,
    canonicalText: input.canonicalText,
    isCurrent: true,
    createdAt: now,
  });
  return id;
}

async function resolveDestination(name = 'مشهد'): Promise<number> {
  const resolved = await destinationService.resolveOrCreateDestination(
    { name, type: 'CITY', confidence: 'CONFIRMED' },
    null,
  );
  assert.ok(resolved);
  return resolved.id;
}

/** Process every KNOWLEDGE_DELTA job of a batch with the given gateway. */
async function runDeltaJobs(batchId: number, gateway: GeminiGatewayLike): Promise<void> {
  const worker = new DeltaWorker(gateway);
  for (;;) {
    const job = await jobService.claimNextJob('KNOWLEDGE_DELTA');
    if (!job) break;
    await worker.processJob(job);
  }
  assert.ok(batchId > 0);
}

async function decisionFor(candidateId: number) {
  return getDatabase()
    .select()
    .from(knowledgeDeltaDecisions)
    .where(eq(knowledgeDeltaDecisions.candidateId, candidateId))
    .get();
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'freebuff-phase9-test-'));
  mkdirSync(join(dir, 'audio'), { recursive: true });
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.GEMINI_CREDENTIALS_FILE = join(dir, 'gemini.key');
  await initDatabase();
  await promptsService.ensureDefaultTemplates();
  await settingsService.updateSettings({ workspacePath: dir, processingConcurrency: 2 });
  await promptsService.saveVersion('TRANSCRIPTION', { content: 'پرامپت تست تبدیل صوت' });
  await promptsService.saveVersion('KNOWLEDGE_PROCESSING', { content: 'پرامپت تست تحلیل دانش' });
  await credentialStore.saveKey('test-key');
  const db = getDatabase();
  const now = new Date();
  for (const [stage, modelId] of [
    ['TRANSCRIPTION', KNOWLEDGE_MODEL],
    ['KNOWLEDGE_PROCESSING', KNOWLEDGE_MODEL],
    ['EMBEDDING', EMBEDDING_MODEL],
  ] as const) {
    await db
      .insert(modelConfigs)
      .values({ stage, provider: 'GEMINI', modelId, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: modelConfigs.stage,
        set: { modelId, provider: 'GEMINI', updatedAt: now },
      });
  }
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
  await db.delete(deltaMetrics);
  await db.delete(knowledgeDeltaDecisions);
  await db.delete(knowledgeEmbeddings);
  await db.delete(knowledgeCandidates);
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
  await db.delete(apiUsage);
  rmSync(join(dir, 'audio'), { recursive: true, force: true });
  mkdirSync(join(dir, 'audio'), { recursive: true });
});

// ---------------------------------------------------------------------------
// Exact gate (spec §39)
// ---------------------------------------------------------------------------

test('same identity + same value → CONFIRMATION without any Gemini call', async () => {
  const destId = await resolveDestination();
  const existingId = await seedMasterKnowledge({
    destinationId: destId,
    entityName: 'هتل پارس',
    attribute: 'فاصله تا حرم',
    value: '۵ دقیقه',
    canonicalText: 'هتل پارس پنج دقیقه با حرم فاصله دارد.',
  });
  const gateway = new MockDeltaGateway('success', analysisFor([fact()]));
  const { batchId } = await analyzedTranscript('exact-1.mp3', gateway);
  await runDeltaJobs(batchId, gateway);

  const candidates = await getDatabase().select().from(knowledgeCandidates);
  assert.equal(candidates.length, 1);
  const decision = await decisionFor(candidates[0]?.id as number);
  assert.equal(decision?.decision, 'CONFIRMATION');
  assert.equal(decision?.reasonCode, 'IDENTITY_VALUE_MATCH');
  assert.equal(decision?.matchedKnowledgeId, existingId);
  assert.equal(gateway.classifyCalls, 0, 'no delta AI call');
  assert.equal(gateway.embedCalls, 0, 'no embedding call');
  const metric = await getDatabase().select().from(deltaMetrics);
  assert.equal(metric[0]?.metricKey, 'exact_confirmation_count');
  assert.equal(metric[0]?.value, 1);
});

test('same identity + different value is never auto-confirmed', async () => {
  const destId = await resolveDestination();
  const existingId = await seedMasterKnowledge({
    destinationId: destId,
    entityName: 'هتل پارس',
    attribute: 'فاصله تا حرم',
    value: '۵ دقیقه',
    canonicalText: 'هتل پارس پنج دقیقه با حرم فاصله دارد.',
  });
  const gateway = new MockDeltaGateway(
    'success',
    analysisFor([fact({ value: '۱۰ دقیقه', canonicalText: 'هتل پارس ده دقیقه با حرم فاصله دارد.' })]),
    [{ decision: 'UPDATE', matchedKnowledgeId: existingId, confidence: 0.9, reasonCode: 'VALUE_CHANGED' }],
  );
  const { batchId } = await analyzedTranscript('exact-2.mp3', gateway);
  await runDeltaJobs(batchId, gateway);

  const candidates = await getDatabase().select().from(knowledgeCandidates);
  const decision = await decisionFor(candidates[0]?.id as number);
  assert.equal(decision?.decision, 'UPDATE', 'Gemini reasoning decides, not the exact gate');
  assert.equal(decision?.reasonCode, 'VALUE_CHANGED');
  assert.equal(gateway.classifyCalls, 1);
});

test('exact confirmation creates no embedding reasoning call', async () => {
  const destId = await resolveDestination();
  await seedMasterKnowledge({
    destinationId: destId,
    entityName: 'هتل پارس',
    attribute: 'فاصله تا حرم',
    value: '۵ دقیقه',
    canonicalText: 'هتل پارس پنج دقیقه با حرم فاصله دارد.',
  });
  const gateway = new MockDeltaGateway('success', analysisFor([fact()]));
  const { batchId } = await analyzedTranscript('exact-3.mp3', gateway);
  await runDeltaJobs(batchId, gateway);
  const embeddings = await getDatabase().select().from(knowledgeEmbeddings);
  assert.equal(embeddings.length, 0);
  assert.equal(gateway.embedCalls, 0);
});

// ---------------------------------------------------------------------------
// Retrieval (spec §40)
// ---------------------------------------------------------------------------

test('retrieval is restricted to the candidate destination', async () => {
  const mashhad = await resolveDestination('مشهد');
  const kish = await resolveDestination('کیش');
  await seedMasterKnowledge({
    destinationId: mashhad,
    entityName: 'هتل پارس',
    attribute: 'فاصله تا حرم',
    value: '۵ دقیقه',
    canonicalText: 'هتل پارس پنج دقیقه با حرم فاصله دارد.',
  });
  await seedMasterKnowledge({
    destinationId: kish,
    entityName: 'هتل دریا',
    attribute: 'فاصله تا ساحل',
    value: '۲ دقیقه',
    canonicalText: 'هتل دریا دو دقیقه با ساحل فاصله دارد.',
  });
  const hits = await knowledgeRetrievalService.hybridRetrieve(
    {
      identityKey: buildKnowledgeIdentityKey({
        destinationId: mashhad,
        knowledgeType: 'FACT',
        entityName: 'هتل پارس',
        attribute: 'فاصله تا حرم',
        scope: null,
      }),
      entityName: 'هتل پارس',
      attribute: 'فاصله تا حرم',
      canonicalText: 'هتل پارس پنج دقیقه با حرم فاصله دارد.',
      knowledgeType: 'FACT',
      valueText: '۵ دقیقه',
      unit: null,
    },
    mashhad,
  );
  assert.ok(hits.length >= 1);
  for (const hit of hits) {
    const item = await getDatabase()
      .select()
      .from(knowledgeItems)
      .where(eq(knowledgeItems.id, hit.knowledgeId))
      .get();
    assert.equal(item?.destinationId, mashhad, 'never retrieves other destinations');
  }
});

test('top-k limit is respected', async () => {
  const destId = await resolveDestination();
  for (let i = 0; i < 8; i += 1) {
    await seedMasterKnowledge({
      destinationId: destId,
      entityName: `هتل ${i}`,
      attribute: 'قیمت',
      value: `${i * 10}`,
      canonicalText: `قیمت هتل ${i} ده هزار تومان است.`,
    });
  }
  const hits = await knowledgeRetrievalService.hybridRetrieve(
    {
      identityKey: buildKnowledgeIdentityKey({
        destinationId: destId,
        knowledgeType: 'FACT',
        entityName: 'هتل 1',
        attribute: 'قیمت',
        scope: null,
      }),
      entityName: 'هتل 1',
      attribute: 'قیمت',
      canonicalText: 'قیمت هتل 1 ده هزار تومان است.',
      knowledgeType: 'FACT',
      valueText: '10',
      unit: null,
    },
    destId,
    undefined,
    3,
  );
  assert.ok(hits.length <= 3, `got ${hits.length} hits, limit is 3`);
});

test('embedding cache: same text/model is never embedded twice', async () => {
  const gateway = new MockDeltaGateway();
  const first = await embeddingService.getOrCreate(
    { modelId: EMBEDDING_MODEL, text: 'یک متن ثابت برای کش' },
    gateway,
    'key',
  );
  assert.equal(first.fromCache, false);
  const second = await embeddingService.getOrCreate(
    { modelId: EMBEDDING_MODEL, text: 'یک متن ثابت برای کش' },
    gateway,
    'key',
  );
  assert.equal(second.fromCache, true);
  assert.equal(gateway.embedCalls, 1);
  const rows = await getDatabase().select().from(knowledgeEmbeddings);
  assert.equal(rows.length, 1);
});

// ---------------------------------------------------------------------------
// Decisions (spec §41)
// ---------------------------------------------------------------------------

test('unmatched useful fact → NEW', async () => {
  const gateway = new MockDeltaGateway(
    'success',
    analysisFor([
      fact({
        entityName: null,
        entityType: null,
        attribute: 'ترانسفر فرودگاهی',
        value: 'رایگان',
        canonicalText: 'این پکیج ترانسفر فرودگاهی رایگان دارد.',
      }),
    ]),
    [{ decision: 'NEW', matchedKnowledgeId: 0, confidence: 0.85, reasonCode: 'NEW_FACT' }],
  );
  const { batchId } = await analyzedTranscript('new-1.mp3', gateway);
  await runDeltaJobs(batchId, gateway);
  const candidates = await getDatabase().select().from(knowledgeCandidates);
  const decision = await decisionFor(candidates[0]?.id as number);
  assert.equal(decision?.decision, 'NEW');
  assert.equal(decision?.matchedKnowledgeId, null);
});

test('same fact phrased differently → CONFIRMATION via structured comparison', async () => {
  // Non-critical attribute (صبحانه) so a semantically-same phrasing can be
  // confirmed by the structured comparison (spec §15 protects only critical
  // values from similarity-based confirmation).
  const destId = await resolveDestination();
  const existingId = await seedMasterKnowledge({
    destinationId: destId,
    entityName: 'هتل پارس',
    attribute: 'صبحانه',
    value: 'بوفه',
    canonicalText: 'صبحانه هتل پارس بوفه است.',
  });
  const gateway = new MockDeltaGateway(
    'success',
    analysisFor([
      fact({
        attribute: 'صبحانه',
        value: 'بوفه سلف',
        canonicalText: 'صبحانه هتل پارس بوفه سلف سرویس است.',
      }),
    ]),
    [{ decision: 'CONFIRMATION', matchedKnowledgeId: existingId, confidence: 0.95, reasonCode: 'SAME_FACT' }],
  );
  const { batchId } = await analyzedTranscript('confirm-1.mp3', gateway);
  await runDeltaJobs(batchId, gateway);
  const candidates = await getDatabase().select().from(knowledgeCandidates);
  const decision = await decisionFor(candidates[0]?.id as number);
  assert.equal(decision?.decision, 'CONFIRMATION');
  assert.equal(decision?.matchedKnowledgeId, existingId);
});

test('changed value → UPDATE when justified', async () => {
  const destId = await resolveDestination();
  const existingId = await seedMasterKnowledge({
    destinationId: destId,
    entityName: 'هتل پارس',
    attribute: 'فاصله تا حرم',
    value: '۵ دقیقه',
    canonicalText: 'هتل پارس پنج دقیقه با حرم فاصله دارد.',
  });
  const gateway = new MockDeltaGateway(
    'success',
    analysisFor([fact({ value: '۱۰ دقیقه', canonicalText: 'هتل پارس ده دقیقه با حرم فاصله دارد.' })]),
    [{ decision: 'UPDATE', matchedKnowledgeId: existingId, confidence: 0.9, reasonCode: 'VALUE_CHANGED' }],
  );
  const { batchId } = await analyzedTranscript('update-1.mp3', gateway);
  await runDeltaJobs(batchId, gateway);
  const candidates = await getDatabase().select().from(knowledgeCandidates);
  const decision = await decisionFor(candidates[0]?.id as number);
  assert.equal(decision?.decision, 'UPDATE');
  assert.equal(decision?.matchedKnowledgeId, existingId);
});

test('contradiction → CONFLICT', async () => {
  const destId = await resolveDestination();
  const existingId = await seedMasterKnowledge({
    destinationId: destId,
    entityName: 'هتل پارس',
    attribute: 'فاصله تا حرم',
    value: '۵ دقیقه',
    canonicalText: 'هتل پارس پنج دقیقه با حرم فاصله دارد.',
  });
  const gateway = new MockDeltaGateway(
    'success',
    analysisFor([fact({ value: '۳۰ دقیقه', canonicalText: 'هتل پارس سی دقیقه با حرم فاصله دارد.' })]),
    [{ decision: 'CONFLICT', matchedKnowledgeId: existingId, confidence: 0.7, reasonCode: 'CONTRADICTS_EXISTING' }],
  );
  const { batchId } = await analyzedTranscript('conflict-1.mp3', gateway);
  await runDeltaJobs(batchId, gateway);
  const candidates = await getDatabase().select().from(knowledgeCandidates);
  const decision = await decisionFor(candidates[0]?.id as number);
  assert.equal(decision?.decision, 'CONFLICT');
});

test('noise → IGNORE', async () => {
  const gateway = new MockDeltaGateway(
    'success',
    analysisFor([fact({ canonicalText: 'درود بر همگی' })]),
    [{ decision: 'IGNORE', matchedKnowledgeId: 0, confidence: 0.8, reasonCode: 'NOISE' }],
  );
  const { batchId } = await analyzedTranscript('ignore-1.mp3', gateway);
  await runDeltaJobs(batchId, gateway);
  const candidates = await getDatabase().select().from(knowledgeCandidates);
  const decision = await decisionFor(candidates[0]?.id as number);
  assert.equal(decision?.decision, 'IGNORE');
});

test('critical numeric difference is never auto-confirmed (downgraded to CONFLICT)', async () => {
  const destId = await resolveDestination();
  const existingId = await seedMasterKnowledge({
    destinationId: destId,
    entityName: 'هتل پارس',
    attribute: 'فاصله تا حرم',
    value: '۵ دقیقه',
    canonicalText: 'هتل پارس پنج دقیقه با حرم فاصله دارد.',
  });
  // Gemini says CONFIRMATION but the values differ → the backend must NOT
  // confirm a critical (numeric) difference.
  const gateway = new MockDeltaGateway(
    'success',
    analysisFor([fact({ value: '۱۰ دقیقه', canonicalText: 'هتل پارس ده دقیقه با حرم فاصله دارد.' })]),
    [{ decision: 'CONFIRMATION', matchedKnowledgeId: existingId, confidence: 0.9, reasonCode: 'SAME_FACT' }],
  );
  const { batchId } = await analyzedTranscript('critical-1.mp3', gateway);
  await runDeltaJobs(batchId, gateway);
  const candidates = await getDatabase().select().from(knowledgeCandidates);
  const decision = await decisionFor(candidates[0]?.id as number);
  assert.equal(decision?.decision, 'CONFLICT', 'critical numeric change never auto-confirmed');
});

test('same-batch duplicate candidates do not become multiple NEW items', async () => {
  const gateway = new MockDeltaGateway(
    'success',
    analysisFor([
      fact({ canonicalText: 'هتل پارس پنج دقیقه با حرم فاصله دارد.' }),
      fact({ canonicalText: 'فاصله هتل پارس تا حرم پنج دقیقه است.' }),
    ]),
    [{ decision: 'NEW', matchedKnowledgeId: 0, confidence: 0.8, reasonCode: 'NEW_FACT' }],
  );
  const { batchId } = await analyzedTranscript('samebatch-1.mp3', gateway);
  await runDeltaJobs(batchId, gateway);

  const candidates = await getDatabase()
    .select()
    .from(knowledgeCandidates)
    .orderBy(knowledgeCandidates.id);
  assert.equal(candidates.length, 2);
  const first = await decisionFor(candidates[0]?.id as number);
  const second = await decisionFor(candidates[1]?.id as number);
  assert.equal(first?.decision, 'NEW');
  assert.equal(second?.decision, 'CONFIRMATION');
  assert.equal(second?.reasonCode, 'SAME_BATCH_DUPLICATE');
  assert.equal(second?.matchedCandidateId, candidates[0]?.id);
  const newCount = (await getDatabase().select().from(knowledgeDeltaDecisions)).filter(
    (d) => d.decision === 'NEW',
  ).length;
  assert.equal(newCount, 1, 'only one NEW for the same fact');
  assert.equal(gateway.classifyCalls, 1, 'the duplicate needs no second AI call');
});

test('same-batch conflicting values become a conflict group, never two NEWs', async () => {
  const gateway = new MockDeltaGateway(
    'success',
    analysisFor([
      fact({ value: '۵ دقیقه', canonicalText: 'فروشنده الف: فاصله پنج دقیقه است.' }),
      fact({ value: '۱۵ دقیقه', canonicalText: 'فروشنده ب: فاصله پانزده دقیقه است.' }),
    ]),
    [{ decision: 'NEW', matchedKnowledgeId: 0, confidence: 0.8, reasonCode: 'NEW_FACT' }],
  );
  const { batchId } = await analyzedTranscript('batchconflict-1.mp3', gateway);
  await runDeltaJobs(batchId, gateway);

  const candidates = await getDatabase()
    .select()
    .from(knowledgeCandidates)
    .orderBy(knowledgeCandidates.id);
  const first = await decisionFor(candidates[0]?.id as number);
  const second = await decisionFor(candidates[1]?.id as number);
  assert.equal(first?.decision, 'CONFLICT');
  assert.equal(first?.reasonCode, 'SAME_BATCH_CONFLICT');
  assert.equal(second?.decision, 'CONFLICT');
  assert.equal(second?.reasonCode, 'SAME_BATCH_CONFLICT');
  const newCount = (await getDatabase().select().from(knowledgeDeltaDecisions)).filter(
    (d) => d.decision === 'NEW',
  ).length;
  assert.equal(newCount, 0, 'neither conflicting claim becomes NEW');
});

// ---------------------------------------------------------------------------
// Reliability (spec §42)
// ---------------------------------------------------------------------------

test('delta job idempotency: re-run with same config skips Gemini', async () => {
  const gateway = new MockDeltaGateway(
    'success',
    analysisFor([
      fact({ entityName: null, entityType: null, attribute: 'ترانسفر', value: 'رایگان', canonicalText: 'ترانسفر رایگان است.' }),
    ]),
    [{ decision: 'NEW', matchedKnowledgeId: 0, confidence: 0.8, reasonCode: 'NEW_FACT' }],
  );
  const { batchId } = await analyzedTranscript('idem-delta.mp3', gateway);
  await runDeltaJobs(batchId, gateway);
  assert.equal(gateway.classifyCalls, 1);

  // Simulate a re-queued run: candidate AND delta job back to PENDING, with
  // the same config — the existing decision must be reused.
  const candidates = await getDatabase().select().from(knowledgeCandidates);
  await candidatesService.setStatus(candidates[0]?.id as number, 'PENDING');
  const deltaJobs = await getDatabase()
    .select()
    .from(jobs)
    .where(eq(jobs.jobType, 'KNOWLEDGE_DELTA'));
  assert.equal(deltaJobs.length, 1);
  await getDatabase()
    .update(jobs)
    .set({ status: 'PENDING', nextAttemptAt: null, errorCode: null, errorMessage: null, updatedAt: new Date() })
    .where(eq(jobs.id, deltaJobs[0]?.id as number));
  // The batch reached a terminal state; reopen it so the requeued job is
  // claimable again (production re-runs work the same way).
  await getDatabase()
    .update(batches)
    .set({ status: 'DELTA_PROCESSING', updatedAt: new Date() })
    .where(eq(batches.id, batchId));
  await runDeltaJobs(batchId, gateway);

  const decision = await decisionFor(candidates[0]?.id as number);
  assert.equal(decision?.decision, 'NEW');
  assert.equal(gateway.classifyCalls, 1, 'no second Gemini call for the same comparison');
  const metrics = await getDatabase().select().from(deltaMetrics);
  assert.ok(metrics.some((m) => m.metricKey === 'delta_ai_call_skipped_count' && m.value >= 1));
});

test('restart recovery: decisions survive a database reopen', async () => {
  const gateway = new MockDeltaGateway('success', analysisFor([fact()]));
  const { batchId } = await analyzedTranscript('reopen-delta.mp3', gateway);
  await runDeltaJobs(batchId, gateway);

  await closeDatabase();
  await initDatabase();

  const candidates = await getDatabase().select().from(knowledgeCandidates);
  const decision = await decisionFor(candidates[0]?.id as number);
  assert.equal(decision?.decision, 'NEW');
  assert.ok(decision?.inputSignature.length > 0);
});

test('failed embedding call is retried by the job engine', async () => {
  // Existing knowledge in the same destination makes the semantic pool
  // non-empty, so the delta engine must compute the candidate embedding.
  const destId = await resolveDestination();
  await seedMasterKnowledge({
    destinationId: destId,
    entityName: 'هتل پارس',
    attribute: 'صبحانه',
    value: 'بوفه',
    canonicalText: 'صبحانه هتل پارس بوفه است.',
  });
  // Analysis succeeds (creates candidates + delta job); only the delta phase
  // hits the embedding rate limit.
  const analysisGateway = new MockDeltaGateway('success', analysisFor([fact()]));
  await analyzedTranscript('embed-retry.mp3', analysisGateway);

  const deltaGateway = new MockDeltaGateway('embed-rate-limit', analysisFor([fact()]));
  const worker = new DeltaWorker(deltaGateway);
  const job = await jobService.claimNextJob('KNOWLEDGE_DELTA');
  assert.ok(job);
  await worker.processJob(job);

  const done = await jobService.getJob(job.id);
  assert.equal(done?.status, 'PENDING', 'retryable embedding failure requeues');
  assert.ok(done?.nextAttemptAt);
  const candidates = await getDatabase().select().from(knowledgeCandidates);
  assert.equal(candidates[0]?.status, 'PENDING', 'claim is reverted so the retry reprocesses');
});

test('failed delta call is retried by the job engine', async () => {
  // Exact identity match exists with a different value → reasoning path.
  const destId = await resolveDestination();
  await seedMasterKnowledge({
    destinationId: destId,
    entityName: 'هتل پارس',
    attribute: 'فاصله تا حرم',
    value: '۵ دقیقه',
    canonicalText: 'هتل پارس پنج دقیقه با حرم فاصله دارد.',
  });
  const analysisGateway = new MockDeltaGateway(
    'success',
    analysisFor([fact({ value: '۱۰ دقیقه', canonicalText: 'هتل پارس ده دقیقه با حرم فاصله دارد.' })]),
  );
  await analyzedTranscript('delta-retry.mp3', analysisGateway);

  // Embedding is cached from analysis? No — disable embedding for this run so
  // the retry exercises the CLASSIFICATION call itself.
  await getDatabase().delete(modelConfigs).where(eq(modelConfigs.stage, 'EMBEDDING'));
  try {
    const deltaGateway = new MockDeltaGateway('classify-rate-limit', analysisFor([fact()]));
    const worker = new DeltaWorker(deltaGateway);
    const job = await jobService.claimNextJob('KNOWLEDGE_DELTA');
    assert.ok(job);
    await worker.processJob(job);
    const done = await jobService.getJob(job.id);
    assert.equal(done?.status, 'PENDING');
    assert.ok(done?.nextAttemptAt);
  } finally {
    const now = new Date();
    await getDatabase()
      .insert(modelConfigs)
      .values({
        stage: 'EMBEDDING',
        provider: 'GEMINI',
        modelId: EMBEDDING_MODEL,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: modelConfigs.stage,
        set: { modelId: EMBEDDING_MODEL, provider: 'GEMINI', updatedAt: now },
      });
  }
});

test('invalid structured output is handled safely (limited retry, no loop)', async () => {
  const destId = await resolveDestination();
  await seedMasterKnowledge({
    destinationId: destId,
    entityName: 'هتل پارس',
    attribute: 'فاصله تا حرم',
    value: '۵ دقیقه',
    canonicalText: 'هتل پارس پنج دقیقه با حرم فاصله دارد.',
  });
  // The classifier keeps referencing an id that is NOT in the provided
  // context — always invalid.
  const analysisGateway = new MockDeltaGateway(
    'success',
    analysisFor([fact({ value: '۱۰ دقیقه', canonicalText: 'هتل پارس ده دقیقه با حرم فاصله دارد.' })]),
  );
  await analyzedTranscript('invalid-delta.mp3', analysisGateway);

  const deltaGateway = new MockDeltaGateway(
    'success',
    analysisFor([fact()]),
    [
      { decision: 'UPDATE', matchedKnowledgeId: 999999, confidence: 0.9, reasonCode: 'VALUE_CHANGED' },
      { decision: 'UPDATE', matchedKnowledgeId: 999999, confidence: 0.9, reasonCode: 'VALUE_CHANGED' },
    ],
  );
  const worker = new DeltaWorker(deltaGateway);
  const job = await jobService.claimNextJob('KNOWLEDGE_DELTA');
  assert.ok(job);
  await worker.processJob(job);

  const done = await jobService.getJob(job.id);
  assert.equal(done?.status, 'FAILED');
  assert.equal(done?.errorCode, 'DELTA_CLASSIFICATION_INVALID');
  assert.equal(deltaGateway.classifyCalls, 2, 'limited retry, then permanent failure');
  const candidates = await getDatabase().select().from(knowledgeCandidates);
  assert.equal(candidates[0]?.status, 'FAILED');
});

test('two workers never corrupt the same candidate decision', async () => {
  const gateway = new MockDeltaGateway('success', analysisFor([fact()]));
  const { batchId } = await analyzedTranscript('twoworkers.mp3', gateway);
  const candidate = await getDatabase().select().from(knowledgeCandidates).get();
  assert.ok(candidate);

  // Atomic claim: only one worker wins.
  const first = await candidatesService.claimCandidate(candidate.id);
  assert.ok(first);
  const second = await candidatesService.claimCandidate(candidate.id);
  assert.equal(second, null, 'second worker cannot claim the same candidate');

  // Revert the winner so the real job processes it exactly once.
  await candidatesService.revertClaim(candidate.id);
  await runDeltaJobs(batchId, gateway);

  const decisions = await getDatabase()
    .select()
    .from(knowledgeDeltaDecisions)
    .where(eq(knowledgeDeltaDecisions.candidateId, candidate.id));
  assert.equal(decisions.length, 1, 'exactly one decision row per candidate');
});

// ---------------------------------------------------------------------------
// Manual scenario (spec §43)
// ---------------------------------------------------------------------------

test('manual Mashhad scenario produces the expected decision set without master mutation', async () => {
  const destId = await resolveDestination('مشهد');
  await seedMasterKnowledge({
    destinationId: destId,
    entityName: 'هتل X',
    attribute: 'صبحانه',
    value: 'بوفه',
    canonicalText: 'صبحانه هتل X بوفه است.',
  });
  await seedMasterKnowledge({
    destinationId: destId,
    entityName: 'هتل X',
    attribute: 'فاصله تا حرم',
    value: '۱۰ دقیقه',
    canonicalText: 'فاصله هتل X تا حرم ده دقیقه است.',
  });

  const items: AnalysisItem[] = [
    fact({
      entityName: 'هتل X',
      attribute: 'صبحانه',
      value: 'بوفه',
      canonicalText: 'صبحانه هتل X بوفه است.',
    }),
    fact({
      entityName: 'هتل X',
      attribute: 'فاصله تا حرم',
      value: '۵ دقیقه',
      canonicalText: 'فاصله هتل X تا حرم پنج دقیقه است.',
    }),
    fact({
      entityName: 'هتل X',
      attribute: 'ترانسفر فرودگاهی',
      value: 'رایگان',
      canonicalText: 'این پکیج ترانسفر فرودگاهی رایگان دارد.',
    }),
    fact({
      entityName: 'هتل X',
      attribute: 'فاصله تا حرم',
      value: '۲۰ دقیقه',
      canonicalText: 'فاصله هتل X تا حرم بیست دقیقه است.',
    }),
  ];
  const gateway = new MockDeltaGateway(
    'success',
    analysisFor(items),
    [
      // (1) breakfast → exact gate (no AI call)
      // (2) distance 5 → sibling conflict with distance 20 (no AI call)
      // (3) free transfer → NEW
      { decision: 'NEW', matchedKnowledgeId: 0, confidence: 0.85, reasonCode: 'NEW_FACT' },
      // (4) distance 20 → sibling conflict with distance 5 (no AI call)
    ],
  );
  const { batchId } = await analyzedTranscript('scenario.mp3', gateway);
  await runDeltaJobs(batchId, gateway);

  const candidates = await getDatabase()
    .select()
    .from(knowledgeCandidates)
    .orderBy(knowledgeCandidates.id);
  assert.equal(candidates.length, 4);
  const decisions = await getDatabase()
    .select()
    .from(knowledgeDeltaDecisions)
    .orderBy(knowledgeDeltaDecisions.candidateId);
  assert.equal(decisions.length, 4);

  const byAttribute = new Map(candidates.map((c, index) => [c.attribute, decisions[index]?.decision]));
  assert.equal(byAttribute.get('صبحانه'), 'CONFIRMATION');
  assert.equal(byAttribute.get('ترانسفر فرودگاهی'), 'NEW');
  // The two conflicting distance claims form a conflict group (safe, no NEW).
  assert.equal(byAttribute.get('فاصله تا حرم'), 'CONFLICT');

  const itemsAfter = await getDatabase().select().from(knowledgeItems);
  assert.equal(itemsAfter.length, 2, 'no master knowledge is mutated in Phase 9');
  const newCount = decisions.filter((d) => d.decision === 'NEW').length;
  assert.equal(newCount, 1);
  assert.equal(gateway.classifyCalls, 1, 'only the unresolved fact needed Gemini');
  // The unresolved fact has no existing knowledge to compare with, so no
  // embedding is computed at all — a token-saving property.
  assert.equal(gateway.embedCalls, 0, 'embedding only runs when a comparison pool exists');
});
