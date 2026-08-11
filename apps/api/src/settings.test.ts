import { test, beforeEach, afterEach, expect, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSettingsRouter } from './routes/settings.js';
import { loadProviderConfig } from './llm/config.js';

let server: Server;
let base: string;
let tmpDir: string;
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-forge-settings-'));
  process.env.PROVIDER_CONFIG_PATH = path.join(tmpDir, 'provider.json');
  process.env.PROMPTS_CONFIG_PATH = path.join(tmpDir, 'prompts.json');
  delete process.env.PF_LLM_API_KEY;

  mockFetch = vi.fn();
  const app = express();
  app.use(express.json());
  app.use(
    '/api/settings',
    createSettingsRouter({ fetchImpl: mockFetch as unknown as typeof fetch }),
  );
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function request(method: string, body?: unknown) {
  const res = await fetch(`${base}/api/settings/provider`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function requestModels(body: unknown) {
  const res = await fetch(`${base}/api/settings/provider/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function requestPrompts(method: string, body?: unknown) {
  const res = await fetch(`${base}/api/settings/prompts`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

test('returns defaults and never exposes apiKey', async () => {
  const { status, data } = await request('GET');
  expect(status).toBe(200);
  expect(data.providers.local.kind).toBe('ollama');
  expect(data.providers.local.baseUrl).toBe('http://localhost:11434/v1');
  expect(data.providers.local.hasApiKey).toBe(false);
  expect(JSON.stringify(data)).not.toContain('sk-');
});

test('saves config, persists apiKey, GET hides it', async () => {
  const put = await request('PUT', {
    providers: {
      local: {
        kind: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        model: 'qwen2.5',
        apiKey: '',
      },
      cloud: {
        kind: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-4o-mini',
        apiKey: 'sk-super-secret',
      },
    },
  });
  expect(put.status).toBe(200);
  expect(put.data.providers.cloud.hasApiKey).toBe(true);

  const stored = loadProviderConfig();
  expect(stored.cloud.apiKey).toBe('sk-super-secret');
  expect(stored.local.apiKey).toBeUndefined();

  const get = await request('GET');
  expect(get.data.providers.cloud.hasApiKey).toBe(true);
  expect(get.data.providers.cloud.apiKey).toBeUndefined();
  expect(JSON.stringify(get.data)).not.toContain('sk-super-secret');
});

test('blank apiKey keeps the stored key', async () => {
  await request('PUT', {
    providers: {
      cloud: {
        kind: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-4o-mini',
        apiKey: 'sk-keep-me',
      },
    },
  });
  const second = await request('PUT', {
    providers: {
      cloud: {
        kind: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-4o-mini',
        apiKey: '',
      },
    },
  });
  expect(second.status).toBe(200);
  expect(loadProviderConfig().cloud.apiKey).toBe('sk-keep-me');
});

test('rejects invalid kind and empty baseUrl', async () => {
  const badKind = await request('PUT', {
    providers: { local: { kind: 'wat', baseUrl: 'http://x', model: 'm' } },
  });
  expect(badKind.status).toBe(400);

  const emptyBase = await request('PUT', {
    providers: { local: { kind: 'ollama', baseUrl: '', model: 'm' } },
  });
  expect(emptyBase.status).toBe(400);
});

test('config file is written with mode 0600', async () => {
  await request('PUT', {
    providers: {
      cloud: { kind: 'openai-compatible', baseUrl: 'https://x', model: 'm', apiKey: 'k' },
    },
  });
  const configPath = process.env.PROVIDER_CONFIG_PATH!;
  expect(fs.existsSync(configPath)).toBe(true);
  if (process.platform !== 'win32') {
    const mode = fs.statSync(configPath).mode & 0o777;
    expect(mode).toBe(0o600);
  }
});

test('models endpoint parses OpenAI-style /models response', async () => {
  mockFetch.mockResolvedValue(
    new Response(
      JSON.stringify({
        object: 'list',
        data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );

  const { status, data } = await requestModels({
    id: 'cloud',
    kind: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
  });

  expect(status).toBe(200);
  expect(data.models).toEqual(['gpt-4o', 'gpt-4o-mini']);

  const calledUrl = mockFetch.mock.calls[0][0];
  expect(calledUrl).toBe('https://api.example.com/v1/models');
  const headers = mockFetch.mock.calls[0][1].headers;
  expect(headers.Authorization).toBe('Bearer sk-test');
});

test('models endpoint appends /v1 for ollama and parses models array', async () => {
  mockFetch.mockResolvedValue(
    new Response(
      JSON.stringify({ models: [{ name: 'llama3.1' }, { name: 'qwen2.5' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );

  const { status, data } = await requestModels({
    id: 'local',
    kind: 'ollama',
    baseUrl: 'http://localhost:11434',
  });

  expect(status).toBe(200);
  expect(data.models).toEqual(['llama3.1', 'qwen2.5']);
  const calledUrl = mockFetch.mock.calls[0][0];
  expect(calledUrl).toBe('http://localhost:11434/v1/models');
});

test('models endpoint uses stored key when apiKey is blank', async () => {
  await request('PUT', {
    providers: {
      cloud: {
        kind: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        model: 'm',
        apiKey: 'sk-stored',
      },
    },
  });
  mockFetch.mockResolvedValue(
    new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 }),
  );

  const { status } = await requestModels({
    id: 'cloud',
    kind: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    apiKey: '',
  });
  expect(status).toBe(200);
  const headers = mockFetch.mock.calls[0][1].headers;
  expect(headers.Authorization).toBe('Bearer sk-stored');
});

test('models endpoint returns 502 on upstream failure', async () => {
  mockFetch.mockResolvedValue(new Response('unauthorized', { status: 401 }));
  const { status, data } = await requestModels({
    id: 'cloud',
    kind: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
  });
  expect(status).toBe(502);
  expect(String(data.error)).toContain('401');
});

test('models endpoint validates baseUrl and kind', async () => {
  const noBase = await requestModels({ kind: 'openai-compatible', baseUrl: '' });
  expect(noBase.status).toBe(400);

  const badKind = await requestModels({ kind: 'wat', baseUrl: 'https://x' });
  expect(badKind.status).toBe(400);
});

test('prompts settings returns empty default category by default', async () => {
  const { status, data } = await requestPrompts('GET');
  expect(status).toBe(200);
  expect(data).toEqual({ defaultCategory: '' });
});

test('prompts settings saves and reads back default category', async () => {
  const put = await requestPrompts('PUT', { defaultCategory: 'NSFW' });
  expect(put.status).toBe(200);
  expect(put.data).toEqual({ defaultCategory: 'NSFW' });

  const get = await requestPrompts('GET');
  expect(get.data).toEqual({ defaultCategory: 'NSFW' });
});

test('prompts settings trims and clears default category', async () => {
  const put = await requestPrompts('PUT', { defaultCategory: '  writing  ' });
  expect(put.status).toBe(200);
  expect(put.data).toEqual({ defaultCategory: 'writing' });

  const clear = await requestPrompts('PUT', { defaultCategory: '' });
  expect(clear.status).toBe(200);
  expect(clear.data).toEqual({ defaultCategory: '' });
});

test('prompts settings rejects invalid payloads', async () => {
  const nonString = await requestPrompts('PUT', { defaultCategory: 42 });
  expect(nonString.status).toBe(400);

  const tooLong = await requestPrompts('PUT', { defaultCategory: 'x'.repeat(51) });
  expect(tooLong.status).toBe(400);
});
