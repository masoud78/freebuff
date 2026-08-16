import type { GeminiUsage, ProposedNoteAction } from '@freebuff/contracts';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDatabase } from '../../core/database/client.js';
import {
  apiUsage,
  destinationNotes,
  destinations,
  knowledgeEmbeddings,
  type JobRow,
} from '../../core/database/schema.js';
import { normalizeDestinationName } from './destination-normalize.js';
import { cosineSimilarity, embeddingService } from './embedding.js';
import type { GeminiGatewayLike } from '../gemini/gateway.js';

/** Minimum cosine similarity to consider two notes "about the same topic". */
const NOTE_SIMILARITY_THRESHOLD = 0.86;
/** Lexical overlap ratio that marks a note as ambiguous (needs AI). */
const LEXICAL_OVERLAP_THRESHOLD = 0.45;
/** Bounded context fed to the AI comparison (never the whole destination). */
const MAX_AI_CONTEXT_NOTES = 3;

export interface NoteCandidateInput {
  title: string;
  description: string;
  relevantDate: string | null;
}

export interface NoteProposalResult {
  proposedAction: ProposedNoteAction;
  matchedNoteId: number | null;
  /** Grounded, human Persian reason — written to the change log, never to the review UI. */
  logReason: string | null;
}

export interface NoteReconciliationContext {
  gateway: GeminiGatewayLike;
  knowledgeModelId: string;
  promptContent: string;
  embeddingModelId: string | null;
  apiKey: string;
  job: JobRow;
}

interface ExistingNote {
  id: number;
  title: string;
  description: string;
  relevantDate: string | null;
}

function normalize(value: string): string {
  return normalizeDestinationName(value).trim();
}

