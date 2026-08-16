import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import type { DeltaDecision } from '@freebuff/contracts';
import { closeDatabase, getDatabase, initDatabase } from '../core/database/index.js';
import {
  audioFiles,
  batches,
  batchDestinationSummaries,
  destinations,
  jobs,
  knowledgeAnalysisRuns,
  knowledgeCandidates,
  knowledgeChanges,
  knowledgeConflicts,
  knowledgeDeltaDecisions,
  knowledgeEvidence,
  knowledgeItems,
  knowledgeVersions,
  transcripts,
} from '../core/database/schema.js';
import { batchService } from './batches.service.js';
import { jobService } from './jobs.service.js';
import { candidatesService } from './knowledge/candidates.service.js';
import { destinationService } from './knowledge/destinations.service.js';
import { buildKnowledgeIdentityKey, buildKnowledgeValueHash } from './knowledge/identity.js';
import { knowledgeReconciliationService } from './knowledge/knowledge-reconciliation.service.js';
import { batchDeltaService } from './knowledge/batch-delta.service.js';
import { ReconciliationWorker } from './knowledge/reconciliation.worker.js';
import { promptsService } from './prompts.service.js';
import { settingsService } from './settings.service.js';

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

/** Seed existing master knowledge (Phase 8 baseline). Returns {itemId, versionId}. */
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
      firstSeenBatchId: null,
      firstSeenAt: now,
      lastSeenBatchId: null,
      lastSeenAt: now,
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

let dir: string;
let batchId = 0;
let transcriptId = 0;

/** A decided candidate + decision pair, ready for reconciliation. */
async function makeDecision(input: {
  seed: CandidateSeed;
  decision: DeltaDecision;
  matchedKnowledgeId?: number | null;
  matchedVersionId?: number | null;
  reasonCode?: string;
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
  // The delta worker claims (PENDING → DECIDED) before persisting a
  // decision — mirror that flow so the candidate ends in DECIDED.
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
      reasonCode: input.reasonCode ?? null,
      confidence: 0.9,
      reasoningSummary: null,
      inputSignature: `test-sig-${candidateId}`,
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

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'freebuff-phase10-test-'));
  mkdirSync(join(dir, 'audio'), { recursive: true });
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.GEMINI_CREDENTIALS_FILE = join(dir, 'gemini.key');
  await initDatabase();
  await promptsService.ensureDefaultTemplates();
  await settingsService.updateSettings({ workspacePath: dir, processingConcurrency: 2 });
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
      fullText: 'متن تست',
      normalizedText: 'متن تست',
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
// NEW (§51)
// ---------------------------------------------------------------------------

test('NEW creates one canonical knowledge with V1, evidence, change and batch delta', async () => {
  const destId = await resolveDestination();
  const { decisionId } = await makeDecision({
    seed: {
      destinationId: destId,
      entityName: 'هتل X',
      attribute: 'ترانسفر فرودگاهی',
      value: 'رایگان',
      canonicalText: 'این پکیج ترانسفر فرودگاهی رایگان دارد.',
    },
    decision: 'NEW',
    reasonCode: 'NEW_FACT',
  });

  await runReconcile(decisionId);

  const items = await getDatabase().select().from(knowledgeItems);
  assert.equal(items.length, 1, 'exactly one canonical knowledge');
  const item = items[0] as typeof knowledgeItems.$inferSelect;
  assert.equal(item.entityName, 'هتل X');
  assert.equal(item.status, 'ACTIVE');
  assert.equal(item.firstSeenBatchId, batchId);

  const versions = await getDatabase()
    .select()
    .from(knowledgeVersions)
    .where(eq(knowledgeVersions.knowledgeId, item.id));
  assert.equal(versions.length, 1, 'V1 exists');
  assert.equal(versions[0]?.versionNumber, 1);
  assert.equal(versions[0]?.isCurrent, true, 'V1 is current');
  assert.equal(versions[0]?.valueText, 'رایگان');

  const evidence = await getDatabase()
    .select()
    .from(knowledgeEvidence)
    .where(eq(knowledgeEvidence.knowledgeId, item.id));
  assert.equal(evidence.length, 1, 'evidence created');
  assert.equal(evidence[0]?.transcriptId, transcriptId);

  const changes = await getDatabase()
    .select()
    .from(knowledgeChanges)
    .where(eq(knowledgeChanges.knowledgeId, item.id));
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.changeType, 'NEW');
  assert.equal(changes[0]?.newVersionId, versions[0]?.id);
  assert.equal(changes[0]?.oldVersionId, null);

  const delta = await batchDeltaService.getDestinationDelta(batchId, destId);
  assert.equal(delta.length, 1, 'NEW appears in batch delta');
  assert.equal(delta[0]?.changeType, 'NEW');
  assert.equal(delta[0]?.knowledgeId, item.id);

  const decision = await getDatabase()
    .select()
    .from(knowledgeDeltaDecisions)
    .where(eq(knowledgeDeltaDecisions.id, decisionId))
    .get();
  assert.ok(decision?.reconciledAt, 'candidate finalized');
});

