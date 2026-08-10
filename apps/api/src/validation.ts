import type { PromptInput, PromptType } from '@prompt-forge/shared';
import { normalizeVariablePools } from '@prompt-forge/shared';

const PROMPT_TYPES: PromptType[] = ['text', 'multimodal'];

export interface PromptInputResult {
  ok: boolean;
  error?: string;
  value?: PromptInput;
}

export function parsePromptInput(body: unknown): PromptInputResult {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'invalid body' };
  }
  const b = body as PromptInput;

  const title = typeof b.title === 'string' ? b.title.trim() : '';
  const content = typeof b.content === 'string' ? b.content : '';
  if (!title || !content.trim()) {
    return { ok: false, error: 'title and content are required' };
  }

  const type = b.type === undefined ? undefined : (b.type as PromptType);
  if (type !== undefined && !PROMPT_TYPES.includes(type)) {
    return { ok: false, error: `type must be one of: ${PROMPT_TYPES.join(', ')}` };
  }

  return {
    ok: true,
    value: {
      title,
      content,
      description: typeof b.description === 'string' ? b.description : undefined,
      category: typeof b.category === 'string' ? b.category : undefined,
      tags: Array.isArray(b.tags)
        ? b.tags.filter((t): t is string => typeof t === 'string')
        : undefined,
      variablePools: normalizeVariablePools(b.variablePools),
      isFavorite:
        typeof b.isFavorite === 'boolean' ? b.isFavorite : undefined,
      type,
    },
  };
}
