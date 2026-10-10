import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_ALLOWED_ORIGINS,
  extConfigPath,
  extTokenPath,
  hashToken,
  loadExtConfig,
  verifyToken,
} from '../config.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pf-ext-config-'));
}

function readConfig(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(extConfigPath(dir), 'utf8')) as Record<
    string,
    unknown
  >;
}

test('first run generates the token file and a config that stores only its hash', () => {
  const dir = tmpDir();
  try {
    const config = loadExtConfig(dir);
    const token = fs.readFileSync(extTokenPath(dir), 'utf8').trim();

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(config.tokenHash).toBe(hashToken(token));
    expect(config.enabled).toBe(true);
    expect(config.allowedOrigins).toEqual(DEFAULT_ALLOWED_ORIGINS);

    const raw = fs.readFileSync(extConfigPath(dir), 'utf8');
    expect(raw).not.toContain(token);
    expect(readConfig(dir).tokenHash).toBe(config.tokenHash);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reloading keeps the same token and does not rewrite the file', () => {
  const dir = tmpDir();
  try {
    const first = loadExtConfig(dir);
    const mtime = fs.statSync(extConfigPath(dir)).mtimeMs;
    const second = loadExtConfig(dir);

    expect(second.tokenHash).toBe(first.tokenHash);
    expect(fs.statSync(extConfigPath(dir)).mtimeMs).toBe(mtime);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a hand-edited origin allow-list is preserved', () => {
  const dir = tmpDir();
  try {
    loadExtConfig(dir);
    const config = readConfig(dir);
    config.allowedOrigins = ['http://localhost:9000'];
    fs.writeFileSync(extConfigPath(dir), JSON.stringify(config));

    expect(loadExtConfig(dir).allowedOrigins).toEqual(['http://localhost:9000']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting the token file rotates it and the stored hash follows', () => {
  const dir = tmpDir();
  try {
    const before = loadExtConfig(dir);
    const oldToken = fs.readFileSync(extTokenPath(dir), 'utf8').trim();

    fs.rmSync(extTokenPath(dir));
    const after = loadExtConfig(dir);
    const newToken = fs.readFileSync(extTokenPath(dir), 'utf8').trim();

    expect(newToken).not.toBe(oldToken);
    expect(after.tokenHash).toBe(hashToken(newToken));
    expect(after.tokenHash).not.toBe(before.tokenHash);
    expect(readConfig(dir).tokenHash).toBe(after.tokenHash);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('enabled:false is honoured', () => {
  const dir = tmpDir();
  try {
    loadExtConfig(dir);
    const config = readConfig(dir);
    config.enabled = false;
    fs.writeFileSync(extConfigPath(dir), JSON.stringify(config));

    expect(loadExtConfig(dir).enabled).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyToken accepts only the exact token string', () => {
  const dir = tmpDir();
  try {
    const config = loadExtConfig(dir);
    const token = fs.readFileSync(extTokenPath(dir), 'utf8').trim();

    expect(verifyToken(config, token)).toBe(true);
    expect(verifyToken(config, `${token}x`)).toBe(false);
    expect(verifyToken(config, token.slice(0, -1))).toBe(false);
    expect(verifyToken(config, '')).toBe(false);
    expect(verifyToken(config, undefined)).toBe(false);
    expect(verifyToken(config, ['token'])).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
