import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { eq } from 'drizzle-orm';
import type { GeminiUsage, NoteExtraction } from '@freebuff/contracts';
import { closeDatabase, getDatabase, initDatabase } from '../core/database/index.js';
import {
  audioFiles,
  batches,
  destinationNoteLogs,
  destinationNotes,
  destinationNoteSources,
  destinationNoteVersions,
  destinations,
  jobs,
  knowledgeAnalysisRuns,
  modelConfigs,
  noteProposals,
  transcripts,
  transcriptSegments,
  voiceReports,
} from '../core/database/schema.js';
import { credentialStore } from './gemini/credentials.store.js';
import { GeminiGatewayError, type GeminiGatewayLike } from './gemini/gateway.js';
import { jobService } from './jobs.service.js';
import { destinationService } from './knowledge/destinations.service.js';
import { noteExtractionService } from './knowledge/note-extraction.service.js';
import { promptsService } from './prompts.service.js';
import { sessionsService } from './sessions.service.js';
import { settingsService } from './settings.service.js';

const MODEL_ID = 'gemini-2.5-flash';
const ZERO_USAGE: GeminiUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0 };

type ExtractionOverride = Omit<Partial<NoteExtraction>, 'notes' | 'audienceInsights'> & {
  notes?: Partial<NoteExtraction['notes'][number]>[];
  audienceInsights?: Partial<NoteExtraction['audienceInsights'][number]>[];
};

function extraction(overrides: ExtractionOverride = {}): NoteExtraction {
  const notes: NoteExtraction['notes'] = (overrides.notes ?? [
    {
      title: 'فاصله هتل تا حرم',
      description: 'هتل پارس حدود پنج دقیقه با حرم فاصله دارد.',
      destination: { name: 'مشهد', role: 'DESTINATION' },
      relevantDate: null,
    },
  ]).map((n) => ({
    title: n.title ?? '',
    description: n.description ?? '',
    destination: n.destination ?? { name: 'مشهد', role: 'DESTINATION' },
    relevantDate: n.relevantDate ?? null,
    kind: n.kind ?? 'DESTINATION_INFO',
    scopeType: n.scopeType ?? 'DESTINATION',
    tourSubject: n.tourSubject ?? null,
  }));
  const audienceInsights: NoteExtraction['audienceInsights'] = (overrides.audienceInsights ?? []).map((i) => ({
    title: i.title ?? '',
    description: i.description ?? '',
    destination: i.destination ?? { name: 'مشهد', role: 'DESTINATION' },
    inferenceBasis: i.inferenceBasis ?? 'مبنای استنباط',
    confidence: i.confidence ?? 0.5,
    contentOpportunity: i.contentOpportunity ?? null,
  }));
  return {
    voiceReport: overrides.voiceReport ?? 'این تماس درباره هتل نزدیک حرم بود.',
    conversationTopic: overrides.conversationTopic ?? 'بررسی هتل‌های نزدیک حرم',
    notes,
    audienceInsights,
  };
}

class NoteGateway implements GeminiGatewayLike {
  analyzeCalls = 0;
  compareCalls = 0;
  compareDecision: 'ADD' | 'UPDATE' | 'MARK_OUTDATED' | 'NO_CHANGE' = 'ADD';

  constructor(private readonly output: NoteExtraction = extraction()) {}

  async testConnection(): Promise<void> {}
  async listModels() {
    return [];
  }
  async transcribeAudio() {
    return { text: 'متن', usage: ZERO_USAGE, durationMs: 1 };
  }
  async analyzeKnowledge() {
    return { analysis: { destinations: [], knowledge: [] }, usage: ZERO_USAGE, durationMs: 1 };
  }
  async analyzeNotes() {
    this.analyzeCalls += 1;
    return { analysis: this.output, usage: ZERO_USAGE, durationMs: 1 };
  }
  async compareNote() {
    this.compareCalls += 1;
    return {
      comparison: { decision: this.compareDecision, matchedNoteId: 0, logReason: 'دلیل تست' },
      usage: ZERO_USAGE,
      durationMs: 1,
    };
  }
  async createEmbedding(): Promise<never> {
    throw new GeminiGatewayError('GEMINI_API_ERROR', 'not used');
  }
  async classifyDelta(): Promise<never> {
    throw new GeminiGatewayError('GEMINI_API_ERROR', 'not used');
  }
  async generateContent() {
    return { text: 'محتوا', usage: ZERO_USAGE, durationMs: 1 };
  }
}

