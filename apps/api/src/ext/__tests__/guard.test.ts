import { test, beforeAll, afterAll, expect } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../app.js';
import { extTokenPath } from '../config.js';

const ALLOWED = 'http://localhost:8000';
const DISALLOWED = 'http://evil.example';

let server: Server;
let base: string;
let tmpDir: string;
let token: string;
let db: { close: () => void };

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-ext-guard-'));
  process.env.DB_PATH = path.join(tmpDir, 'test.db');
  process.env.ASSET_DIR = path.join(tmpDir, 'uploads');

  const app = createApp();
  db = (app as { locals: { db: { close: () => void } } }).locals.db;
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  token = fs.readFileSync(extTokenPath(tmpDir), 'utf8').trim();
});

afterAll(async () => {
  server.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function call(
  method: string,
  url: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}${url}`, { method, headers });
}

async function preflight(origin: string | null): Promise<Response> {
  const headers: Record<string, string> = {
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'x-forge-token',
  };
  if (origin) headers.Origin = origin;
  return call('OPTIONS', '/api/ext/prompts', headers);
}

test('preflight from the allowed origin returns 204 with CORS headers echoing that origin', async () => {
  const res = await preflight(ALLOWED);
  expect(res.status).toBe(204);
  expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
  expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
    'x-forge-token',
  );
  expect(res.headers.get('access-control-max-age')).toBe('86400');
  expect(res.headers.get('vary')).toContain('Origin');
});

test('preflight from a disallowed origin is rejected without CORS headers', async () => {
  const res = await preflight(DISALLOWED);
  expect(res.status).toBe(403);
  expect(res.headers.get('access-control-allow-origin')).toBeNull();
});

test('preflight without an origin is rejected', async () => {
  const res = await preflight(null);
  expect(res.status).toBe(403);
});

test('a real request without a token is rejected', async () => {
  const res = await call('POST', '/api/ext/prompts', { Origin: ALLOWED });
  expect(res.status).toBe(403);
});

test('a real request with a wrong token is rejected', async () => {
  const res = await call('POST', '/api/ext/prompts', {
    Origin: ALLOWED,
    'X-Forge-Token': `${token}deadbeef`,
  });
  expect(res.status).toBe(403);
});

test('a real request with the right token clears the guard (placeholder 501)', async () => {
  const res = await call('POST', '/api/ext/prompts', {
    Origin: ALLOWED,
    'X-Forge-Token': token,
  });
  expect(res.status).toBe(501);
  expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
});

test('the guard does not leak onto other routes', async () => {
  const health = await call('GET', '/api/health', { Origin: DISALLOWED });
  expect(health.status).toBe(200);

  const prompts = await call('GET', '/api/prompts', { Origin: DISALLOWED });
  expect(prompts.status).toBe(200);
});
