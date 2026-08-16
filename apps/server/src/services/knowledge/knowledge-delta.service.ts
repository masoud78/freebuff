import { createHash } from 'node:crypto';
import type { DeltaDecision, DeltaMetricKey, GeminiUsage } from '@freebuff/contracts';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDatabase } from '../../core/database/client.js';
import {
  apiUsage,
  deltaMetrics,
  destinations,
  knowledgeCandidates,
  knowledgeDeltaDecisions,
  type KnowledgeCandidateRow,
  type JobRow,
} from '../../core/database/schema.js';
import { DomainError } from '../errors.js';
import { GeminiGatewayError, type GeminiGatewayLike } from '../gemini/gateway.js';
import { credentialStore } from '../gemini/credentials.store.js';
import { jobService } from '../jobs.service.js';
import { batchService } from '../batches.service.js';
import { modelsService } from '../models.service.js';
import { promptsService } from '../prompts.service.js';
import { normalizeDestinationName } from './destination-normalize.js';
import { candidatesService } from './candidates.service.js';
import { knowledgeRetrievalService, RETRIEVAL_BUDGET, type HybridHit } from './knowledge-retrieval.service.js';

/** Critical-value attributes (structured check — never broad raw-text regexes). */
const CRITICAL_ATTRIBUTE_RE =
  /(قیمت|فاصله|مسافت|زمان|مدت|تاریخ|ساعت|درصد|ظرفیت|تخفیف|سیاست|شرط|دسترسی|نشانی|آدرس)/;

/**
 * Internal comparison contract appended to the user's active knowledge prompt.
 * Deliberately NOT user-configurable — the three user prompts stay unchanged.
 */
const DELTA_INTERNAL_CONTRACT = `
--- Internal comparison contract (system, non-negotiable) ---
You are comparing ONE new knowledge candidate against the EXISTING knowledge
of the same destination. Only the entries listed under "existingKnowledge"
may be referenced by matchedKnowledgeId.

Decide exactly one:
- NEW: meaningful new knowledge with no existing equivalent.
- CONFIRMATION: the SAME fact was already known and this source confirms it.
  Never choose CONFIRMATION when the value differs from the existing value.
- UPDATE: the same subject/attribute but the new information is newer, more
  authoritative, or scope-specific, so a new version is warranted. Only choose
  UPDATE when this is clearly justified; otherwise prefer CONFLICT.
- CONFLICT: the information contradicts existing knowledge and cannot be
  confidently treated as an update. Never overwrite existing data without
  certainty. CONFLICT is safer than UPDATE.
- IGNORE: noise, a wrong extraction, or content that must not be stored.

Return JSON only:
{"decision":"NEW|CONFIRMATION|UPDATE|CONFLICT|IGNORE","matchedKnowledgeId":<id from the list above, or 0 when none>,"confidence":<0..1>,"reasonCode":"<short machine code, e.g. NEW_FACT|VALUE_CHANGED|CONTRADICTS_EXISTING|NOISE|SCOPE_CHANGED>"}
`;

interface DecideContext {
  job: JobRow;
  gateway: GeminiGatewayLike;
  knowledgeModelId: string;
  promptVersionId: number;
  promptContent: string;
  embeddingModelId: string | null;
  apiKey: string;
}

interface DecisionInput {
  decision: DeltaDecision;
  matchedKnowledgeId: number | null;
  matchedVersionId: number | null;
  matchedCandidateId: number | null;
  reasonCode: string;
  confidence: number;
  summary: string | null;
  signature: string;
}

/**
 * Knowledge delta engine (Phase 9). For every candidate:
 * exact gate → same-batch dedup → hybrid retrieval → Gemini comparison →
 * validated decision → persisted decision. Master knowledge is NEVER mutated
 * here — reconciliation happens in Phase 10.
 */
