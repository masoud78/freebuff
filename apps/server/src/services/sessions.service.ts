import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { extname, join } from 'node:path';
import type {
  CommitResponse,
  CommitSummary,
  DestinationListItem,
  ProcessingResultStatus,
  ProcessedVoice,
  SessionAudioItem,
  SessionDerivedState,
  SessionDetail,
  SessionStage,
  SessionSummary,
} from '@freebuff/contracts';
import { SUPPORTED_AUDIO_EXTENSIONS } from '@freebuff/contracts';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDatabase } from '../core/database/client.js';
import type { DbExecutor } from './jobs.service.js';
import {
  apiUsage,
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
  noteProposals,
  transcriptSegments,
  transcripts,
  voiceReports,
} from '../core/database/schema.js';
import { newsroomService } from './newsroom.service.js';
import { DomainError } from './errors.js';
import { credentialStore } from './gemini/credentials.store.js';
import { jobService } from './jobs.service.js';
import { modelsService } from './models.service.js';
import { promptsService } from './prompts.service.js';
import { getWorkspaceAudioDir } from './workspace-paths.js';
import { audioIngestionService } from './audio-ingestion.service.js';

const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
};

const SUPPORTED_SET = new Set<string>(SUPPORTED_AUDIO_EXTENSIONS);

export interface UploadedFile {
  filename: string;
  mimeType: string;
  data: Buffer;
}

export interface UploadResult {
  sessionId: number;
  registered: number;
  duplicates: number;
  unsupported: number;
}

function queueStateFor(status: string): SessionAudioItem['queueState'] {
  switch (status) {
    case 'DUPLICATE':
      return 'تکراری';
    case 'FAILED':
      return 'خطا';
    case 'TRANSCRIBED':
      return 'تکمیل شد';
    case 'TRANSCRIBING':
      return 'در حال انجام';
    case 'QUEUED':
    case 'REGISTERED':
      return 'در صف';
    default:
      return null;
  }
}

/**
 * Processing sessions — the simplified, user-facing product flow.
 *
 *   UPLOAD → (user clicks transcribe) → TRANSCRIBE → (user clicks process)
 *   → PROCESS → REVIEW → (user clicks apply) → NEWSROOM (stage 5)
 *
 * The backend still uses `batches` as the processing boundary and the SQLite
 * job engine for transcription and note extraction; the user never sees any
 * of that. No stage auto-advances into the next without an explicit action.
 */
export class SessionsService {
  async createSession(): Promise<SessionSummary> {
    const db = getDatabase();
    const now = new Date();
    const inserted = await db
      .insert(batches)
      .values({ status: 'READY', sessionStage: 'UPLOAD', createdAt: now, updatedAt: now })
      .returning({ id: batches.id });
    const id = inserted[0]?.id;
    if (id === undefined) {
      throw new DomainError('DATABASE_ERROR', 'ایجاد جلسه پردازش ممکن نشد.');
    }
    return {
      id,
      stage: 'UPLOAD',
      createdAt: now.toISOString(),
      totalAudio: 0,
      transcribed: 0,
      processed: 0,
      destinations: [],
    };
  }

  /**
   * Lazy processing creation: a session is only persisted once the first audio
   * is actually stored. If every file is unsupported/duplicate (nothing new
   * stored), the just-created batch is rolled back so no empty session enters
   * history.
   */
  async createSessionWithFirstUpload(
    files: UploadedFile[],
  ): Promise<{ session: SessionSummary; upload: UploadResult }> {
    const session = await this.createSession();
    const upload = await this.uploadFiles(session.id, files);
    if (upload.registered + upload.duplicates === 0) {
      // Nothing was stored — remove the empty batch and report failure.
      await getDatabase().delete(batches).where(eq(batches.id, session.id));
      throw new DomainError(
        'AUDIO_FORMAT_UNSUPPORTED',
        'هیچ فایل صوتی قابل استفاده‌ای آپلود نشد. فرمت فایل را بررسی کنید.',
      );
    }
    return { session, upload };
  }

  /** Save uploaded files into `{workspace}/audio/{sessionId}/` and register them. */
  async uploadFiles(sessionId: number, files: UploadedFile[]): Promise<UploadResult> {
    const batch = await this.requireBatch(sessionId);
    if (batch.sessionStage === 'COMMITTED' || batch.sessionStage === 'NEWSROOM') {
      throw new DomainError('BATCH_NOT_STARTABLE', 'این جلسه پردازش قبلاً نهایی شده است.');
    }
    const audioDir = join(await getWorkspaceAudioDir(), String(sessionId));
    await fs.mkdir(audioDir, { recursive: true });

    const db = getDatabase();
    let registered = 0;
    let duplicates = 0;
    let unsupported = 0;

    for (const file of files) {
      const extension = extname(file.filename).toLowerCase();
      if (!SUPPORTED_SET.has(extension)) {
        unsupported += 1;
        continue;
      }
      const sha256 = createHash('sha256').update(file.data).digest('hex');

      // Already registered in this session (same content) — idempotent upload.
      const inSession = await db
        .select({ id: audioFiles.id })
        .from(audioFiles)
        .where(
          and(
            eq(audioFiles.batchId, sessionId),
            eq(audioFiles.sha256, sha256),
            isNull(audioFiles.deletedAt),
          ),
        )
        .get();
      if (inSession) continue;

      const absolutePath = join(audioDir, file.filename);
      await fs.writeFile(absolutePath, file.data);

      const duplicateOf = await audioIngestionService.detectDuplicate(sha256);
      if (duplicateOf !== null) {
        await audioIngestionService.insertAudio({
          batchId: sessionId,
          absolutePath,
          originalName: file.filename,
          extension,
          mimeType: MIME_BY_EXT[extension] ?? file.mimeType ?? 'application/octet-stream',
          fileSize: file.data.length,
          sha256,
          status: 'DUPLICATE',
          duplicateOfAudioId: duplicateOf,
        });
        duplicates += 1;
        continue;
      }

      await audioIngestionService.insertAudio({
        batchId: sessionId,
        absolutePath,
        originalName: file.filename,
        extension,
        mimeType: MIME_BY_EXT[extension] ?? file.mimeType ?? 'application/octet-stream',
        fileSize: file.data.length,
        sha256,
        status: 'REGISTERED',
      });
      registered += 1;
    }

    return { sessionId, registered, duplicates, unsupported };
  }

