import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import type { DeltaDecision, GeminiUsage, KnowledgeAnalysis } from '@freebuff/contracts';
import { closeDatabase, getDatabase, initDatabase } from '../core/database/index.js';
import {
  apiUsage,
  audioFiles,
  batches,
  batchDestinationSummaries,
  destinations,
  generatedContentKnowledge,
  generatedContents,
  jobs,
  knowledgeAnalysisRuns,
  knowledgeCandidates,
  knowledgeChanges,
  knowledgeConflicts,
  knowledgeDeltaDecisions,
  knowledgeEvidence,
  knowledgeItems,
  knowledgeVersions,
  modelConfigs,
  transcripts,
} from '../core/database/schema.js';
import { batchService } from './batches.service.js';
import { jobService } from './jobs.service.js';
import { candidatesService } from './knowledge/candidates.service.js';
import { destinationService } from './knowledge/destinations.service.js';
import { buildKnowledgeIdentityKey, buildKnowledgeValueHash } from './knowledge/identity.js';
import { knowledgeReconciliationService } from './knowledge/knowledge-reconciliation.service.js';
import { batchDeltaService } from './knowledge/batch-delta.service.js';
import { batchContentGenerationService } from './content/batch-content-generation.service.js';
import { contentReadService } from './content/content-read.service.js';
import { ContentWorker } from './content/content.worker.js';
import { GeminiGatewayError, type GeminiGatewayLike } from './gemini/gateway.js';
import { promptsService } from './prompts.service.js';
import { settingsService } from './settings.service.js';

const CONTENT_MODEL = 'gemini-2.5-flash';
const ZERO_USAGE: GeminiUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0 };

/** Gateway that records every content request (for isolation assertions). */
class MockContentGateway implements GeminiGatewayLike {
  contentCalls = 0;
  userTexts: string[] = [];
  systemPrompts: string[] = [];
  failNext = false;

  /** The most recent input (or a search by destination marker). */
  lastUserText(): string | null {
    return this.userTexts[this.userTexts.length - 1] ?? null;
  }

  userTextFor(destination: string): string | null {
    return this.userTexts.find((t) => t.includes(`Destination: ${destination}`)) ?? null;
  }

  lastSystemPrompt(): string | null {
    return this.systemPrompts[this.systemPrompts.length - 1] ?? null;
  }

  async testConnection(): Promise<void> {}
  async listModels() {
    return [];
  }
  async transcribeAudio() {
    return { text: '', usage: ZERO_USAGE, durationMs: 1 };
  }
  async analyzeKnowledge(): Promise<{ analysis: KnowledgeAnalysis; usage: GeminiUsage; durationMs: number }> {
    return { analysis: { destinations: [], knowledge: [] }, usage: ZERO_USAGE, durationMs: 1 };
  }
  async analyzeNotes(): Promise<never> {
    throw new Error('not used in this test suite');
  }

  async compareNote(): Promise<never> {
    throw new Error('not used in this test suite');
  }

  async createEmbedding() {
    return { embedding: [0.1], usage: ZERO_USAGE, durationMs: 1 };
  }
  async classifyDelta() {
    return {
      classification: { decision: 'NEW' as const, matchedKnowledgeId: 0, confidence: 0.8, reasonCode: 'NEW_FACT' },
      usage: ZERO_USAGE,
      durationMs: 1,
    };
  }
  async generateContent(input: { apiKey: string; modelId: string; systemPrompt: string; userText: string }) {
    this.contentCalls += 1;
    this.userTexts.push(input.userText);
    this.systemPrompts.push(input.systemPrompt);
    if (this.failNext) {
      throw new GeminiGatewayError('GEMINI_RATE_LIMIT', 'محدودیت نرخ', { retryable: true, durationMs: 5 });
    }
    return { text: `محتوای تولیدشده ${this.contentCalls}`, usage: { inputTokens: 10, outputTokens: 20, cachedTokens: 0, totalTokens: 30 }, durationMs: 15 };
  }
}

let dir: string;
let batchId = 0;
let transcriptId = 0;

async function resolveDestination(name = 'مشهد'): Promise<number> {
  const resolved = await destinationService.resolveOrCreateDestination(
    { name, type: 'CITY', confidence: 'CONFIRMED' },
    null,
  );
  assert.ok(resolved);
  return resolved.id;
}

interface CandidateSeed {
  destinationId: number | null;
  entityName: string | null;
  attribute: string | null;
  value: string | null;
  unit?: string | null;
  canonicalText: string;
  confidence?: number;
}

