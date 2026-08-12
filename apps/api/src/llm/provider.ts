import {
  loadProviderConfig,
  loadVisionConfig,
  normalizeBaseUrl,
  resolveApiKey,
  resolveVisionApiKey,
  type ProviderId,
  type ProviderKind,
  type ProviderSettings,
} from './config.js';
import type { ConversationMessage, ToolCall } from '@prompt-forge/shared';
import { extractVariables, IMAGE_MAX_HISTORY } from '@prompt-forge/shared';

export const CHAT_TIMEOUT_MS = 120_000;

export interface UpstreamTarget {
  baseUrl: string;
  headers: Record<string, string>;
  model: string | undefined;
  kind?: ProviderKind;
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
    value: { baseUrl, headers, model: settings.model || undefined, kind: settings.kind },
  };
}

export type ChatCompletionsResult =
  | { ok: true; response: Response }
  | { ok: false; error: string };

export const VISION_DESCRIBE_SYSTEM_PROMPT =
  '你是图片描述助手。请用中文依次描述下面的参考图，每张图以"参考图 N："开头。' +
  '重点描述与文生图提示词相关的主题、风格、构图、颜色、材质、光线等视觉细节。' +
  '直接给出描述，不要其他说明。';

export const VISION_DESCRIBE_MARKER = '[参考图描述]';

export type DescribeImagesResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

export function resolveVisionUpstream(): ResolveUpstreamResult {
  const settings = loadVisionConfig();

  const baseUrl = normalizeBaseUrl(settings.kind, settings.baseUrl);
  if (!baseUrl) {
    return {
      ok: false,
      error: 'vision provider is not configured (missing baseUrl)',
    };
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (settings.kind === 'openai-compatible') {
    const apiKey = resolveVisionApiKey(settings);
    if (!apiKey) {
      return {
        ok: false,
        error:
          'vision api key not configured (set PF_VISION_API_KEY or save one in settings)',
      };
    }
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return {
    ok: true,
    value: { baseUrl, headers, model: settings.model || undefined, kind: settings.kind },
  };
}

type VisionChatResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

// Shared multipart image request + response extraction for all vision tasks;
// empty model output returns ok:true with empty text so callers can keep
// task-specific error messages.
async function visionChat(
  fetchImpl: typeof fetch,
  target: UpstreamTarget,
  systemPrompt: string,
  userPrompt: string,
  images: string[],
  signal: AbortSignal,
): Promise<VisionChatResult> {
  const parts: (
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  )[] = [
    { type: 'text', text: userPrompt },
    ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
  ];

  const result = await chatCompletions(
    fetchImpl,
    target,
    {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: parts },
      ],
    },
    signal,
  );
  if (!result.ok) return result;

  const data = (await result.response.json()) as {
    choices?: { message?: { content?: unknown } }[];
  };
  const text = data.choices?.[0]?.message?.content;
  return { ok: true, text: typeof text === 'string' ? text.trim() : '' };
}

export async function describeImages(
  fetchImpl: typeof fetch,
  target: UpstreamTarget,
  images: string[],
  signal: AbortSignal,
): Promise<DescribeImagesResult> {
  const result = await visionChat(
    fetchImpl,
    target,
    'You are an image captioning assistant.',
    VISION_DESCRIBE_SYSTEM_PROMPT,
    images,
    signal,
  );
  if (!result.ok) return result;
  if (!result.text) {
    return { ok: false, error: 'vision model returned an empty description' };
  }
  return { ok: true, text: result.text };
}

export const VISION_TAG_SYSTEM_PROMPT =
  '你是图片标签提取助手。请用中文依次为下面的参考图提取标签关键词，每张图以"参考图 N："开头。' +
  '标签应涵盖：主题、风格、色调、光线、材质、氛围、构图等视觉特征。' +
  '每张图输出5-15个标签，标签间用逗号分隔，每个标签2-8个字。' +
  '只输出标签，不要描述句、不要编号列表、不要多余解释。';

export type TagImagesResult =
  | { ok: true; tags: string[] }
  | { ok: false; error: string };