test('NEW replay never duplicates anything', async () => {
  const destId = await resolveDestination();
  const { decisionId } = await makeDecision({
    seed: {
      destinationId: destId,
      entityName: 'هتل X',
      attribute: 'ترانسفر فرودگاهی',
      value: 'رایگان',
      canonicalText: 'این پکیج ترانسفر فرودگاهی رایگان دارد.',
    },
    decision: 'NEW',
  });

  await runReconcile(decisionId);
  await runReconcile(decisionId);
  await runReconcile(decisionId);

  assert.equal((await getDatabase().select().from(knowledgeItems)).length, 1);
  assert.equal((await getDatabase().select().from(knowledgeVersions)).length, 1);
  assert.equal((await getDatabase().select().from(knowledgeEvidence)).length, 1);
  assert.equal((await getDatabase().select().from(knowledgeChanges)).length, 1);
});

// ---------------------------------------------------------------------------
// CONFIRMATION (§52)
// ---------------------------------------------------------------------------

test('CONFIRMATION adds evidence only — no new item, no new version, not publishable', async () => {
  const destId = await resolveDestination();
  const { itemId, versionId } = await seedMasterKnowledge({
    destinationId: destId,
    entityName: 'هتل X',
    attribute: 'صبحانه',
    value: 'بوفه',
    canonicalText: 'صبحانه هتل X بوفه است.',
  });
  const { decisionId } = await makeDecision({
    seed: {
      destinationId: destId,
      entityName: 'هتل X',
      attribute: 'صبحانه',
      value: 'بوفه',
      canonicalText: 'صبحانه هتل X بوفه است.',
    },
    decision: 'CONFIRMATION',
    matchedKnowledgeId: itemId,
    matchedVersionId: versionId,
    reasonCode: 'IDENTITY_VALUE_MATCH',
  });

  await runReconcile(decisionId);

  assert.equal((await getDatabase().select().from(knowledgeItems)).length, 1, 'no new knowledge');
  assert.equal((await getDatabase().select().from(knowledgeVersions)).length, 1, 'no new version');
  const evidence = await getDatabase()
    .select()
    .from(knowledgeEvidence)
    .where(eq(knowledgeEvidence.knowledgeId, itemId));
  assert.equal(evidence.length, 1, 'evidence attached to current version');
  assert.equal(evidence[0]?.knowledgeVersionId, versionId);

  const item = await getDatabase()
    .select()
    .from(knowledgeItems)
    .where(eq(knowledgeItems.id, itemId))
    .get();
  assert.equal(item?.lastSeenBatchId, batchId, 'last_seen updated');

  const delta = await batchDeltaService.getDestinationDelta(batchId, destId);
  assert.equal(delta.length, 0, 'CONFIRMATION is not publishable');
  assert.equal((await getDatabase().select().from(knowledgeChanges)).length, 0);
});

