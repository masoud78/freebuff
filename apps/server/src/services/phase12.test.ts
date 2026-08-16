import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { eq } from 'drizzle-orm';
import type {
  DeltaDecision,
  GeminiUsage,
  KnowledgeAnalysis,
} from '@freebuff/contracts';
import { closeDatabase, getDatabase, initDatabase } from '../core/database/index.js';
import {
  apiUsage,
  audioFiles,
  batches,
  batchDestinationSummaries,
  deltaMetrics,
  destinationAliases,
  destinations,
  generatedContentKnowledge,
  generatedContents,
  geminiModels,
  jobs,
  knowledgeAnalysisRuns,
  knowledgeCandidates,
  knowledgeChanges,
  knowledgeConflicts,
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
import type { GeminiGatewayLike } from './gemini/gateway.js';
import { jobService } from './jobs.service.js';
import { batchContentGenerationService } from './content/batch-content-generation.service.js';
import { ContentWorker } from './content/content.worker.js';
import { batchDeltaService } from './knowledge/batch-delta.service.js';
import { batchFinalizationService } from './knowledge/batch-finalization.service.js';
import { DeltaWorker } from './knowledge/delta.worker.js';
import { knowledgeAnalysisService } from './knowledge/knowledge-analysis.service.js';
import { ReconciliationWorker } from './knowledge/reconciliation.worker.js';
import { pipelinePreflightService } from './pipeline-preflight.service.js';
import { pipelineRecoveryService } from './pipeline-recovery.service.js';
import { promptsService } from './prompts.service.js';
import { settingsService } from './settings.service.js';
import { TranscriptionWorker } from './transcription/worker.js';

const KNOWLEDGE_MODEL = 'gemini-2.5-flash';
const EMBEDDING_MODEL = 'text-embedding-004';
const CONTENT_MODEL = 'gemini-2.5-flash';

const ZERO_USAGE: GeminiUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0 };

type AnalysisItem = KnowledgeAnalysis['knowledge'][number];

function fact(overrides: Partial<AnalysisItem> = {}): AnalysisItem {
  return {
    destinationReference: 'مشهد',
    knowledgeType: 'FACT',
    category: null,
    entityType: 'هتل',
    entityName: 'هتل X',
    attribute: 'فاصله تا حرم',
    value: '۵ دقیقه',
    unit: null,
    qualifiers: [],
    canonicalText: 'هتل X پنج دقیقه با حرم فاصله دارد.',
    sourceSegmentIds: [],
    confidence: 0.9,
    ...overrides,
  };
}

function analysisFor(destinationName: string, items: AnalysisItem[]): KnowledgeAnalysis {
  return {
    destinations: [{ name: destinationName, type: 'CITY', confidence: 'CONFIRMED', aliases: [] }],
    knowledge: items,
  };
}

/** Transcripts used to route analysis output by the mock gateway. */
const TEXT_MASHHAD_A = 'گفتگوی مشهد الف — صبحانه هتل X بوفه است.';
const TEXT_MASHHAD_B = 'گفتگوی مشهد ب — ترانسفر فرودگاهی رایگان است.';
const TEXT_KISH_C = 'گفتگوی کیش — صبحانه هتل Y شامل است.';

const ANALYSIS_MASHHAD_A = analysisFor('مشهد', [
  fact({ attribute: 'صبحانه', value: 'بوفه', canonicalText: 'صبحانه هتل X بوفه است.' }),
]);
const ANALYSIS_MASHHAD_B = analysisFor('مشهد', [
  fact({ attribute: 'صبحانه', value: 'بوفه', canonicalText: 'صبحانه هتل X بوفه است.' }),
  fact({ entityName: null, entityType: null, attribute: 'ترانسفر فرودگاهی', value: 'رایگان', canonicalText: 'ترانسفر فرودگاهی این پکیج رایگان است.' }),
]);
const ANALYSIS_KISH_C = analysisFor('کیش', [
  fact({ destinationReference: 'کیش', entityName: 'هتل Y', attribute: 'صبحانه', value: 'شامل', canonicalText: 'صبحانه هتل Y شامل است.' }),
]);

interface ScriptedClassification {
  decision: DeltaDecision;
  reasonCode: string;
}

