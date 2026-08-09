import { test, beforeEach, afterEach, expect, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';
import type { ConversationMessage, MessageContentPart } from '@prompt-forge/shared';
import { parseSseStream } from '@prompt-forge/shared';
import { createDb } from './db/index.js';
import { ConversationRepository } from './db/conversations.js';
import { PromptRepository } from './db/prompts.js';
import { createWorkshopRouter } from './routes/workshop.js';
import { saveProviderConfig, saveVisionConfig } from './llm/config.js';
import { saveSearchConfig } from './search/config.js';
import { loadWorkshopConfig } from './workshop/config.js';

let server: Server;
let base: string;
let tmpDir: string;
let db: Database.Database;
let repo: ConversationRepository;
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-forge-workshop-'));
  process.env.DB_PATH = path.join(tmpDir, 'test.db');
  process.env.PROVIDER_CONFIG_PATH = path.join(tmpDir, 'provider.json');
  process.env.WORKSHOP_CONFIG_PATH = path.join(tmpDir, 'workshop.json');
  delete process.env.PF_LLM_API_KEY;

  db = createDb();
  repo = new ConversationRepository(db);
  mockFetch = vi.fn();
  const app = express();
  app.use(express.json());
  app.use(
    '/api/workshop',
    createWorkshopRouter(repo, {
      fetchImpl: mockFetch as unknown as typeof fetch,
      workshopConfig: loadWorkshopConfig(),
    }),
  );
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  server.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function waitFor(fn: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function request(method: string, url: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function createConversation(body?: unknown) {
  return request('POST', `${base}/api/workshop/conversations`, body ?? {});
}

async function readSse(url: string, body: unknown): Promise<Record<string, unknown>[]> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const events: Record<string, unknown>[] = [];
  if (res.body) {
    for await (const data of parseSseStream(res.body)) {
      events.push(JSON.parse(data) as Record<string, unknown>);
    }
  }
  return events;
}

async function chat(conversationId: string, body?: unknown) {
  return readSse(`${base}/api/workshop/conversations/${conversationId}/chat`, body ?? { content: 'a cat' });
}

async function reverse(conversationId: string, body?: unknown) {
  return readSse(
    `${base}/api/workshop/conversations/${conversationId}/reverse`,
    body ?? { images: ['data:image/jpeg;base64,/9j/4AAQ=='] },
  );
}

function sseUpstream(chunks: string[], model = 'llama3.1'): Response {
  const encoder = new TextEncoder();
  const parts = chunks.map(
    (c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }], model })}\n\n`,
  );
  parts.push('data: [DONE]\n\n');
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(parts.join('')));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function configureLocal() {
  saveProviderConfig({
    local: { kind: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
    cloud: { kind: 'openai-compatible', baseUrl: '', model: '' },
  });
}

function configureVision() {
  saveVisionConfig({
    kind: 'ollama',
    baseUrl: 'http://localhost:9999/v1',
    model: 'llava',
  });
}

function mockVisionAndMain(
  visionContent = '参考图 1：一只橘猫坐在窗台上',
  mainChunks: string[] = ['ok'],
) {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('9999')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ message: { content: visionContent } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    return Promise.resolve(sseUpstream(mainChunks));
  });
}

function toolCallStream(calls: { id: string; name: string; args: string }[]): Response {
  const encoder = new TextEncoder();
  const parts = calls.map((c, idx) =>
    c.id
      ? `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: idx,
                    id: c.id,
                    type: 'function',
                    function: { name: c.name },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        })}\n\n`
      : '',
  );
  for (const c of calls) {
    parts.push(
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: calls.indexOf(c),
                  function: { arguments: c.args },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })}\n\n`,
    );
  }
  parts.push('data: [DONE]\n\n');
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(parts.join('')));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function searchOkResponse(): Response {
  return new Response(
    JSON.stringify({
      results: [{ title: 'T', url: 'https://x.com', content: 'some content' }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

test('conversation CRUD and cascade delete of messages', async () => {
  const created = await createConversation({
    title: 'First',
    providerId: 'local',
    presetId: 'mj',
  });
  expect(created.status).toBe(201);
  expect(created.data.providerId).toBe('local');
  expect(created.data.presetId).toBe('mj');
  expect(created.data.messages).toBeUndefined();

  const list = await request('GET', `${base}/api/workshop/conversations`);
  expect(list.status).toBe(200);
  expect(list.data).toHaveLength(1);
  expect(list.data[0].id).toBe(created.data.id);

  const got = await request('GET', `${base}/api/workshop/conversations/${created.data.id}`);
  expect(got.status).toBe(200);
  expect(got.data.messages).toEqual([]);

  repo.appendMessage(created.data.id, 'user', 'hello');
  repo.appendMessage(created.data.id, 'assistant', 'world');

  const updated = await request('PUT', `${base}/api/workshop/conversations/${created.data.id}`, {
    title: 'Renamed',
    presetId: 'plain',
  });
  expect(updated.status).toBe(200);
  expect(updated.data.title).toBe('Renamed');
  expect(updated.data.presetId).toBe('plain');

  const del = await request('DELETE', `${base}/api/workshop/conversations/${created.data.id}`);
  expect(del.status).toBe(204);
  expect(repo.listMessages(created.data.id)).toEqual([]);
  const gone = await request('GET', `${base}/api/workshop/conversations/${created.data.id}`);
  expect(gone.status).toBe(404);
});

test('list filters by promptId and defaults providerId/presetId', async () => {
  const prompts = new PromptRepository(db);
  const prompt = prompts.create({ title: 'p', content: 'x' });

  await createConversation({ promptId: prompt.id, title: 'A' });
  await createConversation({ promptId: prompt.id, title: 'B' });
  const other = await createConversation({ title: 'C' });

  expect(other.data.providerId).toBe('cloud');
  expect(other.data.presetId).toBe('tags');

  const filtered = await request(
    'GET',
    `${base}/api/workshop/conversations?promptId=${prompt.id}`,
  );
  expect(filtered.status).toBe(200);
  expect(filtered.data).toHaveLength(2);

  const all = await request('GET', `${base}/api/workshop/conversations`);
  expect(all.data).toHaveLength(3);
});

test('create rejects invalid providerId, presetId and unknown promptId', async () => {
  const badProvider = await createConversation({ providerId: 'mars' });
  expect(badProvider.status).toBe(400);

  const badPreset = await createConversation({ presetId: 'wat' });
  expect(badPreset.status).toBe(400);

  const badPrompt = await createConversation({ promptId: 'no-such-prompt' });
  expect(badPrompt.status).toBe(400);
});

test('chat streams SSE chunks and persists user + assistant messages', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local' });
  mockFetch.mockResolvedValue(sseUpstream(['a cat', ' wearing ', 'a hat']));

  const events = await chat(conv.id, {
    content: 'draw a cat',
    currentPrompt: 'old prompt',
  });

  expect(events.map((e) => e.type)).toEqual(['chunk', 'chunk', 'chunk', 'done']);
  const text = events
    .filter((e) => e.type === 'chunk')
    .map((e) => e.text)
    .join('');
  expect(text).toBe('a cat wearing a hat');
  const done = events.find((e) => e.type === 'done');
  expect(done?.content).toBe('a cat wearing a hat');
  expect(done?.model).toBe('llama3.1');

  const [url, init] = mockFetch.mock.calls[0];
  expect(url).toBe('http://localhost:11434/v1/chat/completions');
  const sent = JSON.parse(init.body) as {
    messages: { role: string; content: string }[];
  };
  expect(sent.messages[0].role).toBe('system');
  expect(sent.messages[0].content).toContain('old prompt');
  expect(sent.messages[0].content).toContain('masterpiece');
  expect(sent.messages.at(-1)).toEqual({ role: 'user', content: 'draw a cat' });

  const messages = repo.listMessages(conv.id);
  expect(messages.map((m: ConversationMessage) => m.role)).toEqual(['user', 'assistant']);
  expect(messages[1].content).toBe('a cat wearing a hat');
});

test('chat sets SSE headers for real-time proxying', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local' });
  mockFetch.mockResolvedValue(sseUpstream(['ok']));

  const res = await fetch(`${base}/api/workshop/conversations/${conv.id}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'x' }),
  });
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  expect(res.headers.get('cache-control')).toBe('no-cache');
  expect(res.headers.get('x-accel-buffering')).toBe('no');
  await res.body?.cancel();
});

test('chat rejects oversized content and currentPrompt', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local' });

  const bigContent = await request(
    'POST',
    `${base}/api/workshop/conversations/${conv.id}/chat`,
    { content: 'x'.repeat(8001) },
  );
  expect(bigContent.status).toBe(400);
  expect(bigContent.data.error).toContain('at most');
  expect(mockFetch).not.toHaveBeenCalled();

  const bigPrompt = await request(
    'POST',
    `${base}/api/workshop/conversations/${conv.id}/chat`,
    { content: 'x', currentPrompt: 'y'.repeat(20_001) },
  );
  expect(bigPrompt.status).toBe(400);
  expect(mockFetch).not.toHaveBeenCalled();
});

test('chat sends history without duplicating the new user message', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local' });
  mockFetch.mockResolvedValue(sseUpstream(['reply one']));
  await chat(conv.id, { content: 'first' });

  mockFetch.mockResolvedValue(sseUpstream(['reply two']));
  await chat(conv.id, { content: 'second' });

  const [, init] = mockFetch.mock.calls[1];
  const sent = JSON.parse(init.body) as { messages: { role: string }[] };
  expect(sent.messages.map((m) => m.role)).toEqual([
    'system',
    'user',
    'assistant',
    'user',
  ]);
});

test('preset mj system prompt carries parameter instructions', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local', presetId: 'mj' });
  mockFetch.mockResolvedValue(sseUpstream(['ok']));
  await chat(conv.id, { content: 'x', currentPrompt: 'current thing' });

  const [, init] = mockFetch.mock.calls[0];
  const sent = JSON.parse(init.body) as { messages: { content: string }[] };
  expect(sent.messages[0].content).toContain('--ar');
  expect(sent.messages[0].content).toContain('current thing');
});

test('extraSystemPrompt is persisted via PUT, validated, and injected into system message', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local' });

  const tooLong = await request('PUT', `${base}/api/workshop/conversations/${conv.id}`, {
    extraSystemPrompt: 'x'.repeat(4001),
  });
  expect(tooLong.status).toBe(400);

  const updated = await request('PUT', `${base}/api/workshop/conversations/${conv.id}`, {
    extraSystemPrompt: 'always include a strong rim light',
  });
  expect(updated.status).toBe(200);
  expect(updated.data.extraSystemPrompt).toBe('always include a strong rim light');

  mockFetch.mockResolvedValue(sseUpstream(['ok']));
  await chat(conv.id, { content: 'x', currentPrompt: 'base prompt' });
  const [, init] = mockFetch.mock.calls[0];
  const sent = JSON.parse(init.body) as { messages: { content: string }[] };
  const system = sent.messages[0].content;
  expect(system).toContain('always include a strong rim light');
  expect(system).toContain('base prompt');
  expect(system).toMatch(/base prompt[\s\S]*always include a strong rim light/);

  mockFetch.mockResolvedValue(sseUpstream(['ok']));
  await chat(conv.id, { content: 'y' });
  const [, init2] = mockFetch.mock.calls[1];
  const sent2 = JSON.parse(init2.body) as { messages: { content: string }[] };
  expect(sent2.messages[0].content).toContain('always include a strong rim light');
});

test('empty extraSystemPrompt is not injected into system message', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local' });
  mockFetch.mockResolvedValue(sseUpstream(['ok']));
  await chat(conv.id, { content: 'x', currentPrompt: 'p' });

  const [, init] = mockFetch.mock.calls[0];
  const sent = JSON.parse(init.body) as { messages: { content: string }[] };
  const system = sent.messages[0].content;
  expect(system).toContain('p');
  expect(system).not.toContain('extraSystemPrompt');
});

test('chat errors: missing conversation, empty content, unconfigured providers', async () => {
  const missing = await request('POST', `${base}/api/workshop/conversations/nope/chat`, {
    content: 'x',
  });
  expect(missing.status).toBe(404);

  saveProviderConfig({
    local: { kind: 'ollama', baseUrl: '', model: '' },
    cloud: { kind: 'openai-compatible', baseUrl: '', model: '' },
  });
  const { data: conv } = await createConversation();
  const { data: localConv } = await createConversation({ providerId: 'local' });

  const empty = await request('POST', `${base}/api/workshop/conversations/${conv.id}/chat`, {
    content: '   ',
  });
  expect(empty.status).toBe(400);
  expect(empty.data.error).toContain('content');

  const noBase = await request(
    'POST',
    `${base}/api/workshop/conversations/${localConv.id}/chat`,
    { content: 'x' },
  );
  expect(noBase.status).toBe(400);
  expect(noBase.data.error).toContain('missing baseUrl');
  expect(mockFetch).not.toHaveBeenCalled();

  saveProviderConfig({
    local: { kind: 'ollama', baseUrl: '', model: '' },
    cloud: { kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'm' },
  });
  const noKey = await request('POST', `${base}/api/workshop/conversations/${conv.id}/chat`, {
    content: 'x',
  });
  expect(noKey.status).toBe(400);
  expect(noKey.data.error).toContain('api key');
  expect(mockFetch).not.toHaveBeenCalled();
});

test('upstream non-200 emits error event and rolls back the user message', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local' });
  mockFetch.mockResolvedValue(new Response('rate limited', { status: 429 }));

  const events = await chat(conv.id, { content: 'x' });
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe('error');
  expect(String(events[0].message)).toContain('429');

  const messages = repo.listMessages(conv.id);
  expect(messages).toEqual([]);
});

test('empty upstream reply rolls back the user message and emits an error event', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local' });
  mockFetch.mockResolvedValue(sseUpstream([]));

  const events = await chat(conv.id, { content: 'x' });
  expect(events.map((e) => e.type)).toEqual(['error']);
  expect(String(events[0].message)).toContain('empty');
  expect(repo.listMessages(conv.id)).toEqual([]);
});

test('upstream JSON response is downgraded to a single chunk', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local' });
  mockFetch.mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [{ message: { content: 'plain answer' } }],
        model: 'llama3.1',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );

  const events = await chat(conv.id, { content: 'x' });
  expect(events.map((e) => e.type)).toEqual(['chunk', 'done']);
  expect(events[0].text).toBe('plain answer');

  const messages = repo.listMessages(conv.id);
  expect(messages[1].content).toBe('plain answer');
});

test('client disconnect aborts upstream and removes the pending user message', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local' });
  mockFetch.mockImplementation(
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal | undefined;
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      }),
  );

  const ctrl = new AbortController();
  const p = fetch(`${base}/api/workshop/conversations/${conv.id}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'hello' }),
    signal: ctrl.signal,
  }).catch(() => null);

  await waitFor(() => mockFetch.mock.calls.length > 0);
  expect(repo.listMessages(conv.id)).toHaveLength(1);

  ctrl.abort();
  await p;
  await waitFor(() => repo.listMessages(conv.id).length === 0);
});

