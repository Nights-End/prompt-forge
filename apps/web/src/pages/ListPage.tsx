import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { Prompt } from '@prompt-forge/shared';
import { Link, useNavigate } from 'react-router-dom';
import styles from './ListPage.module.css';

export default function ListPage() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
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
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load prompts');
    } finally {
      setLoading(false);
    }
  }, [q, category, favorite]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleDelete(id: string) {
    if (!confirm('Delete this prompt?')) return;
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
      const parts = [`Imported ${result.imported} prompt(s)`];
      if ('assets' in result) parts.push(`${result.assets} asset(s)`);
      alert(parts.join(', '));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Import failed');
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
          placeholder="Search prompts..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
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
          Favorites only
        </label>
        <div className={styles.spacer} />
        <label className={styles.importBtn}>
          Import
          <input
            type="file"
            accept=".json,.zip,application/json,application/zip"
            hidden
            onChange={handleImport}
          />
        </label>
        <button className={styles.exportBtn} onClick={handleExport}>
          Export
        </button>
      </div>

      {error && <div className={styles.error}>{error}</div>}
      {loading && <div className={styles.state}>Loading…</div>}
      {!loading && prompts.length === 0 && (
        <div className={styles.state}>
          No prompts yet. <Link to="/new">Create your first prompt</Link>.
        </div>
      )}

      <ul className={styles.list}>
        {prompts.map((p) => (
          <li key={p.id} className={styles.card}>
            <div className={styles.cardBody} onClick={() => navigate(`/prompts/${p.id}`)}>
              <div className={styles.cardTitle}>
                {p.isFavorite && <span className={styles.fav}>★</span>}
                {p.title}
              </div>
              <div className={styles.cardContent}>{p.content}</div>
              <div className={styles.meta}>
                {p.category && <span className={styles.badge}>{p.category}</span>}
                <span className={p.type === 'multimodal' ? styles.typeBadgeMultimodal : styles.badge}>
                  {p.type === 'multimodal' ? 'multimodal' : 'text'}
                </span>
                {p.tags.map((t) => (
                  <span key={t} className={styles.badge}>
                    #{t}
                  </span>
                ))}
                {p.variables.length > 0 && (
                  <span className={styles.vars}>{p.variables.length} var(s)</span>
                )}
              </div>
            </div>
            <button
              className={styles.deleteBtn}
              onClick={() => handleDelete(p.id)}
              aria-label="Delete"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
