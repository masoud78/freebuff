import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
import { destinationNotesService } from './destination-notes.service.js';
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
  compareDecision: 'ADD' | 'UPDATE' | 'MARK_OUTDATED' | 'NO_CHANGE' = 'ADD';
  compareLogReason = 'اطلاعات جدید تفاوت فاصله را نشان می‌دهد.';

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
    return { analysis: this.output, usage: ZERO_USAGE, durationMs: 1 };
  }
  async compareNote() {
    return {
      comparison: { decision: this.compareDecision, matchedNoteId: 0, logReason: this.compareLogReason },
      usage: ZERO_USAGE,
      durationMs: 1,
    };
  }
  async createEmbedding() {
    return { embedding: [0.1, 0.2, 0.3], usage: ZERO_USAGE, durationMs: 1 };
  }
  async classifyDelta(): Promise<never> {
    throw new GeminiGatewayError('GEMINI_API_ERROR', 'not used');
  }
  async generateContent() {
    return { text: 'محتوا', usage: ZERO_USAGE, durationMs: 1 };
  }
}

let dir: string;

async function configure(): Promise<void> {
  await settingsService.updateSettings({ workspacePath: dir, processingConcurrency: 2 });
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
  dir = mkdtempSync(join(tmpdir(), 'freebuff-v2-test-'));
  mkdirSync(join(dir, 'audio'), { recursive: true });
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.GEMINI_CREDENTIALS_FILE = join(dir, 'gemini.key');
  await initDatabase();
  await promptsService.ensureDefaultTemplates();
  await configure();
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

/** Session with one uploaded audio and a COMPLETED transcript (transcription done). */
async function sessionTranscribed(): Promise<{ sessionId: number; audioId: number; transcriptId: number; audioPath: string }> {
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
  await db
    .update(audioFiles)
    .set({ status: 'TRANSCRIBED', updatedAt: now })
    .where(eq(audioFiles.id, audio.id));
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
  await db
    .update(batches)
    .set({ sessionStage: 'PROCESS', status: 'TRANSCRIBED', updatedAt: now })
    .where(eq(batches.id, session.id));
  return {
    sessionId: session.id,
    audioId: audio.id,
    transcriptId: transcript[0]?.id as number,
    audioPath: audio.absolutePath,
  };
}

/** Run note extraction for a transcript with the given gateway output. */
async function processTranscript(transcriptId: number, sessionId: number, gateway: NoteGateway): Promise<void> {
  await sessionsService.startProcessing(sessionId);
  const job = await jobService.claimNextJob('NOTE_EXTRACTION');
  assert.ok(job);
  assert.equal(job.entityId, transcriptId);
  await noteExtractionService.processJob(job, gateway);
}

// ---------------------------------------------------------------------------
// Loading-state regression
// ---------------------------------------------------------------------------

test('transcription finished → process button not loading and enabled', async () => {
  const { sessionId } = await sessionTranscribed();
  const derived = (await sessionsService.getSession(sessionId)).derived;
  assert.equal(derived.isTranscribing, false);
  assert.equal(derived.isKnowledgeProcessing, false);
  assert.equal(derived.canStartProcessing, true);
});

test('knowledge processing active → process button loading', async () => {
  const { sessionId } = await sessionTranscribed();
  await sessionsService.startProcessing(sessionId);
  const derived = (await sessionsService.getSession(sessionId)).derived;
  assert.equal(derived.isKnowledgeProcessing, true);
  assert.equal(derived.canStartProcessing, false);
  assert.equal(derived.canApplyToDatabase, false);

  const job = await jobService.claimNextJob('NOTE_EXTRACTION');
  assert.ok(job);
  await noteExtractionService.processJob(job, new NoteGateway());
  const after = (await sessionsService.getSession(sessionId)).derived;
  assert.equal(after.isKnowledgeProcessing, false);
  assert.equal(after.knowledgeProcessingFinished, true);
  assert.equal(after.canApplyToDatabase, true);
});

test('one permanent transcription failure does not keep the spinner forever', async () => {
  const { sessionId } = await sessionTranscribed();
  // Add a second, permanently-failed audio with no transcript.
  await sessionsService.uploadFiles(sessionId, [
    { filename: 'call-002.mp3', mimeType: 'audio/mpeg', data: Buffer.from('other-bytes') },
  ]);
  const db = getDatabase();
  const failedAudio = await db
    .select()
    .from(audioFiles)
    .where(eq(audioFiles.batchId, sessionId))
    .orderBy(audioFiles.id)
    .then((rows) => rows[rows.length - 1]);
  assert.ok(failedAudio);
  await db
    .update(audioFiles)
    .set({ status: 'FAILED', updatedAt: new Date() })
    .where(eq(audioFiles.id, failedAudio.id));

  const derived = (await sessionsService.getSession(sessionId)).derived;
  assert.equal(derived.isTranscribing, false);
  assert.equal(derived.canStartProcessing, true, 'a valid transcript still allows processing');
});

// ---------------------------------------------------------------------------
// Deletion regression
// ---------------------------------------------------------------------------

test('deleting an uncommitted voice removes file, transcript, jobs and results', async () => {
  const { sessionId, audioId, transcriptId, audioPath } = await sessionTranscribed();
  await processTranscript(transcriptId, sessionId, new NoteGateway());

  assert.ok(existsSync(audioPath), 'physical file exists before delete');
  const result = await sessionsService.deleteVoice(sessionId, audioId);
  assert.equal(result.deleted, true);
  assert.equal(result.committed, false);

  const db = getDatabase();
  assert.equal(existsSync(audioPath), false, 'physical file removed');
  assert.equal(await db.select().from(audioFiles).where(eq(audioFiles.id, audioId)).get(), undefined);
  assert.equal(await db.select().from(transcripts).where(eq(transcripts.id, transcriptId)).get(), undefined);
  assert.equal((await db.select().from(noteProposals).where(eq(noteProposals.audioId, audioId))).length, 0);
  assert.equal((await db.select().from(voiceReports).where(eq(voiceReports.audioId, audioId))).length, 0);
  assert.equal((await db.select().from(jobs).where(eq(jobs.entityId, audioId))).length, 0);
});

test('deleting an uncommitted session removes all session artifacts', async () => {
  const { sessionId, transcriptId, audioPath } = await sessionTranscribed();
  await processTranscript(transcriptId, sessionId, new NoteGateway());

  await sessionsService.deleteSession(sessionId);
  const db = getDatabase();
  assert.equal(await db.select().from(batches).where(eq(batches.id, sessionId)).get(), undefined);
  assert.equal(await db.select().from(audioFiles).where(eq(audioFiles.batchId, sessionId)).get(), undefined);
  assert.equal(await db.select().from(transcripts).where(eq(transcripts.id, transcriptId)).get(), undefined);
  assert.equal(existsSync(audioPath), false);
});

test('deleting a committed session preserves destination notes', async () => {
  const { sessionId, transcriptId } = await sessionTranscribed();
  await processTranscript(transcriptId, sessionId, new NoteGateway());
  await sessionsService.commit(sessionId);

  const beforeNotes = await getDatabase().select().from(destinationNotes);
  assert.equal(beforeNotes.length, 1);

  const result = await sessionsService.deleteSession(sessionId);
  assert.equal(result.committed, true);

  const db = getDatabase();
  const batch = await db.select().from(batches).where(eq(batches.id, sessionId)).get();
  assert.ok(batch && batch.deletedAt !== null, 'committed session is soft-deleted');
  const afterNotes = await db.select().from(destinationNotes);
  assert.equal(afterNotes.length, 1, 'committed master notes survive session deletion');
});

test('deleting a destination removes its notes/logs but preserves shared audio and transcripts', async () => {
  const { sessionId, transcriptId, audioId } = await sessionTranscribed();
  await processTranscript(transcriptId, sessionId, new NoteGateway());
  await sessionsService.commit(sessionId);

  const dest = await getDatabase().select().from(destinations).get();
  assert.ok(dest);
  await destinationNotesService.deleteDestination(dest.id);

  const db = getDatabase();
  assert.equal(await db.select().from(destinations).where(eq(destinations.id, dest.id)).get(), undefined);
  assert.equal((await db.select().from(destinationNotes).where(eq(destinationNotes.destinationId, dest.id))).length, 0);
  assert.equal((await db.select().from(destinationNoteLogs).where(eq(destinationNoteLogs.destinationId, dest.id))).length, 0);
  assert.ok(await db.select().from(audioFiles).where(eq(audioFiles.id, audioId)).get(), 'audio preserved');
  assert.ok(await db.select().from(transcripts).where(eq(transcripts.id, transcriptId)).get(), 'transcript preserved');
});

// ---------------------------------------------------------------------------
// Source voice deduplication
// ---------------------------------------------------------------------------

test('one audio sourcing three notes appears once in the destination source list', async () => {
  const { sessionId, transcriptId } = await sessionTranscribed();
  const gateway = new NoteGateway(
    extraction({
      notes: [1, 2, 3].map((n) => ({
        title: `نکته مشهد ${n}`,
        description: `توضیح نکته ${n} درباره مشهد.`,
        destination: { name: 'مشهد', role: 'DESTINATION' },
        relevantDate: null,
      })),
    }),
  );
  await processTranscript(transcriptId, sessionId, gateway);
  await sessionsService.commit(sessionId);

  const dest = await getDatabase().select().from(destinations).get();
  assert.ok(dest);
  const sources = await destinationNotesService.listDestinationSourceVoices(dest.id);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.noteCount, 3);
});