async function seedMasterKnowledge(input: CandidateSeed & { value: string | null }): Promise<{
  itemId: number;
  versionId: number;
}> {
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
  const itemId = item[0]?.id;
  assert.ok(itemId);
  const version = await db
    .insert(knowledgeVersions)
    .values({
      knowledgeId: itemId,
      versionNumber: 1,
      valueText: input.value,
      unit: input.unit ?? null,
      qualifiersJson: null,
      canonicalText: input.canonicalText,
      isCurrent: true,
      createdAt: now,
    })
    .returning({ id: knowledgeVersions.id });
  const versionId = version[0]?.id;
  assert.ok(versionId);
  return { itemId, versionId };
}

/** A decided candidate + decision pair (Phase 10 style). */
async function makeDecision(input: {
  seed: CandidateSeed;
  decision: DeltaDecision;
  matchedKnowledgeId?: number | null;
  matchedVersionId?: number | null;
}): Promise<{ candidateId: number; decisionId: number }> {
  const db = getDatabase();
  const analysisRun = await db
    .insert(knowledgeAnalysisRuns)
    .values({
      transcriptId,
      modelId: 'test-model',
      promptVersionId: 1,
      inputSignature: `sig-${Math.random()}`,
      status: 'COMPLETED',
      createdAt: new Date(),
    })
    .returning({ id: knowledgeAnalysisRuns.id });
  const runId = analysisRun[0]?.id;
  assert.ok(runId);

  const identityKey = buildKnowledgeIdentityKey({
    destinationId: input.seed.destinationId,
    knowledgeType: 'FACT',
    entityName: input.seed.entityName,
    attribute: input.seed.attribute,
    scope: null,
  });
  const valueHash = buildKnowledgeValueHash({
    valueText: input.seed.value,
    unit: input.seed.unit ?? null,
    qualifiers: [],
  });
  const candidateId = await candidatesService.createCandidate({
    analysisRunId: runId,
    batchId,
    transcriptId,
    destinationId: input.seed.destinationId,
    knowledgeType: 'FACT',
    category: null,
    entityType: null,
    entityName: input.seed.entityName,
    attribute: input.seed.attribute,
    valueText: input.seed.value,
    valueJson: null,
    unit: input.seed.unit ?? null,
    qualifiers: [],
    canonicalText: input.seed.canonicalText,
    identityKey,
    valueHash,
    confidence: input.seed.confidence ?? 0.9,
    sourceSegmentId: null,
    sourceText: input.seed.canonicalText,
  });
  const claimed = await candidatesService.claimCandidate(candidateId);
  assert.ok(claimed);

  const decision = await db
    .insert(knowledgeDeltaDecisions)
    .values({
      candidateId,
      destinationId: input.seed.destinationId,
      decision: input.decision,
      matchedKnowledgeId: input.matchedKnowledgeId ?? null,
      matchedVersionId: input.matchedVersionId ?? null,
      matchedCandidateId: null,
      reasonCode: null,
      confidence: 0.9,
      reasoningSummary: null,
      inputSignature: `sig-${candidateId}`,
      createdAt: new Date(),
    })
    .returning({ id: knowledgeDeltaDecisions.id });
  const decisionId = decision[0]?.id;
  assert.ok(decisionId);
  return { candidateId, decisionId };
}

async function runReconcile(decisionId: number): Promise<void> {
  const db = getDatabase();
  const decision = await db
    .select()
    .from(knowledgeDeltaDecisions)
    .where(eq(knowledgeDeltaDecisions.id, decisionId))
    .get();
  assert.ok(decision);
  const candidate = await db
    .select()
    .from(knowledgeCandidates)
    .where(eq(knowledgeCandidates.id, decision.candidateId))
    .get();
  assert.ok(candidate);
  await knowledgeReconciliationService.reconcileDecision(decision, candidate);
}

/** Reconcile every decision of the batch (Phase 10). */
async function reconcileAll(): Promise<void> {
  const decisions = await getDatabase().select().from(knowledgeDeltaDecisions);
  for (const d of decisions) await runReconcile(d.id);
}

/** Seed one COMPLETED job per pipeline type (real flow always has jobs). */
async function seedCompletedJobs(): Promise<void> {
  const db = getDatabase();
  const types = ['TRANSCRIPTION', 'KNOWLEDGE_ANALYSIS', 'KNOWLEDGE_DELTA', 'KNOWLEDGE_RECONCILIATION'] as const;
  const now = new Date();
  for (const jobType of types) {
    await db
      .insert(jobs)
      .values({
        batchId,
        jobType,
        entityId: 1,
        status: 'COMPLETED',
        attempt: 1,
        maxAttempts: 3,
        idempotencyKey: `${jobType}:test:${batchId}:${Math.random()}`,
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      })
      .onConflictDoNothing({ target: jobs.idempotencyKey });
  }
}

