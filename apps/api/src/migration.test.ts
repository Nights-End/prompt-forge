import { test, beforeAll, afterAll, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { createDb, migrateGenParamsToAssets } from './db/index.js';

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-forge-migrate-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function setupDb(): Database.Database {
  process.env.DB_PATH = path.join(
    tmpDir,
    `migrate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
  );
  return createDb();
}

function insertPrompt(
  db: Database.Database,
  id: string,
  parameters: Record<string, string>,
  type = 'multimodal',
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO prompts
       (id, title, content, category, tags, variables, variablePools, isFavorite, type, parameters, createdAt, updatedAt)
     VALUES (?, ?, ?, 'general', '[]', '[]', '{}', 0, ?, ?, ?, ?)`,
  ).run(id, 'title', 'content', type, JSON.stringify(parameters), now, now);
}

function insertAsset(
  db: Database.Database,
  id: string,
  promptId: string,
  metadata: Record<string, unknown>,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO assets
       (id, promptId, kind, fileName, storagePath, metadata, sortOrder, createdAt)
     VALUES (?, ?, 'image', 'img.png', ?, ?, 0, ?)`,
  ).run(id, promptId, `${promptId}/${id}.png`, JSON.stringify(metadata), now);
}

test('single-image prompt: parameters move into asset genParams and prompt params are cleared', () => {
  const db = setupDb();
  insertPrompt(db, 'p1', { model: 'SDXL', steps: '30' });
  insertAsset(db, 'a1', 'p1', { size: 1, mimeType: 'image/png' });

  migrateGenParamsToAssets(db);

  const asset = db
    .prepare('SELECT metadata FROM assets WHERE id = ?')
    .get('a1') as { metadata: string };
  const metadata = JSON.parse(asset.metadata) as Record<string, unknown>;
  expect(metadata.genParams).toEqual({ model: 'SDXL', steps: '30' });
  expect(metadata.mimeType).toBe('image/png');

  const prompt = db
    .prepare('SELECT parameters FROM prompts WHERE id = ?')
    .get('p1') as { parameters: string };
  expect(prompt.parameters).toBe('{}');
  db.close();
});

test('multi-image prompt: parameters stay on the prompt', () => {
  const db = setupDb();
  insertPrompt(db, 'p2', { model: 'Flux' });
  insertAsset(db, 'a2', 'p2', {});
  insertAsset(db, 'a3', 'p2', {});

  migrateGenParamsToAssets(db);

  const assets = db
    .prepare('SELECT metadata FROM assets WHERE promptId = ? ORDER BY sortOrder')
    .all('p2') as { metadata: string }[];
  for (const a of assets) {
    expect(JSON.parse(a.metadata)).not.toHaveProperty('genParams');
  }
  const prompt = db
    .prepare('SELECT parameters FROM prompts WHERE id = ?')
    .get('p2') as { parameters: string };
  expect(prompt.parameters).not.toBe('{}');
  db.close();
});

test('image that already carries genParams is not overwritten', () => {
  const db = setupDb();
  insertPrompt(db, 'p3', { model: 'SDXL' });
  insertAsset(db, 'a4', 'p3', { genParams: { model: 'Old' } });

  migrateGenParamsToAssets(db);

  const asset = db
    .prepare('SELECT metadata FROM assets WHERE id = ?')
    .get('a4') as { metadata: string };
  expect(JSON.parse(asset.metadata).genParams).toEqual({ model: 'Old' });
  const prompt = db
    .prepare('SELECT parameters FROM prompts WHERE id = ?')
    .get('p3') as { parameters: string };
  expect(prompt.parameters).not.toBe('{}');
  db.close();
});

test('text prompts are never migrated', () => {
  const db = setupDb();
  insertPrompt(db, 'p4', { model: 'SDXL' }, 'text');

  migrateGenParamsToAssets(db);

  const prompt = db
    .prepare('SELECT parameters FROM prompts WHERE id = ?')
    .get('p4') as { parameters: string };
  expect(prompt.parameters).not.toBe('{}');
  db.close();
});
