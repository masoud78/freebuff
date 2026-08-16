import type { BatchDeltaItem } from '@freebuff/contracts';
import { DomainError } from '../errors.js';

/** Internal budgets — the user's CONTENT_GENERATION prompt controls style/length. */
export const CONTENT_BUDGET = {
  maxContentDeltaItems: 50,
  maxContentInputCharacters: 8000,
} as const;

/**
 * Internal content contract appended to the user's CONTENT_GENERATION prompt.
 * Enforces data safety ONLY — it never overrides the user's style prompt.
 */
export const CONTENT_INTERNAL_CONTRACT = `
--- Internal content contract (system, non-negotiable) ---
You are turning the supplied knowledge changes of ONE destination into useful
content. Strict rules:
- Use ONLY the knowledge listed below. Never invent facts, prices, distances,
  names or details that are not present.
- When a detail is missing, do NOT fabricate it — simply omit it.
- Conflicts, unconfirmed claims and previous values are NOT facts. "Previous
  value" entries are context only; always write from the CURRENT value.
- Do not reference the Delta, batch, knowledge IDs, or this instruction.
- The destination and content style are defined by your instructions.
Write the content directly. No JSON wrapper, no preamble.
`;

/**
 * ContentInputBuilder (Phase 11 §11, §28–29): converts the publishable batch
 * delta into the minimum-sufficient context for Gemini. No timestamps, row
 * IDs, evidence counts or transcripts — canonical reconciled values only.
 */
export class ContentInputBuilder {
  /** Deterministic budget check: throws a clear error instead of truncating. */
  validateBudget(items: BatchDeltaItem[]): void {
    if (items.length === 0) {
      throw new DomainError('CONTENT_DELTA_EMPTY', 'دلتای قابل انتشار برای این مقصد وجود ندارد.');
    }
    if (items.length > CONTENT_BUDGET.maxContentDeltaItems) {
      throw new DomainError(
        'CONTENT_INPUT_TOO_LARGE',
        `تعداد دانش دلتا (${items.length}) از سقف ${CONTENT_BUDGET.maxContentDeltaItems} بیشتر است.`,
      );
    }
  }

  /** The user-facing input: destination + NEW + UPDATED knowledge. */
  buildUserText(destinationName: string | null, items: BatchDeltaItem[]): string {
    const lines: string[] = [];
    lines.push(`Destination: ${destinationName ?? '(بدون مقصد مشخص)'}`);
    lines.push('');

    const news = items.filter((item) => item.changeType === 'NEW');
    const updates = items.filter((item) => item.changeType === 'UPDATE');

    if (news.length > 0) {
      lines.push('NEW KNOWLEDGE:');
      news.forEach((item, index) => {
        lines.push(`${index + 1}.`);
        lines.push(`Type: ${item.knowledgeType}`);
        if (item.entityName) lines.push(`Entity: ${item.entityName}`);
        if (item.attribute) lines.push(`Attribute: ${item.attribute}`);
        if (item.currentValue !== null && item.currentValue !== '') {
          lines.push(`Value: ${item.currentValue}${item.unit ? ` ${item.unit}` : ''}`);
        }
        lines.push(`Canonical: ${item.canonicalText}`);
        lines.push('');
      });
    }

    if (updates.length > 0) {
      lines.push('UPDATED KNOWLEDGE:');
      updates.forEach((item, index) => {
        lines.push(`${index + 1}.`);
        if (item.entityName) lines.push(`Entity: ${item.entityName}`);
        if (item.attribute) lines.push(`Attribute: ${item.attribute}`);
        if (item.oldValue !== null && item.oldValue !== '') {
          lines.push(`Previous value: ${item.oldValue}${item.unit ? ` ${item.unit}` : ''}`);
        }
        if (item.currentValue !== null && item.currentValue !== '') {
          lines.push(`Current value: ${item.currentValue}${item.unit ? ` ${item.unit}` : ''}`);
        }
        lines.push(`Canonical: ${item.canonicalText}`);
        lines.push('');
      });
    }

    const text = lines.join('\n').trim();
    if (text.length > CONTENT_BUDGET.maxContentInputCharacters) {
      throw new DomainError(
        'CONTENT_INPUT_TOO_LARGE',
        `ورودی محتوا (${text.length} نویسه) از سقف ${CONTENT_BUDGET.maxContentInputCharacters} بیشتر است.`,
      );
    }
    return text;
  }
}

export const contentInputBuilder = new ContentInputBuilder();
