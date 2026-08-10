import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Asset, Prompt, renderTemplate } from '@prompt-forge/shared';
import PromptForm from '../components/PromptForm';
import { SparklesIcon } from '../components/icons';
import { FormState, formToInput } from '../types';
import styles from './DetailPage.module.css';

function promptToForm(p: Prompt): FormState {
  const poolStrings: Record<string, string> = {};
  for (const [name, values] of Object.entries(p.variablePools ?? {})) {
    poolStrings[name] = values.join(', ');
  }
  return {
    title: p.title,
    content: p.content,
    description: p.description ?? '',
    category: p.category,
    tags: p.tags.join(', '),
    isFavorite: p.isFavorite,
    type: p.type,
    parameters: p.parameters ?? {},
    variablePools: poolStrings,
    files: [],
  };
}

function AssetThumb({ asset, onDelete }: { asset: Asset; onDelete: () => void }) {
  const url = api.assetFileUrl(asset.id);
  return (
    <div className={styles.assetCard}>
      {asset.kind === 'image' ? (
        <a href={url} target="_blank" rel="noreferrer" className={styles.assetLink}>
          <img className={styles.assetImg} src={url} alt={asset.fileName} />
        </a>
      ) : (
        <a href={url} target="_blank" rel="noreferrer" className={styles.assetFile}>
          {asset.fileName}
        </a>
      )}
      {onDelete && (
        <button
          className={styles.assetDelete}
          onClick={onDelete}
                    aria-label="删除附件"
        >
          ✕
        </button>
      )}
    </div>
  );
}

