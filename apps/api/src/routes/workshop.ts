import { Router, type Response } from 'express';
import type { ConversationRepository } from '../db/conversations.js';
import { PROVIDER_IDS, type ProviderId } from '../llm/config.js';
import {
  CHAT_TIMEOUT_MS,
  chatCompletions,
  resolveUpstream,
  buildMessages,
  accumulateToolCalls,
  describeImages,
  resolveVisionUpstream,
  VISION_DESCRIBE_MARKER,
  type DetectedToolCalls,
} from '../llm/provider.js';
import { executeSearch } from '../search/execute.js';
import { cleanTitle, pickProviderId } from './llm.js';
import {
  BUILTIN_PRESETS,
  EXTRA_SYSTEM_PROMPT_MAX,
  WORKSHOP_HISTORY_LIMIT,
  buildSystemPrompt,
  parseSseStream,
  type ConversationMessage,
  type MessageContentPart,
  type Preset,
  type ToolCall,
} from '@prompt-forge/shared';
import {
  getMergedPresets,
  saveWorkshopConfig,
  type WorkshopConfig,
} from '../workshop/config.js';

const LIST_LIMIT = 100;
const MAX_CONTENT_CHARS = 8000;
const MAX_CURRENT_PROMPT_CHARS = 20_000;
const MAX_STREAM_TEXT_CHARS = 50_000;
const MAX_PARSE_BUFFER_CHARS = 1_000_000;
const MAX_IMAGES = 5;
const PRESET_NAME_MAX = 100;
const PRESET_DESC_MAX = 500;
const PRESET_INSTRUCTIONS_MAX = 20_000;
const TITLE_CONTEXT_MESSAGES = 10;
const MAX_TITLE_CONTEXT_CHARS = 4000;
const TITLE_TIMEOUT_MS = CHAT_TIMEOUT_MS;
const VISION_TIMEOUT_MS = 300_000;

const TITLE_SYSTEM_PROMPT =
  '你是一个标题生成助手。根据提供的内容（可能是一段对话或一个提示词），生成一个简洁、准确概括其主题的中文标题，最多 20 个字。' +
  '只输出标题本身：不要引号、不要多余说明、不要句末标点、不要换行。';

const REVERSE_ENHANCE_SYSTEM_PROMPT =
  '你是文生图提示词专家。请基于用户提供的图片描述，将其转化为一段完整、连贯、可直接用于文生图模型的提示词。\n' +
  '要求：\n' +
  '1. 按「主体→背景→风格→光影」顺序组织内容，各部分用中文自然描述，不编号不打标签\n' +
  '2. 补充图片描述中缺失但对生成效果重要的细节（材质纹理、光线方向、氛围感等）\n' +
  '3. 输出为一段通顺的完整文本，不要加注释、引号或额外说明\n' +
  '4. 保留原图的关键视觉元素，不添加与原图无关的内容';

const REVERSE_USER_PROMPT = '请基于以下图片描述，生成文生图提示词：\n\n';

export interface WorkshopDeps {
  fetchImpl?: typeof fetch;
  workshopConfig: WorkshopConfig;
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

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as string[]).includes(value);
}

function isPresetId(value: unknown, presets: Preset[]): value is string {
  return typeof value === 'string' && presets.some((p) => p.id === value);
}

function sendEvent(res: Response, payload: Record<string, unknown>): boolean {
  if (res.writableEnded || res.destroyed) return false;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  return true;
}

function validateImages(images: unknown): string[] | null {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) return null;
  if (images.length > MAX_IMAGES) return null;
  for (const img of images) {
    if (typeof img !== 'string' || !img.startsWith('data:image/')) return null;
  }
  return images as string[];
}

function toMultimodalContent(images?: string[]): MessageContentPart[] | null {
  if (!images || images.length === 0) return null;
  return images.map((url) => ({
    type: 'image_url' as const,
    image_url: { url },
  }));
}

function appendVisionDescription(content: string, description: string): string {
  if (content.length >= MAX_CONTENT_CHARS) return content;
  const budget = MAX_CONTENT_CHARS - content.length;
  const desc =
    description.length > budget ? description.slice(0, budget) : description;
  return `${content}\n\n[${VISION_DESCRIBE_MARKER}]\n${desc}`;
}

