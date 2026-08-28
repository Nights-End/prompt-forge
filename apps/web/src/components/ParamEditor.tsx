import { useEffect, useState } from 'react';
import type { PromptParameters } from '@prompt-forge/shared';
import styles from './ParamEditor.module.css';

const FIXED_PARAM_KEYS = [
  'model',
  'steps',
  'sampler',
  'cfg',
  'seed',
  'resolution',
  'negativePrompt',
] as const;

const PARAM_LABELS: Record<string, string> = {
  model: '模型',
  steps: '步数',
  sampler: '采样器',
  cfg: 'CFG',
  seed: '种子',
  resolution: '分辨率',
  negativePrompt: '负面提示词',
};

const PARAM_PLACEHOLDERS: Record<string, string> = {
  model: 'SDXL / Flux...',
  steps: '30',
  sampler: 'DPM++ 2M Karras',
  cfg: '7',
  seed: '随机种子',
  resolution: '1024x1024',
};

interface Props {
  value: PromptParameters;
  onChange: (next: PromptParameters) => void;
  defaultOpen?: boolean;
}

function CustomParamRow({
  name,
  value,
  onValueChange,
  onRename,
  onRemove,
}: {
  name: string;
  value: string;
  onValueChange: (v: string) => void;
  onRename: (newKey: string) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(name);

  useEffect(() => {
    setDraft(name);
  }, [name]);

  function commit() {
    const t = draft.trim();
    if (t && t !== name) {
      onRename(t);
    } else if (!t) {
      onRemove();
    } else {
      setDraft(name);
    }
  }

  return (
    <div className={styles.paramCustomRow}>
      <input
        type="text"
        className={styles.paramCustomKey}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        placeholder="参数名"
      />
      <input
        type="text"
        className={styles.paramCustomVal}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        placeholder="值"
      />
      <button type="button" className={styles.paramRemove} onClick={onRemove}>
        ✕
      </button>
    </div>
  );
}

export default function ParamEditor({ value, onChange, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);

  function setParam(key: string, raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) {
      const next = { ...value };
      delete next[key];
      onChange(next);
      return;
    }
    onChange({ ...value, [key]: trimmed });
  }

  function removeCustomParam(key: string) {
    const next = { ...value };
    delete next[key];
    onChange(next);
  }

  function addCustomParam() {
    let i = 0;
    let key = 'custom1';
    while (key in value) key = `custom${++i}`;
    onChange({ ...value, [key]: '' });
  }

  return (
    <div className={styles.paramSection}>
      <button
        type="button"
        className={styles.paramToggle}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? '收起生成参数' : '生成参数 ▸'}
      </button>
      {open && (
        <div className={styles.paramBody}>
          <div className={styles.paramGrid}>
            {FIXED_PARAM_KEYS.map((key) => (
              <label key={key} className={styles.paramField}>
                <span>{PARAM_LABELS[key] ?? key}</span>
                {key === 'negativePrompt' ? (
                  <textarea
                    rows={2}
                    value={value[key] ?? ''}
                    onChange={(e) => setParam(key, e.target.value)}
                    placeholder="负面提示词（可选）"
                  />
                ) : (
                  <input
                    type="text"
                    value={value[key] ?? ''}
                    onChange={(e) => setParam(key, e.target.value)}
                    placeholder={PARAM_PLACEHOLDERS[key] ?? ''}
                  />
                )}
              </label>
            ))}
          </div>
          <div className={styles.paramCustoms}>
            {Object.keys(value)
              .filter((k) => !(FIXED_PARAM_KEYS as readonly string[]).includes(k))
              .map((key) => (
                <CustomParamRow
                  key={key}
                  name={key}
                  value={value[key] ?? ''}
                  onValueChange={(v) => setParam(key, v)}
                  onRename={(newKey) => {
                    const next = { ...value };
                    const v = value[key] ?? '';
                    delete next[key];
                    next[newKey] = v;
                    onChange(next);
                  }}
                  onRemove={() => removeCustomParam(key)}
                />
              ))}
            <button type="button" className={styles.paramAdd} onClick={addCustomParam}>
              + 自定义参数
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