test('same evidence replay is ignored (evidence dedup)', async () => {
  const destId = await resolveDestination();
  const { itemId, versionId } = await seedMasterKnowledge({
    destinationId: destId,
    entityName: 'هتل X',
    attribute: 'صبحانه',
    value: 'بوفه',
    canonicalText: 'صبحانه هتل X بوفه است.',
  });
  const { decisionId } = await makeDecision({
    seed: {
      destinationId: destId,
      entityName: 'هتل X',
      attribute: 'صبحانه',
      value: 'بوفه',
      canonicalText: 'صبحانه هتل X بوفه است.',
    },
    decision: 'CONFIRMATION',
    matchedKnowledgeId: itemId,
    matchedVersionId: versionId,
  });

  await runReconcile(decisionId);
  await runReconcile(decisionId);

  const evidence = await getDatabase()
    .select()
    .from(knowledgeEvidence)
    .where(and(eq(knowledgeEvidence.knowledgeId, itemId), eq(knowledgeEvidence.knowledgeVersionId, versionId)));
  assert.equal(evidence.length, 1, 'one source evidences a version only once');
});

// ---------------------------------------------------------------------------
// UPDATE (§53)
// ---------------------------------------------------------------------------

test('UPDATE preserves id, keeps history, creates a current V2 with evidence + change', async () => {
  const destId = await resolveDestination();
  const { itemId, versionId } = await seedMasterKnowledge({
    destinationId: destId,
    entityName: 'هتل X',
    attribute: 'فاصله تا حرم',
    value: '۱۰ دقیقه',
    canonicalText: 'فاصله هتل X تا حرم ده دقیقه است.',
  });
  const { decisionId } = await makeDecision({
    seed: {
      destinationId: destId,
      entityName: 'هتل X',
      attribute: 'فاصله تا حرم',
      value: '۵ دقیقه',
      canonicalText: 'فاصله هتل X تا حرم پنج دقیقه است.',
    },
    decision: 'UPDATE',
    matchedKnowledgeId: itemId,
    matchedVersionId: versionId,
    reasonCode: 'VALUE_CHANGED',
  });

  await runReconcile(decisionId);

  assert.equal((await getDatabase().select().from(knowledgeItems)).length, 1, 'knowledge id preserved');

  const versions = await getDatabase()
    .select()
    .from(knowledgeVersions)
    .where(eq(knowledgeVersions.knowledgeId, itemId))
    .orderBy(knowledgeVersions.versionNumber);
  assert.equal(versions.length, 2, 'V1 + V2 both kept');
  assert.equal(versions[0]?.versionNumber, 1);
  assert.equal(versions[0]?.isCurrent, false, 'old version preserved, not current');
  assert.equal(versions[0]?.valueText, '۱۰ دقیقه', 'historical value never overwritten');
  assert.equal(versions[1]?.versionNumber, 2);
  assert.equal(versions[1]?.isCurrent, true, 'new version is current');
  assert.equal(versions[1]?.valueText, '۵ دقیقه');

  const evidence = await getDatabase()
    .select()
    .from(knowledgeEvidence)
    .where(eq(knowledgeEvidence.knowledgeId, itemId));
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.knowledgeVersionId, versions[1]?.id, 'evidence links to the new version');

  const changes = await getDatabase()
    .select()
    .from(knowledgeChanges)
    .where(eq(knowledgeChanges.knowledgeId, itemId));
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.changeType, 'UPDATE');
  assert.equal(changes[0]?.oldVersionId, versionId);
  assert.equal(changes[0]?.newVersionId, versions[1]?.id);

  const delta = await batchDeltaService.getDestinationDelta(batchId, destId);
  assert.equal(delta.length, 1);
  assert.equal(delta[0]?.changeType, 'UPDATE');
});

// ---------------------------------------------------------------------------
// CONFLICT (§54)
// ---------------------------------------------------------------------------