function buildTitleContext(messages: ConversationMessage[]): string {
  const lines: string[] = [];
  let total = 0;
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = m.content.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const line = `${m.role === 'user' ? '用户' : '助手'}：${text}`;
    if (total + line.length > MAX_TITLE_CONTEXT_CHARS && lines.length > 0) break;
    lines.push(line);
    total += line.length;
    if (total >= MAX_TITLE_CONTEXT_CHARS) break;
  }
  return lines.join('\n').slice(0, MAX_TITLE_CONTEXT_CHARS);
}

export function createWorkshopRouter(
  repo: ConversationRepository,
  deps: WorkshopDeps,
): Router {
  const router = Router();
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  let config = deps.workshopConfig;

  function mergedPresets(): Preset[] {
    return getMergedPresets(config);
  }

  function presetById(id: string): Preset | undefined {
    return getMergedPresets(config).find((p) => p.id === id);
  }

  function persistConfig(next: WorkshopConfig): void {
    config = next;
    saveWorkshopConfig(next);
  }

  router.get('/presets', (_req, res) => {
    res.json(mergedPresets());
  });

  router.post('/presets', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const instructions = typeof body.instructions === 'string' ? body.instructions : '';

    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id)) {
      res.status(400).json({
        error: 'id must be 1-32 characters of letters, digits, "-" or "_"',
      });
      return;
    }
    if (!name || name.length > PRESET_NAME_MAX) {
      res.status(400).json({ error: `name must be 1-${PRESET_NAME_MAX} characters` });
      return;
    }
    if (description.length > PRESET_DESC_MAX) {
      res.status(400).json({ error: `description must be at most ${PRESET_DESC_MAX} characters` });
      return;
    }
    if (!instructions || instructions.length > PRESET_INSTRUCTIONS_MAX) {
      res.status(400).json({
        error: `instructions must be 1-${PRESET_INSTRUCTIONS_MAX} characters`,
      });
      return;
    }
    if (config.customPresets.some((p) => p.id === id)) {
      res.status(409).json({ error: `preset "${id}" already exists` });
      return;
    }

    persistConfig({
      ...config,
      customPresets: [...config.customPresets, { id, name, description, instructions }],
    });
    res.status(201).json(presetById(id));
  });

  router.put('/presets/:id', (req, res) => {
    const id = req.params.id;
    if (!config.customPresets.some((p) => p.id === id)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const instructions = typeof body.instructions === 'string' ? body.instructions : '';

    if (!name || name.length > PRESET_NAME_MAX) {
      res.status(400).json({ error: `name must be 1-${PRESET_NAME_MAX} characters` });
      return;
    }
    if (description.length > PRESET_DESC_MAX) {
      res.status(400).json({ error: `description must be at most ${PRESET_DESC_MAX} characters` });
      return;
    }
    if (!instructions || instructions.length > PRESET_INSTRUCTIONS_MAX) {
      res.status(400).json({
        error: `instructions must be 1-${PRESET_INSTRUCTIONS_MAX} characters`,
      });
      return;
    }

    persistConfig({
      ...config,
      customPresets: config.customPresets.map((p) =>
        p.id === id ? { ...p, name, description, instructions } : p,
      ),
    });
    res.json(presetById(id));
  });

  router.delete('/presets/:id', (req, res) => {
    const id = req.params.id;
    if (!config.customPresets.some((p) => p.id === id)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    persistConfig({
      ...config,
      customPresets: config.customPresets.filter((p) => p.id !== id),
    });
    res.status(204).end();
  });

  router.get('/config', (_req, res) => {
    res.json({ defaultExtraSystemPrompt: config.defaultExtraSystemPrompt });
  });

  router.put('/config', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const defaultExtraSystemPrompt =
      typeof body.defaultExtraSystemPrompt === 'string'
        ? body.defaultExtraSystemPrompt
        : undefined;
    if (defaultExtraSystemPrompt === undefined) {
      res.status(400).json({ error: 'defaultExtraSystemPrompt must be a string' });
      return;
    }
    if (defaultExtraSystemPrompt.length > EXTRA_SYSTEM_PROMPT_MAX) {
      res.status(400).json({
        error: `defaultExtraSystemPrompt must be at most ${EXTRA_SYSTEM_PROMPT_MAX} characters`,
      });
      return;
    }
    persistConfig({ ...config, defaultExtraSystemPrompt });
    res.json({ defaultExtraSystemPrompt });
  });

  router.get('/conversations', (req, res) => {
    const promptId = typeof req.query.promptId === 'string' ? req.query.promptId : undefined;
    const conversations = promptId
      ? repo.listByPrompt(promptId)
      : repo.listRecent(LIST_LIMIT);
    res.json(conversations);
  });

  router.post('/conversations', (req, res) => {
    const body = (req.body ?? {}) as {
      promptId?: unknown;
      title?: unknown;
      providerId?: unknown;
      presetId?: unknown;
      extraSystemPrompt?: unknown;
    };

    const presets = mergedPresets();
    const providerId = body.providerId ?? 'cloud';
    if (!isProviderId(providerId)) {
      res.status(400).json({ error: `providerId must be one of: ${PROVIDER_IDS.join(', ')}` });
      return;
    }
    const presetId = body.presetId ?? 'tags';
    if (!isPresetId(presetId, presets)) {
      res.status(400).json({
        error: `presetId must be one of: ${presets.map((p) => p.id).join(', ')}`,
      });
      return;
    }
    const extraSystemPrompt =
      typeof body.extraSystemPrompt === 'string'
        ? body.extraSystemPrompt
        : config.defaultExtraSystemPrompt;
    if (extraSystemPrompt.length > EXTRA_SYSTEM_PROMPT_MAX) {
      res.status(400).json({
        error: `extraSystemPrompt must be at most ${EXTRA_SYSTEM_PROMPT_MAX} characters`,
      });
      return;
    }

    let conversation;
    try {
      conversation = repo.create({
        promptId:
          body.promptId === undefined || body.promptId === null
            ? undefined
            : typeof body.promptId === 'string'
              ? body.promptId
              : undefined,
        title: typeof body.title === 'string' ? body.title : undefined,
        providerId,
        presetId,
        extraSystemPrompt,
      });
    } catch {
      res.status(400).json({ error: 'promptId does not exist' });
      return;
    }
    res.status(201).json(conversation);
  });

  router.get('/conversations/:id', (req, res) => {
    const conversation = repo.getById(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ ...conversation, messages: repo.listMessages(conversation.id) });
  });

  router.put('/conversations/:id', (req, res) => {
    const body = (req.body ?? {}) as {
      title?: unknown;
      providerId?: unknown;
      presetId?: unknown;
      extraSystemPrompt?: unknown;
      enableSearch?: unknown;
    };

    if (body.providerId !== undefined && !isProviderId(body.providerId)) {
      res.status(400).json({ error: `providerId must be one of: ${PROVIDER_IDS.join(', ')}` });
      return;
    }
    if (body.presetId !== undefined && !isPresetId(body.presetId, mergedPresets())) {
      res.status(400).json({
        error: `presetId must be one of: ${mergedPresets().map((p) => p.id).join(', ')}`,
      });
      return;
    }
    if (
      body.extraSystemPrompt !== undefined &&
      typeof body.extraSystemPrompt !== 'string'
    ) {
      res.status(400).json({ error: 'extraSystemPrompt must be a string' });
      return;
    }
    if (
      typeof body.extraSystemPrompt === 'string' &&
      body.extraSystemPrompt.length > EXTRA_SYSTEM_PROMPT_MAX
    ) {
      res.status(400).json({
        error: `extraSystemPrompt must be at most ${EXTRA_SYSTEM_PROMPT_MAX} characters`,
      });
      return;
    }

    const conversation = repo.update(req.params.id, {
      title: typeof body.title === 'string' ? body.title : undefined,
      providerId: body.providerId as ProviderId | undefined,
      presetId: typeof body.presetId === 'string' ? body.presetId : undefined,
      extraSystemPrompt:
        typeof body.extraSystemPrompt === 'string' ? body.extraSystemPrompt : undefined,
      enableSearch:
        body.enableSearch !== undefined
          ? Boolean(body.enableSearch)
          : undefined,
    });
    if (!conversation) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(conversation);
  });

  router.delete('/conversations/:id', (req, res) => {
    const ok = repo.delete(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.status(204).end();
  });

  router.post('/conversations/:id/undo', (req, res) => {
    const conversation = repo.getById(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const removed = repo.undoLastExchange(conversation.id);
    repo.touch(conversation.id);
    res.json({ removed });
  });

  router.post('/conversations/:id/title', async (req, res) => {
    const conversation = repo.getById(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const body = (req.body ?? {}) as { currentPrompt?: unknown };
    const currentPrompt =
      typeof body.currentPrompt === 'string' ? body.currentPrompt.trim() : '';
    const context = currentPrompt
      ? currentPrompt.slice(0, MAX_TITLE_CONTEXT_CHARS)
      : buildTitleContext(
          repo.listRecentMessages(conversation.id, TITLE_CONTEXT_MESSAGES),
        );
    if (!context) {
      res.status(400).json({ error: 'conversation has no content to summarize' });
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
    const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
    try {
      const result = await chatCompletions(
        fetchImpl,
        upstream.value,
        {
          messages: [
            { role: 'system', content: TITLE_SYSTEM_PROMPT },
            { role: 'user', content: context },
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
      repo.update(conversation.id, { title });
      res.json({ title, model: data.model ?? upstream.value.model });
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      res.status(aborted ? 504 : 502).json({
        error: aborted
          ? 'upstream request timed out'
          : e instanceof Error
            ? e.message
            : 'upstream request failed',
      });
    } finally {
      clearTimeout(timer);
    }
  });

  router.post('/conversations/:id/chat', async (req, res) => {
    const conversation = repo.getById(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const body = (req.body ?? {}) as {
      content?: unknown;
      currentPrompt?: unknown;
      images?: unknown;
    };

    let content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content) {
      res.status(400).json({ error: 'content must be a non-empty string' });
      return;
    }
    if (content.length > MAX_CONTENT_CHARS) {
      res.status(400).json({
        error: `content must be at most ${MAX_CONTENT_CHARS} characters`,
      });
      return;
    }

    const currentPrompt =
      typeof body.currentPrompt === 'string' ? body.currentPrompt : undefined;
    if (currentPrompt !== undefined && currentPrompt.length > MAX_CURRENT_PROMPT_CHARS) {
      res.status(400).json({
        error: `currentPrompt must be at most ${MAX_CURRENT_PROMPT_CHARS} characters`,
      });
      return;
    }

    const images = validateImages(body.images);
    if (images === null) {
      res.status(400).json({
        error: `images must be an array of up to ${MAX_IMAGES} data:image/... strings`,
      });
      return;
    }

    const upstream = resolveUpstream(conversation.providerId as ProviderId);
    if (!upstream.ok) {
      res.status(400).json({ error: upstream.error });
      return;
    }

    const preset = presetById(conversation.presetId);
    const presetInstructions = preset
      ? preset.instructions
      : (BUILTIN_PRESETS[2]?.instructions ?? '');

    const systemMessage =
      buildSystemPrompt(presetInstructions, currentPrompt) +
      (conversation.extraSystemPrompt.trim()
        ? `\n\n${conversation.extraSystemPrompt}`
        : '') +
      (conversation.enableSearch
        ? `\n\nYou have access to a web search tool named "search_web". When the user asks for up-to-date information, current trends, or anything requiring real-time knowledge, call the search_web tool with a concise query. The search results will be provided to you in the next turn — use them to enrich your answer. Never say you cannot search the web: the tool is available and you should call it when needed.`
        : '');

    let bridgeImages: string[] | undefined = images ?? undefined;

    const controller = new AbortController();
    const visionController = new AbortController();
    let done = false;
    let timedOut = false;
    let timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, CHAT_TIMEOUT_MS);
    const visionTimer = setTimeout(() => {
      visionController.abort();
    }, VISION_TIMEOUT_MS);

    const abortOnClose = () => {
      controller.abort();
      visionController.abort();
    };
    res.on('close', abortOnClose);

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const vision = resolveVisionUpstream();
    let history: ConversationMessage[] | undefined;
    if (vision.ok) {
      clearTimeout(timer);
      try {
        history = repo.listRecentMessages(conversation.id, WORKSHOP_HISTORY_LIMIT);
        const hasHistoryImages = history.some(
          (m) =>
            !!m.multimodalContent &&
            m.multimodalContent.length > 0 &&
            !m.content.includes(VISION_DESCRIBE_MARKER),
        );
        if (hasHistoryImages || (bridgeImages && bridgeImages.length > 0)) {
          sendEvent(res, { type: 'vision', status: 'describing' });
        }
        for (const m of history) {
          if (!m.multimodalContent || m.multimodalContent.length === 0) continue;
          if (m.content.includes(VISION_DESCRIBE_MARKER)) {
            m.multimodalContent = null;
            continue;
          }
          const urls = m.multimodalContent
            .filter((p) => p.type === 'image_url')
            .map((p) => p.image_url.url);
          if (urls.length === 0) continue;
          const desc = await describeImages(
            fetchImpl,
            vision.value,
            urls,
            visionController.signal,
          );
          if (desc.ok) {
            m.content = appendVisionDescription(m.content, desc.text);
            m.multimodalContent = null;
          }
        }
        if (bridgeImages && bridgeImages.length > 0) {
          const desc = await describeImages(
            fetchImpl,
            vision.value,
            bridgeImages,
            visionController.signal,
          );
          if (desc.ok) {
            content = appendVisionDescription(content, desc.text);
            bridgeImages = undefined;
          }
        }
      } catch {
        // vision bridge failed or aborted -> fall back to original behavior
      } finally {
        clearTimeout(visionTimer);
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, CHAT_TIMEOUT_MS);
      }
    }

    let appendedUser: ConversationMessage;
    try {
      history = history ?? repo.listRecentMessages(conversation.id, WORKSHOP_HISTORY_LIMIT);
      const mc = toMultimodalContent(images);
      appendedUser = repo.appendMessage(
        conversation.id,
        'user',
        content,
        mc,
      );
      repo.touch(conversation.id);
    } catch {
      res.off('close', abortOnClose);
      sendEvent(res, { type: 'error', message: 'conversation no longer exists' });
      res.end();
      return;
    }

    res.off('close', abortOnClose);
    const cleanupRolledBack: (() => void)[] = [];

    const onClose = () => {
      if (done) return;
      done = true;
      controller.abort();
      repo.deleteMessage(appendedUser.id);
      for (const cleanup of cleanupRolledBack.reverse()) {
        cleanup();
      }
    };
    res.on('close', onClose);
    if (res.destroyed) onClose();

    try {
      const chatMessages = buildMessages(history, content, bridgeImages);

      const fullMessages = [
        { role: 'system', content: systemMessage },
        ...chatMessages.map((m) => {
          const msg: Record<string, unknown> = { role: m.role, content: m.content };
          if (m.tool_calls) msg.tool_calls = m.tool_calls;
          if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
          return msg;
        }),
      ];

      const searchToolDef = conversation.enableSearch
        ? [
            {
              type: 'function',
              function: {
                name: 'search_web',
                description:
                  'Search the web for the latest information, trends, styles, or facts to enrich the image prompt.',
                parameters: {
                  type: 'object',
                  properties: {
                    query: { type: 'string', description: 'The search query' },
                  },
                  required: ['query'],
                },
              },
            },
          ]
        : undefined;

      const result = await doChat(
        fullMessages,
        upstream.value,
        fetchImpl,
        controller.signal,
        searchToolDef,
        { res, repo, conversationId: conversation.id, appendedUser, cleanupRolledBack },
      );

      if (result.error) {
        if (!done) {
          done = true;
          repo.deleteMessage(appendedUser.id);
        }
        sendEvent(res, { type: 'error', message: result.error });
        res.end();
        return;
      }

      done = true;
      const fullText = result.text ?? '';
      const model = result.model ?? upstream.value.model;

      if (!fullText) {
        repo.deleteMessage(appendedUser.id);
        sendEvent(res, { type: 'error', message: 'upstream returned an empty response' });
        res.end();
        return;
      }

      try {
        repo.appendMessage(conversation.id, 'assistant', fullText);
      } catch {
        sendEvent(res, { type: 'error', message: 'failed to persist assistant reply' });
        res.end();
        return;
      }

      sendEvent(res, { type: 'done', content: fullText, model });
      res.end();
    } catch (e) {
      if (!done) {
        done = true;
        repo.deleteMessage(appendedUser.id);
      }
      if (!res.writableEnded && !res.destroyed) {
        const message =
          e instanceof Error && e.name === 'AbortError'
            ? timedOut
              ? 'upstream request timed out'
              : 'request aborted'
            : e instanceof Error
              ? e.message
              : 'upstream request failed';
        sendEvent(res, { type: 'error', message });
        res.end();
      }
    } finally {
      clearTimeout(timer);
      clearTimeout(visionTimer);
      res.off('close', onClose);
    }
  });

  router.post('/conversations/:id/reverse', async (req, res) => {
    const conversation = repo.getById(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const body = (req.body ?? {}) as { images?: unknown };
    const images = validateImages(body.images);
    if (images === null) {
      res.status(400).json({
        error: `images must be an array of up to ${MAX_IMAGES} data:image/... strings`,
      });
      return;
    }
    if (images.length === 0) {
      res.status(400).json({ error: 'images must be a non-empty array' });
      return;
    }

    const vision = resolveVisionUpstream();
    if (!vision.ok) {
      res.status(400).json({
        error: '识图模型未配置：请先在设置页配置识图模型后再使用反推功能',
      });
      return;
    }

    const upstream = resolveUpstream(conversation.providerId as ProviderId);
    if (!upstream.ok) {
      res.status(400).json({ error: upstream.error });
      return;
    }

    const controller = new AbortController();
    const visionController = new AbortController();
    let done = false;
    let timedOut = false;
    let visionTimedOut = false;
    let timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, CHAT_TIMEOUT_MS);
    const visionTimer = setTimeout(() => {
      visionTimedOut = true;
      visionController.abort();
    }, VISION_TIMEOUT_MS);

    const abortOnClose = () => {
      controller.abort();
      visionController.abort();
    };
    res.on('close', abortOnClose);

    clearTimeout(timer);
    let description: string;
    try {
      const desc = await describeImages(
        fetchImpl,
        vision.value,
        images,
        visionController.signal,
      );
      if (!desc.ok) {
        res.off('close', abortOnClose);
        clearTimeout(visionTimer);
        res.status(502).json({ error: desc.error });
        return;
      }
      description = desc.text;
    } catch (e) {
      res.off('close', abortOnClose);
      clearTimeout(visionTimer);
      const aborted = e instanceof Error && e.name === 'AbortError';
      res.status(aborted ? 504 : 502).json({
        error: aborted
          ? visionTimedOut
            ? 'vision request timed out'
            : 'vision request aborted'
          : e instanceof Error
            ? e.message
            : 'vision request failed',
      });
      return;
    }
    clearTimeout(visionTimer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, CHAT_TIMEOUT_MS);

    let appendedUser: ConversationMessage;
    try {
      appendedUser = repo.appendMessage(
        conversation.id,
        'user',
        appendVisionDescription('反推提示词', description),
        toMultimodalContent(images),
      );
      repo.touch(conversation.id);
    } catch {
      res.off('close', abortOnClose);
      res.status(404).json({ error: 'conversation no longer exists' });
      return;
    }

    res.off('close', abortOnClose);
    const onClose = () => {
      if (done) return;
      done = true;
      controller.abort();
      repo.deleteMessage(appendedUser.id);
    };
    res.on('close', onClose);
    if (res.destroyed) onClose();

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const enhanceMessages = [
      { role: 'system', content: REVERSE_ENHANCE_SYSTEM_PROMPT },
      { role: 'user', content: `${REVERSE_USER_PROMPT}${description}` },
    ];

    let fullText = '';
    let model: string | undefined = upstream.value.model;
    try {
      const result = await chatCompletions(
        fetchImpl,
        upstream.value,
        { messages: enhanceMessages, stream: true },
        controller.signal,
      );
      if (!result.ok) {
        if (!done) {
          done = true;
          repo.deleteMessage(appendedUser.id);
        }
        sendEvent(res, { type: 'error', message: result.error });
        res.end();
        return;
      }

      const up = result.response;
      const contentType = up.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream') && up.body) {
        try {
          for await (const data of parseSseStream(up.body, MAX_PARSE_BUFFER_CHARS)) {
            if (data === '[DONE]') break;
            let parsed: UpstreamDelta | null = null;
            try {
              parsed = JSON.parse(data) as UpstreamDelta;
            } catch {
              continue;
            }
            if (!parsed) continue;
            if (typeof parsed.model === 'string') model = parsed.model;
            const textDelta =
              typeof parsed.choices?.[0]?.delta?.content === 'string'
                ? parsed.choices[0].delta.content
                : '';
            if (textDelta) {
              if (fullText.length + textDelta.length > MAX_STREAM_TEXT_CHARS) {
                throw new Error(
                  `upstream response exceeds ${MAX_STREAM_TEXT_CHARS} characters`,
                );
              }
              fullText += textDelta;
              sendEvent(res, { type: 'chunk', text: textDelta });
            }
          }
        } catch (e) {
          throw e instanceof Error
            ? e
            : new Error('upstream stream error');
        }
      } else {
        const fd = (await up.json()) as {
          choices?: { message?: { content?: unknown } }[];
          model?: string;
        };
        const ft = fd.choices?.[0]?.message?.content;
        if (typeof ft === 'string' && ft) {
          if (ft.length > MAX_STREAM_TEXT_CHARS) {
            throw new Error(
              `upstream response exceeds ${MAX_STREAM_TEXT_CHARS} characters`,
            );
          }
          fullText = ft;
          model = fd.model ?? model;
          sendEvent(res, { type: 'chunk', text: ft });
        }
      }

      if (!fullText) {
        if (!done) {
          done = true;
          repo.deleteMessage(appendedUser.id);
        }
        sendEvent(res, { type: 'error', message: 'upstream returned an empty response' });
        res.end();
        return;
      }

      done = true;
      try {
        repo.appendMessage(conversation.id, 'assistant', fullText);
      } catch {
        sendEvent(res, { type: 'error', message: 'failed to persist assistant reply' });
        res.end();
        return;
      }

      sendEvent(res, { type: 'done', content: fullText, model });
      res.end();
    } catch (e) {
      if (!done) {
        done = true;
        repo.deleteMessage(appendedUser.id);
      }
      if (!res.writableEnded && !res.destroyed) {
        const message =
          e instanceof Error && e.name === 'AbortError'
            ? timedOut
              ? 'upstream request timed out'
              : 'request aborted'
            : e instanceof Error
              ? e.message
              : 'upstream request failed';
        sendEvent(res, { type: 'error', message });
        res.end();
      }
    } finally {
      clearTimeout(timer);
      clearTimeout(visionTimer);
      res.off('close', onClose);
    }
  });

  return router;
}

interface ChatResult {
  text?: string;
  model?: string;
  error?: string;
}

interface ChatContext {
  res: Response;
  repo: ConversationRepository;
  conversationId: string;
  appendedUser: ConversationMessage;
  cleanupRolledBack: (() => void)[];
}

async function doChat(
  messages: Record<string, unknown>[],
  target: import('../llm/provider.js').UpstreamTarget,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  tools: Record<string, unknown>[] | undefined,
  ctx: ChatContext,
): Promise<ChatResult> {
  const body: import('../llm/provider.js').ChatCompletionsBody = {
    messages,
    stream: true,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const result = await chatCompletions(fetchImpl, target, body, signal);
  if (!result.ok) {
    return { error: result.error };
  }

  const up = result.response;
  const contentType = up.headers.get('content-type') ?? '';
  let fullText = '';
  let sentText = '';
  let model: string | undefined = target.model;
  let accumulatedToolCalls: ToolCall[] = [];

  if (contentType.includes('text/event-stream') && up.body) {
    try {
      for await (const data of parseSseStream(up.body, MAX_PARSE_BUFFER_CHARS)) {
        if (data === '[DONE]') {
          break;
        }
        let parsed: UpstreamDelta | null = null;
        try {
          parsed = JSON.parse(data) as UpstreamDelta;
        } catch {
          continue;
        }
        if (!parsed) continue;
        if (typeof parsed.model === 'string') model = parsed.model;

        const choice = parsed.choices?.[0];
        const delta = choice?.delta;

        if (
          delta?.tool_calls &&
          delta.tool_calls.length > 0
        ) {
          const tcResult: DetectedToolCalls = accumulateToolCalls(
            parsed,
            accumulatedToolCalls,
            fullText,
          );
          fullText = tcResult.fullText;
          accumulatedToolCalls = tcResult.toolCalls;
          continue;
        }

        const textDelta = typeof delta?.content === 'string' ? delta.content : '';
        if (textDelta) {
          if (fullText.length + textDelta.length > MAX_STREAM_TEXT_CHARS) {
            return { error: `upstream response exceeds ${MAX_STREAM_TEXT_CHARS} characters` };
          }
          fullText += textDelta;
          sentText += textDelta;
          sendEvent(ctx.res, { type: 'chunk', text: textDelta });
        }
      }
    } catch (e) {
      return {
        error: e instanceof Error ? e.message : 'upstream stream error',
      };
    }
  } else {
    const data = (await up.json()) as {
      choices?: {
        message?: {
          content?: unknown;
          tool_calls?: {
            id: string;
            type: 'function';
            function: { name: string; arguments: string };
          }[];
        };
        finish_reason?: string;
      }[];
      model?: string;
    };
    const msg = data.choices?.[0]?.message;
    if (msg?.tool_calls && msg.tool_calls.length > 0) {
      fullText = typeof msg.content === 'string' ? msg.content : '';
      accumulatedToolCalls = msg.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));
    } else {
      const text = typeof msg?.content === 'string' ? msg.content : '';
      if (text) {
        if (text.length > MAX_STREAM_TEXT_CHARS) {
          return { error: `upstream response exceeds ${MAX_STREAM_TEXT_CHARS} characters` };
        }
        fullText = text;
        sentText = text;
        model = data.model ?? model;
        sendEvent(ctx.res, { type: 'chunk', text });
      }
    }
  }

  if (accumulatedToolCalls.length > 0) {
    const normalizedCalls: ToolCall[] = accumulatedToolCalls.map((tc, i) => ({
      ...tc,
      id: tc.id || `call_${i}`,
    }));

    const toolResults: { role: 'tool'; tool_call_id: string; content: string }[] = [];

    for (const tc of normalizedCalls) {
      if (tc.function.name === 'search_web') {
        let query = '';
        try {
          query = (JSON.parse(tc.function.arguments).query as string) ?? '';
        } catch {
          query = '';
        }
        if (!query) {
          toolResults.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: 'no search query provided',
          });
          continue;
        }
        sendEvent(ctx.res, { type: 'tool_search', query });
        const searchResult = await executeSearch(query, fetchImpl);
        toolResults.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: `query: ${query}\n\n${searchResult}`,
        });
      } else {
        toolResults.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: `Tool "${tc.function.name}" is not available`,
        });
      }
    }

    const toolCallContent = fullText || '';
    ctx.repo.appendMessage(ctx.conversationId, 'assistant', toolCallContent, null);
    const tcMsg = ctx.repo.listRecentMessages(ctx.conversationId, 1)[0];
    if (tcMsg) {
      ctx.cleanupRolledBack.push(() => ctx.repo.deleteMessage(tcMsg.id));
    }
    for (const tr of toolResults) {
      ctx.repo.appendMessage(ctx.conversationId, 'tool', tr.content);
      const msg = ctx.repo.listRecentMessages(ctx.conversationId, 1)[0];
      if (msg) {
        ctx.cleanupRolledBack.push(() => ctx.repo.deleteMessage(msg.id));
      }
    }

    const followUpMessages = [
      ...messages,
      {
        role: 'assistant',
        content: toolCallContent || null,
        tool_calls: normalizedCalls.map((tc) => ({
          id: tc.id,
          type: tc.type,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
      },
      ...toolResults,
    ];

    if (fullText.length > sentText.length) {
      sendEvent(ctx.res, {
        type: 'chunk',
        text: fullText.slice(sentText.length),
      });
    }

    const followUpBody: import('../llm/provider.js').ChatCompletionsBody = {
      messages: followUpMessages,
      stream: true,
    };

    const followUpResult = await chatCompletions(
      fetchImpl,
      target,
      followUpBody,
      signal,
    );

    if (!followUpResult.ok) {
      return { error: followUpResult.error };
    }

    let followText = '';
    const followUp = followUpResult.response;
    const followContentType = followUp.headers.get('content-type') ?? '';

    if (followContentType.includes('text/event-stream') && followUp.body) {
      try {
        for await (const data of parseSseStream(followUp.body, MAX_PARSE_BUFFER_CHARS)) {
          if (data === '[DONE]') break;
          let parsed: UpstreamDelta | null = null;
          try {
            parsed = JSON.parse(data) as UpstreamDelta;
          } catch {
            continue;
          }
          if (!parsed) continue;
          if (typeof parsed.model === 'string') model = parsed.model;
          const textDelta =
            typeof parsed.choices?.[0]?.delta?.content === 'string'
              ? parsed.choices[0].delta.content
              : '';
          if (textDelta) {
            if (followText.length + textDelta.length > MAX_STREAM_TEXT_CHARS) {
              return {
                error: `upstream response exceeds ${MAX_STREAM_TEXT_CHARS} characters`,
              };
            }
            followText += textDelta;
            sendEvent(ctx.res, { type: 'chunk', text: textDelta });
          }
        }
      } catch (e) {
        return {
          error: e instanceof Error ? e.message : 'upstream second stream error',
        };
      }
    } else {
      const fd = (await followUp.json()) as {
        choices?: { message?: { content?: unknown } }[];
        model?: string;
      };
      const ft = fd.choices?.[0]?.message?.content;
      if (typeof ft === 'string' && ft) {
        if (ft.length > MAX_STREAM_TEXT_CHARS) {
          return { error: `upstream response exceeds ${MAX_STREAM_TEXT_CHARS} characters` };
        }
        followText = ft;
        model = fd.model ?? model;
        sendEvent(ctx.res, { type: 'chunk', text: ft });
      }
    }

    ctx.cleanupRolledBack.length = 0;

    return { text: followText || fullText, model };
  }

  return { text: fullText, model };
}