test('rollback on disconnect deletes only the request\'s own user message', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local' });
  repo.appendMessage(conv.id, 'assistant', 'previous reply');
  mockFetch.mockImplementation(
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal | undefined;
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      }),
  );

  const ctrl = new AbortController();
  const p = fetch(`${base}/api/workshop/conversations/${conv.id}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'new question' }),
    signal: ctrl.signal,
  }).catch(() => null);

  await waitFor(() => mockFetch.mock.calls.length > 0);
  expect(repo.listMessages(conv.id)).toHaveLength(2);

  ctrl.abort();
  await p;
  await waitFor(() => repo.listMessages(conv.id).length === 1);
  const remaining = repo.listMessages(conv.id);
  expect(remaining[0].role).toBe('assistant');
  expect(remaining[0].content).toBe('previous reply');
});

test('multimodal message sends image_url when images provided', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local' });
  mockFetch.mockResolvedValue(sseUpstream(['ok']));

  const fakeImage = 'data:image/jpeg;base64,/9j/4AAQ==';
  await chat(conv.id, { content: 'describe this', images: [fakeImage] });

  const [, init] = mockFetch.mock.calls[0];
  const sent = JSON.parse(init.body) as {
    messages: { role: string; content: unknown }[];
  };
  const lastMsg = sent.messages.at(-1);
  expect(Array.isArray(lastMsg?.content)).toBe(true);
  const parts = lastMsg!.content as { type: string; image_url?: { url: string } }[];
  const imagePart = parts.find((p) => p.type === 'image_url');
  expect(imagePart?.image_url?.url).toBe(fakeImage);

  const messages = repo.listMessages(conv.id);
  const userMsg = messages.find((m: ConversationMessage) => m.role === 'user') as ConversationMessage;
  expect(userMsg.multimodalContent).not.toBeNull();
  expect(userMsg.multimodalContent![0].image_url.url).toBe(fakeImage);
});

test('multimodal message validates images array', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local' });

  const bad = await request(
    'POST',
    `${base}/api/workshop/conversations/${conv.id}/chat`,
    { content: 'x', images: ['not-an-image', 123] },
  );
  expect(bad.status).toBe(400);
  expect(bad.data.error).toContain('images');

  const tooMany = await request(
    'POST',
    `${base}/api/workshop/conversations/${conv.id}/chat`,
    {
      content: 'x',
      images: Array.from({ length: 6 }, () => 'data:image/png;base64,xx'),
    },
  );
  expect(tooMany.status).toBe(400);
  expect(tooMany.data.error).toContain('images');
});

test('vision bridge converts images to text description for main model', async () => {
  configureLocal();
  configureVision();
  mockVisionAndMain();
  const { data: conv } = await createConversation({ providerId: 'local' });

  const fakeImage = 'data:image/jpeg;base64,/9j/4AAQ==';
  await chat(conv.id, { content: 'describe this', images: [fakeImage] });

  expect(mockFetch.mock.calls.length).toBe(2);
  const [visionUrl, visionInit] = mockFetch.mock.calls[0];
  expect(String(visionUrl)).toContain('9999');
  const visionBody = JSON.parse(String(visionInit.body)) as {
    messages: { role: string; content: unknown }[];
  };
  expect(Array.isArray(visionBody.messages.at(-1)?.content)).toBe(true);

  const [, mainInit] = mockFetch.mock.calls[1];
  const sent = JSON.parse(String(mainInit.body)) as {
    messages: { role: string; content: unknown }[];
  };
  const lastMsg = sent.messages.at(-1)!;
  expect(typeof lastMsg.content).toBe('string');
  expect(lastMsg.content as string).toContain('[参考图描述]');
  expect(lastMsg.content as string).toContain('一只橘猫坐在窗台上');
  const hasImagePart = sent.messages.some(
    (m) =>
      Array.isArray(m.content) &&
      (m.content as { type: string }[]).some((p) => p.type === 'image_url'),
  );
  expect(hasImagePart).toBe(false);

  const messages = repo.listMessages(conv.id);
  const userMsg = messages.find((m: ConversationMessage) => m.role === 'user') as ConversationMessage;
  expect(userMsg.content).toContain('[参考图描述]');
  expect(userMsg.multimodalContent).not.toBeNull();
});

test('chat emits a vision status event while describing images', async () => {
  configureLocal();
  configureVision();
  mockVisionAndMain();
  const { data: conv } = await createConversation({ providerId: 'local' });

  const events = await chat(conv.id, {
    content: 'describe this',
    images: ['data:image/jpeg;base64,/9j/4AAQ=='],
  });

  const visionEvents = events.filter((e) => e.type === 'vision');
  expect(visionEvents.length).toBeGreaterThan(0);
  expect(visionEvents[0].status).toBe('describing');
  expect(events.at(-1)?.type).toBe('done');
});

test('chat skips the vision status event when history images already carry the marker', async () => {
  configureLocal();
  configureVision();
  mockVisionAndMain('参考图 1：一只橘猫坐在窗台上', ['增强后的提示词']);
  const { data: conv } = await createConversation({ providerId: 'local' });
  const fakeImage = 'data:image/jpeg;base64,/9j/4AAQ==';

  await reverse(conv.id, { images: [fakeImage] });
  expect(mockFetch.mock.calls.length).toBe(2);

  mockVisionAndMain();
  const events = await chat(conv.id, { content: 'follow up' });

  expect(events.filter((e) => e.type === 'vision')).toHaveLength(0);
  expect(mockFetch.mock.calls.length).toBe(3);
  const [, mainInit] = mockFetch.mock.calls[2];
  const sent = JSON.parse(String(mainInit.body)) as {
    messages: { role: string; content: unknown }[];
  };
  expect(
    sent.messages.some(
      (m) =>
        Array.isArray(m.content) &&
        (m.content as { type: string }[]).some((p) => p.type === 'image_url'),
    ),
  ).toBe(false);
});

test('vision bridge describes history images without marker', async () => {
  configureLocal();
  mockFetch.mockResolvedValue(sseUpstream(['ok']));
  const { data: conv } = await createConversation({ providerId: 'local' });

  const fakeImage = 'data:image/jpeg;base64,/9j/4AAQ==';
  await chat(conv.id, { content: 'first question', images: [fakeImage] });
  expect(mockFetch.mock.calls.length).toBe(1);

  configureVision();
  mockVisionAndMain();
  await chat(conv.id, { content: 'follow up' });

  expect(mockFetch.mock.calls.length).toBe(3);
  const [, mainInit] = mockFetch.mock.calls[2];
  const sent = JSON.parse(String(mainInit.body)) as {
    messages: { role: string; content: unknown }[];
  };
  const historyUser = sent.messages.find(
    (m) => m.role === 'user' && typeof m.content === 'string' && (m.content as string).includes('first question'),
  );
  expect(historyUser).toBeDefined();
  expect(historyUser!.content as string).toContain('[参考图描述]');
  const hasImagePart = sent.messages.some(
    (m) =>
      Array.isArray(m.content) &&
      (m.content as { type: string }[]).some((p) => p.type === 'image_url'),
  );
  expect(hasImagePart).toBe(false);
});

test('vision bridge skips history messages already containing marker', async () => {
  configureLocal();
  configureVision();
  mockVisionAndMain();
  const { data: conv } = await createConversation({ providerId: 'local' });

  const fakeImage = 'data:image/jpeg;base64,/9j/4AAQ==';
  await chat(conv.id, { content: 'first question', images: [fakeImage] });
  expect(mockFetch.mock.calls.length).toBe(2);

  mockVisionAndMain();
  await chat(conv.id, { content: 'follow up' });

  expect(mockFetch.mock.calls.length).toBe(3);
  const [, mainInit] = mockFetch.mock.calls[2];
  const sent = JSON.parse(String(mainInit.body)) as {
    messages: { role: string; content: unknown }[];
  };
  const historyUser = sent.messages.find(
    (m) => m.role === 'user' && typeof m.content === 'string' && (m.content as string).includes('first question'),
  );
  expect(historyUser).toBeDefined();
  expect(historyUser!.content as string).toContain('[参考图描述]');
});

test('vision bridge falls back to sending images when vision fails', async () => {
  configureLocal();
  configureVision();
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('9999')) {
      return Promise.resolve(new Response('vision down', { status: 500 }));
    }
    return Promise.resolve(sseUpstream(['ok']));
  });
  const { data: conv } = await createConversation({ providerId: 'local' });

  const fakeImage = 'data:image/jpeg;base64,/9j/4AAQ==';
  await chat(conv.id, { content: 'describe this', images: [fakeImage] });

  expect(mockFetch.mock.calls.length).toBe(2);
  const [, mainInit] = mockFetch.mock.calls[1];
  const sent = JSON.parse(String(mainInit.body)) as {
    messages: { role: string; content: unknown }[];
  };
  const lastMsg = sent.messages.at(-1)!;
  expect(Array.isArray(lastMsg.content)).toBe(true);
  const parts = lastMsg.content as { type: string; image_url?: { url: string } }[];
  const imagePart = parts.find((p) => p.type === 'image_url');
  expect(imagePart?.image_url?.url).toBe(fakeImage);
});

test('vision bridge abort during describe does not leave orphan messages', async () => {
  configureLocal();
  configureVision();
  mockFetch.mockImplementation(
    (url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      }),
  );
  const { data: conv } = await createConversation({ providerId: 'local' });

  const ctrl = new AbortController();
  const p = fetch(`${base}/api/workshop/conversations/${conv.id}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: 'x',
      images: ['data:image/jpeg;base64,/9j/4AAQ=='],
    }),
    signal: ctrl.signal,
  }).catch(() => null);

  await waitFor(() => mockFetch.mock.calls.length > 0);
  ctrl.abort();
  await p;
  await waitFor(() => repo.listMessages(conv.id).length === 0);
  expect(repo.listMessages(conv.id)).toHaveLength(0);
});