export class KnowledgeDeltaService {
  /** Deterministic gate: same identity + same value → CONFIRMATION, no AI. */
  async runExactGate(candidate: KnowledgeCandidateRow): Promise<DecisionInput | null> {
    const hits = await knowledgeRetrievalService.exactIdentityLookup(
      candidate.destinationId,
      candidate.identityKey,
    );
    const identityMatch = hits[0] ?? null;
    if (!identityMatch) return null;
    if (!this.valuesEqual(candidate, identityMatch.valueText, identityMatch.unit)) return null;
    return {
      decision: 'CONFIRMATION',
      matchedKnowledgeId: identityMatch.knowledgeId,
      matchedVersionId: identityMatch.versionId,
      matchedCandidateId: null,
      reasonCode: 'IDENTITY_VALUE_MATCH',
      confidence: 1,
      summary: null,
      signature: this.buildSignature(candidate, null),
    };
  }

  /** Same-batch duplicate/conflict detection (sections 26–27). */
  async findSameBatchSibling(candidate: KnowledgeCandidateRow): Promise<{
    siblingId: number;
    sameValue: boolean;
    decided: { decision: DeltaDecision; matchedKnowledgeId: number | null; matchedVersionId: number | null; confidence: number } | null;
  } | null> {
    const db = getDatabase();
    const siblings = await db
      .select()
      .from(knowledgeCandidates)
      .where(
        and(
          eq(knowledgeCandidates.batchId, candidate.batchId),
          eq(knowledgeCandidates.identityKey, candidate.identityKey),
          ne(knowledgeCandidates.id, candidate.id),
        ),
      );
    if (siblings.length === 0) return null;

    const decisions = await db
      .select()
      .from(knowledgeDeltaDecisions)
      .where(inArray(knowledgeDeltaDecisions.candidateId, siblings.map((s) => s.id)));
    const decisionByCandidate = new Map(decisions.map((d) => [d.candidateId, d]));

    for (const sibling of siblings) {
      const dec = decisionByCandidate.get(sibling.id);
      if (sibling.valueHash === candidate.valueHash) {
        // Same fact in the same batch — align with the already-decided one.
        if (dec && (dec.decision === 'NEW' || dec.decision === 'CONFIRMATION')) {
          return {
            siblingId: sibling.id,
            sameValue: true,
            decided: {
              decision: dec.decision as DeltaDecision,
              matchedKnowledgeId: dec.matchedKnowledgeId,
              matchedVersionId: dec.matchedVersionId,
              confidence: dec.confidence,
            },
          };
        }
        continue;
      }
      // Same identity, different value in the same batch → conflict group.
      return {
        siblingId: sibling.id,
        sameValue: false,
        decided: dec
          ? {
              decision: dec.decision as DeltaDecision,
              matchedKnowledgeId: dec.matchedKnowledgeId,
              matchedVersionId: dec.matchedVersionId,
              confidence: dec.confidence,
            }
          : null,
      };
    }
    return null;
  }

  /** Retrieve top relevant existing knowledge (hybrid, bounded). */
  async retrieveRelevantKnowledge(candidate: KnowledgeCandidateRow, ctx: DecideContext): Promise<HybridHit[]> {
    const semantic = ctx.embeddingModelId
      ? {
          modelId: ctx.embeddingModelId,
          gateway: ctx.gateway,
          apiKey: ctx.apiKey,
          onEmbedded: (
            usage: { inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null; totalTokens: number | null },
            durationMs: number,
            fromCache: boolean,
          ) => {
            if (fromCache) {
              void this.incrementMetric(ctx.job.batchId, 'embedding_cache_hit_count');
              return;
            }
            void this.recordUsage(
              ctx.job,
              ctx.embeddingModelId ?? null,
              usage,
              durationMs,
              'SUCCESS',
              null,
              'EMBEDDING',
            );
          },
        }
      : undefined;
    return knowledgeRetrievalService.hybridRetrieve(candidate, candidate.destinationId, semantic);
  }

