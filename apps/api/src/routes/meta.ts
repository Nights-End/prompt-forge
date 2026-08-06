import { Router } from 'express';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import AdmZip from 'adm-zip';
import type { PromptRepository } from '../db/prompts.js';
import type { AssetRepository } from '../db/assets.js';
import type { Asset, AssetKind, Prompt } from '@prompt-forge/shared';
import { parsePromptInput } from '../validation.js';
import { storagePathToFs } from '../uploads.js';

const SAFE_STORAGE_PATH = /^[a-zA-Z0-9._/-]+$/;

interface ExportManifest {
  app: string;
  version: number;
  exportedAt: string;
  prompts: Prompt[];
  assets: Asset[];
}

export function createMetaRouter(repo: PromptRepository): Router {
  const router = Router();

  router.get('/categories', (_req, res) => {
    res.json(repo.categories());
  });

  return router;
}

export function createExportRouter(
  repo: PromptRepository,
  assetRepo: AssetRepository,
  uploadsDir: string,
): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const prompts = repo.list({});
    const assets = assetRepo.listByPrompts(prompts.map((p) => p.id));

    if (req.query.format === 'json') {
      res.json({ app: 'prompt-forge', version: 2, exportedAt: new Date().toISOString(), prompts });
      return;
    }

    const manifest: ExportManifest = {
      app: 'prompt-forge',
      version: 2,
      exportedAt: new Date().toISOString(),
      prompts,
      assets,
    };
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    for (const asset of assets) {
      const filePath = storagePathToFs(uploadsDir, asset.storagePath);
      if (!fs.existsSync(filePath)) continue;
      zip.addFile(asset.storagePath, fs.readFileSync(filePath));
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="prompt-forge-export.zip"',
    );
    res.send(zip.toBuffer());
  });

  return router;
}

export function createImportRouter(
  repo: PromptRepository,
  assetRepo: AssetRepository,
  uploadsDir: string,
): Router {
  const router = Router();
  router.use(
    express.raw({ type: ['application/zip', 'application/octet-stream'], limit: '500mb' }),
  );

  function importZip(zipBuffer: Buffer): { imported: number; skipped: number; assets: number } {
    let zip: AdmZip;
    try {
      zip = new AdmZip(zipBuffer);
    } catch {
      throw new Error('invalid archive');
    }
    const manifestEntry = zip.getEntry('manifest.json');
    if (!manifestEntry) {
      throw new Error('invalid archive: manifest.json missing');
    }
    const manifest = JSON.parse(manifestEntry.getData().toString('utf8')) as ExportManifest;
    if (!Array.isArray(manifest.prompts)) {
      throw new Error('invalid archive: manifest.prompts missing');
    }
    const manifestAssets = Array.isArray(manifest.assets) ? manifest.assets : [];

    let imported = 0;
    let skipped = 0;
    let assets = 0;

    for (const p of manifest.prompts) {
      const parsed = parsePromptInput(p);
      if (!parsed.ok || !parsed.value) {
        skipped++;
        continue;
      }
      const created = repo.create(parsed.value);
      imported++;

      for (const asset of manifestAssets) {
        if (asset.promptId !== p.id) continue;
        if (!SAFE_STORAGE_PATH.test(asset.storagePath)) {
          skipped++;
          continue;
        }
        const entry = zip.getEntry(asset.storagePath);
        if (!entry) {
          skipped++;
          continue;
        }
        const newAssetId = randomUUID();
        const newStoragePath = `${created.id}/${newAssetId}${path.extname(asset.storagePath)}`;
        const dest = storagePathToFs(uploadsDir, newStoragePath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, entry.getData());
        assetRepo.create({
          promptId: created.id,
          kind: asset.kind as AssetKind,
          fileName: asset.fileName,
          storagePath: newStoragePath,
          metadata: asset.metadata,
          sortOrder: asset.sortOrder,
        });
        assets++;
      }
    }

    return { imported, skipped, assets };
  }

  router.post('/', (req, res) => {
    if (Buffer.isBuffer(req.body)) {
      try {
        const result = importZip(req.body);
        res.status(201).json(result);
      } catch (e) {
        res.status(400).json({ error: e instanceof Error ? e.message : 'invalid archive' });
      }
      return;
    }

    const body = req.body as { prompts?: unknown } | unknown[] | null;
    const rawPrompts = Array.isArray(body)
      ? (body as unknown[])
      : Array.isArray((body as { prompts?: unknown })?.prompts)
        ? ((body as { prompts: unknown[] }).prompts)
        : [];
    const imported: Prompt[] = [];
    let skipped = 0;

    for (const p of rawPrompts) {
      const parsed = parsePromptInput(p);
      if (!parsed.ok || !parsed.value) {
        skipped++;
        continue;
      }
      imported.push(repo.create(parsed.value));
    }

    res.status(201).json({ imported: imported.length, skipped });
  });

  return router;
}