test('CONFLICT never changes truth; creates an OPEN conflict excluded from delta', async () => {
  const destId = await resolveDestination();
  const { itemId, versionId } = await seedMasterKnowledge({
    destinationId: destId,
    entityName: 'هتل X',
    attribute: 'فاصله تا حرم',
    value: '۱۰ دقیقه',
    canonicalText: 'فاصله هتل X تا حرم ده دقیقه است.',
  });
  const { decisionId } = await makeDecision({
    seed: {
      destinationId: destId,
      entityName: 'هتل X',
      attribute: 'فاصله تا حرم',
      value: '۲۰ دقیقه',
      canonicalText: 'فاصله هتل X تا حرم بیست دقیقه است.',
    },
    decision: 'CONFLICT',
    matchedKnowledgeId: itemId,
    matchedVersionId: versionId,
    reasonCode: 'CONTRADICTS_EXISTING',
  });

  await runReconcile(decisionId);

  const current = await getDatabase()
    .select()
    .from(knowledgeVersions)
    .where(and(eq(knowledgeVersions.knowledgeId, itemId), eq(knowledgeVersions.isCurrent, true)))
    .get();
  assert.equal(current?.valueText, '۱۰ دقیقه', 'current master value untouched');
  assert.equal((await getDatabase().select().from(knowledgeVersions)).length, 1, 'no new version');

  const conflicts = await getDatabase()
    .select()
    .from(knowledgeConflicts)
    .where(eq(knowledgeConflicts.candidateId, (await getDatabase().select().from(knowledgeCandidates).get())?.id ?? -1));
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.status, 'OPEN');
  assert.equal(conflicts[0]?.existingVersionId, versionId);
  assert.equal(conflicts[0]?.conflictGroupKey.length, 64, 'group key groups same-identity claims');

  const delta = await batchDeltaService.getDestinationDelta(batchId, destId);
  assert.equal(delta.length, 0, 'open conflict excluded from publishable delta');
});

test('CONFLICT replay does not duplicate the conflict record', async () => {
  const destId = await resolveDestination();
  const { itemId, versionId } = await seedMasterKnowledge({
    destinationId: destId,
    entityName: 'هتل X',
    attribute: 'فاصله تا حرم',
    value: '۱۰ دقیقه',
    canonicalText: 'فاصله هتل X تا حرم ده دقیقه است.',
  });
  const { decisionId } = await makeDecision({
    seed: {
      destinationId: destId,
      entityName: 'هتل X',
      attribute: 'فاصله تا حرم',
      value: '۲۰ دقیقه',
      canonicalText: 'فاصله هتل X تا حرم بیست دقیقه است.',
    },
    decision: 'CONFLICT',
    matchedKnowledgeId: itemId,
    matchedVersionId: versionId,
  });

  await runReconcile(decisionId);
  await runReconcile(decisionId);
  assert.equal((await getDatabase().select().from(knowledgeConflicts)).length, 1);
});

// ---------------------------------------------------------------------------
// IGNORE (§55)
// ---------------------------------------------------------------------------

test('IGNORE mutates nothing and finalizes the candidate', async () => {
  const destId = await resolveDestination();
  const { decisionId, candidateId } = await makeDecision({
    seed: {
      destinationId: destId,
      entityName: 'هتل X',
      attribute: 'چت',
      value: null,
      canonicalText: 'درود بر همگی.',
    },
    decision: 'IGNORE',
    reasonCode: 'NOISE',
  });

  await runReconcile(decisionId);

  assert.equal((await getDatabase().select().from(knowledgeItems)).length, 0, 'no master knowledge');
  assert.equal((await getDatabase().select().from(knowledgeVersions)).length, 0, 'no version');
  assert.equal((await getDatabase().select().from(knowledgeChanges)).length, 0, 'no publishable change');
  assert.equal((await getDatabase().select().from(knowledgeEvidence)).length, 0);
  const decision = await getDatabase()
    .select()
    .from(knowledgeDeltaDecisions)
    .where(eq(knowledgeDeltaDecisions.id, decisionId))
    .get();
  assert.ok(decision?.reconciledAt, 'candidate finalized correctly');
  const candidate = await candidatesService.getCandidate(candidateId);
  assert.equal(candidate?.status, 'DECIDED');
});

// ---------------------------------------------------------------------------
// Concurrency & reliability (§56)
// ---------------------------------------------------------------------------

