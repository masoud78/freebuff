import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { eq } from 'drizzle-orm';
import type { GeminiUsage, NoteExtraction } from '@freebuff/contracts';
import { noteExtractionSchema } from '@freebuff/contracts';
import { closeDatabase, getDatabase, initDatabase } from '../core/database/index.js';
import {
  audioFiles,
  batches,
  destinationAudienceInsights,
  destinationInsightSources,
  destinationNoteLogs,
  destinationNotes,
  destinationNoteSources,
  destinationNoteVersions,
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
import { segmentTranscript } from './transcription/normalize.js';

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
  newsroomText = 'در این پردازش اطلاعات جدیدی ثبت شد.';

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
    return {
      stories: [{ headline: 'عنوان خبر', paragraphs: [this.newsroomText] }],
      usage: ZERO_USAGE,
      durationMs: 1,
    };
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
  dir = mkdtempSync(join(tmpdir(), 'freebuff-v3-test-'));
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

/** Run note extraction for a transcript with the given gateway output. */
async function processTranscript(transcriptId: number, sessionId: number, gateway: NoteGateway): Promise<void> {
  await sessionsService.startProcessing(sessionId);
  const job = await jobService.claimNextJob('NOTE_EXTRACTION');
  assert.ok(job);
  assert.equal(job.entityId, transcriptId);
  await noteExtractionService.processJob(job, gateway);
}

// ---------------------------------------------------------------------------
// Speaker roles (§60)
// ---------------------------------------------------------------------------

test('speaker turns are segmented into فروشنده/مشتری turns', () => {
  const text = 'فروشنده: برای چه تاریخی می‌خواین؟\nمشتری: حدود بیستم شهریور.\nفروشنده: چند نفر هستین؟\nمشتری: دو نفر.';
  const segments = segmentTranscript(text);
  assert.deepEqual(
    segments.map((s) => s.speaker),
    ['فروشنده', 'مشتری', 'فروشنده', 'مشتری'],
  );
  assert.equal(segments.length, 4);
  assert.equal(segments[1]?.text, 'حدود بیستم شهریور.');
});

// ---------------------------------------------------------------------------
// Origin/destination routing (§61)
// ---------------------------------------------------------------------------

test('"از تبریز برای مشهد" → Mashhad only, no Tabriz destination', async () => {
  const { sessionId, transcriptId } = await sessionTranscribed();
  const gateway = new NoteGateway(
    extraction({
      notes: [
        {
          title: 'فاصله هتل تا حرم',
          description: 'هتل پارس نزدیک حرم است.',
          destination: { name: 'مشهد', role: 'DESTINATION' },
          relevantDate: null,
          kind: 'DESTINATION_INFO',
          scopeType: 'DESTINATION',
          tourSubject: null,
        },
      ],
    }),
  );
  await processTranscript(transcriptId, sessionId, gateway);

  const rows = await getDatabase().select().from(destinations);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.canonicalName, 'مشهد');
  assert.ok(!rows.some((r) => r.canonicalName === 'تبریز'));
});

// ---------------------------------------------------------------------------
// Knowledge scope (§62) — four kinds route to the right place
// ---------------------------------------------------------------------------

