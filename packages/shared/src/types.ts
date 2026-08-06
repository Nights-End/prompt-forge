export type PromptType = 'text' | 'multimodal';

export type AssetKind = 'image' | 'audio' | 'file';

export interface Prompt {
  id: string;
  title: string;
  content: string;
  description?: string;
  category: string;
  tags: string[];
  variables: string[];
  isFavorite: boolean;
  type: PromptType;
  createdAt: string;
  updatedAt: string;
}

export interface PromptInput {
  title: string;
  content: string;
  description?: string;
  category?: string;
  tags?: string[];
  isFavorite?: boolean;
  type?: PromptType;
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
