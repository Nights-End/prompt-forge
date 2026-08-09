import type { SearchConfig, SearchProvider } from '@prompt-forge/shared';
import { SEARCH_MAX_RESULT_CHARS, SEARCH_TIMEOUT_MS } from '@prompt-forge/shared';
import { loadSearchConfig, resolveSearchApiKey } from './config.js';

export interface SearchResult {
  title: string;
  url: string;
  content: string;
}

export interface ExecuteSearchResult {
  ok: boolean;
  results: SearchResult[];
  error?: string;
}

function formatResults(results: SearchResult[], maxChars: number): string {
  let text = '';
  for (const r of results) {
    if (text.length + r.content.length > maxChars) {
      const remaining = maxChars - text.length;
      if (remaining > 100) {
        text += r.content.slice(0, remaining) + '…';
      }
      break;
    }
    text += r.content + '\n\n';
  }
  return text.trim() || 'no relevant results found';
}

async function searchTavily(
  apiKey: string,
  query: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<ExecuteSearchResult> {
  try {
    const res = await fetchImpl('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'basic',
        max_results: 5,
      }),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        results: [],
        error: `Tavily returned ${res.status}: ${text.slice(0, 300)}`,
      };
    }
    const data = (await res.json()) as {
      results?: { title?: string; url?: string; content?: string }[];
    };
    const results: SearchResult[] = (data.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      content: r.content ?? '',
    }));
    return { ok: true, results };
  } catch (e) {
    if ((e as Error | null)?.name === 'AbortError') {
      return { ok: false, results: [], error: 'search timed out' };
    }
    return {
      ok: false,
      results: [],
      error: e instanceof Error ? e.message : 'search failed',
    };
  }
}

async function searchExa(
  apiKey: string,
  query: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<ExecuteSearchResult> {
  try {
    const res = await fetchImpl('https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        query,
        numResults: 5,
        contents: { text: { maxCharacters: 600 } },
      }),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        results: [],
        error: `Exa returned ${res.status}: ${text.slice(0, 300)}`,
      };
    }
    const data = (await res.json()) as {
      results?: { title?: string; url?: string; text?: string }[];
    };
    const results: SearchResult[] = (data.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      content: r.text ?? '',
    }));
    return { ok: true, results };
  } catch (e) {
    if ((e as Error | null)?.name === 'AbortError') {
      return { ok: false, results: [], error: 'search timed out' };
    }
    return {
      ok: false,
      results: [],
      error: e instanceof Error ? e.message : 'search failed',
    };
  }
}

async function searchDuckDuckGo(
  query: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<ExecuteSearchResult> {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;
    const res = await fetchImpl(url, { signal });
    if (!res.ok) {
      return { ok: false, results: [], error: `DuckDuckGo returned ${res.status}` };
    }
    const data = (await res.json()) as {
      Abstract?: string;
      AbstractURL?: string;
      RelatedTopics?: { Text?: string; FirstURL?: string }[];
    };
    const results: SearchResult[] = [];
    if (data.Abstract) {
      results.push({
        title: 'Abstract',
        url: data.AbstractURL ?? '',
        content: data.Abstract,
      });
    }
    for (const t of data.RelatedTopics ?? []) {
      if (t.Text) {
        results.push({
          title: '',
          url: t.FirstURL ?? '',
          content: t.Text,
        });
      }
    }
    if (results.length === 0) {
      return { ok: true, results: [{ title: '', url: '', content: 'no relevant results found' }] };
    }
    return { ok: true, results };
  } catch (e) {
    if ((e as Error | null)?.name === 'AbortError') {
      return { ok: false, results: [], error: 'search timed out' };
    }
    return {
      ok: false,
      results: [],
      error: e instanceof Error ? e.message : 'search failed',
    };
  }
}

export async function executeSearch(
  query: string,
  overrideFetch?: typeof fetch,
): Promise<string> {
  const config: SearchConfig = loadSearchConfig();
  const provider: SearchProvider = config.provider === 'none' ? 'duckduckgo' : config.provider;
  const apiKey = resolveSearchApiKey(config);
  const fetchImpl = overrideFetch ?? globalThis.fetch;

  if ((provider === 'tavily' || provider === 'exa') && !apiKey) {
    return `${provider === 'tavily' ? 'Tavily' : 'Exa'} API key is not configured. Please set PF_SEARCH_API_KEY or configure it in Settings.`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  try {
    let result: ExecuteSearchResult;
    if (provider === 'tavily') {
      result = await searchTavily(apiKey!, query, controller.signal, fetchImpl);
    } else if (provider === 'exa') {
      result = await searchExa(apiKey!, query, controller.signal, fetchImpl);
    } else {
      result = await searchDuckDuckGo(query, controller.signal, fetchImpl);
    }

    if (!result.ok) {
      return `Search error: ${result.error ?? 'unknown error'}. The model may fall back to its own knowledge.`;
    }
    if (result.results.length === 0) {
      return 'no relevant results found. The model may fall back to its own knowledge.';
    }
    return formatResults(result.results, SEARCH_MAX_RESULT_CHARS);
  } catch (e) {
    if ((e as Error | null)?.name === 'AbortError') {
      return 'search timed out. The model may fall back to its own knowledge.';
    }
    return `Search failed: ${e instanceof Error ? e.message : 'unknown error'}. The model may fall back to its own knowledge.`;
  } finally {
    clearTimeout(timer);
  }
}
