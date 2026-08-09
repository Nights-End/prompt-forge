import { Router } from 'express';
import {
  loadProviderConfig,
  resolveApiKey,
  type ProviderId,
} from '../llm/config.js';
import { PROVIDER_IDS } from '../llm/config.js';
import { CHAT_TIMEOUT_MS, chatCompletions, resolveUpstream } from '../llm/provider.js';

const MAX_MESSAGES = 100;
const MAX_TITLE_CONTENT_CHARS = 20_000;
const MAX_TITLE_CHARS = 50;

const TITLE_SYSTEM_PROMPT =
  '你是一个标题生成助手。根据用户提供的提示词模板内容，生成一个简洁、准确概括其用途的中文标题，最多 30 个字。' +
  '只输出标题本身：不要引号、不要多余说明、不要句末标点、不要换行。';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function pickProviderId(): ProviderId | null {
  for (const id of ['cloud', 'local'] as ProviderId[]) {
    const settings = loadProviderConfig()[id];
    if (!settings.baseUrl) continue;
    if (settings.kind === 'openai-compatible' && !resolveApiKey(settings)) continue;
    return id;
  }
  return null;
}

export function cleanTitle(raw: string): string {
  const line = raw.split(/\r?\n/)[0].trim();
  const cleaned = line.replace(/^["'「『“]+|["'」』”]+$/g, '').trim();
  return cleaned.length > MAX_TITLE_CHARS
    ? cleaned.slice(0, MAX_TITLE_CHARS)
    : cleaned;
}

export interface LlmDeps {
  fetchImpl?: typeof fetch;
}

export function createLlmRouter(deps: LlmDeps = {}): Router {
  const router = Router();
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  router.post('/chat', async (req, res) => {
    const body = req.body as {
      providerId?: unknown;
      messages?: unknown;
    };

    const providerId = body?.providerId as ProviderId | undefined;
    if (typeof providerId !== 'string' || !(PROVIDER_IDS as string[]).includes(providerId)) {
      res.status(400).json({ error: `providerId must be one of: ${PROVIDER_IDS.join(', ')}` });
      return;
    }

    if (!Array.isArray(body?.messages) || body.messages.length === 0) {
      res.status(400).json({ error: 'messages must be a non-empty array' });
      return;
    }
    if (body.messages.length > MAX_MESSAGES) {
      res.status(400).json({ error: `too many messages (max ${MAX_MESSAGES})` });
      return;
    }
    const messages: ChatMessage[] = body.messages.map((m) => {
      const msg = m as Partial<ChatMessage>;
      return {
        role: msg.role ?? 'user',
        content: typeof msg.content === 'string' ? msg.content : String(msg.content ?? ''),
      };
    });

    const upstream = resolveUpstream(providerId);
    if (!upstream.ok) {
      res.status(400).json({ error: upstream.error });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
    try {
      const result = await chatCompletions(
        fetchImpl,
        upstream.value,
        { messages: messages as unknown as Record<string, unknown>[] },
        controller.signal,
      );
      if (!result.ok) {
        res.status(502).json({ error: result.error });
        return;
      }
      const data = (await result.response.json()) as {
        choices?: { message?: { content?: unknown } }[];
        model?: string;
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        res.status(502).json({ error: 'upstream response missing choices[0].message.content' });
        return;
      }
      res.json({ content, model: data.model ?? upstream.value.model });
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      res.status(aborted ? 504 : 502).json({
        error: aborted ? 'upstream request timed out' : e instanceof Error ? e.message : 'upstream request failed',
      });
    } finally {
      clearTimeout(timer);
    }
  });

  router.post('/title', async (req, res) => {
    const body = req.body as { content?: unknown };
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content) {
      res.status(400).json({ error: 'content must be a non-empty string' });
      return;
    }
    if (content.length > MAX_TITLE_CONTENT_CHARS) {
      res.status(400).json({
        error: `content must be at most ${MAX_TITLE_CONTENT_CHARS} characters`,
      });
      return;
    }

    const providerId = pickProviderId();
    if (!providerId) {
      res.status(400).json({
        error: 'no LLM provider configured (set baseUrl and api key in settings)',
      });
      return;
    }

    const upstream = resolveUpstream(providerId);
    if (!upstream.ok) {
      res.status(400).json({ error: upstream.error });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
    try {
      const result = await chatCompletions(
        fetchImpl,
        upstream.value,
        {
          messages: [
            { role: 'system', content: TITLE_SYSTEM_PROMPT },
            { role: 'user', content },
          ],
        },
        controller.signal,
      );
      if (!result.ok) {
        res.status(502).json({ error: result.error });
        return;
      }
      const data = (await result.response.json()) as {
        choices?: { message?: { content?: unknown } }[];
        model?: string;
      };
      const raw = data.choices?.[0]?.message?.content;
      if (typeof raw !== 'string') {
        res.status(502).json({ error: 'upstream response missing choices[0].message.content' });
        return;
      }
      const title = cleanTitle(raw);
      if (!title) {
        res.status(502).json({ error: 'upstream returned an empty title' });
        return;
      }
      res.json({ title, model: data.model ?? upstream.value.model });
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      res.status(aborted ? 504 : 502).json({
        error: aborted ? 'upstream request timed out' : e instanceof Error ? e.message : 'upstream request failed',
      });
    } finally {
      clearTimeout(timer);
    }
  });

  return router;
}