test('two NEW decisions for the same identity cannot create duplicate canonical knowledge', async () => {
  const destId = await resolveDestination();
  const first = await makeDecision({
    seed: {
      destinationId: destId,
      entityName: 'هتل X',
      attribute: 'ترانسفر فرودگاهی',
      value: 'رایگان',
      canonicalText: 'این پکیج ترانسفر فرودگاهی رایگان دارد.',
    },
    decision: 'NEW',
  });
  const second = await makeDecision({
    seed: {
      destinationId: destId,
      entityName: 'هتل X',
      attribute: 'ترانسفر فرودگاهی',
      value: 'رایگان',
      canonicalText: 'این پکیج ترانسفر فرودگاهی رایگان دارد.',
    },
    decision: 'NEW',
  });

  await runReconcile(first.decisionId);
  await runReconcile(second.decisionId);

  assert.equal((await getDatabase().select().from(knowledgeItems)).length, 1, 'one canonical row');
  // The second NEW resolved to a safe behavior (evidence on the canonical).
  const secondDecision = await getDatabase()
    .select()
    .from(knowledgeDeltaDecisions)
    .where(eq(knowledgeDeltaDecisions.id, second.decisionId))
    .get();
  assert.ok(secondDecision?.reasoningSummary?.includes('CONFIRMATION'));
  // Both candidates share ONE transcript, so the evidence-dedup constraint
  // (§11: one source evidences a knowledge only once) keeps a single row.
  assert.equal((await getDatabase().select().from(knowledgeEvidence)).length, 1, 'same-source evidence deduped');
});

test('two UPDATE workers never leave two current versions', async () => {
  const destId = await resolveDestination();
  const { itemId, versionId } = await seedMasterKnowledge({
    destinationId: destId,
    entityName: 'هتل X',
    attribute: 'فاصله تا حرم',
    value: '۱۰ دقیقه',
    canonicalText: 'فاصله هتل X تا حرم ده دقیقه است.',
  });
  const first = await makeDecision({
    seed: {
      destinationId: destId,
      entityName: 'هتل X',
      attribute: 'فاصله تا حرم',
      value: '۵ دقیقه',
      canonicalText: 'فاصله هتل X تا حرم پنج دقیقه است.',
    },
    decision: 'UPDATE',
    matchedKnowledgeId: itemId,
    matchedVersionId: versionId,
  });
  const second = await makeDecision({
    seed: {
      destinationId: destId,
      entityName: 'هتل X',
      attribute: 'فاصله تا حرم',
      value: '۱۵ دقیقه',
      canonicalText: 'فاصله هتل X تا حرم پانزده دقیقه است.',
    },
    decision: 'UPDATE',
    matchedKnowledgeId: itemId,
    matchedVersionId: versionId,
  });

  await runReconcile(first.decisionId);
  await runReconcile(second.decisionId);

  const current = await getDatabase()
    .select()
    .from(knowledgeVersions)
    .where(and(eq(knowledgeVersions.knowledgeId, itemId), eq(knowledgeVersions.isCurrent, true)));
  assert.equal(current.length, 1, 'exactly one current version');
  const versions = await getDatabase()
    .select()
    .from(knowledgeVersions)
    .where(eq(knowledgeVersions.knowledgeId, itemId))
    .orderBy(knowledgeVersions.versionNumber);
  assert.equal(versions.length, 3, 'append-only history V1 V2 V3');
  assert.equal(current[0]?.valueText, '۱۵ دقیقه');
});

