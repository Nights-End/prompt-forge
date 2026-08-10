export type PromptType = 'text' | 'multimodal';

export type AssetKind = 'image' | 'audio' | 'file';

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
