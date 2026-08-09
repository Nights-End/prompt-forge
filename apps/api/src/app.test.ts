import { test, beforeAll, afterAll, expect } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './app.js';

let server: Server;
let base: string;
let tmpDir: string;
let db: { close: () => void };

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-forge-'));
  process.env.DB_PATH = path.join(tmpDir, 'test.db');
  process.env.ASSET_DIR = path.join(tmpDir, 'uploads');
  process.env.PROVIDER_CONFIG_PATH = path.join(tmpDir, 'provider.json');
  process.env.WORKSHOP_CONFIG_PATH = path.join(tmpDir, 'workshop.json');

  const app = createApp();
  db = (app as { locals: { db: { close: () => void } } }).locals.db;
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  server.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function json<T>(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T) : (null as T);
  return { status: res.status, data };
}

test('health check', async () => {
  const { status, data } = await json<{ status: string }>('GET', '/api/health');
  expect(status).toBe(200);
  expect(data.status).toBe('ok');
});

test('create + list + variables', async () => {
  const { status, data } = await json('POST', '/api/prompts', {
    title: 'Email',
    content: 'Hi {name}, about {topic}.',
    category: 'writing',
    tags: ['email'],
  });
  expect(status).toBe(201);
  expect(data.variables).toEqual(['name', 'topic']);
  expect(data.type).toBe('text');

  const list = await json('GET', '/api/prompts');
  expect(list.status).toBe(200);
  expect(list.data.length).toBe(1);
});

test('validation rejects missing fields', async () => {
  const { status } = await json('POST', '/api/prompts', { title: '' });
  expect(status).toBe(400);
});

test('validation rejects unknown type', async () => {
  const { status, data } = await json('POST', '/api/prompts', {
    title: 'Bad',
    content: 'x',
    type: 'video',
  });
  expect(status).toBe(400);
  expect(data.error).toContain('type');
});

test('render endpoint', async () => {
  const { status, data } = await json('POST', '/api/prompts/render', {
    content: 'Hi {name}',
    values: { name: 'World' },
  });
  expect(status).toBe(200);
  expect(data.rendered).toBe('Hi World');
  expect(data.assets).toEqual([]);
});

test('update + getById', async () => {
  const created = await json('POST', '/api/prompts', {
    title: 'Draft',
    content: 'Hello {x}',
  });
  const id = created.data.id;

  const updated = await json('PUT', `/api/prompts/${id}`, {
    title: 'Draft v2',
    content: 'Hello {x} and {y}',
  });
  expect(updated.status).toBe(200);
  expect(updated.data.variables).toEqual(['x', 'y']);

  const got = await json('GET', `/api/prompts/${id}`);
  expect(got.data.title).toBe('Draft v2');
});

test('search by query', async () => {
  await json('POST', '/api/prompts', {
    title: 'UniqueMarketingPhrase',
    content: 'Something unique',
  });
  const { data } = await json('GET', '/api/prompts?q=UniqueMarketingPhrase');
  expect(data.length).toBe(1);
  expect(data[0].title).toBe('UniqueMarketingPhrase');
});

test('export json + import roundtrip', async () => {
  const exported = await json('GET', '/api/export?format=json');
  expect(exported.data.prompts.length).toBeGreaterThanOrEqual(1);

  const { status, data } = await json('POST', '/api/import', {
    prompts: [{ title: 'Imported', content: 'Imported {z}' }],
  });
  expect(status).toBe(201);
  expect(data.imported).toBe(1);
  expect(data.skipped).toBe(0);
});

test('partial update preserves unmodified metadata', async () => {
  const created = await json('POST', '/api/prompts', {
    title: 'Meta Prompt',
    content: 'Hello {name}',
    category: 'writing',
    tags: ['a', 'b'],
    description: 'keep me',
    isFavorite: true,
  });
  const id = created.data.id;

  const updated = await json('PUT', `/api/prompts/${id}`, {
    title: 'Meta Prompt v2',
    content: 'Hello {name}',
  });
  expect(updated.data.category).toBe('writing');
  expect(updated.data.tags).toEqual(['a', 'b']);
  expect(updated.data.description).toBe('keep me');
  expect(updated.data.isFavorite).toBe(true);
});

test('delete', async () => {
  const created = await json('POST', '/api/prompts', { title: 'Temp', content: 'x' });
  const id = created.data.id;
  const del = await fetch(`${base}/api/prompts/${id}`, { method: 'DELETE' });
  expect(del.status).toBe(204);

  const missing = await json('GET', `/api/prompts/${id}`);
  expect(missing.status).toBe(404);
});
