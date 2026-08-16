import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createClient } from '@libsql/client';
import { buildApp } from '../app.js';
import { closeDatabase, initDatabase } from '../core/database/index.js';
import { SettingsError } from './settings.errors.js';
import { DEFAULT_SETTINGS, settingsService } from './settings.service.js';

let dir: string;
let dbPath: string;

function isSettingsError(error: unknown, code: string): boolean {
  return error instanceof SettingsError && error.code === code;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'freebuff-settings-test-'));
  dbPath = join(dir, 'test.db');
  process.env.DB_PATH = dbPath;
  await initDatabase();
  await settingsService.ensureDefaultSettings();
});

after(async () => {
  await closeDatabase();
  delete process.env.DB_PATH;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may hold the SQLite handle; temp dirs are harmless.
  }
});

test('default settings load correctly', async () => {
  const settings = await settingsService.getSettings();
  assert.deepEqual(settings, DEFAULT_SETTINGS);
});

test('invalid concurrency is rejected', () => {
  for (const processingConcurrency of [0, 11, 2.5, '2', undefined]) {
    assert.throws(
      () =>
        settingsService.validateSettings({
          workspacePath: './workspace',
          processingConcurrency,
        }),
      (error) => isSettingsError(error, 'SETTINGS_VALIDATION_ERROR'),
    );
  }
});

test('invalid workspace path returns controlled error', async () => {
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'not a directory');
  await assert.rejects(
    () =>
      settingsService.updateSettings({
        workspacePath: join(blocker, 'sub'),
        processingConcurrency: 2,
      }),
    (error) => isSettingsError(error, 'WORKSPACE_PATH_INVALID'),
  );
});

test('valid settings can be saved', async () => {
  const target = join(dir, 'ws');
  const updated = await settingsService.updateSettings({
    workspacePath: target,
    processingConcurrency: 4,
  });
  assert.deepEqual(updated, { workspacePath: target, processingConcurrency: 4 });
  assert.ok(existsSync(target), 'workspace directory should be created');
});

test('settings persist in database', async () => {
  // Values survive across connections to the same file.
  const client = createClient({ url: `file:${dbPath}` });
  try {
    const rows = await client.execute('SELECT workspace_path, processing_concurrency FROM app_settings WHERE id = 1');
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]?.['workspace_path'], join(dir, 'ws'));
    assert.equal(rows.rows[0]?.['processing_concurrency'], 4);
  } finally {
    client.close();
  }

  // Values survive a "restart": close the connection, re-initialize, re-read.
  await closeDatabase();
  await initDatabase();
  const reloaded = await settingsService.getSettings();
  assert.deepEqual(reloaded, { workspacePath: join(dir, 'ws'), processingConcurrency: 4 });
});

test('GET /api/settings returns current settings', async () => {
  const app = buildApp({ loggerOptions: { level: 'silent' } });
  const response = await app.inject({ method: 'GET', url: '/api/settings' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { workspacePath: join(dir, 'ws'), processingConcurrency: 4 });
});

test('PUT /api/settings updates settings', async () => {
  const app = buildApp({ loggerOptions: { level: 'silent' } });
  const response = await app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { workspacePath: join(dir, 'ws2'), processingConcurrency: 3 },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { workspacePath: join(dir, 'ws2'), processingConcurrency: 3 });
  assert.ok(existsSync(join(dir, 'ws2')));
});

test('PUT /api/settings rejects invalid concurrency with a controlled error', async () => {
  const app = buildApp({ loggerOptions: { level: 'silent' } });
  const response = await app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { workspacePath: './workspace', processingConcurrency: 42 },
  });
  assert.equal(response.statusCode, 400);
  const body = response.json();
  assert.equal(body.error?.code, 'SETTINGS_VALIDATION_ERROR');
  assert.ok(typeof body.error?.message === 'string');
});

test('PUT /api/settings rejects an unusable workspace path', async () => {
  const app = buildApp({ loggerOptions: { level: 'silent' } });
  const response = await app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { workspacePath: join(dir, 'blocker', 'sub'), processingConcurrency: 2 },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error?.code, 'WORKSPACE_PATH_INVALID');
});