  /** User clicks «تبدیل همه به متن» — queue transcription jobs only. */
  async startTranscription(sessionId: number): Promise<SessionDetail> {
    const batch = await this.requireBatch(sessionId);
    if (batch.sessionStage !== 'UPLOAD') {
      throw new DomainError('BATCH_NOT_STARTABLE', 'این مرحله در وضعیت فعلی جلسه قابل اجرا نیست.');
    }

    const apiKey = await credentialStore.getKey();
    if (!apiKey) throw new DomainError('PIPELINE_NOT_READY', 'ابتدا کلید Gemini را در تنظیمات وارد کنید.');
    const modelId = await modelsService.getConfiguredModelId('TRANSCRIPTION');
    if (!modelId) throw new DomainError('PIPELINE_NOT_READY', 'مدل تبدیل ویس به متن انتخاب نشده است.');
    const transcriptionQuota = await modelsService.getConfiguredModelQuota('TRANSCRIPTION');
    if (transcriptionQuota?.quotaStatus === 'exhausted') {
      throw new DomainError(
        'GEMINI_QUOTA_EXHAUSTED',
        'سهمیه مدل تبدیل ویس به متن تمام شده است. در بخش «مدل‌ها» مدل دیگری انتخاب کنید.',
      );
    }
    const prompt = await promptsService.getActiveVersion('TRANSCRIPTION');
    if (!prompt) throw new DomainError('PIPELINE_NOT_READY', 'پرامپت تبدیل ویس به متن تنظیم نشده است.');

    const db = getDatabase();
    const rows = await db
      .select({ id: audioFiles.id })
      .from(audioFiles)
      .where(
        and(
          eq(audioFiles.batchId, sessionId),
          eq(audioFiles.status, 'REGISTERED'),
          isNull(audioFiles.deletedAt),
        ),
      )
      .orderBy(audioFiles.id);
    if (rows.length === 0) {
      throw new DomainError('BATCH_NOT_STARTABLE', 'هنوز فایل صوتی جدیدی آپلود نشده است.');
    }

    for (const row of rows) {
      await jobService.createJob({
        batchId: sessionId,
        jobType: 'TRANSCRIPTION',
        entityId: row.id,
        idempotencyKey: `TRANSCRIPTION:${row.id}`,
      });
      await db
        .update(audioFiles)
        .set({ status: 'QUEUED', updatedAt: new Date() })
        .where(eq(audioFiles.id, row.id));
    }

    await db
      .update(batches)
      .set({ status: 'PROCESSING', sessionStage: 'TRANSCRIBE', startedAt: new Date(), updatedAt: new Date() })
      .where(eq(batches.id, sessionId));

    return this.getSession(sessionId);
  }

  /** Re-queue one permanently failed audio for transcription. */
  async retryTranscription(sessionId: number, audioId: number): Promise<SessionDetail> {
    const batch = await this.requireBatch(sessionId);
    if (batch.sessionStage === 'COMMITTED' || batch.sessionStage === 'NEWSROOM') {
      throw new DomainError('BATCH_NOT_STARTABLE', 'این جلسه پردازش قبلاً نهایی شده است.');
    }
    const db = getDatabase();
    const audio = await db
      .select()
      .from(audioFiles)
      .where(and(eq(audioFiles.id, audioId), eq(audioFiles.batchId, sessionId), isNull(audioFiles.deletedAt)))
      .get();
    if (!audio) throw new DomainError('AUDIO_FILE_NOT_FOUND', 'ویس پیدا نشد.');
    if (audio.status !== 'FAILED') {
      throw new DomainError('BATCH_NOT_STARTABLE', 'فقط ویس‌های دارای خطا را می‌توان دوباره امتحان کرد.');
    }

    await db
      .update(audioFiles)
      .set({ status: 'QUEUED', updatedAt: new Date() })
      .where(eq(audioFiles.id, audioId));
    const job = await jobService.createJob({
      batchId: sessionId,
      jobType: 'TRANSCRIPTION',
      entityId: audioId,
      idempotencyKey: `TRANSCRIPTION:${audioId}`,
    });
    if (!job.created) {
      await jobService.requeueJob(`TRANSCRIPTION:${audioId}`);
    }
    await db
      .update(batches)
      .set({ status: 'PROCESSING', sessionStage: 'TRANSCRIBE', updatedAt: new Date() })
      .where(eq(batches.id, sessionId));

    return this.getSession(sessionId);
  }

  /** User clicks «رفتن برای پردازش» — queue note-extraction jobs only. */
  async startProcessing(sessionId: number): Promise<SessionDetail> {
    const batch = await this.requireBatch(sessionId);
    if (batch.sessionStage !== 'PROCESS' && batch.sessionStage !== 'TRANSCRIBE') {
      throw new DomainError('BATCH_NOT_STARTABLE', 'ابتدا تبدیل ویس‌ها به متن باید تمام شود.');
    }

    const apiKey = await credentialStore.getKey();
    if (!apiKey) throw new DomainError('PIPELINE_NOT_READY', 'ابتدا کلید Gemini را در تنظیمات وارد کنید.');
    const modelId = await modelsService.getConfiguredModelId('KNOWLEDGE_PROCESSING');
    if (!modelId) throw new DomainError('PIPELINE_NOT_READY', 'مدل پردازش و استخراج نکات انتخاب نشده است.');
    const prompt = await promptsService.getActiveVersion('KNOWLEDGE_PROCESSING');
    if (!prompt) throw new DomainError('PIPELINE_NOT_READY', 'پرامپت پردازش تنظیم نشده است.');

    const db = getDatabase();
    const ready = await db
      .select({ id: transcripts.id })
      .from(transcripts)
      .innerJoin(audioFiles, eq(audioFiles.id, transcripts.audioId))
      .where(
        and(
          eq(audioFiles.batchId, sessionId),
          eq(transcripts.status, 'COMPLETED'),
          isNull(transcripts.duplicateOfTranscriptId),
          isNull(audioFiles.deletedAt),
        ),
      );
    if (ready.length === 0) {
      throw new DomainError('BATCH_NOT_STARTABLE', 'هنوز هیچ Transcript آماده‌ای وجود ندارد.');
    }

    // Re-queue a previously FAILED note-extraction job instead of silently
    // doing nothing on a second click (the idempotency key would otherwise
    // match the dead job and block a retry forever).
    const failedJobs = await db
      .select({ idempotencyKey: jobs.idempotencyKey })
      .from(jobs)
      .where(
        and(
          eq(jobs.batchId, sessionId),
          eq(jobs.jobType, 'NOTE_EXTRACTION'),
          eq(jobs.status, 'FAILED'),
        ),
      );
    for (const failed of failedJobs) {
      await jobService.requeueJob(failed.idempotencyKey);
    }

    for (const row of ready) {
      await jobService.createJob({
        batchId: sessionId,
        jobType: 'NOTE_EXTRACTION',
        entityId: row.id,
        idempotencyKey: `NOTE_EXTRACTION:${row.id}`,
      });
    }

    await db
      .update(batches)
      .set({ status: 'PROCESSING', sessionStage: 'PROCESS', updatedAt: new Date() })
      .where(eq(batches.id, sessionId));

    // If a previous run already finished every job (e.g. a race between the
    // last worker tick and a second button click), immediately settle the
    // stage instead of leaving the session stuck in PROCESS.
    await this.advanceStageIfTerminal(sessionId);

    return this.getSession(sessionId);
  }

