import { migrate } from 'drizzle-orm/libsql/migrator';
import { initClient, getClient, getDatabase, closeDatabase } from './client.js';
import { DatabaseError } from './helpers/errors.js';
import { resolveMigrationsFolder } from './helpers/paths.js';

/**
 * Initialize the database connection, apply SQLite pragmas and run pending
 * migrations. Called once at server startup; throws `DatabaseError` if the
 * database is not usable so startup fails loudly.
 */
export async function initDatabase(): Promise<void> {
  const db = await initClient();
  try {
    await migrate(db, { migrationsFolder: resolveMigrationsFolder() });
  } catch (error) {
    throw new DatabaseError('Database migrations failed', { cause: error });
  }
}

export { getClient, getDatabase, closeDatabase };
export { DatabaseError } from './helpers/errors.js';