test('one audio sourcing two destinations appears once in each destination', async () => {
  const { sessionId, transcriptId } = await sessionTranscribed();
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
  await processTranscript(transcriptId, sessionId, gateway);
  await sessionsService.commit(sessionId);

  const db = getDatabase();
  const mashhad = await db
    .select()
    .from(destinations)
    .where(eq(destinations.normalizedName, 'مشهد'))
    .get();
  const kish = await db
    .select()
    .from(destinations)
    .where(eq(destinations.normalizedName, 'کیش'))
    .get();
  assert.ok(mashhad && kish);
  assert.equal((await destinationNotesService.listDestinationSourceVoices(mashhad.id)).length, 1);
  assert.equal((await destinationNotesService.listDestinationSourceVoices(kish.id)).length, 1);
});

// ---------------------------------------------------------------------------
// No-knowledge UX
// ---------------------------------------------------------------------------

test('voice with zero useful notes → NO_USEFUL_KNOWLEDGE and no cards', async () => {
  const { sessionId, transcriptId } = await sessionTranscribed();
  await processTranscript(transcriptId, sessionId, new NoteGateway(extraction({ notes: [] })));

  const detail = await sessionsService.getSession(sessionId);
  assert.equal(detail.voices.length, 1);
  assert.equal(detail.voices[0]?.resultStatus, 'NO_USEFUL_KNOWLEDGE');
  assert.equal(detail.voices[0]?.notes.length, 0);
  assert.equal(detail.commitSummary.totalProposals, 0);
});