/** Queue content jobs for the batch and run them all with the gateway. */
async function runContentJobs(gateway: MockContentGateway, modelConfigured = true): Promise<void> {
  if (modelConfigured) {
    await batchContentGenerationService.ensureContentJobs(batchId);
  }
  await getDatabase()
    .update(batches)
    .set({ status: 'GENERATING_CONTENT', updatedAt: new Date() })
    .where(eq(batches.id, batchId));
  const worker = new ContentWorker(gateway);
  for (;;) {
    const job = await jobService.claimNextJob('CONTENT_GENERATION');
    if (!job) break;
    await worker.processJob(job);
  }
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'freebuff-phase11-test-'));
  mkdirSync(join(dir, 'audio'), { recursive: true });
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.GEMINI_CREDENTIALS_FILE = join(dir, 'gemini.key');
  await initDatabase();
  await promptsService.ensureDefaultTemplates();
  await settingsService.updateSettings({ workspacePath: dir, processingConcurrency: 2 });
  await promptsService.saveVersion('TRANSCRIPTION', { content: 'پرامپت تست' });
  await promptsService.saveVersion('KNOWLEDGE_PROCESSING', { content: 'پرامپت تست' });
  await promptsService.saveVersion('CONTENT_GENERATION', { content: 'محتوای فارسی روان درباره مقصد بنویس.' });
  const now = new Date();
  await getDatabase()
    .insert(modelConfigs)
    .values({
      stage: 'CONTENT_GENERATION',
      provider: 'GEMINI',
      modelId: CONTENT_MODEL,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: modelConfigs.stage,
      set: { modelId: CONTENT_MODEL, provider: 'GEMINI', updatedAt: now },
    });
  // The gateway reads the credential via credentialStore.
  const { credentialStore } = await import('./gemini/credentials.store.js');
  await credentialStore.saveKey('test-key');
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
  const { deltaMetrics } = await import('../core/database/schema.js');
  await db.delete(deltaMetrics);
  await db.delete(generatedContentKnowledge);
  await db.delete(generatedContents);
  await db.delete(batchDestinationSummaries);
  await db.delete(knowledgeConflicts);
  await db.delete(knowledgeChanges);
  await db.delete(knowledgeDeltaDecisions);
  await db.delete(knowledgeCandidates);
  await db.delete(knowledgeEvidence);
  await db.delete(knowledgeVersions);
  await db.delete(knowledgeItems);
  await db.delete(knowledgeAnalysisRuns);
  await db.delete(destinations);
  await db.delete(transcripts);
  await db.delete(audioFiles);
  await db.delete(jobs);
  await db.delete(batches);
  await db.delete(apiUsage);
  // Restore the content model (a permanent-failure test removes it).
  const nowConfig = new Date();
  await db
    .insert(modelConfigs)
    .values({
      stage: 'CONTENT_GENERATION',
      provider: 'GEMINI',
      modelId: CONTENT_MODEL,
      createdAt: nowConfig,
      updatedAt: nowConfig,
    })
    .onConflictDoUpdate({
      target: modelConfigs.stage,
      set: { modelId: CONTENT_MODEL, provider: 'GEMINI', updatedAt: nowConfig },
    });

  const batch = await batchService.createBatch();
  batchId = batch.id;
  const audio = await db
    .insert(audioFiles)
    .values({
      batchId,
      originalName: 'test.mp3',
      absolutePath: join(dir, 'audio', 'test.mp3'),
      extension: '.mp3',
      mimeType: 'audio/mpeg',
      fileSize: 100,
      sha256: 'abc',
      status: 'TRANSCRIBED',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: audioFiles.id });
  const audioId = audio[0]?.id;
  assert.ok(audioId);
  const transcript = await db
    .insert(transcripts)
    .values({
      audioId,
      fullText: 'متن کامل مکالمهٔ مخفی که هرگز نباید به Content Generator برسد.',
      normalizedText: 'متن',
      normalizedHash: 'h',
      modelId: 'test-model',
      promptVersionId: 1,
      status: 'COMPLETED',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: transcripts.id });
  const newTranscriptId = transcript[0]?.id;
  assert.ok(newTranscriptId);
  transcriptId = newTranscriptId;
  writeFileSync(join(dir, 'audio', 'test.mp3'), new Uint8Array([1, 2, 3, 4]));
});

