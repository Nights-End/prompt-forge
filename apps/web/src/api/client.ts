import type {
  Asset,
  Conversation,
  ConversationMessage,
  CreateConversationInput,
  Preset,
  Prompt,
  PromptInput,
  ListPromptQuery,
  RenderResult,
} from '@prompt-forge/shared';
import { parseSseStream } from '@prompt-forge/shared';
import type {
  ProviderId,
  ProviderKind,
  ProviderPublicSettings,
  ProviderSettingsInput,
  VisionPublicSettings,
  VisionSettingsInput,
} from '../types';

const BASE = '/api';

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data as T;
}

function toQuery(query: ListPromptQuery): string {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.category) params.set('category', query.category);
  if (query.tag) params.set('tag', query.tag);
  if (query.favorite !== undefined) params.set('favorite', String(query.favorite));
  if (query.type) params.set('type', query.type);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export const api = {
  listPrompts: (query: ListPromptQuery = {}) =>
    request<Prompt[]>(`/prompts${toQuery(query)}`),
  getPrompt: (id: string) => request<Prompt>(`/prompts/${id}`),
  createPrompt: (input: PromptInput) =>
    request<Prompt>('/prompts', { method: 'POST', body: JSON.stringify(input) }),
  updatePrompt: (id: string, input: PromptInput) =>
    request<Prompt>(`/prompts/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  deletePrompt: (id: string) =>
    request<void>(`/prompts/${id}`, { method: 'DELETE' }),
  getCategories: () => request<string[]>('/meta/categories'),
  listTags: () => request<string[]>('/meta/tags'),
  generatePromptTags: (id: string) =>
    request<{ tags: string[]; added: number }>(
      `/prompts/${encodeURIComponent(id)}/generate-tags`,
      { method: 'POST' },
    ),
  templatizePrompt: (id: string) =>
    request<{ template: string; variables: { name: string; values: string[] }[] }>(
      `/prompts/${encodeURIComponent(id)}/templatize`,
      { method: 'POST' },
    ),
  renderPrompt: (promptId: string, values: Record<string, string>) =>
    request<RenderResult>('/prompts/render', {
      method: 'POST',
      body: JSON.stringify({ promptId, values }),
    }),
  renderPromptBatch: (promptId: string, count: number) =>
    request<{ rendered: string[] | string; assets: { id: string; url: string; kind: string }[] }>(
      '/prompts/render',
      { method: 'POST', body: JSON.stringify({ promptId, count }) },
    ),
  listAssets: (promptId: string) =>
    request<Asset[]>(`/prompts/${promptId}/assets`),
  listAssetsByPrompts: (promptIds: string[]) =>
    request<Record<string, Asset[]>>(
      `/assets/by-prompts?ids=${promptIds.map(encodeURIComponent).join(',')}`,
    ),
  uploadAssets: async (promptId: string, files: File[]) => {
    const form = new FormData();
    for (const file of files) form.append('files', file);
    const res = await fetch(`${BASE}/prompts/${promptId}/assets`, {
      method: 'POST',
      body: form,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(
        (data as { error?: string } | null)?.error ?? `Upload failed (${res.status})`,
      );
    }
    return data as Asset[];
  },
  deleteAsset: (promptId: string, assetId: string) =>
    request<void>(`/prompts/${promptId}/assets/${assetId}`, { method: 'DELETE' }),
  reorderAssets: (promptId: string, assetIds: string[]) =>
    request<Asset[]>(`/prompts/${promptId}/assets/order`, {
      method: 'PUT',
      body: JSON.stringify({ assetIds }),
    }),
  assetFileUrl: (assetId: string) => `${BASE}/assets/${assetId}/file`,
  exportZip: async (): Promise<Blob> => {
    const res = await fetch(`${BASE}/export`);
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    return res.blob();
  },
  exportJson: () => request<{ prompts: Prompt[] }>('/export?format=json'),
  importAll: (prompts: Prompt[]) =>
    request<{ imported: number; skipped: number }>('/import', {
      method: 'POST',
      body: JSON.stringify({ prompts }),
    }),
  importFile: async (file: File) => {
    if (file.name.toLowerCase().endsWith('.json')) {
      const text = await file.text();
      const data = JSON.parse(text) as { prompts?: Prompt[] } | Prompt[];
      const prompts = Array.isArray(data) ? data : data.prompts ?? [];
      return api.importAll(prompts);
    }
    const res = await fetch(`${BASE}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: file,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(
        (data as { error?: string } | null)?.error ?? `Import failed (${res.status})`,
      );
    }
    return data as { imported: number; skipped: number; assets: number };
  },
  getProviderSettings: () =>
    request<{ providers: Record<ProviderId, ProviderPublicSettings> }>(
      '/settings/provider',
    ),
  saveProviderSettings: (
    providers: Record<ProviderId, ProviderSettingsInput>,
  ) =>
    request<{ providers: Record<ProviderId, ProviderPublicSettings> }>(
      '/settings/provider',
      { method: 'PUT', body: JSON.stringify({ providers }) },
    ),
  getVisionSettings: () =>
    request<VisionPublicSettings>('/settings/vision'),
  saveVisionSettings: (input: VisionSettingsInput) =>
    request<VisionPublicSettings>('/settings/vision', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  fetchModels: (input: {
    id: ProviderId | 'vision';
    kind: ProviderKind;
    baseUrl: string;
    apiKey?: string;
  }) =>
    request<{ models: string[] }>('/settings/provider/models', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  listConversations: (promptId?: string) =>
    request<Conversation[]>(
      `/workshop/conversations${promptId ? `?promptId=${encodeURIComponent(promptId)}` : ''}`,
    ),
  listPresets: () => request<Preset[]>('/workshop/presets'),
  createPreset: (input: {
    id: string;
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<Preset>('/workshop/presets', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updatePreset: (
    id: string,
    input: { name: string; description: string; instructions: string },
  ) =>
    request<Preset>(`/workshop/presets/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  deletePreset: (id: string) =>
    request<void>(`/workshop/presets/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  getWorkshopConfig: () =>
    request<{ defaultExtraSystemPrompt: string }>('/workshop/config'),
  saveWorkshopConfig: (patch: { defaultExtraSystemPrompt?: string }) =>
    request<{ defaultExtraSystemPrompt: string }>('/workshop/config', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  getPromptsSettings: () =>
    request<{ defaultCategory: string }>('/settings/prompts'),
  savePromptsSettings: (patch: { defaultCategory?: string }) =>
    request<{ defaultCategory: string }>('/settings/prompts', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  createConversation: (input: CreateConversationInput) =>
    request<Conversation>('/workshop/conversations', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  getConversation: (id: string) =>
    request<Conversation & { messages: ConversationMessage[] }>(
      `/workshop/conversations/${id}`,
    ),
  updateConversation: (
    id: string,
    patch: {
      title?: string;
      providerId?: string;
      presetId?: string;
      extraSystemPrompt?: string;
      enableSearch?: boolean;
    },
  ) =>
    request<Conversation>(`/workshop/conversations/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  deleteConversation: (id: string) =>
    request<void>(`/workshop/conversations/${id}`, { method: 'DELETE' }),
  undoConversation: (id: string) =>
    request<{ removed: number }>(`/workshop/conversations/${id}/undo`, {
      method: 'POST',
    }),
  generateConversationTitle: (id: string, currentPrompt?: string) =>
    request<{ title: string; model?: string }>(
      `/workshop/conversations/${id}/title`,
      { method: 'POST', body: JSON.stringify({ currentPrompt }) },
    ),
  streamChat: async (
    conversationId: string,
    body: { content: string; currentPrompt?: string; images?: string[] },
    handlers: {
      onChunk: (text: string) => void;
      onDone: (payload: { content: string; model?: string }) => void;
      onError: (message: string) => void;
      onToolSearch?: (query: string) => void;
      onVision?: (status: string) => void;
    },
    signal?: AbortSignal,
  ): Promise<void> => {
    let res: Response;
    try {
      res = await fetch(`${BASE}/workshop/conversations/${conversationId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if ((e as Error | null)?.name !== 'AbortError') {
        handlers.onError(e instanceof Error ? e.message : 'Request failed');
      }
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      handlers.onError(
        (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`,
      );
      return;
    }
    if (!res.body) {
      handlers.onError('Streaming is not supported by this browser');
      return;
    }
    try {
      let sawDone = false;
      let sawError = false;
      for await (const data of parseSseStream(res.body)) {
        let evt: {
          type?: string;
          text?: string;
          content?: string;
          model?: string;
          message?: string;
          query?: string;
          status?: string;
        };
        try {
          evt = JSON.parse(data) as typeof evt;
        } catch {
          continue;
        }
        if (evt.type === 'chunk' && typeof evt.text === 'string') {
          handlers.onChunk(evt.text);
        } else if (evt.type === 'done') {
          sawDone = true;
          handlers.onDone({ content: evt.content ?? '', model: evt.model });
        } else if (evt.type === 'error') {
          sawError = true;
          handlers.onError(evt.message ?? 'Unknown error');
        } else if (evt.type === 'tool_search' && typeof evt.query === 'string') {
          handlers.onToolSearch?.(evt.query);
        } else if (evt.type === 'vision' && typeof evt.status === 'string') {
          handlers.onVision?.(evt.status);
        }
      }
      if (!sawDone && !sawError && !signal?.aborted) {
        handlers.onError('流式响应中断，未收到完整回复');
      }
    } catch (e) {
      if (!signal?.aborted) {
        handlers.onError(e instanceof Error ? e.message : 'Stream interrupted');
      }
    }
  },
  streamReverse: async (
    conversationId: string,
    body: { images: string[] },
    handlers: {
      onChunk: (text: string) => void;
      onDone: (payload: { content: string; model?: string }) => void;
      onError: (message: string) => void;
    },
    signal?: AbortSignal,
  ): Promise<void> => {
    let res: Response;
    try {
      res = await fetch(
        `${BASE}/workshop/conversations/${conversationId}/reverse`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        },
      );
    } catch (e) {
      if ((e as Error | null)?.name !== 'AbortError') {
        handlers.onError(e instanceof Error ? e.message : 'Request failed');
      }
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      handlers.onError(
        (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`,
      );
      return;
    }
    if (!res.body) {
      handlers.onError('Streaming is not supported by this browser');
      return;
    }
    try {
      let sawDone = false;
      let sawError = false;
      for await (const data of parseSseStream(res.body)) {
        let evt: {
          type?: string;
          text?: string;
          content?: string;
          model?: string;
          message?: string;
        };
        try {
          evt = JSON.parse(data) as typeof evt;
        } catch {
          continue;
        }
        if (evt.type === 'chunk' && typeof evt.text === 'string') {
          handlers.onChunk(evt.text);
        } else if (evt.type === 'done') {
          sawDone = true;
          handlers.onDone({ content: evt.content ?? '', model: evt.model });
        } else if (evt.type === 'error') {
          sawError = true;
          handlers.onError(evt.message ?? 'Unknown error');
        }
      }
      if (!sawDone && !sawError && !signal?.aborted) {
        handlers.onError('流式响应中断，未收到完整回复');
      }
    } catch (e) {
      if (!signal?.aborted) {
        handlers.onError(e instanceof Error ? e.message : 'Stream interrupted');
      }
    }
  },
  getSearchSettings: () =>
    request<{ provider: string; hasApiKey: boolean; envApiKey: boolean }>(
      '/settings/search',
    ),
  saveSearchSettings: (patch: { provider?: string; apiKey?: string | null }) =>
    request<{ provider: string; hasApiKey: boolean; envApiKey: boolean }>(
      '/settings/search',
      { method: 'PUT', body: JSON.stringify(patch) },
    ),
  generateTitle: (content: string) =>
    request<{ title: string; model?: string }>('/llm/title', {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
};
