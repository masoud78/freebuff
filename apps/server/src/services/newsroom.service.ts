import type { GeminiUsage, NewsroomStory, ProcessingNewsDestination } from '@freebuff/contracts';
import { eq, inArray } from 'drizzle-orm';
import { getDatabase } from '../core/database/client.js';
import {
  batches,
  destinationNotes,
  destinations,
  insightProposals,
  noteProposals,
  processingDestinationNews,
  voiceReports,
} from '../core/database/schema.js';
import { credentialStore } from './gemini/credentials.store.js';
import type { NewsroomPayload } from './gemini/gateway.js';
import { modelsService } from './models.service.js';

/** The reporter surface the newsroom service needs (real gateway satisfies it). */
export interface NewsroomReporter {
  generateNewsroom(input: {
    apiKey: string;
    modelId: string;
    payload: NewsroomPayload;
  }): Promise<{ stories: NewsroomStory[]; noNewsReason: string | null; usage: GeminiUsage; durationMs: number }>;
}

const NO_NEWS_TEXT =
  'نکتهٔ جدیدی برای این مقصد ثبت نشد، چون اطلاعاتی که در ویس‌ها مطرح شد قبلاً در دیتابیس این مقصد وجود دارد یا اطلاعات قابل استفادهٔ جدیدی نداشت.';

/**
 * Processing newsroom — a short, grounded narrative per destination of what a
 * session actually ADDed/UPDATEed/OUTDATED (from reconciliation diffs) plus
 * newly observed audience concerns. The reporter never re-derives novelty; it
 * only explains the backend-computed changes. Generated after processing and
 * stored, so it survives restart and stays historical after Apply.
 */
export class NewsroomService {
  /** Generate (idempotently) the per-destination newsroom for a session. */
  async generateForSession(sessionId: number, reporter: NewsroomReporter): Promise<number> {
    const db = getDatabase();
    const batch = await db.select().from(batches).where(eq(batches.id, sessionId)).get();
    // Build it once note processing is complete. It is displayed only after
    // Apply moves the session to the NEWSROOM (stage 5) state.
    if (!batch || !['REVIEW', 'COMMITTED', 'NEWSROOM'].includes(batch.sessionStage)) return 0;

    const noteRows = await db
      .select()
      .from(noteProposals)
      .where(eq(noteProposals.batchId, sessionId));
    const insightRows = await db
      .select()
      .from(insightProposals)
      .where(eq(insightProposals.batchId, sessionId));

    const destinationIds = new Set<number>();
    for (const row of noteRows) {
      if (row.destinationId !== null) destinationIds.add(row.destinationId);
    }
    for (const row of insightRows) {
      if (row.destinationId !== null) destinationIds.add(row.destinationId);
    }
    if (destinationIds.size === 0) return 0;

    const destRows = await db
      .select({ id: destinations.id, name: destinations.canonicalName })
      .from(destinations)
      .where(inArray(destinations.id, [...destinationIds]));
    const nameById = new Map(destRows.map((row) => [row.id, row.name]));

    // Conversation topics per audio, for a grounded "no news" sentence.
    const audioIds = new Set<number>();
    for (const row of noteRows) audioIds.add(row.audioId);
    for (const row of insightRows) audioIds.add(row.audioId);
    const topicByAudio = new Map<number, string>();
    if (audioIds.size > 0) {
      const reports = await db
        .select({ audioId: voiceReports.audioId, conversationTopic: voiceReports.conversationTopic })
        .from(voiceReports)
        .where(inArray(voiceReports.audioId, [...audioIds]));
      for (const report of reports) {
        if (report.conversationTopic) topicByAudio.set(report.audioId, report.conversationTopic);
      }
    }

    const existingNews = await db
      .select({ destinationId: processingDestinationNews.destinationId })
      .from(processingDestinationNews)
      .where(eq(processingDestinationNews.processingSessionId, sessionId));
    const existingIds = new Set(existingNews.map((row) => row.destinationId));

    const apiKey = await credentialStore.getKey();
    const modelId = await modelsService.getConfiguredModelId('KNOWLEDGE_PROCESSING');

    let generated = 0;
    for (const destinationId of destinationIds) {
      if (existingIds.has(destinationId)) continue;

      const destNotes = noteRows.filter((r) => r.destinationId === destinationId);
      const destInsights = insightRows.filter((r) => r.destinationId === destinationId);

      const actionableNotes = destNotes.filter((r) => r.proposedAction !== 'NO_CHANGE');
      const actionableInsights = destInsights.filter((r) => r.proposedAction !== 'NO_CHANGE');
      const noActionable = actionableNotes.length === 0 && actionableInsights.length === 0;

      const topics = [
        ...new Set(
          destNotes
            .map((r) => topicByAudio.get(r.audioId))
            .concat(destInsights.map((r) => topicByAudio.get(r.audioId)))
            .filter((t): t is string => !!t),
        ),
      ].slice(0, 5);

      const destinationName = nameById.get(destinationId) ?? 'مقصد';
      let content: string;
      let storiesJson: string | null = null;

      if (!apiKey || !modelId) {
        // Config missing — fall back to a safe, deterministic summary so the
        // newsroom never blocks processing. It is recomputed on retry.
        content = noActionable
          ? this.buildNoNewsText(topics)
          : this.buildFallbackSummary(actionableNotes, actionableInsights, destinationName);
      } else {
        const payload = await this.buildPayload(destinationId, destinationName, destNotes, destInsights, topics);
        try {
          const result = await reporter.generateNewsroom({ apiKey, modelId, payload });
          if (result.stories.length > 0 && !noActionable) {
            storiesJson = JSON.stringify(result.stories);
            content = '';
          } else if (result.noNewsReason?.trim()) {
            // The reporter honestly explains why there is nothing new (a call
            // about something else, or information already recorded) — never
            // an invented piece of news.
            content = result.noNewsReason.trim();
          } else {
            content = noActionable
              ? this.buildNoNewsText(topics)
              : this.buildFallbackSummary(actionableNotes, actionableInsights, destinationName);
          }
        } catch (error) {
          // A reporter failure must never block processing — degrade to the
          // deterministic summary. The newsroom is additive, not critical.
          console.error('[newsroom] reporter failed', { sessionId, destinationId, err: error });
          content = noActionable
            ? this.buildNoNewsText(topics)
            : this.buildFallbackSummary(actionableNotes, actionableInsights, destinationName);
        }
      }

      await db
        .insert(processingDestinationNews)
        .values({
          processingSessionId: sessionId,
          destinationId,
          content,
          storiesJson,
          createdAt: new Date(),
        })
        .onConflictDoNothing({ target: [processingDestinationNews.processingSessionId, processingDestinationNews.destinationId] });
      generated += 1;
    }

    return generated;
  }