/** Short grounded excerpt of real note text (no invented detail). */
function excerpt(value: string, max = 120): string {
  const clean = value.trim().replace(/\s+/g, ' ');
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function termsOf(value: string): Set<string> {
  const seen = new Set<string>();
  for (const term of normalize(value).split(/[\s،.؛:!؟?()\-–_]+/)) {
    if (term.length < 2) continue;
    seen.add(term);
  }
  return seen;
}

/** Overlap ratio between two short texts (title-first lexical gate). */
function lexicalOverlap(a: string, b: string): number {
  const ta = termsOf(a);
  const tb = termsOf(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const term of ta) {
    if (tb.has(term)) common += 1;
  }
  return common / Math.min(ta.size, tb.size);
}

function noteEmbeddingText(note: NoteCandidateInput): string {
  return [note.title, note.description, note.relevantDate ?? ''].join('\n').trim();
}

/**
 * Note reconciliation: computes a proposed action for one extracted note by
 * comparing it against the existing CURRENT notes of the SAME destination.
 * Deterministic gates run first (exact title → value hash → embedding
 * similarity), and a Gemini comparison is used only for ambiguous cases —
 * never for obvious ADD / NO_CHANGE.
 */
export class NoteReconciliationService {
  /** Current notes of a destination, most-recently-updated first. */
  async listCurrentNotes(destinationId: number): Promise<ExistingNote[]> {
    const db = getDatabase();
    const rows = await db
      .select({
        id: destinationNotes.id,
        title: destinationNotes.currentTitle,
        description: destinationNotes.currentDescription,
        relevantDate: destinationNotes.relevantDate,
      })
      .from(destinationNotes)
      .where(and(eq(destinationNotes.destinationId, destinationId), eq(destinationNotes.status, 'CURRENT')))
      .orderBy(desc(destinationNotes.updatedAt));
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      relevantDate: row.relevantDate,
    }));
  }

  async destinationName(destinationId: number): Promise<string | null> {
    const row = await getDatabase()
      .select({ name: destinations.canonicalName })
      .from(destinations)
      .where(eq(destinations.id, destinationId))
      .get();
    return row?.name ?? null;
  }

  /** Compute the proposed action for one extracted note. */
  async propose(
    note: NoteCandidateInput,
    destinationId: number,
    ctx: NoteReconciliationContext,
  ): Promise<NoteProposalResult> {
    const existing = await this.listCurrentNotes(destinationId);
    const destinationName = await this.destinationName(destinationId);
    if (existing.length === 0) {
      return {
        proposedAction: 'ADD',
        matchedNoteId: null,
        logReason: `این نکته («${excerpt(note.title)}») تازه استخراج شده و به دیتابیس مقصد «${destinationName ?? 'مقصد'}» اضافه می‌شود.`,
      };
    }

    // 1. Exact-title gate (deterministic — no Gemini).
    const title = normalize(note.title);
    const exact = existing.find((n) => normalize(n.title) === title);
    if (exact) {
      if (normalize(exact.description) === normalize(note.description)) {
        return {
          proposedAction: 'NO_CHANGE',
          matchedNoteId: exact.id,
          logReason: null,
        };
      }
      return {
        proposedAction: 'UPDATE',
        matchedNoteId: exact.id,
        logReason: `این نکته به‌روزرسانی شد؛ توضیح قبلی «${excerpt(exact.description)}» بود و در ویس جدید اطلاعات جدیدتری دربارهٔ همین موضوع ثبت شده است.`,
      };
    }

    // 2. Embedding similarity (destination-scoped, bounded, cache-friendly).
    if (ctx.embeddingModelId) {
      const candidateVec = await embeddingService.getOrCreate(
        { modelId: ctx.embeddingModelId, text: noteEmbeddingText(note) },
        ctx.gateway,
        ctx.apiKey,
        (usage, durationMs) => {
          void this.recordEmbeddingUsage(ctx.job, ctx.embeddingModelId, usage, durationMs);
        },
      );
      const top = await this.mostSimilarNote(ctx.embeddingModelId, existing, candidateVec.embedding);
      if (top && top.similarity >= NOTE_SIMILARITY_THRESHOLD) {
        return this.aiCompare(note, destinationId, existing, top.noteId, ctx);
      }
    }

    // 3. Lexical prefilter (bounded) — ambiguous only if strong overlap.
    const candidateText = `${note.title} ${note.description}`;
    let best: { id: number; overlap: number } | null = null;
    for (const n of existing) {
      const overlap = lexicalOverlap(candidateText, `${n.title} ${n.description}`);
      if (overlap >= LEXICAL_OVERLAP_THRESHOLD && (best === null || overlap > best.overlap)) {
        best = { id: n.id, overlap };
      }
    }
    if (best) {
      return this.aiCompare(note, destinationId, existing, best.id, ctx);
    }

    // 4. Default — genuinely new.
    return {
      proposedAction: 'ADD',
      matchedNoteId: null,
      logReason: `این نکته («${excerpt(note.title)}») برای مقصد «${destinationName ?? 'مقصد'}» جدید است و به دیتابیس اضافه می‌شود.`,
    };
  }

  /** Semantic comparison over stored note embeddings (never the whole DB). */
  private async mostSimilarNote(
    modelId: string,
    existing: ExistingNote[],
    candidateVector: number[],
  ): Promise<{ noteId: number; similarity: number } | null> {
    const ids = existing.map((n) => n.id);
    if (ids.length === 0) return null;
    const db = getDatabase();
    const rows = await db
      .select({ noteId: knowledgeEmbeddings.noteId, embedding: knowledgeEmbeddings.embedding })
      .from(knowledgeEmbeddings)
      .where(and(eq(knowledgeEmbeddings.modelId, modelId), inArray(knowledgeEmbeddings.noteId, ids)));
    let best: { noteId: number; similarity: number } | null = null;
    for (const row of rows) {
      if (row.noteId === null) continue;
      const vector = JSON.parse(row.embedding) as number[];
      const similarity = cosineSimilarity(candidateVector, vector);
      if (similarity > 0 && (best === null || similarity > best.similarity)) {
        best = { noteId: row.noteId, similarity };
      }
    }
    return best;
  }

  /** Gemini comparison for ambiguous notes (bounded context). */
  private async aiCompare(
    note: NoteCandidateInput,
    destinationId: number,
    existing: ExistingNote[],
    matchedNoteId: number,
    ctx: NoteReconciliationContext,
  ): Promise<NoteProposalResult> {
    const contextNotes = [existing.find((n) => n.id === matchedNoteId), ...existing.filter((n) => n.id !== matchedNoteId)]
      .filter((n): n is ExistingNote => n !== undefined)
      .slice(0, MAX_AI_CONTEXT_NOTES);

    const result = await ctx.gateway.compareNote({
      apiKey: ctx.apiKey,
      modelId: ctx.knowledgeModelId,
      systemPrompt: ctx.promptContent,
      payload: {
        candidate: { title: note.title, description: note.description, relevantDate: note.relevantDate },
        destination: await this.destinationName(destinationId),
        existingNotes: contextNotes.map((n) => ({
          id: n.id,
          title: n.title,
          description: n.description,
          relevantDate: n.relevantDate,
        })),
      },
    });

    await getDatabase().insert(apiUsage).values({
      batchId: ctx.job.batchId,
      jobId: ctx.job.id,
      audioId: null,
      stage: 'KNOWLEDGE',
      modelId: ctx.knowledgeModelId,
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      cachedTokens: result.usage?.cachedTokens ?? null,
      totalTokens: result.usage?.totalTokens ?? null,
      durationMs: result.durationMs ?? 0,
      status: 'SUCCESS',
      errorCode: null,
      createdAt: new Date(),
    });

    const validIds = new Set(contextNotes.map((n) => n.id));
    let decision: ProposedNoteAction = result.comparison.decision;
    let targetId: number | null = result.comparison.matchedNoteId === 0 ? null : result.comparison.matchedNoteId;
    if (decision !== 'ADD' && (targetId === null || !validIds.has(targetId))) {
      // Invalid reference — fall back to the conservative safe behavior.
      decision = 'ADD';
      targetId = null;
    }
    if (decision === 'ADD') targetId = null;

    const fallbackReason =
      decision === 'ADD'
        ? `این نکته («${excerpt(note.title)}») به دیتابیس مقصد اضافه می‌شود.`
        : decision === 'UPDATE'
          ? `این نکته با اطلاعات جدید ویس به‌روزرسانی می‌شود.`
          : decision === 'MARK_OUTDATED'
            ? `اطلاعات جدید نشان می‌دهد این نکته دیگر معتبر نیست.`
            : null;

    return {
      proposedAction: decision,
      matchedNoteId: targetId,
      logReason: result.comparison.logReason.trim() || fallbackReason,
    };
  }

  private async recordEmbeddingUsage(
    job: JobRow,
    modelId: string | null,
    usage: GeminiUsage | null,
    durationMs: number,
  ): Promise<void> {
    await getDatabase().insert(apiUsage).values({
      batchId: job.batchId,
      jobId: job.id,
      audioId: null,
      stage: 'EMBEDDING',
      modelId,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      cachedTokens: usage?.cachedTokens ?? null,
      totalTokens: usage?.totalTokens ?? null,
      durationMs,
      status: 'SUCCESS',
      errorCode: null,
      createdAt: new Date(),
    });
  }
}

export const noteReconciliationService = new NoteReconciliationService();
