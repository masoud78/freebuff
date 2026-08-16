import { appSettingsSchema, type AppSettings } from '@freebuff/contracts';
import { eq } from 'drizzle-orm';
import { getDatabase } from '../core/database/client.js';
import { resolveRepoRoot } from '../core/database/helpers/paths.js';
import { appSettings } from '../core/database/schema.js';
import { SettingsError } from './settings.errors.js';
import { isAbsolute, join } from 'node:path';
import { mkdirSync, statSync } from 'node:fs';

const SETTINGS_ROW_ID = 1;

export const DEFAULT_SETTINGS: AppSettings = {
  workspacePath: './workspace',
  processingConcurrency: 2,
};

const MESSAGES = {
  database: 'خطا در ذخیره تنظیمات. دوباره تلاش کنید.',
  workspaceInvalid: 'مسیر Workspace قابل استفاده نیست؛ مسیر معتبر دیگری وارد کنید.',
} as const;

/** Resolve a possibly-relative workspace path against the repository root. */
export function resolveWorkspacePath(rawPath: string): string {
  return isAbsolute(rawPath) ? rawPath : join(resolveRepoRoot(), rawPath);
}

export class SettingsService {
  /** Current settings. Falls back to defaults if no row exists yet. */
  async getSettings(): Promise<AppSettings> {
    try {
      const row = await getDatabase()
        .select({
          workspacePath: appSettings.workspacePath,
          processingConcurrency: appSettings.processingConcurrency,
        })
        .from(appSettings)
        .where(eq(appSettings.id, SETTINGS_ROW_ID))
        .get();

      if (!row) {
        return DEFAULT_SETTINGS;
      }
      return {
        workspacePath: row.workspacePath,
        processingConcurrency: row.processingConcurrency,
      };
    } catch (error) {
      throw new SettingsError('DATABASE_ERROR', MESSAGES.database, { cause: error });
    }
  }

  /**
   * Validate, check the workspace path, and persist settings.
   * Returns the saved settings.
   */
  async updateSettings(input: unknown): Promise<AppSettings> {
    const settings = this.validateSettings(input);
    this.validateWorkspacePath(settings.workspacePath);

    const now = new Date();
    try {
      await getDatabase()
        .insert(appSettings)
        .values({
          id: SETTINGS_ROW_ID,
          ...settings,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: appSettings.id,
          set: {
            workspacePath: settings.workspacePath,
            processingConcurrency: settings.processingConcurrency,
            updatedAt: now,
          },
        });
    } catch (error) {
      throw new SettingsError('DATABASE_ERROR', MESSAGES.database, { cause: error });
    }

    return settings;
  }

  /** Validate an unknown input against the shared schema. Throws on failure. */
  validateSettings(input: unknown): AppSettings {
    const result = appSettingsSchema.safeParse(input);
    if (!result.success) {
      const message = result.error.issues[0]?.message ?? 'مقادیر واردشده معتبر نیستند.';
      throw new SettingsError('SETTINGS_VALIDATION_ERROR', message);
    }
    return result.data;
  }

  /** Create the settings row with defaults if it does not exist yet. */
  async ensureDefaultSettings(): Promise<void> {
    const existing = await getDatabase()
      .select({ id: appSettings.id })
      .from(appSettings)
      .where(eq(appSettings.id, SETTINGS_ROW_ID))
      .get();

    if (!existing) {
      const now = new Date();
      await getDatabase().insert(appSettings).values({
        id: SETTINGS_ROW_ID,
        ...DEFAULT_SETTINGS,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  /**
   * Ensure the workspace path is usable: create it if missing and verify it is
   * a directory. Throws WORKSPACE_PATH_INVALID on failure.
   */
  private validateWorkspacePath(rawPath: string): void {
    const resolved = resolveWorkspacePath(rawPath);
    try {
      mkdirSync(resolved, { recursive: true });
      if (!statSync(resolved).isDirectory()) {
        throw new Error(`${resolved} is not a directory`);
      }
    } catch (error) {
      throw new SettingsError('WORKSPACE_PATH_INVALID', MESSAGES.workspaceInvalid, { cause: error });
    }
  }
}

export const settingsService = new SettingsService();
