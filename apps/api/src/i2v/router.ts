import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { PromptRepository } from '../db/prompts.js';
import type { AssetRepository } from '../db/assets.js';
import type { GenJobRepository, GenJob } from '../db/genJobs.js';
import { ComfyClient } from './comfyClient.js';
import {
  buildI2vGraph,
  POLL_INTERVAL_MS,
  STALE_PENDING_MS,
  MAX_ACTIVE_JOBS,
} from './template.js';
import { storagePathToFs } from '../uploads.js';

export interface GenJobView {
  id: string;
  promptId: string;
  sourceAssetId: string;
  status: GenJob['status'];
  error: string | null;
  outputAssetId: string | null;
  createdAt: string;
  updatedAt: string;
  /** 队列信息(有 ComfyUI 时) */
  queue?: { running: number; pending: number };
}

function toView(job: GenJob, queue?: { running: number; pending: number }): GenJobView {
  return {
    id: job.id,
    promptId: job.promptId,
    sourceAssetId: job.sourceAssetId,
    status: job.status,
    error: job.error,
    outputAssetId: job.outputAssetId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    queue,
  };
}

export function createGenRouter(
  repo: PromptRepository,
  assetRepo: AssetRepository,
  jobRepo: GenJobRepository,
  uploadsDir: string,
): Router {
  const router = Router();
  const comfy = new ComfyClient(process.env.COMFY_URL ?? 'http://127.0.0.1:8188');

  // ---- poll loop -------------------------------------------------------
  // One interval for the whole process. Each tick advances every active job.
  let pollStarted = false;
  function ensurePolling() {
    if (pollStarted) return;
    pollStarted = true;
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    timer.unref?.();
  }

  async function tick() {
    for (const job of jobRepo.listActive()) {
      try {
        await advance(job);
      } catch (e) {
        // Network error while ComfyUI is briefly down must not kill jobs:
        // only long-missing jobs are failed by the stale check below.
        console.error('[i2v] tick error:', e instanceof Error ? e.message : e);
        jobRepo.update(job.id, {
          status: 'pending',
          error: e instanceof Error ? e.message : 'comfy unreachable',
        });
      }
    }
  }

  async function advance(job: GenJob) {
    if (!job.comfyPromptId) {
      // Not yet submitted — submit now (covers both fresh jobs and jobs that
      // survived a restart without ever reaching ComfyUI).
      await submitJob(job);
      return;
    }
    const entry = await comfy.history(job.comfyPromptId);
    if (!entry) {
      maybeStale(job);
      return;
    }
    const statusStr = entry.status?.status_str ?? '';
    if (statusStr === 'error') {
      jobRepo.update(job.id, { status: 'failed', error: 'ComfyUI execution error' });
      return;
    }
    if (!entry.status?.completed) return; // still queued/running
    // Success: collect the mp4 from the first node with a gif/video output.
    for (const output of Object.values(entry.outputs ?? {})) {
      const gif = output.gifs?.[0];
      if (!gif) continue;
      const { bytes, mime } = await comfy.fetchOutput(gif.subfolder, gif.filename);
      const asset = await persistVideo(job, gif.filename, bytes, mime);
      jobRepo.update(job.id, { status: 'success', outputAssetId: asset.id, error: null });
      return;
    }
    // Completed but no video output — treat as failure with a clear reason.
    jobRepo.update(job.id, { status: 'failed', error: 'no video output' });
  }

  function maybeStale(job: GenJob) {
    const age = Date.now() - Date.parse(job.createdAt);
    if (age > STALE_PENDING_MS) {
      jobRepo.update(job.id, {
        status: 'failed',
        error: 'ComfyUI has no record of this job (restarted?)',
      });
    }
  }

  async function submitJob(job: GenJob) {
    const prompt = repo.getById(job.promptId);
    const asset = assetRepo.getById(job.sourceAssetId);
    if (!prompt || !asset || asset.promptId !== prompt.id) {
      jobRepo.update(job.id, { status: 'failed', error: 'source prompt or asset missing' });
      return;
    }
    const src = storagePathToFs(uploadsDir, asset.storagePath);
    if (!fs.existsSync(src)) {
      jobRepo.update(job.id, { status: 'failed', error: 'source image file missing' });
      return;
    }
    // Upload the first frame under a stable, collision-free name.
    const ext = normalizeExt(path.extname(asset.fileName));
    const comfyName = `forge-${asset.id}${ext}`;
    const uploaded = await comfy.uploadImage(
      comfyName,
      new Uint8Array(fs.readFileSync(src)),
      (asset.metadata?.mimeType as string | undefined) ?? guessMime(ext),
    );
    const seed = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
    const graph = buildI2vGraph({
      image: uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name,
      prompt: prompt.content,
      seed: Number(seed % 2305843009213693951n), // < 2^53
      prefix: `forge-i2v/${job.id.slice(0, 8)}`,
    });
    const submitted = await comfy.submit(graph);
    jobRepo.update(job.id, { comfyPromptId: submitted.promptId, status: 'running' });
  }

  async function persistVideo(
    job: GenJob,
    fileName: string,
    bytes: Uint8Array,
    mime: string,
  ) {
    const assetId = randomUUID();
    const storagePath = `${job.promptId}/${assetId}.mp4`;
    const dest = storagePathToFs(uploadsDir, storagePath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
    return assetRepo.create({
      promptId: job.promptId,
      kind: 'video',
      fileName: fileName.replace(/\.[^.]*$/, '') + '.mp4',
      storagePath,
      metadata: {
        size: bytes.length,
        mimeType: mime.startsWith('video/') ? mime : 'video/mp4',
        i2vOf: job.sourceAssetId,
      },
    });
  }

  // Startup reconciliation: a job that references a ComfyUI run that no longer
  // exists (ComfyUI restarted and its history is gone) is failed after a grace
  // period; a job that was never submitted is picked up by the poll loop.
  function reconcile() {
    for (const job of jobRepo.listActive()) {
      if (job.comfyPromptId) maybeStale(job);
    }
  }
  reconcile();

  // ---- routes ----------------------------------------------------------

  router.get('/status', async (_req, res) => {
    const reachable = await comfy.ping();
    const queue = reachable ? await comfy.queue().catch(() => undefined) : undefined;
    res.json({ comfyReachable: reachable, activeJobs: jobRepo.listActive().length, queue });
  });

  router.get('/jobs', (req, res) => {
    if (typeof req.query.assetId === 'string' && req.query.assetId) {
      res.json(jobRepo.listByAsset(req.query.assetId).map((j) => toView(j)));
      return;
    }
    res.json(jobRepo.listRecent().map((j) => toView(j)));
  });

  router.get('/jobs/:id', async (req, res) => {
    const job = jobRepo.getById(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    let queue: { running: number; pending: number } | undefined;
    if (job.status === 'pending' || job.status === 'running') {
      queue = await comfy.queue().catch(() => undefined);
    }
    res.json(toView(job, queue));
  });

  router.post('/assets/:assetId/i2v', async (req, res) => {
    const asset = assetRepo.getById(req.params.assetId);
    if (!asset) {
      res.status(404).json({ error: 'asset not found' });
      return;
    }
    const prompt = repo.getById(asset.promptId);
    if (!prompt) {
      res.status(404).json({ error: 'prompt not found' });
      return;
    }

    // Dedupe: an active job already exists for this image → return it (200).
    const active = jobRepo.getActiveByAsset(asset.id);
    if (active) {
      ensurePolling();
      res.status(200).json(toView(active));
      return;
    }
    // Redundant re-render guard unless ?force=1: latest success returned
    // without spending another ~13 minutes of GPU.
    if (req.query.force !== '1') {
      const done = jobRepo.getLatestSuccessByAsset(asset.id);
      if (done) {
        res.status(200).json({ ...toView(done), reused: true });
        return;
      }
    }
    // Backstop for jobs created while ComfyUI was down.
    if (jobRepo.listActive().length >= MAX_ACTIVE_JOBS) {
      res.status(503).json({ error: `too many active video jobs (max ${MAX_ACTIVE_JOBS})` });
      return;
    }
    if (!(await comfy.ping())) {
      res.status(503).json({ error: 'ComfyUI 不可达(未运行?)' });
      return;
    }

    const job = jobRepo.create({ promptId: prompt.id, sourceAssetId: asset.id });
    ensurePolling();
    // Kick the first poll immediately so submission errors surface fast.
    const fresh = jobRepo.getById(job.id);
    if (fresh) advance(fresh).catch((e) => console.error('[i2v] advance failed:', e));
    res.status(201).json(toView(job));
  });

  router.delete('/jobs/:id', async (req, res) => {
    const job = jobRepo.getById(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (job.status === 'success' || job.status === 'failed' || job.status === 'cancelled') {
      res.json(toView(job));
      return;
    }
    if (job.comfyPromptId) await comfy.interrupt(job.comfyPromptId);
    const updated = jobRepo.update(job.id, { status: 'cancelled' });
    if (!updated) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(toView(updated));
  });

  return router;
}

function normalizeExt(ext: string): string {
  const e = ext.toLowerCase();
  if (e === '.jpg' || e === '.jpeg') return '.jpg';
  if (e === '.webp') return '.webp';
  return '.png';
}

function guessMime(ext: string): string {
  if (ext === '.jpg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}