/**
 * Deterministic end-to-end gateway. Transcription is routed by file name,
 * analysis by transcript text, and delta classification by a scripted queue
 * (UPDATE/CONFLICT pick the first provided existing knowledge id — exactly
 * what a real comparison would do with the retrieved context).
 */
class E2EGateway implements GeminiGatewayLike {
  transcriptionCalls = 0;
  knowledgeCalls = 0;
  classifyCalls = 0;
  contentCalls = 0;
  contentInputs: string[] = [];

  constructor(
    private readonly byText: Record<string, { analysis: KnowledgeAnalysis }>,
    private readonly fileToText: Record<string, string>,
    private readonly scripted: ScriptedClassification[] = [],
  ) {}

  async testConnection(): Promise<void> {}
  async listModels() {
    return [];
  }

  async transcribeAudio(input: { audioPath: string }): Promise<{ text: string; usage: GeminiUsage; durationMs: number }> {
    this.transcriptionCalls += 1;
    const name = input.audioPath.split(/[\\/]/).pop() ?? '';
    const text = this.fileToText[name];
    if (text === undefined) throw new Error(`no transcript for ${name}`);
    return { text, usage: ZERO_USAGE, durationMs: 10 };
  }

  async analyzeKnowledge(input: { transcriptText: string }): Promise<{ analysis: KnowledgeAnalysis; usage: GeminiUsage; durationMs: number }> {
    this.knowledgeCalls += 1;
    const routed = this.byText[input.transcriptText];
    if (!routed) throw new Error(`no analysis for ${input.transcriptText}`);
    return { analysis: routed.analysis, usage: ZERO_USAGE, durationMs: 20 };
  }

  async classifyDelta(input: {
    payload: { existingKnowledge: { id: number }[] };
  }): Promise<{ classification: { decision: DeltaDecision; matchedKnowledgeId: number; confidence: number; reasonCode: string }; usage: GeminiUsage; durationMs: number }> {
    this.classifyCalls += 1;
    const scripted = this.scripted[this.classifyCalls - 1] ?? { decision: 'NEW', reasonCode: 'NEW_FACT' };
    const needsMatch = scripted.decision === 'UPDATE' || scripted.decision === 'CONFIRMATION' || scripted.decision === 'CONFLICT';
    return {
      classification: {
        decision: scripted.decision,
        matchedKnowledgeId: needsMatch ? (input.payload.existingKnowledge[0]?.id ?? 0) : 0,
        confidence: 0.9,
        reasonCode: scripted.reasonCode,
      },
      usage: ZERO_USAGE,
      durationMs: 9,
    };
  }

  async analyzeNotes(): Promise<never> {
    throw new Error('not used in this test suite');
  }

  async compareNote(): Promise<never> {
    throw new Error('not used in this test suite');
  }

  async createEmbedding(): Promise<{ embedding: number[]; usage: GeminiUsage; durationMs: number }> {
    return { embedding: [0.1, 0.2, 0.3], usage: ZERO_USAGE, durationMs: 5 };
  }

  async generateContent(input: { userText: string }): Promise<{ text: string; usage: GeminiUsage; durationMs: number }> {
    this.contentCalls += 1;
    this.contentInputs.push(input.userText);
    return { text: `محتوا: ${input.userText.slice(0, 80)}`, usage: ZERO_USAGE, durationMs: 10 };
  }
}

/** Run every stage of the batch to completion with the given gateway. */
async function processBatchFully(batchId: number, gateway: GeminiGatewayLike): Promise<void> {
  for (;;) {
    const job = await jobService.claimNextJob('TRANSCRIPTION');
    if (!job) break;
    await new TranscriptionWorker(gateway).processJob(job);
  }
  for (;;) {
    const job = await jobService.claimNextJob('KNOWLEDGE_ANALYSIS');
    if (!job) break;
    await knowledgeAnalysisService.analyze(job, gateway);
  }
  for (;;) {
    const job = await jobService.claimNextJob('KNOWLEDGE_DELTA');
    if (!job) break;
    await new DeltaWorker(gateway).processJob(job);
  }
  for (;;) {
    const job = await jobService.claimNextJob('KNOWLEDGE_RECONCILIATION');
    if (!job) break;
    await new ReconciliationWorker().processJob(job);
  }
  await batchFinalizationService.finalizeIfComplete(batchId);
  for (;;) {
    const job = await jobService.claimNextJob('CONTENT_GENERATION');
    if (!job) break;
    await new ContentWorker(gateway).processJob(job);
  }
  await batchFinalizationService.finalizeIfComplete(batchId);
}

