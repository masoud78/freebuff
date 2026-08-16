import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import * as schema from './schema.js';
import { DatabaseError } from './helpers/errors.js';
import { resolveDatabasePath } from './helpers/paths.js';

export interface DatabaseConfig {
  /** SQLite database file path. Defaults to `<repo>/workspace/system/database/app.db`. */
  path?: string;
}

/** SQLite pragmas applied to every connection, tuned for a local application. */
const DEFAULT_PRAGMAS = [
  'PRAGMA foreign_keys = ON',
  'PRAGMA journal_mode = WAL',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA synchronous = NORMAL',
] as const;

let client: Client | undefined;
let database: LibSQLDatabase<typeof schema> | undefined;

/**
 * Open the SQLite connection (creating parent directories and the file if
 * needed), apply pragmas and build the Drizzle instance. Singleton: repeated
 * calls return the existing instance.
 */
export async function initClient(config: DatabaseConfig = {}): Promise<LibSQLDatabase<typeof schema>> {
  if (database) {
    return database;
  }

  const path = config.path ?? resolveDatabasePath();

  try {
    mkdirSync(dirname(path), { recursive: true });
    const sqlite = createClient({ url: `file:${path}` });
    for (const pragma of DEFAULT_PRAGMAS) {
      await sqlite.execute(pragma);
    }
    client = sqlite;
    database = drizzle(sqlite, { schema });
    return database;
  } catch (error) {
    throw new DatabaseError(`Failed to open SQLite database at ${path}`, { cause: error });
  }
}

/** Raw libsql client. Throws if the database was not initialized. */
export function getClient(): Client {
  if (!client) {
    throw new DatabaseError('Database is not initialized. Call initClient() first.');
  }
  return client;
}

/** Drizzle database instance. Throws if the database was not initialized. */
export function getDatabase(): LibSQLDatabase<typeof schema> {
  if (!database) {
    throw new DatabaseError('Database is not initialized. Call initClient() first.');
  }
  return database;
}

/** Close the connection and reset the singleton (used by tests and scripts). */
export async function closeDatabase(): Promise<void> {
  await client?.close();
  client = undefined;
  database = undefined;
}
