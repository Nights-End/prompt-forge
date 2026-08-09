import { PromptInput, PromptParameters, PromptType } from '@prompt-forge/shared';

export interface FormState {
  title: string;
  content: string;
  description: string;
  category: string;
  tags: string;
  isFavorite: boolean;
  type: PromptType;
  parameters: PromptParameters;
  files: File[];
}

export const EMPTY_FORM: FormState = {
  title: '',
  content: '',
  description: '',
  category: '',
  tags: '',
  isFavorite: false,
  type: 'text',
  parameters: {},
  files: [],
};

export function formToInput(form: FormState): PromptInput {
  return {
    title: form.title,
    content: form.content,
    description: form.description || undefined,
    category: form.category || undefined,
    tags: form.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    isFavorite: form.isFavorite,
    type: form.type,
    parameters: form.parameters,
  };
}

export type ProviderId = 'local' | 'cloud';
export type ProviderKind = 'ollama' | 'openai-compatible';

export interface ProviderPublicSettings {
  id: ProviderId;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  envApiKey: boolean;
}

export interface ProviderSettingsInput {
  kind?: ProviderKind;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

export interface VisionPublicSettings {
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  envApiKey: boolean;
}

export interface VisionSettingsInput {
  kind?: ProviderKind;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}
