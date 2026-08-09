import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { Asset, Prompt } from '@prompt-forge/shared';
import { Link, useNavigate } from 'react-router-dom';
import styles from './ListPage.module.css';

export default function ListPage() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [assetMap, setAssetMap] = useState<Record<string, Asset[]>>({});
  const [categories, setCategories] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [favorite, setFavorite] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [list, cats] = await Promise.all([
        api.listPrompts({
          q: q || undefined,
          category: category || undefined,
          favorite: favorite || undefined,
        }),
        api.getCategories(),
      ]);
      setPrompts(list);
      setCategories(cats);
      if (list.length > 0) {
        try {
          setAssetMap(await api.listAssetsByPrompts(list.map((p) => p.id)));
        } catch {
          setAssetMap({});
        }
      } else {
        setAssetMap({});
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载提示词失败');
    } finally {
      setLoading(false);
    }
  }, [q, category, favorite]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleDelete(id: string) {
    if (!confirm('删除这条提示词？')) return;
    await api.deletePrompt(id);
    load();
  }

  async function handleExport() {
    const blob = await api.exportZip();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'prompt-forge-export.zip';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const result = await api.importFile(file);
      const parts = [`已导入 ${result.imported} 条提示词`];
      if ('assets' in result) parts.push(`${result.assets} 个附件`);
      alert(parts.join(', '));
    } catch (err) {
      alert(err instanceof Error ? err.message : '导入失败');
    }
    e.target.value = '';
    load();
  }

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <input
          className={styles.search}
          type="search"
          placeholder="搜索提示词…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">全部分类</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={favorite}
            onChange={(e) => setFavorite(e.target.checked)}
          />
          只看收藏
        </label>
        <div className={styles.spacer} />
        <label className={styles.importBtn}>
          导入
          <input
            type="file"
            accept=".json,.zip,application/json,application/zip"
            hidden
            onChange={handleImport}
          />
        </label>
        <button className={styles.exportBtn} onClick={handleExport}>
          导出
        </button>
      </div>

      {error && <div className={styles.error}>{error}</div>}
      {loading && (
        <ul className={styles.list} aria-hidden="true">
          {Array.from({ length: 8 }).map((_, i) => (
            <li key={i} className={styles.skeletonCard}>
              <div className={styles.skeletonThumb} />
              <div className={styles.skeletonBody}>
                <div
                  className={styles.skeletonLine}
                  style={{ width: `${60 + ((i * 13) % 30)}%` }}
                />
                <div className={styles.skeletonLine} style={{ width: '92%' }} />
                <div className={styles.skeletonLine} style={{ width: '45%' }} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {!loading && prompts.length === 0 && (
        <div className={styles.state}>
          还没有提示词。<Link to="/new">创建第一条提示词</Link>。
        </div>
      )}

      <ul className={styles.list}>
        {prompts.map((p) => {
          const thumbAsset = (assetMap[p.id] ?? []).find((a) => a.kind === 'image');
          const thumb = thumbAsset ? api.assetFileUrl(thumbAsset.id) : null;
          return (
            <li key={p.id} className={styles.card}>
              <div
                className={styles.cardBody}
                onClick={() => navigate(`/prompts/${p.id}`)}
              >
                {thumb && (
                  <img className={styles.thumb} src={thumb} alt="" loading="lazy" />
                )}
                <div className={styles.cardTitle}>
                  {p.isFavorite && <span className={styles.fav}>★</span>}
                  {p.title}
                </div>
                <div className={styles.cardContent}>{p.content}</div>
                <div className={styles.meta}>
                  {p.category && <span className={styles.badge}>{p.category}</span>}
                  <span
                    className={
                      p.type === 'multimodal' ? styles.typeBadgeMultimodal : styles.badge
                    }
                  >
                    {p.type === 'multimodal' ? '多模态' : '文本'}
                  </span>
                  {p.tags.map((t) => (
                    <span key={t} className={styles.badge}>
                      #{t}
                    </span>
                  ))}
                  {p.variables.length > 0 && (
                    <span className={styles.vars}>{p.variables.length} 个变量</span>
                  )}
                </div>
              </div>
              <button
                className={styles.deleteBtn}
                onClick={() => handleDelete(p.id)}
                aria-label="删除"
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
