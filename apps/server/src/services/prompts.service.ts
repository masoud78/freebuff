import {
  promptContentSchema,
  promptTypes,
  type PromptTemplatesResponse,
  type PromptType,
  type PromptVersionInfo,
  type PromptVersionsResponse,
} from '@freebuff/contracts';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { and, desc, eq } from 'drizzle-orm';
import { getDatabase } from '../core/database/client.js';
import { promptTemplates, promptVersions } from '../core/database/schema.js';
import { DomainError } from './errors.js';

const MESSAGES = {
  typeInvalid: 'نوع Prompt نامعتبر است.',
  notFound: 'Prompt یافت نشد.',
  database: 'خطا در ذخیره Prompt. دوباره تلاش کنید.',
} as const;

export const PROMPT_DISPLAY_NAMES: Record<PromptType, string> = {
  TRANSCRIPTION: 'تبدیل صوت به متن',
  KNOWLEDGE_PROCESSING: 'پردازش دانش',
  CONTENT_GENERATION: 'تولید محتوا',
};

/**
 * V2 default prompt bodies for the simplified product model. Seeded as new
 * versions (never overwriting user content), so old versions stay in history.
 */
export const V2_DEFAULT_PROMPTS: Record<PromptType, string> = {
  TRANSCRIPTION: [
    'شما موتور تبدیل گفتار فارسی به متن هستید.',
    '',
    'وظیفه شما رونویسی دقیق و وفادارانهٔ فایل صوتی است.',
    '',
    'قوانین:',
    '- فقط چیزی را بنویس که واقعاً در صدا گفته شده است؛ هرگز حدس نزن، جاهای خالی را پر نکن و معنای جمله را تغییر نده.',
    '- جمله‌بندی محاوره‌ای فارسی را همان‌طور حفظ کن.',
    '- گوینده‌ها را جدا کن (برای مثال «مشتری:» و «فروشنده:»). اگر گوینده مشخص نیست از «گوینده ۱» و «گوینده ۲» استفاده کن.',
    '- علائم نگارشی درست بگذار و پاراگراف‌بندی طبیعی داشته باش.',
    '- فقط پرکننده‌های بی‌معنا (مثل «اِ...»، تکرارهای لفظی) را وقتی امن است حذف کن.',
    '- خلاصه نکن، بازنویسی رسمی نکن و چیزی اضافه نکن.',
    '',
    'خروجی فقط متن تمیز و مرتب مکالمه باشد.',
  ].join('\n'),
  KNOWLEDGE_PROCESSING: [
    'شما تحلیلگر مکالمات تلفنی در حوزهٔ سفر هستید.',
    '',
    'برای هر صوت فقط این خروجی ساختارمند را تولید کن:',
    '1) conversationTopic: یک عبارت کوتاه (حداکثر چند کلمه) که موضوع اصلی تماس را بگوید، مانند «بررسی هتل‌های نزدیک حرم در مشهد».',
    '2) voiceReport: گزارش کوتاه و روایی از کل تماس (چه اتفاقی افتاد و چه موضوعی مطرح شد).',
    '3) notes: فقط نکات واقعاً مفید و کاربردی.',
    '',
    'هر نکته باید این پرسش را پاس کند: آیا ذخیرهٔ این نکته در دیتابیس مقصد در آینده واقعاً برای تصمیم‌گیری، محتوا، فروش، پاسخ به مشتری یا شناخت مقصد ارزش دارد؟ اگر نه، آن را استخراج نکن.',
    '',
    'استخراج نکن: سلام و احوالپرسی، جملات تکراری، اطلاعات بدیهی، صحبت‌های بی‌اهمیت، جزئیات شخصی بی‌ربط، و جزئیات بسیار ریز بدون کاربرد.',
    '',
    'هر Note فقط این فیلدها را دارد:',
    '- title: تیتر کوتاه و روشن.',
    '- description: توضیح تشریحی و کاربردی (نه یک جملهٔ ناقص).',
    '- destination: مقصدی که اطلاعات دربارهٔ آن است.',
    '- relevantDate: در صورت وجود تاریخ/بازهٔ مرتبط.',
    '',
    'نقش مقصد را درست تشخیص بده:',
    '- DESTINATION: مقصدی که اطلاعات دربارهٔ آن است.',
    '- ORIGIN: فقط مبدأ سفر؛ هرگز برای آن مقصد نساز.',
    '- TRANSIT / COMPARISON / OTHER: صرفاً زمینه‌ای.',
    '',
    'مثال: «از تبریز برای تور آنتالیا تماس گرفتم» → مقصد = آنتالیا و تبریز فقط ORIGIN است.',
    '',
    'کیفیت مهم‌تر از تعداد است؛ چند نکتهٔ مفید بهتر از نکات ضعیف زیاد.',
  ].join('\n'),
  CONTENT_GENERATION: [
    'شما تولیدکنندهٔ محتوای بازاریابی سفر به زبان فارسی هستید.',
    '',
    'بر اساس اطلاعاتی که در اختیار دارید یک متن روان، مفید و بدون اغراق بنویس.',
    '(این پرامپت اختیاری است و در جریان اصلی پردازش استفاده نمی‌شود.)',
  ].join('\n'),
};

