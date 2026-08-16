/**
 * Standalone CLI entry that applies pending Drizzle migrations.
 * Used by `pnpm db:migrate`; runs the same code path as server startup.
 */
import { initDatabase, closeDatabase } from './index.js';

try {
  await initDatabase();
  console.log('Database migrations applied.');
} catch (error) {
  console.error('Migration failed:', error);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
