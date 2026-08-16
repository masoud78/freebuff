import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { closeDatabase, getDatabase, initDatabase } from '../core/database/index.js';
import { audioFiles, jobs } from '../core/database/schema.js';
import { batchService } from './batches.service.js';
import { jobService } from './jobs.service.js';
import { settingsService } from './settings.service.js';

let dir: string;
let audioDir: string;

function writeFixture(name: string, content?: Buffer): string {
  const path = join(audioDir, name);
  writeFileSync(path, content ?? randomBytes(64));
  return path;
}

function fixtureNames(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `audio-${i + 1}.mp3`);
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'freebuff-batch-test-'));
  audioDir = join(dir, 'audio');
  mkdirSync(audioDir, { recursive: true });
  process.env.DB_PATH = join(dir, 'test.db');
  await initDatabase();
  await settingsService.updateSettings({ workspacePath: dir, processingConcurrency: 2 });
});

after(async () => {
  await closeDatabase();
  delete process.env.DB_PATH;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may hold the SQLite handle; temp dirs are harmless.
  }
});

async function jobCount(batchId: number): Promise<number> {
  const db = getDatabase();
  const row = await db
    .select({ count: sql<number>`count(${jobs.id})` })
    .from(jobs)
    .where(eq(jobs.batchId, batchId))
    .get();
  return Number(row?.count ?? 0);
}

async function audioStatuses(batchId: number): Promise<string[]> {
  const db = getDatabase();
  const rows = await db.select({ status: audioFiles.status }).from(audioFiles).where(eq(audioFiles.batchId, batchId));
  return rows.map((row) => row.status);
}

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

test('create batch', async () => {
  const batch = await batchService.createBatch();
  assert.equal(batch.status, 'CREATED');
  assert.deepEqual(batch.stats, {
    totalAudio: 0,
    newAudio: 0,
    duplicates: 0,
    queuedJobs: 0,
    transcribing: 0,
    transcribed: 0,
    failedItems: 0,
    knowledgePending: 0,
    knowledgeAnalyzing: 0,
    knowledgeAnalyzed: 0,
    detectedDestinations: 0,
    extractedKnowledge: 0,
  });
});

test('scan an empty folder completes with no files', async () => {
  const batch = await batchService.createBatch();
  const scanned = await batchService.scanBatch(batch.id);
  assert.equal(scanned.status, 'COMPLETED');
  assert.equal(scanned.stats.totalAudio, 0);
  assert.equal(scanned.stats.newAudio, 0);
});

test('register valid audio files', async () => {
  fixtureNames(3).forEach((name) => writeFixture(name));
  const batch = await batchService.createBatch();
  const scanned = await batchService.scanBatch(batch.id);
  assert.equal(scanned.stats.totalAudio, 3);
  assert.equal(scanned.stats.newAudio, 3);
  assert.equal(scanned.stats.duplicates, 0);
  assert.equal(scanned.stats.queuedJobs, 3);
  assert.equal(scanned.status, 'READY');
});

