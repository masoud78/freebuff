import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ApiError } from '@google/genai';
import type { FastifyReply } from 'fastify';
import type { GeminiModelInfo, ModelStage } from '@freebuff/contracts';
import { buildApp } from '../app.js';
import { closeDatabase, initDatabase } from '../core/database/index.js';
import { toErrorResponse } from '../routes/error-response.js';
import { DomainError } from './errors.js';
import { GeminiService } from './gemini/gemini.service.js';
import {
  GeminiGatewayError,
  toGeminiGatewayError,
  type GeminiGatewayLike,
} from './gemini/gateway.js';
import { modelsService } from './models.service.js';
import { promptsService } from './prompts.service.js';
import { readinessService } from './readiness.service.js';

let dir: string;

const MOCK_MODELS: GeminiModelInfo[] = [
  {
    id: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    description: 'Fast generative model with audio support',
    capabilities: { generative: true, embedding: false, audio: true },
  },
  {
    id: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    description: 'Large generative model',
    capabilities: { generative: true, embedding: false, audio: false },
  },
  {
    id: 'text-embedding-004',
    displayName: 'Text Embedding',
    description: 'Embedding model',
    capabilities: { generative: false, embedding: true, audio: false },
  },
];

class MockGateway implements GeminiGatewayLike {
  constructor(
    private readonly models: GeminiModelInfo[],
    private readonly failTest = false,
  ) {}

  async testConnection(): Promise<void> {
    if (this.failTest) {
      // Emulate the real gateway contract: normalized errors only.
      throw toGeminiGatewayError(new ApiError({ status: 401, message: 'unauthorized' }));
    }
  }

  async listModels(): Promise<GeminiModelInfo[]> {
    return this.models;
  }

  async transcribeAudio(): Promise<never> {
    throw new Error('not used in this test suite');
  }

  async analyzeKnowledge(): Promise<never> {
    throw new Error('not used in this test suite');
  }
}

function isDomainError(error: unknown, code: string): boolean {
  return error instanceof DomainError && error.code === code;
}

const geminiService = new GeminiService(new MockGateway(MOCK_MODELS));

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'freebuff-phase5-test-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.GEMINI_CREDENTIALS_FILE = join(dir, 'gemini.key');
  await initDatabase();
  await promptsService.ensureDefaultTemplates();
});

