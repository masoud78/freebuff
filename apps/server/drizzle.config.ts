import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineConfig } from 'drizzle-kit';

// The database file lives outside this package, at the repo root:
// <repo>/workspace/system/database/app.db. Ensure the directory exists
// before any tool (generate/migrate/studio) opens the file.
const databaseDir = join(process.cwd(), '..', 'workspace', 'system', 'database');
mkdirSync(databaseDir, { recursive: true });

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/core/database/schema.ts',
  out: './src/core/database/migrations',
  dbCredentials: {
    url: pathToFileURL(join(databaseDir, 'app.db')).href,
  },
});