let dir: string;

async function configure(workspaceDir: string): Promise<void> {
  await settingsService.updateSettings({ workspacePath: workspaceDir, processingConcurrency: 2 });
  const db = getDatabase();
  const now = new Date();
  for (const stage of ['TRANSCRIPTION', 'KNOWLEDGE_PROCESSING', 'EMBEDDING'] as const) {
    await db
      .insert(modelConfigs)
      .values({ stage, provider: 'GEMINI', modelId: MODEL_ID, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: modelConfigs.stage,
        set: { modelId: MODEL_ID, provider: 'GEMINI', updatedAt: now },
      });
  }
  await promptsService.saveVersion('TRANSCRIPTION', { content: 'پرامپت تبدیل تست' });
  await promptsService.saveVersion('KNOWLEDGE_PROCESSING', { content: 'پرامپت پردازش تست' });
  await credentialStore.saveKey('test-key');
}

async function wipeDomain(): Promise<void> {
  const db = getDatabase();
  await db.delete(destinationNoteLogs);
  await db.delete(destinationNoteSources);
  await db.delete(destinationNoteVersions);
  await db.delete(destinationNotes);
  await db.delete(noteProposals);
  await db.delete(voiceReports);
  await db.delete(knowledgeAnalysisRuns);
  await db.delete(transcriptSegments);
  await db.delete(transcripts);
  await db.delete(jobs);
  await db.delete(audioFiles);
  await db.delete(destinations);
  await db.delete(batches);
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'freebuff-simplify-test-'));
  mkdirSync(join(dir, 'audio'), { recursive: true });
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.GEMINI_CREDENTIALS_FILE = join(dir, 'gemini.key');
  await initDatabase();
  await promptsService.ensureDefaultTemplates();
  await configure(dir);
});

after(async () => {
  await closeDatabase();
  delete process.env.DB_PATH;
  delete process.env.GEMINI_CREDENTIALS_FILE;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may hold the SQLite handle.
  }
});

beforeEach(async () => {
  await wipeDomain();
});

/** Create a session with one uploaded+transcribed audio and a note job. */
async function sessionWithTranscript(): Promise<{ sessionId: number; audioId: number; transcriptId: number }> {
  const session = await sessionsService.createSession();
  await sessionsService.uploadFiles(session.id, [
    { filename: 'call-001.mp3', mimeType: 'audio/mpeg', data: Buffer.from('audio-bytes') },
  ]);
  const db = getDatabase();
  const audio = await db
    .select()
    .from(audioFiles)
    .where(eq(audioFiles.batchId, session.id))
    .get();
  assert.ok(audio);
  const now = new Date();
  const transcript = await db
    .insert(transcripts)
    .values({
      audioId: audio.id,
      fullText: 'مسافر درباره هتل نزدیک حرم سوال کرد.',
      normalizedText: 'مسافر درباره هتل نزدیک حرم سوال کرد.',
      normalizedHash: 'hash-' + audio.id,
      language: null,
      modelId: MODEL_ID,
      promptVersionId: 1,
      status: 'COMPLETED',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: transcripts.id });
  const transcriptId = transcript[0]?.id;
  assert.ok(transcriptId);
  await db
    .update(batches)
    .set({ sessionStage: 'PROCESS', status: 'PROCESSING' })
    .where(eq(batches.id, session.id));
  return { sessionId: session.id, audioId: audio.id, transcriptId };
}

