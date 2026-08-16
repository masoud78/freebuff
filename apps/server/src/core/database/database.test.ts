import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { initDatabase, getClient, getDatabase, closeDatabase } from './index.js';
import { checkDatabaseHealth } from './helpers/health.js';

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'freebuff-db-test-'));
  process.env.DB_PATH = join(dir, 'test.db');
  await initDatabase();
});

after(async () => {
  await closeDatabase();
  delete process.env.DB_PATH;
  // The @libsql native client on Windows holds the SQLite file handles for the
  // process lifetime, so the temp dir may stay locked. Best-effort cleanup;
  // leftover dirs under the OS temp folder are harmless.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore — handle still held by the native library
  }
});

test('SQLite pragmas are applied', async () => {
  const client = getClient();
  const foreignKeys = await client.execute('PRAGMA foreign_keys');
  const journalMode = await client.execute('PRAGMA journal_mode');
  const synchronous = await client.execute('PRAGMA synchronous');
  assert.equal(foreignKeys.rows[0]?.['foreign_keys'], 1);
  assert.equal(journalMode.rows[0]?.['journal_mode'], 'wal');
  assert.equal(synchronous.rows[0]?.['synchronous'], 1);
});

test('health check runs a real query', async () => {
  await checkDatabaseHealth();
});

test('system_meta table exists after migration', async () => {
  const client = getClient();
  const rows = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='system_meta'",
  );
  assert.equal(rows.rows.length, 1);
});

test('database accessors return a singleton', () => {
  assert.equal(getDatabase(), getDatabase());
  assert.equal(getClient(), getClient());
});