// ---------------------------------------------------------------------------
// No delta (§53)
// ---------------------------------------------------------------------------

test('destination with zero NEW/UPDATE creates no content job and no Gemini call', async () => {
  const destId = await resolveDestination('کیش');
  const { itemId, versionId } = await seedMasterKnowledge({
    destinationId: destId,
    entityName: 'هتل دریا',
    attribute: 'صبحانه',
    value: 'بوفه',
    canonicalText: 'صبحانه هتل دریا بوفه است.',
  });
  await makeDecision({
    seed: {
      destinationId: destId,
      entityName: 'هتل دریا',
      attribute: 'صبحانه',
      value: 'بوفه',
      canonicalText: 'صبحانه هتل دریا بوفه است.',
    },
    decision: 'CONFIRMATION',
    matchedKnowledgeId: itemId,
    matchedVersionId: versionId,
  });
  await makeDecision({
    seed: {
      destinationId: destId,
      entityName: 'هتل دریا',
      attribute: 'چت',
      value: null,
      canonicalText: 'درود.',
    },
    decision: 'IGNORE',
  });
  await reconcileAll();
  await batchDeltaService.rebuildBatchDestinationSummary(batchId);

  const gateway = new MockContentGateway();
  const created = await batchContentGenerationService.ensureContentJobs(batchId);
  assert.equal(created, 0, 'no content job for a no-delta destination');
  const contentJobs = await getDatabase()
    .select()
    .from(jobs)
    .where(eq(jobs.jobType, 'CONTENT_GENERATION'));
  assert.equal(contentJobs.length, 0);
  await runContentJobs(gateway);
  assert.equal(gateway.contentCalls, 0, 'no Gemini call');
  assert.equal((await getDatabase().select().from(generatedContents)).length, 0);

  // The batch can still complete without any content call.
  await seedCompletedJobs();
  await getDatabase()
    .update(batches)
    .set({ status: 'KNOWLEDGE_READY', updatedAt: new Date() })
    .where(eq(batches.id, batchId));
  const { batchFinalizationService } = await import('./knowledge/batch-finalization.service.js');
  const finalized = await batchFinalizationService.finalizeIfComplete(batchId);
  assert.equal(finalized, true);
  const batchRow = await getDatabase().select().from(batches).where(eq(batches.id, batchId)).get();
  assert.equal(batchRow?.status, 'COMPLETED');
});

// ---------------------------------------------------------------------------
// Input isolation (§54)
// ---------------------------------------------------------------------------

