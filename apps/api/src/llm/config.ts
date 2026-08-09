import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from '../db/index.js';

export type ProviderKind = 'ollama' | 'openai-compatible';
export type ProviderId = 'local' | 'cloud';

export interface ProviderSettings {
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export type ProviderConfigFile = Record<ProviderId, ProviderSettings>;

export const PROVIDER_IDS: ProviderId[] = ['local', 'cloud'];
export const PROVIDER_KINDS: ProviderKind[] = ['ollama', 'openai-compatible'];

const DEFAULT_CONFIG: ProviderConfigFile = {
  local: { kind: 'ollama', baseUrl: 'http://localhost:11434/v1', model: '' },
  cloud: { kind: 'openai-compatible', baseUrl: '', model: '' },
};

export function resolveProviderConfigPath(): string {
  const env = process.env.PROVIDER_CONFIG_PATH;
  if (env) return path.resolve(env);
  return path.join(resolveDataDir(), 'provider.json');
}

function normalizeSettings(
  id: ProviderId,
  raw: Partial<ProviderSettings> | undefined,
): ProviderSettings {
  const defaults = DEFAULT_CONFIG[id];
  if (!raw || typeof raw !== 'object') return { ...defaults };
  return {
    kind:
      typeof raw.kind === 'string' && (PROVIDER_KINDS as string[]).includes(raw.kind)
        ? (raw.kind as ProviderKind)
        : defaults.kind,
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : defaults.baseUrl,
    model: typeof raw.model === 'string' ? raw.model.trim() : defaults.model,
    apiKey: typeof raw.apiKey === 'string' && raw.apiKey ? raw.apiKey : undefined,
  };
}

export function loadProviderConfig(): ProviderConfigFile {
  const filePath = resolveProviderConfigPath();
  let raw: Record<string, Partial<ProviderSettings>> = {};
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<
      string,
      Partial<ProviderSettings>
    >;
  } catch {
    // missing or corrupt -> defaults
  }
  const config = {} as ProviderConfigFile;
  for (const id of PROVIDER_IDS) {
    config[id] = normalizeSettings(id, raw[id]);
  }
  return config;
}

export function saveProviderConfig(config: ProviderConfigFile): void {
  const filePath = resolveProviderConfigPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // chmod is a no-op on Windows; key protection relies on local filesystem ACLs
  }
}

export function resolveApiKey(settings: ProviderSettings): string | undefined {
  return process.env.PF_LLM_API_KEY || settings.apiKey || undefined;
}

export function resolveVisionConfigPath(): string {
  const env = process.env.VISION_CONFIG_PATH;
  if (env) return path.resolve(env);
  return path.join(resolveDataDir(), 'vision.json');
}

const DEFAULT_VISION: ProviderSettings = {
  kind: 'openai-compatible',
  baseUrl: '',
  model: '',
  apiKey: undefined,
};

function normalizeVisionSettings(
  raw: Partial<ProviderSettings> | undefined,
): ProviderSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_VISION };
  return {
    kind:
      typeof raw.kind === 'string' && (PROVIDER_KINDS as string[]).includes(raw.kind)
        ? (raw.kind as ProviderKind)
        : DEFAULT_VISION.kind,
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : DEFAULT_VISION.baseUrl,
    model: typeof raw.model === 'string' ? raw.model.trim() : DEFAULT_VISION.model,
    apiKey: typeof raw.apiKey === 'string' && raw.apiKey ? raw.apiKey : undefined,
  };
}

export function loadVisionConfig(): ProviderSettings {
  const filePath = resolveVisionConfigPath();
  let raw: Partial<ProviderSettings> | undefined;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<ProviderSettings>;
  } catch {
    // missing or corrupt -> defaults
  }
  return normalizeVisionSettings(raw);
}

export function saveVisionConfig(config: ProviderSettings): void {
  const filePath = resolveVisionConfigPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // chmod is a no-op on Windows; key protection relies on local filesystem ACLs
  }
}

export function resolveVisionApiKey(settings: ProviderSettings): string | undefined {
  return process.env.PF_VISION_API_KEY || settings.apiKey || undefined;
}

export function normalizeBaseUrl(kind: ProviderKind, baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, '');
  if (!url) return url;
  if (kind === 'ollama' && !url.endsWith('/v1')) url += '/v1';
  return url;
}
