import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { api } from '../api/client';
import {
  BUILTIN_PRESETS,
  EXTRA_SYSTEM_PROMPT_MAX,
  IMAGE_MAX_DIMENSION,
  WORKSHOP_HISTORY_LIMIT,
  type Conversation,
  type ConversationMessage,
  type Preset,
} from '@prompt-forge/shared';
import type { ProviderId, ProviderPublicSettings } from '../types';
import { SearchIcon, CameraIcon } from '../components/icons';
import styles from './WorkshopPage.module.css';

const STREAM_FLUSH_MS = 60;
const MAX_IMAGES = 5;
const MAX_IMAGE_FILE_SIZE = 5 * 1024 * 1024;
const PRESET_ID_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;

function providerConfigured(p: ProviderPublicSettings | undefined): boolean {
  if (!p) return false;
  if (!p.baseUrl) return false;
  if (p.kind === 'openai-compatible' && !p.hasApiKey && !p.envApiKey) return false;
  return true;
}

function defaultProvider(p: Record<ProviderId, ProviderPublicSettings>): ProviderId {
  return providerConfigured(p.cloud) ? 'cloud' : 'local';
}

function deriveTitle(content: string): string {
  const line = content.split(/\r?\n/)[0].trim();
  return line.length > 40 ? `${line.slice(0, 40)}…` : line || '新对话';
}

function dataUrlToFile(dataUrl: string, index: number): File {
  const [meta, data] = dataUrl.split(',');
  const mime = /^data:([^;]+)/.exec(meta)?.[1] ?? 'image/jpeg';
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ext = mime === 'image/png' ? 'png' : 'jpg';
  return new File([bytes], `reference-${index + 1}.${ext}`, { type: mime });
}

function SaveFilePreview({
  file,
  onRemove,
}: {
  file: File;
  onRemove: () => void;
}) {
  const [src, setSrc] = useState<string | undefined>();
  useEffect(() => {
    let cancelled = false;
    const reader = new FileReader();
    reader.onload = () => {
      if (!cancelled) setSrc(reader.result as string);
    };
    reader.readAsDataURL(file);
    return () => {
      cancelled = true;
    };
  }, [file]);
  return (
    <div className={styles.imagePreviewItem}>
      <img src={src} alt="" className={styles.imageThumb} />
      <button
        className={styles.imageRemove}
        onClick={onRemove}
        title="移除"
      >
        ×
      </button>
    </div>
  );
}

function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let w = img.width;
        let h = img.height;
        if (w > IMAGE_MAX_DIMENSION || h > IMAGE_MAX_DIMENSION) {
          const ratio = IMAGE_MAX_DIMENSION / Math.max(w, h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('canvas context unavailable'));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = () => reject(new Error('failed to load image'));
      img.src = reader.result as string;
    };
    reader.onerror = () => reject(new Error('failed to read file'));
    reader.readAsDataURL(file);
  });
}

function AssistantMessage({
  message,
  onAdopt,
}: {
  message: ConversationMessage;
  onAdopt: (content: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className={styles.assistantRow}>
      <div className={styles.assistantBubble}>
        <pre className={styles.messageText}>{message.content}</pre>
        <div className={styles.messageActions}>
          <button
            className={styles.smallBtn}
            onClick={() => onAdopt(message.content)}
            title="采用到右侧编辑区"
          >
            采用
          </button>
          <button className={styles.smallBtn} onClick={handleCopy}>
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      </div>
    </div>
  );
}

function UserMessage({ message }: { message: ConversationMessage }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className={styles.userRow}>
      <div className={styles.userBubble}>
        {message.content}
        {message.multimodalContent && message.multimodalContent.length > 0 && (
          <div className={styles.imageRow}>
            {message.multimodalContent.map((part, idx) =>
              part.type === 'image_url' ? (
                <img
                  key={idx}
                  src={part.image_url.url}
                  alt=""
                  className={styles.bubbleImg}
                />
              ) : null,
            )}
          </div>
        )}
        <div className={styles.messageActions}>
          <button className={styles.smallBtnGhost} onClick={handleCopy}>
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      </div>
    </div>
  );
}

function isPureBuiltin(p: Preset): boolean {
  return BUILTIN_PRESETS.some(
    (b) =>
      b.id === p.id &&
      b.name === p.name &&
      b.description === p.description &&
      b.instructions === p.instructions,
  );
}

