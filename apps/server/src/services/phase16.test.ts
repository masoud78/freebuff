import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { eq } from 'drizzle-orm';
import type { GeminiUsage, NewsroomStory, NoteExtraction } from '@freebuff/contracts';
import { closeDatabase, getDatabase, initDatabase } from '../core/database/index.js';
import {
  audioFiles,
  batches,
  destinationNoteSources,
  destinationNotes,
  destinations,
  insightProposals,
  jobs,
  knowledgeAnalysisRuns,
  modelConfigs,
  noteProposals,
  processingDestinationNews,
  transcripts,
  transcriptSegments,
  voiceReports,
  destinationInsightSources,
  destinationAudienceInsights,
  destinationNoteLogs,
  destinationNoteVersions,
} from '../core/database/schema.js';
import { credentialStore } from './gemini/credentials.store.js';
import { GeminiGatewayError, type GeminiGatewayLike, type NewsroomPayload } from './gemini/gateway.js';
import { jobService } from './jobs.service.js';
import { destinationNotesService } from './destination-notes.service.js';
import { noteExtractionService } from './knowledge/note-extraction.service.js';
import { newsroomService } from './newsroom.service.js';
import { promptsService } from './prompts.service.js';
import { sessionsService } from './sessions.service.js';
import { settingsService } from './settings.service.js';

const MODEL_ID = 'gemini-2.5-flash';
const ZERO_USAGE: GeminiUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0 };

function extraction(overrides: Partial<NoteExtraction> = {}): NoteExtraction {
  return {
    voiceReport: 'این تماس درباره هتل نزدیک حرم بود.',
    conversationTopic: 'بررسی هتل‌های نزدیک حرم',
    notes: [],
    audienceInsights: [],
    ...overrides,
  };
}

class NoteGateway implements GeminiGatewayLike {
  newsroomPayloads: NewsroomPayload[] = [];
  newsroomStories: NewsroomStory[] = [{ headline: 'عنوان خبر', paragraphs: ['پاراگراف اول'] }];

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
      comparison: { decision: 'ADD' as const, matchedNoteId: 0, logReason: 'دلیل تست' },
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
  async generateNewsroom(input: { apiKey: string; modelId: string; payload: NewsroomPayload }) {
    this.newsroomPayloads.push(input.payload);
    return { stories: this.newsroomStories, noNewsReason: null, usage: ZERO_USAGE, durationMs: 1 };
  }
}

let dir: string;

async function configure(): Promise<void> {
  await settingsService.updateSettings({ workspacePath: dir, processingConcurrency: 2 });
  const db = getDatabase();
  const now = new Date();
  for (const stage of ['TRANSCRIPTION', 'KNOWLEDGE_PROCESSING'] as const) {
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
  await db.delete(processingDestinationNews);
  await db.delete(destinationInsightSources);
  await db.delete(destinationAudienceInsights);
  await db.delete(insightProposals);
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
  dir = mkdtempSync(join(tmpdir(), 'freebuff-v31-test-'));
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
async function sessionTranscribed(): Promise<{ sessionId: number; audioId: number; transcriptId: number }> {
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
  };
}

async function processTranscript(transcriptId: number, sessionId: number, gateway: NoteGateway): Promise<void> {
  await sessionsService.startProcessing(sessionId);
  const job = await jobService.claimNextJob('NOTE_EXTRACTION');
  assert.ok(job);
  assert.equal(job.entityId, transcriptId);
  await noteExtractionService.processJob(job, gateway);
}

// ---------------------------------------------------------------------------
// PART 2 — Lazy processing creation (§8-11)
// ---------------------------------------------------------------------------

test('createSessionWithFirstUpload persists nothing when no file is stored', async () => {
  await assert.rejects(
    sessionsService.createSessionWithFirstUpload([
      { filename: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('not audio') },
    ]),
  );
  const rows = await getDatabase().select().from(batches);
  assert.equal(rows.length, 0, 'no empty session may be created on a failed first upload');
});

test('createSessionWithFirstUpload persists the session on the first successful upload', async () => {
  const { session, upload } = await sessionsService.createSessionWithFirstUpload([
    { filename: 'call-001.mp3', mimeType: 'audio/mpeg', data: Buffer.from('audio-bytes') },
  ]);
  assert.equal(upload.registered, 1);
  const rows = await getDatabase().select().from(batches);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, session.id);
});

test('empty sessions are hidden from history but real sessions appear', async () => {
  const empty = await sessionsService.createSession();
  const real = await sessionsService.createSession();
  await sessionsService.uploadFiles(real.id, [
    { filename: 'call-002.mp3', mimeType: 'audio/mpeg', data: Buffer.from('audio-bytes-2') },
  ]);

  const list = await sessionsService.listSessions();
  assert.ok(!list.some((s) => s.id === empty.id), 'empty session must be hidden');
  assert.ok(list.some((s) => s.id === real.id), 'session with audio must be listed');
});