  /**
   * Apply all PENDING proposals to the destination database, transactionally
   * and idempotently. NO_CHANGE only links the source; every other action
   * writes a version, source and a change-log event. The log reason is
   * backend-generated from real data — never exposed in the review UI.
   */
  async commit(sessionId: number): Promise<CommitResponse> {
    const batch = await this.requireBatch(sessionId);
    if (batch.sessionStage !== 'REVIEW') {
      throw new DomainError('BATCH_NOT_STARTABLE', 'هنوز پردازش کامل نشده است یا تغییرات قبلاً اعمال شده‌اند.');
    }
    const db = getDatabase();
    const pending = await db
      .select()
      .from(noteProposals)
      .where(and(eq(noteProposals.batchId, sessionId), eq(noteProposals.status, 'PENDING')))
      .orderBy(noteProposals.id);
    const pendingInsights = await db
      .select()
      .from(insightProposals)
      .where(and(eq(insightProposals.batchId, sessionId), eq(insightProposals.status, 'PENDING')))
      .orderBy(insightProposals.id);

    const audioNameById = new Map<number, string>();
    const audioRows = await db
      .select({ id: audioFiles.id, originalName: audioFiles.originalName })
      .from(audioFiles)
      .where(eq(audioFiles.batchId, sessionId));
    for (const row of audioRows) audioNameById.set(row.id, row.originalName);

    const touchedDestinations = new Set<number>();
    let applied = 0;
    await db.transaction(async (tx) => {
      for (const proposal of pending) {
        if (proposal.destinationId === null) continue;
        touchedDestinations.add(proposal.destinationId);
        const now = new Date();
        const sourceAudioIds = [proposal.audioId];
        const audioName = audioNameById.get(proposal.audioId) ?? null;

        if (proposal.proposedAction === 'ADD') {
          const note = await tx
            .insert(destinationNotes)
            .values({
              destinationId: proposal.destinationId,
              currentTitle: proposal.title,
              currentDescription: proposal.description,
              noteKind: proposal.noteKind,
              scopeType: proposal.scopeType,
              tourSubject: proposal.tourSubject,
              status: 'CURRENT',
              relevantDate: proposal.relevantDate,
              firstObservedAt: now,
              lastUpdatedAt: now,
              createdAt: now,
              updatedAt: now,
            })
            .returning({ id: destinationNotes.id });
          const noteId = note[0]?.id;
          if (noteId === undefined) throw new DomainError('KNOWLEDGE_TRANSACTION_FAILED', 'ایجاد نکته ممکن نشد.');
          const version = await tx
            .insert(destinationNoteVersions)
            .values({
              noteId,
              versionNumber: 1,
              title: proposal.title,
              description: proposal.description,
              relevantDate: proposal.relevantDate,
              sourceProcessingId: sessionId,
              createdAt: now,
            })
            .returning({ id: destinationNoteVersions.id });
          await this.insertSource(tx, {
            noteId,
            audioId: proposal.audioId,
            transcriptId: proposal.transcriptId,
            sessionId,
            audioName,
          });
          await tx.insert(destinationNoteLogs).values({
            destinationId: proposal.destinationId,
            noteId,
            eventType: 'NOTE_ADDED',
            sourceAudioIds: JSON.stringify(sourceAudioIds),
            sourceProcessingSession: sessionId,
            reason:
              proposal.logReason ??
              `این نکته («${proposal.title}») از ویس «${audioName ?? 'نامشخص'}» استخراج و به دیتابیس اضافه شد.`,
            oldVersionId: null,
            newVersionId: version[0]?.id ?? null,
            createdAt: now,
          });
          applied += 1;
        } else if (proposal.proposedAction === 'UPDATE' || proposal.proposedAction === 'MARK_OUTDATED' || proposal.proposedAction === 'NO_CHANGE') {
          const targetId = proposal.matchedNoteId ?? null;
          const target = targetId !== null
            ? await tx.select().from(destinationNotes).where(eq(destinationNotes.id, targetId)).get()
            : null;

          if (proposal.proposedAction === 'NO_CHANGE') {
            // Only attach the new source — no note mutation, no log event.
            if (target) {
              await this.insertSource(tx, {
                noteId: target.id,
                audioId: proposal.audioId,
                transcriptId: proposal.transcriptId,
                sessionId,
                audioName,
              });
            }
          } else if (proposal.proposedAction === 'MARK_OUTDATED') {
            if (!target) throw new DomainError('RECONCILIATION_TARGET_NOT_FOUND', 'نکته مقصد برای قدیمی‌شدن یافت نشد.');
            await tx
              .update(destinationNotes)
              .set({ status: 'OUTDATED', updatedAt: now })
              .where(eq(destinationNotes.id, target.id));
            await tx.insert(destinationNoteLogs).values({
              destinationId: proposal.destinationId,
              noteId: target.id,
              eventType: 'NOTE_MARKED_OUTDATED',
              sourceAudioIds: JSON.stringify(sourceAudioIds),
              sourceProcessingSession: sessionId,
              reason:
                proposal.logReason ??
                `اطلاعات جدید ویس «${audioName ?? 'نامشخص'}» نشان می‌دهد این نکته دیگر معتبر نیست.`,
              oldVersionId: null,
              newVersionId: null,
              createdAt: now,
            });
            applied += 1;
          } else {
            // UPDATE
            if (!target) throw new DomainError('RECONCILIATION_TARGET_NOT_FOUND', 'نکته مقصد برای به‌روزرسانی یافت نشد.');
            const current = await tx
              .select({ id: destinationNoteVersions.id, versionNumber: destinationNoteVersions.versionNumber })
              .from(destinationNoteVersions)
              .where(eq(destinationNoteVersions.noteId, target.id))
              .orderBy(desc(destinationNoteVersions.versionNumber))
              .limit(1)
              .get();
            const versionNumber = (current?.versionNumber ?? 0) + 1;
            const version = await tx
              .insert(destinationNoteVersions)
              .values({
                noteId: target.id,
                versionNumber,
                title: proposal.title,
                description: proposal.description,
                relevantDate: proposal.relevantDate,
                sourceProcessingId: sessionId,
                createdAt: now,
              })
              .returning({ id: destinationNoteVersions.id });
            await tx
              .update(destinationNotes)
              .set({
                currentTitle: proposal.title,
                currentDescription: proposal.description,
                noteKind: proposal.noteKind,
                scopeType: proposal.scopeType,
                tourSubject: proposal.tourSubject,
                relevantDate: proposal.relevantDate,
                status: 'CURRENT',
                lastUpdatedAt: now,
                updatedAt: now,
              })
              .where(eq(destinationNotes.id, target.id));
            await this.insertSource(tx, {
              noteId: target.id,
              audioId: proposal.audioId,
              transcriptId: proposal.transcriptId,
              sessionId,
              audioName,
            });
            await tx.insert(destinationNoteLogs).values({
              destinationId: proposal.destinationId,
              noteId: target.id,
              eventType: 'NOTE_UPDATED',
              sourceAudioIds: JSON.stringify(sourceAudioIds),
              sourceProcessingSession: sessionId,
              reason:
                proposal.logReason ??
                `این نکته («${proposal.title}») با اطلاعات جدید ویس «${audioName ?? 'نامشخص'}» به‌روزرسانی شد.`,
              oldVersionId: current?.id ?? null,
              newVersionId: version[0]?.id ?? null,
              createdAt: now,
            });
            applied += 1;
          }
        }

        await tx
          .update(noteProposals)
          .set({ status: 'COMMITTED', updatedAt: new Date() })
          .where(eq(noteProposals.id, proposal.id));
      }

      // Audience insights (ADD → new insight, MERGE → richer evidence, NO_CHANGE → source only).
      for (const insight of pendingInsights) {
        if (insight.destinationId === null) continue;
        touchedDestinations.add(insight.destinationId);
        const now = new Date();

        if (insight.proposedAction === 'ADD') {
          const created = await tx
            .insert(destinationAudienceInsights)
            .values({
              destinationId: insight.destinationId,
              title: insight.title,
              description: insight.description,
              inferenceBasis: insight.inferenceBasis,
              confidence: insight.confidence,
              contentOpportunityTitle: insight.contentOpportunityTitle,
              contentOpportunityReason: insight.contentOpportunityReason,
              status: 'CURRENT',
              firstObservedAt: now,
              lastUpdatedAt: now,
              createdAt: now,
              updatedAt: now,
            })
            .returning({ id: destinationAudienceInsights.id });
          const insightId = created[0]?.id;
          if (insightId === undefined) {
            throw new DomainError('KNOWLEDGE_TRANSACTION_FAILED', 'ایجاد Insight ممکن نشد.');
          }
          await this.insertInsightSource(tx, {
            insightId,
            audioId: insight.audioId,
            transcriptId: insight.transcriptId,
            sessionId,
            audioName: audioNameById.get(insight.audioId) ?? null,
            evidenceSummary: insight.inferenceBasis,
          });
        } else {
          const targetId = insight.matchedInsightId ?? null;
          const target =
            targetId !== null
              ? await tx
                  .select()
                  .from(destinationAudienceInsights)
                  .where(eq(destinationAudienceInsights.id, targetId))
                  .get()
              : null;
          if (target) {
            if (insight.proposedAction === 'MERGE') {
              await tx
                .update(destinationAudienceInsights)
                .set({
                  contentOpportunityTitle: target.contentOpportunityTitle ?? insight.contentOpportunityTitle,
                  contentOpportunityReason: target.contentOpportunityReason ?? insight.contentOpportunityReason,
                  lastUpdatedAt: now,
                  updatedAt: now,
                })
                .where(eq(destinationAudienceInsights.id, target.id));
            }
            await this.insertInsightSource(tx, {
              insightId: target.id,
              audioId: insight.audioId,
              transcriptId: insight.transcriptId,
              sessionId,
              audioName: audioNameById.get(insight.audioId) ?? null,
              evidenceSummary: insight.inferenceBasis,
            });
          }
        }

        await tx
          .update(insightProposals)
          .set({ status: 'COMMITTED', updatedAt: new Date() })
          .where(eq(insightProposals.id, insight.id));
      }
    });

    await db
      .update(batches)
      .set({ sessionStage: 'NEWSROOM', status: 'COMMITTED', completedAt: new Date(), updatedAt: new Date() })
      .where(eq(batches.id, sessionId));

    const destinationRows = await db
      .select({ id: destinations.id, name: destinations.canonicalName })
      .from(destinations)
      .where(inArray(destinations.id, [...touchedDestinations]));
    return {
      sessionId,
      applied,
      destinations: destinationRows.map((row) => ({ id: row.id, name: row.name })),
    };
  }