test('voice whose notes all repeat existing knowledge → NO_NEW_KNOWLEDGE', async () => {
  // First session commits the note.
  const first = await sessionTranscribed();
  await processTranscript(first.transcriptId, first.sessionId, new NoteGateway());
  await sessionsService.commit(first.sessionId);

  // Second session repeats the exact same title+description → NO_CHANGE.
  const second = await sessionTranscribed();
  await processTranscript(second.transcriptId, second.sessionId, new NoteGateway());
  await sessionsService.commit(second.sessionId);

  const detail = await sessionsService.getSession(second.sessionId);
  assert.equal(detail.voices[0]?.resultStatus, 'NO_NEW_KNOWLEDGE');
  assert.equal(detail.voices[0]?.notes.length, 0, 'NO_CHANGE cards are hidden');
});

test('ADD + NO_CHANGE shows only the ADD card and counts only actionable', async () => {
  const first = await sessionTranscribed();
  await processTranscript(first.transcriptId, first.sessionId, new NoteGateway());
  await sessionsService.commit(first.sessionId);

  const second = await sessionTranscribed();
  const gateway = new NoteGateway(
    extraction({
      notes: [
        {
          title: 'فاصله هتل تا حرم',
          description: 'هتل پارس حدود پنج دقیقه با حرم فاصله دارد.',
          destination: { name: 'مشهد', role: 'DESTINATION' },
          relevantDate: null,
        },
        {
          title: 'پرواز مستقیم',
          description: 'برای این مسیر پرواز مستقیم وجود دارد.',
          destination: { name: 'مشهد', role: 'DESTINATION' },
          relevantDate: null,
        },
      ],
    }),
  );
  await processTranscript(second.transcriptId, second.sessionId, gateway);

  const detail = await sessionsService.getSession(second.sessionId);
  assert.equal(detail.voices[0]?.resultStatus, 'ACTIONABLE');
  assert.equal(detail.voices[0]?.notes.length, 1, 'only the ADD note is shown');
  assert.equal(detail.voices[0]?.notes[0]?.proposedAction, 'ADD');
  assert.equal(detail.commitSummary.totalProposals, 1);
  assert.equal(detail.commitSummary.noChangeCount, 1);
});

