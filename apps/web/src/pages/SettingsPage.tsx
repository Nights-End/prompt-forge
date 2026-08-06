import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import {
  ProviderId,
  ProviderKind,
  ProviderPublicSettings,
  ProviderSettingsInput,
} from '../types';
import styles from './SettingsPage.module.css';

const PROVIDER_META: { id: ProviderId; name: string; hint: string }[] = [
  { id: 'local', name: 'Local (Ollama)', hint: 'For sensitive content. Runs on your machine.' },
  { id: 'cloud', name: 'Cloud (OpenAI-compatible)', hint: 'For high-quality tasks. Key via env PF_LLM_API_KEY or below.' },
];

export default function SettingsPage() {
  const [configs, setConfigs] = useState<Record<string, ProviderPublicSettings>>({});
  const [drafts, setDrafts] = useState<
    Record<string, ProviderSettingsInput & { apiKey: string }>
  >({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { providers } = await api.getProviderSettings();
      setConfigs(providers);
      const next: Record<string, ProviderSettingsInput & { apiKey: string }> = {};
      for (const id of Object.keys(providers) as ProviderId[]) {
        next[id] = {
          kind: providers[id].kind,
          baseUrl: providers[id].baseUrl,
          model: providers[id].model,
          apiKey: '',
        };
      }
      setDrafts(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function patch(id: ProviderId, key: keyof ProviderSettingsInput, value: string) {
    setDrafts((d) => ({ ...d, [id]: { ...d[id], [key]: value } }));
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const providers: Record<ProviderId, ProviderSettingsInput> = {
        local: {},
        cloud: {},
      };
      for (const meta of PROVIDER_META) {
        const d = drafts[meta.id];
        providers[meta.id] = {
          kind: d.kind,
          baseUrl: d.baseUrl,
          model: d.model,
          apiKey: d.apiKey || undefined,
        };
      }
      const result = await api.saveProviderSettings(providers);
      setConfigs(result.providers);
      setDrafts((d) => {
        const next: Record<string, ProviderSettingsInput & { apiKey: string }> = {};
        for (const meta of PROVIDER_META) {
          next[meta.id] = { ...d[meta.id], apiKey: '' };
        }
        return next;
      });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className={styles.state}>Loading…</div>;

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Settings</h1>
      <p className={styles.sub}>
        LLM providers. Sensitive content routes to the local provider, high-quality
        tasks to the cloud provider. API keys are stored locally (chmod 600) or read
        from the <code>PF_LLM_API_KEY</code> environment variable — never in SQLite.
      </p>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.cards}>
        {PROVIDER_META.map((meta) => {
          const d = drafts[meta.id];
          const cfg = configs[meta.id];
          if (!d || !cfg) return null;
          return (
            <div key={meta.id} className={styles.card}>
              <h2 className={styles.cardTitle}>{meta.name}</h2>
              <p className={styles.hint}>{meta.hint}</p>

              <label className={styles.field}>
                <span>Type</span>
                <select
                  value={d.kind}
                  onChange={(e) => patch(meta.id, 'kind', e.target.value as ProviderKind)}
                >
                  <option value="ollama">Ollama</option>
                  <option value="openai-compatible">OpenAI compatible</option>
                </select>
              </label>

              <label className={styles.field}>
                <span>Base URL</span>
                <input
                  type="text"
                  value={d.baseUrl}
                  onChange={(e) => patch(meta.id, 'baseUrl', e.target.value)}
                  placeholder={meta.id === 'local' ? 'http://localhost:11434/v1' : 'https://api.example.com/v1'}
                />
              </label>

              <label className={styles.field}>
                <span>Model</span>
                <input
                  type="text"
                  value={d.model}
                  onChange={(e) => patch(meta.id, 'model', e.target.value)}
                  placeholder={meta.id === 'local' ? 'llama3.1' : 'gpt-4o-mini'}
                />
              </label>

              <label className={styles.field}>
                <span>API key (optional)</span>
                <input
                  type="password"
                  value={d.apiKey}
                  onChange={(e) => patch(meta.id, 'apiKey', e.target.value)}
                  placeholder={cfg.hasApiKey || cfg.envApiKey ? 'Stored — leave blank to keep' : 'Leave blank if using PF_LLM_API_KEY'}
                />
              </label>

              <div className={styles.keyStatus}>
                {cfg.envApiKey && <span className={styles.ok}>PF_LLM_API_KEY env var active</span>}
                {cfg.hasApiKey && !cfg.envApiKey && <span className={styles.ok}>Key stored locally</span>}
                {!cfg.hasApiKey && !cfg.envApiKey && <span className={styles.muted}>No key configured</span>}
              </div>
            </div>
          );
        })}
      </div>

      <div className={styles.actions}>
        {saved && <span className={styles.ok}>Saved ✓</span>}
        <button onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