  /** Read the stored newsroom for a session (survives restart + Apply). */
  async listForSession(sessionId: number): Promise<ProcessingNewsDestination[]> {
    const rows = await getDatabase()
      .select({
        destinationId: processingDestinationNews.destinationId,
        destinationName: destinations.canonicalName,
        content: processingDestinationNews.content,
        storiesJson: processingDestinationNews.storiesJson,
      })
      .from(processingDestinationNews)
      .innerJoin(destinations, eq(destinations.id, processingDestinationNews.destinationId))
      .where(eq(processingDestinationNews.processingSessionId, sessionId))
      .orderBy(processingDestinationNews.id);
    return rows.map((row) => ({
      destinationId: row.destinationId,
      destinationName: row.destinationName,
      content: row.content,
      stories: this.parseStories(row.storiesJson),
      reason: this.reasonFor(row.content, row.storiesJson),
    }));
  }

  /**
   * Explain why a destination has no editorial stories: either the stored
   * plain text is the deterministic "no new info" note, or the stored JSON
   * was malformed/empty and we can only report that nothing was produced.
   */
  private reasonFor(content: string, storiesJson: string | null): string | null {
    const stories = this.parseStories(storiesJson);
    if (stories.length > 0) return null;
    if (content.trim().length > 0) return content.trim();
    return 'برای این مقصد محتوای خبری تولید نشد.';
  }

  /** Parse stored JSON stories defensively — malformed data degrades to empty. */
  private parseStories(storiesJson: string | null): NewsroomStory[] {
    if (!storiesJson) return [];
    try {
      const parsed = JSON.parse(storiesJson) as unknown;
      if (!Array.isArray(parsed)) return [];
      const stories: NewsroomStory[] = [];
      for (const item of parsed) {
        if (
          typeof item !== 'object' ||
          item === null ||
          typeof item.headline !== 'string' ||
          !Array.isArray(item.paragraphs) ||
          !item.paragraphs.every((p: unknown) => typeof p === 'string')
        ) {
          continue;
        }
        const headline = item.headline.trim();
        const rawParagraphs = item.paragraphs as unknown[];
        const paragraphs = [
          ...new Set(
            rawParagraphs
              .filter((p): p is string => typeof p === 'string')
              .map((p) => p.trim())
              .filter((p) => p.length > 0),
          ),
        ];
        if (!headline || paragraphs.length === 0) continue;
        if (stories.some((story) => story.headline.trim() === headline)) continue;
        stories.push({
          headline,
          paragraphs,
          subheading: typeof item.subheading === 'string' && item.subheading.trim() ? item.subheading.trim() : null,
        });
        if (stories.length >= 3) break;
      }
      return stories;
    } catch {
      return [];
    }
  }