test('Mashhad content receives only the Mashhad publishable delta', async () => {
  const mashhad = await resolveDestination('مشهد');
  const kish = await resolveDestination('کیش');
  const { itemId: breakfastId, versionId: breakfastVersion } = await seedMasterKnowledge({
    destinationId: mashhad,
    entityName: 'هتل X',
    attribute: 'صبحانه',
    value: 'بوفه',
    canonicalText: 'صبحانه هتل X بوفه است.',
  });

  // Mashhad publishable: transfer NEW, family rooms NEW, distance UPDATE.
  await makeDecision({
    seed: {
      destinationId: mashhad,
      entityName: 'هتل X',
      attribute: 'ترانسفر فرودگاهی',
      value: 'رایگان',
      canonicalText: 'ترانسفر فرودگاهی هتل X رایگان است.',
    },
    decision: 'NEW',
  });
  await makeDecision({
    seed: {
      destinationId: mashhad,
      entityName: 'هتل X',
      attribute: 'اتاق خانوادگی',
      value: 'دارد',
      canonicalText: 'هتل X اتاق خانوادگی دارد.',
    },
    decision: 'NEW',
  });
  const { itemId: distanceId, versionId: distanceVersion } = await seedMasterKnowledge({
    destinationId: mashhad,
    entityName: 'هتل Y',
    attribute: 'فاصله تا حرم',
    value: '۱۰ دقیقه',
    canonicalText: 'فاصله هتل Y تا حرم ده دقیقه است.',
  });
  await makeDecision({
    seed: {
      destinationId: mashhad,
      entityName: 'هتل Y',
      attribute: 'فاصله تا حرم',
      value: '۵ دقیقه',
      canonicalText: 'فاصله هتل Y تا حرم پنج دقیقه است.',
    },
    decision: 'UPDATE',
    matchedKnowledgeId: distanceId,
    matchedVersionId: distanceVersion,
  });

  // Confirmation + ignore (must NOT appear in content input).
  await makeDecision({
    seed: {
      destinationId: mashhad,
      entityName: 'هتل X',
      attribute: 'صبحانه',
      value: 'بوفه',
      canonicalText: 'صبحانه هتل X بوفه است.',
    },
    decision: 'CONFIRMATION',
    matchedKnowledgeId: breakfastId,
    matchedVersionId: breakfastVersion,
  });
  await makeDecision({
    seed: {
      destinationId: mashhad,
      entityName: 'هتل Z',
      attribute: 'شایعه',
      value: null,
      canonicalText: 'شایعهٔ بی‌مورد.',
    },
    decision: 'IGNORE',
  });

  // Kish knowledge — must never leak into Mashhad input.
  await makeDecision({
    seed: {
      destinationId: kish,
      entityName: 'هتل دریا',
      attribute: 'ساحل خصوصی',
      value: 'دارد',
      canonicalText: 'هتل دریا ساحل خصوصی دارد.',
    },
    decision: 'NEW',
  });

  await reconcileAll();
  await batchDeltaService.rebuildBatchDestinationSummary(batchId);

  const gateway = new MockContentGateway();
  await runContentJobs(gateway);

  // Both Mashhad and Kish have deltas → two content jobs, two calls.
  assert.equal(gateway.contentCalls, 2);
  const mashhadInput = gateway.userTextFor('مشهد') ?? '';
  const kishInput = gateway.userTextFor('کیش') ?? '';
  assert.ok(mashhadInput.includes('Destination: مشهد'));
  assert.ok(mashhadInput.includes('ترانسفر فرودگاهی هتل X رایگان است'), 'NEW included');
  assert.ok(mashhadInput.includes('هتل X اتاق خانوادگی دارد'), 'NEW included');
  assert.ok(mashhadInput.includes('Previous value: ۱۰ دقیقه'), 'UPDATE previous value is context');
  assert.ok(mashhadInput.includes('Current value: ۵ دقیقه'), 'UPDATE current value present');
  assert.ok(!mashhadInput.includes('صبحانه'), 'CONFIRMATION excluded');
  assert.ok(!mashhadInput.includes('شایعه'), 'IGNORE excluded');
  assert.ok(!mashhadInput.includes('هتل دریا'), 'Kish knowledge never leaks into Mashhad input');
  assert.ok(!mashhadInput.includes('متن کامل مکالمه'), 'raw transcript excluded');
  assert.ok(!mashhadInput.includes('Batch'), 'no internal batch metadata');
  assert.ok(kishInput.includes('هتل دریا'), 'Kish gets its own input');
  assert.ok(gateway.lastSystemPrompt()?.includes('Internal content contract'), 'hallucination guard attached');
});

// ---------------------------------------------------------------------------
// Idempotency (§55)
// ---------------------------------------------------------------------------

test('same delta signature does not call Gemini twice; retry is safe; regenerate creates new generation', async () => {
  const destId = await resolveDestination('مشهد');
  await makeDecision({
    seed: {
      destinationId: destId,
      entityName: 'هتل X',
      attribute: 'ترانسفر',
      value: 'رایگان',
      canonicalText: 'ترانسفر رایگان است.',
    },
    decision: 'NEW',
  });
  await reconcileAll();
  await batchDeltaService.rebuildBatchDestinationSummary(batchId);

  const gateway = new MockContentGateway();
  await runContentJobs(gateway);
  assert.equal(gateway.contentCalls, 1);

  // Replay: same signature → reuse, no second call.
  await runContentJobs(gateway);
  assert.equal(gateway.contentCalls, 1, 'no second Gemini call for the same delta');

  const rows = await getDatabase().select().from(generatedContents);
  assert.equal(rows.length, 1, 'no duplicate content');

  // Explicit regenerate → new generation, new call, history preserved.
  const regenerated = await batchContentGenerationService.regenerate(batchId, destId);
  assert.equal(regenerated.generationNumber, 2);
  await runContentJobs(gateway);
  assert.equal(gateway.contentCalls, 2);

  const all = await getDatabase()
    .select()
    .from(generatedContents)
    .orderBy(generatedContents.generationNumber);
  assert.equal(all.length, 2, 'previous generation preserved');
  assert.equal(all[0]?.generationNumber, 1);
  assert.equal(all[1]?.generationNumber, 2);
  const oldGen = await getDatabase()
    .select()
    .from(generatedContents)
    .where(and(eq(generatedContents.batchId, batchId), eq(generatedContents.generationNumber, 1)))
    .get();
  assert.equal(oldGen?.status, 'SUPERSEDED', 'older generation marked superseded');

  const metrics = await getDatabase().select().from((await import('../core/database/schema.js')).deltaMetrics);
  assert.ok(metrics.some((m) => m.metricKey === 'content_generation_call_count' && m.value === 2));
  // Reuse happened on the replay AND again when the regenerate sweep re-ran.
  assert.ok(metrics.some((m) => m.metricKey === 'content_generation_reuse_count' && m.value === 2));
});

