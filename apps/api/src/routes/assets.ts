import { Router } from 'express';
import fs from 'node:fs';
import type { AssetRepository } from '../db/assets.js';
import { storagePathToFs } from '../uploads.js';

export function createAssetsRouter(
  assetRepo: AssetRepository,
  uploadsDir: string,
): Router {
  const router = Router();

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
