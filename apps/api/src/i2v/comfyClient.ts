import type { ComfyPromptGraph } from './template.js';

export interface ComfySubmitResult {
  promptId: string;
  number: number;
}

export interface ComfyHistoryEntry {
  status?: { status_str?: string; completed?: boolean };
  outputs?: Record<
    string,
    { gifs?: { filename: string; subfolder: string; type: string }[] }
  >;
}

// Minimal ComfyUI HTTP client. All state stays in ComfyUI itself — we only
// submit, look up history, and download outputs.
export class ComfyClient {
  constructor(
    private baseUrl: string,
    private fetchImpl: typeof fetch = globalThis.fetch,
    private timeoutMs = 10_000,
  ) {}

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`ComfyUI ${path} -> ${res.status}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async ping(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_000);
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/system_stats`, {
          signal: controller.signal,
        });
        return res.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  async uploadImage(fileName: string, bytes: Uint8Array, mime: string): Promise<{ name: string; subfolder: string }> {
    const form = new FormData();
    // Cast: undici's Blob accepts Uint8Array directly; TS lib types are narrower.
    const blobPart = bytes as unknown as ArrayBuffer;
    form.append('image', new Blob([blobPart], { type: mime }), fileName);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/upload/image`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`upload failed (${res.status})`);
      return (await res.json()) as { name: string; subfolder: string };
    } finally {
      clearTimeout(timer);
    }
  }

  async submit(graph: ComfyPromptGraph): Promise<ComfySubmitResult> {
    const body = JSON.stringify({ prompt: graph, client_id: 'prompt-forge' });
    const out = await this.req<{ prompt_id: string; number: number }>('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return { promptId: out.prompt_id, number: out.number };
  }

  async history(promptId: string): Promise<ComfyHistoryEntry | null> {
    const all = await this.req<Record<string, ComfyHistoryEntry>>(
      `/history/${promptId}`,
    );
    return all[promptId] ?? null;
  }

  async queue(): Promise<{ running: number; pending: number }> {
    const q = await this.req<{
      queue_running: unknown[];
      queue_pending: unknown[];
    }>('/queue');
    return { running: q.queue_running.length, pending: q.queue_pending.length };
  }

  async fetchOutput(
    subfolder: string,
    fileName: string,
  ): Promise<{ bytes: Uint8Array; mime: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const q = new URLSearchParams({
        filename: fileName,
        subfolder,
        type: 'output',
      });
      const res = await this.fetchImpl(
        `${this.baseUrl}/view?${q.toString()}`,
        { signal: controller.signal },
      );
      if (!res.ok) throw new Error(`view failed (${res.status})`);
      // Fully materialise the body: writeFile of a bare undici buffer view
      // can write 0 bytes if the ArrayBuffer is detached or a stream ref.
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length === 0) throw new Error('empty video payload');
      const mime = res.headers.get('content-type') ?? 'video/mp4';
      return { bytes: buf, mime };
    } finally {
      clearTimeout(timer);
    }
  }

  async interrupt(promptId: string): Promise<void> {
    // ComfyUI has no per-prompt delete by id in older builds; use the queue
    // delete API with the running prompt id, ignore failures (best effort).
    try {
      await this.req('/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clear: true, delete: [promptId] }),
      });
    } catch {
      // best effort
    }
  }
}
