import { Router } from 'express';
import {
  loadProviderConfig,
  normalizeBaseUrl,
  resolveApiKey,
  PROVIDER_IDS,
  type ProviderId,
} from '../llm/config.js';

const CHAT_TIMEOUT_MS = 120_000;
const MAX_MESSAGES = 100;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
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

    const config = loadProviderConfig();
    const settings = config[providerId];
    const baseUrl = normalizeBaseUrl(settings.kind, settings.baseUrl);
    if (!baseUrl) {
      res.status(400).json({ error: `provider "${providerId}" is not configured (missing baseUrl)` });
      return;
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (settings.kind === 'openai-compatible') {
      const apiKey = resolveApiKey(settings);
      if (!apiKey) {
        res.status(400).json({
          error: 'api key not configured for this provider (set PF_LLM_API_KEY or save one in settings)',
        });
        return;
      }
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
    try {
      const upstream = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: settings.model || undefined, messages }),
        signal: controller.signal,
      });
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        res.status(502).json({
          error: `upstream ${upstream.status}: ${text.slice(0, 500) || 'unknown error'}`,
        });
        return;
      }
      const data = (await upstream.json()) as {
        choices?: { message?: { content?: unknown } }[];
        model?: string;
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        res.status(502).json({ error: 'upstream response missing choices[0].message.content' });
        return;
      }
      res.json({ content, model: data.model ?? settings.model });
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