test('reverse: vision describe then main model enhance streams result', async () => {
  configureLocal();
  configureVision();
  mockVisionAndMain('参考图 1：一只橘猫坐在窗台上', ['增强后的提示词']);
  const { data: conv } = await createConversation({ providerId: 'local' });

  const events = await reverse(conv.id);

  expect(events.at(-1)?.type).toBe('done');
  expect(events.at(-1)?.content).toContain('增强后的提示词');
  expect(mockFetch.mock.calls.length).toBe(2);

  const [visionUrl] = mockFetch.mock.calls[0];
  expect(String(visionUrl)).toContain('9999');

  const [, mainInit] = mockFetch.mock.calls[1];
  expect(String(mockFetch.mock.calls[1][0])).toContain('11434');
  const sent = JSON.parse(String(mainInit.body)) as {
    messages: { role: string; content: unknown }[];
  };
  expect(sent.messages[0].role).toBe('system');
  expect(sent.messages[0].content as string).toContain('主体');
  expect(sent.messages[0].content as string).toContain('光影');
  const userMsg = sent.messages.at(-1)!;
  expect(userMsg.content as string).toContain('一只橘猫坐在窗台上');

  const messages = repo.listMessages(conv.id);
  expect(messages).toHaveLength(2);
  expect(messages[0].role).toBe('user');
  expect(messages[0].content).toContain('反推提示词');
  expect(messages[0].content).toContain('[参考图描述]');
  expect(messages[0].content).toContain('一只橘猫坐在窗台上');
  expect(messages[0].multimodalContent).not.toBeNull();
  expect(messages[1].role).toBe('assistant');
  expect(messages[1].content).toContain('增强后的提示词');
});

