import PromptForm from '../components/PromptForm';
import { formToInput, FormState } from '../types';
import { api } from '../api/client';
import { useNavigate } from 'react-router-dom';
import { useState } from 'react';
import styles from './NewPromptPage.module.css';

export default function NewPromptPage() {
  const navigate = useNavigate();
  const [error, setError] = useState('');

  async function handleSubmit(form: FormState) {
    try {
      const prompt = await api.createPrompt(formToInput(form));
      if (form.files.length > 0) {
        await api.uploadAssets(prompt.id, form.files);
      }
      navigate(`/prompts/${prompt.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create');
    }
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>New Prompt</h1>
      {error && <div className={styles.error}>{error}</div>}
      <PromptForm
        submitLabel="Create"
        onSubmit={handleSubmit}
        onCancel={() => navigate('/')}
      />
    </div>
  );
}
