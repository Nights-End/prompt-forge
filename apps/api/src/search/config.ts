import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from '../db/index.js';
import type { SearchConfig, SearchProvider } from '@prompt-forge/shared';

export type { SearchConfig, SearchProvider };

export const SEARCH_PROVIDERS: SearchProvider[] = ['tavily', 'exa', 'duckduckgo', 'none'];

const DEFAULT_CONFIG: SearchConfig = {
  provider: 'none',
  apiKey: undefined,
};

export function resolveSearchConfigPath(): string {
  const env = process.env.SEARCH_CONFIG_PATH;
  if (env) return path.resolve(env);
  return path.join(resolveDataDir(), 'search.json');
}

export function loadSearchConfig(): SearchConfig {
  const filePath = resolveSearchConfigPath();
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<SearchConfig>;
    const provider =
      typeof raw.provider === 'string' &&
      (SEARCH_PROVIDERS as string[]).includes(raw.provider)
        ? (raw.provider as SearchProvider)
        : DEFAULT_CONFIG.provider;
    const apiKey =
      typeof raw.apiKey === 'string' && raw.apiKey ? raw.apiKey : undefined;
    return { provider, apiKey };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveSearchConfig(config: SearchConfig): void {
  const filePath = resolveSearchConfigPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // chmod is a no-op on Windows
  }
}

export function resolveSearchApiKey(config: SearchConfig): string | undefined {
  return process.env.PF_SEARCH_API_KEY || config.apiKey || undefined;
}