// ---------------------------------------------------------------------------
// Destination role routing
// ---------------------------------------------------------------------------

test('ORIGIN place never creates a destination; DESTINATION does', async () => {
  const origin = await destinationService.resolveOrCreateNoteDestination(
    { name: 'تبریز', role: 'ORIGIN' },
    null,
  );
  assert.equal(origin, null, 'origin city must never become a destination');

  const dest = await destinationService.resolveOrCreateNoteDestination(
    { name: 'مشهد', role: 'DESTINATION' },
    null,
  );
  assert.ok(dest);
  assert.equal(dest.created, true);

  const rows = await getDatabase().select().from(destinations);
  assert.equal(rows.length, 1, 'only Mashhad exists');
  assert.equal(rows[0]?.canonicalName, 'مشهد');
});

test('multi-destination notes each map to their own destination', async () => {
  const { transcriptId, sessionId } = await sessionWithTranscript();
  const gateway = new NoteGateway(
    extraction({
      notes: [
        {
          title: 'نکته مشهد',
          description: 'اطلاعات مشهد',
          destination: { name: 'مشهد', role: 'DESTINATION' },
          relevantDate: null,
        },
        {
          title: 'نکته کیش',
          description: 'اطلاعات کیش',
          destination: { name: 'کیش', role: 'DESTINATION' },
          relevantDate: null,
        },
      ],
    }),
  );
  await jobService.createJob({
    batchId: sessionId,
    jobType: 'NOTE_EXTRACTION',
    entityId: transcriptId,
    idempotencyKey: `NOTE_EXTRACTION:${transcriptId}`,
  });
  const job = await jobService.claimNextJob('NOTE_EXTRACTION');
  assert.ok(job);
  await noteExtractionService.processJob(job, gateway);

  const proposals = await getDatabase().select().from(noteProposals).orderBy(noteProposals.id);
  assert.equal(proposals.length, 2);
  const names = proposals.map((p) => p.title).sort();
  assert.deepEqual(names, ['نکته کیش', 'نکته مشهد'].sort());
  const destNames = await getDatabase().select({ id: destinations.id, name: destinations.canonicalName }).from(destinations);
  assert.equal(destNames.length, 2);
});

// ---------------------------------------------------------------------------
// Manual stage control
// ---------------------------------------------------------------------------

test('upload never auto-transcribes; processing never auto-starts', async () => {
  const session = await sessionsService.createSession();
  await sessionsService.uploadFiles(session.id, [
    { filename: 'a.mp3', mimeType: 'audio/mpeg', data: Buffer.from('x') },
  ]);

  let jobCount = await getDatabase().select().from(jobs);
  assert.equal(jobCount.length, 0, 'upload must not create transcription jobs');

  const detail = await sessionsService.getSession(session.id);
  assert.equal(detail.stage, 'UPLOAD');

  // No transcript yet — processing cannot start.
  await assert.rejects(() => sessionsService.startProcessing(session.id));

  await sessionsService.startTranscription(session.id);
  jobCount = await getDatabase().select().from(jobs);
  assert.equal(jobCount.filter((j) => j.jobType === 'TRANSCRIPTION').length, 1);
});

// ---------------------------------------------------------------------------
// Extraction → proposals + commit
// ---------------------------------------------------------------------------