test('unsupported files are ignored during scan', async () => {
  writeFixture('notes.txt', Buffer.from('not audio'));
  writeFixture('image.png', randomBytes(32));
  const batch = await batchService.createBatch();
  const scanned = await batchService.scanBatch(batch.id);
  // The 3 mp3 fixtures from the previous test are still on disk; the
  // unsupported files must not appear in the batch at all.
  assert.equal(scanned.stats.totalAudio, 3, 'only supported audio extensions count');
  const names = (await batchService.getBatch(batch.id)).audio.map((a) => a.originalName);
  assert.ok(!names.includes('notes.txt'));
  assert.ok(!names.includes('image.png'));
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

test('duplicate audio files are detected by SHA-256', async () => {
  // The same 3 files from the earlier test are still on disk.
  const batch = await batchService.createBatch();
  const scanned = await batchService.scanBatch(batch.id);
  assert.equal(scanned.stats.totalAudio, 3);
  assert.equal(scanned.stats.newAudio, 0);
  assert.equal(scanned.stats.duplicates, 3);
  assert.equal(scanned.stats.queuedJobs, 0);
  assert.equal(scanned.status, 'COMPLETED');

  const detail = await batchService.getBatch(batch.id);
  for (const audio of detail.audio) {
    assert.equal(audio.status, 'DUPLICATE');
    assert.ok(audio.duplicateOfAudioId !== null, 'duplicate points at the original');
  }
});

test('duplicate audio does not receive a transcription job', async () => {
  // Batch above created 0 jobs; verify across the DB.
  const batches = await batchService.listBatches();
  const dupBatch = batches.find((b) => b.stats.duplicates === 3 && b.stats.newAudio === 0);
  assert.ok(dupBatch, 'duplicate-only batch exists');
  assert.equal(await jobCount(dupBatch.id), 0);
});

test('new audio receives exactly one transcription job each', async () => {
  const batches = await batchService.listBatches();
  const newBatch = batches.find((b) => b.stats.newAudio === 3);
  assert.ok(newBatch, 'batch with 3 new files exists');
  assert.equal(await jobCount(newBatch.id), 3);
});

test('re-scanning the same batch is idempotent', async () => {
  const batch = await batchService.createBatch();
  const first = await batchService.scanBatch(batch.id);
  const beforeAudio = first.stats.totalAudio;
  const beforeJobs = await jobCount(batch.id);

  const second = await batchService.scanBatch(batch.id);
  // No new rows and no new jobs — the scan is a no-op the second time.
  assert.equal(second.stats.totalAudio, beforeAudio, 'no duplicate audio rows');
  assert.equal(await jobCount(batch.id), beforeJobs, 'no duplicate jobs');
  assert.equal(second.stats.newAudio, first.stats.newAudio, 'new count unchanged');
  assert.equal(second.stats.duplicates, first.stats.duplicates, 'duplicate count unchanged');
});

test('adding new files to a later batch mixes new and duplicates', async () => {
  writeFixture('new-a.mp3');
  writeFixture('new-b.wav');
  const batch = await batchService.createBatch();
  const scanned = await batchService.scanBatch(batch.id);
  assert.equal(scanned.stats.newAudio, 2);
  assert.equal(scanned.stats.duplicates, 3);
  assert.equal(scanned.stats.queuedJobs, 2);
  const statuses = await audioStatuses(batch.id);
  assert.equal(statuses.filter((s) => s === 'QUEUED').length, 2);
  assert.equal(statuses.filter((s) => s === 'DUPLICATE').length, 3);
});

// ---------------------------------------------------------------------------
// Job engine
// ---------------------------------------------------------------------------

test('job creation is idempotent by key', async () => {
  const batch = await batchService.createBatch();
  const first = await jobService.createJob({
    batchId: batch.id,
    jobType: 'TRANSCRIPTION',
    entityId: 999,
    idempotencyKey: 'TRANSCRIPTION:999',
  });
  assert.equal(first.created, true);
  const second = await jobService.createJob({
    batchId: batch.id,
    jobType: 'TRANSCRIPTION',
    entityId: 999,
    idempotencyKey: 'TRANSCRIPTION:999',
  });
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  assert.equal(await jobCount(batch.id), 1);
});

test('stale RUNNING jobs are recovered to PENDING', async () => {
  const batch = await batchService.createBatch();
  const job = await jobService.createJob({
    batchId: batch.id,
    jobType: 'TRANSCRIPTION',
    entityId: 1001,
    idempotencyKey: 'TRANSCRIPTION:1001',
  });
  await jobService.markRunning(job.id);
  assert.equal((await jobService.getPendingJobs()).some((j) => j.id === job.id), false);

  const recovered = await jobService.recoverStaleJobs();
  assert.ok(recovered >= 1);
  const pending = await jobService.getPendingJobs();
  const jobRow = pending.find((j) => j.id === job.id);
  assert.ok(jobRow, 'job is pending again');
  assert.equal(jobRow.status, 'PENDING');
  assert.equal(jobRow.lockedAt, null);
});

// ---------------------------------------------------------------------------
// Persistence across restart
// ---------------------------------------------------------------------------

test('batch data persists after database reopen', async () => {
  await closeDatabase();
  await initDatabase();

  const batches = await batchService.listBatches();
  assert.ok(batches.length >= 3, `expected batches to survive, got ${batches.length}`);
  const withAudio = batches.find((b) => b.stats.totalAudio > 0);
  assert.ok(withAudio, 'a batch with audio survives');
  const detail = await batchService.getBatch(withAudio.id);
  assert.ok(detail.audio.length > 0, 'audio rows survive restart');
  assert.ok((await jobCount(withAudio.id)) >= 1, 'jobs survive restart');
});

// ---------------------------------------------------------------------------
// API surface
// ---------------------------------------------------------------------------

test('GET /api/batches lists batches with stats', async () => {
  const app = buildApp({ loggerOptions: { level: 'silent' } });
  const response = await app.inject({ method: 'GET', url: '/api/batches' });
  assert.equal(response.statusCode, 200);
  const body = response.json() as Array<{ stats: { totalAudio: number } }>;
  assert.ok(body.length >= 1);
  assert.ok(typeof body[0]?.stats?.totalAudio === 'number');
});

test('batch audio API never exposes the local absolute path', async () => {
  const app = buildApp({ loggerOptions: { level: 'silent' } });
  const batches = await batchService.listBatches();
  const withAudio = batches.find((b) => b.stats.totalAudio > 0);
  assert.ok(withAudio);
  const response = await app.inject({ method: 'GET', url: `/api/batches/${withAudio.id}/audio` });
  assert.equal(response.statusCode, 200);
  const body = JSON.stringify(response.json());
  assert.ok(!body.includes(audioDir), 'absolute path leaked in API response');
});
