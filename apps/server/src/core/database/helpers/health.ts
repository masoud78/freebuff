import { sql } from 'drizzle-orm';
import { getDatabase } from '../client.js';
import { DatabaseError } from './errors.js';

/**
 * Run a real, minimal query against the database. A live connection object
 * alone does not prove the database is usable — this executes `SELECT 1`.
 *
 * Throws `DatabaseError` if the database is not usable.
 */
export async function checkDatabaseHealth(): Promise<void> {
  try {
    await getDatabase().get(sql`select 1 as ok`);
  } catch (error) {
    throw new DatabaseError('Database health check failed', { cause: error });
  }
}
