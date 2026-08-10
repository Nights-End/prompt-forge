const VARIABLE_REGEX = /\{([a-zA-Z0-9_]+)\}/g;

export const BATCH_COUNT_MIN = 1;
export const BATCH_COUNT_MAX = 100;

export function extractVariables(content: string): string[] {
  const set = new Set<string>();
  for (const match of content.matchAll(VARIABLE_REGEX)) {
    set.add(match[1]);
  }
  return [...set];
}

export function renderTemplate(
  content: string,
  values: Record<string, string>,
): string {
  return content.replace(VARIABLE_REGEX, (match, name: string) => {
    const value = values[name];
    return value !== undefined && value !== '' ? value : match;
  });
}

export function clampBatchCount(value: unknown, fallback = 1): number {
  const n = parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(BATCH_COUNT_MAX, Math.max(BATCH_COUNT_MIN, n));
}

export function normalizeVariablePools(
  raw: Record<string, unknown> | undefined | null,
): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const result: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) continue;
    const filtered = value
      .filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
      .map((s) => s.trim());
    if (filtered.length < 2) continue;
    result[key] = filtered;
  }
  return result;
}

export function renderTemplateBatch(
  content: string,
  pools: Record<string, string[]>,
  count: number,
): string[] {
  const names = extractVariables(content);
  return Array.from({ length: count }, () => {
    const values: Record<string, string> = {};
    for (const name of names) {
      const pool = pools[name];
      if (pool && pool.length > 0) {
        values[name] = pool[Math.floor(Math.random() * pool.length)];
      }
    }
    return renderTemplate(content, values);
  });
}
