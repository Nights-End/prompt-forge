import type {
  Asset,
  Prompt,
  PromptInput,
  ListPromptQuery,
  RenderResult,
} from '@prompt-forge/shared';
import type {
  ProviderId,
  ProviderPublicSettings,
  ProviderSettingsInput,
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
  renderPrompt: (promptId: string, values: Record<string, string>) =>
    request<RenderResult>('/prompts/render', {
      method: 'POST',
      body: JSON.stringify({ promptId, values }),
    }),
  listAssets: (promptId: string) =>
    request<Asset[]>(`/prompts/${promptId}/assets`),
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
};