test('batch summary stays correct after replays and rebuilds', async () => {
  const destId = await resolveDestination();
  const { itemId, versionId } = await seedMasterKnowledge({
    destinationId: destId,
    entityName: 'هتل X',
    attribute: 'صبحانه',
    value: 'بوفه',
    canonicalText: 'صبحانه هتل X بوفه است.',
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
  await makeDecision({
    seed: {
      destinationId: destId,
      entityName: 'هتل X',
      attribute: 'صبحانه',
      value: 'بوفه',
      canonicalText: 'صبحانه هتل X بوفه است.',
    },
    decision: 'CONFIRMATION',
    matchedKnowledgeId: itemId,
    matchedVersionId: versionId,
  });

  const decisions = await getDatabase().select().from(knowledgeDeltaDecisions);
  for (const d of decisions) await runReconcile(d.id);
  // Replays must not change counts.
  for (const d of decisions) await runReconcile(d.id);

  const first = await batchDeltaService.rebuildBatchDestinationSummary(batchId);
  const second = await batchDeltaService.rebuildBatchDestinationSummary(batchId);
  const stored = await batchDeltaService.getBatchSummaries(batchId);

  assert.deepEqual(second, first, 'rebuild produces identical results');
  assert.equal(second[0]?.newCount, 1);
  assert.equal(second[0]?.confirmationCount, 1);
  assert.equal(second[0]?.publishableDeltaCount, 1);
  assert.deepEqual(stored, first, 'stored summaries match the canonical rebuild');
});

// ---------------------------------------------------------------------------
// Batch delta (§57)
// ---------------------------------------------------------------------------

test('batch delta contains only NEW + UPDATE; confirmation/conflict/ignore excluded; destination isolation', async () => {
  const mashhad = await resolveDestination('مشهد');
  const kish = await resolveDestination('کیش');
  const { itemId: breakfastId, versionId: breakfastVersion } = await seedMasterKnowledge({
    destinationId: mashhad,
    entityName: 'هتل X',
    attribute: 'صبحانه',
    value: 'بوفه',
    canonicalText: 'صبحانه هتل X بوفه است.',
  });

  await makeDecision({
    seed: {
      destinationId: mashhad,
      entityName: 'هتل X',
      attribute: 'ترانسفر',
      value: 'رایگان',
      canonicalText: 'ترانسفر رایگان است.',
    },
    decision: 'NEW',
  });
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
      entityName: 'هتل X',
      attribute: 'فاصله تا حرم',
      value: '۵ دقیقه',
      canonicalText: 'فاصله هتل X تا حرم پنج دقیقه است.',
    },
    decision: 'NEW',
  });
  await makeDecision({
    seed: {
      destinationId: mashhad,
      entityName: 'هتل Y',
      attribute: 'قیمت',
      value: 'مشخص نشده',
      canonicalText: 'قیمت هتل Y مشخص نیست.',
    },
    decision: 'IGNORE',
  });
  await makeDecision({
    seed: {
      destinationId: kish,
      entityName: 'هتل دریا',
      attribute: 'ترانسفر',
      value: 'پولی',
      canonicalText: 'ترانسفر هتل دریا پولی است.',
    },
    decision: 'NEW',
  });

  const decisions = await getDatabase().select().from(knowledgeDeltaDecisions);
  for (const d of decisions) await runReconcile(d.id);

  const mashhadDelta = await batchDeltaService.getDestinationDelta(batchId, mashhad);
  assert.equal(mashhadDelta.length, 2, 'only the two NEW items are publishable');
  for (const item of mashhadDelta) assert.equal(item.changeType, 'NEW');
  assert.ok(mashhadDelta.some((i) => i.attribute === 'ترانسفر'));
  assert.ok(mashhadDelta.some((i) => i.attribute === 'فاصله تا حرم'));

  const kishDelta = await batchDeltaService.getDestinationDelta(batchId, kish);
  assert.equal(kishDelta.length, 1);
  assert.equal(kishDelta[0]?.entityName, 'هتل دریا', 'destination isolation');

  const full = await batchDeltaService.getBatchDelta(batchId);
  const mashhadDest = full.destinations.find((d) => d.destinationId === mashhad);
  assert.equal(mashhadDest?.items.length, 2);
  assert.ok(!mashhadDest?.items.some((i) => i.attribute === 'صبحانه'), 'CONFIRMATION excluded');
  assert.ok(!mashhadDest?.items.some((i) => i.attribute === 'قیمت'), 'IGNORE excluded');

  const summary = await batchDeltaService.rebuildBatchDestinationSummary(batchId);
  const mashhadSummary = summary.find((s) => s.destinationId === mashhad);
  assert.equal(mashhadSummary?.newCount, 2);
  assert.equal(mashhadSummary?.confirmationCount, 1);
  assert.equal(mashhadSummary?.ignoredCount, 1);
  assert.equal(mashhadSummary?.publishableDeltaCount, 2);
});