// ---------------------------------------------------------------------------
// PART 1 — Processing card destinations (§4-5, §61)
// ---------------------------------------------------------------------------

test('one audio producing three Mashhad notes yields a single deduplicated destination label', async () => {
  const { sessionId, transcriptId } = await sessionTranscribed();
  const notes = ['نکته یک', 'نکته دو', 'نکته سه'].map((title) => ({
    title,
    description: `${title} برای مشهد`,
    destination: { name: 'مشهد', role: 'DESTINATION' },
    relevantDate: null,
    kind: 'DESTINATION_INFO',
    scopeType: 'DESTINATION',
    tourSubject: null,
  }));
  await processTranscript(transcriptId, sessionId, new NoteGateway(extraction({ notes: notes as NoteExtraction['notes'] })));

  const list = await sessionsService.listSessions();
  const session = list.find((s) => s.id === sessionId);
  assert.ok(session);
  assert.equal(session.destinations.length, 1);
  assert.equal(session.destinations[0]?.name, 'مشهد');

  const detail = await sessionsService.getSession(sessionId);
  assert.equal(detail.destinations.length, 1);
});

test('Mashhad + Kish notes yield two deduplicated destination labels; origin never appears', async () => {
  const { sessionId, transcriptId } = await sessionTranscribed();
  await processTranscript(
    transcriptId,
    sessionId,
    new NoteGateway(
      extraction({
        notes: [
          {
            title: 'نکته مشهد',
            description: 'اطلاعات مشهد',
            destination: { name: 'مشهد', role: 'DESTINATION' },
            relevantDate: null,
            kind: 'DESTINATION_INFO',
            scopeType: 'DESTINATION',
            tourSubject: null,
          },
          {
            title: 'نکته کیش',
            description: 'اطلاعات کیش',
            destination: { name: 'کیش', role: 'DESTINATION' },
            relevantDate: null,
            kind: 'DESTINATION_INFO',
            scopeType: 'DESTINATION',
            tourSubject: null,
          },
          {
            title: 'نکته مبدا',
            description: 'از تبریز تماس گرفته شد.',
            destination: { name: 'تبریز', role: 'ORIGIN' },
            relevantDate: null,
            kind: 'DESTINATION_INFO',
            scopeType: 'DESTINATION',
            tourSubject: null,
          },
        ],
      }),
    ),
  );

  const list = await sessionsService.listSessions();
  const session = list.find((s) => s.id === sessionId);
  assert.ok(session);
  const names = session.destinations.map((d) => d.name);
  assert.ok(names.includes('مشهد'));
  assert.ok(names.includes('کیش'));
  assert.ok(!names.includes('تبریز'), 'origin must never appear as a destination label');
  assert.equal(names.length, 2);
});

// ---------------------------------------------------------------------------
// PART 3 — Full destination knowledge (§12-20, §62)
// ---------------------------------------------------------------------------

test('a long note description is returned and persisted in full (never truncated)', async () => {
  const { sessionId, transcriptId } = await sessionTranscribed();
  const longDescription =
    'برای انتخاب هتل نزدیک حرم، فقط فاصله عددی کافی نیست. '.repeat(12).trim();
  assert.ok(longDescription.length > 500, 'test description must be long');
  await processTranscript(
    transcriptId,
    sessionId,
    new NoteGateway(
      extraction({
        notes: [
          {
            title: 'فاصله واقعی هتل تا حرم',
            description: longDescription,
            destination: { name: 'مشهد', role: 'DESTINATION' },
            relevantDate: null,
            kind: 'TRAVELER_GUIDANCE',
            scopeType: 'DESTINATION',
            tourSubject: null,
          },
        ],
      }),
    ),
  );
  await sessionsService.commit(sessionId);

  const dest = await getDatabase().select().from(destinations).get();
  assert.ok(dest);
  const detail = await destinationNotesService.getDetail(dest.id, 'CURRENT');
  assert.ok(detail);
  assert.equal(detail.notes.length, 1);
  assert.equal(detail.notes[0]?.description, longDescription);
});