/** Create + scan + start a batch containing the given fixture files. */
async function createStartedBatch(fileNames: string[]): Promise<number> {
  for (const name of fileNames) writeFixture(name);
  const batch = await batchService.createBatch();
  await batchService.scanBatch(batch.id);
  await batchService.startBatch(batch.id);
  return batch.id;
}

let dir: string;

function writeFixture(name: string): void {
  // Deterministic, name-unique bytes so each fixture has a distinct SHA-256.
  const bytes = new Uint8Array(16);
  for (let i = 0; i < name.length; i += 1) bytes[i % 16] = (bytes[i % 16]! + name.charCodeAt(i)) % 256;
  writeFileSync(join(dir, 'audio', name), bytes);
}

async function configureModels(): Promise<void> {
  const db = getDatabase();
  const now = new Date();
  // Model discovery cache (populated by the UI's refresh in production).
  for (const modelId of new Set([KNOWLEDGE_MODEL, EMBEDDING_MODEL, CONTENT_MODEL])) {
    await db
      .insert(geminiModels)
      .values({
        modelId,
        displayName: modelId,
        description: '',
        capabilitiesJson: JSON.stringify({ generative: true, embedding: false, audio: false }),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: geminiModels.modelId });
  }
  for (const [stage, modelId] of [
    ['TRANSCRIPTION', KNOWLEDGE_MODEL],
    ['KNOWLEDGE_PROCESSING', KNOWLEDGE_MODEL],
    ['EMBEDDING', EMBEDDING_MODEL],
    ['CONTENT_GENERATION', CONTENT_MODEL],
  ] as const) {
    await db
      .insert(modelConfigs)
      .values({ stage, provider: 'GEMINI', modelId, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: modelConfigs.stage,
        set: { modelId, provider: 'GEMINI', updatedAt: now },
      });
  }
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'freebuff-phase12-test-'));
  mkdirSync(join(dir, 'audio'), { recursive: true });
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.GEMINI_CREDENTIALS_FILE = join(dir, 'gemini.key');
  await initDatabase();
  await promptsService.ensureDefaultTemplates();
  await settingsService.updateSettings({ workspacePath: dir, processingConcurrency: 2 });
  await promptsService.saveVersion('TRANSCRIPTION', { content: 'پرامپت تست تبدیل صوت' });
  await promptsService.saveVersion('KNOWLEDGE_PROCESSING', { content: 'پرامپت تست تحلیل دانش' });
  await promptsService.saveVersion('CONTENT_GENERATION', { content: 'پرامپت تست تولید محتوا' });
  await credentialStore.saveKey('test-key');
  await configureModels();
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
  await db.delete(generatedContentKnowledge);
  await db.delete(generatedContents);
  await db.delete(batchDestinationSummaries);
  await db.delete(knowledgeConflicts);
  await db.delete(knowledgeChanges);
  await db.delete(knowledgeDeltaDecisions);
  await db.delete(knowledgeCandidates);
  await db.delete(knowledgeEmbeddings);
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
  await db.delete(deltaMetrics);
  rmSync(join(dir, 'audio'), { recursive: true, force: true });
  mkdirSync(join(dir, 'audio'), { recursive: true });
});

// ---------------------------------------------------------------------------
// §40 — End-to-end pipeline (one batch, three audios, two destinations)
// ---------------------------------------------------------------------------