  /**
   * Delete one voice. Uncommitted voices are fully removed (physical file +
   * transcripts + results + jobs). Committed voices keep the transcript and
   * source relations for audit: the audio row is soft-deleted, the source's
   * filename is snapshotted and its audio FK is nulled. Master notes never
   * change.
   */
  async deleteVoice(sessionId: number, audioId: number): Promise<{ deleted: boolean; committed: boolean }> {
    const batch = await this.requireBatch(sessionId);
    const db = getDatabase();
    const audio = await db
      .select()
      .from(audioFiles)
      .where(and(eq(audioFiles.id, audioId), eq(audioFiles.batchId, sessionId)))
      .get();
    if (!audio) throw new DomainError('AUDIO_FILE_NOT_FOUND', 'ویس پیدا نشد.');

    const transcriptRows = await db
      .select({ id: transcripts.id })
      .from(transcripts)
      .where(eq(transcripts.audioId, audioId));
    const transcriptIds = transcriptRows.map((row) => row.id);

    const sourceRows = await db
      .select({ id: destinationNoteSources.id })
      .from(destinationNoteSources)
      .where(eq(destinationNoteSources.audioId, audioId));
    const committed =
      batch.sessionStage === 'COMMITTED' || batch.sessionStage === 'NEWSROOM' || sourceRows.length > 0;

    await jobService.cancelActiveByEntityIds([audioId]);

    await db.transaction(async (tx) => {
      if (committed) {
        // Snapshot the filename onto sources and null their audio FK.
        await tx
          .update(destinationNoteSources)
          .set({ audioId: null, audioNameSnapshot: audio.originalName })
          .where(eq(destinationNoteSources.audioId, audioId));
        await tx
          .update(destinationInsightSources)
          .set({ audioId: null, audioNameSnapshot: audio.originalName })
          .where(eq(destinationInsightSources.audioId, audioId));
        // Keep the audio row (transcript FK target) but soft-delete it.
        await tx
          .update(audioFiles)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(eq(audioFiles.id, audioId));
        await tx.delete(voiceReports).where(eq(voiceReports.audioId, audioId));
        await tx.delete(noteProposals).where(eq(noteProposals.audioId, audioId));
        await tx.delete(insightProposals).where(eq(insightProposals.audioId, audioId));
        if (transcriptIds.length > 0) {
          await tx.delete(knowledgeAnalysisRuns).where(inArray(knowledgeAnalysisRuns.transcriptId, transcriptIds));
        }
        await tx.delete(jobs).where(eq(jobs.entityId, audioId));
      } else {
        await tx.delete(noteProposals).where(eq(noteProposals.audioId, audioId));
        await tx.delete(insightProposals).where(eq(insightProposals.audioId, audioId));
        await tx.delete(voiceReports).where(eq(voiceReports.audioId, audioId));
        if (transcriptIds.length > 0) {
          await tx.delete(knowledgeAnalysisRuns).where(inArray(knowledgeAnalysisRuns.transcriptId, transcriptIds));
          await tx.delete(transcriptSegments).where(inArray(transcriptSegments.transcriptId, transcriptIds));
          await tx.delete(destinationNoteSources).where(inArray(destinationNoteSources.transcriptId, transcriptIds));
          await tx.delete(destinationInsightSources).where(inArray(destinationInsightSources.transcriptId, transcriptIds));
          await tx.delete(transcripts).where(eq(transcripts.audioId, audioId));
        }
        await tx.delete(jobs).where(eq(jobs.entityId, audioId));
        await tx.delete(apiUsage).where(eq(apiUsage.audioId, audioId));
        await tx.delete(audioFiles).where(eq(audioFiles.id, audioId));
      }
    });

    await this.removePhysical(audio.absolutePath);
    return { deleted: true, committed };
  }

