import { useEffect, useRef, useState } from 'react';
import { EMPTY_FORM, FormState } from '../types';
import { extractVariables } from '@prompt-forge/shared';
import { api } from '../api/client';
import ParamEditor from './ParamEditor';
import FilePreview from './FilePreview';
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
    setForm((f) => ({
      ...f,
      images: [
        ...f.images,
        ...files.map((file, i) => ({
          key: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
          file,
          params: {},
        })),
      ],
    }));
  }

  function removeImage(index: number) {
    setForm((f) => ({
      ...f,
      images: f.images.filter((_, i) => i !== index),
    }));
  }

  function removeExistingImage(id: string) {
    setForm((f) => ({
      ...f,
      existingImages: f.existingImages.filter((a) => a.id !== id),
    }));
  }

  const [tagInput, setTagInput] = useState('');

  function tagList(): string[] {
    return form.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }

  function addTag(raw: string) {
    const tag = raw.trim();
    if (!tag) return;
    const current = tagList();
    if (current.includes(tag)) return;
    set('tags', [...current, tag].join(', '));
  }

  function removeTag(tag: string) {
    set('tags', tagList().filter((t) => t !== tag).join(', '));
  }

  function tagCandidates(): string[] {
    const current = tagList();
    const q = tagInput.trim().toLowerCase();
    return allTags.filter(
      (t) => !current.includes(t) && (!q || t.toLowerCase().includes(q)),
    );
  }

  const [poolOpen, setPoolOpen] = useState(false);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [allCategories, setAllCategories] = useState<string[]>([]);
  const [categoryFocused, setCategoryFocused] = useState(false);
  const categoryRef = useRef<HTMLDivElement | null>(null);
  const [focusedPoolVar, setFocusedPoolVar] = useState<string | null>(null);
  const poolSectionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.listTags(), api.getCategories()])
      .then(([tags, categories]) => {
        if (cancelled) return;
        setAllTags(tags);
        setAllCategories(categories);
      })
      .catch(() => {
        // tag/category library is best-effort
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function categoryCandidates(): string[] {
    const q = form.category.trim().toLowerCase();
    return allCategories.filter(
      (c) => c !== form.category.trim() && (!q || c.toLowerCase().includes(q)),
    );
  }

  function handleCategoryBlur(e: React.FocusEvent) {
    const next = e.relatedTarget as Node | null;
    if (categoryRef.current && next && categoryRef.current.contains(next)) {
      return;
    }
    setCategoryFocused(false);
  }

  function handlePoolBlur(e: React.FocusEvent) {
    const next = e.relatedTarget as Node | null;
    if (poolSectionRef.current && next && poolSectionRef.current.contains(next)) {
      return;
    }
    setFocusedPoolVar(null);
  }

  function appendTagToPool(name: string, tag: string) {
    setForm((f) => {
      const current = (f.variablePools[name] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (current.includes(tag)) return f;
      return {
        ...f,
        variablePools: {
          ...f.variablePools,
          [name]: [...current, tag].join(', '),
        },
      };
    });
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
          {form.existingImages.length > 0 && (
            <>
              <span className={styles.imageSectionLabel}>已有图片（可编辑生成参数）</span>
              <ul className={styles.fileList}>
                {form.existingImages.map((img) => {
                  const url = api.assetFileUrl(img.id);
                  return (
                    <li key={img.id} className={styles.imageBlock}>
                      <div className={styles.imageBlockHead}>
                        <FilePreview url={url} href={url} />
                        <span className={styles.existingImageName}>
                          {img.fileName}
                        </span>
                        <button
                          type="button"
                          className={styles.fileRemove}
                          onClick={() => removeExistingImage(img.id)}
                          aria-label="移除"
                        >
                          ✕
                        </button>
                      </div>
                      <ParamEditor
                        value={img.params}
                        onChange={(params) =>
                          setForm((f) => ({
                            ...f,
                            existingImages: f.existingImages.map((x) =>
                              x.id === img.id ? { ...x, params } : x,
                            ),
                          }))
                        }
                      />
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {form.images.length > 0 && (
            <>
              <span className={styles.imageSectionLabel}>新图片（可编辑生成参数）</span>
              <ul className={styles.fileList}>
                {form.images.map((img, i) => (
                  <li key={img.key} className={styles.imageBlock}>
                    <div className={styles.imageBlockHead}>
                      <FilePreview file={img.file} />
                      <span>{img.file.name}</span>
                      <button
                        type="button"
                        className={styles.fileRemove}
                        onClick={() => removeImage(i)}
                        aria-label="移除"
                      >
                        ✕
                      </button>
                    </div>
                    <ParamEditor
                      value={img.params}
                      onChange={(params) =>
                        setForm((f) => ({
                          ...f,
                          images: f.images.map((x, idx) =>
                            idx === i ? { ...x, params } : x,
                          ),
                        }))
                      }
                    />
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {form.type === 'text' && (
        <ParamEditor
          value={form.parameters}
          onChange={(params) => set('parameters', params)}
        />
      )}

      <div className={styles.row}>
        <label className={styles.field}>
          <span>分类</span>
          <div
            className={styles.categoryPicker}
            ref={categoryRef}
            onBlur={handleCategoryBlur}
          >
            <input
              type="text"
              value={form.category}
              onChange={(e) => set('category', e.target.value)}
              onFocus={() => setCategoryFocused(true)}
              placeholder="例如：写作"
            />
            {categoryFocused && categoryCandidates().length > 0 && (
              <div className={styles.tagSuggest}>
                {categoryCandidates().map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={styles.tagSuggestItem}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      set('category', c);
                      setCategoryFocused(false);
                    }}
                  >
                    {c}
                  </button>
                ))}
              </div>
            )}
          </div>
        </label>
        <label className={styles.field}>
          <span>标签</span>
          <div className={styles.tagPicker}>
            <div className={styles.tagInputRow}>
              {tagList().map((tag) => (
                <span key={tag} className={styles.tagPicked}>
                  {tag}
                  <button
                    type="button"
                    className={styles.tagChipRemove}
                    onClick={() => removeTag(tag)}
                    aria-label={`移除标签 ${tag}`}
                  >
                    ✕
                  </button>
                </span>
              ))}
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    addTag(tagInput);
                    setTagInput('');
                  } else if (e.key === 'Backspace' && !tagInput && tagList().length > 0) {
                    removeTag(tagList()[tagList().length - 1]);
                  }
                }}
                onBlur={() => {
                  addTag(tagInput);
                  setTagInput('');
                }}
                placeholder={tagList().length > 0 ? '继续添加…' : '输入后回车添加，或选择已有标签'}
              />
            </div>
            {tagCandidates().length > 0 && (
              <div className={styles.tagSuggest}>
                {tagCandidates().map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className={styles.tagSuggestItem}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      addTag(tag);
                      setTagInput('');
                    }}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}
          </div>
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
              <div className={styles.poolBody} ref={poolSectionRef}>
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
                      onFocus={() => setFocusedPoolVar(name)}
                      onBlur={handlePoolBlur}
                      placeholder="值1, 值2, 值3"
                    />
                  </label>
                ))}
                {focusedPoolVar && allTags.length > 0 && (
                  <div className={styles.tagPanel}>
                    <div className={styles.tagPanelTitle}>
                      标签库 — 点击标签添加到「{focusedPoolVar}」
                    </div>
                    <div className={styles.tagChips}>
                      {allTags.map((tag) => {
                        const inPool = (form.variablePools[focusedPoolVar] ?? '')
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean)
                          .includes(tag);
                        return (
                          <button
                            key={tag}
                            type="button"
                            className={
                              inPool
                                ? `${styles.tagChip} ${styles.tagChipUsed}`
                                : styles.tagChip
                            }
                            title={inPool ? '已在池中' : `添加到 ${focusedPoolVar}`}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => appendTagToPool(focusedPoolVar, tag)}
                          >
                            {tag}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
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