test('E2E: full pipeline creates isolated destination knowledge + per-destination content', async () => {
  const gateway = new E2EGateway(
    {
      [TEXT_MASHHAD_A]: { analysis: ANALYSIS_MASHHAD_A },
      [TEXT_MASHHAD_B]: { analysis: ANALYSIS_MASHHAD_B },
      [TEXT_KISH_C]: { analysis: ANALYSIS_KISH_C },
    },
    {
      'mashhad-a.mp3': TEXT_MASHHAD_A,
      'mashhad-b.mp3': TEXT_MASHHAD_B,
      'kish-c.mp3': TEXT_KISH_C,
    },
  );
  const batchId = await createStartedBatch(['mashhad-a.mp3', 'mashhad-b.mp3', 'kish-c.mp3']);
  await processBatchFully(batchId, gateway);

  const db = getDatabase();

  // Both destinations exist exactly once.
  const destRows = await db.select().from(destinations);
  assert.equal(destRows.length, 2, 'مشهد + کیش');
  const mashhad = destRows.find((d) => d.canonicalName === 'مشهد');
  const kish = destRows.find((d) => d.canonicalName === 'کیش');
  assert.ok(mashhad && kish);

  // Mashhad master: breakfast (2 evidence) + transfer (1 evidence).
  const mashhadItems = await db
    .select()
    .from(knowledgeItems)
    .where(eq(knowledgeItems.destinationId, mashhad.id));
  assert.equal(mashhadItems.length, 2);
  const breakfast = mashhadItems.find((item) => item.attribute === 'صبحانه');
  const transfer = mashhadItems.find((item) => item.attribute === 'ترانسفر فرودگاهی');
  assert.ok(breakfast && transfer);
  const breakfastEvidence = await db
    .select()
    .from(knowledgeEvidence)
    .where(eq(knowledgeEvidence.knowledgeId, breakfast.id));
  assert.equal(breakfastEvidence.length, 2, 'دو شاهد برای صبحانه');
  const transferEvidence = await db
    .select()
    .from(knowledgeEvidence)
    .where(eq(knowledgeEvidence.knowledgeId, transfer.id));
  assert.equal(transferEvidence.length, 1);

  // Kish isolated: only its own breakfast.
  const kishItems = await db
    .select()
    .from(knowledgeItems)
    .where(eq(knowledgeItems.destinationId, kish.id));
  assert.equal(kishItems.length, 1);
  assert.equal(kishItems[0]?.attribute, 'صبحانه');

  // Content: one per destination with publishable delta.
  const contents = await db.select().from(generatedContents);
  assert.equal(contents.length, 2, 'مشهد + کیش هر کدام یک محتوا');
  assert.equal(gateway.contentCalls, 2);

  // Input isolation: Mashhad input has transfer, never kish; Kish input has kish.
  const mashhadInput = gateway.contentInputs.find((text) => text.includes('ترانسفر'));
  const kishInput = gateway.contentInputs.find((text) => text.includes('کیش'));
  assert.ok(mashhadInput, 'ورودی مشهد شامل دانش جدید مشهد است');
  assert.ok(!mashhadInput?.includes('کیش'), 'دانش کیش به ورودی مشهد نشت نکرده است');
  assert.ok(kishInput, 'ورودی کیش شامل دانش کیش است');

  // Both content rows are traceable to real knowledge versions.
  const links = await db.select().from(generatedContentKnowledge);
  assert.equal(links.length, 3, 'صبحانه + ترانسفر + صبحانه کیش');

  const batch = await db.select().from(batches).where(eq(batches.id, batchId)).get();
  assert.equal(batch?.status, 'COMPLETED');
});

// ---------------------------------------------------------------------------
// §41 — Multi-batch: versioning, update, confirmation, conflict
// ---------------------------------------------------------------------------

