import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function resolveDataDir(): string {
  const env = process.env.DB_PATH;
  if (env) return path.dirname(path.resolve(env));
  const dataDir = path.resolve(__dirname, '../../data');
  fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

function resolveDbPath(): string {
  const env = process.env.DB_PATH;
  if (env) return env;
  return path.join(resolveDataDir(), 'prompt-forge.db');
}

// Ordered schema migrations. Each index corresponds to PRAGMA user_version.
// Only migrations with an index greater than the current user_version run.
const MIGRATIONS: string[] = [
  // v1: initial prompts table
  `
    CREATE TABLE IF NOT EXISTS prompts (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      content     TEXT NOT NULL,
      description TEXT,
      category    TEXT NOT NULL DEFAULT 'general',
      tags        TEXT NOT NULL DEFAULT '[]',
      variables   TEXT NOT NULL DEFAULT '[]',
      isFavorite  INTEGER NOT NULL DEFAULT 0,
      createdAt   TEXT NOT NULL,
      updatedAt   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_prompts_category ON prompts(category);
    CREATE INDEX IF NOT EXISTS idx_prompts_createdAt ON prompts(createdAt);
  `,
  // v2: prompt type + asset files
  `
    ALTER TABLE prompts ADD COLUMN type TEXT NOT NULL DEFAULT 'multimodal';

    CREATE TABLE IF NOT EXISTS assets (
      id          TEXT PRIMARY KEY,
      promptId    TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      fileName    TEXT NOT NULL,
      storagePath TEXT NOT NULL,
      metadata    TEXT NOT NULL DEFAULT '{}',
      sortOrder   INTEGER NOT NULL DEFAULT 0,
      createdAt   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_assets_promptId ON assets(promptId);
  `,
  // v3: workshop conversations + messages
  `
    CREATE TABLE IF NOT EXISTS conversations (
      id         TEXT PRIMARY KEY,
      promptId   TEXT REFERENCES prompts(id) ON DELETE SET NULL,
      title      TEXT NOT NULL DEFAULT '',
      providerId TEXT NOT NULL DEFAULT 'cloud',
      presetId   TEXT NOT NULL DEFAULT 'tags',
      extraSystemPrompt TEXT NOT NULL DEFAULT '',
      createdAt  TEXT NOT NULL,
      updatedAt  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_promptId ON conversations(promptId);

    CREATE TABLE IF NOT EXISTS conversation_messages (
      id             TEXT PRIMARY KEY,
      conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role           TEXT NOT NULL,
      content        TEXT NOT NULL,
      createdAt      TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON conversation_messages(conversationId, createdAt);
  `,
  // v4: search toggle + multimodal content
  `
    ALTER TABLE conversations ADD COLUMN enableSearch INTEGER NOT NULL DEFAULT 0;

    ALTER TABLE conversation_messages ADD COLUMN multimodal_content TEXT;
  `,
  // v5: default prompt flag
  `
    ALTER TABLE prompts ADD COLUMN isDefault INTEGER NOT NULL DEFAULT 0;
  `,
  // v6: prompt generation parameters
  `
    ALTER TABLE prompts ADD COLUMN parameters TEXT NOT NULL DEFAULT '{}';
  `,
  // v7: variable pools for batch rendering
  `
    ALTER TABLE prompts ADD COLUMN variablePools TEXT NOT NULL DEFAULT '{}';
  `,
  // v8: no schema change; generation params move to asset metadata
  // (data migration runs in migrateGenParamsToAssets after schema migration)
  '-- v8: data-only migration (gen params to assets)',
  // v9: dedupe ledger for the /api/ext write surface. The PRIMARY KEY is what
  // makes external ingest idempotent — a replayed request finds the original
  // row instead of creating a second prompt.
  `
    CREATE TABLE IF NOT EXISTS ext_dedupe (
      dedupeKey   TEXT PRIMARY KEY,
      contentHash TEXT NOT NULL,
      promptId    TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
      createdAt   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ext_dedupe_contentHash ON ext_dedupe(contentHash);
  `,
];

function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      // v8 is data-only: run the genParams migration exactly once, inside the
      // versioned transaction, so it cannot re-scan on every startup.
      if (v === 7) migrateGenParamsToAssets(db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

// Moves generation parameters from single-image multimodal prompts into the
// image asset's metadata.genParams, clearing the prompt-level copy. Prompts
// with zero or multiple images (and images that already carry genParams) are
// left untouched. Note: the clear of prompts.parameters is one-way and runs
// only during the v7 -> v8 upgrade, so pre-v8 rollback cannot see the moved
// data on those prompts.
export function migrateGenParamsToAssets(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT id, parameters FROM prompts
       WHERE type = 'multimodal' AND parameters IS NOT NULL AND parameters != '{}'`,
    )
    .all() as { id: string; parameters: string }[];
  if (rows.length === 0) return;

  const getImages = db.prepare(
    `SELECT id, metadata FROM assets
     WHERE promptId = ? AND kind = 'image'
     ORDER BY sortOrder ASC, createdAt ASC`,
  );
  const updateAsset = db.prepare('UPDATE assets SET metadata = ? WHERE id = ?');
  const clearPrompt = db.prepare(`UPDATE prompts SET parameters = '{}' WHERE id = ?`);

  db.transaction(() => {
    for (const row of rows) {
      const images = getImages.all(row.id) as { id: string; metadata: string }[];
      if (images.length !== 1) continue;
      let parameters: unknown;
      try {
        parameters = JSON.parse(row.parameters) as unknown;
      } catch {
        continue;
      }
      if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
        continue;
      }
      let metadata: Record<string, unknown>;
      try {
        metadata = JSON.parse(images[0].metadata) as Record<string, unknown>;
      } catch {
        metadata = {};
      }
      if (metadata.genParams !== undefined) continue;
      metadata.genParams = parameters;
      updateAsset.run(JSON.stringify(metadata), images[0].id);
      clearPrompt.run(row.id);
    }
  })();
}

export function createDb(): Database.Database {
  const dbPath = resolveDbPath();
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  migrate(db);

  return db;
}
