import { test, beforeAll, afterAll, expect, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../app.js';

// ---- fake ComfyUI -------------------------------------------------------
// A tiny in-process HTTP stand-in: records submissions, serves history
// transitions on demand. The poll loop in the router under test hits it for
// real over loopback HTTP.

type HistoryState = {
  status_str?: string;
  completed?: boolean;
  outputs?: Record<string, { gifs?: { filename: string; subfolder: string }[] }>;
};

const comfy = {
  submitted: [] as { prompt_id: string; graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> }[],
  uploads: [] as string[],
  history: new Map<string, HistoryState>(),
  reachable: true,
  mp4: Buffer.from('fake-mp4-bytes'),
};

function startFakeComfy(): Promise<{ server: Server; url: string; close: () => void }> {
  const http = require('node:http') as typeof import('node:http');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!comfy.reachable) {
      res.statusCode = 503;
      res.end('down');
      return;
    }
    if (url.pathname === '/system_stats') {
      res.end('{}');
      return;
    }
    if (url.pathname === '/upload/image' && req.method === 'POST') {
      comfy.uploads.push(url.searchParams.get('name') ?? '(form)');
      // consume the multipart body
      req.on('data', () => {});
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ name: 'uploaded.png', subfolder: '' }));
      });
      return;
    }
    if (url.pathname === '/prompt' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body) as {
          prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
        };
        const prompt_id = `fake-${comfy.submitted.length + 1}`;
        comfy.submitted.push({ prompt_id, graph: parsed.prompt });
        comfy.history.set(prompt_id, {}); // queued, not yet run
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ prompt_id, number: comfy.submitted.length }));
      });
      return;
    }
    const histMatch = url.pathname.match(/^\/history\/(.+)$/);
    if (histMatch && req.method === 'GET') {
      const id = histMatch[1];
      const entry = comfy.history.get(id);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(entry ? { [id]: entry } : {}));
      return;
    }
    if (url.pathname === '/queue' && req.method === 'GET') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ queue_running: [], queue_pending: comfy.submitted.filter((s) => !comfy.history.get(s.prompt_id)?.completed).map((_, i) => [i]) }));
      return;
    }
    if (url.pathname === '/view') {
      res.setHeader('content-type', 'video/mp4');
      res.end(comfy.mp4);
      return;
    }
    if (url.pathname === '/queue' && req.method === 'POST') {
      res.end('{}');
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
      });
    });
  });
}

let forge: Server;
let forgeBase: string;
let tmpDir: string;
let dbHandle: { close: () => void };
let comfySrv: { url: string; close: () => void };

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-i2v-'));
  process.env.DB_PATH = path.join(tmpDir, 'test.db');
  process.env.ASSET_DIR = path.join(tmpDir, 'uploads');
  process.env.PROVIDER_CONFIG_PATH = path.join(tmpDir, 'provider.json');
  process.env.WORKSHOP_CONFIG_PATH = path.join(tmpDir, 'workshop.json');
  process.env.PROMPTS_CONFIG_PATH = path.join(tmpDir, 'prompts.json');

  comfySrv = await startFakeComfy();
  process.env.COMFY_URL = comfySrv.url;

  const app = createApp();
  dbHandle = (app as { locals: { db: { close: () => void } } }).locals.db;
  forge = app.listen(0);
  await new Promise((resolve) => forge.once('listening', resolve));
  forgeBase = `http://127.0.0.1:${(forge.address() as AddressInfo).port}`;
});

afterAll(async () => {
  forge.close();
  dbHandle.close();
  comfySrv.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function json<T>(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${forgeBase}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? (JSON.parse(text) as T) : (null as T) };
}

async function seedPromptWithImage(): Promise<{ promptId: string; assetId: string }> {
  const created = await json<{ id: string }>('POST', '/api/prompts', {
    title: 'i2v test',
    content: 'A young woman standing in front of a mirror, soft light.',
    category: 'i2v',
  });
  const res = await fetch(`${forgeBase}/api/prompts/${created.data.id}/assets`, {
    method: 'POST',
    // tiny real PNG (1x1)
    body: (() => {
      const form = new FormData();
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      );
      form.append('files', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'a.png');
      return form as unknown as BodyInit;
    })(),
  });
  const assets = (await res.json()) as { id: string }[];
  return { promptId: created.data.id, assetId: assets[0].id };
}

interface JobView {
  id: string;
  status: string;
  error: string | null;
  outputAssetId: string | null;
  sourceAssetId: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 等到 fake comfy 收到第 n 笔提交(0-based)
function waitForSubmit(n: number) {
  return waitFor(async () => (comfy.submitted.length > n ? comfy.submitted[n] : null));
}

async function waitFor(
  pred: () => Promise<JobView | null>,
  timeoutMs = 15_000,
): Promise<JobView | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await pred();
    if (v) return v;
    await sleep(250);
  }
  return null;
}