test('TOUR_INFO / DESTINATION_INFO / TRAVELER_GUIDANCE become notes; AUDIENCE_INSIGHT becomes insight', async () => {
  const { sessionId, transcriptId } = await sessionTranscribed();
  const gateway = new NoteGateway(
    extraction({
      notes: [
        {
          title: 'مدت اقامت تور',
          description: 'تور آنتالیا ۵ شب اقامت دارد.',
          destination: { name: 'آنتالیا', role: 'DESTINATION' },
          relevantDate: null,
          kind: 'TOUR_INFO',
          scopeType: 'TOUR',
          tourSubject: 'تور آنتالیا از تبریز',
        },
        {
          title: 'دسترسی به فرودگاه',
          description: 'فرودگاه آنتالیا ۳۰ دقیقه با مرکز فاصله دارد.',
          destination: { name: 'آنتالیا', role: 'DESTINATION' },
          relevantDate: null,
          kind: 'DESTINATION_INFO',
          scopeType: 'DESTINATION',
          tourSubject: null,
        },
        {
          title: 'راهنمای انتخاب هتل',
          description: 'اگر نزدیکی به حرم مهم است، ورودی حرم هم مهم است.',
          destination: { name: 'مشهد', role: 'DESTINATION' },
          relevantDate: null,
          kind: 'TRAVELER_GUIDANCE',
          scopeType: 'DESTINATION',
          tourSubject: null,
        },
      ],
      audienceInsights: [
        {
          title: 'مسافر فاصله را بر اساس تجربه واقعی مسیر ارزیابی می‌کند',
          description: 'سوال‌های مشتری نشان می‌دهد عدد فاصله به‌تنهایی کافی نیست.',
          destination: { name: 'مشهد', role: 'DESTINATION' },
          inferenceBasis: 'مشتری چند بار درباره زمان پیاده‌روی و ورودی حرم پرسید.',
          confidence: 0.8,
          contentOpportunity: {
            title: 'فاصله هتل تا حرم را بر اساس کدام ورودی بررسی کنیم؟',
            reason: 'عدد فاصله برای تصمیم‌گیری مشتری کافی نبود.',
          },
        },
      ],
    }),
  );
  await processTranscript(transcriptId, sessionId, gateway);

  const proposals = await getDatabase().select().from(noteProposals);
  assert.equal(proposals.length, 3);
  const tour = proposals.find((p) => p.noteKind === 'TOUR_INFO');
  assert.ok(tour);
  assert.equal(tour.scopeType, 'TOUR');
  assert.equal(tour.tourSubject, 'تور آنتالیا از تبریز');

  const insights = await getDatabase().select().from(insightProposals);
  assert.equal(insights.length, 1);

  await sessionsService.commit(sessionId);

  const notes = await getDatabase().select().from(destinationNotes);
  assert.equal(notes.length, 3);
  assert.ok(notes.some((n) => n.noteKind === 'TRAVELER_GUIDANCE'));

  const masterInsights = await getDatabase().select().from(destinationAudienceInsights);
  assert.equal(masterInsights.length, 1);
  assert.equal(masterInsights[0]?.contentOpportunityTitle, 'فاصله هتل تا حرم را بر اساس کدام ورودی بررسی کنیم؟');
});

// ---------------------------------------------------------------------------
// Inference safety (§63)
// ---------------------------------------------------------------------------

test('an audience insight never creates a factual note and keeps its evidence basis', async () => {
  const { sessionId, transcriptId } = await sessionTranscribed();
  const gateway = new NoteGateway(
    extraction({
      audienceInsights: [
        {
          title: 'دغدغه تمیزی هتل',
          description: 'در این تماس مشتری چند بار درباره تمیزی هتل پرسید.',
          destination: { name: 'مشهد', role: 'DESTINATION' },
          inferenceBasis: 'مشتری سه بار درباره نظافت اتاق و سرویس بهداشتی سوال کرد.',
          confidence: 0.7,
          contentOpportunity: null,
        },
      ],
    }),
  );
  await processTranscript(transcriptId, sessionId, gateway);
  await sessionsService.commit(sessionId);

  const notes = await getDatabase().select().from(destinationNotes);
  assert.equal(notes.length, 0, 'insight must not mutate factual destination notes');

  const insights = await getDatabase().select().from(destinationAudienceInsights);
  assert.equal(insights.length, 1);
  assert.ok(insights[0]?.inferenceBasis.includes('نظافت'));
});

test('insight schema requires a traceable inference basis', () => {
  const invalid = noteExtractionSchema.safeParse({
    voiceReport: 'گزارش',
    conversationTopic: 'موضوع',
    notes: [],
    audienceInsights: [
      {
        title: 'دغدغه',
        description: 'توضیح',
        destination: { name: 'مشهد', role: 'DESTINATION' },
        inferenceBasis: '',
        confidence: 0.5,
        contentOpportunity: null,
      },
    ],
  });
  assert.equal(invalid.success, false, 'empty inferenceBasis must be rejected');
});

// ---------------------------------------------------------------------------
// Audience insight dedup (§47)
// ---------------------------------------------------------------------------

