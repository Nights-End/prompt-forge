import PromptForm from '../components/PromptForm';
import { formToInput, FormState, EMPTY_FORM } from '../types';
import { api } from '../api/client';
import { useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import styles from './NewPromptPage.module.css';

export default function NewPromptPage() {
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [initial, setInitial] = useState<FormState | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    api
      .getPromptsSettings()
      .then(({ defaultCategory }) => {
        if (cancelled) return;
        setInitial({
          ...EMPTY_FORM,
          category: defaultCategory.trim(),
        });
      })
      .catch(() => {
        if (!cancelled) setInitial(EMPTY_FORM);
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(form: FormState) {
    try {
      const prompt = await api.createPrompt(formToInput(form));
      if (form.files.length > 0) {
        await api.uploadAssets(prompt.id, form.files);
      }
      navigate(`/prompts/${prompt.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败');
    }
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>新建提示词</h1>
      {error && <div className={styles.error}>{error}</div>}
      {ready ? (
        <PromptForm
          initial={initial}
          submitLabel="创建"
          onSubmit={handleSubmit}
          onCancel={() => navigate('/')}
        />
      ) : (
        <div className={styles.state}>加载中…</div>
      )}
    </div>
  );
}