test('multi-batch: V1 → CONFIRMATION+UPDATE+NEW → CONFLICT, content only from delta', async () => {
  // Batch 1: distance 10 + breakfast buffet.
  const g1 = new E2EGateway(
    {
      [TEXT_MASHHAD_A]: {
        analysis: analysisFor('مشهد', [
          fact({ attribute: 'فاصله تا حرم', value: '۱۰ دقیقه', canonicalText: 'فاصله هتل X تا حرم ده دقیقه است.' }),
          fact({ attribute: 'صبحانه', value: 'بوفه', canonicalText: 'صبحانه هتل X بوفه است.' }),
        ]),
      },
    },
    { 'b1.mp3': TEXT_MASHHAD_A },
  );
  const batch1 = await createStartedBatch(['b1.mp3']);
  await processBatchFully(batch1, g1);

  const db = getDatabase();
  const itemsAfter1 = await db.select().from(knowledgeItems);
  assert.equal(itemsAfter1.length, 2);
  const distanceItem = itemsAfter1.find((item) => item.attribute === 'فاصله تا حرم');
  assert.ok(distanceItem);
  const v1 = await db
    .select()
    .from(knowledgeVersions)
    .where(eq(knowledgeVersions.knowledgeId, distanceItem.id));
  assert.equal(v1.length, 1);
  assert.equal(v1[0]?.versionNumber, 1);
  assert.equal(v1[0]?.valueText, '۱۰ دقیقه');
  assert.equal(v1[0]?.isCurrent, true);

  // Batch 2: breakfast (confirmation), distance 5 (UPDATE), transfer (NEW).
  const TEXT_B2 = 'گفتگوی مشهد دوم — فاصله پنج دقیقه و ترانسفر رایگان.';
  const g2 = new E2EGateway(
    {
      [TEXT_B2]: {
        analysis: analysisFor('مشهد', [
          fact({ attribute: 'صبحانه', value: 'بوفه', canonicalText: 'صبحانه هتل X بوفه است.' }),
          fact({ attribute: 'فاصله تا حرم', value: '۵ دقیقه', canonicalText: 'فاصله هتل X تا حرم پنج دقیقه است.' }),
          fact({ entityName: null, entityType: null, attribute: 'ترانسفر فرودگاهی', value: 'رایگان', canonicalText: 'ترانسفر فرودگاهی رایگان است.' }),
        ]),
      },
    },
    { 'b2.mp3': TEXT_B2 },
    [
      { decision: 'UPDATE', reasonCode: 'VALUE_CHANGED' },
      { decision: 'NEW', reasonCode: 'NEW_FACT' },
    ],
  );
  const batch2 = await createStartedBatch(['b2.mp3']);
  await processBatchFully(batch2, g2);

  // Distance: V1 preserved, V2 current = 5.
  const versions = await db
    .select()
    .from(knowledgeVersions)
    .where(eq(knowledgeVersions.knowledgeId, distanceItem.id))
    .orderBy(knowledgeVersions.versionNumber);
  assert.equal(versions.length, 2);
  assert.equal(versions[0]?.isCurrent, false, 'نسخهٔ قدیمی هرگز overwrite نمیشود');
  assert.equal(versions[1]?.versionNumber, 2);
  assert.equal(versions[1]?.valueText, '۵ دقیقه');
  assert.equal(versions[1]?.isCurrent, true);

  // Breakfast confirmed: still one item, evidence grew, no new version.
  const breakfastAfter = await db
    .select()
    .from(knowledgeItems)
    .where(eq(knowledgeItems.attribute, 'صبحانه'));
  assert.equal(breakfastAfter.length, 1, 'تأیید، دانش تکراری نمیسازد');
  const breakfastEvidenceCount = await db
    .select()
    .from(knowledgeEvidence)
    .where(eq(knowledgeEvidence.knowledgeId, breakfastAfter[0]?.id as number));
  assert.equal(breakfastEvidenceCount.length, 2);

  // Batch 2 delta: distance + transfer only (breakfast confirmation excluded).
  const delta2 = await batchDeltaService.getBatchDelta(batch2);
  const mashhadDelta = delta2.destinations.find((d) => d.destinationName === 'مشهد');
  assert.ok(mashhadDelta);
  const attributes = mashhadDelta.items.map((item) => item.attribute);
  assert.ok(attributes.includes('فاصله تا حرم'));
  assert.ok(attributes.includes('ترانسفر فرودگاهی'));
  assert.ok(!attributes.includes('صبحانه'), 'CONFIRMATION وارد Delta نمیشود');

  // Content input: only the delta, breakfast never appears.
  assert.equal(g2.contentCalls, 1);
  const input2 = g2.contentInputs[0] ?? '';
  assert.ok(input2.includes('فاصله'), 'ورودی محتوا شامل UPDATE است');
  assert.ok(input2.includes('ترانسفر'), 'ورودی محتوا شامل NEW است');
  assert.ok(!input2.includes('صبحانه'), 'تأیید وارد ورودی محتوا نمیشود');

  // Batch 3: distance 20 → CONFLICT, no content.
  const TEXT_B3 = 'گفتگوی مشهد سوم — فاصله بیست دقیقه است.';
  const g3 = new E2EGateway(
    {
      [TEXT_B3]: {
        analysis: analysisFor('مشهد', [
          fact({ attribute: 'فاصله تا حرم', value: '۲۰ دقیقه', canonicalText: 'فاصله هتل X تا حرم بیست دقیقه است.' }),
        ]),
      },
    },
    { 'b3.mp3': TEXT_B3 },
    [{ decision: 'CONFLICT', reasonCode: 'CONTRADICTS_EXISTING' }],
  );
  const batch3 = await createStartedBatch(['b3.mp3']);
  await processBatchFully(batch3, g3);

  // Master stays 5 (V2 current).
  const current = await db
    .select()
    .from(knowledgeVersions)
    .where(eq(knowledgeVersions.knowledgeId, distanceItem.id))
    .orderBy(knowledgeVersions.versionNumber);
  assert.equal(current[1]?.isCurrent, true);
  assert.equal(current[1]?.valueText, '۵ دقیقه', 'تعارض حقیقت فعلی را عوض نمیکند');

  const conflicts = await db.select().from(knowledgeConflicts);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.status, 'OPEN');

  const delta3 = await batchDeltaService.getBatchDelta(batch3);
  assert.equal(delta3.destinations.length, 0, 'Delta خالی است');
  assert.equal(g3.contentCalls, 0, 'بدون Delta هیچ Call محتوایی');
  assert.equal(g3.classifyCalls, 1, 'تعارض یک مقایسهٔ AI دارد');

  const batch3Row = await db.select().from(batches).where(eq(batches.id, batch3)).get();
  assert.equal(batch3Row?.status, 'COMPLETED', 'Batch بدون محتوا هم کامل میشود');
});

