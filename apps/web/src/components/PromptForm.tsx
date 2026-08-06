import { useState } from 'react';
import { EMPTY_FORM, FormState } from '../types';
import { extractVariables } from '@prompt-forge/shared';
import styles from './PromptForm.module.css';

interface Props {
  initial?: FormState;
  submitLabel: string;
  onSubmit: (form: FormState) => void;
  onCancel: () => void;
}

export default function PromptForm({ initial, submitLabel, onSubmit, onCancel }: Props) {
  const [form, setForm] = useState<FormState>(initial ?? EMPTY_FORM);
  const variables = extractVariables(form.content);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit(form);
  }

  function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    setForm((f) => ({ ...f, files: [...f.files, ...files] }));
  }

  function removeFile(index: number) {
    setForm((f) => ({
      ...f,
      files: f.files.filter((_, i) => i !== index),
    }));
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <label className={styles.field}>
        <span>Title *</span>
        <input
          type="text"
          required
          value={form.title}
          onChange={(e) => set('title', e.target.value)}
          placeholder="e.g. Product launch email"
        />
      </label>

      <div className={styles.row}>
        <label className={styles.field}>
          <span>Type</span>
          <select value={form.type} onChange={(e) => set('type', e.target.value as FormState['type'])}>
            <option value="text">Text</option>
            <option value="multimodal">Text + images</option>
          </select>
        </label>
        <label className={styles.field}>
          <span>Description</span>
          <input
            type="text"
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="Optional short description"
          />
        </label>
      </div>

      <label className={styles.field}>
        <span>Content *</span>
        <textarea
          required
          rows={6}
          value={form.content}
          onChange={(e) => set('content', e.target.value)}
          placeholder="Write your template. Use {variable} placeholders."
        />
      </label>

      {form.type === 'multimodal' && (
        <div className={styles.field}>
          <span>Images</span>
          <label className={styles.fileBtn}>
            Select images…
            <input
              type="file"
              multiple
              accept="image/*"
              hidden
              onChange={handleFiles}
            />
          </label>
          {form.files.length > 0 && (
            <ul className={styles.fileList}>
              {form.files.map((f, i) => (
                <li key={`${f.name}-${i}`} className={styles.fileItem}>
                  <span>{f.name}</span>
                  <button
                    type="button"
                    className={styles.fileRemove}
                    onClick={() => removeFile(i)}
                    aria-label="Remove"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className={styles.row}>
        <label className={styles.field}>
          <span>Category</span>
          <input
            type="text"
            value={form.category}
            onChange={(e) => set('category', e.target.value)}
            placeholder="e.g. writing"
          />
        </label>
        <label className={styles.field}>
          <span>Tags (comma separated)</span>
          <input
            type="text"
            value={form.tags}
            onChange={(e) => set('tags', e.target.value)}
            placeholder="email, marketing"
          />
        </label>
      </div>

      {variables.length > 0 && (
        <div className={styles.hint}>
          Detected variables: {variables.map((v) => `{${v}}`).join(', ')}
        </div>
      )}

      <label className={styles.check}>
        <input
          type="checkbox"
          checked={form.isFavorite}
          onChange={(e) => set('isFavorite', e.target.checked)}
        />
        Mark as favorite
      </label>

      <div className={styles.actions}>
        <button type="button" className={styles.cancel} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className={styles.submit}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
