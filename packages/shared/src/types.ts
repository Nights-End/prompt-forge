export type PromptType = 'text' | 'multimodal';

export type AssetKind = 'image' | 'audio' | 'video' | 'file';

export interface PromptParameters {
  model?: string;
  steps?: string;
  sampler?: string;
  cfg?: string;
  seed?: string;
  resolution?: string;
  negativePrompt?: string;
  [key: string]: string | undefined;
}

export interface Prompt {
  id: string;
  title: string;
  content: string;
  description?: string;
  category: string;
  tags: string[];
  variables: string[];
  variablePools: Record<string, string[]>;
  isFavorite: boolean;
  type: PromptType;
  parameters: PromptParameters;
  createdAt: string;
  updatedAt: string;
}

export interface PromptInput {
  title: string;
  content: string;
  description?: string;
  category?: string;
  tags?: string[];
  variablePools?: Record<string, string[]>;
  isFavorite?: boolean;
  type?: PromptType;
  parameters?: PromptParameters;
}

export interface Asset {
  id: string;
  promptId: string;
  kind: AssetKind;
  fileName: string;
  storagePath: string;
  metadata?: Record<string, unknown>;
  sortOrder: number;
  createdAt: string;
}

export type GenJobStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

export interface GenJobView {
  id: string;
  promptId: string;
  sourceAssetId: string;
  status: GenJobStatus;
  error: string | null;
  outputAssetId: string | null;
  createdAt: string;
  updatedAt: string;
  queue?: { running: number; pending: number };
  reused?: boolean;
}

export function getAssetGenParams(asset: Asset): PromptParameters {
  const raw = asset.metadata?.genParams;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: PromptParameters = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

const DANGEROUS_PARAM_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_PARAM_KEYS = 32;
const MAX_PARAM_KEY_LENGTH = 64;
const MAX_PARAM_VALUE_LENGTH = 2048;

// Single sanitizer for prompt-level and asset-level generation parameters:
// keeps only trimmed non-empty string values, drops dangerous/oversized keys.
export function sanitizePromptParameters(raw: unknown): PromptParameters {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: PromptParameters = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_PARAM_KEYS) break;
    if (typeof value !== 'string') continue;
    if (key.length > MAX_PARAM_KEY_LENGTH) continue;
    if (DANGEROUS_PARAM_KEYS.has(key)) continue;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_PARAM_VALUE_LENGTH) continue;
    out[key] = trimmed;
    count++;
  }
  return out;
}

export interface TemplateRenderInput {
  content: string;
  values: Record<string, string>;
}

export interface RenderResult {
  rendered: string;
  assets: { id: string; url: string; kind: AssetKind }[];
}

export interface ListPromptQuery {
  q?: string;
  category?: string;
  tag?: string;
  favorite?: boolean;
  type?: PromptType;
  limit?: number;
  offset?: number;
}

export type PresetId = string;

export interface Preset {
  id: string;
  name: string;
  description: string;
  instructions: string;
}

export type ConversationRole = 'user' | 'assistant' | 'tool';

export interface Conversation {
  id: string;
  promptId: string | null;
  title: string;
  providerId: string;
  presetId: PresetId;
  extraSystemPrompt: string;
  enableSearch: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: ConversationRole;
  content: string;
  multimodalContent?: MessageContentPart[] | null;
  createdAt: string;
}

export interface MessageContentPart {
  type: 'image_url';
  image_url: { url: string };
}

export interface CreateConversationInput {
  promptId?: string | null;
  title?: string;
  providerId?: string;
  presetId?: string;
  extraSystemPrompt?: string;
  enableSearch?: boolean;
}

export type SearchProvider = 'tavily' | 'exa' | 'duckduckgo' | 'none';

export interface SearchConfig {
  provider: SearchProvider;
  apiKey?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolResult {
  tool_call_id: string;
  role: 'tool';
  content: string;
}
