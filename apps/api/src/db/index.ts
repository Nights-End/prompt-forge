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
];

function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export function createDb(): Database.Database {
  const dbPath = resolveDbPath();
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  migrate(db);

  return db;
}
