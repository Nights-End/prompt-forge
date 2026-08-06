const VARIABLE_REGEX = /\{([a-zA-Z0-9_]+)\}/g;

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