  /** Gemini structured comparison with limited invalid-output retry. */
  async classifyCandidate(
    candidate: KnowledgeCandidateRow,
    destinationName: string | null,
    hits: HybridHit[],
    ctx: DecideContext,
  ): Promise<{ decision: DeltaDecision; matchedKnowledgeId: number | null; confidence: number; reasonCode: string }> {
    const payload = {
      candidate: {
        canonicalText: candidate.canonicalText,
        knowledgeType: candidate.knowledgeType,
        entityName: candidate.entityName,
        attribute: candidate.attribute,
        valueText: candidate.valueText,
        unit: candidate.unit,
        confidence: candidate.confidence,
      },
      destination: destinationName,
      existingKnowledge: hits.slice(0, RETRIEVAL_BUDGET.maxRetrievedItems).map((hit) => ({
        id: hit.knowledgeId,
        canonicalText: hit.canonicalText,
        valueText: hit.valueText,
        unit: hit.unit,
        sourceCount: hit.sourceCount,
      })),
    };
    const systemPrompt = `${ctx.promptContent}\n${DELTA_INTERNAL_CONTRACT}`;

    let lastError: string | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let result: { classification: { decision: DeltaDecision; matchedKnowledgeId: number; confidence: number; reasonCode: string }; usage: GeminiUsage; durationMs: number };
      try {
        result = await ctx.gateway.classifyDelta({
          apiKey: ctx.apiKey,
          modelId: ctx.knowledgeModelId,
          systemPrompt,
          payload,
        });
      } catch (error) {
        if (error instanceof GeminiGatewayError) throw error;
        throw error;
      }
      // The call succeeded — record its real usage regardless of validity.
      await this.recordUsage(
        ctx.job,
        ctx.knowledgeModelId,
        result.usage,
        result.durationMs,
        'SUCCESS',
        null,
        'KNOWLEDGE',
      );

      const validation = this.validateClassification(result.classification, hits);
      if (validation.ok) {
        return {
          decision: validation.decision,
          matchedKnowledgeId: validation.matchedKnowledgeId,
          confidence: result.classification.confidence,
          reasonCode: validation.reasonCode,
        };
      }
      lastError = validation.error;
    }
    throw new DomainError('DELTA_CLASSIFICATION_INVALID', 'خروجی ساخت‌یافته مقایسه دانش نامعتبر بود.', {
      cause: lastError ?? undefined,
    });
  }

  /** Persist (or replace) the decision row for a candidate. */
  async persistDecision(candidate: KnowledgeCandidateRow, input: DecisionInput): Promise<void> {
    const db = getDatabase();
    const now = new Date();
    const values = {
      candidateId: candidate.id,
      destinationId: candidate.destinationId,
      decision: input.decision,
      matchedKnowledgeId: input.matchedKnowledgeId,
      matchedVersionId: input.matchedVersionId,
      matchedCandidateId: input.matchedCandidateId,
      reasonCode: input.reasonCode,
      confidence: input.confidence,
      reasoningSummary: input.summary,
      inputSignature: input.signature,
      createdAt: now,
    };
    await db
      .insert(knowledgeDeltaDecisions)
      .values(values)
      .onConflictDoUpdate({
        target: knowledgeDeltaDecisions.candidateId,
        set: values,
      });
  }

  /** Process all pending candidates of one transcript (delta job body). */
  async processTranscript(job: JobRow, gateway: GeminiGatewayLike): Promise<void> {
    const transcriptId = job.entityId;

    const knowledgeModelId = await modelsService.getConfiguredModelId('KNOWLEDGE_PROCESSING');
    if (!knowledgeModelId) {
      throw new DomainError('DELTA_MODEL_NOT_CONFIGURED', 'مدل مقایسه دانش تنظیم نشده است.');
    }
    const prompt = await promptsService.getActiveVersion('KNOWLEDGE_PROCESSING');
    if (!prompt) {
      throw new DomainError('KNOWLEDGE_PROMPT_NOT_CONFIGURED', 'پرامپت مقایسه دانش تنظیم نشده است.');
    }
    const embeddingModelId = await modelsService.getConfiguredModelId('EMBEDDING');
    const apiKey = await credentialStore.getKey();
    if (!apiKey) {
      throw new DomainError('GEMINI_NOT_CONFIGURED', 'کلید Gemini تنظیم نشده است.');
    }

    const ctx: DecideContext = {
      job,
      gateway,
      knowledgeModelId,
      promptVersionId: prompt.id,
      promptContent: prompt.content,
      embeddingModelId,
      apiKey,
    };

    const pending = await candidatesService.listPendingByTranscript(transcriptId);
    for (const candidate of pending) {
      const claimed = await candidatesService.claimCandidate(candidate.id);
      if (!claimed) continue;
      try {
        await this.decideCandidate(claimed, ctx);
      } catch (error) {
        await candidatesService.revertClaim(claimed.id);
        throw error;
      }
    }

    await jobService.markCompleted(job.id);
    await batchService.refreshBatchState(job.batchId);
  }

  /** One candidate through the whole decision pipeline. */
  private async decideCandidate(candidate: KnowledgeCandidateRow, ctx: DecideContext): Promise<void> {
    // 1. Exact gate — deterministic CONFIRMATION without AI.
    const exact = await this.runExactGate(candidate);
    if (exact) {
      await this.persistDecision(candidate, exact);
      await this.incrementMetric(ctx.job.batchId, 'exact_confirmation_count');
      return;
    }

    // 2. Same-batch siblings (dedup / conflict groups).
    const sibling = await this.findSameBatchSibling(candidate);
    if (sibling) {
      if (sibling.sameValue && sibling.decided) {
        await this.persistDecision(candidate, {
          decision: 'CONFIRMATION',
          matchedKnowledgeId: sibling.decided.matchedKnowledgeId,
          matchedVersionId: sibling.decided.matchedVersionId,
          matchedCandidateId: sibling.siblingId,
          reasonCode: 'SAME_BATCH_DUPLICATE',
          confidence: Math.max(0.8, sibling.decided.confidence),
          summary: `تأیید همان دانش Candidate #${sibling.siblingId} در همین Batch.`,
          signature: this.buildSignature(candidate, null),
        });
        return;
      }
      if (!sibling.sameValue) {
        await this.persistDecision(candidate, {
          decision: 'CONFLICT',
          matchedKnowledgeId: null,
          matchedVersionId: null,
          matchedCandidateId: sibling.siblingId,
          reasonCode: 'SAME_BATCH_CONFLICT',
          confidence: 0.6,
          summary: `ادعای متناقض با Candidate #${sibling.siblingId} در همین Batch.`,
          signature: this.buildSignature(candidate, null),
        });
        return;
      }
    }

    // 3. Idempotency: same comparison with same config already decided.
    const signature = this.buildSignature(candidate, ctx);
    const existing = await getDatabase()
      .select({ id: knowledgeDeltaDecisions.id, inputSignature: knowledgeDeltaDecisions.inputSignature })
      .from(knowledgeDeltaDecisions)
      .where(eq(knowledgeDeltaDecisions.candidateId, candidate.id))
      .get();
    if (existing && existing.inputSignature === signature) {
      await this.incrementMetric(ctx.job.batchId, 'delta_ai_call_skipped_count');
      return;
    }

    // 4. Hybrid retrieval (embedding cached — never re-embedded).
    const hits = await this.retrieveRelevantKnowledge(candidate, ctx);

    // 5. Gemini structured comparison (only for ambiguous cases).
    const destinationName = await this.destinationName(candidate.destinationId);
    const classification = await this.classifyCandidate(candidate, destinationName, hits, ctx);

    // 6. Critical-value guard: no auto-confirmation unless values match.
    const { matchedKnowledgeId } = classification;
    let decision: DeltaDecision = classification.decision;
    if (this.isCritical(candidate) && decision === 'CONFIRMATION' && matchedKnowledgeId !== null) {
      const matched = hits.find((h) => h.knowledgeId === matchedKnowledgeId);
      if (!matched || !this.valuesEqual(candidate, matched.valueText, matched.unit)) {
        decision = 'CONFLICT';
      }
    }

    const matchedHit = matchedKnowledgeId !== null ? hits.find((h) => h.knowledgeId === matchedKnowledgeId) : null;
    await this.persistDecision(candidate, {
      decision,
      matchedKnowledgeId: matchedKnowledgeId !== null ? matchedKnowledgeId : null,
      matchedVersionId: matchedHit?.versionId ?? null,
      matchedCandidateId: null,
      reasonCode: this.sanitizeReasonCode(classification.reasonCode),
      confidence: classification.confidence,
      summary: null,
      signature,
    });
  }

  private validateClassification(
    classification: { decision: DeltaDecision; matchedKnowledgeId: number; confidence: number; reasonCode: string },
    hits: HybridHit[],
  ): { ok: true; decision: DeltaDecision; matchedKnowledgeId: number | null; reasonCode: string } | { ok: false; error: string } {
    const { decision, matchedKnowledgeId } = classification;
    const provided = new Set(hits.map((h) => h.knowledgeId));
    if (decision === 'NEW' || decision === 'IGNORE') {
      if (matchedKnowledgeId !== 0) {
        return { ok: false, error: 'NEW/IGNORE must not reference existing knowledge' };
      }
      return { ok: true, decision, matchedKnowledgeId: null, reasonCode: this.sanitizeReasonCode(classification.reasonCode) };
    }
    if (matchedKnowledgeId === 0 || !provided.has(matchedKnowledgeId)) {
      return { ok: false, error: 'matchedKnowledgeId not in provided context' };
    }
    return { ok: true, decision, matchedKnowledgeId, reasonCode: this.sanitizeReasonCode(classification.reasonCode) };
  }

  private sanitizeReasonCode(code: string): string {
    const trimmed = code.trim().replace(/[^A-Za-z0-9_]/g, '_').slice(0, 60);
    return trimmed.length > 0 ? trimmed : 'AI_CLASSIFIED';
  }

  /** Structured critical-value check (spec §15). */
  private isCritical(candidate: KnowledgeCandidateRow): boolean {
    if (candidate.unit && candidate.unit.trim().length > 0) return true;
    // \p{Nd} covers Persian/Arabic numerals (۵, ٥) as well as ASCII digits.
    if (candidate.valueText && /\p{Nd}/u.test(candidate.valueText)) return true;
    if (candidate.valueJson) return true;
    if (candidate.attribute && CRITICAL_ATTRIBUTE_RE.test(normalizeDestinationName(candidate.attribute))) return true;
    return false;
  }

  /** Value equality for the exact gate / critical guard. */
  private valuesEqual(
    candidate: KnowledgeCandidateRow,
    existingValue: string | null,
    existingUnit: string | null,
  ): boolean {
    const candidateValue = normalizeDestinationName(candidate.valueText ?? '');
    const existing = normalizeDestinationName(existingValue ?? '');
    if (candidateValue !== existing) return false;
    return normalizeDestinationName(candidate.unit ?? '') === normalizeDestinationName(existingUnit ?? '');
  }

  /** Idempotency key: candidate + config fingerprint (prompt + embedding model). */
  private buildSignature(candidate: KnowledgeCandidateRow, ctx: DecideContext | null): string {
    const payload = [
      candidate.id,
      candidate.identityKey,
      candidate.valueHash,
      candidate.destinationId ?? '',
      'KNOWLEDGE_DELTA',
      ctx?.promptVersionId ?? '',
      ctx?.embeddingModelId ?? '',
    ];
    return createHash('sha256').update(payload.join('|')).digest('hex');
  }

  private async destinationName(destinationId: number | null): Promise<string | null> {
    if (destinationId === null) return null;
    const db = getDatabase();
    const row = await db
      .select({ name: destinations.canonicalName })
      .from(destinations)
      .where(eq(destinations.id, destinationId))
      .get();
    return row?.name ?? null;
  }

  private async recordUsage(
    job: JobRow,
    modelId: string | null,
    usage: GeminiUsage | null,
    durationMs: number,
    status: 'SUCCESS' | 'FAILED',
    errorCode: string | null,
    stage: 'KNOWLEDGE' | 'EMBEDDING',
  ): Promise<void> {
    await getDatabase().insert(apiUsage).values({
      batchId: job.batchId,
      jobId: job.id,
      audioId: null,
      stage,
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

  private async incrementMetric(batchId: number, metricKey: DeltaMetricKey): Promise<void> {
    const now = new Date();
    await getDatabase()
      .insert(deltaMetrics)
      .values({ batchId, metricKey, value: 1, updatedAt: now })
      .onConflictDoUpdate({
        target: [deltaMetrics.batchId, deltaMetrics.metricKey],
        set: { value: sql`${deltaMetrics.value} + 1`, updatedAt: now },
      });
  }

  /** Metric counter for a batch+key (UI/debug). */
  async getMetrics(batchId: number): Promise<Record<string, number>> {
    const db = getDatabase();
    const rows = await db
      .select()
      .from(deltaMetrics)
      .where(eq(deltaMetrics.batchId, batchId));
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.metricKey] = row.value;
    }
    return result;
  }
}

export const knowledgeDeltaService = new KnowledgeDeltaService();
