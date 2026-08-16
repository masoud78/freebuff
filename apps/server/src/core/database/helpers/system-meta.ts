import { eq } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { systemMeta } from '../schema.js';

type Schema = typeof import('../schema.js');
type Database = LibSQLDatabase<Schema>;

/** Read a system_meta value, or null when the key is absent. */
export async function getMeta(db: Database, key: string): Promise<string | null> {
  const row = await db
    .select({ value: systemMeta.value })
    .from(systemMeta)
    .where(eq(systemMeta.key, key))
    .get();
  return row?.value ?? null;
}

/** Upsert a system_meta value. */
export async function setMeta(db: Database, key: string, value: string): Promise<void> {
  const now = new Date();
  await db
    .insert(systemMeta)
    .values({ key, value, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: systemMeta.key,
      set: { value, updatedAt: now },
    });
}
