import { Router } from 'express';
import {
  loadProviderConfig,
  saveProviderConfig,
  PROVIDER_IDS,
  PROVIDER_KINDS,
  type ProviderId,
  type ProviderKind,
  type ProviderSettings,
} from '../llm/config.js';

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

export function createSettingsRouter(): Router {
  const router = Router();

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

  return router;
}