  /**
   * Delete a whole processing session. Uncommitted sessions are fully removed.
   * Committed sessions preserve destination notes, versions, sources and logs;
   * transcripts stay (source FK) while audio rows are soft-deleted and their
   * filenames snapshotted onto sources.
   */
  async deleteSession(sessionId: number): Promise<{ deleted: boolean; committed: boolean }> {
    const batch = await this.requireBatch(sessionId);
    const db = getDatabase();

    const audioRows = await db.select().from(audioFiles).where(eq(audioFiles.batchId, sessionId));
    const audioIds = audioRows.map((row) => row.id);
    const transcriptRows = await db
      .select({ id: transcripts.id })
      .from(transcripts)
      .innerJoin(audioFiles, eq(audioFiles.id, transcripts.audioId))
      .where(eq(audioFiles.batchId, sessionId));
    const transcriptIds = transcriptRows.map((row) => row.id);

    const committedSource = await db
      .select({ id: destinationNoteSources.id })
      .from(destinationNoteSources)
      .where(eq(destinationNoteSources.processingSessionId, sessionId))
      .limit(1)
      .get();
    const committed =
      batch.sessionStage === 'COMMITTED' || batch.sessionStage === 'NEWSROOM' || committedSource !== undefined;

    await jobService.cancelActiveByEntityIds(audioIds);

    await db.transaction(async (tx) => {
      if (committed) {
        for (const audio of audioRows) {
          await tx
            .update(destinationNoteSources)
            .set({ audioId: null, audioNameSnapshot: audio.originalName })
            .where(eq(destinationNoteSources.audioId, audio.id));
          await tx
            .update(destinationInsightSources)
            .set({ audioId: null, audioNameSnapshot: audio.originalName })
            .where(eq(destinationInsightSources.audioId, audio.id));
          await tx
            .update(audioFiles)
            .set({ deletedAt: new Date(), updatedAt: new Date() })
            .where(eq(audioFiles.id, audio.id));
        }
        await tx.delete(voiceReports).where(inArray(voiceReports.audioId, audioIds.length > 0 ? audioIds : [-1]));
        await tx.delete(noteProposals).where(eq(noteProposals.batchId, sessionId));
        await tx.delete(insightProposals).where(eq(insightProposals.batchId, sessionId));
        if (transcriptIds.length > 0) {
          await tx.delete(knowledgeAnalysisRuns).where(inArray(knowledgeAnalysisRuns.transcriptId, transcriptIds));
        }
        await tx.delete(jobs).where(eq(jobs.batchId, sessionId));
      } else {
        await tx.delete(noteProposals).where(eq(noteProposals.batchId, sessionId));
        await tx.delete(insightProposals).where(eq(insightProposals.batchId, sessionId));
        await tx.delete(voiceReports).where(inArray(voiceReports.audioId, audioIds.length > 0 ? audioIds : [-1]));
        if (transcriptIds.length > 0) {
          await tx.delete(knowledgeAnalysisRuns).where(inArray(knowledgeAnalysisRuns.transcriptId, transcriptIds));
          await tx.delete(transcriptSegments).where(inArray(transcriptSegments.transcriptId, transcriptIds));
          await tx.delete(destinationNoteSources).where(inArray(destinationNoteSources.transcriptId, transcriptIds));
          await tx.delete(destinationInsightSources).where(inArray(destinationInsightSources.transcriptId, transcriptIds));
          await tx.delete(transcripts).where(inArray(transcripts.id, transcriptIds));
        }
        await tx.delete(jobs).where(eq(jobs.batchId, sessionId));
        await tx.delete(apiUsage).where(eq(apiUsage.batchId, sessionId));
        if (audioIds.length > 0) {
          await tx.delete(audioFiles).where(inArray(audioFiles.id, audioIds));
        }
      }
      if (committed) {
        // Committed audios keep their batch FK, so the batch is soft-deleted.
        await tx
          .update(batches)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(eq(batches.id, sessionId));
      } else {
        await tx.delete(batches).where(eq(batches.id, sessionId));
      }
    });

    for (const audio of audioRows) {
      await this.removePhysical(audio.absolutePath);
    }
    await this.removePhysicalDir(join(await getWorkspaceAudioDir(), String(sessionId)));

    return { deleted: true, committed };
  }

