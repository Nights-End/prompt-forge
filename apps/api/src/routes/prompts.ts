import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PromptRepository } from '../db/prompts.js';
import type { AssetRepository } from '../db/assets.js';
import type { AssetKind } from '@prompt-forge/shared';
import {
  clampBatchCount,
  renderTemplate,
  renderTemplateBatch,
} from '@prompt-forge/shared';
import { parsePromptInput } from '../validation.js';
import { storagePathToFs } from '../uploads.js';
import { pickProviderId } from './llm.js';
import { resolveProviderConfigPath } from '../llm/config.js';
import {
  resolveUpstream,
  resolveVisionUpstream,
  tagImages,
  templatizePrompt,
} from '../llm/provider.js';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_RENDER_BATCH_BYTES = 2 * 1024 * 1024;
const TAG_IMAGE_LIMIT = 5;
const TAG_VISION_TIMEOUT_MS = 300_000;
const TEMPLATIZE_TIMEOUT_MS = 120_000;
const TAG_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const TAG_TOTAL_MAX_BYTES = 4 * 1024 * 1024;
const TEMPLATIZE_CONTENT_MAX_CHARS = 8000;

function parsePositiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function kindFromMime(mime: string): AssetKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

export function createPromptsRouter(
  repo: PromptRepository,
  assetRepo: AssetRepository,
  uploadsDir: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Router {
  const router = Router();
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const tmpDir = path.join(uploadsDir, '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, tmpDir),
      filename: (_req, file, cb) =>
        cb(null, `${randomUUID()}${path.extname(file.originalname)}`),
    }),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 20 },
  });

  router.get('/', (req, res) => {
    const favorite =
      req.query.favorite === 'true'
        ? true
        : req.query.favorite === 'false'
          ? false
          : undefined;
    const type = req.query.type === 'multimodal' ? 'multimodal' : req.query.type === 'text' ? 'text' : undefined;
    const prompts = repo.list({
      q: typeof req.query.q === 'string' ? req.query.q : undefined,
      category:
        typeof req.query.category === 'string' ? req.query.category : undefined,
      tag: typeof req.query.tag === 'string' ? req.query.tag : undefined,
      favorite,
      type,
      limit: parsePositiveInt(req.query.limit, 50),
      offset: parsePositiveInt(req.query.offset, 0),
    });
    res.json(prompts);
  });

  router.post('/', (req, res) => {
    const parsed = parsePromptInput(req.body);
    if (!parsed.ok || !parsed.value) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const prompt = repo.create(parsed.value);
    res.status(201).json(prompt);
  });

  router.post('/render', (req, res) => {
    const body = req.body as {
      promptId?: string;
      content?: string;
      values?: Record<string, string>;
      variablePools?: Record<string, string[]>;
      count?: number;
    };

    if (body?.promptId) {
      const prompt = repo.getById(body.promptId);
      if (!prompt) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const assets = assetRepo.listByPrompt(prompt.id).map((a) => ({
        id: a.id,
        url: `/api/assets/${a.id}/file`,
        kind: a.kind,
      }));
      const count = clampBatchCount(body.count);
      if (
        count > 1 &&
        Object.keys(prompt.variablePools).length > 0
      ) {
        if (prompt.content.length * count > MAX_RENDER_BATCH_BYTES) {
          res.status(400).json({
            error: `batch render too large: ${count} x ${prompt.content.length} bytes exceeds ${MAX_RENDER_BATCH_BYTES}`,
          });
          return;
        }
        res.json({
          rendered: renderTemplateBatch(prompt.content, prompt.variablePools, count),
          assets,
        });
        return;
      }
      res.json({
        rendered: renderTemplate(prompt.content, body.values ?? {}),
        assets,
      });
      return;
    }

    if (!body?.content) {
      res.status(400).json({ error: 'promptId or content is required' });
      return;
    }
    res.json({
      rendered: renderTemplate(body.content, body.values ?? {}),
      assets: [],
    });
  });

  router.get('/:id', (req, res) => {
    const prompt = repo.getById(req.params.id);
    if (!prompt) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(prompt);
  });

  router.get('/:id/variables', (req, res) => {
    const prompt = repo.getById(req.params.id);
    if (!prompt) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ variables: prompt.variables });
  });

  router.put('/:id', (req, res) => {
    const parsed = parsePromptInput(req.body);
    if (!parsed.ok || !parsed.value) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const prompt = repo.update(req.params.id, parsed.value);
    if (!prompt) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(prompt);
  });

  router.post('/:id/assets', upload.array('files', 20), (req, res) => {
    const prompt = repo.getById(req.params.id);
    if (!prompt) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      res.status(400).json({ error: 'no files uploaded' });
      return;
    }

    const created = [];
    for (const file of files) {
      const assetId = randomUUID();
      const ext = path.extname(file.originalname).toLowerCase();
      const storagePath = `${prompt.id}/${assetId}${ext}`;
      const dest = storagePathToFs(uploadsDir, storagePath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file.path, dest);
      fs.unlinkSync(file.path);

      created.push(
        assetRepo.create({
          promptId: prompt.id,
          kind: kindFromMime(file.mimetype),
          fileName: file.originalname,
          storagePath,
          metadata: { size: file.size, mimeType: file.mimetype },
        }),
      );
    }
    res.status(201).json(created);
  });

  router.post('/:id/generate-tags', async (req, res) => {
    const prompt = repo.getById(req.params.id);
    if (!prompt) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const imageAssets = assetRepo
      .listByPrompt(prompt.id)
      .filter((a) => a.kind === 'image');
    if (imageAssets.length === 0) {
      res.status(400).json({ error: 'no image assets to analyze' });
      return;
    }

    const vision = resolveVisionUpstream();
    if (!vision.ok) {
      res.status(400).json({ error: vision.error });
      return;
    }

    const urls: string[] = [];
    let totalBytes = 0;
    for (const asset of imageAssets.slice(0, TAG_IMAGE_LIMIT)) {
      const filePath = storagePathToFs(uploadsDir, asset.storagePath);
      if (!fs.existsSync(filePath)) continue;
      const stat = fs.statSync(filePath);
      if (stat.size > TAG_IMAGE_MAX_BYTES) continue;
      if (totalBytes + stat.size > TAG_TOTAL_MAX_BYTES) continue;
      totalBytes += stat.size;
      const mime =
        (asset.metadata?.mimeType as string | undefined) ?? 'image/jpeg';
      urls.push(`data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`);
    }
    if (urls.length === 0) {
      res.status(400).json({
        error: `no usable image assets (each image must be ≤${Math.round(TAG_IMAGE_MAX_BYTES / 1024 / 1024)}MB, total ≤${Math.round(TAG_TOTAL_MAX_BYTES / 1024 / 1024)}MB)`,
      });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TAG_VISION_TIMEOUT_MS);
    try {
      const result = await tagImages(fetchImpl, vision.value, urls, controller.signal);
      if (!result.ok) {
        res.status(502).json({ error: result.error });
        return;
      }

      const existing = new Set(prompt.tags.map((t) => t.trim()).filter(Boolean));
      const merged = [...new Set([...existing, ...result.tags])];
      repo.update(req.params.id, { tags: merged });
      res.json({ tags: merged, added: merged.length - existing.size });
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      res.status(aborted ? 504 : 502).json({
        error: aborted
          ? 'vision request timed out'
          : e instanceof Error
            ? e.message
            : 'vision request failed',
      });
    } finally {
      clearTimeout(timer);
    }
  });

  router.post('/:id/templatize', async (req, res) => {
    const prompt = repo.getById(req.params.id);
    if (!prompt) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (prompt.content.length > TEMPLATIZE_CONTENT_MAX_CHARS) {
      res.status(400).json({
        error: `prompt content must be at most ${TEMPLATIZE_CONTENT_MAX_CHARS} characters to be templatized`,
      });
      return;
    }

    if (!fs.existsSync(resolveProviderConfigPath())) {
      res.status(400).json({
        error: 'no LLM provider configured (set baseUrl and api key in settings)',
      });
      return;
    }
    const providerId = pickProviderId();
    if (!providerId) {
      res.status(400).json({
        error: 'no LLM provider configured (set baseUrl and api key in settings)',
      });
      return;
    }
    const upstream = resolveUpstream(providerId);
    if (!upstream.ok) {
      res.status(400).json({ error: upstream.error });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEMPLATIZE_TIMEOUT_MS);
    try {
      const result = await templatizePrompt(
        fetchImpl,
        upstream.value,
        prompt.content,
        controller.signal,
      );
      if (!result.ok) {
        res.status(502).json({ error: result.error });
        return;
      }
      res.json({ template: result.template, variables: result.variables });
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      res.status(aborted ? 504 : 502).json({
        error: aborted
          ? 'upstream request timed out'
          : e instanceof Error
            ? e.message
            : 'upstream request failed',
      });
    } finally {
      clearTimeout(timer);
    }
  });

  router.get('/:id/assets', (req, res) => {
    const prompt = repo.getById(req.params.id);
    if (!prompt) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(assetRepo.listByPrompt(prompt.id));
  });

  router.put('/:id/assets/order', (req, res) => {
    const prompt = repo.getById(req.params.id);
    if (!prompt) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const orderedIds = req.body?.assetIds;
    if (
      !Array.isArray(orderedIds) ||
      orderedIds.some((id) => typeof id !== 'string')
    ) {
      res.status(400).json({ error: 'assetIds (array of strings) is required' });
      return;
    }
    try {
      res.json(assetRepo.reorder(prompt.id, orderedIds));
    } catch (e) {
      res.status(400).json({
        error: e instanceof Error ? e.message : 'invalid asset order',
      });
    }
  });

  router.delete('/:id/assets/:assetId', (req, res) => {
    const asset = assetRepo.getById(req.params.assetId);
    if (!asset || asset.promptId !== req.params.id) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    assetRepo.delete(asset.id);
    const filePath = storagePathToFs(uploadsDir, asset.storagePath);
    fs.rmSync(filePath, { force: true });
    res.status(204).end();
  });

  router.delete('/:id', (req, res) => {
    const assets = assetRepo.listByPrompt(req.params.id);
    const ok = repo.delete(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    for (const asset of assets) {
      const filePath = storagePathToFs(uploadsDir, asset.storagePath);
      fs.rmSync(filePath, { force: true });
    }
    res.status(204).end();
  });

  return router;
}