// ---------------------------------------------------------------------------
// Reconciliation worker (§5, §48) — job-driven, no Gemini
// ---------------------------------------------------------------------------

test('reconciliation worker applies a decision through the job engine idempotently', async () => {
  const destId = await resolveDestination();
  const { decisionId } = await makeDecision({
    seed: {
      destinationId: destId,
      entityName: 'هتل X',
      attribute: 'ترانسفر',
      value: 'رایگان',
      canonicalText: 'ترانسفر رایگان است.',
    },
    decision: 'NEW',
  });
  const job = await jobService.createJob({
    batchId,
    jobType: 'KNOWLEDGE_RECONCILIATION',
    entityId: decisionId,
    idempotencyKey: `RECONCILE:${decisionId}`,
  });
  assert.equal(job.created, true);
  // Creating again is a no-op (idempotency key).
  const again = await jobService.createJob({
    batchId,
    jobType: 'KNOWLEDGE_RECONCILIATION',
    entityId: decisionId,
    idempotencyKey: `RECONCILE:${decisionId}`,
  });
  assert.equal(again.created, false);

  await getDatabase().update(batches).set({ status: 'RECONCILING', updatedAt: new Date() }).where(eq(batches.id, batchId));
  const worker = new ReconciliationWorker();
  const claimed = await jobService.claimNextJob('KNOWLEDGE_RECONCILIATION');
  assert.ok(claimed);
  await worker.processJob(claimed);

  assert.equal((await getDatabase().select().from(knowledgeItems)).length, 1);
  const done = await jobService.getJob(claimed.id);
  assert.equal(done?.status, 'COMPLETED');

  // A re-claimed replay of the same job is a no-op (reconciledAt guard).
  const decision = await getDatabase()
    .select()
    .from(knowledgeDeltaDecisions)
    .where(eq(knowledgeDeltaDecisions.id, decisionId))
    .get();
  assert.ok(decision?.reconciledAt);
});

// ---------------------------------------------------------------------------
// Manual scenario (§58)
// ---------------------------------------------------------------------------

