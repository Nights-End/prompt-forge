import type { Asset, AssetKind } from '@prompt-forge/shared';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

interface AssetRow {
  id: string;
  promptId: string;
  kind: string;
  fileName: string;
  storagePath: string;
  metadata: string;
  sortOrder: number;
  createdAt: string;
}

function rowToAsset(row: AssetRow): Asset {
  return {
    id: row.id,
    promptId: row.promptId,
    kind: row.kind as AssetKind,
    fileName: row.fileName,
    storagePath: row.storagePath,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
  };
}

export interface AssetInput {
  promptId: string;
  kind: AssetKind;
  fileName: string;
  storagePath: string;
  metadata?: Record<string, unknown>;
  sortOrder?: number;
}

export class AssetRepository {
  constructor(private db: Database.Database) {}

  listByPrompt(promptId: string): Asset[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM assets WHERE promptId = ? ORDER BY sortOrder ASC, createdAt ASC',
      )
      .all(promptId) as AssetRow[];
    return rows.map(rowToAsset);
  }

  listByPrompts(promptIds: string[]): Asset[] {
    if (promptIds.length === 0) return [];
    const placeholders = promptIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT * FROM assets WHERE promptId IN (${placeholders}) ORDER BY sortOrder ASC, createdAt ASC`,
      )
      .all(...promptIds) as AssetRow[];
    return rows.map(rowToAsset);
  }

  getById(id: string): Asset | null {
    const row = this.db
      .prepare('SELECT * FROM assets WHERE id = ?')
      .get(id) as AssetRow | undefined;
    return row ? rowToAsset(row) : null;
  }

  create(input: AssetInput): Asset {
    const now = new Date().toISOString();
    const maxOrder = this.db
      .prepare(
        'SELECT COALESCE(MAX(sortOrder), -1) AS maxOrder FROM assets WHERE promptId = ?',
      )
      .get(input.promptId) as { maxOrder: number };
    const row: AssetRow = {
      id: randomUUID(),
      promptId: input.promptId,
      kind: input.kind,
      fileName: input.fileName,
      storagePath: input.storagePath,
      metadata: JSON.stringify(input.metadata ?? {}),
      sortOrder: input.sortOrder ?? maxOrder.maxOrder + 1,
      createdAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO assets
           (id, promptId, kind, fileName, storagePath, metadata, sortOrder, createdAt)
         VALUES
           (@id, @promptId, @kind, @fileName, @storagePath, @metadata, @sortOrder, @createdAt)`,
      )
      .run(row);
    return rowToAsset(row);
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM assets WHERE id = ?').run(id);
    return result.changes > 0;
  }

  reorder(promptId: string, orderedIds: string[]): Asset[] {
    const existing = this.listByPrompt(promptId);
    const byId = new Map(existing.map((a) => [a.id, a]));
    const unknown = orderedIds.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      throw new Error(`unknown asset ids: ${unknown.join(', ')}`);
    }
    const update = this.db.prepare(
      'UPDATE assets SET sortOrder = ? WHERE id = ?',
    );
    this.db.transaction(() => {
      orderedIds.forEach((id, index) => update.run(index, id));
    })();
    return this.listByPrompt(promptId);
  }
}