// ---------------------------------------------------------------------------
// Traceability (§56)
// ---------------------------------------------------------------------------

test('generated content links to exact knowledge versions, batch, prompt and model', async () => {
  const destId = await resolveDestination('مشهد');
  const { itemId: distanceId, versionId: distanceVersion } = await seedMasterKnowledge({
    destinationId: destId,
    entityName: 'هتل Y',
    attribute: 'فاصله تا حرم',
    value: '۱۰ دقیقه',
    canonicalText: 'فاصله هتل Y تا حرم ده دقیقه است.',
  });
  await makeDecision({
    seed: {
      destinationId: destId,
      entityName: 'هتل Y',
      attribute: 'فاصله تا حرم',
      value: '۵ دقیقه',
      canonicalText: 'فاصله هتل Y تا حرم پنج دقیقه است.',
    },
    decision: 'UPDATE',
    matchedKnowledgeId: distanceId,
    matchedVersionId: distanceVersion,
  });
  await makeDecision({
    seed: {
      destinationId: destId,
      entityName: 'هتل X',
      attribute: 'ترانسفر',
      value: 'رایگان',
      canonicalText: 'ترانسفر رایگان است.',
    },
    decision: 'NEW',
  });
  await reconcileAll();

  const gateway = new MockContentGateway();
  await runContentJobs(gateway);

  const contentRows = await getDatabase().select().from(generatedContents);
  assert.equal(contentRows.length, 1);
  const contentRow = contentRows[0] as typeof generatedContents.$inferSelect;
  assert.equal(contentRow.batchId, batchId);
  assert.equal(contentRow.destinationId, destId);
  assert.equal(contentRow.modelId, CONTENT_MODEL);
  assert.ok(contentRow.promptVersionId > 0);
  assert.ok(contentRow.deltaSignature.length === 64, 'stable backend hash');

  const links = await getDatabase()
    .select()
    .from(generatedContentKnowledge)
    .where(eq(generatedContentKnowledge.generatedContentId, contentRow.id));
  assert.equal(links.length, 2, 'links to both knowledge changes');

  // Exactly the two changes of the delta (UPDATE distance + NEW transfer).
  const changeIds = new Set(links.map((l) => l.changeId));
  const changes = await getDatabase()
    .select()
    .from(knowledgeChanges)
    .where(eq(knowledgeChanges.batchId, batchId));
  assert.equal(changes.length, 2);
  for (const change of changes) assert.ok(changeIds.has(change.id));
  for (const link of links) {
    assert.ok(link.knowledgeVersionId > 0);
    assert.ok(link.knowledgeId > 0);
  }

  // Detail endpoint data.
  const detail = await contentReadService.getGeneratedContentDetail(contentRow.id);
  assert.ok(detail);
  assert.equal(detail.knowledge.length, 2);
  assert.equal(detail.destinationName, 'مشهد');
  assert.ok(detail.knowledge.some((k) => k.changeType === 'UPDATE' && k.oldValue === '۱۰ دقیقه' && k.currentValue === '۵ دقیقه'));
  assert.ok(detail.knowledge.some((k) => k.changeType === 'NEW' && k.currentValue === 'رایگان'));

  const history = await contentReadService.getDestinationContentHistory(destId);
  assert.equal(history.batches.length, 1);
  assert.equal(history.batches[0]?.batchId, batchId);

  const batchContents = await contentReadService.getBatchGeneratedContents(batchId);
  assert.equal(batchContents.destinations.length, 1);
  assert.equal(batchContents.destinations[0]?.generations.length, 1);
});

// ---------------------------------------------------------------------------
// Usage (§57)
// ---------------------------------------------------------------------------

