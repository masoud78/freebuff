import type { FastifyInstance } from 'fastify';
import type {
  ApiErrorResponse,
  CandidateRetrievalDebugResponse,
  CandidateStatus,
  DeltaDecision,
  KnowledgeCandidateInfo,
  KnowledgeDecisionsResponse,
  KnowledgeType,
} from '@freebuff/contracts';
import { eq, inArray } from 'drizzle-orm';
import { getDatabase } from '../core/database/client.js';
import {
  destinations,
  knowledgeCandidates,
  knowledgeDeltaDecisions,
  knowledgeItems,
  knowledgeVersions,
} from '../core/database/schema.js';
import { candidatesService } from '../services/knowledge/candidates.service.js';
import { knowledgeRetrievalService, RETRIEVAL_BUDGET } from '../services/knowledge/knowledge-retrieval.service.js';
import { knowledgeDeltaService } from '../services/knowledge/knowledge-delta.service.js';
import { toErrorResponse } from './error-response.js';

/** Candidates of a batch joined with their delta decisions (if any). */
async function loadBatchCandidates(batchId: number): Promise<KnowledgeCandidateInfo[]> {
  const db = getDatabase();
  const rows = await db
    .select({
      id: knowledgeCandidates.id,
      transcriptId: knowledgeCandidates.transcriptId,
      destinationId: knowledgeCandidates.destinationId,
      knowledgeType: knowledgeCandidates.knowledgeType,
      entityName: knowledgeCandidates.entityName,
      attribute: knowledgeCandidates.attribute,
      valueText: knowledgeCandidates.valueText,
      unit: knowledgeCandidates.unit,
      canonicalText: knowledgeCandidates.canonicalText,
      status: knowledgeCandidates.status,
      createdAt: knowledgeCandidates.createdAt,
    })
    .from(knowledgeCandidates)
    .where(eq(knowledgeCandidates.batchId, batchId))
    .orderBy(knowledgeCandidates.id);

  const candidateIds = rows.map((row) => row.id);
  const decisionByCandidate = new Map<number, typeof knowledgeDeltaDecisions.$inferSelect>();
  if (candidateIds.length > 0) {
    const decisionRows = await db
      .select()
      .from(knowledgeDeltaDecisions)
      .where(inArray(knowledgeDeltaDecisions.candidateId, candidateIds));
    for (const row of decisionRows) {
      decisionByCandidate.set(row.candidateId, row);
    }
  }

  const destIds = [...new Set(rows.map((r) => r.destinationId).filter((id): id is number => id !== null))];
  const destName = new Map<number, string>();
  if (destIds.length > 0) {
    const destRows = await db
      .select({ id: destinations.id, canonicalName: destinations.canonicalName })
      .from(destinations)
      .where(inArray(destinations.id, destIds));
    for (const row of destRows) destName.set(row.id, row.canonicalName);
  }

  const matchedKnowledgeIds = [...new Set(
    [...decisionByCandidate.values()]
      .map((d) => d.matchedKnowledgeId)
      .filter((id): id is number => id !== null),
  )];
  const matchedText = new Map<number, string>();
  if (matchedKnowledgeIds.length > 0) {
    const matchedRows = await db
      .select({ knowledgeId: knowledgeItems.id, canonicalText: knowledgeVersions.canonicalText })
      .from(knowledgeItems)
      .innerJoin(knowledgeVersions, eq(knowledgeVersions.knowledgeId, knowledgeItems.id))
      .where(inArray(knowledgeItems.id, matchedKnowledgeIds));
    for (const row of matchedRows) matchedText.set(row.knowledgeId, row.canonicalText);
  }

  return rows.map((row) => {
    const decision = decisionByCandidate.get(row.id) ?? null;
    return {
      id: row.id,
      transcriptId: row.transcriptId,
      destinationId: row.destinationId,
      destinationName: row.destinationId !== null ? (destName.get(row.destinationId) ?? null) : null,
      knowledgeType: row.knowledgeType as KnowledgeType,
      entityName: row.entityName,
      attribute: row.attribute,
      valueText: row.valueText,
      unit: row.unit,
      canonicalText: row.canonicalText,
      status: row.status as CandidateStatus,
      createdAt: row.createdAt.toISOString(),
      decision: {
        decision: (decision?.decision as DeltaDecision | undefined) ?? null,
        confidence: decision?.confidence ?? null,
        reasonCode: decision?.reasonCode ?? null,
        matchedKnowledgeId: decision?.matchedKnowledgeId ?? null,
        matchedKnowledgeText:
          decision?.matchedKnowledgeId !== null
            ? (matchedText.get(decision?.matchedKnowledgeId ?? -1) ?? null)
            : null,
        matchedCandidateId: decision?.matchedCandidateId ?? null,
      },
    };
  });
}

export async function knowledgeRoutes(app: FastifyInstance): Promise<void> {
  // Candidates + delta decisions of a batch (UI "Knowledge Decisions" section).
  app.get(
    '/api/batches/:id/knowledge-decisions',
    async (request, reply): Promise<KnowledgeDecisionsResponse | ApiErrorResponse> => {
      try {
        const { id } = request.params as { id: string };
        const batchId = Number(id);
        const candidates = await loadBatchCandidates(batchId);
        return { batchId, candidates };
      } catch (error) {
        request.log.error({ err: error }, 'Failed to load knowledge decisions');
        return toErrorResponse(reply, error);
      }
    },
  );

  // Debuggable retrieval for one candidate (expandable details in the UI).
  app.get(
    '/api/knowledge-candidates/:id/retrieval',
    async (request, reply): Promise<CandidateRetrievalDebugResponse | ApiErrorResponse> => {
      try {
        const { id } = request.params as { id: string };
        const candidateId = Number(id);
        const candidate = await candidatesService.getCandidate(candidateId);
        if (!candidate) {
          reply.code(404);
          return { error: { code: 'CANDIDATE_NOT_FOUND', message: 'Candidate یافت نشد.' } };
        }
        const hits = await knowledgeRetrievalService.hybridRetrieve(
          {
            identityKey: candidate.identityKey,
            entityName: candidate.entityName,
            attribute: candidate.attribute,
            canonicalText: candidate.canonicalText,
            knowledgeType: candidate.knowledgeType,
            valueText: candidate.valueText,
            unit: candidate.unit,
          },
          candidate.destinationId,
          undefined,
          RETRIEVAL_BUDGET.maxRetrievedItems,
        );
        const destinationName =
          candidate.destinationId !== null
            ? ((await getDatabase()
                .select({ canonicalName: destinations.canonicalName })
                .from(destinations)
                .where(eq(destinations.id, candidate.destinationId))
                .get())?.canonicalName ?? null)
            : null;
        return {
          candidateId,
          destinationId: candidate.destinationId,
          destinationName,
          matches: hits.map((hit) => ({
            knowledgeId: hit.knowledgeId,
            canonicalText: hit.canonicalText,
            matchType: hit.matchType,
            similarity: hit.similarity,
          })),
        };
      } catch (error) {
        request.log.error({ err: error }, 'Failed to load retrieval debug');
        return toErrorResponse(reply, error);
      }
    },
  );

  // Token/API savings metrics for a batch (foundation for Phase 11).
  app.get(
    '/api/batches/:id/delta-metrics',
    async (request, reply): Promise<Record<string, number> | ApiErrorResponse> => {
      try {
        const { id } = request.params as { id: string };
        return await knowledgeDeltaService.getMetrics(Number(id));
      } catch (error) {
        request.log.error({ err: error }, 'Failed to load delta metrics');
        return toErrorResponse(reply, error);
      }
    },
  );
}
