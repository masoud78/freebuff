import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseError } from './errors.js';

/** Resolve the repository root (the directory containing `pnpm-workspace.yaml`). */
export function resolveRepoRoot(start = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new DatabaseError(
    `Could not locate the repository root (pnpm-workspace.yaml) from ${start}`,
  );
}

/** Absolute path of the SQLite database file. Override with the DB_PATH env var. */
export function resolveDatabasePath(): string {
  return process.env.DB_PATH ?? join(resolveRepoRoot(), 'workspace', 'system', 'database', 'app.db');
}

/**
 * Absolute path of the Drizzle migrations folder.
 * Resolved relative to this module, so it works both from source (tsx) and
 * from the build output (dist), where the folder is copied by the build step.
 */
export function resolveMigrationsFolder(): string {
  return fileURLToPath(new URL('../migrations', import.meta.url));
}