test('one voice with four notes yields four complete notes in the source detail', async () => {
  const { sessionId, transcriptId } = await sessionTranscribed();
  const titles = ['نکته یک', 'نکته دو', 'نکته سه', 'نکته چهار'];
  await processTranscript(
    transcriptId,
    sessionId,
    new NoteGateway(
      extraction({
        notes: titles.map((title) => ({
          title,
          description: `توضیح کامل ${title}`,
          destination: { name: 'مشهد', role: 'DESTINATION' },
          relevantDate: null,
          kind: 'DESTINATION_INFO',
          scopeType: 'DESTINATION',
          tourSubject: null,
        })),
      }),
    ),
  );
  await sessionsService.commit(sessionId);

  const dest = await getDatabase().select().from(destinations).get();
  assert.ok(dest);
  const detail = await destinationNotesService.getDetail(dest.id, 'CURRENT');
  assert.ok(detail);
  assert.equal(detail.sources.length, 1, 'one voice appears once in the source list');
  assert.equal(detail.sources[0]?.noteCount, 4);

  const sourceNotes = await destinationNotesService.listSourceVoiceNotes(dest.id, transcriptId);
  assert.ok(sourceNotes);
  assert.equal(sourceNotes.notes.length, 4);
  for (const title of titles) {
    assert.ok(sourceNotes.notes.some((n) => n.title === title), `missing note ${title}`);
  }
});

// ---------------------------------------------------------------------------
// PART 4/5 — Newsroom structured stories (§42-43, §63-64)
// ---------------------------------------------------------------------------

test('reporter stories are stored and returned as structured H2+paragraphs', async () => {
  const { sessionId, transcriptId } = await sessionTranscribed();
  const gateway = new NoteGateway(
    extraction({
      notes: [
        {
          title: 'پرواز مستقیم',
          description: 'برای این مسیر پرواز مستقیم وجود دارد.',
          destination: { name: 'مشهد', role: 'DESTINATION' },
          relevantDate: null,
          kind: 'TOUR_INFO',
          scopeType: 'DESTINATION',
          tourSubject: null,
        },
      ],
    }),
  );
  gateway.newsroomStories = [
    { headline: 'مسیر جدیدی برای این تور معرفی شد', paragraphs: ['پاراگراف اول.', 'پاراگراف دوم.'] },
  ];
  await processTranscript(transcriptId, sessionId, gateway);

  const newsroom = await newsroomService.listForSession(sessionId);
  assert.equal(newsroom.length, 1);
  assert.equal(newsroom[0]?.stories.length, 1);
  assert.equal(newsroom[0]?.stories[0]?.headline, 'مسیر جدیدی برای این تور معرفی شد');
  assert.equal(newsroom[0]?.stories[0]?.paragraphs.length, 2);
});

test('NO_CHANGE only → no fake stories, plain no-news text', async () => {
  const first = await sessionTranscribed();
  const note = {
    title: 'صبحانه هتل',
    description: 'صبحانه هتل X بوفه است.',
    destination: { name: 'مشهد', role: 'DESTINATION' },
    relevantDate: null,
    kind: 'DESTINATION_INFO',
    scopeType: 'DESTINATION',
    tourSubject: null,
  } as const;
  await processTranscript(first.transcriptId, first.sessionId, new NoteGateway(extraction({ notes: [note] })));
  await sessionsService.commit(first.sessionId);

  const second = await sessionTranscribed();
  await processTranscript(second.transcriptId, second.sessionId, new NoteGateway(extraction({ notes: [note] })));

  const newsroom = await newsroomService.listForSession(second.sessionId);
  assert.equal(newsroom.length, 1);
  assert.equal(newsroom[0]?.stories.length, 0, 'no stories for NO_CHANGE only');
  assert.ok(newsroom[0]?.content.includes('نکتهٔ جدیدی برای این مقصد ثبت نشد'));
});

test('multi-destination newsroom keeps each destination isolated in its payload', async () => {
  const { sessionId, transcriptId } = await sessionTranscribed();
  const gateway = new NoteGateway(
    extraction({
      notes: [
        {
          title: 'نکته مشهد',
          description: 'اطلاعات مشهد',
          destination: { name: 'مشهد', role: 'DESTINATION' },
          relevantDate: null,
          kind: 'DESTINATION_INFO',
          scopeType: 'DESTINATION',
          tourSubject: null,
        },
        {
          title: 'نکته کیش',
          description: 'اطلاعات کیش',
          destination: { name: 'کیش', role: 'DESTINATION' },
          relevantDate: null,
          kind: 'DESTINATION_INFO',
          scopeType: 'DESTINATION',
          tourSubject: null,
        },
      ],
    }),
  );
  await processTranscript(transcriptId, sessionId, gateway);

  const mashhadPayload = gateway.newsroomPayloads.find((p) => p.destination === 'مشهد');
  const kishPayload = gateway.newsroomPayloads.find((p) => p.destination === 'کیش');
  assert.ok(mashhadPayload);
  assert.ok(kishPayload);
  assert.ok(mashhadPayload.newNotes.some((n) => n.title === 'نکته مشهد'));
  assert.ok(!mashhadPayload.newNotes.some((n) => n.title === 'نکته کیش'));
  assert.ok(kishPayload.newNotes.some((n) => n.title === 'نکته کیش'));
  assert.ok(!kishPayload.newNotes.some((n) => n.title === 'نکته مشهد'));
});
