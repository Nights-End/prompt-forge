import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api/client';
import { Asset, Prompt } from '@prompt-forge/shared';
import { Link, useNavigate } from 'react-router-dom';
import styles from './ListPage.module.css';

const LIST_STATE_KEY = 'prompt-forge:list-state';
const PAGE_SIZE = 50;

interface SavedListState {
  q: string;
  category: string;
  favorite: boolean;
  prompts: Prompt[];
  assetMap: Record<string, Asset[]>;
  hasMore: boolean;
  scrollY: number;
}

function loadSavedState(): SavedListState | null {
  try {
    const raw = sessionStorage.getItem(LIST_STATE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SavedListState;
    if (!Array.isArray(s.prompts)) return null;
    return s;
  } catch {
    return null;
  }
}

export default function ListPage() {
  const saved = useRef<SavedListState | null>(loadSavedState()).current;
  const [prompts, setPrompts] = useState<Prompt[]>(saved?.prompts ?? []);
  const [assetMap, setAssetMap] = useState<Record<string, Asset[]>>(
    saved?.assetMap ?? {},
  );
  const [categories, setCategories] = useState<string[]>([]);
  const [q, setQ] = useState(saved?.q ?? '');
  const [category, setCategory] = useState(saved?.category ?? '');
  const [favorite, setFavorite] = useState(saved?.favorite ?? false);
  const [loading, setLoading] = useState(!saved);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(saved?.hasMore ?? false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
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
          limit: PAGE_SIZE,
        }),
        api.getCategories(),
      ]);
      setPrompts(list);
      setCategories(cats);
      setHasMore(list.length >= PAGE_SIZE);
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

  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    setError('');
    try {
      const list = await api.listPrompts({
        q: q || undefined,
        category: category || undefined,
        favorite: favorite || undefined,
        limit: PAGE_SIZE,
        offset: prompts.length,
      });
      setPrompts((prev) => [...prev, ...list]);
      setHasMore(list.length >= PAGE_SIZE);
      if (list.length > 0) {
        try {
          const more = await api.listAssetsByPrompts(list.map((p) => p.id));
          setAssetMap((prev) => ({ ...prev, ...more }));
        } catch {
          // asset thumbs are best-effort
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载更多失败');
    } finally {
      setLoadingMore(false);
    }
  }, [q, category, favorite, prompts.length, loadingMore]);

  useEffect(() => {
    if (saved) return;
    load();
  }, [load, saved]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading || loadingMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, loadMore]);

  useEffect(() => {
    if (saved && saved.scrollY > 0) {
      const y = saved.scrollY;
      requestAnimationFrame(() => window.scrollTo(0, y));
    }
  }, [saved]);

  useEffect(() => {
    return () => {
      try {
        sessionStorage.setItem(
          LIST_STATE_KEY,
          JSON.stringify({
            q,
            category,
            favorite,
            prompts,
            assetMap,
            hasMore,
            scrollY: window.scrollY,
          } satisfies SavedListState),
        );
      } catch {
        // sessionStorage may be full; state preservation is best-effort
      }
    };
  }, [q, category, favorite, prompts, assetMap, hasMore]);

  useEffect(() => {
    if (saved) {
      api
        .getCategories()
        .then(setCategories)
        .catch(() => {
          // categories are best-effort when restoring state
        });
    }
  }, [saved]);

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

      {!loading && hasMore && (
        <div className={styles.loadMoreWrap} ref={sentinelRef}>
          {loadingMore && <span className={styles.loadMoreHint}>加载中…</span>}
          <button
            className={styles.loadMoreBtn}
            onClick={loadMore}
            disabled={loadingMore}
          >
            {loadingMore ? '加载中…' : '加载更多'}
          </button>
        </div>
      )}
    </div>
  );
}
