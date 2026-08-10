import type {
  Conversation,
  ConversationMessage,
  ConversationRole,
  CreateConversationInput,
  MessageContentPart,
} from '@prompt-forge/shared';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

interface ConversationRow {
  id: string;
  promptId: string | null;
  title: string;
  providerId: string;
  presetId: string;
  extraSystemPrompt: string;
  enableSearch: number;
  createdAt: string;
  updatedAt: string;
}

interface MessageRow {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  multimodalContent: string | null;
  createdAt: string;
}

function rowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    promptId: row.promptId,
    title: row.title,
    providerId: row.providerId,
    presetId: row.presetId,
    extraSystemPrompt: row.extraSystemPrompt,
    enableSearch: row.enableSearch === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToMessage(row: MessageRow): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role as ConversationRole,
    content: row.content,
    multimodalContent: row.multimodalContent
      ? (JSON.parse(row.multimodalContent) as MessageContentPart[])
      : null,
    createdAt: row.createdAt,
  };
}

export class ConversationRepository {
  constructor(private db: Database.Database) {}

  create(input: CreateConversationInput): Conversation {
    const now = new Date().toISOString();
    const row: ConversationRow = {
      id: randomUUID(),
      promptId: input.promptId || null,
      title: input.title ?? '',
      providerId: input.providerId ?? 'cloud',
      presetId: input.presetId ?? 'tags',
      extraSystemPrompt: input.extraSystemPrompt ?? '',
      enableSearch: input.enableSearch ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO conversations
           (id, promptId, title, providerId, presetId, extraSystemPrompt, createdAt, updatedAt)
         VALUES
           (@id, @promptId, @title, @providerId, @presetId, @extraSystemPrompt, @createdAt, @updatedAt)`,
      )
      .run(row);
    return rowToConversation(row);
  }

  getById(id: string): Conversation | null {
    const row = this.db
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(id) as ConversationRow | undefined;
    return row ? rowToConversation(row) : null;
  }

  listByPrompt(promptId: string): Conversation[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM conversations WHERE promptId = ? ORDER BY updatedAt DESC',
      )
      .all(promptId) as ConversationRow[];
    return rows.map(rowToConversation);
  }

  listRecent(limit: number): Conversation[] {
    const rows = this.db
      .prepare('SELECT * FROM conversations ORDER BY updatedAt DESC LIMIT ?')
      .all(limit) as ConversationRow[];
    return rows.map(rowToConversation);
  }

  update(
    id: string,
    patch: {
      title?: string;
      providerId?: string;
      presetId?: string;
      extraSystemPrompt?: string;
      enableSearch?: boolean;
    },
  ): Conversation | null {
    const existing = this.getById(id);
    if (!existing) return null;
    const row: ConversationRow = {
      ...existing,
      title: patch.title ?? existing.title,
      providerId: patch.providerId ?? existing.providerId,
      presetId: patch.presetId ?? existing.presetId,
      extraSystemPrompt: patch.extraSystemPrompt ?? existing.extraSystemPrompt,
      enableSearch:
        patch.enableSearch !== undefined
          ? (patch.enableSearch ? 1 : 0)
          : (existing.enableSearch ? 1 : 0),
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `UPDATE conversations SET
           title = @title,
           providerId = @providerId,
           presetId = @presetId,
           extraSystemPrompt = @extraSystemPrompt,
           enableSearch = @enableSearch,
           updatedAt = @updatedAt
         WHERE id = @id`,
      )
      .run(row);
    return rowToConversation(row);
  }

  touch(id: string): void {
    this.db
      .prepare('UPDATE conversations SET updatedAt = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }

  delete(id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM conversations WHERE id = ?')
      .run(id);
    return result.changes > 0;
  }

  listMessages(conversationId: string): ConversationMessage[] {
    const rows = this.db
      .prepare(
        'SELECT id, conversationId, role, content, multimodal_content AS multimodalContent, createdAt FROM conversation_messages WHERE conversationId = ? ORDER BY createdAt ASC, rowid ASC',
      )
      .all(conversationId) as MessageRow[];
    return rows.map(rowToMessage);
  }

  listRecentMessages(conversationId: string, limit: number): ConversationMessage[] {
    const rows = this.db
      .prepare(
        `SELECT id, conversationId, role, content, multimodal_content AS multimodalContent, createdAt FROM (
           SELECT rowid, * FROM conversation_messages
           WHERE conversationId = ?
           ORDER BY createdAt DESC, rowid DESC
           LIMIT ?
         )
         ORDER BY createdAt ASC, rowid ASC`,
      )
      .all(conversationId, limit) as MessageRow[];
    return rows.map(rowToMessage);
  }

  appendMessage(
    conversationId: string,
    role: ConversationRole,
    content: string,
    multimodalContent?: MessageContentPart[] | null,
  ): ConversationMessage {
    const row: MessageRow = {
      id: randomUUID(),
      conversationId,
      role,
      content,
      multimodalContent: multimodalContent ? JSON.stringify(multimodalContent) : null,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO conversation_messages
           (id, conversationId, role, content, multimodal_content, createdAt)
         VALUES
           (@id, @conversationId, @role, @content, @multimodalContent, @createdAt)`,
      )
      .run(row);
    return rowToMessage(row);
  }

  deleteMessage(id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM conversation_messages WHERE id = ?')
      .run(id);
    return result.changes > 0;
  }

  /**
   * Deletes the last user message together with every message that followed it
   * (assistant replies, tool messages, ...). Returns the number of deleted rows.
   */
  undoLastExchange(conversationId: string): number {
    const lastUser = this.db
      .prepare(
        `SELECT rowid FROM conversation_messages
         WHERE conversationId = ? AND role = 'user'
         ORDER BY createdAt DESC, rowid DESC
         LIMIT 1`,
      )
      .get(conversationId) as { rowid: number } | undefined;
    if (!lastUser) return 0;
    const result = this.db
      .prepare(
        `DELETE FROM conversation_messages
         WHERE conversationId = ? AND rowid >= ?`,
      )
      .run(conversationId, lastUser.rowid);
    return result.changes;
  }
}
