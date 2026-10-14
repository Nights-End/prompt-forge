import express from 'express';
import { createDb, resolveDataDir } from './db/index.js';
import { PromptRepository } from './db/prompts.js';
import { AssetRepository } from './db/assets.js';
import { ExtDedupeRepository } from './db/extDedupe.js';
import { ConversationRepository } from './db/conversations.js';
import { createPromptsRouter } from './routes/prompts.js';
import { createMetaRouter, createExportRouter, createImportRouter } from './routes/meta.js';
import { createAssetsRouter } from './routes/assets.js';
import { createSettingsRouter } from './routes/settings.js';
import { createLlmRouter } from './routes/llm.js';
import { createWorkshopRouter } from './routes/workshop.js';
import { GenJobRepository } from './db/genJobs.js';
import { createGenRouter } from './i2v/router.js';
import { loadExtConfig } from './ext/config.js';
import { createExtGuard } from './ext/middleware.js';
import { createExtRouter } from './ext/router.js';
import { loadWorkshopConfig } from './workshop/config.js';
import { resolveUploadsDir } from './uploads.js';

export function createApp(deps: { fetchImpl?: typeof fetch } = {}) {
  const app = express();
  const db = createDb();
  const repo = new PromptRepository(db);
  const assetRepo = new AssetRepository(db);
  const extDedupeRepo = new ExtDedupeRepository(db);
  const conversationRepo = new ConversationRepository(db);
  const genJobRepo = new GenJobRepository(db);
  const uploadsDir = resolveUploadsDir();

  // /api/ext boundary config (origin allow-list + token hash) is read once per
  // process; the plaintext token and the config both live in the data dir,
  // which .gitignore keeps out of the public repo.
  const extConfig = loadExtConfig(resolveDataDir());

  app.locals.db = db;
  app.locals.uploadsDir = uploadsDir;

  app.use(express.json({ limit: '20mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  app.use('/api/prompts', createPromptsRouter(repo, assetRepo, uploadsDir, deps));
  app.use('/api/meta', createMetaRouter(repo));
  app.use('/api/export', createExportRouter(repo, assetRepo, uploadsDir));
  app.use('/api/import', createImportRouter(repo, assetRepo, uploadsDir));
  app.use('/api/assets', createAssetsRouter(assetRepo, uploadsDir));
  app.use('/api/settings', createSettingsRouter());
  app.use('/api/llm', createLlmRouter());
  app.use('/api/workshop', createWorkshopRouter(conversationRepo, { workshopConfig: loadWorkshopConfig() }));

  // Image → video line: submit to the local ComfyUI (Wan2.2 GGUF I2V),
  // poll its queue, and collect the finished mp4 back as a video asset.
  app.use('/api/gen', createGenRouter(repo, assetRepo, genJobRepo, uploadsDir));

  // Write-only surface for the SillyTavern extension: loopback-only binding +
  // origin allow-list + shared token, all enforced by extGuard.
  app.use(
    '/api/ext',
    createExtGuard(() => extConfig),
    createExtRouter(repo, assetRepo, extDedupeRepo, uploadsDir),
  );

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