// ---------------------------------------------------------------------------
// §42 — Restart recovery
// ---------------------------------------------------------------------------

test('restart recovery: stale jobs requeued, successful work never repeated, content generated once', async () => {
  const TEXT1 = 'گفتگوی مشهد الف';
  const TEXT2 = 'گفتگوی مشهد ب';
  const gateway = new E2EGateway(
    {
      [TEXT1]: { analysis: ANALYSIS_MASHHAD_A },
      [TEXT2]: { analysis: ANALYSIS_MASHHAD_B },
    },
    { 'r-a.mp3': TEXT1, 'r-b.mp3': TEXT2 },
  );
  const batchId = await createStartedBatch(['r-a.mp3', 'r-b.mp3']);

  // Complete transcription of A; claim (mark RUNNING) transcription of B and
  // leave it in flight — simulating a crash mid-job.
  const jobA = await jobService.claimNextJob('TRANSCRIPTION');
  assert.ok(jobA);
  await new TranscriptionWorker(gateway).processJob(jobA);
  const jobB = await jobService.claimNextJob('TRANSCRIPTION');
  assert.ok(jobB);
  const callsBeforeCrash = gateway.transcriptionCalls;

  // "Restart": reopen the database and run the recovery sweep.
  await closeDatabase();
  await initDatabase();
  const recovery = await pipelineRecoveryService.recover();
  assert.equal(recovery.recoveredJobs, 1, 'Job در حال اجرا به PENDING برگشت');

  const db = getDatabase();
  const jobBAfter = await jobService.getJob(jobB.id);
  assert.equal(jobBAfter?.status, 'PENDING');
  const jobAAfter = await jobService.getJob(jobA.id);
  assert.equal(jobAAfter?.status, 'COMPLETED', 'کار موفق دوباره اجرا نمیشود');

  // Resume the whole pipeline.
  await processBatchFully(batchId, gateway);
  assert.equal(gateway.transcriptionCalls, callsBeforeCrash + 1, 'فقط فایل ناقص دوباره پردازش شد');

  const contents = await db.select().from(generatedContents);
  assert.equal(contents.length, 1, 'محتوا دقیقاً یک بار تولید شد');
  assert.equal(gateway.contentCalls, 1);

  const batch = await db.select().from(batches).where(eq(batches.id, batchId)).get();
  assert.equal(batch?.status, 'COMPLETED');
});

// ---------------------------------------------------------------------------
// §43 — Duplicate protection
// ---------------------------------------------------------------------------