  /** Recompute the user-facing stage when jobs finish (never skips a step). */
  async advanceStageIfTerminal(sessionId: number): Promise<void> {
    const batch = await this.requireBatch(sessionId);
    const db = getDatabase();

    const countJobs = async (jobType: string): Promise<{ total: number; terminal: number }> => {
      const rows = await db
        .select({ status: jobs.status, count: sql<number>`count(${jobs.id})` })
        .from(jobs)
        .where(and(eq(jobs.batchId, sessionId), eq(jobs.jobType, jobType)))
        .groupBy(jobs.status);
      let total = 0;
      let terminal = 0;
      for (const row of rows) {
        const count = Number(row.count);
        total += count;
        if (row.status === 'COMPLETED' || row.status === 'FAILED' || row.status === 'CANCELLED') {
          terminal += count;
        }
      }
      return { total, terminal };
    };

    if (batch.sessionStage === 'TRANSCRIBE') {
      const t = await countJobs('TRANSCRIPTION');
      if (t.total > 0 && t.terminal === t.total) {
        await db
          .update(batches)
          .set({ sessionStage: 'PROCESS', status: 'TRANSCRIBED', updatedAt: new Date() })
          .where(eq(batches.id, sessionId));
      }
    } else if (batch.sessionStage === 'PROCESS') {
      const n = await countJobs('NOTE_EXTRACTION');
      if (n.total > 0 && n.terminal === n.total) {
        await db
          .update(batches)
          .set({ sessionStage: 'REVIEW', status: 'COMPLETED', updatedAt: new Date() })
          .where(eq(batches.id, sessionId));
      }
    }
  }

  async getSession(sessionId: number): Promise<SessionDetail> {
    const batch = await this.requireBatch(sessionId);
    const db = getDatabase();

    const audioRows = await db
      .select()
      .from(audioFiles)
      .where(and(eq(audioFiles.batchId, sessionId), isNull(audioFiles.deletedAt)))
      .orderBy(audioFiles.id);
    const transcriptRows = await db
      .select({ audioId: transcripts.audioId })
      .from(transcripts)
      .where(eq(transcripts.status, 'COMPLETED'));
    const transcriptAudioIds = new Set(transcriptRows.map((r) => r.audioId));

    // Precise failure reason per voice from its terminal failed job.
    const failedJobRows = await db
      .select({ entityId: jobs.entityId, errorMessage: jobs.errorMessage })
      .from(jobs)
      .where(and(eq(jobs.batchId, sessionId), eq(jobs.status, 'FAILED')));
    const errorByAudioId = new Map<number, string>();
    for (const row of failedJobRows) {
      if (row.errorMessage && !errorByAudioId.has(row.entityId)) {
        errorByAudioId.set(row.entityId, row.errorMessage);
      }
    }

    const audio: SessionAudioItem[] = audioRows.map((row) => ({
      id: row.id,
      fileName: row.originalName,
      size: row.fileSize,
      status: row.status as SessionAudioItem['status'],
      hasTranscript: transcriptAudioIds.has(row.id),
      queueState: queueStateFor(row.status),
      errorMessage: errorByAudioId.get(row.id) ?? null,
    }));

    // Clean transcripts exist (non-duplicate) for this session?
    const cleanTranscript = await db
      .select({ id: transcripts.id })
      .from(transcripts)
      .innerJoin(audioFiles, eq(audioFiles.id, transcripts.audioId))
      .where(
        and(
          eq(audioFiles.batchId, sessionId),
          eq(transcripts.status, 'COMPLETED'),
          isNull(transcripts.duplicateOfTranscriptId),
          isNull(audioFiles.deletedAt),
        ),
      )
      .limit(1)
      .get();

    // Voice reports + proposals grouped per audio.
    const reportRows = await db
      .select({
        audioId: voiceReports.audioId,
        report: voiceReports.report,
        conversationTopic: voiceReports.conversationTopic,
        resultStatus: voiceReports.resultStatus,
        fileName: audioFiles.originalName,
      })
      .from(voiceReports)
      .innerJoin(audioFiles, eq(audioFiles.id, voiceReports.audioId))
      .where(and(eq(audioFiles.batchId, sessionId), isNull(audioFiles.deletedAt)));
    const proposalRows = await db
      .select()
      .from(noteProposals)
      .where(eq(noteProposals.batchId, sessionId))
      .orderBy(noteProposals.id);
    const insightProposalRows = await db
      .select()
      .from(insightProposals)
      .where(eq(insightProposals.batchId, sessionId))
      .orderBy(insightProposals.id);
    const actionableInsightTotal = insightProposalRows.filter(
      (p) => p.status === 'PENDING' && p.proposedAction !== 'NO_CHANGE' && p.destinationId !== null,
    ).length;

    const destIds = [...new Set(proposalRows.map((p) => p.destinationId).filter((id): id is number => id !== null))];
    const destNameById = new Map<number, string>();
    if (destIds.length > 0) {
      const rows = await db
        .select({ id: destinations.id, canonicalName: destinations.canonicalName })
        .from(destinations)
        .where(inArray(destinations.id, destIds));
      for (const row of rows) destNameById.set(row.id, row.canonicalName);
    }

    const voices: ProcessedVoice[] = reportRows.map((row) => ({
      audioId: row.audioId,
      fileName: row.fileName,
      report: row.report,
      conversationTopic: row.conversationTopic,
      resultStatus: row.resultStatus as ProcessingResultStatus,
      hasTranscript: true,
      notes: proposalRows
        .filter((p) => p.audioId === row.audioId && p.proposedAction !== 'NO_CHANGE')
        .map((p) => ({
          id: p.id,
          destinationId: p.destinationId,
          destinationName: p.destinationId !== null ? (destNameById.get(p.destinationId) ?? null) : null,
          title: p.title,
          description: p.description,
          relevantDate: p.relevantDate,
          proposedAction: p.proposedAction as ProcessedVoice['notes'][number]['proposedAction'],
          matchedNoteId: p.matchedNoteId,
          kind: p.noteKind as ProcessedVoice['notes'][number]['kind'],
          scopeType: p.scopeType as ProcessedVoice['notes'][number]['scopeType'],
          tourSubject: p.tourSubject,
        })),
    }));

    // Commit summary grouped per destination/action (actionable only).
    const summaryByDest = new Map<number, { add: number; update: number; outdated: number; noChange: number }>();
    let actionableTotal = 0;
    let noChangeTotal = 0;
    for (const p of proposalRows) {
      if (p.status !== 'PENDING' || p.destinationId === null) continue;
      const entry = summaryByDest.get(p.destinationId) ?? { add: 0, update: 0, outdated: 0, noChange: 0 };
      if (p.proposedAction === 'ADD') {
        entry.add += 1;
        actionableTotal += 1;
      } else if (p.proposedAction === 'UPDATE') {
        entry.update += 1;
        actionableTotal += 1;
      } else if (p.proposedAction === 'MARK_OUTDATED') {
        entry.outdated += 1;
        actionableTotal += 1;
      } else if (p.proposedAction === 'NO_CHANGE') {
        entry.noChange += 1;
        noChangeTotal += 1;
      }
      summaryByDest.set(p.destinationId, entry);
    }
    const commitSummary: CommitSummary = {
      destinations: [...summaryByDest.entries()].map(([destinationId, entry]) => ({
        destinationId,
        destinationName: destNameById.get(destinationId) ?? null,
        addCount: entry.add,
        updateCount: entry.update,
        outdatedCount: entry.outdated,
        noChangeCount: entry.noChange,
      })),
      totalProposals: actionableTotal,
      noChangeCount: noChangeTotal,
      insightCount: actionableInsightTotal,
    };

    return {
      id: batch.id,
      stage: batch.sessionStage as SessionStage,
      createdAt: batch.createdAt.toISOString(),
      totalAudio: audio.length,
      transcribed: audio.filter((a) => a.hasTranscript).length,
      processed: reportRows.length,
      destinations: await this.listSessionDestinations(sessionId),
      audio,
      voices,
      commitSummary,
      newsroom: await newsroomService.listForSession(sessionId),
      newsroomReason: await this.computeNewsroomReason(sessionId),
      derived: await this.computeDerived(
        batch,
        audioRows,
        cleanTranscript !== undefined,
        actionableTotal,
        actionableInsightTotal,
      ),
    };
  }

