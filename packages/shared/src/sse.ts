export interface SseStream {
  getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> };
}

/**
 * Iterates SSE frames, yielding the payload of every `data:` line.
 * Handles both `\n` and `\r\n` line endings and skips blank/comment lines.
 * When `maxBufferChars` is set and a single frame exceeds it, throws an Error.
 */
export async function* parseSseStream(
  stream: SseStream,
  maxBufferChars = 0,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (maxBufferChars > 0 && buffer.length > maxBufferChars) {
      throw new Error('stream frame too large');
    }
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data) yield data;
      }
    }
  }
}