test('i2v 全链路:提交 → 轮询 → 完成回收入库为 video 资产', async () => {
  const { assetId } = await seedPromptWithImage();

  const start = await json<JobView>('POST', `/api/gen/assets/${assetId}/i2v`);
  expect(start.status).toBe(201);
  expect(start.data.status).toBe('pending');

  // submit happens on the first poll tick
  const submitted = await waitFor(async () => {
    const job = await json<JobView>('GET', `/api/gen/jobs/${start.data.id}`);
    return comfy.submitted.length > 0 ? job.data : null;
  });
  expect(submitted).not.toBeNull();
  expect(comfy.submitted.length).toBe(1);

  // the graph must be the 19-node Wan template with our prompt as the positive
  const graph = comfy.submitted[0].graph;
  expect(Object.keys(graph).length).toBe(19);
  expect(graph['29']?.inputs.text).toContain('young woman');
  expect(graph['23']?.inputs.image).toBeTruthy();

  // finish the job in fake comfy and wait for collection
  const comfyId = comfy.submitted[0].prompt_id;
  comfy.history.set(comfyId, {
    status: { status_str: 'success', completed: true },
    outputs: { '22': { gifs: [{ filename: 'out.mp4', subfolder: 'forge-i2v' }] } },
  });

  const done = await waitFor(async () => {
    const job = await json<JobView>('GET', `/api/gen/jobs/${start.data.id}`);
    return job.data.status === 'success' ? job.data : null;
  });
  expect(done).not.toBeNull();
  expect(done?.outputAssetId).toBeTruthy();

  // video asset exists with kind=video and metadata.i2vOf pointing back
  const promptView = await json<{ id: string; kind: string; metadata: Record<string, unknown> }[]>(
    'GET',
    `/api/prompts/${(await json<{ id: string }>('GET', `/api/gen/jobs/${start.data.id}`)).data ? '' : ''}`,
  ).catch(() => null);
  void promptView; // full check below via job -> prompt assets

  const jobAgain = await json<JobView & { promptId: string }>('GET', `/api/gen/jobs/${start.data.id}`);
  const assets = await json<{ id: string; kind: string; metadata?: Record<string, unknown> }[]>(
    'GET',
    `/api/prompts/${jobAgain.data.promptId}/assets`,
  );
  const video = assets.data.find((a) => a.id === done?.outputAssetId);
  expect(video?.kind).toBe('video');
  expect(video?.metadata?.i2vOf).toBe(assetId);
}, 20_000);

test('重复点击不重复建任务;成功后复用,force=1 才重跑', async () => {
  const { assetId } = await seedPromptWithImage();
  const first = await json<JobView>('POST', `/api/gen/assets/${assetId}/i2v`);
  expect(first.status).toBe(201);
  const second = await json<JobView>('POST', `/api/gen/assets/${assetId}/i2v`);
  expect(second.status).toBe(200);
  expect(second.data.id).toBe(first.data.id);

  // finish it
  await waitForSubmit(1);
  comfy.history.set(comfy.submitted[1].prompt_id, {
    status: { status_str: 'success', completed: true },
    outputs: { '22': { gifs: [{ filename: 'out2.mp4', subfolder: '' }] } },
  });
  await waitFor(async () => {
    const job = await json<JobView>('GET', `/api/gen/jobs/${first.data.id}`);
    return job.data.status === 'success' ? job.data : null;
  });

  // re-click reuses
  const third = await json<JobView & { reused?: boolean }>('POST', `/api/gen/assets/${assetId}/i2v`);
  expect(third.status).toBe(200);
  expect(third.data.id).toBe(first.data.id);
  expect(third.data.reused).toBe(true);
  expect(comfy.submitted.length).toBe(2);

  // force re-runs
  const fourth = await json<JobView>('POST', `/api/gen/assets/${assetId}/i2v?force=1`);
  expect(fourth.status).toBe(201);
  expect(fourth.data.id).not.toBe(first.data.id);
}, 20_000);

test('ComfyUI 不可达 → 503,不建僵尸任务', async () => {
  const { assetId } = await seedPromptWithImage();
  comfy.reachable = false;
  const res = await json<{ error: string }>('POST', `/api/gen/assets/${assetId}/i2v`);
  expect(res.status).toBe(503);
  comfy.reachable = true;
}, 20_000);

test('执行错误 → failed 带原因', async () => {
  const { assetId } = await seedPromptWithImage();
  const start = await json<JobView>('POST', `/api/gen/assets/${assetId}/i2v`);
  await waitForSubmit(3);
  comfy.history.set(comfy.submitted[comfy.submitted.length - 1].prompt_id, {
    status: { status_str: 'error', completed: false },
  });
  const failed = await waitFor(async () => {
    const job = await json<JobView>('GET', `/api/gen/jobs/${start.data.id}`);
    return job.data.status === 'failed' ? job.data : null;
  });
  expect(failed?.error).toBeTruthy();
}, 20_000);

test('取消:pending/running → cancelled(终端态)', async () => {
  const { assetId } = await seedPromptWithImage();
  const start = await json<JobView>('POST', `/api/gen/assets/${assetId}/i2v`);
  // wait for submission so cancel exercises the running path
  await waitForSubmit(4);
  const cancelled = await json<JobView>('DELETE', `/api/gen/jobs/${start.data.id}`);
  expect(cancelled.data.status).toBe('cancelled');
  // poll loop must not resurrect it
  await sleep(6_000);
  const after = await json<JobView>('GET', `/api/gen/jobs/${start.data.id}`);
  expect(after.data.status).toBe('cancelled');
}, 20_000);

test('/gen/status 反映可达性与活跃任务数', async () => {
  const res = await json<{ comfyReachable: boolean; activeJobs: number }>('GET', '/api/gen/status');
  expect(res.status).toBe(200);
  expect(res.data.comfyReachable).toBe(true);
  expect(typeof res.data.activeJobs).toBe('number');
});

// keep the unused-import linter quiet in environments where vi is optional
void vi;