test('the same concern across two voices dedups to one insight with two sources', async () => {
  const insightOutput = {
    title: 'مسافر فاصله را بر اساس تجربه واقعی مسیر ارزیابی می‌کند',
    description: 'سوال‌های مشتری نشان می‌دهد عدد فاصله به‌تنهایی کافی نیست.',
    destination: { name: 'مشهد', role: 'DESTINATION' },
    inferenceBasis: 'مشتری چند بار درباره زمان پیاده‌روی و ورودی حرم پرسید.',
    confidence: 0.8,
    contentOpportunity: null,
  } as const;

  const first = await sessionTranscribed();
  await processTranscript(first.transcriptId, first.sessionId, new NoteGateway(extraction({ audienceInsights: [insightOutput] })));
  await sessionsService.commit(first.sessionId);

  const second = await sessionTranscribed();
  await processTranscript(second.transcriptId, second.sessionId, new NoteGateway(extraction({ audienceInsights: [insightOutput] })));
  await sessionsService.commit(second.sessionId);

  const insights = await getDatabase().select().from(destinationAudienceInsights);
  assert.equal(insights.length, 1, 'same concern must dedup to one insight');
  const sources = await getDatabase().select().from(destinationInsightSources);
  assert.equal(sources.length, 2, 'both voices attach as sources');
});

// ---------------------------------------------------------------------------
// Processing newsroom (§64-66)
// ---------------------------------------------------------------------------

test('existing knowledge only → newsroom reports no meaningful new information (reporter not called)', async () => {
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
  const gateway = new NoteGateway(extraction({ notes: [note] }));
  await processTranscript(second.transcriptId, second.sessionId, gateway);

  assert.equal(gateway.newsroomPayloads.length, 0, 'no Gemini call for a no-change newsroom');
  const news = await getDatabase()
    .select()
    .from(processingDestinationNews)
    .where(eq(processingDestinationNews.processingSessionId, second.sessionId));
  assert.equal(news.length, 1);
  assert.ok(news[0]?.content.includes('تازه یا تغییر معناداری'));
  assert.ok(!news[0]?.content.includes('صبحانه هتل X بوفه است'));
});

test('one ADD → newsroom payload contains the new note', async () => {
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
  await processTranscript(transcriptId, sessionId, gateway);

  assert.equal(gateway.newsroomPayloads.length, 1);
  assert.equal(gateway.newsroomPayloads[0]?.newNotes.length, 1);
  assert.equal(gateway.newsroomPayloads[0]?.newNotes[0]?.title, 'پرواز مستقیم');
});

test('one UPDATE → newsroom payload carries the previous and new description', async () => {
  const first = await sessionTranscribed();
  await processTranscript(
    first.transcriptId,
    first.sessionId,
    new NoteGateway(
      extraction({
        notes: [
          {
            title: 'فاصله هتل تا حرم',
            description: 'هتل پارس حدود پنج دقیقه با حرم فاصله دارد.',
            destination: { name: 'مشهد', role: 'DESTINATION' },
            relevantDate: null,
            kind: 'DESTINATION_INFO',
            scopeType: 'DESTINATION',
            tourSubject: null,
          },
        ],
      }),
    ),
  );
  await sessionsService.commit(first.sessionId);

  const second = await sessionTranscribed();
  const gateway = new NoteGateway(
    extraction({
      notes: [
        {
          title: 'فاصله هتل تا حرم',
          description: 'فاصله پیاده حدود هفت دقیقه است.',
          destination: { name: 'مشهد', role: 'DESTINATION' },
          relevantDate: null,
          kind: 'DESTINATION_INFO',
          scopeType: 'DESTINATION',
          tourSubject: null,
        },
      ],
    }),
  );
  await processTranscript(second.transcriptId, second.sessionId, gateway);

  assert.equal(gateway.newsroomPayloads.length, 1);
  const payload = gateway.newsroomPayloads[0];
  assert.equal(payload?.updatedNotes.length, 1);
  assert.equal(payload?.updatedNotes[0]?.previousDescription, 'هتل پارس حدود پنج دقیقه با حرم فاصله دارد.');
  assert.equal(payload?.updatedNotes[0]?.newDescription, 'فاصله پیاده حدود هفت دقیقه است.');
});