  private async buildPayload(
    _destinationId: number,
    destinationName: string,
    noteRows: (typeof noteProposals.$inferSelect)[],
    insightRows: (typeof insightProposals.$inferSelect)[],
    conversationTopics: string[],
  ): Promise<NewsroomPayload> {
    const db = getDatabase();
    const sourceVoiceCount = new Set(noteRows.map((r) => r.audioId).concat(insightRows.map((r) => r.audioId))).size;

    const newNotes = noteRows
      .filter((r) => r.proposedAction === 'ADD')
      .map((r) => ({ title: r.title, description: r.description }));

    // Resolve previous text for UPDATE/OUTDATED from the matched master note.
    const matchedIds = [
      ...new Set(
        noteRows
          .filter((r) => r.matchedNoteId !== null)
          .map((r) => r.matchedNoteId as number),
      ),
    ];
    const prevById = new Map<number, { title: string; description: string }>();
    if (matchedIds.length > 0) {
      const rows = await db
        .select({ id: destinationNotes.id, title: destinationNotes.currentTitle, description: destinationNotes.currentDescription })
        .from(destinationNotes)
        .where(inArray(destinationNotes.id, matchedIds));
      for (const row of rows) prevById.set(row.id, { title: row.title, description: row.description });
    }

    const updatedNotes = noteRows
      .filter((r) => r.proposedAction === 'UPDATE')
      .map((r) => {
        const prev = r.matchedNoteId !== null ? prevById.get(r.matchedNoteId) : undefined;
        return {
          title: r.title,
          previousTitle: prev?.title ?? r.title,
          previousDescription: prev?.description ?? '',
          newDescription: r.description,
        };
      });

    const markedOutdated = noteRows
      .filter((r) => r.proposedAction === 'MARK_OUTDATED')
      .map((r) => {
        const prev = r.matchedNoteId !== null ? prevById.get(r.matchedNoteId) : undefined;
        return {
          title: r.title,
          previousDescription: prev?.description ?? '',
          reason: r.logReason ?? '',
        };
      });

    const newInsights = insightRows
      .filter((r) => r.proposedAction !== 'NO_CHANGE')
      .map((r) => ({
        title: r.title,
        description: r.description,
        inferenceBasis: r.inferenceBasis,
        contentOpportunityTitle: r.contentOpportunityTitle,
        contentOpportunityReason: r.contentOpportunityReason,
      }));

    return {
      destination: destinationName,
      sourceVoiceCount,
      conversationTopics,
      newNotes,
      updatedNotes,
      outdatedNotes: markedOutdated,
      newInsights,
    };
  }

  /** Deterministic "nothing new" fallback (optionally grounded with topics). */
  private buildNoNewsText(topics: string[]): string {
    if (topics.length === 0) return NO_NEWS_TEXT;
    const joined = topics.slice(0, 3).join('، ');
    return `${NO_NEWS_TEXT} موضوعات مطرح‌شده: ${joined}.`;
  }

  /** Safe deterministic fallback when Gemini config is missing. */
  private buildFallbackSummary(
    notes: (typeof noteProposals.$inferSelect)[],
    insights: (typeof insightProposals.$inferSelect)[],
    destinationName: string | undefined,
  ): string {
    const newCount = notes.filter((n) => n.proposedAction === 'ADD').length;
    const updatedCount = notes.filter((n) => n.proposedAction === 'UPDATE').length;
    const outdatedCount = notes.filter((n) => n.proposedAction === 'MARK_OUTDATED').length;
    const insightCount = insights.filter((i) => i.proposedAction !== 'NO_CHANGE').length;
    const parts: string[] = [];
    if (newCount > 0) parts.push(`${newCount} نکته جدید`);
    if (updatedCount > 0) parts.push(`${updatedCount} بروزرسانی`);
    if (outdatedCount > 0) parts.push(`${outdatedCount} نکته قدیمی شد`);
    if (insightCount > 0) parts.push(`${insightCount} دغدغه جدید`);
    if (parts.length === 0) return NO_NEWS_TEXT;
    return `برای مقصد «${destinationName ?? 'مقصد'}»، ${parts.join('، ')} ثبت شد.`;
  }
}

export const newsroomService = new NewsroomService();
