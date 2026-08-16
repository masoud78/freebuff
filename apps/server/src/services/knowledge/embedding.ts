import { createHash } from 'node:crypto';
import type { GeminiUsage } from '@freebuff/contracts';
import { and, eq } from 'drizzle-orm';
import { getDatabase } from '../../core/database/client.js';
import { knowledgeEmbeddings } from '../../core/database/schema.js';
import { DomainError } from '../errors.js';
import { GeminiGatewayError } from '../gemini/gateway.js';

/**
 * Central, stable representation of a knowledge fact for embedding. One
 * function — candidates and master knowledge use the same text so their
 * vectors live in the same space and compare meaningfully.
 */
export function buildKnowledgeEmbeddingText(input: {
  knowledgeType: string;
  entityName: string | null;
  attribute: string | null;
  valueText: string | null;
  unit: string | null;
  canonicalText: string;
}): string {
  const parts = [
    input.knowledgeType,
    input.entityName ?? '',
    input.attribute ?? '',
    input.valueText ?? '',
    input.unit ?? '',
    input.canonicalText,
  ];
  return parts.join(' | ').replace(/\s+/g, ' ').trim();
}

/** Hash of the embedding source text — cache key component. */
export function hashEmbeddingSource(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface EmbeddingResult {
  embedding: number[];
  /** True when the vector came from the cache (zero Gemini calls). */
  fromCache: boolean;
}

export interface EmbeddingGatewayLike {
  createEmbedding(input: { apiKey: string; modelId: string; text: string }): Promise<{
    embedding: number[];
    usage: GeminiUsage;
    durationMs: number;
  }>;
}

/**
 * Embedding cache. Re-embedding the same text with the same model is
 * forbidden: rows are unique on (model_id, source_hash), so a cache hit
 * means exactly zero Gemini calls.
 */
export class EmbeddingService {
  /**
   * Get (or create) the vector for `text` with `modelId`. Callers supply the
   * gateway and apiKey; embedding usage is recorded by the caller so this
   * service stays storage-only.
   */
  async getOrCreate(
    input: {
      modelId: string;
      text: string;
      knowledgeId?: number | null;
      knowledgeVersionId?: number | null;
      candidateId?: number | null;
      noteId?: number | null;
    },
    gateway: EmbeddingGatewayLike,
    apiKey: string,
    onEmbedded?: (usage: GeminiUsage, durationMs: number) => void,
  ): Promise<EmbeddingResult> {
    const db = getDatabase();
    const sourceHash = hashEmbeddingSource(input.text);
    const cacheKey = and(
      eq(knowledgeEmbeddings.modelId, input.modelId),
      eq(knowledgeEmbeddings.sourceHash, sourceHash),
    );

    const existing = await db
      .select({
        id: knowledgeEmbeddings.id,
        embedding: knowledgeEmbeddings.embedding,
        noteId: knowledgeEmbeddings.noteId,
      })
      .from(knowledgeEmbeddings)
      .where(cacheKey)
      .get();
    if (existing) {
      // Attach the note id to a previously-created candidate/cache vector.
      if (input.noteId != null && existing.noteId == null) {
        await db
          .update(knowledgeEmbeddings)
          .set({ noteId: input.noteId })
          .where(eq(knowledgeEmbeddings.id, existing.id));
      }
      return {
        embedding: parseEmbedding(existing.embedding),
        fromCache: true,
      };
    }

    // Cache miss → real Gemini embedding call. Transient gateway failures stay
    // retryable (the job engine requeues); only non-gateway problems become
    // the permanent EMBEDDING_FAILED error.
    let result: { embedding: number[]; usage: GeminiUsage; durationMs: number };
    try {
      result = await gateway.createEmbedding({ apiKey, modelId: input.modelId, text: input.text });
    } catch (error) {
      if (error instanceof GeminiGatewayError) throw error;
      throw new DomainError('EMBEDDING_FAILED', 'ایجاد Embedding ناموفق بود.', { cause: error });
    }
    onEmbedded?.(result.usage, result.durationMs);

    // The unique index guards against concurrent duplicate embeddings: a
    // concurrent insert that wins the race makes ours a harmless no-op.
    await db
      .insert(knowledgeEmbeddings)
      .values({
        knowledgeId: input.knowledgeId ?? null,
        knowledgeVersionId: input.knowledgeVersionId ?? null,
        candidateId: input.candidateId ?? null,
        noteId: input.noteId ?? null,
        modelId: input.modelId,
        sourceHash,
        dimensions: result.embedding.length,
        embedding: JSON.stringify(result.embedding),
        createdAt: new Date(),
      })
      .onConflictDoNothing({ target: [knowledgeEmbeddings.modelId, knowledgeEmbeddings.sourceHash] });

    return { embedding: result.embedding, fromCache: false };
  }

  /** Load the stored vector for a knowledge item (null when never embedded). */
  async getForKnowledge(modelId: string, knowledgeId: number): Promise<number[] | null> {
    const db = getDatabase();
    const row = await db
      .select({ embedding: knowledgeEmbeddings.embedding })
      .from(knowledgeEmbeddings)
      .where(
        and(
          eq(knowledgeEmbeddings.modelId, modelId),
          eq(knowledgeEmbeddings.knowledgeId, knowledgeId),
        ),
      )
      .limit(1)
      .get();
    return row ? parseEmbedding(row.embedding) : null;
  }
}

export function parseEmbedding(json: string): number[] {
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'number')) {
    throw new DomainError('EMBEDDING_FAILED', 'بردار Embedding ذخیره‌شده نامعتبر است.');
  }
  return parsed;
}

/** Cosine similarity between two equal-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export const embeddingService = new EmbeddingService();
