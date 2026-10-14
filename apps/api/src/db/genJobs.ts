import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export type GenJobStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

export interface GenJob {
  id: string;
  promptId: string;
  sourceAssetId: string;
  comfyPromptId: string | null;
  status: GenJobStatus;
  error: string | null;
  outputAssetId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface JobRow {
  id: string;
  promptId: string;
  sourceAssetId: string;
  comfyPromptId: string | null;
  status: string;
  error: string | null;
  outputAssetId: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToJob(row: JobRow): GenJob {
  return { ...row, status: row.status as GenJobStatus };
}

const COLUMNS = 'id, promptId, sourceAssetId, comfyPromptId, status, error, outputAssetId, createdAt, updatedAt';

export class GenJobRepository {
  constructor(private db: Database.Database) {}

  create(input: { promptId: string; sourceAssetId: string }): GenJob {
    const now = new Date().toISOString();
    const row: JobRow = {
      id: randomUUID(),
      promptId: input.promptId,
      sourceAssetId: input.sourceAssetId,
      comfyPromptId: null,
      status: 'pending',
      error: null,
      outputAssetId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO gen_jobs
           (id, promptId, sourceAssetId, comfyPromptId, status, error, outputAssetId, createdAt, updatedAt)
         VALUES
           (@id, @promptId, @sourceAssetId, @comfyPromptId, @status, @error, @outputAssetId, @createdAt, @updatedAt)`,
      )
      .run(row);
    return rowToJob(row);
  }

  getById(id: string): GenJob | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM gen_jobs WHERE id = ?`)
      .get(id) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  /** Active (non-terminal) job for an asset, if any — used to dedupe repeat clicks. */
  getActiveByAsset(assetId: string): GenJob | null {
    const row = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM gen_jobs
         WHERE sourceAssetId = ? AND status IN ('pending','running')
         ORDER BY createdAt DESC LIMIT 1`,
      )
      .get(assetId) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  /** Latest successful job for an asset — used to skip a redundant re-render. */
  getLatestSuccessByAsset(assetId: string): GenJob | null {
    const row = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM gen_jobs
         WHERE sourceAssetId = ? AND status = 'success'
         ORDER BY createdAt DESC LIMIT 1`,
      )
      .get(assetId) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  update(
    id: string,
    patch: Partial<Pick<GenJob, 'comfyPromptId' | 'status' | 'error' | 'outputAssetId'>>,
  ): GenJob | null {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.comfyPromptId !== undefined) {
      sets.push('comfyPromptId = @comfyPromptId');
      params.comfyPromptId = patch.comfyPromptId;
    }
    if (patch.status !== undefined) {
      sets.push('status = @status');
      params.status = patch.status;
    }
    if (patch.error !== undefined) {
      sets.push('error = @error');
      params.error = patch.error;
    }
    if (patch.outputAssetId !== undefined) {
      sets.push('outputAssetId = @outputAssetId');
      params.outputAssetId = patch.outputAssetId;
    }
    if (sets.length === 0) return this.getById(id);
    sets.push('updatedAt = @updatedAt');
    params.updatedAt = new Date().toISOString();
    this.db
      .prepare(`UPDATE gen_jobs SET ${sets.join(', ')} WHERE id = @id`)
      .run(params);
    return this.getById(id);
  }

  listByAsset(assetId: string): GenJob[] {
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM gen_jobs WHERE sourceAssetId = ? ORDER BY createdAt DESC`,
      )
      .all(assetId) as JobRow[];
    return rows.map(rowToJob);
  }

  listActive(): GenJob[] {
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM gen_jobs WHERE status IN ('pending','running') ORDER BY createdAt ASC`,
      )
      .all() as JobRow[];
    return rows.map(rowToJob);
  }

  listRecent(limit = 50): GenJob[] {
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM gen_jobs ORDER BY createdAt DESC LIMIT ?`,
      )
      .all(limit) as JobRow[];
    return rows.map(rowToJob);
  }
}