after(async () => {
  await closeDatabase();
  delete process.env.DB_PATH;
  delete process.env.GEMINI_CREDENTIALS_FILE;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may hold the SQLite handle; temp dirs are harmless.
  }
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

test('credential status is NOT_CONFIGURED without a key', async () => {
  const status = await geminiService.getCredentialStatus();
  assert.equal(status.status, 'NOT_CONFIGURED');
  assert.equal(status.lastTestedAt, null);
});

test('credential save makes status CONFIGURED and persists the key', async () => {
  await geminiService.saveApiKey('test-secret-key-123');
  const status = await geminiService.getCredentialStatus();
  assert.equal(status.status, 'CONFIGURED');
});

test('API key is never returned by any endpoint', async () => {
  const app = buildApp({ loggerOptions: { level: 'silent' } });

  const credential = await app.inject({ method: 'GET', url: '/api/gemini/credential' });
  assert.equal(credential.statusCode, 200);
  const credentialBody = JSON.stringify(credential.json());
  assert.ok(!credentialBody.includes('test-secret-key-123'), 'credential endpoint leaked the key');

  const settings = await app.inject({ method: 'GET', url: '/api/settings' });
  const settingsBody = JSON.stringify(settings.json());
  assert.ok(!settingsBody.includes('test-secret-key-123'), 'settings endpoint leaked the key');
});

test('credential DELETE clears the key', async () => {
  const app = buildApp({ loggerOptions: { level: 'silent' } });
  const response = await app.inject({ method: 'DELETE', url: '/api/gemini/credential' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'NOT_CONFIGURED');
});

test('test connection requires a configured credential', async () => {
  await geminiService.deleteCredential();
  await assert.rejects(
    () => geminiService.testConnection(),
    (error) => isDomainError(error, 'GEMINI_NOT_CONFIGURED'),
  );
  await geminiService.saveApiKey('test-secret-key-123');
});

test('successful connection test records outcome and timestamp', async () => {
  await geminiService.testConnection();
  const status = await geminiService.getCredentialStatus();
  assert.equal(status.lastTestOutcome, 'success');
  assert.ok(status.lastTestedAt !== null);
});

test('failed connection test normalizes the error and marks the credential INVALID', async () => {
  const failing = new GeminiService(new MockGateway(MOCK_MODELS, true));
  await failing.saveApiKey('bad-key-xyz');
  await assert.rejects(
    () => failing.testConnection(),
    (error) => error instanceof GeminiGatewayError && error.code === 'GEMINI_AUTH_ERROR',
  );
  const status = await failing.getCredentialStatus();
  assert.equal(status.status, 'INVALID');
  assert.equal(status.lastTestOutcome, 'auth_error');
});

test('gemini errors map to controlled 400 API responses', () => {
  const codes: number[] = [];
  const reply = {
    code: (status: number) => {
      codes.push(status);
      return reply;
    },
  } as unknown as FastifyReply;
  const response = toErrorResponse(
    reply,
    new GeminiGatewayError('GEMINI_AUTH_ERROR', 'کلید API نامعتبر است.'),
  );
  assert.deepEqual(codes, [400]);
  assert.deepEqual(response, {
    error: { code: 'GEMINI_AUTH_ERROR', message: 'کلید API نامعتبر است.' },
  });
});

// ---------------------------------------------------------------------------
// Gemini error normalization
// ---------------------------------------------------------------------------

test('gemini errors are normalized to stable codes', () => {
  const cases: Array<[unknown, string]> = [
    [new ApiError({ status: 401, message: 'unauthorized' }), 'GEMINI_AUTH_ERROR'],
    [
      new ApiError({
        status: 400,
        message: '{"error":{"message":"API key not valid. Please pass a valid API key."}}',
      }),
      'GEMINI_AUTH_ERROR',
    ],
    [new ApiError({ status: 429, message: 'rate limit exceeded' }), 'GEMINI_RATE_LIMIT'],
    [new ApiError({ status: 500, message: 'internal error' }), 'GEMINI_API_ERROR'],
    [
      new TypeError('fetch failed', { cause: new Error('ECONNREFUSED connect') }),
      'GEMINI_NETWORK_ERROR',
    ],
    [new Error('boom'), 'GEMINI_API_ERROR'],
  ];
  for (const [error, expected] of cases) {
    const normalized = toGeminiGatewayError(error);
    assert.ok(normalized instanceof GeminiGatewayError);
    assert.equal(normalized.code, expected);
  }
});

test('normalized errors never contain the API key', () => {
  const key = 'supersecretkey-98765';
  const normalized = toGeminiGatewayError(
    new ApiError({ status: 401, message: `invalid key ${key}` }),
  );
  assert.ok(!normalized.message.includes(key));
});

// ---------------------------------------------------------------------------
// Model discovery cache
// ---------------------------------------------------------------------------

test('refreshing models populates the local cache', async () => {
  const response = await geminiService.refreshModels();
  assert.equal(response.models.length, MOCK_MODELS.length);
  assert.ok(response.refreshedAt !== null);
  const cached = await geminiService.getCachedModels();
  assert.equal(cached.models.length, MOCK_MODELS.length);
});

// ---------------------------------------------------------------------------
// Model configuration
// ---------------------------------------------------------------------------

test('model configs can be saved and persist', async () => {
  const assignments: Array<[ModelStage, string]> = [
    ['TRANSCRIPTION', 'gemini-2.5-flash'],
    ['KNOWLEDGE_PROCESSING', 'gemini-2.5-pro'],
    ['CONTENT_GENERATION', 'gemini-2.5-flash'],
    ['EMBEDDING', 'text-embedding-004'],
  ];
  for (const [stage, modelId] of assignments) {
    const saved = await modelsService.updateModelConfig({ stage, modelId });
    assert.equal(saved.provider, 'GEMINI');
    assert.equal(saved.modelId, modelId);
    assert.equal(saved.available, true);
  }

  const configs = await modelsService.getModelConfigs();
  assert.equal(configs.length, 4);
  for (const [stage, modelId] of assignments) {
    const config = configs.find((c) => c.stage === stage);
    assert.equal(config?.modelId, modelId);
    assert.equal(config?.available, true);
  }
});

test('invalid model config is rejected', async () => {
  // Unknown model id.
  await assert.rejects(
    () => modelsService.updateModelConfig({ stage: 'EMBEDDING', modelId: 'nope-123' }),
    (error) => isDomainError(error, 'MODEL_CONFIG_INVALID'),
  );
  // Capability mismatch: generative model for the embedding stage.
  await assert.rejects(
    () => modelsService.updateModelConfig({ stage: 'EMBEDDING', modelId: 'gemini-2.5-pro' }),
    (error) => isDomainError(error, 'MODEL_CONFIG_INVALID'),
  );
  // Invalid stage.
  await assert.rejects(
    () => modelsService.updateModelConfig({ stage: 'BOGUS', modelId: 'gemini-2.5-pro' }),
    (error) => isDomainError(error, 'MODEL_CONFIG_INVALID'),
  );
});

// ---------------------------------------------------------------------------
// Prompt versioning
// ---------------------------------------------------------------------------

test('three default prompt templates are seeded', async () => {
  const templates = await promptsService.getTemplates();
  assert.equal(templates.length, 3);
  for (const template of templates) {
    assert.equal(template.versionCount, 1);
    assert.ok(template.activeVersion);
  }
});

test('saving a prompt creates a new version instead of editing', async () => {
  const result = await promptsService.saveVersion('TRANSCRIPTION', { content: 'متن نسخه دوم' });
  assert.equal(result.versions.length, 2);
  assert.equal(result.versions[0]?.versionNumber, 2);
  assert.equal(result.versions[0]?.isActive, true);
  assert.equal(result.versions[1]?.versionNumber, 1);
  assert.equal(result.versions[1]?.isActive, false);
});

test('only one prompt version can be active', async () => {
  await promptsService.saveVersion('TRANSCRIPTION', { content: 'متن نسخه سوم' });
  const result = await promptsService.getVersions('TRANSCRIPTION');
  const active = result.versions.filter((v) => v.isActive);
  assert.equal(active.length, 1);
  assert.equal(active[0]?.versionNumber, 3);
  assert.equal(result.versions.length, 3);
});

test('a previous version can be reactivated', async () => {
  const versions = await promptsService.getVersions('TRANSCRIPTION');
  const v1 = versions.versions.find((v) => v.versionNumber === 1);
  assert.ok(v1);
  const result = await promptsService.activateVersion('TRANSCRIPTION', v1.id);
  const active = result.versions.filter((v) => v.isActive);
  assert.equal(active.length, 1);
  assert.equal(active[0]?.id, v1.id);
});

test('prompt history is preserved across saves', async () => {
  const result = await promptsService.getVersions('TRANSCRIPTION');
  assert.equal(result.versions.length, 3);
  const contents = result.versions.map((v) => v.content);
  assert.deepEqual(new Set(contents).size, 3, 'all versions keep distinct content');
});

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

test('readiness is not ready before full configuration', async () => {
  // Prompts are still empty and two stages use models — fill prompts first,
  // then check that knowledge/embedding gaps make readiness false.
  await promptsService.saveVersion('TRANSCRIPTION', { content: 'پرامپت تبدیل صوت' });
  await promptsService.saveVersion('KNOWLEDGE_PROCESSING', { content: 'پرامپت پردازش دانش' });
  await promptsService.saveVersion('CONTENT_GENERATION', { content: 'پرامپت تولید محتوا' });

  // Remove the embedding config temporarily to prove readiness reacts.
  const db = (await import('../core/database/index.js')).getDatabase();
  const { modelConfigs } = await import('../core/database/schema.js');
  const { eq } = await import('drizzle-orm');
  await db.delete(modelConfigs).where(eq(modelConfigs.stage, 'EMBEDDING'));
  const partial = await readinessService.getReadiness();
  assert.equal(partial.ready, false);
  const embedding = partial.checks.find((c) => c.key === 'model_embedding');
  assert.equal(embedding?.ready, false);
});

test('readiness is ready when everything is configured', async () => {
  await modelsService.updateModelConfig({ stage: 'EMBEDDING', modelId: 'text-embedding-004' });
  const result = await readinessService.getReadiness();
  assert.equal(result.ready, true);
  for (const check of result.checks) {
    assert.equal(check.ready, true, `check ${check.key} should be ready`);
  }
});

test('an empty active prompt makes readiness false', async () => {
  await promptsService.saveVersion('CONTENT_GENERATION', { content: '' });
  const result = await readinessService.getReadiness();
  assert.equal(result.ready, false);
  const contentCheck = result.checks.find((c) => c.key === 'prompt_content_generation');
  assert.equal(contentCheck?.ready, false);
});