test('successful content call creates a CONTENT usage record with real values', async () => {
  const destId = await resolveDestination('مشهد');
  await makeDecision({
    seed: {
      destinationId: destId,
      entityName: 'هتل X',
      attribute: 'ترانسفر',
      value: 'رایگان',
      canonicalText: 'ترانسفر رایگان است.',
    },
    decision: 'NEW',
  });
  await reconcileAll();

  const gateway = new MockContentGateway();
  await runContentJobs(gateway);

  const usage = await getDatabase()
    .select()
    .from(apiUsage)
    .where(eq(apiUsage.stage, 'CONTENT'));
  assert.equal(usage.length, 1);
  assert.equal(usage[0]?.status, 'SUCCESS');
  assert.equal(usage[0]?.inputTokens, 10);
  assert.equal(usage[0]?.outputTokens, 20);
  assert.equal(usage[0]?.totalTokens, 30);
  assert.equal(usage[0]?.destinationId, destId);
  assert.equal(usage[0]?.batchId, batchId);
  assert.ok(usage[0]?.jobId);

  const summary = await contentReadService.getBatchUsage(batchId);
  assert.equal(summary.CONTENT?.calls, 1);
  assert.equal(summary.CONTENT?.inputTokens, 10);
  assert.equal(summary.CONTENT?.totalTokens, 30);
});

// ---------------------------------------------------------------------------
// Batch completion (§58)
// ---------------------------------------------------------------------------

test('all successful content jobs complete the batch as COMPLETED', async () => {
  const destId = await resolveDestination('مشهد');
  await makeDecision({
    seed: {
      destinationId: destId,
      entityName: 'هتل X',
      attribute: 'ترانسفر',
      value: 'رایگان',
      canonicalText: 'ترانسفر رایگان است.',
    },
    decision: 'NEW',
  });
  await reconcileAll();
  await batchDeltaService.rebuildBatchDestinationSummary(batchId);

  const gateway = new MockContentGateway();
  await runContentJobs(gateway);
  assert.equal(gateway.contentCalls, 1);

  const batchRow = await getDatabase().select().from(batches).where(eq(batches.id, batchId)).get();
  assert.equal(batchRow?.status, 'COMPLETED', 'batch completes after content generation');
});

test('one permanent content failure marks the batch PARTIAL_FAILED', async () => {
  const destId = await resolveDestination('مشهد');
  await makeDecision({
    seed: {
      destinationId: destId,
      entityName: 'هتل X',
      attribute: 'ترانسفر',
      value: 'رایگان',
      canonicalText: 'ترانسفر رایگان است.',
    },
    decision: 'NEW',
  });
  await reconcileAll();
  await batchDeltaService.rebuildBatchDestinationSummary(batchId);

  // Queue the job first, then remove the model → permanent failure on run.
  const createdJobs = await batchContentGenerationService.ensureContentJobs(batchId);
  assert.equal(createdJobs, 1);
  await seedCompletedJobs();
  await getDatabase().delete(modelConfigs).where(eq(modelConfigs.stage, 'CONTENT_GENERATION'));
  const gateway = new MockContentGateway();
  await runContentJobs(gateway, false);
  assert.equal(gateway.contentCalls, 0, 'no Gemini call without a model');

  const contentJobRows = await getDatabase()
    .select()
    .from(jobs)
    .where(eq(jobs.jobType, 'CONTENT_GENERATION'));
  assert.equal(contentJobRows.length, 1);
  assert.equal(contentJobRows[0]?.status, 'FAILED');
  assert.equal(contentJobRows[0]?.errorCode, 'CONTENT_MODEL_NOT_CONFIGURED');

  // With reconciliation already done, the batch is partial (not failed).
  const batchRow = await getDatabase().select().from(batches).where(eq(batches.id, batchId)).get();
  assert.equal(batchRow?.status, 'PARTIAL_FAILED');
});

test('restart does not regenerate successful content (reuse path)', async () => {
  const destId = await resolveDestination('مشهد');
  await makeDecision({
    seed: {
      destinationId: destId,
      entityName: 'هتل X',
      attribute: 'ترانسفر',
      value: 'رایگان',
      canonicalText: 'ترانسفر رایگان است.',
    },
    decision: 'NEW',
  });
  await reconcileAll();
  await batchDeltaService.rebuildBatchDestinationSummary(batchId);

  const gateway = new MockContentGateway();
  await runContentJobs(gateway);
  assert.equal(gateway.contentCalls, 1);

  // Simulate a restart: the job is requeued and the batch re-opened.
  const contentJobs = await getDatabase()
    .select()
    .from(jobs)
    .where(eq(jobs.jobType, 'CONTENT_GENERATION'));
  assert.equal(contentJobs.length, 1);
  await getDatabase()
    .update(jobs)
    .set({ status: 'PENDING', updatedAt: new Date() })
    .where(eq(jobs.id, contentJobs[0]?.id as number));
  await getDatabase()
    .update(batches)
    .set({ status: 'GENERATING_CONTENT', updatedAt: new Date() })
    .where(eq(batches.id, batchId));

  const worker = new ContentWorker(gateway);
  const claimed = await jobService.claimNextJob('CONTENT_GENERATION');
  assert.ok(claimed);
  await worker.processJob(claimed);

  assert.equal(gateway.contentCalls, 1, 'no regeneration after restart');
  assert.equal((await getDatabase().select().from(generatedContents)).length, 1);
});