test('processing produces a voice report and an ADD proposal; commit applies it', async () => {
  const { sessionId, transcriptId, audioId } = await sessionWithTranscript();
  const gateway = new NoteGateway();
  await jobService.createJob({
    batchId: sessionId,
    jobType: 'NOTE_EXTRACTION',
    entityId: transcriptId,
    idempotencyKey: `NOTE_EXTRACTION:${transcriptId}`,
  });
  const job = await jobService.claimNextJob('NOTE_EXTRACTION');
  assert.ok(job);
  await noteExtractionService.processJob(job, gateway);

  // Report persisted.
  const reports = await getDatabase().select().from(voiceReports);
  assert.equal(reports.length, 1);
  assert.ok(reports[0]?.report.includes('هتل'));

  // One ADD proposal.
  const proposals = await getDatabase().select().from(noteProposals);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0]?.proposedAction, 'ADD');
  assert.equal(proposals[0]?.status, 'PENDING');

  // Stage advanced to REVIEW.
  const detail = await sessionsService.getSession(sessionId);
  assert.equal(detail.stage, 'REVIEW');

  // Commit applies it to the destination database.
  const commit = await sessionsService.commit(sessionId);
  assert.equal(commit.applied, 1);
  assert.equal(commit.destinations.length, 1);

  const notes = await getDatabase().select().from(destinationNotes);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.currentTitle, 'فاصله هتل تا حرم');
  assert.equal(notes[0]?.status, 'CURRENT');

  const versions = await getDatabase().select().from(destinationNoteVersions);
  assert.equal(versions.length, 1);
  assert.equal(versions[0]?.versionNumber, 1);

  const sources = await getDatabase().select().from(destinationNoteSources);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.audioId, audioId);

  const logs = await getDatabase().select().from(destinationNoteLogs);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.eventType, 'NOTE_ADDED');
  assert.ok(logs[0]?.reason);
});

test('same title repeats → NO_CHANGE; changed title → UPDATE with new version + log', async () => {
  const first = await sessionWithTranscript();
  const gateway = new NoteGateway();
  await jobService.createJob({
    batchId: first.sessionId,
    jobType: 'NOTE_EXTRACTION',
    entityId: first.transcriptId,
    idempotencyKey: `NOTE_EXTRACTION:${first.transcriptId}`,
  });
  const job1 = await jobService.claimNextJob('NOTE_EXTRACTION');
  assert.ok(job1);
  await noteExtractionService.processJob(job1, gateway);
  await sessionsService.commit(first.sessionId);

  // Second session: same title, different description → UPDATE proposal.
  const second = await sessionWithTranscript();
  const gateway2 = new NoteGateway(
    extraction({
      notes: [
        {
          title: 'فاصله هتل تا حرم',
          description: 'فاصله پیاده حدود هفت دقیقه است.',
          destination: { name: 'مشهد', role: 'DESTINATION' },
          relevantDate: null,
        },
      ],
    }),
  );
  await jobService.createJob({
    batchId: second.sessionId,
    jobType: 'NOTE_EXTRACTION',
    entityId: second.transcriptId,
    idempotencyKey: `NOTE_EXTRACTION:${second.transcriptId}`,
  });
  const job2 = await jobService.claimNextJob('NOTE_EXTRACTION');
  assert.ok(job2);
  await noteExtractionService.processJob(job2, gateway2);

  const proposals = await getDatabase()
    .select()
    .from(noteProposals)
    .where(eq(noteProposals.batchId, second.sessionId));
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0]?.proposedAction, 'UPDATE');

  await sessionsService.commit(second.sessionId);

  const notes = await getDatabase().select().from(destinationNotes);
  assert.equal(notes.length, 1, 'still one note, not a duplicate');
  assert.equal(notes[0]?.currentDescription, 'فاصله پیاده حدود هفت دقیقه است.');

  const versions = await getDatabase().select().from(destinationNoteVersions).orderBy(destinationNoteVersions.versionNumber);
  assert.equal(versions.length, 2, 'history preserved');
  assert.equal(versions[1]?.versionNumber, 2);

  const logs = await getDatabase().select().from(destinationNoteLogs).orderBy(destinationNoteLogs.id);
  assert.equal(logs.length, 2);
  assert.equal(logs[1]?.eventType, 'NOTE_UPDATED');

  const sources = await getDatabase().select().from(destinationNoteSources);
  assert.equal(sources.length, 2, 'both voices attach to the same note');
});
