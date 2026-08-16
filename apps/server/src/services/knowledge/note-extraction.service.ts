import { createHash } from 'node:crypto';
import type { GeminiUsage, NoteKind, NoteScopeType } from '@freebuff/contracts';
import { eq } from 'drizzle-orm';
import { getDatabase } from '../../core/database/client.js';
import type { DbExecutor } from '../jobs.service.js';
import {
  apiUsage,
  insightProposals,
  knowledgeAnalysisRuns,
  noteProposals,
  transcripts,
  voiceReports,
  type JobRow,
} from '../../core/database/schema.js';
import { credentialStore } from '../gemini/credentials.store.js';
import type { GeminiGatewayLike } from '../gemini/gateway.js';
import { jobService } from '../jobs.service.js';
import { modelsService } from '../models.service.js';
import { newsroomService, type NewsroomReporter } from '../newsroom.service.js';
import { promptsService } from '../prompts.service.js';
import { sessionsService } from '../sessions.service.js';
import { destinationService } from './destinations.service.js';
import { insightReconciliationService } from './insight-reconciliation.service.js';
import { noteReconciliationService } from './note-reconciliation.service.js';

/**
 * Simplified processing (notes + voice report + audience insights). One Gemini
 * call per unique transcript extracts a whole-voice report, a small set of
 * genuinely useful destination notes and grounded audience insights; each is
 * then reconciled against the destination's CURRENT data and persisted as a
 * PENDING proposal. The destination database is NEVER mutated here — the user
 * applies proposals explicitly.
 */
export class NoteExtractionService {
  buildInputSignature(transcript: { normalizedHash: string }, modelId: string, promptVersionId: number): string {
    return createHash('sha256')
      .update(`NOTE|${transcript.normalizedHash}|${modelId}|${promptVersionId}`)
      .digest('hex');
  }

