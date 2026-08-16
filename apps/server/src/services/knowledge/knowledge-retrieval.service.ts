import { and, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { getDatabase } from '../../core/database/client.js';
import { knowledgeEvidence, knowledgeItems, knowledgeVersions } from '../../core/database/schema.js';
import { normalizeDestinationName } from './destination-normalize.js';
import type { EmbeddingGatewayLike } from './embedding.js';
import { embeddingService, buildKnowledgeEmbeddingText, cosineSimilarity } from './embedding.js';
import { loadPoolVectors } from './vector-index.js';

/** Retrieval budget — Gemini context must stay small. Conservative defaults. */
export const RETRIEVAL_BUDGET = {
  maxRetrievedItems: 6,
  maxRetrievedCharacters: 4000,
  similarityCandidateLimit: 40,
  lexicalPrefilterLimit: 20,
} as const;

export interface ExistingKnowledgeHit {
  knowledgeId: number;
  versionId: number;
  identityKey: string;
  knowledgeType: string;
  entityName: string | null;
  attribute: string | null;
  valueText: string | null;
  unit: string | null;
  canonicalText: string;
  sourceCount: number;
}

export type MatchType = 'identity' | 'entity_attribute' | 'lexical' | 'semantic';

export interface HybridHit {
  knowledgeId: number;
  versionId: number;
  canonicalText: string;
  valueText: string | null;
  unit: string | null;
  sourceCount: number;
  matchType: MatchType;
  similarity: number | null;
}

export interface RetrieveCandidate {
  identityKey: string;
  entityName: string | null;
  attribute: string | null;
  canonicalText: string;
  knowledgeType: string;
  valueText: string | null;
  unit: string | null;
}

export interface SemanticRetrievalOptions {
  modelId: string;
  gateway: EmbeddingGatewayLike;
  apiKey: string;
  /** Called when an embedding was created (usage) or served from cache. */
  onEmbedded?: (usage: { inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null; totalTokens: number | null }, durationMs: number, fromCache: boolean) => void;
}

const MATCH_RANK: Record<MatchType, number> = {
  identity: 0,
  entity_attribute: 1,
  lexical: 2,
  semantic: 3,
};

type Condition = SQL | ReturnType<typeof eq>;

function destinationCondition(destinationId: number | null): Condition {
  return destinationId === null
    ? sql`${knowledgeItems.destinationId} IS NULL`
    : eq(knowledgeItems.destinationId, destinationId);
}

/**
 * Retrieval of relevant EXISTING knowledge for a candidate. All searches are
 * destination-aware and bounded — a candidate never scans the whole database
 * and Gemini never receives the full destination knowledge. The delta service
 * owns decisions; this service owns search.
 */
export class KnowledgeRetrievalService {
  /** Exact identity lookup (destination-scoped, active items only). */
  async exactIdentityLookup(
    destinationId: number | null,
    identityKey: string,
    limit = 5,
  ): Promise<ExistingKnowledgeHit[]> {
    return this.selectHits(
      [
        destinationCondition(destinationId),
        eq(knowledgeItems.identityKey, identityKey),
        eq(knowledgeItems.status, 'ACTIVE'),
        eq(knowledgeVersions.isCurrent, true),
      ],
      limit,
    );
  }

  /** Exact normalized entity/attribute match (destination-scoped). */
  async exactEntityAttributeMatch(
    destinationId: number | null,
    entityName: string | null,
    attribute: string | null,
    limit = 10,
  ): Promise<ExistingKnowledgeHit[]> {
    if (!entityName && !attribute) return [];
    const conditions: Condition[] = [
      destinationCondition(destinationId),
      eq(knowledgeItems.status, 'ACTIVE'),
      eq(knowledgeVersions.isCurrent, true),
    ];
    if (entityName) {
      // Exact normalized match OR substring containment — a bounded prefilter.
      const normalized = normalizeDestinationName(entityName);
      conditions.push(
        or(
          eq(knowledgeItems.entityName, normalized),
          like(knowledgeItems.entityName, `%${normalized}%`),
        ) ?? sql`1 = 0`,
      );
    }
    if (attribute) {
      const normalized = normalizeDestinationName(attribute);
      conditions.push(
        or(
          eq(knowledgeItems.attribute, normalized),
          like(knowledgeItems.attribute, `%${normalized}%`),
        ) ?? sql`1 = 0`,
      );
    }
    return this.selectHits(conditions, limit);
  }

  /** Lexical (LIKE) relevance over canonical text — bounded prefilter tier. */
  async lexicalSearch(
    destinationId: number | null,
    query: string,
    limit = RETRIEVAL_BUDGET.lexicalPrefilterLimit,
  ): Promise<ExistingKnowledgeHit[]> {
    const terms = this.extractTerms(query).slice(0, 4);
    if (terms.length === 0) return [];
    const conditions: Condition[] = [
      destinationCondition(destinationId),
      eq(knowledgeItems.status, 'ACTIVE'),
      eq(knowledgeVersions.isCurrent, true),
      or(...terms.map((term) => like(knowledgeVersions.canonicalText, `%${term}%`))) ?? sql`1 = 0`,
    ];
    return this.selectHits(conditions, limit);
  }

  /**
   * Hybrid retrieval: identity → entity/attribute → lexical → semantic.
   * Returns a deduped, ranked, character-budgeted list. When `semantic`
   * options are provided the semantic tier runs over the bounded pool
   * (never the whole database).
   */
  async hybridRetrieve(
    candidate: RetrieveCandidate,
    destinationId: number | null,
    semantic?: SemanticRetrievalOptions,
    limit: number = RETRIEVAL_BUDGET.maxRetrievedItems,
  ): Promise<HybridHit[]> {
    const results = new Map<number, HybridHit>();

    // Tier 1: identity.
    for (const hit of await this.exactIdentityLookup(destinationId, candidate.identityKey)) {
      this.push(results, hit, 'identity', null);
    }
    // Tier 2: entity/attribute.
    for (const hit of await this.exactEntityAttributeMatch(destinationId, candidate.entityName, candidate.attribute)) {
      this.push(results, hit, 'entity_attribute', null);
    }
    // Tier 3: lexical.
    for (const hit of await this.lexicalSearch(destinationId, candidate.canonicalText)) {
      this.push(results, hit, 'lexical', null);
    }

    // Tier 4: semantic — only over the bounded pool already collected.
    if (semantic) {
      const poolIds = [...results.keys()].slice(0, RETRIEVAL_BUDGET.similarityCandidateLimit);
      const withSimilarity = await this.semanticSearch(candidate, poolIds, semantic);
      for (const hit of withSimilarity) {
        this.push(results, hit, 'semantic', hit.similarity);
      }
    }

    return this.finalize(results, limit);
  }

  private async semanticSearch(
    candidate: RetrieveCandidate,
    poolKnowledgeIds: number[],
    options: SemanticRetrievalOptions,
  ): Promise<HybridHit[]> {
    if (poolKnowledgeIds.length === 0) return [];

    // Candidate embedding (cache-friendly).
    const text = buildKnowledgeEmbeddingText({
      knowledgeType: candidate.knowledgeType,
      entityName: candidate.entityName,
      attribute: candidate.attribute,
      valueText: candidate.valueText,
      unit: candidate.unit,
      canonicalText: candidate.canonicalText,
    });
    const candidateVec = await embeddingService.getOrCreate(
      { modelId: options.modelId, text },
      options.gateway,
      options.apiKey,
      (usage, durationMs) => {
        options.onEmbedded?.(
          {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedTokens: usage.cachedTokens,
            totalTokens: usage.totalTokens,
          },
          durationMs,
          false,
        );
      },
    );
    options.onEmbedded?.(
      { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0 },
      0,
      candidateVec.fromCache,
    );

    // Existing pool vectors — only those already stored are used; missing
    // ones simply don't participate (search stays bounded and free of
    // surprise embedding calls during retrieval).
    const vectors = await loadPoolVectors(options.modelId, poolKnowledgeIds);
    const scored: { knowledgeId: number; similarity: number }[] = [];
    for (const [knowledgeId, vector] of vectors) {
      const similarity = cosineSimilarity(candidateVec.embedding, vector);
      if (similarity > 0) scored.push({ knowledgeId, similarity });
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    const top = scored.slice(0, RETRIEVAL_BUDGET.similarityCandidateLimit);
    if (top.length === 0) return [];

    const rows = await this.selectHits(
      [
        eq(knowledgeItems.status, 'ACTIVE'),
        eq(knowledgeVersions.isCurrent, true),
        inArray(knowledgeItems.id, top.map((t) => t.knowledgeId)),
      ],
      top.length,
    );
    const byId = new Map(top.map((t) => [t.knowledgeId, t.similarity]));
    return rows.map((row) => ({ ...row, matchType: 'semantic' as const, similarity: byId.get(row.knowledgeId) ?? null }));
  }

  /** Minimal fields needed to merge a hit into the ranked map. */
  private push(
    map: Map<number, HybridHit>,
    hit: { knowledgeId: number; versionId: number; canonicalText: string; valueText: string | null; unit: string | null; sourceCount: number },
    matchType: MatchType,
    similarity: number | null,
  ): void {
    const existing = map.get(hit.knowledgeId);
    if (existing && MATCH_RANK[matchType] >= MATCH_RANK[existing.matchType]) return;
    map.set(hit.knowledgeId, {
      knowledgeId: hit.knowledgeId,
      versionId: hit.versionId,
      canonicalText: hit.canonicalText,
      valueText: hit.valueText,
      unit: hit.unit,
      sourceCount: hit.sourceCount,
      matchType,
      similarity: matchType === 'semantic' ? similarity : null,
    });
  }

  private finalize(map: Map<number, HybridHit>, limit: number): HybridHit[] {
    const sorted = [...map.values()].sort((a, b) => {
      const rankDiff = MATCH_RANK[a.matchType] - MATCH_RANK[b.matchType];
      if (rankDiff !== 0) return rankDiff;
      return (b.similarity ?? 0) - (a.similarity ?? 0);
    });
    const selected: HybridHit[] = [];
    let chars = 0;
    for (const hit of sorted) {
      const cost = hit.canonicalText.length + 20;
      if (chars + cost > RETRIEVAL_BUDGET.maxRetrievedCharacters) break;
      selected.push(hit);
      chars += cost;
      if (selected.length >= limit) break;
    }
    return selected;
  }

  private extractTerms(text: string): string[] {
    const seen = new Set<string>();
    const terms: string[] = [];
    for (const term of normalizeDestinationName(text).split(/[\s،.؛:!؟?()\-–_]+/)) {
      if (term.length < 2) continue;
      if (seen.has(term)) continue;
      seen.add(term);
      terms.push(term);
    }
    return terms;
  }

  private async selectHits(conditions: Condition[], limit: number): Promise<ExistingKnowledgeHit[]> {
    const db = getDatabase();
    const rows = await db
      .select({
        knowledgeId: knowledgeItems.id,
        versionId: knowledgeVersions.id,
        identityKey: knowledgeItems.identityKey,
        knowledgeType: knowledgeItems.knowledgeType,
        entityName: knowledgeItems.entityName,
        attribute: knowledgeItems.attribute,
        valueText: knowledgeVersions.valueText,
        unit: knowledgeVersions.unit,
        canonicalText: knowledgeVersions.canonicalText,
        sourceCount: sql<number>`0`,
      })
      .from(knowledgeItems)
      .innerJoin(knowledgeVersions, eq(knowledgeVersions.knowledgeId, knowledgeItems.id))
      .where(and(...conditions))
      .orderBy(desc(knowledgeItems.updatedAt))
      .limit(limit);

    const ids = rows.map((row) => row.knowledgeId);
    if (ids.length === 0) return rows;
    const counts = await db
      .select({ knowledgeId: knowledgeEvidence.knowledgeId, count: sql<number>`count(${knowledgeEvidence.id})` })
      .from(knowledgeEvidence)
      .where(inArray(knowledgeEvidence.knowledgeId, ids))
      .groupBy(knowledgeEvidence.knowledgeId);
    const countById = new Map(counts.map((c) => [c.knowledgeId, Number(c.count)]));
    return rows.map((row) => ({ ...row, sourceCount: countById.get(row.knowledgeId) ?? 0 }));
  }
}

export const knowledgeRetrievalService = new KnowledgeRetrievalService();