  /**
   * Explain an empty processing newsroom instead of showing a generic "nothing"
   * box: no identified destination versus news that was generated but empty.
   */
  private async computeNewsroomReason(sessionId: number): Promise<string | null> {
    const newsroom = await newsroomService.listForSession(sessionId);
    if (newsroom.length > 0) return null;
    const destinations = await this.listSessionDestinations(sessionId);
    if (destinations.length === 0) {
      return 'هیچ مقصدی در این پردازش شناسایی نشد؛ به همین دلیل خبری تولید نشده است.';
    }
    return 'خبر این پردازش هنوز تولید نشده است. کمی صبر کنید یا پردازش را دوباره اجرا کنید.';
  }

  /** Stage-specific workflow state derived from real job/audio data. */
  private async computeDerived(
    batch: typeof batches.$inferSelect,
    audioRows: (typeof audioFiles.$inferSelect)[],
    hasCleanTranscript: boolean,
    actionableTotal: number,
    actionableInsightTotal: number,
  ): Promise<SessionDerivedState> {
    const db = getDatabase();
    const activeJobs = await db
      .select({ jobType: jobs.jobType, count: sql<number>`count(${jobs.id})` })
      .from(jobs)
      .where(and(eq(jobs.batchId, batch.id), inArray(jobs.status, ['PENDING', 'RUNNING'])))
      .groupBy(jobs.jobType);

    let transActive = 0;
    let noteActive = 0;
    for (const row of activeJobs) {
      const count = Number(row.count);
      if (row.jobType === 'TRANSCRIPTION') transActive += count;
      if (row.jobType === 'NOTE_EXTRACTION') noteActive += count;
    }

    const transcriptionStarted = batch.sessionStage !== 'UPLOAD';
    const allAudioTerminal = audioRows.every(
      (a) => a.status === 'TRANSCRIBED' || a.status === 'FAILED' || a.status === 'DUPLICATE',
    );

    const isTranscribing = transActive > 0;
    const transcriptionFinished = transcriptionStarted && allAudioTerminal && transActive === 0;
    const isKnowledgeProcessing = noteActive > 0;
    const knowledgeProcessingFinished =
      batch.sessionStage === 'REVIEW' || batch.sessionStage === 'COMMITTED' || batch.sessionStage === 'NEWSROOM';
    const canStartProcessing =
      hasCleanTranscript && transcriptionFinished && !isKnowledgeProcessing && !knowledgeProcessingFinished;
    const canApplyToDatabase =
      batch.sessionStage === 'REVIEW' && (actionableTotal > 0 || actionableInsightTotal > 0);

    // A quota-exhausted transcription model blocks the voice-to-text step.
    const transcriptionQuota = await modelsService.getConfiguredModelQuota('TRANSCRIPTION');
    const transcriptionBlockedReason =
      transcriptionQuota?.quotaStatus === 'exhausted'
        ? 'سهمیه مدل تبدیل ویس به متن تمام شده است. در بخش «مدل‌ها» مدل دیگری انتخاب کنید.'
        : null;

    return {
      isTranscribing,
      transcriptionFinished,
      canStartProcessing,
      isKnowledgeProcessing,
      knowledgeProcessingFinished,
      canApplyToDatabase,
      transcriptionBlockedReason,
    };
  }

