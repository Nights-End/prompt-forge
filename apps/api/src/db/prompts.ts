import type { Prompt, PromptInput, PromptParameters, PromptType } from '@prompt-forge/shared';
import { extractVariables } from '@prompt-forge/shared';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { getDefaultCategory } from '../prompts/config.js';

interface PromptRow {
  id: string;
  title: string;
  content: string;
  description: string | null;
  category: string;
  tags: string;
  variables: string;
  variablePools: string;
  isFavorite: number;
  type: string;
  parameters: string;
  createdAt: string;
  updatedAt: string;
}

function rowToPrompt(row: PromptRow): Prompt {
  let parameters: PromptParameters = {};
  try {
    parameters = JSON.parse(row.parameters) as PromptParameters;
  } catch {
    // keep empty object on parse failure
  }
  let variablePools: Record<string, string[]> = {};
  try {
    variablePools = JSON.parse(row.variablePools) as Record<string, string[]>;
  } catch {
    // keep empty object on parse failure
  }
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    description: row.description ?? undefined,
    category: row.category,
    tags: JSON.parse(row.tags) as string[],
    variables: JSON.parse(row.variables) as string[],
    variablePools,
    isFavorite: row.isFavorite === 1,
    type: row.type as PromptType,
    parameters,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToRowValues(prompt: PromptInput): {
  title: string;
  content: string;
  description: string | null;
  category: string;
  tags: string;
  variables: string;
  variablePools: string;
  isFavorite: number;
  type: string;
  parameters: string;
} {
  return {
    title: prompt.title,
    content: prompt.content,
    description: prompt.description ?? null,
    category: prompt.category?.trim() || getDefaultCategory() || 'general',
    tags: JSON.stringify(prompt.tags ?? []),
    variables: JSON.stringify(extractVariables(prompt.content)),
    variablePools: JSON.stringify(prompt.variablePools ?? {}),
    isFavorite: prompt.isFavorite ? 1 : 0,
    type: prompt.type ?? 'multimodal',
    parameters: JSON.stringify(prompt.parameters ?? {}),
  };
}

export interface ListOptions {
  q?: string;
  category?: string;
  tag?: string;
  favorite?: boolean;
  type?: PromptType;
  limit?: number;
  offset?: number;
}

export class PromptRepository {
  constructor(private db: Database.Database) {}

  private tagsCache: string[] | null = null;

  private map(rows: PromptRow[]): Prompt[] {
    return rows.map(rowToPrompt);
  }

  list(opts: ListOptions): Prompt[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (opts.q) {
      clauses.push('(title LIKE ? OR content LIKE ? OR description LIKE ?)');
      const like = `%${opts.q}%`;
      params.push(like, like, like);
    }
    if (opts.category) {
      clauses.push('category = ?');
      params.push(opts.category);
    }
    if (opts.tag) {
      clauses.push('tags LIKE ?');
      params.push(`%"${opts.tag}"%`);
    }
    if (opts.favorite !== undefined) {
      clauses.push('isFavorite = ?');
      params.push(opts.favorite ? 1 : 0);
    }
    if (opts.type) {
      clauses.push('type = ?');
      params.push(opts.type);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    let sql = `SELECT * FROM prompts ${where} ORDER BY createdAt DESC`;
    if (opts.limit !== undefined) {
      sql += ' LIMIT ? OFFSET ?';
      params.push(opts.limit, opts.offset ?? 0);
    }
    const rows = this.db.prepare(sql).all(...params) as PromptRow[];
    return this.map(rows);
  }

  getById(id: string): Prompt | null {
    const row = this.db
      .prepare('SELECT * FROM prompts WHERE id = ?')
      .get(id) as PromptRow | undefined;
    return row ? rowToPrompt(row) : null;
  }

  create(input: PromptInput): Prompt {
    const now = new Date().toISOString();
    const row: PromptRow = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      ...rowToRowValues(input),
    };
    this.db
      .prepare(
       `INSERT INTO prompts
            (id, title, content, description, category, tags, variables, variablePools, isFavorite, type, parameters, createdAt, updatedAt)
          VALUES
            (@id, @title, @content, @description, @category, @tags, @variables, @variablePools, @isFavorite, @type, @parameters, @createdAt, @updatedAt)`,
      )
      .run(row);
    this.invalidateTagsCache();
    return rowToPrompt(row);
  }

  update(id: string, input: Partial<PromptInput>): Prompt | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const merged = rowToRowValues({
      title: input.title ?? existing.title,
      content: input.content ?? existing.content,
      description: input.description ?? existing.description,
      category: input.category ?? existing.category,
      tags: input.tags ?? existing.tags,
      variablePools: input.variablePools ?? existing.variablePools,
      isFavorite: input.isFavorite ?? existing.isFavorite,
      type: input.type ?? existing.type,
      parameters: input.parameters ?? existing.parameters,
    });
    const row: PromptRow = {
      id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
      ...merged,
    };
    this.db
      .prepare(
       `UPDATE prompts SET
            title = @title,
            content = @content,
            description = @description,
            category = @category,
            tags = @tags,
            variables = @variables,
            variablePools = @variablePools,
            isFavorite = @isFavorite,
            type = @type,
            parameters = @parameters,
            updatedAt = @updatedAt
          WHERE id = @id`,
      )
      .run(row);
    this.invalidateTagsCache();
    return rowToPrompt(row);
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM prompts WHERE id = ?').run(id);
    if (result.changes > 0) this.invalidateTagsCache();
    return result.changes > 0;
  }

  categories(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT category FROM prompts ORDER BY category ASC')
      .all() as { category: string }[];
    return rows.map((r) => r.category);
  }

  tags(): string[] {
    if (this.tagsCache) return this.tagsCache;
    const rows = this.db
      .prepare("SELECT DISTINCT tags FROM prompts WHERE tags != '[]'")
      .all() as { tags: string }[];
    const set = new Set<string>();
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.tags) as unknown;
        if (!Array.isArray(parsed)) continue;
        for (const t of parsed) {
          if (typeof t === 'string' && t.trim()) set.add(t.trim());
        }
      } catch {
        // skip malformed tag rows
      }
    }
    this.tagsCache = [...set].sort((a, b) => a.localeCompare(b, 'zh'));
    return this.tagsCache;
  }

  private invalidateTagsCache(): void {
    this.tagsCache = null;
  }
}