test('manual Mashhad scenario reconciles to the expected master + batch delta', async () => {
  const destId = await resolveDestination('مشهد');
  const { itemId: breakfastItem, versionId: breakfastVersion } = await seedMasterKnowledge({
    destinationId: destId,
    entityName: 'هتل X',
    attribute: 'صبحانه',
    value: 'بوفه',
    canonicalText: 'صبحانه هتل X بوفه است.',
  });
  const { itemId: distanceItem, versionId: distanceVersion } = await seedMasterKnowledge({
    destinationId: destId,
    entityName: 'هتل X',
    attribute: 'فاصله تا حرم',
    value: '۱۰ دقیقه',
    canonicalText: 'فاصله هتل X تا حرم ده دقیقه است.',
  });

  await makeDecision({
    seed: {
      destinationId: destId,
      entityName: 'هتل X',
      attribute: 'صبحانه',
      value: 'بوفه',
      canonicalText: 'صبحانه هتل X بوفه است.',
    },
    decision: 'CONFIRMATION',
    matchedKnowledgeId: breakfastItem,
    matchedVersionId: breakfastVersion,
  });
  await makeDecision({
    seed: {
      destinationId: destId,
      entityName: 'هتل X',
      attribute: 'فاصله تا حرم',
      value: '۵ دقیقه',
      canonicalText: 'فاصله هتل X تا حرم پنج دقیقه است.',
    },
    decision: 'UPDATE',
    matchedKnowledgeId: distanceItem,
    matchedVersionId: distanceVersion,
  });
  await makeDecision({
    seed: {
      destinationId: destId,
      entityName: null,
      attribute: 'ترانسفر فرودگاهی',
      value: 'رایگان',
      canonicalText: 'این پکیج ترانسفر فرودگاهی رایگان دارد.',
    },
    decision: 'NEW',
  });
  await makeDecision({
    seed: {
      destinationId: destId,
      entityName: 'هتل X',
      attribute: 'فاصله تا حرم',
      value: '۲۰ دقیقه',
      canonicalText: 'فاصله هتل X تا حرم بیست دقیقه است.',
    },
    decision: 'CONFLICT',
    matchedKnowledgeId: distanceItem,
    matchedVersionId: distanceVersion,
  });

  const decisions = await getDatabase().select().from(knowledgeDeltaDecisions);
  for (const d of decisions) await runReconcile(d.id);

  // --- Master knowledge expectations ---
  // Breakfast: same current version, new evidence.
  const breakfastVersions = await getDatabase()
    .select()
    .from(knowledgeVersions)
    .where(eq(knowledgeVersions.knowledgeId, breakfastItem));
  assert.equal(breakfastVersions.length, 1, 'breakfast keeps its single version');
  assert.equal(breakfastVersions[0]?.isCurrent, true);
  const breakfastEvidence = await getDatabase()
    .select()
    .from(knowledgeEvidence)
    .where(eq(knowledgeEvidence.knowledgeId, breakfastItem));
  assert.equal(breakfastEvidence.length, 1, 'new evidence added');

  // Distance: V1 = 10 (historical), V2 = 5 CURRENT.
  const distanceVersions = await getDatabase()
    .select()
    .from(knowledgeVersions)
    .where(eq(knowledgeVersions.knowledgeId, distanceItem))
    .orderBy(knowledgeVersions.versionNumber);
  assert.equal(distanceVersions.length, 2);
  assert.equal(distanceVersions[0]?.valueText, '۱۰ دقیقه');
  assert.equal(distanceVersions[0]?.isCurrent, false);
  assert.equal(distanceVersions[1]?.valueText, '۵ دقیقه');
  assert.equal(distanceVersions[1]?.isCurrent, true);

  // Airport transfer: V1 = free CURRENT.
  const transferItems = await getDatabase()
    .select()
    .from(knowledgeItems)
    .where(eq(knowledgeItems.attribute, 'ترانسفر فرودگاهی'));
  assert.equal(transferItems.length, 1);
  const transferVersion = await getDatabase()
    .select()
    .from(knowledgeVersions)
    .where(eq(knowledgeVersions.knowledgeId, transferItems[0]?.id as number));
  assert.equal(transferVersion.length, 1);
  assert.equal(transferVersion[0]?.valueText, 'رایگان');
  assert.equal(transferVersion[0]?.isCurrent, true);

  // Conflict: the 20-minute claim is OPEN.
  const conflicts = await getDatabase().select().from(knowledgeConflicts);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.status, 'OPEN');
  assert.equal(conflicts[0]?.existingVersionId, distanceVersion);

  // --- Batch delta expectations ---
  const delta = await batchDeltaService.getDestinationDelta(batchId, destId);
  assert.equal(delta.length, 2, 'delta = NEW transfer + UPDATE distance');
  const transferChange = delta.find((d) => d.attribute === 'ترانسفر فرودگاهی');
  assert.equal(transferChange?.changeType, 'NEW');
  const distanceChange = delta.find((d) => d.attribute === 'فاصله تا حرم');
  assert.equal(distanceChange?.changeType, 'UPDATE');
  assert.equal(distanceChange?.currentValue, '۵ دقیقه');
  assert.ok(!delta.some((d) => d.attribute === 'صبحانه'), 'breakfast confirmation excluded');
  assert.ok(!delta.some((d) => d.currentValue === '۲۰ دقیقه'), 'conflict excluded');

  // The 20-minute claim never overwrote truth.
  const currentDistance = await getDatabase()
    .select()
    .from(knowledgeVersions)
    .where(and(eq(knowledgeVersions.knowledgeId, distanceItem), eq(knowledgeVersions.isCurrent, true)))
    .get();
  assert.equal(currentDistance?.valueText, '۵ دقیقه');
});
