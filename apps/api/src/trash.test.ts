import { test, beforeAll, afterAll, expect } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './app.js';
import { pruneTrash, readTrashEntries, trashDirOf } from './trash.js';

let server: Server;
let base: string;
let tmpDir: string;
let db: { close: () => void };
let uploadsDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-forge-trash-'));
  process.env.DB_PATH = path.join(tmpDir, 'test.db');
  process.env.ASSET_DIR = path.join(tmpDir, 'uploads');
  process.env.PROVIDER_CONFIG_PATH = path.join(tmpDir, 'provider.json');
  delete process.env.TRASH_KEEP_DAYS;
  uploadsDir = process.env.ASSET_DIR;

  const app = createApp();
  db = (app as { locals: { db: { close: () => void } } }).locals.db;
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const DAY = 86_400_000;

async function createPrompt(title: string): Promise<string> {
  const res = await fetch(`${base}/api/prompts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, content: 'Hello', type: 'multimodal' }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function uploadAsset(promptId: string, name = 'a.png'): Promise<{ id: string; storagePath: string }> {
  const form = new FormData();
  form.append('files', new File([PNG], name, { type: 'image/png' }));
  const res = await fetch(`${base}/api/prompts/${promptId}/assets`, { method: 'POST', body: form });
  expect(res.status).toBe(201);
  const assets = (await res.json()) as Array<{ id: string; storagePath: string }>;
  return assets[0];
}

test('整条删除:文件进回收站、条节目录消失、manifest 留快照', async () => {
  const id = await createPrompt('TrashWhole');
  const asset = await uploadAsset(id);
  const filePath = path.join(uploadsDir, asset.storagePath);
  expect(fs.existsSync(filePath)).toBe(true);

  const del = await fetch(`${base}/api/prompts/${id}`, { method: 'DELETE' });
  expect(del.status).toBe(204);

  expect(fs.existsSync(filePath)).toBe(false);
  expect(fs.existsSync(path.join(uploadsDir, id))).toBe(false);

  const entry = readTrashEntries(uploadsDir).find((e) => e.promptId === id);
  expect(entry).toBeTruthy();
  expect(entry?.reason).toBe('prompt');
  expect(entry?.prompt?.title).toBe('TrashWhole');
  expect(entry?.assets.length).toBe(1);
  expect(entry?.files.length).toBe(1);
  expect(fs.existsSync(path.join(trashDirOf(uploadsDir), entry!.files[0].trashedAs))).toBe(true);

  const list = (await (await fetch(`${base}/api/prompts?limit=500`)).json()) as Array<{ id: string }>;
  expect(list.some((p) => p.id === id)).toBe(false);
});

test('删单图:还有别的图时目录保留,最后一个删掉后目录才消失', async () => {
  const id = await createPrompt('TrashOne');
  const a = await uploadAsset(id, 'one.png');
  const b = await uploadAsset(id, 'two.png');

  let del = await fetch(`${base}/api/prompts/${id}/assets/${a.id}`, { method: 'DELETE' });
  expect(del.status).toBe(204);
  expect(fs.existsSync(path.join(uploadsDir, id))).toBe(true);
  expect(readTrashEntries(uploadsDir).some((e) => e.reason === 'asset' && e.promptId === id)).toBe(true);

  const still = await fetch(`${base}/api/assets/${b.id}/file`);
  expect(still.status).toBe(200);

  del = await fetch(`${base}/api/prompts/${id}/assets/${b.id}`, { method: 'DELETE' });
  expect(del.status).toBe(204);
  expect(fs.existsSync(path.join(uploadsDir, id))).toBe(false);
});

test('删条目时 uploads 里的残余文件挪进回收站,不硬删', async () => {
  const id = await createPrompt('TrashResidual');
  await uploadAsset(id);
  const stray = path.join(uploadsDir, id, 'stray.txt');
  fs.writeFileSync(stray, 'keep me');

  const del = await fetch(`${base}/api/prompts/${id}`, { method: 'DELETE' });
  expect(del.status).toBe(204);
  expect(fs.existsSync(path.join(uploadsDir, id))).toBe(false);

  const names = fs.readdirSync(trashDirOf(uploadsDir));
  const residual = names.find((n) => n.includes('residual__stray.txt'));
  expect(residual).toBeTruthy();
  expect(fs.readFileSync(path.join(trashDirOf(uploadsDir), residual!), 'utf8')).toBe('keep me');
});

test('prune:按 manifest 的 at 判过期,不看文件 mtime', () => {
  const dir = trashDirOf(uploadsDir);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const oldTs = Date.now() - 9 * DAY;
  const oldName = 'old.png';
  const newName = 'new.png';
  fs.writeFileSync(path.join(dir, oldName), 'old');
  fs.writeFileSync(path.join(dir, newName), 'new');
  // 故意给「刚删的」那个文件一个很旧的 mtime —— 按 mtime 判的实现会误删它
  fs.utimesSync(path.join(dir, newName), oldTs / 1000, oldTs / 1000);

  const entry = (at: string, promptId: string, trashedAs: string) =>
    JSON.stringify({
      at,
      reason: 'asset',
      promptId,
      prompt: null,
      assets: [],
      files: [{ storagePath: `x/${trashedAs}`, trashedAs }],
    }) + '\n';
  fs.appendFileSync(path.join(dir, 'manifest.jsonl'), entry(new Date(oldTs).toISOString(), 'gone', oldName));
  fs.appendFileSync(path.join(dir, 'manifest.jsonl'), entry(new Date().toISOString(), 'keep', newName));

  const removed = pruneTrash(uploadsDir, { days: 7 });
  expect(removed).toBe(1);
  expect(fs.existsSync(path.join(dir, oldName))).toBe(false);
  expect(fs.existsSync(path.join(dir, newName))).toBe(true);
  expect(readTrashEntries(uploadsDir).map((e) => e.promptId)).toEqual(['keep']);
});

test('TRASH_KEEP_DAYS=0 表示永久保留', () => {
  const dir = trashDirOf(uploadsDir);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'ancient.png');
  fs.writeFileSync(f, 'x');
  const oldTs = Date.now() - 365 * DAY;
  fs.utimesSync(f, oldTs / 1000, oldTs / 1000);
  fs.appendFileSync(
    path.join(dir, 'manifest.jsonl'),
    JSON.stringify({
      at: new Date(oldTs).toISOString(),
      reason: 'asset',
      promptId: 'ancient',
      prompt: null,
      assets: [],
      files: [{ storagePath: 'x/ancient.png', trashedAs: 'ancient.png' }],
    }) + '\n',
  );

  process.env.TRASH_KEEP_DAYS = '0';
  try {
    expect(pruneTrash(uploadsDir)).toBe(0);
    expect(fs.existsSync(f)).toBe(true);
  } finally {
    delete process.env.TRASH_KEEP_DAYS;
  }
});
