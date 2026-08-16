import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveRepoRoot } from '../../core/database/helpers/paths.js';

const DEFAULT_CREDENTIALS_FILE = () =>
  join(resolveRepoRoot(), 'workspace', 'system', 'secrets', 'gemini.key');

/**
 * Stores the Gemini API key outside the business database and outside git.
 * The key is never exposed through any API — only its presence/validity is.
 */
export class CredentialStore {
  /** Resolve the credentials file path (env override for tests). */
  private resolvePath(): string {
    return process.env.GEMINI_CREDENTIALS_FILE ?? DEFAULT_CREDENTIALS_FILE();
  }

  async getKey(): Promise<string | null> {
    const path = this.resolvePath();
    try {
      const key = readFileSync(path, 'utf8').trim();
      return key.length > 0 ? key : null;
    } catch {
      return null;
    }
  }

  async saveKey(key: string): Promise<void> {
    const path = this.resolvePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, key.trim(), { mode: 0o600 });
  }

  async deleteKey(): Promise<void> {
    const path = this.resolvePath();
    try {
      rmSync(path, { force: true });
    } catch {
      // Key file already absent — nothing to do.
    }
  }
}

export const credentialStore = new CredentialStore();