  async processJob(job: JobRow, gateway: GeminiGatewayLike): Promise<void> {
    const db = getDatabase();
    const { batchId, entityId } = job;
    const transcript = await db.select().from(transcripts).where(eq(transcripts.id, entityId)).get();
    if (!transcript || transcript.status !== 'COMPLETED') {
      await this.failJob(job, 'TRANSCRIPT_NOT_FOUND', 'Transcript یافت نشد.', false);
      return;
    }

    const modelId = await modelsService.getConfiguredModelId('KNOWLEDGE_PROCESSING');
    if (!modelId) {
      await this.failJob(job, 'KNOWLEDGE_MODEL_NOT_CONFIGURED', 'مدل پردازش و استخراج نکات تنظیم نشده است.', false);
      return;
    }
    const prompt = await promptsService.getActiveVersion('KNOWLEDGE_PROCESSING');
    if (!prompt) {
      await this.failJob(job, 'KNOWLEDGE_PROMPT_NOT_CONFIGURED', 'پرامپت پردازش تنظیم نشده است.', false);
      return;
    }
    const apiKey = await credentialStore.getKey();
    if (!apiKey) {
      await this.failJob(job, 'GEMINI_NOT_CONFIGURED', 'کلید Gemini تنظیم نشده است.', false);
      return;
    }

    // Idempotency: a COMPLETED run with the same config means zero Gemini calls.
    const signature = this.buildInputSignature(transcript, modelId, prompt.id);
    const existingRun = await db
      .select({ id: knowledgeAnalysisRuns.id, status: knowledgeAnalysisRuns.status })
      .from(knowledgeAnalysisRuns)
      .where(eq(knowledgeAnalysisRuns.inputSignature, signature))
      .get();
    if (existingRun?.status === 'COMPLETED') {
      await jobService.markCompleted(job.id);
      await sessionsService.advanceStageIfTerminal(batchId);
      await this.maybeGenerateNewsroom(batchId, gateway);
      return;
    }

    const started = new Date();
    const runInserted = await db
      .insert(knowledgeAnalysisRuns)
      .values({
        transcriptId: transcript.id,
        modelId,
        promptVersionId: prompt.id,
        inputSignature: signature,
        status: 'RUNNING',
        createdAt: started,
      })
      .returning({ id: knowledgeAnalysisRuns.id });
    if (runInserted[0]?.id === undefined) {
      await this.failJob(job, 'KNOWLEDGE_SAVE_FAILED', 'ثبت پردازش ممکن نشد.', false);
      return;
    }

    let result: {
      analysis: {
        voiceReport: string;
        conversationTopic: string;
        notes: {
          title: string;
          description: string;
          destination: { name: string; role: string };
          relevantDate: string | null;
          kind: NoteKind;
          scopeType: NoteScopeType;
          tourSubject: string | null;
        }[];
        audienceInsights: {
          title: string;
          description: string;
          destination: { name: string; role: string };
          inferenceBasis: string;
          confidence: number;
          contentOpportunity: { title: string; reason: string } | null;
        }[];
      };
      usage: GeminiUsage | null;
      durationMs: number;
    };
    try {
      result = await gateway.analyzeNotes({
        apiKey,
        modelId,
        systemPrompt: prompt.content,
        transcriptText: transcript.fullText,
      });
    } catch (error) {
      await this.markFailedRun(signature);
      throw error;
    }

    // Record the real usage of the successful call.
    await this.recordUsage(
      batchId,
      job.id,
      transcript.audioId,
      modelId,
      result.usage,
      result.durationMs,
      'SUCCESS',
      null,
    );

    const embeddingModelId = await modelsService.getConfiguredModelId('EMBEDDING').catch(() => null);
    const ctx = {
      gateway,
      knowledgeModelId: modelId,
      promptContent: prompt.content,
      embeddingModelId,
      apiKey,
      job,
    };

    // Reconcile each factual note (may make bounded embedding / comparison calls).
    const proposals: {
      destinationId: number;
      title: string;
      description: string;
      relevantDate: string | null;
      noteKind: NoteKind;
      scopeType: NoteScopeType;
      tourSubject: string | null;
      proposedAction: 'ADD' | 'UPDATE' | 'MARK_OUTDATED' | 'NO_CHANGE';
      matchedNoteId: number | null;
      logReason: string | null;
    }[] = [];
    for (const note of result.analysis.notes) {
      const destination = await destinationService.resolveOrCreateNoteDestination(
        { name: note.destination.name, role: note.destination.role },
        batchId,
      );
      // Origin / transit / comparison / other places never create destinations.
      if (!destination) continue;

      const proposal = await noteReconciliationService.propose(
        { title: note.title, description: note.description, relevantDate: note.relevantDate },
        destination.id,
        ctx,
      );
      proposals.push({
        destinationId: destination.id,
        title: note.title,
        description: note.description,
        relevantDate: note.relevantDate,
        noteKind: note.kind,
        scopeType: note.scopeType,
        tourSubject: note.tourSubject,
        proposedAction: proposal.proposedAction,
        matchedNoteId: proposal.matchedNoteId,
        logReason: proposal.logReason,
      });
    }

    // Reconcile each audience insight (deterministic dedup, never hard delete).
    const insights: {
      destinationId: number;
      title: string;
      description: string;
      inferenceBasis: string;
      confidence: number;
      contentOpportunityTitle: string | null;
      contentOpportunityReason: string | null;
      proposedAction: 'ADD' | 'MERGE' | 'NO_CHANGE';
      matchedInsightId: number | null;
    }[] = [];
    for (const insight of result.analysis.audienceInsights) {
      const destination = await destinationService.resolveOrCreateNoteDestination(
        { name: insight.destination.name, role: insight.destination.role },
        batchId,
      );
      if (!destination) continue;

      const proposal = await insightReconciliationService.propose(
        {
          title: insight.title,
          description: insight.description,
          inferenceBasis: insight.inferenceBasis,
          confidence: Math.round(insight.confidence * 100),
          contentOpportunityTitle: insight.contentOpportunity?.title ?? null,
          contentOpportunityReason: insight.contentOpportunity?.reason ?? null,
        },
        destination.id,
      );
      insights.push({
        destinationId: destination.id,
        title: insight.title,
        description: insight.description,
        inferenceBasis: insight.inferenceBasis,
        confidence: Math.round(insight.confidence * 100),
        contentOpportunityTitle: insight.contentOpportunity?.title ?? null,
        contentOpportunityReason: insight.contentOpportunity?.reason ?? null,
        proposedAction: proposal.proposedAction,
        matchedInsightId: proposal.matchedInsightId,
      });
    }

    // Two distinct no-knowledge states (notes-based, as the per-voice card is note-centric):
    //   NO_USEFUL_KNOWLEDGE — no useful destination note existed in the voice.
    //   NO_NEW_KNOWLEDGE    — notes existed but all repeated existing knowledge.
    const actionableProposals = proposals.filter((p) => p.proposedAction !== 'NO_CHANGE');
    const noChangeProposals = proposals.filter((p) => p.proposedAction === 'NO_CHANGE');
    const resultStatus: 'ACTIONABLE' | 'NO_USEFUL_KNOWLEDGE' | 'NO_NEW_KNOWLEDGE' =
      result.analysis.notes.length === 0 || proposals.length === 0
        ? 'NO_USEFUL_KNOWLEDGE'
        : actionableProposals.length === 0 && noChangeProposals.length > 0
          ? 'NO_NEW_KNOWLEDGE'
          : 'ACTIONABLE';

    // Atomic persistence: voice report + note proposals + insight proposals + run status + job.
    await db.transaction(async (tx) => {
      const now = new Date();
      await tx
        .insert(voiceReports)
        .values({
          audioId: transcript.audioId,
          transcriptId: transcript.id,
          report: result.analysis.voiceReport,
          conversationTopic: result.analysis.conversationTopic.trim() || null,
          resultStatus,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: voiceReports.audioId,
          set: {
            report: result.analysis.voiceReport,
            conversationTopic: result.analysis.conversationTopic.trim() || null,
            resultStatus,
            transcriptId: transcript.id,
            createdAt: now,
          },
        });
      for (const p of proposals) {
        await tx.insert(noteProposals).values({
          batchId,
          transcriptId: transcript.id,
          audioId: transcript.audioId,
          destinationId: p.destinationId,
          title: p.title,
          description: p.description,
          relevantDate: p.relevantDate,
          noteKind: p.noteKind,
          scopeType: p.scopeType,
          tourSubject: p.tourSubject,
          proposedAction: p.proposedAction,
          matchedNoteId: p.matchedNoteId,
          logReason: p.logReason,
          status: 'PENDING',
          createdAt: now,
          updatedAt: now,
        });
      }
      for (const insight of insights) {
        await tx.insert(insightProposals).values({
          batchId,
          transcriptId: transcript.id,
          audioId: transcript.audioId,
          destinationId: insight.destinationId,
          title: insight.title,
          description: insight.description,
          inferenceBasis: insight.inferenceBasis,
          confidence: insight.confidence,
          contentOpportunityTitle: insight.contentOpportunityTitle,
          contentOpportunityReason: insight.contentOpportunityReason,
          proposedAction: insight.proposedAction,
          matchedInsightId: insight.matchedInsightId,
          status: 'PENDING',
          createdAt: now,
          updatedAt: now,
        });
      }
      await tx
        .update(knowledgeAnalysisRuns)
        .set({ status: 'COMPLETED', completedAt: now })
        .where(eq(knowledgeAnalysisRuns.inputSignature, signature));
      await jobService.markCompleted(job.id, tx);
    });

    await sessionsService.advanceStageIfTerminal(batchId);
    await this.maybeGenerateNewsroom(batchId, gateway);
  }

