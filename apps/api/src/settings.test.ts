import { test, beforeEach, afterEach, expect } from 'vitest';
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

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-forge-settings-'));
  process.env.PROVIDER_CONFIG_PATH = path.join(tmpDir, 'provider.json');
  delete process.env.PF_LLM_API_KEY;

  const app = express();
  app.use(express.json());
  app.use('/api/settings', createSettingsRouter());
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
