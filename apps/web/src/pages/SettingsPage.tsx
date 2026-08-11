import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import {
  ProviderId,
  ProviderKind,
  ProviderPublicSettings,
  ProviderSettingsInput,
  VisionPublicSettings,
  VisionSettingsInput,
} from '../types';
import styles from './SettingsPage.module.css';

const PROVIDER_META: { id: ProviderId; name: string; hint: string }[] = [
  { id: 'local', name: '本地 (Ollama)', hint: '用于敏感内容，运行在你的机器上。' },
  { id: 'cloud', name: '云端 (OpenAI 兼容)', hint: '用于高质量任务。密钥通过环境变量 PF_LLM_API_KEY 或下方填写。' },
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

  const [searchConfig, setSearchConfig] = useState<{
    provider: string;
    hasApiKey: boolean;
    envApiKey: boolean;
  } | null>(null);
  const [searchProvider, setSearchProvider] = useState('none');
  const [searchApiKey, setSearchApiKey] = useState('');
  const [savingSearch, setSavingSearch] = useState(false);
  const [savedSearch, setSavedSearch] = useState(false);

  const [modelOptions, setModelOptions] = useState<Record<string, string[]>>({});
  const [loadingModels, setLoadingModels] = useState<Record<string, boolean>>({});
  const [modelErrors, setModelErrors] = useState<Record<string, string>>({});

  const [visionConfig, setVisionConfig] = useState<VisionPublicSettings | null>(null);
  const [visionDraft, setVisionDraft] = useState<
    VisionSettingsInput & { apiKey: string }
  >({ kind: 'openai-compatible', baseUrl: '', model: '', apiKey: '' });
  const [visionSaving, setVisionSaving] = useState(false);
  const [visionSaved, setVisionSaved] = useState(false);
  const [visionModelOptions, setVisionModelOptions] = useState<string[]>([]);
  const [visionLoadingModels, setVisionLoadingModels] = useState(false);
  const [visionModelError, setVisionModelError] = useState('');

  const [defaultCategory, setDefaultCategory] = useState('');
  const [savingCategory, setSavingCategory] = useState(false);
  const [savedCategory, setSavedCategory] = useState(false);
  const [categoryOptions, setCategoryOptions] = useState<string[]>([]);

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

      const search = await api.getSearchSettings();
      setSearchConfig(search);
      setSearchProvider(search.provider);
      setSearchApiKey('');

      const vision = await api.getVisionSettings();
      setVisionConfig(vision);
      setVisionDraft({
        kind: vision.kind,
        baseUrl: vision.baseUrl,
        model: vision.model,
        apiKey: '',
      });
      setVisionSaved(false);

      const prompts = await api.getPromptsSettings();
      setDefaultCategory(prompts.defaultCategory);
      setSavedCategory(false);
      api.getCategories().then(setCategoryOptions).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载设置失败');
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

  async function handleFetchModels(id: ProviderId) {
    const d = drafts[id];
    const baseUrl = d?.baseUrl?.trim() ?? '';
    if (!d || !baseUrl) {
      setModelErrors((m) => ({ ...m, [id]: '请先填写 Base URL' }));
      return;
    }
    setLoadingModels((m) => ({ ...m, [id]: true }));
    setModelErrors((m) => ({ ...m, [id]: '' }));
    setModelOptions((m) => ({ ...m, [id]: [] }));
    try {
      const { models } = await api.fetchModels({
        id,
        kind: d.kind ?? 'openai-compatible',
        baseUrl,
        apiKey: d.apiKey || undefined,
      });
      setModelOptions((m) => ({ ...m, [id]: models }));
    } catch (e) {
      setModelErrors((m) => ({
        ...m,
        [id]: e instanceof Error ? e.message : '拉取模型失败',
      }));
    } finally {
      setLoadingModels((m) => ({ ...m, [id]: false }));
    }
  }

  function patchVision(key: keyof VisionSettingsInput, value: string) {
    setVisionDraft((d) => ({ ...d, [key]: value }));
  }

  async function handleFetchVisionModels() {
    const baseUrl = visionDraft.baseUrl?.trim() ?? '';
    if (!baseUrl) {
      setVisionModelError('请先填写 Base URL');
      return;
    }
    setVisionLoadingModels(true);
    setVisionModelError('');
    setVisionModelOptions([]);
    try {
      const { models } = await api.fetchModels({
        id: 'vision',
        kind: visionDraft.kind ?? 'openai-compatible',
        baseUrl,
        apiKey: visionDraft.apiKey || undefined,
      });
      setVisionModelOptions(models);
    } catch (e) {
      setVisionModelError(e instanceof Error ? e.message : '拉取模型失败');
    } finally {
      setVisionLoadingModels(false);
    }
  }

  async function handleSaveVision() {
    setVisionSaving(true);
    setVisionSaved(false);
    setError('');
    try {
      const result = await api.saveVisionSettings({
        kind: visionDraft.kind,
        baseUrl: visionDraft.baseUrl,
        model: visionDraft.model,
        apiKey: visionDraft.apiKey || undefined,
      });
      setVisionConfig(result);
      setVisionDraft((d) => ({ ...d, apiKey: '' }));
      setVisionSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存识图模型设置失败');
    } finally {
      setVisionSaving(false);
    }
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
      setError(e instanceof Error ? e.message : '保存设置失败');
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveSearch() {
    setSavingSearch(true);
    setSavedSearch(false);
    setError('');
    try {
      const result = await api.saveSearchSettings({
        provider: searchProvider,
        apiKey: searchApiKey || undefined,
      });
      setSearchConfig(result);
      setSearchProvider(result.provider);
      setSearchApiKey('');
      setSavedSearch(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存搜索设置失败');
    } finally {
      setSavingSearch(false);
    }
  }

  async function handleSaveCategory() {
    setSavingCategory(true);
    setSavedCategory(false);
    setError('');
    try {
      const trimmed = defaultCategory.trim();
      if (trimmed.length > 50) {
        throw new Error('默认分类最多 50 个字符');
      }
      const result = await api.savePromptsSettings({
        defaultCategory: trimmed || undefined,
      });
      setDefaultCategory(result.defaultCategory);
      setSavedCategory(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存默认分类失败');
    } finally {
      setSavingCategory(false);
    }
  }

  if (loading) return <div className={styles.state}>加载中…</div>;

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>设置</h1>
      <p className={styles.sub}>
        LLM 提供方配置。敏感内容走本地提供方，高质量任务走云端提供方。API 密钥仅保存在本地（chmod
        600）或从 <code>PF_LLM_API_KEY</code> 环境变量读取，绝不写入 SQLite。
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
                <span>类型</span>
                <select
                  value={d.kind}
                  onChange={(e) => patch(meta.id, 'kind', e.target.value as ProviderKind)}
                >
                  <option value="ollama">Ollama</option>
                  <option value="openai-compatible">OpenAI 兼容</option>
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
                <span>模型</span>
                <div className={styles.modelRow}>
                  <input
                    type="text"
                    value={d.model}
                    onChange={(e) => patch(meta.id, 'model', e.target.value)}
                    placeholder={meta.id === 'local' ? 'llama3.1' : 'gpt-4o-mini'}
                  />
                  <button
                    type="button"
                    className={styles.fetchBtn}
                    onClick={() => handleFetchModels(meta.id)}
                    disabled={loadingModels[meta.id]}
                  >
                    {loadingModels[meta.id] ? '…' : '拉取模型'}
                  </button>
                </div>
                {modelOptions[meta.id]?.length > 0 && (
                  <select
                    className={styles.modelSelect}
                    value={d.model}
                    onChange={(e) => patch(meta.id, 'model', e.target.value)}
                  >
                    <option value="" disabled>
                      选择模型…
                    </option>
                    {modelOptions[meta.id].map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                )}
                {modelErrors[meta.id] && (
                  <span className={styles.modelError}>{modelErrors[meta.id]}</span>
                )}
              </label>

              <label className={styles.field}>
                <span>API Key（可选）</span>
                <input
                  type="password"
                  value={d.apiKey}
                  onChange={(e) => patch(meta.id, 'apiKey', e.target.value)}
                  placeholder={cfg.hasApiKey || cfg.envApiKey ? '已保存 — 留空则保持不变' : '使用 PF_LLM_API_KEY 时可留空'}
                />
              </label>

              <div className={styles.keyStatus}>
                {cfg.envApiKey && <span className={styles.ok}>正在使用环境变量 PF_LLM_API_KEY</span>}
                {cfg.hasApiKey && !cfg.envApiKey && <span className={styles.ok}>密钥已保存在本地</span>}
                {!cfg.hasApiKey && !cfg.envApiKey && <span className={styles.muted}>未配置密钥</span>}
              </div>
            </div>
          );
        })}
      </div>

      <div className={styles.actions}>
        {saved && <span className={styles.ok}>已保存 ✓</span>}
        <button onClick={handleSave} disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </button>
      </div>

      <h2 className={styles.sectionTitle}>识图模型（参考图）</h2>
      <p className={styles.sub}>
        当主模型不支持视觉输入（如 DeepSeek）时，发送参考图会先由识图模型转换为文字描述，再随消息发送给主模型。
        可配置 Ollama（如 llava、llama3.2-vision）或 OpenAI 兼容的视觉模型（如 GLM-4V、Qwen-VL）。
        密钥仅保存在本地或从 <code>PF_VISION_API_KEY</code> 环境变量读取。
      </p>

      {visionConfig && (
        <div className={styles.card}>
          <label className={styles.field}>
            <span>类型</span>
            <select
              value={visionDraft.kind}
              onChange={(e) => patchVision('kind', e.target.value as ProviderKind)}
            >
              <option value="ollama">Ollama</option>
              <option value="openai-compatible">OpenAI 兼容</option>
            </select>
          </label>

          <label className={styles.field}>
            <span>Base URL</span>
            <input
              type="text"
              value={visionDraft.baseUrl}
              onChange={(e) => patchVision('baseUrl', e.target.value)}
              placeholder="http://localhost:11434/v1 或 https://api.example.com/v1"
            />
          </label>

          <label className={styles.field}>
            <span>模型</span>
            <div className={styles.modelRow}>
              <input
                type="text"
                value={visionDraft.model}
                onChange={(e) => patchVision('model', e.target.value)}
                placeholder="llava / qwen-vl-plus / glm-4v"
              />
              <button
                type="button"
                className={styles.fetchBtn}
                onClick={handleFetchVisionModels}
                disabled={visionLoadingModels}
              >
                {visionLoadingModels ? '…' : '拉取模型'}
              </button>
            </div>
            {visionModelOptions.length > 0 && (
              <select
                className={styles.modelSelect}
                value={visionDraft.model}
                onChange={(e) => patchVision('model', e.target.value)}
              >
                <option value="" disabled>
                  选择模型…
                </option>
                {visionModelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            )}
            {visionModelError && (
              <span className={styles.modelError}>{visionModelError}</span>
            )}
          </label>

          <label className={styles.field}>
            <span>API Key（可选）</span>
            <input
              type="password"
              value={visionDraft.apiKey}
              onChange={(e) => patchVision('apiKey', e.target.value)}
              placeholder={
                visionConfig.hasApiKey || visionConfig.envApiKey
                  ? '已保存 — 留空则保持不变'
                  : '使用 PF_VISION_API_KEY 时可留空'
              }
            />
          </label>

          <div className={styles.keyStatus}>
            {visionConfig.envApiKey && (
              <span className={styles.ok}>正在使用环境变量 PF_VISION_API_KEY</span>
            )}
            {visionConfig.hasApiKey && !visionConfig.envApiKey && (
              <span className={styles.ok}>密钥已保存在本地</span>
            )}
            {!visionConfig.hasApiKey && !visionConfig.envApiKey && (
              <span className={styles.muted}>未配置密钥</span>
            )}
          </div>

          <div className={styles.actions}>
            {visionSaved && <span className={styles.ok}>已保存 ✓</span>}
            <button onClick={handleSaveVision} disabled={visionSaving}>
              {visionSaving ? '保存中…' : '保存识图模型'}
            </button>
          </div>
        </div>
      )}

      <h2 className={styles.sectionTitle}>联网搜索</h2>
      <p className={styles.sub}>
        为 AI 文生图提示词提供联网搜索。模型支持 function calling 时可搜索趋势、风格与参考。
        需要 Tavily 或 Exa API Key，未配置时自动降级为 DuckDuckGo。
      </p>

      {searchConfig && (
        <div className={styles.card}>
          <label className={styles.field}>
            <span>服务商</span>
            <select
              value={searchProvider}
              onChange={(e) => setSearchProvider(e.target.value)}
            >
              <option value="none">关闭</option>
              <option value="tavily">Tavily</option>
              <option value="exa">Exa</option>
              <option value="duckduckgo">DuckDuckGo</option>
            </select>
          </label>

          {searchProvider === 'tavily' && (
            <label className={styles.field}>
              <span>Tavily API Key</span>
              <input
                type="password"
                value={searchApiKey}
                onChange={(e) => setSearchApiKey(e.target.value)}
                placeholder={
                  searchConfig.hasApiKey || searchConfig.envApiKey
                    ? '已保存 — 留空则保持不变'
                    : '填写 Tavily API Key'
                }
              />
            </label>
          )}

          {searchProvider === 'exa' && (
            <label className={styles.field}>
              <span>Exa API Key</span>
              <input
                type="password"
                value={searchApiKey}
                onChange={(e) => setSearchApiKey(e.target.value)}
                placeholder={
                  searchConfig.hasApiKey || searchConfig.envApiKey
                    ? '已保存 — 留空则保持不变'
                    : '填写 Exa API Key'
                }
              />
            </label>
          )}

          <div className={styles.keyStatus}>
            {searchConfig.envApiKey && (
              <span className={styles.ok}>正在使用环境变量 PF_SEARCH_API_KEY</span>
            )}
            {searchConfig.hasApiKey && !searchConfig.envApiKey && (
              <span className={styles.ok}>密钥已保存在本地</span>
            )}
          </div>

          <div className={styles.actions}>
            {savedSearch && <span className={styles.ok}>已保存 ✓</span>}
            <button onClick={handleSaveSearch} disabled={savingSearch}>
              {savingSearch ? '保存中…' : '保存搜索设置'}
            </button>
          </div>
        </div>
      )}

      <p className={styles.sub}>
        注意：仅当会话开启「🔍 联网搜索」时才会生效。模型还需支持 function calling（OpenAI
        兼容接口），部分本地模型可能忽略搜索工具。
      </p>

      <h2 className={styles.sectionTitle}>默认分类</h2>
      <p className={styles.sub}>
        新建提示词时自动填入该分类；不传分类的创建请求也会使用它。留空则保持原有行为。
      </p>

      <div className={styles.card}>
        <label className={styles.field}>
          <span>默认分类</span>
          <input
            type="text"
            value={defaultCategory}
            onChange={(e) => setDefaultCategory(e.target.value)}
            list="default-category-options"
            placeholder="留空 = 不设置默认分类"
          />
          <datalist id="default-category-options">
            {categoryOptions.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
        <div className={styles.actions}>
          {savedCategory && <span className={styles.ok}>已保存 ✓</span>}
          <button onClick={handleSaveCategory} disabled={savingCategory}>
            {savingCategory ? '保存中…' : '保存默认分类'}
          </button>
        </div>
      </div>
    </div>
  );
}
