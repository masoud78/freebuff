import { createHash } from 'node:crypto';

/**
 * Conservative Persian/Arabic text normalization. Only safe, meaning-preserving
 * transformations are applied: Arabic yeh/kaf → Persian forms and whitespace
 * cleanup. Digits, punctuation, names and spacing semantics are untouched.
 */
export function normalizeText(input: string): string {
  return input
    .replace(/\u064A/g, '\u06CC') // Arabic yeh (ي) → Persian yeh (ی)
    .replace(/\u0643/g, '\u06A9') // Arabic kaf (ك) → Persian kaf (ک)
    .replace(/\u0649/g, '\u06CC') // Arabic alef maksura (ى) → Persian yeh
    .replace(/[ \t\u00A0]+/g, ' ') // collapse runs of spaces/tabs
    .replace(/ *\n */g, '\n') // trim spaces around line breaks
    .replace(/\n{3,}/g, '\n\n') // collapse 3+ blank lines to 2
    .trim();
}

/** Stable SHA-256 of normalized text — the transcript identity for dedup. */
export function hashText(normalizedText: string): string {
  return createHash('sha256').update(normalizedText).digest('hex');
}

export interface TranscriptSegmentDraft {
  text: string;
  normalizedText: string;
  textHash: string;
  speaker: string | null;
}

/**
 * Speaker-like label at line start: a short label (numbers or known speaker
 * words) followed by a colon. Conservative by design — no label is required
 * for segmentation to succeed.
 */
const SPEAKER_LABEL_RE =
  /^(?:[0-9٠-٩۰-۹]{1,3}|(?:Speaker|گوینده|گفتگوگر|شخص|نفر|صدای|فروشنده|مشتری)[\s_]*(?:[0-9٠-٩۰-۹]{0,3}))\s*[:：]\s+/i;

/**
 * Deterministic local segmentation: paragraphs first, then best-effort
 * speaker-turn splits inside paragraphs. Never calls Gemini and never fails
 * the transcript when no speaker labels exist.
 */
export function segmentTranscript(fullText: string): TranscriptSegmentDraft[] {
  const normalized = normalizeText(fullText);
  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  const segments: TranscriptSegmentDraft[] = [];
  for (const paragraph of paragraphs) {
    const lines = paragraph.split('\n');
    let current: { speaker: string | null; parts: string[] } = { speaker: null, parts: [] };

    const flush = (): void => {
      const text = current.parts.join('\n').trim();
      if (!text) return;
      const normalizedText = normalizeText(text);
      segments.push({
        text,
        normalizedText,
        textHash: hashText(normalizedText),
        speaker: current.speaker,
      });
    };

    for (const line of lines) {
      const match = SPEAKER_LABEL_RE.exec(line);
      if (match) {
        flush();
        current = { speaker: match[0].trim().replace(/[:：]\s*$/, ''), parts: [line.slice(match[0].length)] };
      } else {
        current.parts.push(line);
      }
    }
    flush();
  }
  return segments;
}
