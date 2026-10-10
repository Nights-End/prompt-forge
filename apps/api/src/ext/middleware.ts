import type { NextFunction, Request, Response } from 'express';
import { verifyToken, type ExtConfig } from './config.js';

const ALLOWED_METHODS = 'POST, OPTIONS';
const ALLOWED_HEADERS = 'X-Forge-Token, Content-Type';
const PREFLIGHT_MAX_AGE = '86400';

/**
 * Boundary guard for /api/ext. The network boundary (loopback-only binding)
 * lives in index.ts; this adds the browser-facing ones: origin allow-list and
 * the shared token.
 *
 * Every rejection is the same opaque 403, so probing cannot tell "wrong
 * origin" from "wrong token" — and a disallowed origin gets no CORS headers,
 * so the browser cannot read the answer either way.
 */
export function createExtGuard(getConfig: () => ExtConfig) {
  return function extGuard(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const config = getConfig();

    if (!config.enabled) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !config.allowedOrigins.includes(origin)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
    res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
    res.setHeader('Access-Control-Max-Age', PREFLIGHT_MAX_AGE);

    // Preflight never carries the custom header (browsers strip it), so it is
    // answered before the token check — otherwise every real call would fail
    // at the preflight stage.
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    if (!verifyToken(config, req.headers['x-forge-token'])) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    next();
  };
}
