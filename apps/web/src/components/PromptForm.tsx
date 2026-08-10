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

  const [paramOpen, setParamOpen] = useState(false);
  const [poolOpen, setPoolOpen] = useState(false);

  const FIXED_PARAM_KEYS = [
    'model', 'steps', 'sampler', 'cfg', 'seed',
    'resolution', 'negativePrompt',
  ] as const;

  const PARAM_LABELS: Record<string, string> = {
    model: '模型', steps: '步数', sampler: '采样器',
    cfg: 'CFG', seed: '种子', resolution: '分辨率',
    negativePrompt: '负面提示词',
  };

  const PARAM_PLACEHOLDERS: Record<string, string> = {
    model: 'SDXL / Flux...', steps: '30', sampler: 'DPM++ 2M Karras',
    cfg: '7', seed: '随机种子', resolution: '1024x1024',
  };

  function setParam(key: string, value: string) {
    setForm((f) => ({
      ...f,
      parameters: { ...f.parameters, [key]: value.trim() || undefined },
    }));
  }

  function removeCustomParam(key: string) {
    setForm((f) => {
      const next = { ...f.parameters };
      delete next[key];
      return { ...f, parameters: next };
    });
  }

  function addCustomParam() {
    let i = 0;
    let key = 'custom1';
    while (key in form.parameters) key = `custom${++i}`;
    setForm((f) => ({
      ...f,
      parameters: { ...f.parameters, [key]: '' },
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

      <div className={styles.paramSection}>
        <button
          type="button"
          className={styles.paramToggle}
          onClick={() => setParamOpen((o) => !o)}
        >
          {paramOpen ? '收起生成参数' : '生成参数 ▸'}
        </button>
        {paramOpen && (
          <div className={styles.paramBody}>
            <div className={styles.paramGrid}>
              {FIXED_PARAM_KEYS.map((key) => (
                <label key={key} className={styles.paramField}>
                  <span>{PARAM_LABELS[key] ?? key}</span>
                  {key === 'negativePrompt' ? (
                    <textarea
                      rows={2}
                      value={form.parameters[key] ?? ''}
                      onChange={(e) => setParam(key, e.target.value)}
                      placeholder="负面提示词（可选）"
                    />
                  ) : (
                    <input
                      type="text"
                      value={form.parameters[key] ?? ''}
                      onChange={(e) => setParam(key, e.target.value)}
                      placeholder={PARAM_PLACEHOLDERS[key] ?? ''}
                    />
                  )}
                </label>
              ))}
            </div>
            <div className={styles.paramCustoms}>
              {Object.keys(form.parameters)
                .filter((k) => !(FIXED_PARAM_KEYS as readonly string[]).includes(k))
                .map((key) => (
                  <div key={key} className={styles.paramCustomRow}>
                    <input
                      type="text"
                      className={styles.paramCustomKey}
                      value={key}
                      onChange={(e) => {
                        const newKey = e.target.value.trim();
                        const value = form.parameters[key] ?? '';
                        removeCustomParam(key);
                        if (newKey) setParam(newKey, value);
                      }}
                      placeholder="参数名"
                    />
                    <input
                      type="text"
                      className={styles.paramCustomVal}
                      value={form.parameters[key] ?? ''}
                      onChange={(e) => setParam(key, e.target.value)}
                      placeholder="值"
                    />
                    <button
                      type="button"
                      className={styles.paramRemove}
                      onClick={() => removeCustomParam(key)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              <button
                type="button"
                className={styles.paramAdd}
                onClick={addCustomParam}
              >
                + 自定义参数
              </button>
            </div>
          </div>
        )}
      </div>

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
        <>
          <div className={styles.hint}>
            检测到变量：{variables.map((v) => `{${v}}`).join(', ')}
          </div>
          <div className={styles.poolSection}>
            <button
              type="button"
              className={styles.paramToggle}
              onClick={() => setPoolOpen((o) => !o)}
            >
              {poolOpen ? '收起变量池配置' : '变量池配置（可选）▸'}
            </button>
            {poolOpen && (
              <div className={styles.poolBody}>
                <p className={styles.poolHint}>
                  为变量设置多个候选值（逗号分隔），渲染时随机抽取。至少 2 个值。
                </p>
                {variables.map((name) => (
                  <label key={name} className={styles.poolField}>
                    <span>{`{${name}}`}</span>
                    <input
                      type="text"
                      value={form.variablePools[name] ?? ''}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          variablePools: {
                            ...f.variablePools,
                            [name]: e.target.value,
                          },
                        }))
                      }
                      placeholder="值1, 值2, 值3"
                    />
                  </label>
                ))}
              </div>
            )}
          </div>
        </>
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
