import { Router } from 'express';

/**
 * /api/ext — the write-only surface the SillyTavern extension talks to.
 *
 * PR1 wires the route and its guard only; the ingest endpoint itself lands in
 * PR2. Until then every request that clears the guard gets a 501, which is
 * exactly what the guard tests assert.
 */
export function createExtRouter(): Router {
  const router = Router();

  router.use((_req, res) => {
    res.status(501).json({ error: 'not implemented' });
  });

  return router;
}
