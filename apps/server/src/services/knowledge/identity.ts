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

export interface KnowledgeValueParts {
  valueText: string | null;
  unit: string | null;
  qualifiers: string[];
  valueJson?: unknown;
}

/**
 * Deterministic hash of a knowledge value. Exact-gate comparisons compare
 * identity + this hash: same identity AND same value → CONFIRMATION without
 * any Gemini call. `valueJson` (when present) is canonicalized by key order
 * so equivalent objects hash identically.
 */
export function buildKnowledgeValueHash(parts: KnowledgeValueParts): string {
  const json = parts.valueJson !== undefined && parts.valueJson !== null
    ? JSON.stringify(parts.valueJson, Object.keys(parts.valueJson as Record<string, unknown>).sort())
    : '';
  const payload = [
    normalizePart(parts.valueText),
    normalizePart(parts.unit),
    ...(parts.qualifiers ?? []).map(normalizePart),
    json,
  ].join('|');
  return createHash('sha256').update(payload).digest('hex');
}