test('reverse persists the vision description so later chats skip re-describing', async () => {
  configureLocal();
  configureVision();
  mockVisionAndMain('参考图 1：一只橘猫坐在窗台上', ['增强后的提示词']);
  const { data: conv } = await createConversation({ providerId: 'local' });

  await reverse(conv.id);
  expect(mockFetch.mock.calls.length).toBe(2);

  mockVisionAndMain();
  const events = await chat(conv.id, { content: 'make it shorter' });

  expect(events.at(-1)?.type).toBe('done');
  expect(mockFetch.mock.calls.length).toBe(3);
  const [, mainInit] = mockFetch.mock.calls[2];
  const sent = JSON.parse(String(mainInit.body)) as {
    messages: { role: string; content: unknown }[];
  };
  const reverseMsg = sent.messages.find(
    (m) => m.role === 'user' && typeof m.content === 'string' && (m.content as string).includes('反推提示词'),
  );
  expect(reverseMsg).toBeDefined();
  expect(reverseMsg!.content as string).toContain('一只橘猫坐在窗台上');
  const hasImagePart = sent.messages.some(
    (m) =>
      Array.isArray(m.content) &&
      (m.content as { type: string }[]).some((p) => p.type === 'image_url'),
  );
  expect(hasImagePart).toBe(false);
});

