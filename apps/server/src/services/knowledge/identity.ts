import { createHash } from 'node:crypto';
import { normalizeDestinationName } from './destination-normalize.js';

export interface KnowledgeIdentityParts {
  destinationId: number | null;
  knowledgeType: string;
  /** Normalized entity name (nullable) — lowercased, trimmed. */
  entityName: string | null;
  /** Normalized attribute (nullable). */
  attribute: string | null;
  /** Optional scope (e.g. normalized category). */
  scope: string | null;
}

function normalizePart(value: string | null | undefined): string {
  if (!value) return '';
  return normalizeDestinationName(value);
}

/**
 * Deterministic identity key for a knowledge item. Built entirely by the
 * backend from normalized parts — Gemini never supplies the hash. Used in
 * Phase 9 for NEW / UPDATE / CONFIRMATION / CONFLICT detection.
 */
export function buildKnowledgeIdentityKey(parts: KnowledgeIdentityParts): string {
  const payload = [
    parts.destinationId ?? '',
    parts.knowledgeType,
    normalizePart(parts.entityName),
    normalizePart(parts.attribute),
    normalizePart(parts.scope),
  ].join('|');
  return createHash('sha256').update(payload).digest('hex');
}
