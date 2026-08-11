import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from '../db/index.js';

export interface PromptsConfig {
  defaultCategory: string;
}

const DEFAULT_CONFIG: PromptsConfig = {
  defaultCategory: '',
};

export function resolvePromptsConfigPath(): string {
  const env = process.env.PROMPTS_CONFIG_PATH;
  if (env) return path.resolve(env);
  return path.join(resolveDataDir(), 'prompts.json');
}

export function loadPromptsConfig(): PromptsConfig {
  const filePath = resolvePromptsConfigPath();
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    // missing or corrupt -> defaults
  }
  return {
    defaultCategory:
      typeof raw.defaultCategory === 'string'
        ? raw.defaultCategory
        : DEFAULT_CONFIG.defaultCategory,
  };
}

export function savePromptsConfig(config: PromptsConfig): void {
  const filePath = resolvePromptsConfigPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // chmod is a no-op on Windows; key protection relies on local filesystem ACLs
  }
}

export function getDefaultCategory(): string {
  return loadPromptsConfig().defaultCategory.trim();
}
