import { test, beforeEach, afterEach, expect, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLlmRouter } from './routes/llm.js';
import { saveProviderConfig } from './llm/config.js';

let server: Server;
let base: string;
let tmpDir: string;
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-forge-llm-'));
  process.env.PROVIDER_CONFIG_PATH = path.join(tmpDir, 'provider.json');
  delete process.env.PF_LLM_API_KEY;

  mockFetch = vi.fn();
  const app = express();
  app.use(express.json());
  app.use('/api/llm', createLlmRouter({ fetchImpl: mockFetch as unknown as typeof fetch }));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function chat(providerId: string, messages?: unknown) {
  const res = await fetch(`${base}/api/llm/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      providerId,
      messages: messages ?? [{ role: 'user', content: 'Hi' }],
    }),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function title(content?: unknown) {
  const res = await fetch(`${base}/api/llm/title`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

test('ollama provider posts without auth header', async () => {
  saveProviderConfig({
    local: { kind: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
    cloud: { kind: 'openai-compatible', baseUrl: '', model: '' },
  });
  mockFetch.mockResolvedValue(
    new Response(
      JSON.stringify({ choices: [{ message: { content: 'pong' } }], model: 'llama3.1' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );

  const { status, data } = await chat('local');
  expect(status).toBe(200);
  expect(data.content).toBe('pong');

  const [url, init] = mockFetch.mock.calls[0];
  expect(url).toBe('http://localhost:11434/v1/chat/completions');
  expect(init.headers).not.toHaveProperty('Authorization');
  expect(JSON.parse(init.body).model).toBe('llama3.1');
  expect(JSON.parse(init.body).options).toEqual({ num_gpu: -1 });
});

test('ollama baseUrl without /v1 is normalized', async () => {
  saveProviderConfig({
    local: { kind: 'ollama', baseUrl: 'http://localhost:11434', model: 'llama3.1' },
    cloud: { kind: 'openai-compatible', baseUrl: '', model: '' },
  });
  mockFetch.mockResolvedValue(
    new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  await chat('local');
  const [url] = mockFetch.mock.calls[0];
  expect(url).toBe('http://localhost:11434/v1/chat/completions');
});

test('openai-compatible provider sends Bearer key from config', async () => {
  saveProviderConfig({
    local: { kind: 'ollama', baseUrl: '', model: '' },
    cloud: {
      kind: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-secret',
    },
  });
  mockFetch.mockResolvedValue(
    new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  await chat('cloud');
  const [url, init] = mockFetch.mock.calls[0];
  expect(url).toBe('https://api.example.com/v1/chat/completions');
  expect(init.headers.Authorization).toBe('Bearer sk-secret');
  expect(JSON.parse(init.body).options).toBeUndefined();
});

test('PF_LLM_API_KEY env var overrides stored key', async () => {
  process.env.PF_LLM_API_KEY = 'sk-env';
  saveProviderConfig({
    local: { kind: 'ollama', baseUrl: '', model: '' },
    cloud: {
      kind: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-stored',
    },
  });
  mockFetch.mockResolvedValue(
    new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  await chat('cloud');
  const [, init] = mockFetch.mock.calls[0];
  expect(init.headers.Authorization).toBe('Bearer sk-env');
});

test('openai-compatible without key is rejected', async () => {
  saveProviderConfig({
    local: { kind: 'ollama', baseUrl: '', model: '' },
    cloud: { kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'gpt-4o-mini' },
  });
  const { status, data } = await chat('cloud');
  expect(status).toBe(400);
  expect(data.error).toContain('api key');
  expect(mockFetch).not.toHaveBeenCalled();
});

test('upstream error is mapped to 502', async () => {
  saveProviderConfig({
    local: { kind: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
    cloud: { kind: 'openai-compatible', baseUrl: '', model: '' },
  });
  mockFetch.mockResolvedValue(new Response('rate limited', { status: 429 }));
  const { status, data } = await chat('local');
  expect(status).toBe(502);
  expect(data.error).toContain('429');
});

test('invalid providerId and messages are rejected', async () => {
  const badProvider = await chat('mars');
  expect(badProvider.status).toBe(400);

  const badMessages = await chat('local', 'not-an-array');
  expect(badMessages.status).toBe(400);
});

test('title generation prefers cloud provider when configured', async () => {
  saveProviderConfig({
    local: { kind: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
    cloud: {
      kind: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-secret',
    },
  });
  mockFetch.mockResolvedValue(
    new Response(
      JSON.stringify({ choices: [{ message: { content: '"邮件写作助手"' } }], model: 'gpt-4o-mini' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );

  const { status, data } = await title('请帮我写一封产品发布邮件');
  expect(status).toBe(200);
  expect(data.title).toBe('邮件写作助手');
  expect(data.model).toBe('gpt-4o-mini');

  const [url, init] = mockFetch.mock.calls[0];
  expect(url).toBe('https://api.example.com/v1/chat/completions');
  expect(init.headers.Authorization).toBe('Bearer sk-secret');
  const sent = JSON.parse(init.body);
  expect(sent.messages[0].role).toBe('system');
  expect(sent.messages[1].content).toBe('请帮我写一封产品发布邮件');
});

test('title generation falls back to local provider when cloud missing', async () => {
  saveProviderConfig({
    local: { kind: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
    cloud: { kind: 'openai-compatible', baseUrl: '', model: '' },
  });
  mockFetch.mockResolvedValue(
    new Response(
      JSON.stringify({ choices: [{ message: { content: '产品发布邮件' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );

  const { status, data } = await title('请帮我写一封产品发布邮件');
  expect(status).toBe(200);
  expect(data.title).toBe('产品发布邮件');
  expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:11434/v1/chat/completions');
});

test('title generation truncates and strips quotes', async () => {
  saveProviderConfig({
    local: { kind: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
    cloud: { kind: 'openai-compatible', baseUrl: '', model: '' },
  });
  mockFetch.mockResolvedValue(
    new Response(
      JSON.stringify({ choices: [{ message: { content: '「' + '很'.repeat(80) + '」' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );

  const { status, data } = await title('x');
  expect(status).toBe(200);
  expect(data.title).toHaveLength(50);
  expect(data.title.startsWith('「')).toBe(false);
  expect(data.title.endsWith('」')).toBe(false);
});

test('title generation rejects missing content and unconfigured providers', async () => {
  const empty = await title('');
  expect(empty.status).toBe(400);

  saveProviderConfig({
    local: { kind: 'ollama', baseUrl: '', model: '' },
    cloud: { kind: 'openai-compatible', baseUrl: '', model: '' },
  });
  const unconfigured = await title('hello');
  expect(unconfigured.status).toBe(400);
  expect(mockFetch).not.toHaveBeenCalled();
});