export async function tagImages(
  fetchImpl: typeof fetch,
  target: UpstreamTarget,
  images: string[],
  signal: AbortSignal,
): Promise<TagImagesResult> {
  const result = await visionChat(
    fetchImpl,
    target,
    'You are an image tagging assistant.',
    VISION_TAG_SYSTEM_PROMPT,
    images,
    signal,
  );
  if (!result.ok) return result;
  if (!result.text) {
    return { ok: false, error: 'vision model returned an empty tag list' };
  }

  const tags = new Set<string>();
  for (const line of result.text.split(/\r?\n/)) {
    // strip the "参考图 N：" prefix, then split on comma-like separators
    const body = line.replace(/^参考图\s*\d*\s*[:：]?\s*/, '').trim();
    for (const raw of body.split(/[,，、;；]/)) {
      const tag = raw.trim().replace(/^[#·\-*\s]+/, '').replace(/[。.]+$/, '');
      if (tag) tags.add(tag);
    }
  }
  return { ok: true, tags: [...tags].slice(0, 100) };
}

export const TEMPLATIZE_SYSTEM_PROMPT =
  '你是提示词模板化助手。请把用户给定的文生图提示词转换为带 {变量} 占位符的模板。\n' +
  '要求：\n' +
  '1. 提取 3-6 个最值得变化的片段（如风格、主体、场景、光线、构图、色彩等）\n' +
  '2. 变量名用简短的中文语义名（如 风格、主体、场景）\n' +
  '3. 原文中对应的片段必须作为该变量的第一个候选值，并保持原文语言\n' +
  '4. 每个变量再补充 4-9 个与原文风格一致、贴合语境的候选值（共 5-10 个）\n' +
  '5. 只输出一个 JSON 对象，不要 markdown 代码块、不要任何额外说明，格式：\n' +
  '{"template": "替换后的完整模板文本", "variables": [{"name": "风格", "values": ["原文片段", "候选值2", "候选值3"]}]}';

export interface TemplatizeVariables {
  name: string;
  values: string[];
}

export type TemplatizeResult =
  | { ok: true; template: string; variables: TemplatizeVariables[] }
  | { ok: false; error: string };

function parseTemplatizeJson(
  text: string,
): { template: string; variables: TemplatizeVariables[] } | null {
  let raw = text.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as { template?: unknown; variables?: unknown };
  if (typeof obj.template !== 'string' || !obj.template.trim()) return null;
  if (!Array.isArray(obj.variables)) return null;

  const variables: TemplatizeVariables[] = [];
  const seen = new Set<string>();
  for (const v of obj.variables) {
    if (!v || typeof v !== 'object') return null;
    const vv = v as { name?: unknown; values?: unknown };
    if (typeof vv.name !== 'string' || !vv.name.trim() || seen.has(vv.name)) return null;
    if (!Array.isArray(vv.values)) return null;
    const values = vv.values
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .map((s) => s.trim());
    if (values.length < 2) return null;
    seen.add(vv.name);
    variables.push({ name: vv.name, values });
  }
  if (variables.length === 0) return null;
  // every placeholder in the template must have a variable, and every
  // variable must appear in the template (rejects stray {x} from the model)
  for (const v of variables) {
    if (!obj.template.includes(`{${v.name}}`)) return null;
  }
  for (const name of extractVariables(obj.template)) {
    if (!seen.has(name)) return null;
  }
  return { template: obj.template, variables };
}

export async function templatizePrompt(
  fetchImpl: typeof fetch,
  target: UpstreamTarget,
  content: string,
  signal: AbortSignal,
): Promise<TemplatizeResult> {
  const result = await chatCompletions(
    fetchImpl,
    target,
    {
      messages: [
        { role: 'system', content: TEMPLATIZE_SYSTEM_PROMPT },
        { role: 'user', content },
      ],
    },
    signal,
  );
  if (!result.ok) return result;

  const data = (await result.response.json()) as {
    choices?: { message?: { content?: unknown } }[];
  };
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: '模型返回了空内容' };
  }
  const parsed = parseTemplatizeJson(text);
  if (!parsed) {
    return { ok: false, error: '模型输出格式不符合预期（应为 JSON 对象）' };
  }
  return { ok: true, ...parsed };
}

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
  // Ollama's OpenAI-compatible endpoint defaults to num_gpu=0 (CPU only);
  // -1 lets Ollama pick the best device (GPU when available).
  if (target.kind === 'ollama') requestBody.options = { num_gpu: -1 };

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