export default function DetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [values, setValues] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  const [batchMode, setBatchMode] = useState(false);
  const [batchCount, setBatchCount] = useState(10);
  const [batchResults, setBatchResults] = useState<string[]>([]);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchError, setBatchError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [p, list] = await Promise.all([api.getPrompt(id), api.listAssets(id)]);
      setPrompt(p);
      setAssets(list);
      const v: Record<string, string> = {};
      p.variables.forEach((name) => (v[name] = ''));
      setValues(v);
    } catch (e) {
      setError(e instanceof Error ? e.message : '未找到提示词');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const rendered = prompt ? renderTemplate(prompt.content, values) : '';

  async function handleSave(form: FormState) {
    await api.updatePrompt(id, formToInput(form));
    if (form.files.length > 0) {
      await api.uploadAssets(id, form.files);
    }
    setEditing(false);
    load();
  }

  async function handleDelete() {
    if (!confirm('删除这条提示词？')) return;
    await api.deletePrompt(id);
    navigate('/');
  }

  async function handleDeleteAsset(assetId: string) {
    if (!confirm('删除这张图片？')) return;
    await api.deleteAsset(id, assetId);
    load();
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(rendered);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function handleBatchRender() {
    setBatchLoading(true);
    setBatchError('');
    try {
      const result = await api.renderPromptBatch(id, batchCount);
      setBatchResults(Array.isArray(result.rendered) ? result.rendered : [result.rendered]);
    } catch (e) {
      setBatchError(e instanceof Error ? e.message : '批量渲染失败');
    } finally {
      setBatchLoading(false);
    }
  }

  if (loading) return <div className={styles.state}>加载中…</div>;
  if (error || !prompt)
    return (
      <div className={styles.state}>
        <div className={styles.error}>{error}</div>
        <button onClick={() => navigate('/')}>返回列表</button>
      </div>
    );

  if (editing) {
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>编辑：{prompt.title}</h1>
        <PromptForm
          initial={promptToForm(prompt)}
          submitLabel="保存"
          onSubmit={handleSave}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <button className={styles.back} onClick={() => navigate('/')}>
        ← Back
      </button>

      <div className={styles.head}>
        <h1 className={styles.title}>
          {prompt.isFavorite && <span className={styles.fav}>★</span>} {prompt.title}
        </h1>
        <div className={styles.headActions}>
          <button onClick={() => navigate(`/workshop?promptId=${prompt.id}`)}>
            <span className={styles.btnIcon}>
              <SparklesIcon size={14} />
              AI 优化
            </span>
          </button>
          <button onClick={() => setEditing(true)}>编辑</button>
          <button className={styles.danger} onClick={handleDelete}>
            删除
          </button>
        </div>
      </div>

      {prompt.description && <p className={styles.desc}>{prompt.description}</p>}

      <div className={styles.meta}>
        {prompt.category && <span className={styles.badge}>{prompt.category}</span>}
          <span className={styles.badge}>{prompt.type === 'multimodal' ? '多模态' : '文本'}</span>
        {prompt.tags.map((t) => (
          <span key={t} className={styles.badge}>
            #{t}
          </span>
        ))}
      </div>

      {assets.length > 0 && (
        <div className={styles.assets}>
          {assets.map((a) => (
            <AssetThumb key={a.id} asset={a} onDelete={() => handleDeleteAsset(a.id)} />
          ))}
        </div>
      )}

      {prompt.parameters && Object.keys(prompt.parameters).length > 0 && (
        <section className={styles.paramSection}>
          <div className={styles.paramHead}>
            <h2 className={styles.sectionTitle}>生成参数</h2>
            <button
              onClick={async () => {
                const lines = Object.entries(prompt.parameters)
                  .filter(([, v]) => v)
                  .map(([k, v]) => `${k}: ${v}`);
                if (lines.length > 0) await navigator.clipboard.writeText(lines.join('\n'));
              }}
            >
              复制全部
            </button>
          </div>
          <div className={styles.paramGrid}>
            {Object.entries(prompt.parameters).map(([key, value]) => (
              <div key={key} className={styles.paramItem}>
                <span className={styles.paramKey}>{key}</span>
                <span className={styles.paramValue}>{value || '—'}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <pre className={styles.raw}>{prompt.content}</pre>

      {prompt.variables.length > 0 && (
        <section className={styles.renderSection}>
          <h2 className={styles.sectionTitle}>渲染</h2>
          {Object.keys(prompt.variablePools).length > 0 && (
            <label className={styles.batchToggle}>
              <input
                type="checkbox"
                checked={batchMode}
                onChange={(e) => setBatchMode(e.target.checked)}
              />
              批量随机模式
            </label>
          )}

          {!batchMode ? (
            <>
              <div className={styles.vars}>
                {prompt.variables.map((name) => (
                  <label key={name} className={styles.varField}>
                    <span>{name}</span>
                    <input
                      type="text"
                      value={values[name] ?? ''}
                      placeholder={`{${name}} 的值`}
                      onChange={(e) =>
                        setValues((v) => ({ ...v, [name]: e.target.value }))
                      }
                    />
                  </label>
                ))}
              </div>

              <div className={styles.output}>
                <div className={styles.outputHead}>
                  <span>Result</span>
                  <button onClick={handleCopy}>{copied ? '已复制 ✓' : '复制'}</button>
                </div>
                <pre className={styles.rendered}>{rendered}</pre>
              </div>
            </>
          ) : (
            <div className={styles.batchSection}>
              <div className={styles.batchControls}>
                <label>
                  生成数量：
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={batchCount}
                    onChange={(e) => setBatchCount(parseInt(e.target.value) || 10)}
                  />
                </label>
                <button onClick={handleBatchRender} disabled={batchLoading}>
                  {batchLoading ? '生成中…' : '批量渲染'}
                </button>
              </div>
              {batchError && <div className={styles.batchError}>{batchError}</div>}
              {batchResults.length > 0 && (
                <div className={styles.batchOutput}>
                  <div className={styles.outputHead}>
                    <span>共 {batchResults.length} 条变体</span>
                  </div>
                  <ul className={styles.batchList}>
                    {batchResults.map((text, i) => (
                      <li key={i} className={styles.batchItem}>
                        <span className={styles.batchIndex}>#{i + 1}</span>
                        <pre className={styles.batchText}>{text}</pre>
                        <button
                          onClick={async () => {
                            await navigator.clipboard.writeText(text);
                          }}
                        >
                          复制
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