// ---------------------------------------------------------------------------
// Change-log reasons
// ---------------------------------------------------------------------------

test('commit writes grounded log reasons and hides them from the review card', async () => {
  const { sessionId, transcriptId } = await sessionTranscribed();
  await processTranscript(transcriptId, sessionId, new NoteGateway());
  const detail = await sessionsService.getSession(sessionId);
  const note = detail.voices[0]?.notes[0];
  assert.ok(note);
  assert.equal('reasonSummary' in note, false, 'reason is not exposed on the review card');

  await sessionsService.commit(sessionId);
  const logs = await getDatabase().select().from(destinationNoteLogs);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.eventType, 'NOTE_ADDED');
  assert.ok(logs[0]?.reason && logs[0].reason.length > 10, 'grounded, non-empty reason');
  assert.ok(logs[0]?.createdAt.getTime() > 0, 'backend timestamp');
});

test('NO_CHANGE creates no destination change-log event', async () => {
  const { sessionId, transcriptId } = await sessionTranscribed();
  await processTranscript(transcriptId, sessionId, new NoteGateway());
  await sessionsService.commit(sessionId);

  const db = getDatabase();
  const note = await db.select().from(destinationNotes).get();
  assert.ok(note);
  const before = (await db.select().from(destinationNoteLogs)).length;

  // Repeat the same note in a second session → NO_CHANGE → source link only.
  const second = await sessionTranscribed();
  await processTranscript(second.transcriptId, second.sessionId, new NoteGateway());
  await sessionsService.commit(second.sessionId);

  const after = (await db.select().from(destinationNoteLogs)).length;
  assert.equal(after, before, 'NO_CHANGE must not write a main log event');
  const sources = await db
    .select()
    .from(destinationNoteSources)
    .where(eq(destinationNoteSources.noteId, note.id));
  assert.equal(sources.length, 2, 'both voices attach as sources');
});

test('MARK_OUTDATED writes a NOTE_MARKED_OUTDATED log with a reason', async () => {
  const { sessionId, transcriptId } = await sessionTranscribed();
  await processTranscript(transcriptId, sessionId, new NoteGateway());
  await sessionsService.commit(sessionId);

  const db = getDatabase();
  const note = await db.select().from(destinationNotes).get();
  assert.ok(note);

  // Insert an outdated proposal manually and commit a fresh session.
  const second = await sessionTranscribed();
  await db
    .update(batches)
    .set({ sessionStage: 'REVIEW', status: 'COMPLETED' })
    .where(eq(batches.id, second.sessionId));
  const dest = await db.select().from(destinations).get();
  assert.ok(dest);
  await db.insert(noteProposals).values({
    batchId: second.sessionId,
    transcriptId: second.transcriptId,
    audioId: second.audioId,
    destinationId: dest.id,
    title: 'فاصله هتل تا حرم',
    description: 'این سرویس دیگر ارائه نمی‌شود.',
    relevantDate: null,
    proposedAction: 'MARK_OUTDATED',
    matchedNoteId: note.id,
    logReason: 'این نکته قدیمی شد چون در تماس جدید اعلام شد سرویس قبلی دیگر ارائه نمی‌شود.',
    status: 'PENDING',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await sessionsService.commit(second.sessionId);
  const logs = await getDatabase().select().from(destinationNoteLogs).orderBy(destinationNoteLogs.id);
  const outdated = logs.find((l) => l.eventType === 'NOTE_MARKED_OUTDATED');
  assert.ok(outdated);
  assert.ok(outdated.reason);
  const noteAfter = await db.select().from(destinationNotes).where(eq(destinationNotes.id, note.id)).get();
  assert.equal(noteAfter?.status, 'OUTDATED');
});
