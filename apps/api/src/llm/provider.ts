import {
  loadProviderConfig,
  normalizeBaseUrl,
  resolveApiKey,
  type ProviderId,
  type ProviderSettings,
} from './config.js';
import type { ConversationMessage, ToolCall } from '@prompt-forge/shared';
import { IMAGE_MAX_HISTORY } from '@prompt-forge/shared';

export const CHAT_TIMEOUT_MS = 120_000;

export interface UpstreamTarget {
  baseUrl: string;
  headers: Record<string, string>;
  model: string | undefined;
}

export type ResolveUpstreamResult =
  | { ok: true; value: UpstreamTarget }
  | { ok: false; error: string };

export function resolveUpstream(providerId: ProviderId): ResolveUpstreamResult {
  const settings: ProviderSettings = loadProviderConfig()[providerId];

  const baseUrl = normalizeBaseUrl(settings.kind, settings.baseUrl);
  if (!baseUrl) {
    return {
      ok: false,
      error: `provider "${providerId}" is not configured (missing baseUrl)`,
    };
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (settings.kind === 'openai-compatible') {
    const apiKey = resolveApiKey(settings);
    if (!apiKey) {
      return {
        ok: false,
        error:
          'api key not configured for this provider (set PF_LLM_API_KEY or save one in settings)',
      };
    }
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return {
    ok: true,
    value: { baseUrl, headers, model: settings.model || undefined },
  };
}

export type ChatCompletionsResult =
  | { ok: true; response: Response }
  | { ok: false; error: string };

export interface ChatCompletionsBody {
  model?: string;
  messages: Record<string, unknown>[];
  stream?: boolean;
  tools?: Record<string, unknown>[];
  tool_choice?: 'auto' | 'none' | Record<string, unknown>;
}

export async function chatCompletions(
  fetchImpl: typeof fetch,
  target: UpstreamTarget,
  body: ChatCompletionsBody,
  signal: AbortSignal,
): Promise<ChatCompletionsResult> {
  const requestBody: Record<string, unknown> = {
    model: target.model,
    messages: body.messages,
    stream: body.stream ?? false,
  };
  if (body.tools) requestBody.tools = body.tools;
  if (body.tool_choice) requestBody.tool_choice = body.tool_choice;

  const response = await fetchImpl(`${target.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: target.headers,
    body: JSON.stringify(requestBody),
    signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return {
      ok: false,
      error: `upstream ${response.status}: ${text.slice(0, 500) || 'unknown error'}`,
    };
  }
  return { ok: true, response };
}

type UpstreamMessageContent =
  | string
  | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];

interface UpstreamMessage {
  role: string;
  content: UpstreamMessageContent;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

function messageHasImages(m: ConversationMessage): boolean {
  return !!m.multimodalContent && m.multimodalContent.length > 0;
}

export function buildMessages(
  history: ConversationMessage[],
  newUserContent: string,
  newImages?: string[],
  imageMaxHistory = IMAGE_MAX_HISTORY,
): UpstreamMessage[] {
  let imageCount = 0;
  const messages: UpstreamMessage[] = [];

  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role === 'tool') {
      // Persisted tool results carry the query in the first line. We never store
      // tool_call_ids, so replay them as plain user content to stay compatible
      // with strict OpenAI-format APIs that reject dangling tool messages.
      messages.push({
        role: 'user',
        content: `[Web search result]\n${m.content}`,
      });
      continue;
    }
    if (m.role === 'assistant') {
      const msg: UpstreamMessage = { role: 'assistant', content: m.content };
      messages.push(msg);
      continue;
    }

    if (messageHasImages(m) && imageCount < imageMaxHistory) {
      imageCount++;
      const parts: ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] = [
        { type: 'text', text: m.content },
      ];
      for (const img of m.multimodalContent!) {
        if (img.type === 'image_url') {
          parts.push({ type: 'image_url', image_url: { url: img.image_url.url } });
        }
      }
      messages.push({ role: 'user', content: parts });
    } else {
      messages.push({ role: 'user', content: m.content });
    }
  }

  const newParts: ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] = [
    { type: 'text', text: newUserContent },
  ];
  if (newImages && newImages.length > 0) {
    for (const img of newImages) {
      newParts.push({ type: 'image_url', image_url: { url: img } });
    }
  }

  messages.push({
    role: 'user',
    content: newParts.length === 1 ? newUserContent : newParts,
  });

  return messages;
}

interface UpstreamDelta {
  choices?: {
    delta?: {
      content?: unknown;
      tool_calls?: {
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string;
  }[];
  model?: string;
}

export interface DetectedToolCalls {
  fullText: string;
  toolCalls: ToolCall[];
}

export function accumulateToolCalls(
  chunk: UpstreamDelta,
  current: ToolCall[],
  textSoFar: string,
): DetectedToolCalls {
  const delta = chunk.choices?.[0]?.delta;
  if (!delta) return { fullText: textSoFar, toolCalls: current };

  let fullText = textSoFar;
  if (typeof delta.content === 'string' && delta.content) {
    fullText += delta.content;
  }

  const toolCallDeltas = delta.tool_calls;
  if (!toolCallDeltas || toolCallDeltas.length === 0) {
    return { fullText, toolCalls: current };
  }

  const merged = [...current];
  for (const tc of toolCallDeltas) {
    const idx = tc.index;
    while (merged.length <= idx) {
      merged.push({
        id: '',
        type: 'function',
        function: { name: '', arguments: '' },
      });
    }
    if (tc.id) merged[idx].id = tc.id;
    if (tc.type) merged[idx].type = tc.type;
    if (tc.function?.name) merged[idx].function.name += tc.function.name;
    if (tc.function?.arguments) merged[idx].function.arguments += tc.function.arguments;
  }

  return { fullText, toolCalls: merged };
}