// ---------------------------------------------------------------------------
// Manual scenario (§59)
// ---------------------------------------------------------------------------

test('manual scenario: Mashhad gets content, Kish (confirmation only) gets none', async () => {
  const mashhad = await resolveDestination('مشهد');
  const kish = await resolveDestination('کیش');

  // Mashhad publishable delta.
  await makeDecision({
    seed: {
      destinationId: mashhad,
      entityName: 'هتل X',
      attribute: 'ترانسفر فرودگاهی',
      value: 'رایگان',
      canonicalText: 'ترانسفر فرودگاهی هتل X رایگان است.',
    },
    decision: 'NEW',
  });
  await makeDecision({
    seed: {
      destinationId: mashhad,
      entityName: 'هتل X',
      attribute: 'اتاق خانوادگی',
      value: 'دارد',
      canonicalText: 'هتل X اتاق خانوادگی دارد.',
    },
    decision: 'NEW',
  });
  const { itemId: distanceItem, versionId: distanceVersion } = await seedMasterKnowledge({
    destinationId: mashhad,
    entityName: 'هتل Y',
    attribute: 'فاصله تا حرم',
    value: '۱۰ دقیقه',
    canonicalText: 'فاصله هتل Y تا حرم ده دقیقه است.',
  });
  await makeDecision({
    seed: {
      destinationId: mashhad,
      entityName: 'هتل Y',
      attribute: 'فاصله تا حرم',
      value: '۵ دقیقه',
      canonicalText: 'فاصله هتل Y تا حرم پنج دقیقه است.',
    },
    decision: 'UPDATE',
    matchedKnowledgeId: distanceItem,
    matchedVersionId: distanceVersion,
  });

  // Kish: confirmation only → no publishable delta.
  const { itemId: kishItem, versionId: kishVersion } = await seedMasterKnowledge({
    destinationId: kish,
    entityName: 'هتل دریا',
    attribute: 'صبحانه',
    value: 'بوفه',
    canonicalText: 'صبحانه هتل دریا بوفه است.',
  });
  await makeDecision({
    seed: {
      destinationId: kish,
      entityName: 'هتل دریا',
      attribute: 'صبحانه',
      value: 'بوفه',
      canonicalText: 'صبحانه هتل دریا بوفه است.',
    },
    decision: 'CONFIRMATION',
    matchedKnowledgeId: kishItem,
    matchedVersionId: kishVersion,
  });

  await reconcileAll();
  await batchDeltaService.rebuildBatchDestinationSummary(batchId);

  const gateway = new MockContentGateway();
  const created = await batchContentGenerationService.ensureContentJobs(batchId);
  assert.equal(created, 1, 'only Mashhad gets a content job');
  const contentJobs = await getDatabase()
    .select()
    .from(jobs)
    .where(eq(jobs.jobType, 'CONTENT_GENERATION'));
  assert.equal(contentJobs.length, 1);
  assert.equal(contentJobs[0]?.entityId, mashhad, 'job is for Mashhad only');

  await runContentJobs(gateway);
  assert.equal(gateway.contentCalls, 1, 'Kish gets no content Gemini call');

  const mashhadInput = gateway.userTextFor('مشهد') ?? '';
  assert.ok(mashhadInput.includes('ترانسفر فرودگاهی هتل X رایگان است'));
  assert.ok(mashhadInput.includes('هتل X اتاق خانوادگی دارد'));
  assert.ok(mashhadInput.includes('Current value: ۵ دقیقه'));
  assert.ok(!mashhadInput.includes('صبحانه'), 'Kish confirmation never enters Mashhad content');

  // Batch contents response: Mashhad has a generation; Kish flagged no-delta.
  const batchContents = await contentReadService.getBatchGeneratedContents(batchId);
  const mashhadDest = batchContents.destinations.find((d) => d.destinationId === mashhad);
  const kishDest = batchContents.destinations.find((d) => d.destinationId === kish);
  assert.equal(mashhadDest?.generations.length, 1);
  assert.equal(mashhadDest?.generations[0]?.knowledgeCount, 3, 'three knowledge items used');
  assert.equal(kishDest?.noPublishableDelta, true, 'UI shows no new publishable knowledge');
  assert.equal(kishDest?.generations.length, 0);
});
