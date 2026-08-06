import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from './db/index.js';

export function resolveUploadsDir(): string {
  const env = process.env.ASSET_DIR;
  if (env) return path.resolve(env);
  const dir = path.join(resolveDataDir(), 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// storagePath is server-generated as "promptId/assetId.ext" (forward slashes,
// ZIP-safe). Convert to a filesystem path, guarding against traversal.
export function storagePathToFs(uploadsDir: string, storagePath: string): string {
  const resolved = path.resolve(uploadsDir, ...storagePath.split('/'));
  const root = path.resolve(uploadsDir) + path.sep;
  if (!resolved.startsWith(root)) {
    throw new Error('invalid storage path');
  }
  return resolved;
}