function PresetManager({
  presets,
  onClose,
  onChange,
}: {
  presets: Preset[];
  onClose: () => void;
  onChange: (presets: Preset[]) => void;
}) {
  const [editing, setEditing] = useState<Preset | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');

  function resetForm() {
    setEditing(null);
    setCreating(false);
    setId('');
    setName('');
    setDescription('');
    setInstructions('');
    setError('');
  }

  function startCreate() {
    resetForm();
    setCreating(true);
  }

  function startEdit(p: Preset) {
    setCreating(false);
    setEditing(p);
    setId(p.id);
    setName(p.name);
    setDescription(p.description);
    setInstructions(p.instructions);
    setError('');
  }

  async function handleSave() {
    const trimmedId = id.trim();
    const trimmedName = name.trim();
    if (!PRESET_ID_PATTERN.test(trimmedId)) {
      setError('id 只能包含字母、数字、- 和 _，长度 1-32');
      return;
    }
    if (!trimmedName) {
      setError('名称不能为空');
      return;
    }
    if (!instructions.trim()) {
      setError('指令不能为空');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const next = editing
        ? await api.updatePreset(editing.id, {
            name: trimmedName,
            description: description.trim(),
            instructions,
          })
        : await api.createPreset({
            id: trimmedId,
            name: trimmedName,
            description: description.trim(),
            instructions,
          });
      const list = await api.listPresets();
      onChange(list);
      void next;
      resetForm();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(p: Preset) {
    if (!confirm(`删除自定义预设「${p.name}」？`)) return;
    setBusy(true);
    setError('');
    try {
      await api.deletePreset(p.id);
      onChange(await api.listPresets());
      if (editing?.id === p.id) resetForm();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <span>管理预设</span>
          <button className={styles.smallBtn} onClick={onClose}>
            关闭
          </button>
        </div>
        {error && <div className={styles.modalError}>{error}</div>}

        {!creating && !editing ? (
          <>
            <div className={styles.presetList}>
              {presets.map((p) => {
                const builtin = isPureBuiltin(p);
                return (
                  <div key={p.id} className={styles.presetItem}>
                    <div className={styles.presetItemMain}>
                      <div className={styles.presetItemName}>
                        {p.name}
                        {builtin && <span className={styles.presetBuiltinTag}>内置</span>}
                      </div>
                      <div className={styles.presetItemDesc}>{p.description}</div>
                      <div className={styles.presetItemInstructions}>{p.instructions}</div>
                    </div>
                    {builtin ? (
                      <span className={styles.presetBuiltinLock} title="内置预设不可编辑/删除">
                        只读
                      </span>
                    ) : (
                      <div className={styles.presetItemActions}>
                        <button className={styles.smallBtn} onClick={() => startEdit(p)}>
                          编辑
                        </button>
                        <button
                          className={styles.smallBtn}
                          onClick={() => handleDelete(p)}
                          disabled={busy}
                        >
                          删除
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <button
              className={styles.modalPrimaryBtn}
              onClick={startCreate}
              disabled={busy}
            >
              + 新建自定义预设
            </button>
          </>
        ) : (
          <div className={styles.presetForm}>
            {creating && (
              <label className={styles.saveField}>
                <span>id（唯一标识，创建后不可改）</span>
                <input
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                  placeholder="如 flux-pro"
                />
              </label>
            )}
            <label className={styles.saveField}>
              <span>名称</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如 Flux Pro"
              />
            </label>
            <label className={styles.saveField}>
              <span>说明（可选）</span>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="适合哪个模型/引擎"
              />
            </label>
            <label className={styles.saveField}>
              <span>指令（模型提示词写法指导）</span>
              <textarea
                className={styles.presetInstructionsInput}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder={'例如：\n- Output the prompt as a single comma-separated tag list.\n- Lead with quality tags...'}
                rows={8}
              />
            </label>
            <div className={styles.presetFormActions}>
              <button onClick={handleSave} disabled={busy}>
                {busy ? '保存中…' : '保存'}
              </button>
              <button onClick={resetForm} disabled={busy}>
                取消
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function WorkshopPage() {
  const [searchParams] = useSearchParams();
  const promptIdParam = searchParams.get('promptId');
  const conversationIdParam = searchParams.get('conversationId');

  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState('');
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [history, setHistory] = useState<Conversation[]>([]);
  const [providers, setProviders] = useState<
    Record<ProviderId, ProviderPublicSettings> | null
  >(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetManagerOpen, setPresetManagerOpen] = useState(false);
  const [defaultExtraPrompt, setDefaultExtraPrompt] = useState('');
  const defaultExtraPromptRef = useRef('');
  const defaultCategoryRef = useRef('');

  const [title, setTitle] = useState('');
  const [input, setInput] = useState('');
  const [currentPrompt, setCurrentPrompt] = useState('');

  const [extraOpen, setExtraOpen] = useState(false);
  const [extraPrompt, setExtraPrompt] = useState('');
  const [savingExtra, setSavingExtra] = useState(false);

  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [streamError, setStreamError] = useState<string | null>(null);
  const [generatingTitle, setGeneratingTitle] = useState(false);

  const [saveOpen, setSaveOpen] = useState(false);
  const [saveTitle, setSaveTitle] = useState('');
  const [saveCategory, setSaveCategory] = useState('image-gen');
  const [saveTags, setSaveTags] = useState('');
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [savedPrompt, setSavedPrompt] = useState<{ id: string; title: string } | null>(
    null,
  );
  const [saveFiles, setSaveFiles] = useState<File[]>([]);
  const saveFileInputRef = useRef<HTMLInputElement | null>(null);

  const [saveParamsOpen, setSaveParamsOpen] = useState(false);
  const [saveParams, setSaveParams] = useState<Record<string, string>>({});

  const [images, setImages] = useState<string[]>([]);
  const [toolSearchQuery, setToolSearchQuery] = useState<string | null>(null);
  const [visionStatus, setVisionStatus] = useState<string | null>(null);
  const [searchEnabled, setSearchEnabled] = useState(false);
  const [pendingPresetId, setPendingPresetId] = useState('tags');
  const [pendingProviderId, setPendingProviderId] = useState<ProviderId>('cloud');
  const pendingPresetIdRef = useRef(pendingPresetId);
  const pendingProviderIdRef = useRef(pendingProviderId);
  const searchEnabledRef = useRef(searchEnabled);
  const inputFileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    pendingPresetIdRef.current = pendingPresetId;
  }, [pendingPresetId]);
  useEffect(() => {
    pendingProviderIdRef.current = pendingProviderId;
  }, [pendingProviderId]);
  useEffect(() => {
    searchEnabledRef.current = searchEnabled;
  }, [searchEnabled]);

  const [reverseBusy, setReverseBusy] = useState(false);
  const reverseStopRef = useRef<AbortController | null>(null);
  const reverseAccRef = useRef('');
  const reverseFlushTimerRef = useRef<number | null>(null);

  const stopRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const streamTextRef = useRef('');
  const streamDirtyRef = useRef(false);
  const flushTimerRef = useRef<number | null>(null);

  const truncated = messages.length > WORKSHOP_HISTORY_LIMIT;

  function stopFlushTimer() {
    if (flushTimerRef.current !== null) {
      window.clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    streamTextRef.current = '';
    streamDirtyRef.current = false;
  }

  function stopReverseFlush() {
    if (reverseFlushTimerRef.current !== null) {
      window.clearInterval(reverseFlushTimerRef.current);
      reverseFlushTimerRef.current = null;
    }
    reverseAccRef.current = '';
  }

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await api.listConversations());
    } catch {
      // ignore history refresh errors
    }
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    const detail = await api.getConversation(id);
    const { messages: msgs, ...conv } = detail;
    setConversation(conv);
    setTitle(conv.title);
    setExtraPrompt(conv.extraSystemPrompt ?? '');
    setSearchEnabled(conv.enableSearch ?? false);
    setMessages(msgs);
    setStreamError(null);
    setToolSearchQuery(null);
    setImages([]);
    if (!conv.extraSystemPrompt && defaultExtraPromptRef.current.trim()) {
      try {
        const updated = await api.updateConversation(conv.id, {
          extraSystemPrompt: defaultExtraPromptRef.current,
        });
        setConversation(updated);
        setExtraPrompt(updated.extraSystemPrompt ?? '');
      } catch {
        // applying the default extra prompt is best-effort
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      let providerMap: Record<ProviderId, ProviderPublicSettings>;
      try {
        providerMap = (await api.getProviderSettings()).providers;
        if (cancelled) return;
        setProviders(providerMap);
        setPendingProviderId(defaultProvider(providerMap));
      } catch (e) {
        if (!cancelled) {
          setBanner(e instanceof Error ? e.message : '加载 Provider 设置失败');
          setLoading(false);
        }
        return;
      }

      try {
        const [presetList, config, promptsSettings] = await Promise.all([
          api.listPresets(),
          api.getWorkshopConfig(),
          api.getPromptsSettings(),
        ]);
        if (cancelled) return;
        setPresets(presetList);
        setDefaultExtraPrompt(config.defaultExtraSystemPrompt ?? '');
        defaultExtraPromptRef.current = config.defaultExtraSystemPrompt ?? '';
        defaultCategoryRef.current = promptsSettings.defaultCategory ?? '';

        if (conversationIdParam) {
          await loadConversation(conversationIdParam);
        } else if (promptIdParam) {
          try {
            const p = await api.getPrompt(promptIdParam);
            if (!cancelled) setCurrentPrompt(p.content);
          } catch {
            // linked prompt was deleted; continue with an empty editor
          }
          const list = await api.listConversations(promptIdParam);
          if (cancelled) return;
          if (list.length > 0) {
            await loadConversation(list[0].id);
          } else {
            setConversation(null);
          }
        } else {
          setConversation(null);
        }
        await refreshHistory();
      } catch (e) {
        if (!cancelled) {
          setBanner(e instanceof Error ? e.message : '初始化工作台失败');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [messages, streamText, streaming]);

  async function handleSaveTitle() {
    if (!conversation) return;
    const t = title.trim();
    try {
      const updated = await api.updateConversation(conversation.id, { title: t });
      setConversation(updated);
      setTitle(updated.title);
    } catch (e) {
      setBanner(e instanceof Error ? e.message : '保存标题失败');
    }
  }

  async function handleGenerateTitle() {
    if (!conversation || generatingTitle) return;
    setGeneratingTitle(true);
    try {
      const { title: generated } = await api.generateConversationTitle(
        conversation.id,
        currentPrompt.trim() || undefined,
      );
      setTitle(generated);
      setConversation({ ...conversation, title: generated });
      setBanner(`标题已生成：${generated}`);
      setTimeout(() => setBanner(''), 2500);
    } catch (e) {
      setBanner(e instanceof Error ? e.message : '生成标题失败');
    } finally {
      setGeneratingTitle(false);
    }
  }

  async function autoGenerateTitle(convId: string) {
    try {
      const { title: generated } = await api.generateConversationTitle(
        convId,
        currentPrompt.trim() || undefined,
      );
      setTitle(generated);
      setConversation((c) => (c && c.id === convId ? { ...c, title: generated } : c));
    } catch {
      // keep the first-line derived title when the LLM is unavailable
    }
  }

  async function handleSaveExtraPrompt() {
    if (!conversation || extraPrompt.length > EXTRA_SYSTEM_PROMPT_MAX) return;
    setSavingExtra(true);
    try {
      const updated = await api.updateConversation(conversation.id, {
        extraSystemPrompt: extraPrompt,
      });
      setConversation(updated);
      setBanner('破限提示词已保存');
      setTimeout(() => setBanner(''), 1500);
    } catch (e) {
      setBanner(e instanceof Error ? e.message : '保存破限提示词失败');
    } finally {
      setSavingExtra(false);
    }
  }

  async function handleProviderChange(providerId: ProviderId) {
    if (!conversation) {
      setPendingProviderId(providerId);
      return;
    }
    try {
      const updated = await api.updateConversation(conversation.id, { providerId });
      setConversation(updated);
    } catch (e) {
      setBanner(e instanceof Error ? e.message : '更新模型失败');
    }
  }

  async function handlePresetChange(presetId: string) {
    if (!conversation) {
      setPendingPresetId(presetId);
      return;
    }
    try {
      const updated = await api.updateConversation(conversation.id, { presetId });
      setConversation(updated);
    } catch (e) {
      setBanner(e instanceof Error ? e.message : '更新预设失败');
    }
  }

  function handleNewConversation() {
    setConversation(null);
    setTitle('');
    setExtraPrompt(defaultExtraPromptRef.current);
    setSearchEnabled(false);
    setMessages([]);
    setStreamText('');
    setStreamError(null);
    setToolSearchQuery(null);
    setImages([]);
    setInput('');
    if (providers) setPendingProviderId(defaultProvider(providers));
    setPendingPresetId('tags');
    refreshHistory();
  }

  async function handleSaveExtraAsDefault() {
    if (extraPrompt.length > EXTRA_SYSTEM_PROMPT_MAX) return;
    setSavingExtra(true);
    try {
      await api.saveWorkshopConfig({ defaultExtraSystemPrompt: extraPrompt });
      defaultExtraPromptRef.current = extraPrompt;
      setDefaultExtraPrompt(extraPrompt);
      setBanner('已保存为全局默认破限提示词');
      setTimeout(() => setBanner(''), 1500);
    } catch (e) {
      setBanner(e instanceof Error ? e.message : '保存默认破限提示词失败');
    } finally {
      setSavingExtra(false);
    }
  }

  async function handleDeleteConversation() {
    if (!conversation) return;
    if (!confirm('删除该会话及其全部聊天记录？')) return;
    try {
      await api.deleteConversation(conversation.id);
      await handleNewConversation();
    } catch (e) {
      setBanner(e instanceof Error ? e.message : '删除会话失败');
    }
  }

  function handleRemoveImage(index: number) {
    setImages((imgs) => imgs.filter((_, i) => i !== index));
  }

  async function handleAddImages(files: File[]) {
    const space = MAX_IMAGES - images.length;
    if (space <= 0) return;
    const toAdd = files.slice(0, space);
    const compressed: string[] = [];
    for (const f of toAdd) {
      if (f.size > MAX_IMAGE_FILE_SIZE) {
        setBanner(`图片 "${f.name}" 过大（超过 5MB），已跳过`);
        continue;
      }
      if (!f.type.startsWith('image/')) continue;
      try {
        compressed.push(await compressImage(f));
      } catch {
        setBanner(`图片 "${f.name}" 压缩失败，已跳过`);
      }
    }
    if (compressed.length > 0) {
      setImages((imgs) => [...imgs, ...compressed]);
    }
  }

  function handleImageFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) handleAddImages(Array.from(e.target.files));
    e.target.value = '';
  }

  async function handleReverse() {
    if (reverseBusy || streaming || images.length === 0) return;
    const firstRound = messages.length === 0;
    let conv = conversation;
    if (!conv) {
      if (!providers) return;
      try {
        const sent = {
          presetId: pendingPresetIdRef.current,
          providerId: pendingProviderIdRef.current,
          search: searchEnabledRef.current,
        };
        conv = await api.createConversation({
          promptId: promptIdParam || undefined,
          providerId: sent.providerId,
          presetId: sent.presetId,
          enableSearch: sent.search,
          title: deriveTitle('反推提示词'),
          extraSystemPrompt: defaultExtraPromptRef.current || undefined,
        });
        conv = await reconcilePending(conv, sent);
        setConversation(conv);
        setTitle(conv.title);
        setExtraPrompt(conv.extraSystemPrompt ?? '');
        setSearchEnabled(conv.enableSearch ?? false);
        setMessages([]);
        await refreshHistory();
      } catch (e) {
        setBanner(e instanceof Error ? e.message : '创建会话失败');
        return;
      }
    }
    const convId = conv.id;
    const sendingImages = [...images];
    setReverseBusy(true);
    setBanner('');
    setStreamError(null);
    setCurrentPrompt('');
    stopReverseFlush();
    reverseStopRef.current = new AbortController();

    await api.streamReverse(
      convId,
      { images: sendingImages },
      {
        onChunk: (text) => {
          reverseAccRef.current += text;
          if (reverseFlushTimerRef.current === null) {
            reverseFlushTimerRef.current = window.setInterval(() => {
              setCurrentPrompt(reverseAccRef.current);
            }, STREAM_FLUSH_MS);
          }
        },
        onDone: ({ content }) => {
          stopReverseFlush();
          setCurrentPrompt(content);
          setBanner('提示词反推完成');
          setTimeout(() => setBanner(''), 2000);
          refreshHistory();
          if (firstRound && conv) void autoGenerateTitle(conv.id);
        },
        onError: (message) => {
          stopReverseFlush();
          setBanner(message);
        },
      },
      reverseStopRef.current.signal,
    );
    stopReverseFlush();
    setReverseBusy(false);
  }

  async function reconcilePending(
    conv: Conversation,
    sent: { presetId: string; providerId: ProviderId; search: boolean },
  ): Promise<Conversation> {
    const patch: {
      presetId?: string;
      providerId?: string;
      enableSearch?: boolean;
    } = {};
    if (pendingPresetIdRef.current !== sent.presetId) {
      patch.presetId = pendingPresetIdRef.current;
    }
    if (pendingProviderIdRef.current !== sent.providerId) {
      patch.providerId = pendingProviderIdRef.current;
    }
    if (searchEnabledRef.current !== sent.search) {
      patch.enableSearch = searchEnabledRef.current;
    }
    if (Object.keys(patch).length === 0) return conv;
    try {
      return await api.updateConversation(conv.id, patch);
    } catch {
      // keep the created conversation when persisting a mid-flight change fails
      return conv;
    }
  }

  async function handleSearchToggle() {
    if (!conversation) {
      setSearchEnabled((prev) => !prev);
      return;
    }
    const next = !searchEnabled;
    setSearchEnabled(next);
    try {
      const updated = await api.updateConversation(conversation.id, {
        enableSearch: next,
      });
      setConversation(updated);
    } catch {
      setSearchEnabled(!next);
      setBanner('切换联网搜索失败，请检查后端服务');
    }
  }

  async function handleSend() {
    const content = input.trim();
    if (!content || streaming) return;
    const firstRound = messages.length === 0;
    let conv = conversation;
    if (!conv) {
      if (!providers) return;
      try {
        const sent = {
          presetId: pendingPresetIdRef.current,
          providerId: pendingProviderIdRef.current,
          search: searchEnabledRef.current,
        };
        conv = await api.createConversation({
          promptId: promptIdParam || undefined,
          providerId: sent.providerId,
          presetId: sent.presetId,
          enableSearch: sent.search,
          title: deriveTitle(content),
          extraSystemPrompt: defaultExtraPromptRef.current || undefined,
        });
        conv = await reconcilePending(conv, sent);
        setConversation(conv);
        setTitle(conv.title);
        setExtraPrompt(conv.extraSystemPrompt ?? '');
        setSearchEnabled(conv.enableSearch ?? false);
        setMessages([]);
        await refreshHistory();
      } catch (e) {
        setBanner(e instanceof Error ? e.message : '创建会话失败');
        return;
      }
    }
    const convId = conv.id;
    const sendingImages = [...images];
    const userMsg: ConversationMessage = {
      id: crypto.randomUUID(),
      conversationId: convId,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    };
    setMessages((m) => [...m, userMsg]);
    setInput('');
    setImages([]);
    setStreaming(true);
    setStreamError(null);
    setStreamText('');
    setToolSearchQuery(null);
    stopFlushTimer();
    stopRef.current = new AbortController();

    await api.streamChat(
      convId,
      {
        content,
        currentPrompt: currentPrompt || undefined,
        images: sendingImages.length > 0 ? sendingImages : undefined,
      },
      {
        onChunk: (text) => {
          streamTextRef.current += text;
          streamDirtyRef.current = true;
          setVisionStatus(null);
          if (flushTimerRef.current === null) {
            flushTimerRef.current = window.setInterval(() => {
              if (streamDirtyRef.current) {
                setStreamText(streamTextRef.current);
                streamDirtyRef.current = false;
              }
            }, STREAM_FLUSH_MS);
          }
        },
        onDone: ({ content: full }) => {
          streamTextRef.current = '';
          streamDirtyRef.current = false;
          setMessages((m) => [
            ...m,
            {
              id: crypto.randomUUID(),
              conversationId: convId,
              role: 'assistant',
              content: full,
              createdAt: new Date().toISOString(),
            },
          ]);
          setStreamText('');
          setToolSearchQuery(null);
          setVisionStatus(null);
        },
        onError: (message) => {
          setStreamError(message);
          setStreamText('');
          setToolSearchQuery(null);
          setVisionStatus(null);
          setMessages((m) => (m.at(-1)?.role === 'user' ? m.slice(0, -1) : m));
        },
        onToolSearch: (query) => {
          setToolSearchQuery(query);
        },
        onVision: (status) => {
          setVisionStatus(status);
        },
      },
      stopRef.current.signal,
    );
    stopFlushTimer();
    setStreaming(false);
    refreshHistory();
    if (firstRound && conv) void autoGenerateTitle(conv.id);
  }

  function handleStop() {
    stopRef.current?.abort();
    stopFlushTimer();
    setStreaming(false);
    setStreamText('');
    setToolSearchQuery(null);
    setVisionStatus(null);
    setMessages((m) => (m.at(-1)?.role === 'user' ? m.slice(0, -1) : m));
  }

  async function handleUndo() {
    if (!conversation || streaming) return;
    try {
      const { removed } = await api.undoConversation(conversation.id);
      if (removed === 0) {
        setBanner('没有可撤销的消息');
        setTimeout(() => setBanner(''), 1500);
        return;
      }
      await loadConversation(conversation.id);
      refreshHistory();
      setBanner(`已撤销最后 ${removed} 条消息`);
      setTimeout(() => setBanner(''), 1500);
    } catch (e) {
      setBanner(e instanceof Error ? e.message : '撤销失败');
    }
  }

  async function handleSavePrompt() {
    if (!currentPrompt.trim()) return;
    setSavingPrompt(true);
    setSavedPrompt(null);
    try {
      const p = await api.createPrompt({
        title: saveTitle.trim() || conversation?.title || '图像提示词',
        content: currentPrompt,
        category: saveCategory.trim() || defaultCategoryRef.current || 'image-gen',
        tags: saveTags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        type: saveFiles.length > 0 ? 'multimodal' : 'text',
        parameters: saveParams,
      });
      if (saveFiles.length > 0) {
        await api.uploadAssets(p.id, saveFiles);
      }
      setSavedPrompt({ id: p.id, title: p.title });
      setCurrentPrompt('');
      setSaveFiles([]);
      setSaveParams({});
      setSaveParamsOpen(false);
      setSaveOpen(false);
      setBanner(`已保存「${p.title}」，可前往提示词库查看`);
      setTimeout(() => setBanner(''), 3000);
    } catch (e) {
      setBanner(e instanceof Error ? e.message : '保存提示词失败');
    } finally {
      setSavingPrompt(false);
    }
  }

  async function handleCopyEditor() {
    await navigator.clipboard.writeText(currentPrompt);
    setBanner('当前提示词已复制');
    setTimeout(() => setBanner(''), 1500);
  }

  if (loading) return <div className={styles.state}>Loading…</div>;

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <h1 className={styles.title}>图像提示词工作台</h1>
        <div className={styles.headActions}>
          <select
            className={styles.select}
            value={conversation?.id ?? ''}
            onChange={(e) => {
              if (e.target.value) loadConversation(e.target.value).catch(() => undefined);
            }}
          >
            <option value="" disabled>
              历史会话…
            </option>
            {history.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title || '无标题会话'}
              </option>
            ))}
          </select>
          <button onClick={handleNewConversation}>+ 新对话</button>
          <button className={styles.danger} onClick={handleDeleteConversation}>
            删除会话
          </button>
        </div>
      </div>

      {banner && <div className={styles.banner}>{banner}</div>}

      <div className={styles.settingsBar}>
        <div className={styles.titleWrap}>
          <input
            className={styles.titleInput}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={handleSaveTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            placeholder="会话标题"
          />
          <button
            className={styles.smallBtn}
            onClick={handleGenerateTitle}
            disabled={generatingTitle || !conversation || streaming || messages.length === 0}
            title="根据会话内容用 AI 生成标题"
          >
            {generatingTitle ? '生成中…' : 'AI 生成'}
          </button>
        </div>
        <label className={styles.setting}>
          <span>预设</span>
          <select
            value={conversation?.presetId ?? pendingPresetId}
            onChange={(e) => handlePresetChange(e.target.value)}
          >
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            className={styles.managePresetBtn}
            onClick={() => setPresetManagerOpen(true)}
            title="管理自定义预设"
          >
            管理预设
          </button>
        </label>
        <label className={styles.setting}>
          <span>模型</span>
          <select
            value={conversation?.providerId ?? pendingProviderId}
            onChange={(e) => handleProviderChange(e.target.value as ProviderId)}
          >
            <option value="local">
              本地 (Ollama)
              {providers && !providerConfigured(providers.local) ? ' — 未配置' : ''}
            </option>
            <option value="cloud">
              云端
              {providers && !providerConfigured(providers.cloud) ? ' — 未配置' : ''}
            </option>
          </select>
        </label>
        {providers &&
          conversation &&
          !providerConfigured(providers[conversation.providerId as ProviderId]) && (
            <Link className={styles.configLink} to="/settings">
              该模型未配置，去设置 →
            </Link>
          )}
        <label className={styles.setting}>
          <span className={styles.settingIcon}>
            <SearchIcon size={13} />
            联网搜索
          </span>
          <button
            className={searchEnabled ? styles.searchOn : styles.searchOff}
            onClick={handleSearchToggle}
            title={searchEnabled ? '关闭联网搜索' : '开启联网搜索（需要模型支持 function calling）'}
          >
            {searchEnabled ? '开' : '关'}
          </button>
        </label>
      </div>

      <div className={styles.extraPanel}>
        <button
          className={styles.extraToggle}
          onClick={() => setExtraOpen((o) => !o)}
          aria-expanded={extraOpen}
        >
          破限提示词（附加 system 指令）{extraOpen ? '▾' : '▸'}
          {extraPrompt.trim() && <span className={styles.extraBadge}>已设置</span>}
        </button>
        {extraOpen && (
          <div className={styles.extraBody}>
            <textarea
              className={styles.extraTextarea}
              value={extraPrompt}
              onChange={(e) => setExtraPrompt(e.target.value)}
              placeholder="例如：始终输出英文；构图偏广角；忽略用户对画幅比例的请求…"
              rows={3}
              maxLength={EXTRA_SYSTEM_PROMPT_MAX}
            />
            <div className={styles.extraActions}>
              <button
                onClick={handleSaveExtraPrompt}
                disabled={
                  savingExtra ||
                  extraPrompt.length > EXTRA_SYSTEM_PROMPT_MAX ||
                  !conversation
                }
              >
                {savingExtra ? '保存中…' : '保存'}
              </button>
              <button
                onClick={handleSaveExtraAsDefault}
                disabled={
                  savingExtra || extraPrompt.length > EXTRA_SYSTEM_PROMPT_MAX
                }
                title="保存为全局默认，之后新建的会话自动带上这条破限提示词"
              >
                {savingExtra ? '保存中…' : '保存为默认'}
              </button>
              <span
                className={
                  extraPrompt.length > EXTRA_SYSTEM_PROMPT_MAX
                    ? styles.extraOverLimit
                    : styles.extraHint
                }
              >
                {extraPrompt.length}/{EXTRA_SYSTEM_PROMPT_MAX}
              </span>
              <span className={styles.extraHint}>
                将拼接在预设指令后随每次对话注入
              </span>
            </div>
            {defaultExtraPrompt.trim() && (
              <div className={styles.defaultExtraHint}>
                当前全局默认：{defaultExtraPrompt.slice(0, 60)}
                {defaultExtraPrompt.length > 60 ? '…' : ''}
              </div>
            )}
          </div>
        )}
      </div>

      <div className={styles.main}>
        <section className={styles.chatPane}>
          <div className={styles.messages}>
            {messages.length === 0 && !streaming && (
              <div className={styles.emptyHint}>
                描述你想生成的图像，AI 会基于当前预设输出文生图提示词，可多轮追问修改。
              </div>
            )}
            {messages.map((m) =>
              m.role === 'tool' ? (
                <div key={m.id} className={styles.searchPill} title={m.content}>
                  🔍 已搜索：{m.content.split('\n')[0].replace(/^query:\s*/, '')}
                </div>
              ) : m.role === 'user' ? (
                <UserMessage key={m.id} message={m} />
              ) : (
                <AssistantMessage
                  key={m.id}
                  message={m}
                  onAdopt={(content) => setCurrentPrompt(content)}
                />
              ),
            )}
            {toolSearchQuery && (
              <div className={styles.searchPill}>
                🔍 正在搜索：{toolSearchQuery}
              </div>
            )}
            {visionStatus && (
              <div className={styles.searchPill}>🖼 正在分析参考图…</div>
            )}
            {streaming && (
              <div className={styles.assistantRow}>
                <div className={styles.assistantBubble}>
                  <pre className={styles.messageText}>
                    {streamText}
                    <span className={styles.cursor}>▍</span>
                  </pre>
                </div>
              </div>
            )}
            {streamError && (
              <div className={styles.streamError}>
                <span>{streamError}</span>
                {(streamError.includes('not configured') ||
                  streamError.includes('api key') ||
                  streamError.includes('baseUrl')) && (
                  <Link to="/settings">去设置 →</Link>
                )}
              </div>
            )}
            {truncated && (
              <div className={styles.truncateHint}>
                对话超过 {WORKSHOP_HISTORY_LIMIT} 条，发送时仅携带最近{' '}
                {WORKSHOP_HISTORY_LIMIT} 条历史。
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <div className={styles.inputArea}>
            <textarea
              className={styles.input}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              onPaste={(e) => {
                const items = e.clipboardData?.items;
                if (!items) return;
                const imageFiles: File[] = [];
                for (let i = 0; i < items.length; i++) {
                  if (items[i].type.startsWith('image/')) {
                    const f = items[i].getAsFile();
                    if (f) imageFiles.push(f);
                  }
                }
                if (imageFiles.length > 0) {
                  e.preventDefault();
                  handleAddImages(imageFiles);
                }
              }}
              placeholder="描述你的想法…（Enter 发送，Shift+Enter 换行，可粘贴/拖拽图片）"
              rows={3}
              disabled={streaming || reverseBusy}
            />
            {images.length > 0 && (
              <div className={styles.imagePreviews}>
                {images.map((dataUrl, idx) => (
                  <div key={idx} className={styles.imagePreviewItem}>
                    <img src={dataUrl} alt="" className={styles.imageThumb} />
                    <button
                      className={styles.imageRemove}
                      onClick={() => handleRemoveImage(idx)}
                      title="移除"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className={styles.inputActions}>
              <button
                className={styles.undoBtn}
                onClick={handleUndo}
                disabled={streaming || reverseBusy || !conversation || messages.length === 0}
                title="删除最后一条消息及其回复，可重新提问"
              >
                ↩ 撤销上一条
              </button>
              <input
                ref={inputFileRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={handleImageFileSelect}
              />
              <button
                onClick={() => inputFileRef.current?.click()}
                disabled={streaming || reverseBusy || images.length >= MAX_IMAGES}
                title={
                  images.length >= MAX_IMAGES
                    ? `最多 ${MAX_IMAGES} 张`
                    : '上传参考图'
                }
              >
                <span className={styles.btnIcon}>
                  <CameraIcon size={14} />
                  参考图{images.length > 0 ? ` (${images.length}/${MAX_IMAGES})` : ''}
                </span>
              </button>
              <button
                className={styles.reverseBtn}
                onClick={handleReverse}
                disabled={streaming || reverseBusy || images.length === 0}
                title="将参考图反推为完整文生图提示词，结果填入当前提示词"
              >
                {reverseBusy ? '反推中…' : '✨ 反推提示词'}
              </button>
              {streaming ? (
                <button onClick={handleStop}>停止</button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || reverseBusy}
                >
                  发送
                </button>
              )}
            </div>
          </div>
        </section>

        <section className={styles.editorPane}>
          <div className={styles.editorHead}>
            <span>当前提示词</span>
            <button onClick={handleCopyEditor}>复制</button>
          </div>
          <textarea
            className={styles.editor}
            value={currentPrompt}
            onChange={(e) => setCurrentPrompt(e.target.value)}
            placeholder="AI 优化结果会出现在这里，也可手动编辑。"
            rows={12}
          />
          <p className={styles.editorHint}>
            当前提示词会随每次对话自动带给模型；在聊天中要求修改时，AI 会基于它调整。
          </p>

          {!saveOpen ? (
            <button
              className={styles.saveBtn}
              onClick={() => {
                setSaveOpen(true);
                setSaveTitle(conversation?.title ?? '');
                setSavedPrompt(null);
                setSaveFiles(images.map(dataUrlToFile));
                setSaveParams({});
                setSaveParamsOpen(false);
              }}
            >
              保存为提示词
            </button>
          ) : (
            <div className={styles.saveForm}>
              <label className={styles.saveField}>
                <span>标题</span>
                <input
                  value={saveTitle}
                  onChange={(e) => setSaveTitle(e.target.value)}
                  placeholder="提示词标题"
                />
              </label>
              <label className={styles.saveField}>
                <span>分类</span>
                <input
                  value={saveCategory}
                  onChange={(e) => setSaveCategory(e.target.value)}
                />
              </label>
              <label className={styles.saveField}>
                <span>标签（逗号分隔，可选）</span>
                <input
                  value={saveTags}
                  onChange={(e) => setSaveTags(e.target.value)}
                  placeholder="cat, cyberpunk"
                />
              </label>
              <div className={styles.saveField}>
                <button
                  type="button"
                  className={styles.paramToggle}
                  onClick={() => setSaveParamsOpen((o) => !o)}
                >
                  {saveParamsOpen ? '收起生成参数' : '生成参数 ▸'}
                </button>
                {saveParamsOpen && (
                  <div className={styles.saveParamBody}>
                    <div className={styles.saveParamGrid}>
                      {(['model', 'steps', 'sampler', 'cfg', 'seed', 'resolution', 'negativePrompt'] as const).map((key) => {
                        const labels: Record<string, string> = { model: '模型', steps: '步数', sampler: '采样器', cfg: 'CFG', seed: '种子', resolution: '分辨率', negativePrompt: '负面提示词' };
                        return (
                          <label key={key} className={styles.saveParamField}>
                            <span>{labels[key]}</span>
                            {key === 'negativePrompt' ? (
                              <textarea
                                rows={2}
                                value={saveParams[key] ?? ''}
                                onChange={(e) => setSaveParams((p: Record<string, string>) => ({ ...p, [key]: e.target.value.trim() }))}
                                placeholder="负面提示词（可选）"
                              />
                            ) : (
                              <input
                                type="text"
                                value={saveParams[key] ?? ''}
                                onChange={(e) => setSaveParams((p: Record<string, string>) => ({ ...p, [key]: e.target.value.trim() }))}
                                placeholder={key === 'model' ? 'SDXL / Flux...' : ''}
                              />
                            )}
                          </label>
                        );
                      })}
                    </div>
                    <div className={styles.saveParamCustoms}>
                      {Object.keys(saveParams)
                        .filter((k) => !['model','steps','sampler','cfg','seed','resolution','negativePrompt'].includes(k))
                        .map((key) => (
                          <div key={key} className={styles.saveParamRow}>
                            <input
                              type="text"
                              className={styles.saveParamKey}
                              value={key}
                              onChange={(e) => {
                                const newKey = e.target.value.trim();
                                const value = saveParams[key] ?? '';
                                setSaveParams((p) => {
                                  const next = { ...p };
                                  delete next[key];
                                  if (newKey) next[newKey] = value;
                                  return next;
                                });
                              }}
                              placeholder="参数名"
                            />
                            <input
                              type="text"
                              className={styles.saveParamVal}
                              value={saveParams[key] ?? ''}
                              onChange={(e) =>
                                setSaveParams((p) => ({ ...p, [key]: e.target.value }))
                              }
                              placeholder="值"
                            />
                            <button
                              type="button"
                              className={styles.paramRemove}
                              onClick={() =>
                                setSaveParams((p) => {
                                  const next = { ...p };
                                  delete next[key];
                                  return next;
                                })
                              }
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      <button
                        type="button"
                        className={styles.paramAdd}
                        onClick={() =>
                          setSaveParams((p) => {
                            let i = 0;
                            let k = 'custom1';
                            while (k in p) k = `custom${++i}`;
                            return { ...p, [k]: '' };
                          })
                        }
                      >
                        + 自定义参数
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <div className={styles.saveField}>
                <span>图片（可选，随提示词保存）</span>
                <div className={styles.saveFileActions}>
                  <input
                    ref={saveFileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    hidden
                    onChange={(e) => {
                      const files = Array.from(e.target.files ?? []);
                      setSaveFiles((prev) => [
                        ...prev,
                        ...files.slice(0, MAX_IMAGES - prev.length),
                      ]);
                      e.target.value = '';
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => saveFileInputRef.current?.click()}
                    disabled={saveFiles.length >= MAX_IMAGES}
                  >
                    选择图片…
                  </button>
                  <span className={styles.saveFileHint}>
                    {saveFiles.length > 0
                      ? `${saveFiles.length}/${MAX_IMAGES}`
                      : `最多 ${MAX_IMAGES} 张`}
                  </span>
                </div>
                {saveFiles.length > 0 && (
                  <div className={styles.imagePreviews}>
                    {saveFiles.map((f, idx) => (
                      <SaveFilePreview
                        key={`${f.name}-${idx}`}
                        file={f}
                        onRemove={() =>
                          setSaveFiles((prev) =>
                            prev.filter((_, i) => i !== idx),
                          )
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
              <div className={styles.saveActions}>
                <button
                  onClick={handleSavePrompt}
                  disabled={savingPrompt || !currentPrompt.trim()}
                >
                  {savingPrompt ? '保存中…' : '保存'}
                </button>
                <button onClick={() => setSaveOpen(false)}>取消</button>
                {savedPrompt && (
                  <Link className={styles.savedLink} to={`/prompts/${savedPrompt.id}`}>
                    已保存「{savedPrompt.title}」，查看 →
                  </Link>
                )}
              </div>
            </div>
          )}
        </section>
      </div>

      {presetManagerOpen && (
        <PresetManager
          presets={presets}
          onClose={() => setPresetManagerOpen(false)}
          onChange={(next) => {
            setPresets(next);
            if (
              conversation &&
              !next.some((p) => p.id === conversation.presetId)
            ) {
              setConversation({ ...conversation, presetId: next[0]?.id ?? 'tags' });
            }
          }}
        />
      )}
    </div>
  );
}
