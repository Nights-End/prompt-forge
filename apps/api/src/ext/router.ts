import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AssetKind } from '@prompt-forge/shared';
import type { PromptRepository } from '../db/prompts.js';
import type { AssetRepository } from '../db/assets.js';
import type { ExtDedupeRepository } from '../db/extDedupe.js';
import { parsePromptInput } from '../validation.js';
import { storagePathToFs } from '../uploads.js';
import {
  MAX_DEDUPE_KEY_LENGTH,
  contentHash,
  resolveDedupeKey,
  sha256Hex,
} from './dedupe.js';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 20;
const TITLE_HEAD = 40;
/** Marks assets written by this surface so they can be found (and cleaned) later. */
const SOURCE = 'st-ext';

interface ExtMeta {
  dedupeKey?: unknown;
  content?: unknown;
  title?: unknown;
  category?: unknown;
  tags?: unknown;
  genParams?: unknown;
  source?: unknown;
}

function kindFromMime(mime: string): AssetKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

/**
 * Attaches images to a prompt, skipping any whose bytes are already attached
 * under that prompt. Never throws: the prompt row is the deliverable and an
 * image that cannot be stored is reportable, not fatal.
 */
function attachImages(
  promptId: string,
  files: Express.Multer.File[],
  assetRepo: AssetRepository,
  uploadsDir: string,
): { assetsAdded: number; assetsSkipped: number; warnings?: string[] } {
  const seen = new Set<string>();
  for (const asset of assetRepo.listByPrompt(promptId)) {
    const hash = asset.metadata?.imageHash;
    if (typeof hash === 'string') seen.add(hash);
  }

  const warnings: string[] = [];
  let added = 0;
  let skipped = 0;

  for (const file of files) {
    try {
      const imageHash = sha256Hex(fs.readFileSync(file.path));
      if (seen.has(imageHash)) {
        skipped += 1;
        continue;
      }
      const assetId = randomUUID();
      const ext = path.extname(file.originalname).toLowerCase();
      const storagePath = `${promptId}/${assetId}${ext}`;
      const dest = storagePathToFs(uploadsDir, storagePath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file.path, dest);

      assetRepo.create({
        promptId,
        kind: kindFromMime(file.mimetype),
        fileName: file.originalname,
        storagePath,
        metadata: {
          size: file.size,
          mimeType: file.mimetype,
          imageHash,
          source: SOURCE,
        },
      });
      seen.add(imageHash);
      added += 1;
    } catch (e) {
      skipped += 1;
      warnings.push(e instanceof Error ? e.message : String(e));
    }
  }

  return warnings.length > 0
    ? { assetsAdded: added, assetsSkipped: skipped, warnings }
    : { assetsAdded: added, assetsSkipped: skipped };
}

/**
 * POST /api/ext/prompts — one request carries the prompt and, optionally, the
 * images generated from it.
 *
 * Idempotency: the request resolves to a ledger key (caller's `chat|line|seq`
 * when supplied, otherwise a hash of the body). A key that is already recorded
 * reuses that prompt; only new images are attached. The handler is fully
 * synchronous, so the lookup and the write cannot interleave with another
 * request — no transaction is needed to keep the ledger honest.
 */
export function createExtRouter(
  repo: PromptRepository,
  assetRepo: AssetRepository,
  dedupeRepo: ExtDedupeRepository,
  uploadsDir: string,
): Router {
  const router = Router();
  const tmpDir = path.join(uploadsDir, '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, tmpDir),
      filename: (_req, file, cb) =>
        cb(null, `${randomUUID()}${path.extname(file.originalname)}`),
    }),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_FILES },
  });

  router.post('/prompts', upload.array('images', MAX_FILES), (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    try {
      const rawMeta = (req.body as { meta?: unknown } | undefined)?.meta;
      if (typeof rawMeta !== 'string' || !rawMeta.trim()) {
        res.status(400).json({ error: 'meta (a JSON string) is required' });
        return;
      }

      let meta: ExtMeta;
      try {
        meta = JSON.parse(rawMeta) as ExtMeta;
      } catch {
        res.status(400).json({ error: 'meta is not valid JSON' });
        return;
      }
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
        res.status(400).json({ error: 'meta must be a JSON object' });
        return;
      }

      const content = typeof meta.content === 'string' ? meta.content : '';
      if (!content.trim()) {
        res.status(400).json({ error: 'meta.content is required' });
        return;
      }

      const explicitKey =
        typeof meta.dedupeKey === 'string' ? meta.dedupeKey.trim() : '';
      if (explicitKey.length > MAX_DEDUPE_KEY_LENGTH) {
        res.status(400).json({
          error: `meta.dedupeKey must be at most ${MAX_DEDUPE_KEY_LENGTH} characters`,
        });
        return;
      }

      const dedupeKey = resolveDedupeKey(explicitKey, content);
      const hash = contentHash(content);

      const recorded = dedupeRepo.getByKey(dedupeKey);
      const existingPrompt = recorded ? repo.getById(recorded.promptId) : null;

      if (recorded && existingPrompt) {
        // Same key, different body: the caller's key no longer identifies the
        // same prompt (edited chat, shifted line numbers). Refuse rather than
        // silently graft unrelated content onto the original entry.
        if (recorded.contentHash !== hash) {
          res.status(409).json({
            error: 'dedupeKey already used with different content',
            promptId: recorded.promptId,
          });
          return;
        }
        const attached = attachImages(
          existingPrompt.id,
          files,
          assetRepo,
          uploadsDir,
        );
        res.status(200).json({ status: 'deduped', prompt: existingPrompt, ...attached });
        return;
      }

      const parsed = parsePromptInput({
        title:
          typeof meta.title === 'string' && meta.title.trim()
            ? meta.title
            : content.trim().slice(0, TITLE_HEAD),
        content,
        category: typeof meta.category === 'string' ? meta.category : undefined,
        tags: Array.isArray(meta.tags) ? meta.tags : undefined,
        type: files.length > 0 ? 'multimodal' : 'text',
        parameters: meta.genParams,
      });
      if (!parsed.ok || !parsed.value) {
        res.status(400).json({ error: parsed.error ?? 'invalid meta' });
        return;
      }

      const prompt = repo.create(parsed.value);
      if (!recorded) {
        dedupeRepo.insert({
          dedupeKey,
          contentHash: hash,
          promptId: prompt.id,
          createdAt: new Date().toISOString(),
        });
      }

      const attached = attachImages(prompt.id, files, assetRepo, uploadsDir);
      res.status(201).json({ status: 'created', prompt, ...attached });
    } finally {
      // Multer already wrote the uploads to disk; they are scratch copies.
      for (const file of files) fs.rmSync(file.path, { force: true });
    }
  });

  return router;
}
