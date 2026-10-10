import { test, beforeAll, afterAll, expect } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../app.js';
import { extTokenPath } from '../config.js';

const ALLOWED = 'http://localhost:8000';

// Two distinct 1x1 PNGs — the endpoint keys images by content hash, so the
// bytes must actually differ for the "new image" case.
const PNG_A = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_B = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

let server: Server;
let base: string;
let tmpDir: string;
let token: string;
let db: { close: () => void };

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-ext-ingest-'));
  process.env.DB_PATH = path.join(tmpDir, 'test.db');
  process.env.ASSET_DIR = path.join(tmpDir, 'uploads');

  const app = createApp();
  db = (app as { locals: { db: { close: () => void } } }).locals.db;
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  token = fs.readFileSync(extTokenPath(tmpDir), 'utf8').trim();
});

afterAll(async () => {
  server.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface IngestResponse {
  status?: string;
  prompt?: { id: string; type: string; parameters: Record<string, string> };
  assetsAdded?: number;
  assetsSkipped?: number;
  error?: string;
  promptId?: string;
}

async function ingest(
  meta: Record<string, unknown> | string | undefined,
  images: { bytes: Buffer; name: string }[] = [],
): Promise<{ status: number; data: IngestResponse }> {
  const form = new FormData();
  if (meta !== undefined) {
    form.append('meta', typeof meta === 'string' ? meta : JSON.stringify(meta));
  }
  for (const img of images) {
    form.append('images', new Blob([img.bytes], { type: 'image/png' }), img.name);
  }
  const res = await fetch(`${base}/api/ext/prompts`, {
    method: 'POST',
    headers: { Origin: ALLOWED, 'X-Forge-Token': token },
    body: form,
  });
  const text = await res.text();
  return {
    status: res.status,
    data: text ? (JSON.parse(text) as IngestResponse) : {},
  };
}

async function assetsOf(promptId: string): Promise<{ id: string; metadata: Record<string, unknown> }[]> {
  const res = await fetch(`${base}/api/prompts/${promptId}/assets`);
  return (await res.json()) as { id: string; metadata: Record<string, unknown> }[];
}

async function countPrompts(): Promise<number> {
  const res = await fetch(`${base}/api/prompts`);
  return ((await res.json()) as unknown[]).length;
}

const IMG_A = { bytes: PNG_A, name: 'a.png' };

test('creates a prompt with its image (201)', async () => {
  const before = await countPrompts();
  const { status, data } = await ingest(
    { dedupeKey: 'chat-1|10|1', content: 'masterpiece, 1girl', tags: ['酒馆', '已生成'] },
    [IMG_A],
  );

  expect(status).toBe(201);
  expect(data.status).toBe('created');
  expect(data.assetsAdded).toBe(1);
  expect(data.assetsSkipped).toBe(0);
  expect(data.prompt?.type).toBe('multimodal');
  expect(await countPrompts()).toBe(before + 1);

  const assets = await assetsOf(data.prompt!.id);
  expect(assets).toHaveLength(1);
  expect(typeof assets[0].metadata.imageHash).toBe('string');
  expect(assets[0].metadata.source).toBe('st-ext');
});

test('a replayed request is deduped: no second prompt, no second copy of the image', async () => {
  const meta = { dedupeKey: 'chat-1|11|1', content: 'replay me' };
  const first = await ingest(meta, [IMG_A]);
  expect(first.status).toBe(201);

  const before = await countPrompts();
  const again = await ingest(meta, [IMG_A]);

  expect(again.status).toBe(200);
  expect(again.data.status).toBe('deduped');
  expect(again.data.prompt?.id).toBe(first.data.prompt?.id);
  expect(again.data.assetsAdded).toBe(0);
  expect(again.data.assetsSkipped).toBe(1);
  expect(await countPrompts()).toBe(before);
  expect(await assetsOf(first.data.prompt!.id)).toHaveLength(1);
});

test('the same image under a different filename is still recognised as the same image', async () => {
  const meta = { dedupeKey: 'chat-1|12|1', content: 'same bytes, other name' };
  const first = await ingest(meta, [{ bytes: PNG_A, name: 'first.png' }]);
  const again = await ingest(meta, [{ bytes: PNG_A, name: 'second.png' }]);

  expect(first.status).toBe(201);
  expect(again.status).toBe(200);
  expect(again.data.assetsAdded).toBe(0);
  expect(again.data.assetsSkipped).toBe(1);
  expect(await assetsOf(first.data.prompt!.id)).toHaveLength(1);
});

test('a new image on the same key is attached alongside the first', async () => {
  const meta = { dedupeKey: 'chat-1|13|1', content: 'two images' };
  const first = await ingest(meta, [IMG_A]);
  const second = await ingest(meta, [{ bytes: PNG_B, name: 'b.png' }]);

  expect(second.status).toBe(200);
  expect(second.data.assetsAdded).toBe(1);
  expect(await assetsOf(first.data.prompt!.id)).toHaveLength(2);

  const third = await ingest(meta, [{ bytes: PNG_B, name: 'b.png' }]);
  expect(third.data.assetsAdded).toBe(0);
  expect(await assetsOf(first.data.prompt!.id)).toHaveLength(2);
});

test('same key with different content is refused with 409', async () => {
  await ingest({ dedupeKey: 'chat-1|14|1', content: 'original body' }, [IMG_A]);
  const conflict = await ingest({ dedupeKey: 'chat-1|14|1', content: 'edited body' });

  expect(conflict.status).toBe(409);
  expect(conflict.data.promptId).toBeTruthy();
});

test('without a dedupeKey the body hash keys the entry', async () => {
  const before = await countPrompts();
  const first = await ingest({ content: 'hash-keyed prompt' });
  const again = await ingest({ content: 'hash-keyed prompt' });
  const different = await ingest({ content: 'hash-keyed prompt!' });

  expect(first.status).toBe(201);
  expect(again.status).toBe(200);
  expect(again.data.prompt?.id).toBe(first.data.prompt?.id);
  expect(different.status).toBe(201);
  expect(await countPrompts()).toBe(before + 2);
});

test('trailing whitespace does not create a second entry', async () => {
  const first = await ingest({ content: 'whitespace prompt' });
  const again = await ingest({ content: '  whitespace prompt\r\n' });
  expect(again.status).toBe(200);
  expect(again.data.prompt?.id).toBe(first.data.prompt?.id);
});

test('an image-less ingest still lands the prompt, typed as text', async () => {
  const { status, data } = await ingest({
    dedupeKey: 'chat-1|15|1',
    content: 'text only entry',
  });
  expect(status).toBe(201);
  expect(data.prompt?.type).toBe('text');
  expect(data.assetsAdded).toBe(0);
});

test('genParams are stored as prompt parameters', async () => {
  const { data } = await ingest({
    dedupeKey: 'chat-1|16|1',
    content: 'with params',
    genParams: { model: 'Krea2', steps: '28', seed: '123456' },
  });
  expect(data.prompt?.parameters).toEqual({
    model: 'Krea2',
    steps: '28',
    seed: '123456',
  });
});

test('bad input is rejected', async () => {
  expect((await ingest(undefined)).status).toBe(400);
  expect((await ingest('{not json')).status).toBe(400);
  expect((await ingest({ content: '   ' })).status).toBe(400);
  expect((await ingest({ dedupeKey: 'k'.repeat(201), content: 'x' })).status).toBe(400);
});

test('deleting the prompt also drops its ledger row, so the key can be reused', async () => {
  const meta = { dedupeKey: 'chat-1|17|1', content: 'deleted then resent' };
  const first = await ingest(meta, [IMG_A]);
  expect(first.status).toBe(201);

  const del = await fetch(`${base}/api/prompts/${first.data.prompt!.id}`, {
    method: 'DELETE',
  });
  expect(del.status).toBe(204);

  const again = await ingest(meta, [IMG_A]);
  expect(again.status).toBe(201);
  expect(again.data.prompt?.id).not.toBe(first.data.prompt?.id);
});