  async listSessions(): Promise<SessionSummary[]> {
    const db = getDatabase();
    const rows = await db
      .select()
      .from(batches)
      .where(isNull(batches.deletedAt))
      .orderBy(desc(batches.id))
      .limit(50);
    const result: SessionSummary[] = [];
    for (const row of rows) {
      const audioCount = await db
        .select({ count: sql<number>`count(${audioFiles.id})` })
        .from(audioFiles)
        .where(and(eq(audioFiles.batchId, row.id), isNull(audioFiles.deletedAt)))
        .get();
      const totalAudio = Number(audioCount?.count ?? 0);
      // Empty legacy sessions are hidden from history (§11) but never deleted.
      if (totalAudio === 0) continue;

      const transcriptCount = await db
        .select({ count: sql<number>`count(${transcripts.id})` })
        .from(transcripts)
        .innerJoin(audioFiles, eq(audioFiles.id, transcripts.audioId))
        .where(
          and(
            eq(audioFiles.batchId, row.id),
            eq(transcripts.status, 'COMPLETED'),
            isNull(audioFiles.deletedAt),
          ),
        )
        .get();
      const reportCount = await db
        .select({ count: sql<number>`count(${voiceReports.id})` })
        .from(voiceReports)
        .innerJoin(audioFiles, eq(audioFiles.id, voiceReports.audioId))
        .where(and(eq(audioFiles.batchId, row.id), isNull(audioFiles.deletedAt)))
        .get();
      result.push({
        id: row.id,
        stage: row.sessionStage as SessionStage,
        createdAt: row.createdAt.toISOString(),
        totalAudio,
        transcribed: Number(transcriptCount?.count ?? 0),
        processed: Number(reportCount?.count ?? 0),
        destinations: await this.listSessionDestinations(row.id),
      });
    }
    return result;
  }

  /**
   * Real destinations a session actually identified (DESTINATION role only —
   * origins/transits never create rows, so they can't appear here). Deduped
   * by destination id.
   */
  private async listSessionDestinations(sessionId: number): Promise<{ id: number; name: string }[]> {
    const db = getDatabase();
    const noteDestIds = await db
      .selectDistinct({ destinationId: noteProposals.destinationId })
      .from(noteProposals)
      .where(and(eq(noteProposals.batchId, sessionId), sql`${noteProposals.destinationId} IS NOT NULL`));
    const insightDestIds = await db
      .selectDistinct({ destinationId: insightProposals.destinationId })
      .from(insightProposals)
      .where(and(eq(insightProposals.batchId, sessionId), sql`${insightProposals.destinationId} IS NOT NULL`));
    const ids = [
      ...new Set(
        [...noteDestIds, ...insightDestIds]
          .map((r) => r.destinationId)
          .filter((id): id is number => id !== null),
      ),
    ];
    if (ids.length === 0) return [];
    const rows = await db
      .select({ id: destinations.id, name: destinations.canonicalName })
      .from(destinations)
      .where(inArray(destinations.id, ids))
      .orderBy(destinations.canonicalName);
    return rows.map((r) => ({ id: r.id, name: r.name }));
  }

  /** Simplified destination list (notes-based, no legacy knowledge counts). */
  async listDestinations(): Promise<DestinationListItem[]> {
    const db = getDatabase();
    const rows = await db.select().from(destinations).orderBy(destinations.canonicalName);
    const noteRows = await db
      .select({
        destinationId: destinationNotes.destinationId,
        status: destinationNotes.status,
        lastUpdatedAt: destinationNotes.lastUpdatedAt,
      })
      .from(destinationNotes);
    const currentByDest = new Map<number, number>();
    const outdatedByDest = new Map<number, number>();
    const latestByDest = new Map<number, number>();
    for (const note of noteRows) {
      currentByDest.set(note.destinationId, (currentByDest.get(note.destinationId) ?? 0) + (note.status === 'CURRENT' ? 1 : 0));
      outdatedByDest.set(note.destinationId, (outdatedByDest.get(note.destinationId) ?? 0) + (note.status === 'OUTDATED' ? 1 : 0));
      const ts = note.lastUpdatedAt.getTime();
      if (ts > (latestByDest.get(note.destinationId) ?? 0)) latestByDest.set(note.destinationId, ts);
    }
    return rows.map((row) => ({
      id: row.id,
      canonicalName: row.canonicalName,
      currentNoteCount: currentByDest.get(row.id) ?? 0,
      outdatedNoteCount: outdatedByDest.get(row.id) ?? 0,
      lastUpdatedAt: latestByDest.has(row.id) ? new Date(latestByDest.get(row.id) ?? 0).toISOString() : null,
    }));
  }

  private async insertSource(
    tx: DbExecutor,
    input: { noteId: number; audioId: number; transcriptId: number; sessionId: number; audioName: string | null },
  ): Promise<void> {
    await tx
      .insert(destinationNoteSources)
      .values({
        noteId: input.noteId,
        audioId: input.audioId,
        transcriptId: input.transcriptId,
        processingSessionId: input.sessionId,
        audioNameSnapshot: input.audioName,
        createdAt: new Date(),
      })
      .onConflictDoNothing({ target: [destinationNoteSources.noteId, destinationNoteSources.transcriptId] });
  }

  private async insertInsightSource(
    tx: DbExecutor,
    input: {
      insightId: number;
      audioId: number;
      transcriptId: number;
      sessionId: number;
      audioName: string | null;
      evidenceSummary: string | null;
    },
  ): Promise<void> {
    await tx
      .insert(destinationInsightSources)
      .values({
        insightId: input.insightId,
        audioId: input.audioId,
        transcriptId: input.transcriptId,
        processingSessionId: input.sessionId,
        evidenceSummary: input.evidenceSummary,
        audioNameSnapshot: input.audioName,
        createdAt: new Date(),
      })
      .onConflictDoNothing({ target: [destinationInsightSources.insightId, destinationInsightSources.transcriptId] });
  }

  private async removePhysical(path: string): Promise<void> {
    try {
      await fs.rm(path, { force: true });
    } catch {
      // Best effort — a missing/locked file must never fail the deletion.
    }
  }

  private async removePhysicalDir(path: string): Promise<void> {
    try {
      await fs.rm(path, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }

  private async requireBatch(sessionId: number) {
    const db = getDatabase();
    const batch = await db
      .select()
      .from(batches)
      .where(and(eq(batches.id, sessionId), isNull(batches.deletedAt)))
      .get();
    if (!batch) {
      throw new DomainError('BATCH_NOT_FOUND', 'جلسه پردازش پیدا نشد.');
    }
    return batch;
  }
}

export const sessionsService = new SessionsService();
