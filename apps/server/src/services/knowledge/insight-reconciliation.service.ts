import type { InsightProposalAction } from '@freebuff/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { getDatabase } from '../../core/database/client.js';
import { destinationAudienceInsights } from '../../core/database/schema.js';
import { normalizeDestinationName } from './destination-normalize.js';

/** High lexical overlap marks two insights as the same traveler concern. */
const INSIGHT_OVERLAP_THRESHOLD = 0.6;

export interface InsightCandidateInput {
  title: string;
  description: string;
  inferenceBasis: string;
  confidence: number;
  contentOpportunityTitle: string | null;
  contentOpportunityReason: string | null;
}

export interface InsightProposalResult {
  proposedAction: InsightProposalAction;
  matchedInsightId: number | null;
}

interface ExistingInsight {
  id: number;
  title: string;
  description: string;
}

function normalize(value: string): string {
  return normalizeDestinationName(value).trim();
}

function termsOf(value: string): Set<string> {
  const seen = new Set<string>();
  for (const term of normalize(value).split(/[\s،.؛:!؟?()\-–_]+/)) {
    if (term.length < 2) continue;
    seen.add(term);
  }
  return seen;
}

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

/**
 * Audience-insight reconciliation: deduplicates inferred traveler concerns per
 * destination. Insights are never time-sensitively OUTDATED like facts — they
 * are ADDed, MERGEd (same concern, richer evidence) or NO_CHANGE (already
 * recorded). Deterministic only; no Gemini calls.
 */
export class InsightReconciliationService {
  async listCurrentInsights(destinationId: number): Promise<ExistingInsight[]> {
    const rows = await getDatabase()
      .select({
        id: destinationAudienceInsights.id,
        title: destinationAudienceInsights.title,
        description: destinationAudienceInsights.description,
      })
      .from(destinationAudienceInsights)
      .where(
        and(
          eq(destinationAudienceInsights.destinationId, destinationId),
          eq(destinationAudienceInsights.status, 'CURRENT'),
        ),
      )
      .orderBy(desc(destinationAudienceInsights.updatedAt));
    return rows.map((row) => ({ id: row.id, title: row.title, description: row.description }));
  }

  async propose(insight: InsightCandidateInput, destinationId: number): Promise<InsightProposalResult> {
    const existing = await this.listCurrentInsights(destinationId);
    if (existing.length === 0) {
      return { proposedAction: 'ADD', matchedInsightId: null };
    }

    const title = normalize(insight.title);
    const exact = existing.find((n) => normalize(n.title) === title);
    if (exact) {
      return {
        proposedAction: normalize(exact.description) === normalize(insight.description) ? 'NO_CHANGE' : 'MERGE',
        matchedInsightId: exact.id,
      };
    }

    // Conservative lexical gate — only merge when the concern clearly repeats.
    const candidateText = `${insight.title} ${insight.description}`;
    let best: { id: number; overlap: number } | null = null;
    for (const n of existing) {
      const overlap = lexicalOverlap(candidateText, `${n.title} ${n.description}`);
      if (overlap >= INSIGHT_OVERLAP_THRESHOLD && (best === null || overlap > best.overlap)) {
        best = { id: n.id, overlap };
      }
    }
    if (best) {
      return { proposedAction: 'MERGE', matchedInsightId: best.id };
    }

    return { proposedAction: 'ADD', matchedInsightId: null };
  }
}

export const insightReconciliationService = new InsightReconciliationService();
