import { eq } from 'drizzle-orm';
import { getDatabase } from '../../core/database/client.js';
import { knowledgeEmbeddings } from '../../core/database/schema.js';
import { cosineSimilarity, parseEmbedding } from './embedding.js';

/** One entry in the vector index (a stored embedding row). */
export interface VectorIndexEntry {
  key: string;
  knowledgeId: number | null;
  candidateId: number | null;
  embedding: number[];
}

/** Result of a similarity search, sorted descending. */
export interface VectorSearchMatch {
  key: string;
  knowledgeId: number | null;
  candidateId: number | null;
  similarity: number;
}

/**
 * VectorIndex — small abstraction over the local vector store. Business logic
 * never touches the storage format of vectors; it talks to this interface.
 * The local strategy keeps SQLite as the source of truth: vectors live in the
 * `knowledge_embeddings` table, and search is bounded in-process cosine
 * similarity over a prefiltered pool (never the whole database).
 */
export interface VectorIndex {
  /** Upsert an entry keyed by its stable key (dedupe by key). */
  upsert(entry: VectorIndexEntry): Promise<void>;
  /** Top-k cosine matches within the given pool. */
  search(query: { embedding: number[]; limit: number; pool: VectorIndexEntry[] }): Promise<VectorSearchMatch[]>;
  /** Remove an entry by key. */
  remove(key: string): Promise<void>;
}

/** SQLite-backed implementation: upsert/remove touch the DB; search is in-memory cosine over the caller-supplied bounded pool. */
export class SqliteVectorIndex implements VectorIndex {
  async upsert(entry: VectorIndexEntry): Promise<void> {
    const db = getDatabase();
    await db
      .insert(knowledgeEmbeddings)
      .values({
        knowledgeId: entry.knowledgeId,
        candidateId: entry.candidateId,
        modelId: 'virtual', // rows are model-scoped in practice via EmbeddingService
        sourceHash: entry.key,
        dimensions: entry.embedding.length,
        embedding: JSON.stringify(entry.embedding),
        createdAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [knowledgeEmbeddings.modelId, knowledgeEmbeddings.sourceHash],
        set: { embedding: JSON.stringify(entry.embedding) },
      });
  }

  async search(query: {
    embedding: number[];
    limit: number;
    pool: VectorIndexEntry[];
  }): Promise<VectorSearchMatch[]> {
    const scored = query.pool
      .map((entry) => ({
        key: entry.key,
        knowledgeId: entry.knowledgeId,
        candidateId: entry.candidateId,
        similarity: cosineSimilarity(query.embedding, entry.embedding),
      }))
      .filter((match) => match.similarity > 0)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, query.limit);
    return scored;
  }

  async remove(key: string): Promise<void> {
    const db = getDatabase();
    await db
      .delete(knowledgeEmbeddings)
      .where(eq(knowledgeEmbeddings.sourceHash, key));
  }
}

/** Load stored vectors for a set of knowledge ids (bounded pool). */
export async function loadPoolVectors(
  modelId: string,
  knowledgeIds: number[],
): Promise<Map<number, number[]>> {
  if (knowledgeIds.length === 0) return new Map();
  const db = getDatabase();
  const rows = await db
    .select({ knowledgeId: knowledgeEmbeddings.knowledgeId, embedding: knowledgeEmbeddings.embedding })
    .from(knowledgeEmbeddings)
    .where(eq(knowledgeEmbeddings.modelId, modelId));
  const byId = new Map<number, number[]>();
  const wanted = new Set(knowledgeIds);
  for (const row of rows) {
    if (row.knowledgeId !== null && wanted.has(row.knowledgeId)) {
      try {
        byId.set(row.knowledgeId, parseEmbedding(row.embedding));
      } catch {
        // Corrupt vector — skip, similarity treats it as absent.
      }
    }
  }
  return byId;
}

export const vectorIndex: VectorIndex = new SqliteVectorIndex();
