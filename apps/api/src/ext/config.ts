import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface ExtConfig {
  /** Master switch; when false the whole /api/ext surface answers 404. */
  enabled: boolean;
  /** Browser origins allowed to call /api/ext. */
  allowedOrigins: string[];
  /** sha256:<hex> of the shared token — the plaintext never lives here. */
  tokenHash: string;
}

export const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];

export function extConfigPath(dataDir: string): string {
  return path.join(dataDir, 'ext.json');
}

export function extTokenPath(dataDir: string): string {
  return path.join(dataDir, 'ext-token.txt');
}

export function hashToken(token: string): string {
  return `sha256:${crypto.createHash('sha256').update(token, 'utf8').digest('hex')}`;
}

function readTokenFile(file: string): string | null {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Loads (and on first run creates) the /api/ext boundary config from the data
 * dir. The plaintext token is generated here and kept in ext-token.txt; only
 * its hash is written to ext.json. Deleting ext-token.txt and restarting
 * rotates the token (the hash in ext.json follows on the next load).
 */
export function loadExtConfig(dataDir: string): ExtConfig {
  fs.mkdirSync(dataDir, { recursive: true });

  const tokenFile = extTokenPath(dataDir);
  let token = readTokenFile(tokenFile);
  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  }
  const tokenHash = hashToken(token);

  const configFile = extConfigPath(dataDir);
  let stored: Partial<ExtConfig> = {};
  let readable = true;
  try {
    stored = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Partial<ExtConfig>;
  } catch {
    readable = false;
  }

  const allowedOrigins =
    Array.isArray(stored.allowedOrigins) && stored.allowedOrigins.length > 0
      ? stored.allowedOrigins.filter((o): o is string => typeof o === 'string')
      : [...DEFAULT_ALLOWED_ORIGINS];

  const config: ExtConfig = {
    enabled: stored.enabled !== false,
    allowedOrigins,
    tokenHash,
  };

  // Persist on first run, whenever the token was rotated (hash drift), or when
  // the existing file is missing/unreadable — so ext.json always matches the
  // live token. A hand-edited allowedOrigins list is otherwise left alone.
  const needsWrite =
    !readable ||
    stored.tokenHash !== tokenHash ||
    !Array.isArray(stored.allowedOrigins);
  if (needsWrite) {
    fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  }

  return config;
}

/** Constant-time comparison of a presented token against the stored hash. */
export function verifyToken(config: ExtConfig, presented: unknown): boolean {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const a = Buffer.from(hashToken(presented), 'utf8');
  const b = Buffer.from(config.tokenHash, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
