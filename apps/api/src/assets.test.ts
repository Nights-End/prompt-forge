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
let uploadsDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-forge-assets-'));
  process.env.DB_PATH = path.join(tmpDir, 'test.db');
  process.env.ASSET_DIR = path.join(tmpDir, 'uploads');
  process.env.PROVIDER_CONFIG_PATH = path.join(tmpDir, 'provider.json');
  uploadsDir = process.env.ASSET_DIR;

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

async function createPrompt(title: string): Promise<string> {
  const { status, data } = await json('POST', '/api/prompts', {
    title,
    content: 'Hello {name}',
    type: 'multimodal',
  });
  expect(status).toBe(201);
  return data.id;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test('upload, list, and serve asset files', async () => {
  const id = await createPrompt('AssetPrompt1');

  const form = new FormData();
  form.append(
    'files',
    new File([PNG], 'ref.png', { type: 'image/png' }),
  );
  form.append(
    'files',
    new File([Buffer.from('hello')], 'note.txt', { type: 'text/plain' }),
  );
  const uploadRes = await fetch(`${base}/api/prompts/${id}/assets`, {
    method: 'POST',
    body: form,
  });
  expect(uploadRes.status).toBe(201);
  const assets = (await uploadRes.json()) as { id: string; kind: string; fileName: string }[];
  expect(assets.length).toBe(2);
  expect(assets[0].kind).toBe('image');
  expect(assets[1].kind).toBe('file');

  const list = await json('GET', `/api/prompts/${id}/assets`);
  expect(list.data.length).toBe(2);

  const fileRes = await fetch(`${base}/api/assets/${assets[0].id}/file`);
  expect(fileRes.status).toBe(200);
  const bytes = Buffer.from(await fileRes.arrayBuffer());
  expect(bytes.equals(PNG)).toBe(true);
  expect(fileRes.headers.get('content-type')).toContain('image/png');
});

test('render with promptId returns assets', async () => {
  const id = await createPrompt('AssetRenderPrompt');
  const form = new FormData();
  form.append('files', new File([PNG], 'img.png', { type: 'image/png' }));
  await fetch(`${base}/api/prompts/${id}/assets`, { method: 'POST', body: form });

  const { status, data } = await json('POST', '/api/prompts/render', {
    promptId: id,
    values: { name: 'World' },
  });
  expect(status).toBe(200);
  expect(data.rendered).toBe('Hello World');
  expect(data.assets.length).toBe(1);
  expect(data.assets[0].url).toContain('/api/assets/');
});

test('render with unknown promptId returns 404', async () => {
  const { status } = await json('POST', '/api/prompts/render', {
    promptId: 'does-not-exist',
  });
  expect(status).toBe(404);
});

test('delete asset removes file from disk', async () => {
  const id = await createPrompt('AssetDeletePrompt');
  const form = new FormData();
  form.append('files', new File([PNG], 'gone.png', { type: 'image/png' }));
  const uploadRes = await fetch(`${base}/api/prompts/${id}/assets`, {
    method: 'POST',
    body: form,
  });
  const asset = ((await uploadRes.json()) as { id: string; storagePath: string }[])[0];
  const diskPath = path.join(uploadsDir, ...asset.storagePath.split('/'));
  expect(fs.existsSync(diskPath)).toBe(true);

  const del = await fetch(`${base}/api/prompts/${id}/assets/${asset.id}`, {
    method: 'DELETE',
  });
  expect(del.status).toBe(204);
  expect(fs.existsSync(diskPath)).toBe(false);

  const missing = await fetch(`${base}/api/assets/${asset.id}/file`);
  expect(missing.status).toBe(404);
});

test('deleting a prompt removes its asset files', async () => {
  const id = await createPrompt('AssetCascadePrompt');
  const form = new FormData();
  form.append('files', new File([PNG], 'cascade.png', { type: 'image/png' }));
  const uploadRes = await fetch(`${base}/api/prompts/${id}/assets`, {
    method: 'POST',
    body: form,
  });
  const asset = ((await uploadRes.json()) as { storagePath: string }[])[0];
  const diskPath = path.join(uploadsDir, ...asset.storagePath.split('/'));
  expect(fs.existsSync(diskPath)).toBe(true);

  const del = await fetch(`${base}/api/prompts/${id}`, { method: 'DELETE' });
  expect(del.status).toBe(204);
  expect(fs.existsSync(diskPath)).toBe(false);

  const list = await json('GET', `/api/prompts/${id}/assets`);
  expect(list.status).toBe(404);
});

test('upload without files is rejected', async () => {
  const id = await createPrompt('NoFilesPrompt');
  const form = new FormData();
  const uploadRes = await fetch(`${base}/api/prompts/${id}/assets`, {
    method: 'POST',
    body: form,
  });
  expect(uploadRes.status).toBe(400);
});

test('batch assets by prompts returns grouped map', async () => {
  const idA = await createPrompt('BatchPromptA');
  const idB = await createPrompt('BatchPromptB');
  for (const id of [idA, idB]) {
    const form = new FormData();
    form.append('files', new File([PNG], `img-${id}.png`, { type: 'image/png' }));
    await fetch(`${base}/api/prompts/${id}/assets`, { method: 'POST', body: form });
  }

  const { status, data } = await json(
    'GET',
    `/api/assets/by-prompts?ids=${idA},${idB},does-not-exist`,
  );
  expect(status).toBe(200);
  expect(data[idA]).toHaveLength(1);
  expect(data[idA][0].kind).toBe('image');
  expect(data[idB]).toHaveLength(1);
  expect(data['does-not-exist']).toBeUndefined();
});