test('reverse: rejects when vision model not configured', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local' });

  const res = await fetch(`${base}/api/workshop/conversations/${conv.id}/reverse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images: ['data:image/jpeg;base64,/9j/4AAQ=='] }),
  });
  const data = (await res.json()) as { error?: string };
  expect(res.status).toBe(400);
  expect(data.error).toContain('识图模型');
  expect(mockFetch).not.toHaveBeenCalled();
});

test('reverse: rejects invalid or empty images', async () => {
  configureLocal();
  configureVision();
  const { data: conv } = await createConversation({ providerId: 'local' });

  const bad = await request(
    'POST',
    `${base}/api/workshop/conversations/${conv.id}/reverse`,
    { images: ['not-an-image'] },
  );
  expect(bad.status).toBe(400);

  const empty = await request(
    'POST',
    `${base}/api/workshop/conversations/${conv.id}/reverse`,
    { images: [] },
  );
  expect(empty.status).toBe(400);
  expect(empty.data.error).toContain('non-empty');
  expect(mockFetch).not.toHaveBeenCalled();
});

test('reverse: rolls back user message when main model fails', async () => {
  configureLocal();
  configureVision();
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('9999')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ message: { content: '描述' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    return Promise.resolve(new Response('boom', { status: 500 }));
  });
  const { data: conv } = await createConversation({ providerId: 'local' });

  const events = await reverse(conv.id);

  expect(events.at(-1)?.type).toBe('error');
  expect(mockFetch.mock.calls.length).toBe(2);
  expect(repo.listMessages(conv.id)).toHaveLength(0);
});

test('enableSearch toggle is persisted via PUT', async () => {
  const { data: conv } = await createConversation();
  expect(conv.enableSearch).toBe(false);

  const on = await request('PUT', `${base}/api/workshop/conversations/${conv.id}`, {
    enableSearch: true,
  });
  expect(on.status).toBe(200);
  expect(on.data.enableSearch).toBe(true);

  const off = await request('PUT', `${base}/api/workshop/conversations/${conv.id}`, {
    enableSearch: false,
  });
  expect(off.status).toBe(200);
  expect(off.data.enableSearch).toBe(false);
});

test('chat request includes tools when enableSearch=true', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local' });
  await request('PUT', `${base}/api/workshop/conversations/${conv.id}`, {
    enableSearch: true,
  });
  mockFetch.mockResolvedValue(sseUpstream(['ok']));

  await chat(conv.id, { content: 'x' });

  const [, init] = mockFetch.mock.calls[0];
  const sent = JSON.parse(init.body) as { tools?: unknown[] };
  expect(sent.tools).toBeDefined();
  expect((sent.tools as { function: { name: string } }[])[0].function.name).toBe('search_web');
});

test('system message tells the model about search_web when enableSearch=true', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local' });
  await request('PUT', `${base}/api/workshop/conversations/${conv.id}`, {
    enableSearch: true,
  });
  mockFetch.mockResolvedValue(sseUpstream(['ok']));

  await chat(conv.id, { content: 'x' });

  const [, init] = mockFetch.mock.calls[0];
  const sent = JSON.parse(init.body) as { messages: { role: string; content: string }[] };
  expect(sent.messages[0].content).toContain('search_web');
  expect(sent.messages[0].content).toContain('Never say you cannot search');

  const toolChoice = JSON.parse(init.body) as { tool_choice?: unknown };
  expect(toolChoice.tool_choice).toBe('auto');
});

test('system message omits search_web hint when enableSearch=false', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local' });
  mockFetch.mockResolvedValue(sseUpstream(['ok']));

  await chat(conv.id, { content: 'x' });

  const [, init] = mockFetch.mock.calls[0];
  const sent = JSON.parse(init.body) as { messages: { content: string }[] };
  expect(sent.messages[0].content).not.toContain('search_web');
});

test('chat request omits tools when enableSearch=false', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local' });
  mockFetch.mockResolvedValue(sseUpstream(['ok']));

  await chat(conv.id, { content: 'x' });

  const [, init] = mockFetch.mock.calls[0];
  const sent = JSON.parse(init.body) as { tools?: unknown[] };
  expect(sent.tools).toBeUndefined();
});

test('function calling: tool_call triggers search and second round', async () => {
  configureLocal();
  saveSearchConfig({ provider: 'tavily', apiKey: 'test-key' });
  process.env.PF_SEARCH_API_KEY = 'test-key';

  const { data: conv } = await createConversation({ providerId: 'local' });
  await request('PUT', `${base}/api/workshop/conversations/${conv.id}`, {
    enableSearch: true,
  });

  const encoder = new TextEncoder();

  const round1Stream = new ReadableStream({
    start(controller) {
      const chunks = [
        [
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search_web' } }] } }],
          }),
        ],
        [
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query"' } }] } }],
          }),
        ],
        [
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"cyberpunk trends"' } }] } }],
          }),
        ],
        [
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] }, finish_reason: 'tool_calls' }],
          }),
        ],
      ];
      for (const c of chunks) {
        controller.enqueue(encoder.encode(`data: ${c}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  const round2Stream = sseUpstream([' neon ', 'lights']);

  mockFetch
    .mockResolvedValueOnce(
      new Response(round1Stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [
            { title: 'Trends', url: 'https://x.com', content: 'Neon lights are trending' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    .mockResolvedValueOnce(round2Stream);

  const events = await chat(conv.id, { content: 'cyberpunk style' });

  expect(events.map((e) => e.type)).toEqual([
    'tool_search',
    'chunk',
    'chunk',
    'done',
  ]);
  expect(events[0].query).toBe('cyberpunk trends');
  const done = events.find((e) => e.type === 'done');
  expect(done?.content).toBe(' neon lights');

  const messages = repo.listMessages(conv.id);
  const roles = messages.map((m: ConversationMessage) => m.role);
  expect(roles).toContain('tool');
  expect(roles).toContain('assistant');
});

test('function calling without search_web tool name does not trigger search', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local' });
  await request('PUT', `${base}/api/workshop/conversations/${conv.id}`, {
    enableSearch: true,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const chunk = JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_2',
                  type: 'function',
                  function: { name: 'some_other', arguments: '{}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      });
      controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  mockFetch.mockResolvedValue(
    new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  );

  const events = await chat(conv.id, { content: 'x' });
  const types = events.map((e) => e.type);
  expect(types).not.toContain('tool_search');
});

test('search API error is handled gracefully in tool result', async () => {
  configureLocal();
  saveSearchConfig({ provider: 'tavily', apiKey: 'bad-key' });
  process.env.PF_SEARCH_API_KEY = 'test-key';

  const { data: conv } = await createConversation({ providerId: 'local' });
  await request('PUT', `${base}/api/workshop/conversations/${conv.id}`, {
    enableSearch: true,
  });

  const encoder = new TextEncoder();
  const round1Stream = new ReadableStream({
    start(controller) {
      const chunk = JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_3',
                  type: 'function',
                  function: { name: 'search_web', arguments: '{"query":"test"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      });
      controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  mockFetch
    .mockResolvedValueOnce(
      new Response(round1Stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    )
    .mockResolvedValueOnce(
      new Response('Tavily API error', { status: 500 }),
    )
    .mockResolvedValueOnce(sseUpstream(['fallback response']));

  const events = await chat(conv.id, { content: 'x' });
  expect(events.map((e) => e.type)).toEqual([
    'tool_search',
    'chunk',
    'done',
  ]);
  expect(events.find((e) => e.type === 'done')?.content).toBeDefined();
});

test('multiple tool_calls each get a corresponding tool message', async () => {
  configureLocal();
  saveSearchConfig({ provider: 'tavily', apiKey: 'test-key' });
  process.env.PF_SEARCH_API_KEY = 'test-key';
  const { data: conv } = await createConversation({ providerId: 'local' });
  await request('PUT', `${base}/api/workshop/conversations/${conv.id}`, {
    enableSearch: true,
  });

  mockFetch
    .mockResolvedValueOnce(
      toolCallStream([
        { id: 'call_a', name: 'search_web', args: '{"query":"trends"}' },
        { id: 'call_b', name: 'search_web', args: '{"query":"styles"}' },
      ]),
    )
    .mockResolvedValueOnce(searchOkResponse())
    .mockResolvedValueOnce(searchOkResponse())
    .mockResolvedValueOnce(sseUpstream(['combined answer']));

  const events = await chat(conv.id, { content: 'x' });
  expect(events.map((e) => e.type)).toEqual([
    'tool_search',
    'tool_search',
    'chunk',
    'done',
  ]);
  expect(events.filter((e) => e.type === 'tool_search').map((e) => e.query)).toEqual([
    'trends',
    'styles',
  ]);

  const messages = repo.listMessages(conv.id);
  expect(messages.filter((m: ConversationMessage) => m.role === 'tool')).toHaveLength(2);
});

test('follow-up chat after a search does not replay dangling tool messages', async () => {
  configureLocal();
  saveSearchConfig({ provider: 'tavily', apiKey: 'test-key' });
  process.env.PF_SEARCH_API_KEY = 'test-key';
  const { data: conv } = await createConversation({ providerId: 'local' });
  await request('PUT', `${base}/api/workshop/conversations/${conv.id}`, {
    enableSearch: true,
  });

  mockFetch
    .mockResolvedValueOnce(
      toolCallStream([{ id: 'call_c', name: 'search_web', args: '{"query":"trends"}' }]),
    )
    .mockResolvedValueOnce(searchOkResponse())
    .mockResolvedValueOnce(sseUpstream(['first answer']));

  await chat(conv.id, { content: 'first question' });

  mockFetch.mockResolvedValue(sseUpstream(['second answer']));
  await chat(conv.id, { content: 'second question' });

  const [, init] = mockFetch.mock.calls[3];
  const sent = JSON.parse(init.body) as { messages: { role: string; content: unknown }[] };
  for (const m of sent.messages) {
    expect(m.role).not.toBe('tool');
  }
  const hasSearchContent = sent.messages.some(
    (m) => typeof m.content === 'string' && m.content.includes('[Web search result]'),
  );
  expect(hasSearchContent).toBe(true);
});

test('undo removes the last user message and everything after it', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local' });
  repo.appendMessage(conv.id, 'user', 'q1');
  repo.appendMessage(conv.id, 'assistant', 'a1');
  repo.appendMessage(conv.id, 'user', 'q2');
  repo.appendMessage(conv.id, 'assistant', 'a2');

  const undo = await request(
    'POST',
    `${base}/api/workshop/conversations/${conv.id}/undo`,
  );
  expect(undo.status).toBe(200);
  expect(undo.data.removed).toBe(2);

  const remaining = repo.listMessages(conv.id);
  expect(remaining.map((m: ConversationMessage) => m.content)).toEqual(['q1', 'a1']);
});

test('undo removes tool messages between user and assistant', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local' });
  repo.appendMessage(conv.id, 'user', 'q1');
  repo.appendMessage(conv.id, 'assistant', 'partial');
  repo.appendMessage(conv.id, 'tool', 'query: trends\n\nresults');
  repo.appendMessage(conv.id, 'assistant', 'final');

  const undo = await request(
    'POST',
    `${base}/api/workshop/conversations/${conv.id}/undo`,
  );
  expect(undo.status).toBe(200);
  expect(undo.data.removed).toBe(4);
  expect(repo.listMessages(conv.id)).toEqual([]);
});

test('undo returns removed=0 when there is no user message', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local' });
  repo.appendMessage(conv.id, 'assistant', 'orphan reply');

  const undo = await request(
    'POST',
    `${base}/api/workshop/conversations/${conv.id}/undo`,
  );
  expect(undo.status).toBe(200);
  expect(undo.data.removed).toBe(0);

  const missing = await request(
    'POST',
    `${base}/api/workshop/conversations/nope/undo`,
  );
  expect(missing.status).toBe(404);
});

test('title generation summarizes conversation messages and persists the title', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local' });
  repo.appendMessage(conv.id, 'user', '给我一个赛博朋克猫娘的提示词');
  repo.appendMessage(conv.id, 'assistant', 'masterpiece, cyberpunk catgirl');
  repo.appendMessage(conv.id, 'tool', 'query: trends\n\nsearch results should be skipped');

  mockFetch.mockResolvedValue(
    new Response(
      JSON.stringify({ choices: [{ message: { content: '赛博猫娘提示词' } }], model: 'llama3.1' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );

  const res = await request('POST', `${base}/api/workshop/conversations/${conv.id}/title`);
  expect(res.status).toBe(200);
  expect(res.data.title).toBe('赛博猫娘提示词');
  expect(res.data.model).toBe('llama3.1');

  const sent = JSON.parse(mockFetch.mock.calls[0][1].body as string);
  expect(sent.messages[0].role).toBe('system');
  expect(sent.messages[1].content).toContain('赛博朋克猫娘');
  expect(sent.messages[1].content).toContain('cyberpunk catgirl');
  expect(sent.messages[1].content).not.toContain('search results should be skipped');

  const got = await request('GET', `${base}/api/workshop/conversations/${conv.id}`);
  expect(got.data.title).toBe('赛博猫娘提示词');
});

test('title generation trims quotes and newlines from the upstream reply', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local' });
  repo.appendMessage(conv.id, 'user', '如何生成日落海景');
  mockFetch.mockResolvedValue(
    new Response(
      JSON.stringify({ choices: [{ message: { content: '「日落海景提示词」\n\n补充说明' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );

  const res = await request('POST', `${base}/api/workshop/conversations/${conv.id}/title`);
  expect(res.status).toBe(200);
  expect(res.data.title).toBe('日落海景提示词');
});

test('title generation prefers currentPrompt over conversation messages', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local' });
  repo.appendMessage(conv.id, 'user', '帮我写一个机甲战士的提示词');

  mockFetch.mockResolvedValue(
    new Response(
      JSON.stringify({ choices: [{ message: { content: '机甲战士提示词' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );

  const res = await request(
    'POST',
    `${base}/api/workshop/conversations/${conv.id}/title`,
    { currentPrompt: 'masterpiece, mecha warrior, cinematic lighting' },
  );
  expect(res.status).toBe(200);

  const sent = JSON.parse(mockFetch.mock.calls[0][1].body as string);
  expect(sent.messages[1].content).toContain('mecha warrior');
  expect(sent.messages[1].content).not.toContain('机甲战士');

  const got = await request('GET', `${base}/api/workshop/conversations/${conv.id}`);
  expect(got.data.title).toBe('机甲战士提示词');
});

test('title generation returns 400 without messages or missing conversation', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local' });
  const empty = await request('POST', `${base}/api/workshop/conversations/${conv.id}/title`);
  expect(empty.status).toBe(400);

  const missing = await request('POST', `${base}/api/workshop/conversations/nope/title`);
  expect(missing.status).toBe(404);
});

test('title generation prefers the cloud provider when configured', async () => {
  saveProviderConfig({
    local: { kind: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
    cloud: {
      kind: 'openai-compatible',
      baseUrl: 'http://cloud.example.com/v1',
      model: 'gpt-4o',
    },
  });
  process.env.PF_LLM_API_KEY = 'sk-test';
  const { data: conv } = await createConversation({ providerId: 'local' });
  repo.appendMessage(conv.id, 'user', 'hello');
  mockFetch.mockResolvedValue(
    new Response(
      JSON.stringify({ choices: [{ message: { content: '云端标题' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );

  const res = await request('POST', `${base}/api/workshop/conversations/${conv.id}/title`);
  expect(res.status).toBe(200);
  expect(res.data.title).toBe('云端标题');
  expect(mockFetch.mock.calls[0][0]).toBe('http://cloud.example.com/v1/chat/completions');
});

test('title generation returns 400 when no provider is configured', async () => {
  saveProviderConfig({
    local: { kind: 'ollama', baseUrl: '', model: '' },
    cloud: { kind: 'openai-compatible', baseUrl: '', model: '' },
  });
  const { data: conv } = await createConversation({});
  repo.appendMessage(conv.id, 'user', 'hello');
  const res = await request('POST', `${base}/api/workshop/conversations/${conv.id}/title`);
  expect(res.status).toBe(400);
  expect(res.data.error).toContain('no LLM provider configured');
});

test('presets: list returns builtin presets with instructions', async () => {
  const list = await request('GET', `${base}/api/workshop/presets`);
  expect(list.status).toBe(200);
  expect(list.data).toHaveLength(3);
  const tags = list.data.find((p: { id: string }) => p.id === 'tags');
  expect(tags.name).toBe('Tags 标签式');
  expect(typeof tags.instructions).toBe('string');
  expect(tags.instructions.length).toBeGreaterThan(0);
});

test('presets: create/update/delete custom preset', async () => {
  const created = await request('POST', `${base}/api/workshop/presets`, {
    id: 'flux-pro',
    name: 'Flux Pro',
    description: 'For Flux Pro',
    instructions: 'Output flux style prompts.',
  });
  expect(created.status).toBe(201);
  expect(created.data.instructions).toBe('Output flux style prompts.');

  const list = await request('GET', `${base}/api/workshop/presets`);
  expect(list.data).toHaveLength(4);
  expect(list.data.map((p: { id: string }) => p.id)).toContain('flux-pro');

  const updated = await request('PUT', `${base}/api/workshop/presets/flux-pro`, {
    name: 'Flux Pro v2',
    description: 'Updated',
    instructions: 'New instructions.',
  });
  expect(updated.status).toBe(200);
  expect(updated.data.name).toBe('Flux Pro v2');
  expect(updated.data.instructions).toBe('New instructions.');

  const deleted = await request('DELETE', `${base}/api/workshop/presets/flux-pro`);
  expect(deleted.status).toBe(204);
  const after = await request('GET', `${base}/api/workshop/presets`);
  expect(after.data).toHaveLength(3);
});

test('presets: delete builtin returns 404, duplicate create returns 409', async () => {
  const delBuiltin = await request('DELETE', `${base}/api/workshop/presets/tags`);
  expect(delBuiltin.status).toBe(404);

  await request('POST', `${base}/api/workshop/presets`, {
    id: 'flux-pro',
    name: 'Flux Pro',
    description: '',
    instructions: 'x',
  });
  const dup = await request('POST', `${base}/api/workshop/presets`, {
    id: 'flux-pro',
    name: 'Flux Pro 2',
    description: '',
    instructions: 'y',
  });
  expect(dup.status).toBe(409);
});

test('presets: invalid id and missing instructions rejected', async () => {
  const badId = await request('POST', `${base}/api/workshop/presets`, {
    id: 'has space',
    name: 'Nope',
    description: '',
    instructions: 'x',
  });
  expect(badId.status).toBe(400);

  const noInstructions = await request('POST', `${base}/api/workshop/presets`, {
    id: 'ok-id',
    name: 'Nope',
    description: '',
    instructions: '',
  });
  expect(noInstructions.status).toBe(400);
});

test('presets: custom preset overrides builtin with the same id', async () => {
  await request('POST', `${base}/api/workshop/presets`, {
    id: 'tags',
    name: 'Tags 自定义版',
    description: 'overridden',
    instructions: 'Custom tags instructions.',
  });

  const list = await request('GET', `${base}/api/workshop/presets`);
  expect(list.data).toHaveLength(3);
  const tags = list.data.find((p: { id: string }) => p.id === 'tags');
  expect(tags.name).toBe('Tags 自定义版');
  expect(tags.instructions).toBe('Custom tags instructions.');
});

test('presets: deleting override restores the builtin preset', async () => {
  await request('POST', `${base}/api/workshop/presets`, {
    id: 'tags',
    name: 'Tags 自定义版',
    description: 'overridden',
    instructions: 'Custom tags instructions.',
  });
  await request('DELETE', `${base}/api/workshop/presets/tags`);

  const list = await request('GET', `${base}/api/workshop/presets`);
  const tags = list.data.find((p: { id: string }) => p.id === 'tags');
  expect(tags.name).toBe('Tags 标签式');
  expect(tags.instructions).toContain('comma-separated');
});

test('workshop config: defaultExtraSystemPrompt read/write', async () => {
  const initial = await request('GET', `${base}/api/workshop/config`);
  expect(initial.status).toBe(200);
  expect(initial.data.defaultExtraSystemPrompt).toBe('');

  const saved = await request('PUT', `${base}/api/workshop/config`, {
    defaultExtraSystemPrompt: 'always output English',
  });
  expect(saved.status).toBe(200);
  expect(saved.data.defaultExtraSystemPrompt).toBe('always output English');

  const reread = await request('GET', `${base}/api/workshop/config`);
  expect(reread.data.defaultExtraSystemPrompt).toBe('always output English');

  const tooLong = await request('PUT', `${base}/api/workshop/config`, {
    defaultExtraSystemPrompt: 'x'.repeat(4001),
  });
  expect(tooLong.status).toBe(400);
});

test('conversation create persists explicit extraSystemPrompt', async () => {
  const created = await createConversation({
    extraSystemPrompt: 'explicit prompt',
  });
  expect(created.status).toBe(201);
  expect(created.data.extraSystemPrompt).toBe('explicit prompt');
});

test('conversation create applies default extraSystemPrompt when not provided', async () => {
  await request('PUT', `${base}/api/workshop/config`, {
    defaultExtraSystemPrompt: 'default jailbreak',
  });
  const created = await createConversation();
  expect(created.data.extraSystemPrompt).toBe('default jailbreak');
});

test('chat uses custom preset instructions in the system message', async () => {
  configureLocal();
  await request('POST', `${base}/api/workshop/presets`, {
    id: 'flux-pro',
    name: 'Flux Pro',
    description: '',
    instructions: 'Use FLUX tagging syntax with weighted terms.',
  });
  const { data: conv } = await createConversation({ providerId: 'local', presetId: 'flux-pro' });
  mockFetch.mockResolvedValue(sseUpstream(['ok']));
  await chat(conv.id, { content: 'x', currentPrompt: 'p' });

  const [, init] = mockFetch.mock.calls[0];
  const sent = JSON.parse(init.body) as { messages: { content: string }[] };
  expect(sent.messages[0].content).toContain('FLUX tagging syntax');
});

test('chat falls back to plain instructions for unknown presetId', async () => {
  configureLocal();
  const { data: conv } = await createConversation({ providerId: 'local' });
  repo.update(conv.id, { presetId: 'no-such-preset' });
  mockFetch.mockResolvedValue(sseUpstream(['ok']));
  await chat(conv.id, { content: 'x', currentPrompt: 'p' });

  const [, init] = mockFetch.mock.calls[0];
  const sent = JSON.parse(init.body) as { messages: { content: string }[] };
  expect(sent.messages[0].content).toContain('flowing natural-language paragraph');
});

