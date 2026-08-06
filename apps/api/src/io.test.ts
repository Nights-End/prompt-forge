import { test, beforeAll, afterAll, expect } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { createApp } from './app.js';

let server: Server;
let base: string;
let tmpDir: string;
let db: { close: () => void };

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-forge-io-'));
  process.env.DB_PATH = path.join(tmpDir, 'test.db');
  process.env.ASSET_DIR = path.join(tmpDir, 'uploads');
  process.env.PROVIDER_CONFIG_PATH = path.join(tmpDir, 'provider.json');

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

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7]);

test('zip export contains manifest and asset files', async () => {
  const created = await json('POST', '/api/prompts', {
    title: 'ZipExportPrompt',
    content: 'Export {me}',
    type: 'multimodal',
    tags: ['zip'],
  });
  const id = created.data.id;

  const form = new FormData();
  form.append('files', new File([PNG], 'zip.png', { type: 'image/png' }));
  const uploadRes = await fetch(`${base}/api/prompts/${id}/assets`, {
    method: 'POST',
    body: form,
  });
  const asset = ((await uploadRes.json()) as { storagePath: string }[])[0];

  const exportRes = await fetch(`${base}/api/export`);
  expect(exportRes.status).toBe(200);
  expect(exportRes.headers.get('content-type')).toContain('application/zip');
  const zipBuffer = Buffer.from(await exportRes.arrayBuffer());

  const zip = new AdmZip(zipBuffer);
  const manifest = JSON.parse(
    zip.getEntry('manifest.json')!.getData().toString('utf8'),
  ) as { prompts: { title: string }[]; assets: { storagePath: string }[] };
  expect(manifest.prompts.some((p) => p.title === 'ZipExportPrompt')).toBe(true);
  expect(manifest.assets.some((a) => a.storagePath === asset.storagePath)).toBe(true);
  expect(zip.getEntry(asset.storagePath)).not.toBeNull();

  const stored = zip.getEntry(asset.storagePath)!.getData();
  expect(stored.equals(PNG)).toBe(true);
});

test('zip import roundtrips prompts and assets', async () => {
  const exportRes = await fetch(`${base}/api/export`);
  const zipBuffer = Buffer.from(await exportRes.arrayBuffer());

  const before = await json('GET', '/api/prompts');
  const beforeCount = before.data.length;

  const importRes = await fetch(`${base}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: zipBuffer,
  });
  expect(importRes.status).toBe(201);
  const result = (await importRes.json()) as {
    imported: number;
    skipped: number;
    assets: number;
  };
  expect(result.imported).toBe(beforeCount);
  expect(result.assets).toBeGreaterThanOrEqual(1);

  const after = await json('GET', '/api/prompts?q=ZipExportPrompt');
  const imported = after.data[0] as { id: string; type: string };
  expect(imported.type).toBe('multimodal');

  const assets = await json('GET', `/api/prompts/${imported.id}/assets`);
  expect(assets.data.length).toBe(1);
  const fileRes = await fetch(`${base}/api/assets/${assets.data[0].id}/file`);
  expect(fileRes.status).toBe(200);
  const bytes = Buffer.from(await fileRes.arrayBuffer());
  expect(bytes.equals(PNG)).toBe(true);
});

test('json import still works and accepts a plain array', async () => {
  const { status, data } = await json('POST', '/api/import', {
    prompts: [{ title: 'JsonImportPrompt', content: 'Hello' }],
  });
  expect(status).toBe(201);
  expect(data.imported).toBe(1);

  const arrayRes = await fetch(`${base}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ title: 'ArrayImportPrompt', content: 'Hello' }]),
  });
  expect(arrayRes.status).toBe(201);
  const arrayData = (await arrayRes.json()) as { imported: number };
  expect(arrayData.imported).toBe(1);
});

test('invalid zip is rejected', async () => {
  const importRes = await fetch(`${base}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: Buffer.from('not a zip file at all'),
  });
  expect(importRes.status).toBe(400);
});