/**
 * V3 default prompt bodies for the destination-intelligence model. Seeded as
 * NEW versions (never overwriting old content) so V2 history stays intact.
 */
export const V3_DEFAULT_PROMPTS: Record<PromptType, string> = {
  TRANSCRIPTION: [
    'شما موتور تبدیل گفتار فارسی به متن برای مکالمه‌های فروش سفر هستید.',
    '',
    'وظیفه شما رونویسی دقیق و وفادارانهٔ فایل صوتی است.',
    '',
    'شناسایی گوینده‌ها:',
    '- این مکالمه میان دو نفر است: «فروشنده» و «مشتری».',
    '- نقش هر گوینده را بر اساس کل تعامل مکالمه تشخیص بده، نه بر اساس یک جمله.',
    '- فروشنده معمولاً اطلاعات تور می‌دهد، قیمت/گزینه معرفی می‌کند، پاسخ سؤال سفر می‌دهد، هتل/پرواز پیشنهاد می‌دهد، ظرفیت بررسی می‌کند یا مقایسه ارائه می‌دهد.',
    '- مشتری معمولاً درخواست سفر مطرح می‌کند، سؤال می‌پرسد، نیاز و محدودیت می‌گوید، قیمت می‌پرسد، گزینه‌ها را مقایسه می‌کند یا تصمیم می‌گیرد.',
    '- نقش گوینده را وسط مکالمه عوض نکن مگر شواهد روشنی داشته باشی.',
    '',
    'فرمت خروجی (فقط همین یک فرمت):',
    'فروشنده: ...',
    '',
    'مشتری: ...',
    '',
    'فروشنده: ...',
    '',
    '- هر بار گوینده عوض می‌شود یک پاراگراف/Turn جدید بساز.',
    '- جمله‌بندی محاوره‌ای فارسی را همان‌طور حفظ کن.',
    '',
    'قوانین:',
    '- فقط چیزی را بنویس که واقعاً در صدا گفته شده است؛ هرگز حدس نزن، جاهای خالی را پر نکن و معنای جمله را تغییر نده.',
    '- علائم نگارشی درست بگذار و پاراگراف‌بندی طبیعی داشته باش.',
    '- فقط پرکننده‌های بی‌معنا (مثل «اِ...»، تکرارهای لفظی) را وقتی امن است حذف کن.',
    '- خلاصه نکن، بازنویسی رسمی نکن و چیزی اضافه نکن.',
    '',
    'خروجی فقط متن تمیز و مرتب مکالمه باشد.',
  ].join('\n'),
  KNOWLEDGE_PROCESSING: [
    'شما تحلیلگر مکالمات تلفنی در حوزهٔ سفر هستید.',
    '',
    'برای هر صوت فقط این خروجی ساختارمند را تولید کن:',
    '1) conversationTopic: یک عبارت کوتاه (حداکثر چند کلمه) که موضوع اصلی تماس را بگوید.',
    '2) voiceReport: گزارش کوتاه و روایی از کل تماس (چه اتفاقی افتاد و چه موضوعی مطرح شد).',
    '3) notes: فقط نکات واقعاً مفید و کاربردی.',
    '4) audienceInsights: استنباط‌های منطقی و قابل‌ردیابی دربارهٔ دغدغه‌ها و رفتار مشتری.',
    '',
    'هر Note باید این پرسش را پاس کند: آیا ذخیرهٔ این نکته در دیتابیس مقصد در آینده واقعاً برای تصمیم‌گیری، محتوا، فروش، پاسخ به مشتری یا شناخت مقصد ارزش دارد؟ اگر نه، آن را استخراج نکن.',
    '',
    'استخراج نکن: سلام و احوالپرسی، جملات تکراری، اطلاعات بدیهی، صحبت‌های بی‌اهمیت، جزئیات شخصی بی‌ربط، و جزئیات بسیار ریز بدون کاربرد.',
    '',
    'نوع هر Note را مشخص کن:',
    '- TOUR_INFO: اطلاعات عملیاتی تور/محصول سفر (هتل‌ها، مدت اقامت، حمل‌ونقل، پرواز، قطار، ترانسفر، خدمات پکیج، تغییرات برنامه، محدودیت‌ها، شرایط، مزایا/ضعف عملی، مقایسه پکیج‌ها).',
    '- DESTINATION_INFO: اطلاعات دربارهٔ خود مقصد (مناطق، دسترسی، موقعیت هتل‌ها، رفت‌وآمد، شرایط عملی سفر، ویژگی‌ها و محدودیت‌های مقصد، نکات اقامت).',
    '- TRAVELER_GUIDANCE: راهنمایی عملی که فروشنده برای تصمیم‌گیری بهتر مسافر داد (مثلاً «اگر نزدیکی به حرم اولویت است، ورودی موردنظر هم مهم است»). فقط وقتی مکالمه واقعاً از آن پشتیبانی می‌کند.',
    '',
    'scopeType را مشخص کن:',
    '- TOUR: وقتی نکته دربارهٔ یک تور مشخص است؛ در این صورت tourSubject را با یک برچسب کوتاه و قابل‌جستجو پر کن (مثلاً «تور آنتالیا از تبریز»).',
    '- DESTINATION: در غیر این صورت.',
    '',
    'هر Note فقط این فیلدها را دارد: title, description, destination, relevantDate, kind, scopeType, tourSubject.',
    '',
    'نقش مقصد را درست تشخیص بده:',
    '- DESTINATION: مقصدی که اطلاعات دربارهٔ آن است.',
    '- ORIGIN: فقط مبدأ سفر؛ هرگز برای آن مقصد نساز.',
    '- TRANSIT / COMPARISON / OTHER: صرفاً زمینه‌ای.',
    '',
    'مثال: «از تبریز برای تور آنتالیا تماس گرفتم» → مقصد = آنتالیا و تبریز فقط ORIGIN است.',
    '',
    'audienceInsights:',
    '- این‌ها استنباط هستند، نه Fact. دغدغه یا رفتار مشتری را نشان می‌دهند.',
    '- هر Insight باید inferenceBasis داشته باشد: توضیح کوتاه و مشخص از اینکه چه بخشی از مکالمه از آن پشتیبانی می‌کند.',
    '- هرگز استنباط را به Fact دربارهٔ مقصد تبدیل نکن (مثلاً «مشتری درباره تمیزی زیاد پرسید» → Insight دربارهٔ مشتری است، نه «هتل‌ها تمیز نیستند»).',
    '- یک سیگنال ضعیف برای Insight کافی نیست؛ آن را حذف کن.',
    '- از زبان محدود به این تماس استفاده کن («در این تماس…»)، نه «معمولاً» یا «اکثر مسافران…».',
    '- در صورت منطقی بودن یک contentOpportunity {title, reason} برگرفته از همان دغدغه بده؛ موضوع عمومی و تصادفی نساز.',
    '',
    'کیفیت مهم‌تر از تعداد است؛ چند نکتهٔ مفید بهتر از نکات ضعیف زیاد.',
  ].join('\n'),
  CONTENT_GENERATION: [
    'شما تولیدکنندهٔ محتوای بازاریابی سفر به زبان فارسی هستید.',
    '',
    'بر اساس اطلاعاتی که در اختیار دارید یک متن روان، مفید و بدون اغراق بنویس.',
    '(این پرامپت اختیاری است و در جریان اصلی پردازش استفاده نمی‌شود.)',
  ].join('\n'),
};