  /** Newsroom is additive — its failure must never fail or block processing. */
  private async maybeGenerateNewsroom(batchId: number, gateway: unknown): Promise<void> {
    const reporter = gateway as unknown as NewsroomReporter;
    if (typeof reporter.generateNewsroom !== 'function') return;
    try {
      await newsroomService.generateForSession(batchId, reporter);
    } catch (error) {
      console.error('[note-worker] newsroom generation failed', { batchId, err: error });
    }
  }

  private async markFailedRun(signature: string): Promise<void> {
    await getDatabase()
      .update(knowledgeAnalysisRuns)
      .set({ status: 'FAILED', completedAt: new Date() })
      .where(eq(knowledgeAnalysisRuns.inputSignature, signature));
  }

  private async recordUsage(
    batchId: number,
    jobId: number,
    audioId: number | null,
    modelId: string | null,
    usage: GeminiUsage | null,
    durationMs: number,
    status: 'SUCCESS' | 'FAILED',
    errorCode: string | null,
    db: DbExecutor = getDatabase(),
  ): Promise<void> {
    await db.insert(apiUsage).values({
      batchId,
      jobId,
      audioId,
      stage: 'KNOWLEDGE',
      modelId,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      cachedTokens: usage?.cachedTokens ?? null,
      totalTokens: usage?.totalTokens ?? null,
      durationMs,
      status,
      errorCode,
      createdAt: new Date(),
    });
  }

  private async failJob(
    job: JobRow,
    errorCode: string,
    errorMessage: string,
    retryable: boolean,
  ): Promise<void> {
    await jobService.markFailed(job.id, errorCode, errorMessage, { retryable });
    console.error(`[note-worker] job ${job.id} failed`, {
      batchId: job.batchId,
      jobId: job.id,
      transcriptId: job.entityId,
      operation: 'note_extraction',
      errorCode,
    });
    await sessionsService.advanceStageIfTerminal(job.batchId);
  }
}

export const noteExtractionService = new NoteExtractionService();
