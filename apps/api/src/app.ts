import express from 'express';
import { createDb } from './db/index.js';
import { PromptRepository } from './db/prompts.js';
import { AssetRepository } from './db/assets.js';
import { createPromptsRouter } from './routes/prompts.js';
import { createMetaRouter, createExportRouter, createImportRouter } from './routes/meta.js';
import { createAssetsRouter } from './routes/assets.js';
import { createSettingsRouter } from './routes/settings.js';
import { createLlmRouter } from './routes/llm.js';
import { resolveUploadsDir } from './uploads.js';

export function createApp() {
  const app = express();
  const db = createDb();
  const repo = new PromptRepository(db);
  const assetRepo = new AssetRepository(db);
  const uploadsDir = resolveUploadsDir();

  app.locals.db = db;
  app.locals.uploadsDir = uploadsDir;

  app.use(express.json({ limit: '10mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  app.use('/api/prompts', createPromptsRouter(repo, assetRepo, uploadsDir));
  app.use('/api/meta', createMetaRouter(repo));
  app.use('/api/export', createExportRouter(repo, assetRepo, uploadsDir));
  app.use('/api/import', createImportRouter(repo, assetRepo, uploadsDir));
  app.use('/api/assets', createAssetsRouter(assetRepo, uploadsDir));
  app.use('/api/settings', createSettingsRouter());
  app.use('/api/llm', createLlmRouter());

  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  // Multer/JSON parse errors -> JSON instead of HTML
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (res.headersSent) {
        next(err);
        return;
      }
      const status =
        err instanceof Error && err.name === 'MulterError' ? 400 : 500;
      res.status(status).json({
        error: err instanceof Error ? err.message : 'internal error',
      });
    },
  );

  return app;
}