test('same audio again: duplicate detected, no transcription call', async () => {
  const gateway = new E2EGateway({}, { 'dup.mp3': 'متن' });
  const batch1 = await createStartedBatch(['dup.mp3']);
  assert.equal(gateway.transcriptionCalls, 0, 'scan هرگز Gemini صدا نمیزند');

  // Same file, second batch → DUPLICATE, zero new jobs.
  const batch2 = await batchService.createBatch();
  await batchService.scanBatch(batch2.id);
  const db = getDatabase();
  const audios = await db.select().from(audioFiles).where(eq(audioFiles.batchId, batch2.id));
  assert.equal(audios.length, 1);
  assert.equal(audios[0]?.status, 'DUPLICATE');
  const jobs2 = await db.select().from(jobs).where(eq(jobs.batchId, batch2.id));
  assert.equal(jobs2.length, 0, 'فایل تکراری Job نمیگیرد');
  assert.equal(gateway.transcriptionCalls, 0);
  void batch1;
});

test('same transcript from different audio: no knowledge analysis for the duplicate', async () => {
  const TEXT = 'متن یکسان برای هر دو فایل';
  const gateway = new E2EGateway(
    { [TEXT]: { analysis: ANALYSIS_MASHHAD_A } },
    { 't-a.mp3': TEXT, 't-b.mp3': TEXT },
  );
  const batchId = await createStartedBatch(['t-a.mp3', 't-b.mp3']);
  await processBatchFully(batchId, gateway);

  const db = getDatabase();
  const transcriptRows = await db.select().from(transcripts);
  assert.equal(transcriptRows.length, 2);
  const dup = transcriptRows.find((row) => row.duplicateOfTranscriptId !== null);
  const original = transcriptRows.find((row) => row.duplicateOfTranscriptId === null);
  assert.ok(dup && original, 'دومین transcript به عنوان تکراری علامت خورده');

  const knowledgeJobs = await db
    .select()
    .from(jobs)
    .where(eq(jobs.jobType, 'KNOWLEDGE_ANALYSIS'));
  assert.equal(knowledgeJobs.length, 1, 'فقط یک تحلیل دانش برای متن تکراری');
  assert.equal(gateway.knowledgeCalls, 1);

  // Only one canonical master item.
  const items = await db.select().from(knowledgeItems);
  assert.equal(items.length, 1);
});

// ---------------------------------------------------------------------------
// §9 — Retry a permanently failed job
// ---------------------------------------------------------------------------

test('retry: permanent transcription failure is retried by the user and completes', async () => {
  const gateway = new E2EGateway(
    { [TEXT_MASHHAD_A]: { analysis: ANALYSIS_MASHHAD_A } },
    { 'retry.mp3': TEXT_MASHHAD_A },
  );
  const batchId = await createStartedBatch(['retry.mp3']);

  // Remove the transcription model → permanent failure.
  await getDatabase().delete(modelConfigs).where(eq(modelConfigs.stage, 'TRANSCRIPTION'));
  let job = await jobService.claimNextJob('TRANSCRIPTION');
  assert.ok(job);
  await new TranscriptionWorker(gateway).processJob(job);
  const failed = await jobService.getJob(job.id);
  assert.equal(failed?.status, 'FAILED');
  assert.equal(failed?.errorCode, 'TRANSCRIPTION_MODEL_NOT_CONFIGURED');

  // Restore the model and retry through the public service.
  await configureModels();
  const result = await batchService.retryFailedJobs(batchId);
  assert.equal(result.retriedJobs, 1);
  job = await jobService.claimNextJob('TRANSCRIPTION');
  assert.ok(job, 'Job دوباره در صف قرار گرفت');
  await new TranscriptionWorker(gateway).processJob(job);
  const done = await jobService.getJob(job.id);
  assert.equal(done?.status, 'COMPLETED');
  assert.equal(gateway.transcriptionCalls, 1);
});

// ---------------------------------------------------------------------------
// §11–12 — Preflight
// ---------------------------------------------------------------------------

test('preflight: missing credential blocks readiness, full config is ready', async () => {
  await credentialStore.deleteKey();
  const notReady = await pipelinePreflightService.checkPreflight();
  assert.equal(notReady.ready, false);
  assert.ok(notReady.issues.some((issue) => issue.key === 'gemini_credential'));

  await credentialStore.saveKey('test-key');
  const ready = await pipelinePreflightService.checkPreflight();
  assert.equal(ready.ready, true);
  assert.equal(ready.issues.length, 0);
});

