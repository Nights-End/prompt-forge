import { Router } from 'express';
import {
  loadProviderConfig,
  saveProviderConfig,
  PROVIDER_IDS,
  PROVIDER_KINDS,
  normalizeBaseUrl,
  resolveApiKey,
  type ProviderId,
  type ProviderKind,
  type ProviderSettings,
} from '../llm/config.js';
import {
  loadSearchConfig,
  saveSearchConfig,
  SEARCH_PROVIDERS,
  type SearchConfig,
  type SearchProvider,
} from '../search/config.js';

function publicShape(id: ProviderId, settings: ProviderSettings) {
  return {
    id,
    kind: settings.kind,
    baseUrl: settings.baseUrl,
    model: settings.model,
    hasApiKey: Boolean(settings.apiKey),
    envApiKey: Boolean(process.env.PF_LLM_API_KEY),
  };
}

function searchPublicShape(config: SearchConfig) {
  return {
    provider: config.provider,
    hasApiKey: Boolean(config.apiKey),
    envApiKey: Boolean(process.env.PF_SEARCH_API_KEY),
  };
}

function extractModelIds(payload: unknown): string[] {
  const ids: string[] = [];
  const record = (payload ?? {}) as Record<string, unknown>;
  for (const key of ['data', 'models']) {
    const arr = record[key];
    if (Array.isArray(arr)) {
      for (const m of arr) {
        const o = (m ?? {}) as Record<string, unknown>;
        if (typeof o.id === 'string') ids.push(o.id);
        else if (typeof o.name === 'string') ids.push(o.name);
      }
    }
  }
  if (Array.isArray(payload)) {
    for (const m of payload) {
      const o = (m ?? {}) as Record<string, unknown>;
      if (typeof o.id === 'string') ids.push(o.id);
      else if (typeof o.name === 'string') ids.push(o.name);
    }
  }
  return [...new Set(ids)];
}

export interface SettingsDeps {
  fetchImpl?: typeof fetch;
}

export function createSettingsRouter(deps: SettingsDeps = {}): Router {
  const router = Router();
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  router.get('/provider', (_req, res) => {
    const config = loadProviderConfig();
    res.json({
      providers: Object.fromEntries(
        PROVIDER_IDS.map((id) => [id, publicShape(id, config[id])]),
      ),
    });
  });

  router.put('/provider', (req, res) => {
    const body = (req.body ?? {}) as {
      providers?: Partial<Record<ProviderId, Partial<ProviderSettings> & { apiKey?: string | null }>>;
    };
    const raw = body.providers ?? {};
    const config = loadProviderConfig();

    for (const id of PROVIDER_IDS) {
      const patch = raw[id];
      if (!patch || typeof patch !== 'object') continue;

      const kind = patch.kind as ProviderKind | undefined;
      if (kind !== undefined && !(PROVIDER_KINDS as string[]).includes(kind)) {
        res.status(400).json({ error: `kind must be one of: ${PROVIDER_KINDS.join(', ')}` });
        return;
      }
      const baseUrl = typeof patch.baseUrl === 'string' ? patch.baseUrl.trim() : undefined;
      const model = typeof patch.model === 'string' ? patch.model.trim() : undefined;
      if (baseUrl === '') {
        res.status(400).json({ error: 'baseUrl is required' });
        return;
      }

      if (kind !== undefined) config[id].kind = kind;
      if (baseUrl !== undefined) config[id].baseUrl = baseUrl;
      if (model !== undefined) config[id].model = model;
      if (typeof patch.apiKey === 'string' && patch.apiKey) {
        config[id].apiKey = patch.apiKey;
      } else if (patch.apiKey === null) {
        config[id].apiKey = undefined;
      }
    }

    saveProviderConfig(config);
    res.json({
      providers: Object.fromEntries(
        PROVIDER_IDS.map((pid) => [pid, publicShape(pid, config[pid])]),
      ),
    });
  });

  router.post('/provider/models', async (req, res) => {
    const body = (req.body ?? {}) as {
      id?: unknown;
      kind?: unknown;
      baseUrl?: unknown;
      apiKey?: unknown;
    };

    const id = body.id as ProviderId | undefined;
    if (id !== undefined && !(PROVIDER_IDS as string[]).includes(id)) {
      res.status(400).json({ error: `id must be one of: ${PROVIDER_IDS.join(', ')}` });
      return;
    }
    const kind = body.kind as ProviderKind | undefined;
    if (kind !== undefined && !(PROVIDER_KINDS as string[]).includes(kind)) {
      res.status(400).json({ error: `kind must be one of: ${PROVIDER_KINDS.join(', ')}` });
      return;
    }
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
    if (!baseUrl) {
      res.status(400).json({ error: 'baseUrl is required' });
      return;
    }
    let apiKey = typeof body.apiKey === 'string' ? body.apiKey : undefined;
    if (!apiKey && id !== undefined) {
      apiKey = resolveApiKey(loadProviderConfig()[id]);
    }

    const url = `${normalizeBaseUrl(kind ?? 'openai-compatible', baseUrl)}/models`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      res.status(502).json({ error: `cannot reach ${url}` });
      return;
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      res
        .status(502)
        .json({ error: `failed to list models (${response.status}): ${detail}` });
      return;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      res.status(502).json({ error: 'invalid JSON response from model endpoint' });
      return;
    }

    const models = extractModelIds(payload);
    if (models.length === 0) {
      res.status(502).json({ error: 'model endpoint returned no models' });
      return;
    }
    res.json({ models });
  });

  router.get('/search', (_req, res) => {
    const config = loadSearchConfig();
    res.json(searchPublicShape(config));
  });

  router.put('/search', (req, res) => {
    const body = (req.body ?? {}) as {
      provider?: unknown;
      apiKey?: unknown;
    };

    const provider = body.provider;
    if (provider !== undefined) {
      if (
        typeof provider !== 'string' ||
        !(SEARCH_PROVIDERS as string[]).includes(provider)
      ) {
        res.status(400).json({
          error: `provider must be one of: ${SEARCH_PROVIDERS.join(', ')}`,
        });
        return;
      }
    }

    const config = loadSearchConfig();
    const newConfig: SearchConfig = { ...config };
    if (provider !== undefined) newConfig.provider = provider as SearchProvider;
    if (body.apiKey !== undefined) {
      if (typeof body.apiKey === 'string' && body.apiKey) {
        newConfig.apiKey = body.apiKey;
      } else if (body.apiKey === null || body.apiKey === '') {
        newConfig.apiKey = undefined;
      }
    }

    saveSearchConfig(newConfig);
    res.json(searchPublicShape(newConfig));
  });

  return router;
}
