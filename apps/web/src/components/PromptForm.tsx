import { useState } from 'react';
import { EMPTY_FORM, FormState } from '../types';
import { extractVariables } from '@prompt-forge/shared';
import { api } from '../api/client';
import styles from './PromptForm.module.css';

interface Props {
  initial?: FormState;
  submitLabel: string;
  onSubmit: (form: FormState) => void;
  onCancel: () => void;
}

export default function PromptForm({ initial, submitLabel, onSubmit, onCancel }: Props) {
  const [form, setForm] = useState<FormState>(initial ?? EMPTY_FORM);
  const [titleBusy, setTitleBusy] = useState(false);
  const [titleError, setTitleError] = useState('');
  const variables = extractVariables(form.content);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleGenerateTitle() {
    if (!form.content.trim()) return;
    setTitleBusy(true);
    setTitleError('');
    try {
      const { title } = await api.generateTitle(form.content);
      set('title', title);
    } catch (e) {
      setTitleError(e instanceof Error ? e.message : '生成标题失败');
    } finally {
      setTitleBusy(false);
    }
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
        <span>标题 *</span>
        <div className={styles.titleRow}>
          <input
            type="text"
            required
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder="例如：产品发布邮件"
          />
          <button
            type="button"
            className={styles.genTitle}
            onClick={handleGenerateTitle}
            disabled={titleBusy || !form.content.trim()}
            title="根据提示词内容生成标题"
          >
            {titleBusy ? '生成中…' : '✨ AI 生成标题'}
          </button>
        </div>
        {titleError && <span className={styles.fieldError}>{titleError}</span>}
      </label>

      <div className={styles.row}>
        <label className={styles.field}>
          <span>类型</span>
          <select value={form.type} onChange={(e) => set('type', e.target.value as FormState['type'])}>
            <option value="text">纯文本</option>
            <option value="multimodal">文本 + 图片</option>
          </select>
        </label>
        <label className={styles.field}>
          <span>描述</span>
          <input
            type="text"
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="简短说明（可选）"
          />
        </label>
      </div>

      <label className={styles.field}>
        <span>内容 *</span>
        <textarea
          required
          rows={6}
          value={form.content}
          onChange={(e) => set('content', e.target.value)}
          placeholder="填写模板内容，使用 {variable} 占位符。"
        />
      </label>

      {form.type === 'multimodal' && (
        <div className={styles.field}>
          <span>图片</span>
          <label className={styles.fileBtn}>
            选择图片…
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
                    aria-label="移除"
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
          <span>分类</span>
          <input
            type="text"
            value={form.category}
            onChange={(e) => set('category', e.target.value)}
            placeholder="例如：写作"
          />
        </label>
        <label className={styles.field}>
          <span>标签（逗号分隔）</span>
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
          检测到变量：{variables.map((v) => `{${v}}`).join(', ')}
        </div>
      )}

      <label className={styles.check}>
        <input
          type="checkbox"
          checked={form.isFavorite}
          onChange={(e) => set('isFavorite', e.target.checked)}
        />
        设为收藏
      </label>

      <div className={styles.actions}>
        <button type="button" className={styles.cancel} onClick={onCancel}>
          取消
        </button>
        <button type="submit" className={styles.submit}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
