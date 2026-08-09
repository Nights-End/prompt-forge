import fs from 'node:fs';
import path from 'node:path';
import type { Preset } from '@prompt-forge/shared';
import { BUILTIN_PRESETS } from '@prompt-forge/shared';
import { resolveDataDir } from '../db/index.js';

export interface WorkshopConfig {
  defaultExtraSystemPrompt: string;
  customPresets: Preset[];
}

const DEFAULT_CONFIG: WorkshopConfig = {
  defaultExtraSystemPrompt: '',
  customPresets: [],
};

export function resolveWorkshopConfigPath(): string {
  const env = process.env.WORKSHOP_CONFIG_PATH;
  if (env) return path.resolve(env);
  return path.join(resolveDataDir(), 'workshop.json');
}

function normalizePreset(raw: unknown): Preset | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  const description = typeof r.description === 'string' ? r.description.trim() : '';
  const instructions = typeof r.instructions === 'string' ? r.instructions : '';
  if (!id || !name || !instructions) return null;
  return { id, name, description, instructions };
}

export function loadWorkshopConfig(): WorkshopConfig {
  const filePath = resolveWorkshopConfigPath();
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    // missing or corrupt -> defaults
  }
  const customPresets: Preset[] = [];
  if (Array.isArray(raw.customPresets)) {
    for (const entry of raw.customPresets) {
      const preset = normalizePreset(entry);
      if (preset && !customPresets.some((p) => p.id === preset.id)) {
        customPresets.push(preset);
      }
    }
  }
  return {
    defaultExtraSystemPrompt:
      typeof raw.defaultExtraSystemPrompt === 'string'
        ? raw.defaultExtraSystemPrompt
        : DEFAULT_CONFIG.defaultExtraSystemPrompt,
    customPresets,
  };
}

export function saveWorkshopConfig(config: WorkshopConfig): void {
  const filePath = resolveWorkshopConfigPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // chmod is a no-op on Windows; key protection relies on local filesystem ACLs
  }
}

/** Builtin presets merged with custom presets; custom entries with the same id override builtin ones. */
export function getMergedPresets(config: WorkshopConfig): Preset[] {
  const merged = new Map<string, Preset>();
  for (const p of BUILTIN_PRESETS) merged.set(p.id, p);
  for (const p of config.customPresets) merged.set(p.id, p);
  return [...merged.values()];
}

export function isBuiltinPresetId(id: string): boolean {
  return BUILTIN_PRESETS.some((p) => p.id === id);
}