test('startBatch refuses to start when pipeline is not ready', async () => {
  const batchId = await createStartedBatch(['preflight.mp3']);
  // Batch is READY (scan done, nothing started).
  await credentialStore.deleteKey();
  try {
    await assert.rejects(
      batchService.startBatch(batchId),
      (error: unknown) => (error as { code?: string }).code === 'PIPELINE_NOT_READY',
    );
  } finally {
    await credentialStore.saveKey('test-key');
  }
});

// ---------------------------------------------------------------------------
// §36 — Cancel batch
// ---------------------------------------------------------------------------

test('cancel: pending jobs cancelled, batch stays cancelled, workers stop picking up', async () => {
  const batchId = await createStartedBatch(['cancel-a.mp3', 'cancel-b.mp3']);
  const result = await batchService.cancelBatch(batchId);
  assert.equal(result.cancelledJobs, 2);

  const db = getDatabase();
  const jobsRows = await db.select().from(jobs).where(eq(jobs.batchId, batchId));
  assert.ok(jobsRows.every((job) => job.status === 'CANCELLED'));

  const claimed = await jobService.claimNextJob('TRANSCRIPTION');
  assert.equal(claimed, null, 'Job لغوشده قابل Claim نیست');

  const batch = await db.select().from(batches).where(eq(batches.id, batchId)).get();
  assert.equal(batch?.status, 'CANCELLED');
  const refreshed = await batchService.refreshBatchState(batchId);
  assert.equal(refreshed, 'CANCELLED', 'پس از لغو، وضعیت برنمیگردد');
});

// ---------------------------------------------------------------------------
// §44 — No automatic reprocessing after model/prompt changes
// ---------------------------------------------------------------------------

test('model/prompt changes never reprocess successful data automatically', async () => {
  const gateway = new E2EGateway(
    { [TEXT_MASHHAD_A]: { analysis: ANALYSIS_MASHHAD_A } },
    { 'norepro.mp3': TEXT_MASHHAD_A },
  );
  const batchId = await createStartedBatch(['norepro.mp3']);

  // Complete transcription (one call).
  const job = await jobService.claimNextJob('TRANSCRIPTION');
  assert.ok(job);
  await new TranscriptionWorker(gateway).processJob(job);
  assert.equal(gateway.transcriptionCalls, 1);

  // Change the transcription model and prompt, then replay the same job.
  await configureModels();
  await promptsService.saveVersion('TRANSCRIPTION', { content: 'پرامپت جدید' });
  const existingTranscripts = await getDatabase().select().from(transcripts);
  assert.equal(existingTranscripts.length, 1);
  const replay = await jobService.claimNextJob('TRANSCRIPTION');
  assert.equal(replay, null, 'هیچ Job جدیدی ساخته نمیشود');
  assert.equal(gateway.transcriptionCalls, 1, 'دادهٔ موفق دوباره پردازش نمیشود');
  void batchId;
});

// ---------------------------------------------------------------------------
// §45 — Regenerate keeps history
// ---------------------------------------------------------------------------

test('regenerate creates a new generation and keeps the old one', async () => {
  const gateway = new E2EGateway(
    { [TEXT_MASHHAD_A]: { analysis: ANALYSIS_MASHHAD_A } },
    { 'reg.mp3': TEXT_MASHHAD_A },
  );
  const batchId = await createStartedBatch(['reg.mp3']);
  await processBatchFully(batchId, gateway);
  assert.equal(gateway.contentCalls, 1);

  const db = getDatabase();
  const first = await db.select().from(generatedContents);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.generationNumber, 1);

  // Explicit regenerate → generation 2, generation 1 superseded.
  await batchContentGenerationService.regenerate(batchId, first[0]?.destinationId as number);
  const job = await jobService.claimNextJob('CONTENT_GENERATION');
  assert.ok(job);
  await new ContentWorker(gateway).processJob(job);

  const rows = await db
    .select()
    .from(generatedContents)
    .orderBy(generatedContents.generationNumber);
  assert.equal(rows.length, 2, 'تاریخچه حفظ میشود');
  assert.equal(rows[0]?.status, 'SUPERSEDED');
  assert.equal(rows[1]?.status, 'GENERATED');
  assert.equal(rows[1]?.generationNumber, 2);
  assert.equal(gateway.contentCalls, 2);
});
