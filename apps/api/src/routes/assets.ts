import { Router } from 'express';
import fs from 'node:fs';
import type { Asset } from '@prompt-forge/shared';
import type { AssetRepository } from '../db/assets.js';
import { storagePathToFs } from '../uploads.js';

export function createAssetsRouter(
  assetRepo: AssetRepository,
  uploadsDir: string,
): Router {
  const router = Router();

  router.get('/by-prompts', (req, res) => {
    const raw = typeof req.query.ids === 'string' ? req.query.ids : '';
    const ids = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      res.json({});
      return;
    }
    const grouped: Record<string, Asset[]> = {};
    for (const asset of assetRepo.listByPrompts(ids)) {
      (grouped[asset.promptId] ??= []).push(asset);
    }
    res.json(grouped);
  });

  router.get('/:assetId/file', (req, res) => {
    const asset = assetRepo.getById(req.params.assetId);
    if (!asset) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const filePath = storagePathToFs(uploadsDir, asset.storagePath);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'file missing' });
      return;
    }
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(filePath);
  });

  return router;
}