function isPromptType(value: string): value is PromptType {
  return (promptTypes as readonly string[]).includes(value);
}

function toVersionInfo(row: typeof promptVersions.$inferSelect): PromptVersionInfo {
  return {
    id: row.id,
    versionNumber: row.versionNumber,
    content: row.content,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Immutable, versioned prompt management. Saves never modify old versions. */
export class PromptsService {
  /** Create the three default templates (each with one empty v1) if absent. */
  async ensureDefaultTemplates(): Promise<void> {
    const db = getDatabase();
    const now = new Date();
    for (const promptType of promptTypes) {
      const existing = await db
        .select({ id: promptTemplates.id })
        .from(promptTemplates)
        .where(eq(promptTemplates.promptType, promptType))
        .get();
      if (existing) continue;
      const inserted = await db
        .insert(promptTemplates)
        .values({
          promptType,
          displayName: PROMPT_DISPLAY_NAMES[promptType],
          createdAt: now,
        })
        .returning({ id: promptTemplates.id });
      const templateId = inserted[0]?.id;
      if (templateId == null) continue;
      // Empty v1 — never processing-ready until the user fills it in.
      await db.insert(promptVersions).values({
        promptTemplateId: templateId,
        versionNumber: 1,
        content: '',
        isActive: true,
        createdAt: now,
      });
    }
  }

  /**
   * Seed the V2 prompt bodies as new versions — but only for prompts whose
   * active version is still empty (never overwrite a user's own content).
   * Old versions are preserved in history.
   */
  async ensureV2PromptVersions(): Promise<void> {
    for (const promptType of promptTypes) {
      const active = await this.getActiveVersion(promptType);
      if (active && active.content.length > 0) continue;
      const content = V2_DEFAULT_PROMPTS[promptType];
      if (!content) continue;
      await this.saveVersion(promptType, { content });
    }
  }

  /**
   * Activate the V3 prompt bodies as new versions. Unlike V2 (which only fills
   * empty prompts), V3 supersedes the previous active version — but only when
   * the active content differs, so restarts stay idempotent and user edits are
   * never clobbered by an identical re-seed. History is always preserved.
   */
  async ensureV3PromptVersions(): Promise<void> {
    for (const promptType of promptTypes) {
      const content = V3_DEFAULT_PROMPTS[promptType];
      if (!content) continue;
      const active = await this.getActiveVersion(promptType);
      if (active && active.content === content) continue;
      await this.saveVersion(promptType, { content });
    }
  }

  async getTemplates(): Promise<PromptTemplatesResponse> {
    const db = getDatabase();
    const templates = await db.select().from(promptTemplates);
    const versions = await db.select().from(promptVersions);

    const byTemplate = new Map<number, typeof versions>();
    for (const version of versions) {
      const list = byTemplate.get(version.promptTemplateId) ?? [];
      list.push(version);
      byTemplate.set(version.promptTemplateId, list);
    }

    return templates.map((template) => {
      const templateVersions = (byTemplate.get(template.id) ?? []).sort(
        (a, b) => b.versionNumber - a.versionNumber,
      );
      const active = templateVersions.find((v) => v.isActive) ?? null;
      return {
        promptType: template.promptType as PromptType,
        displayName: template.displayName,
        activeVersion: active ? toVersionInfo(active) : null,
        versionCount: templateVersions.length,
      };
    });
  }

  async getVersions(promptType: string): Promise<PromptVersionsResponse> {
    if (!isPromptType(promptType)) {
      throw new DomainError('PROMPT_NOT_FOUND', MESSAGES.typeInvalid);
    }
    const db = getDatabase();
    const template = await this.requireTemplate(db, promptType);
    const versions = await db
      .select()
      .from(promptVersions)
      .where(eq(promptVersions.promptTemplateId, template.id))
      .orderBy(desc(promptVersions.versionNumber));

    return {
      promptType,
      displayName: template.displayName,
      versions: versions.map(toVersionInfo),
    };
  }

  /** Save a new immutable version and make it the active one. */
  async saveVersion(promptType: string, input: unknown): Promise<PromptVersionsResponse> {
    if (!isPromptType(promptType)) {
      throw new DomainError('PROMPT_NOT_FOUND', MESSAGES.typeInvalid);
    }
    const result = promptContentSchema.safeParse(input);
    if (!result.success) {
      throw new DomainError('PROMPT_INVALID', 'محتوی Prompt نامعتبر است.');
    }
    const content = result.data.content;

    const db = getDatabase();
    const template = await this.requireTemplate(db, promptType);
    const now = new Date();
    try {
      const latest = await db
        .select({ versionNumber: promptVersions.versionNumber })
        .from(promptVersions)
        .where(eq(promptVersions.promptTemplateId, template.id))
        .orderBy(desc(promptVersions.versionNumber))
        .limit(1)
        .get();

      const nextNumber = (latest?.versionNumber ?? 0) + 1;
      await db.transaction(async (tx) => {
        await tx
          .update(promptVersions)
          .set({ isActive: false })
          .where(
            and(
              eq(promptVersions.promptTemplateId, template.id),
              eq(promptVersions.isActive, true),
            ),
          );
        await tx.insert(promptVersions).values({
          promptTemplateId: template.id,
          versionNumber: nextNumber,
          content,
          isActive: true,
          createdAt: now,
        });
      });
    } catch (error) {
      throw new DomainError('DATABASE_ERROR', MESSAGES.database, { cause: error });
    }
    return this.getVersions(promptType);
  }

  /** Activate an existing version; the previous active version is deactivated. */
  async activateVersion(promptType: string, versionId: number): Promise<PromptVersionsResponse> {
    if (!isPromptType(promptType)) {
      throw new DomainError('PROMPT_NOT_FOUND', MESSAGES.typeInvalid);
    }
    const db = getDatabase();
    const template = await this.requireTemplate(db, promptType);
    try {
      const target = await db
        .select({ id: promptVersions.id })
        .from(promptVersions)
        .where(
          and(
            eq(promptVersions.promptTemplateId, template.id),
            eq(promptVersions.id, versionId),
          ),
        )
        .get();
      if (!target) {
        throw new DomainError('PROMPT_NOT_FOUND', 'نسخه موردنظر یافت نشد.');
      }
      await db.transaction(async (tx) => {
        await tx
          .update(promptVersions)
          .set({ isActive: false })
          .where(eq(promptVersions.promptTemplateId, template.id));
        await tx
          .update(promptVersions)
          .set({ isActive: true })
          .where(eq(promptVersions.id, versionId));
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('DATABASE_ERROR', MESSAGES.database, { cause: error });
    }
    return this.getVersions(promptType);
  }

  /** The active, non-empty prompt content, or null when not ready. */
  async getActivePromptContent(promptType: PromptType): Promise<string | null> {
    const active = await this.getActiveVersion(promptType);
    return active?.content ?? null;
  }

  /** The active prompt version (id + content), or null when not ready. */
  async getActiveVersion(
    promptType: PromptType,
  ): Promise<{ id: number; content: string } | null> {
    const db = getDatabase();
    const template = await db
      .select({ id: promptTemplates.id })
      .from(promptTemplates)
      .where(eq(promptTemplates.promptType, promptType))
      .get();
    if (!template) return null;
    const active = await db
      .select({ id: promptVersions.id, content: promptVersions.content })
      .from(promptVersions)
      .where(
        and(
          eq(promptVersions.promptTemplateId, template.id),
          eq(promptVersions.isActive, true),
        ),
      )
      .get();
    if (!active) return null;
    const content = active.content.trim();
    return content.length > 0 ? { id: active.id, content } : null;
  }

  private async requireTemplate(db: LibSQLDatabase<typeof import('../core/database/schema.js')>, promptType: PromptType) {
    const template = await db
      .select()
      .from(promptTemplates)
      .where(eq(promptTemplates.promptType, promptType))
      .get();
    if (!template) {
      throw new DomainError('PROMPT_NOT_FOUND', MESSAGES.notFound);
    }
    return template;
  }
}

export const promptsService = new PromptsService();
