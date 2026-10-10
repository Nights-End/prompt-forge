import crypto from 'node:crypto';

/** Longest dedupeKey we accept, so a hostile client cannot inflate the ledger. */
export const MAX_DEDUPE_KEY_LENGTH = 200;

/** Prefix marking a key derived from the prompt body rather than supplied. */
export const CONTENT_KEY_PREFIX = 'content:';

/**
 * Content identity is whitespace-insensitive at the edges and treats CRLF and
 * LF as the same text — the same normalisation the one-off import script uses
 * when it dedupes by body, so the two paths agree on what "the same prompt"
 * means.
 */
export function normalizeContent(content: string): string {
  return content.replace(/\r\n?/g, '\n').trim();
}

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function contentHash(content: string): string {
  return sha256Hex(normalizeContent(content));
}

/**
 * The ledger key for a request: the caller's `chat|line|seq` when it supplies
 * one, otherwise a hash of the body. Both are stable across retries, which is
 * what makes the endpoint idempotent.
 */
export function resolveDedupeKey(explicitKey: string, content: string): string {
  return explicitKey || `${CONTENT_KEY_PREFIX}${contentHash(content)}`;
}
