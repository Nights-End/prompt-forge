import type Database from 'better-sqlite3';

export interface ExtDedupeEntry {
  dedupeKey: string;
  contentHash: string;
  promptId: string;
  createdAt: string;
}

/**
 * Ledger mapping an external ingest key to the prompt it produced. The UNIQUE
 * primary key is what makes /api/ext writes idempotent: a replay finds the
 * original instead of creating a second row.
 */
export class ExtDedupeRepository {
  constructor(private db: Database.Database) {}

  getByKey(dedupeKey: string): ExtDedupeEntry | null {
    const row = this.db
      .prepare('SELECT * FROM ext_dedupe WHERE dedupeKey = ?')
      .get(dedupeKey) as ExtDedupeEntry | undefined;
    return row ?? null;
  }

  getByContentHash(contentHash: string): ExtDedupeEntry | null {
    const row = this.db
      .prepare(
        'SELECT * FROM ext_dedupe WHERE contentHash = ? ORDER BY createdAt ASC LIMIT 1',
      )
      .get(contentHash) as ExtDedupeEntry | undefined;
    return row ?? null;
  }

  insert(entry: ExtDedupeEntry): void {
    this.db
      .prepare(
        `INSERT INTO ext_dedupe (dedupeKey, contentHash, promptId, createdAt)
         VALUES (@dedupeKey, @contentHash, @promptId, @createdAt)`,
      )
      .run(entry);
  }
}