test('one MARK_OUTDATED → newsroom payload carries the obsolete note', async () => {
  const first = await sessionTranscribed();
  await processTranscript(
    first.transcriptId,
    first.sessionId,
    new NoteGateway(
      extraction({
        notes: [
          {
            title: 'برنامه تور',
            description: 'این تور روزهای پنجشنبه برگزار می‌شود.',
            destination: { name: 'مشهد', role: 'DESTINATION' },
            relevantDate: null,
            kind: 'TOUR_INFO',
            scopeType: 'DESTINATION',
            tourSubject: null,
          },
        ],
      }),
    ),
  );
  await sessionsService.commit(first.sessionId);

  const db = getDatabase();
  const note = await db.select().from(destinationNotes).get();
  assert.ok(note);
  const dest = await db.select().from(destinations).get();
  assert.ok(dest);

  const second = await sessionTranscribed();
  await db
    .update(batches)
    .set({ sessionStage: 'REVIEW', status: 'COMPLETED' })
    .where(eq(batches.id, second.sessionId));
  await db.insert(noteProposals).values({
    batchId: second.sessionId,
    transcriptId: second.transcriptId,
    audioId: second.audioId,
    destinationId: dest.id,
    title: 'برنامه تور',
    description: 'برنامه پنجشنبه متوقف شده و تور فقط دوشنبه برگزار می‌شود.',
    relevantDate: null,
    noteKind: 'TOUR_INFO',
    scopeType: 'DESTINATION',
    tourSubject: null,
    proposedAction: 'MARK_OUTDATED',
    matchedNoteId: note.id,
    logReason: 'برنامه پنجشنبه متوقف شده است.',
    status: 'PENDING',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const gateway = new NoteGateway();
  await newsroomService.generateForSession(second.sessionId, gateway);

  assert.equal(gateway.newsroomPayloads.length, 1);
  assert.equal(gateway.newsroomPayloads[0]?.outdatedNotes.length, 1);
  assert.equal(gateway.newsroomPayloads[0]?.outdatedNotes[0]?.title, 'برنامه تور');
});

test('a new audience insight surfaces in the newsroom payload', async () => {
  const { sessionId, transcriptId } = await sessionTranscribed();
  const gateway = new NoteGateway(
    extraction({
      audienceInsights: [
        {
          title: 'مسافر فاصله را بر اساس تجربه واقعی مسیر ارزیابی می‌کند',
          description: 'عدد فاصله به‌تنهایی کافی نیست.',
          destination: { name: 'مشهد', role: 'DESTINATION' },
          inferenceBasis: 'مشتری چند بار درباره زمان پیاده‌روی پرسید.',
          confidence: 0.8,
          contentOpportunity: { title: 'فاصله واقعی هتل تا حرم', reason: 'عدد فاصله کافی نبود.' },
        },
      ],
    }),
  );
  await processTranscript(transcriptId, sessionId, gateway);

  assert.equal(gateway.newsroomPayloads.length, 1);
  assert.equal(gateway.newsroomPayloads[0]?.newInsights.length, 1);
  assert.equal(gateway.newsroomPayloads[0]?.newInsights[0]?.contentOpportunityTitle, 'فاصله واقعی هتل تا حرم');
});

test('multi-destination processing produces one newsroom per destination', async () => {
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

  assert.equal(gateway.newsroomPayloads.length, 2);
  const destinationNames = gateway.newsroomPayloads.map((p) => p.destination);
  assert.ok(destinationNames.includes('مشهد'));
  assert.ok(destinationNames.includes('کیش'));

  const news = await getDatabase().select().from(processingDestinationNews);
  assert.equal(news.length, 2);
});

// ---------------------------------------------------------------------------
// Destination page exposes insights separately from notes
// ---------------------------------------------------------------------------

test('destination detail returns insights separately from factual notes', async () => {
  const { sessionId, transcriptId } = await sessionTranscribed();
  const gateway = new NoteGateway(
    extraction({
      notes: [
        {
          title: 'نکته مقصد',
          description: 'اطلاعات مشهد',
          destination: { name: 'مشهد', role: 'DESTINATION' },
          relevantDate: null,
          kind: 'DESTINATION_INFO',
          scopeType: 'DESTINATION',
          tourSubject: null,
        },
      ],
      audienceInsights: [
        {
          title: 'دغدغه مشتری',
          description: 'دغدغه واقعی مشتری',
          destination: { name: 'مشهد', role: 'DESTINATION' },
          inferenceBasis: 'شواهد تماس',
          confidence: 0.6,
          contentOpportunity: null,
        },
      ],
    }),
  );
  await processTranscript(transcriptId, sessionId, gateway);
  await sessionsService.commit(sessionId);

  const dest = await getDatabase().select().from(destinations).get();
  assert.ok(dest);
  const detail = await destinationNotesService.getDetail(dest.id, 'CURRENT');
  assert.ok(detail);
  assert.equal(detail.notes.length, 1);
  assert.equal(detail.insights.length, 1);
  assert.equal(detail.insights[0]?.title, 'دغدغه مشتری');
});
