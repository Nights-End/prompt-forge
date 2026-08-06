import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Asset, Prompt, renderTemplate } from '@prompt-forge/shared';
import PromptForm from '../components/PromptForm';
import { FormState, formToInput } from '../types';
import styles from './DetailPage.module.css';

function promptToForm(p: Prompt): FormState {
  return {
    title: p.title,
    content: p.content,
    description: p.description ?? '',
    category: p.category,
    tags: p.tags.join(', '),
    isFavorite: p.isFavorite,
    type: p.type,
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
          aria-label="Delete asset"
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
      setError(e instanceof Error ? e.message : 'Prompt not found');
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
    if (!confirm('Delete this prompt?')) return;
    await api.deletePrompt(id);
    navigate('/');
  }

  async function handleDeleteAsset(assetId: string) {
    if (!confirm('Delete this image?')) return;
    await api.deleteAsset(id, assetId);
    load();
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(rendered);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (loading) return <div className={styles.state}>Loading…</div>;
  if (error || !prompt)
    return (
      <div className={styles.state}>
        <div className={styles.error}>{error}</div>
        <button onClick={() => navigate('/')}>Back to list</button>
      </div>
    );

  if (editing) {
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>Edit: {prompt.title}</h1>
        <PromptForm
          initial={promptToForm(prompt)}
          submitLabel="Save"
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
          <button onClick={() => setEditing(true)}>Edit</button>
          <button className={styles.danger} onClick={handleDelete}>
            Delete
          </button>
        </div>
      </div>

      {prompt.description && <p className={styles.desc}>{prompt.description}</p>}

      <div className={styles.meta}>
        {prompt.category && <span className={styles.badge}>{prompt.category}</span>}
        <span className={styles.badge}>{prompt.type === 'multimodal' ? 'multimodal' : 'text'}</span>
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

      <pre className={styles.raw}>{prompt.content}</pre>

      {prompt.variables.length > 0 && (
        <section className={styles.renderSection}>
          <h2 className={styles.sectionTitle}>Render</h2>
          <div className={styles.vars}>
            {prompt.variables.map((name) => (
              <label key={name} className={styles.varField}>
                <span>{name}</span>
                <input
                  type="text"
                  value={values[name] ?? ''}
                  placeholder={`Value for {${name}}`}
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
              <button onClick={handleCopy}>{copied ? 'Copied ✓' : 'Copy'}</button>
            </div>
            <pre className={styles.rendered}>{rendered}</pre>
          </div>
        </section>
      )}
    </div>
  );
}
