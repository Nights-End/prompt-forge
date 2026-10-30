import fs from 'node:fs';
import path from 'node:path';
import type { Asset, Prompt } from '@prompt-forge/shared';
import { storagePathToFs } from './uploads.js';

// 删除不再直接 unlink:文件挪进 uploads/.trash,元数据追加到 manifest.jsonl。
// 手滑删错时,保留期内文件与记录都还在,可以按 manifest 原样放回去。
// 保留期由 TRASH_KEEP_DAYS 控制(默认 7 天,0 = 永久保留)。
export const TRASH_DIRNAME = '.trash';
const MANIFEST = 'manifest.jsonl';
const DEFAULT_KEEP_DAYS = 7;
const DAY_MS = 86_400_000;

export interface TrashedFile {
  storagePath: string;
  trashedAs: string;
}

export interface TrashEntry {
  at: string;
  reason: 'prompt' | 'asset';
  promptId: string;
  /** prompt 整条被删时留一份完整快照;只删单图时为 null。 */
  prompt: Prompt | null;
  assets: Array<Pick<Asset, 'id' | 'kind' | 'fileName' | 'storagePath' | 'metadata' | 'sortOrder' | 'createdAt'>>;
  files: TrashedFile[];
}

export function trashDirOf(uploadsDir: string): string {
  return path.join(uploadsDir, TRASH_DIRNAME);
}

/** uploads 下的条节目录:只接受落在 uploads 根内的路径(id 来自数据库,仍防一手穿越)。 */
function promptDirOf(uploadsDir: string, promptId: string): string {
  const resolved = path.resolve(uploadsDir, promptId);
  const root = path.resolve(uploadsDir) + path.sep;
  if (!resolved.startsWith(root)) throw new Error('invalid prompt id');
  return resolved;
}

function keepDays(): number {
  const env = process.env.TRASH_KEEP_DAYS;
  if (env === undefined || env.trim() === '') return DEFAULT_KEEP_DAYS; // 设成空串=没设
  const raw = Number(env);
  if (!Number.isFinite(raw) || raw < 0) {
    console.warn(`TRASH_KEEP_DAYS=${env} 不合法,按 ${DEFAULT_KEEP_DAYS} 天处理`);
    return DEFAULT_KEEP_DAYS;
  }
  return raw;
}

function stampFor(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * 把资产文件挪进回收站,并追加一条 manifest(不清库里的行 —— 调用方自己负责删记录)。
 * 返回真正挪走的文件。
 */
export function trashAssets(
  uploadsDir: string,
  opts: { promptId: string; prompt: Prompt | null; assets: Asset[]; reason: 'prompt' | 'asset'; now?: Date },
): TrashedFile[] {
  const now = opts.now ?? new Date();
  const dir = trashDirOf(uploadsDir);
  const stamp = stampFor(now);
  const moved: TrashedFile[] = [];

  for (const asset of opts.assets) {
    // 单个文件挪不动(被占用/路径非法)不能拖垮整批:其余照挪,失败的留给调用方看日志
    try {
      const src = storagePathToFs(uploadsDir, asset.storagePath);
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(dir, { recursive: true });
      const base = asset.storagePath.replace(/[\\/]+/g, '__');
      let name = `${stamp}__${base}`;
      for (let n = 1; fs.existsSync(path.join(dir, name)); n += 1) name = `${stamp}-${n}__${base}`;
      const dst = path.join(dir, name);
      fs.renameSync(src, dst);
      // rename 会带走原 mtime(可能是几周前的上传时间)。这里改成「删除时刻」,
      // 否则按 mtime 兜底清理时,老文件刚进回收站就被当成过期。
      const t = now.getTime() / 1000;
      fs.utimesSync(dst, t, t);
      moved.push({ storagePath: asset.storagePath, trashedAs: name });
    } catch (e) {
      console.error(`trash: skip ${asset.storagePath}:`, e instanceof Error ? e.message : e);
    }
  }

  if (!moved.length) return [];

  const entry: TrashEntry = {
    at: now.toISOString(),
    reason: opts.reason,
    promptId: opts.promptId,
    prompt: opts.prompt,
    assets: opts.assets.map((a) => ({
      id: a.id,
      kind: a.kind,
      fileName: a.fileName,
      storagePath: a.storagePath,
      metadata: a.metadata,
      sortOrder: a.sortOrder,
      createdAt: a.createdAt,
    })),
    files: moved,
  };
  fs.appendFileSync(path.join(dir, MANIFEST), `${JSON.stringify(entry)}\n`);
  return moved;
}

/** 整条删除后收掉条节目录。目录里还有残余(没走 trash 的文件)时也挪进回收站,不硬删。 */
export function removePromptDir(uploadsDir: string, promptId: string): void {
  let dir: string;
  try {
    dir = promptDirOf(uploadsDir, promptId);
  } catch {
    return; // 路径非法:什么都不做
  }
  if (!fs.existsSync(dir)) return;
  try {
    const left = fs.readdirSync(dir);
    if (left.length) {
      const trash = trashDirOf(uploadsDir);
      fs.mkdirSync(trash, { recursive: true });
      const stamp = stampFor(new Date());
      const ts = Date.now() / 1000;
      for (const name of left) {
        try {
          let dstName = `${stamp}__${promptId}__residual__${name}`;
          for (let n = 1; fs.existsSync(path.join(trash, dstName)); n += 1) {
            dstName = `${stamp}-${n}__${promptId}__residual__${name}`; // 别静默覆盖回收站里同名文件
          }
          const dst = path.join(trash, dstName);
          fs.renameSync(path.join(dir, name), dst);
          fs.utimesSync(dst, ts, ts); // 与 trashAssets 同口径:mtime = 删除时刻
        } catch (e) {
          console.error(`trash: residual ${name} 挪不动,留在原地:`, e instanceof Error ? e.message : e);
        }
      }
    }
    fs.rmdirSync(dir); // 还有挪不动的就抛,目录留着(不硬删)
  } catch {
    /* 非空或已被挪走:不影响删除结果 */
  }
}

/** 只删一张图:目录空了才收掉,非空(还有别的图)必须留着。 */
export function removeEmptyPromptDir(uploadsDir: string, promptId: string): void {
  try {
    fs.rmdirSync(promptDirOf(uploadsDir, promptId));
  } catch {
    /* ENOTEMPTY / ENOENT 都正常 */
  }
}

/** 读 manifest(测试与人工恢复用)。坏行跳过。 */
export function readTrashEntries(uploadsDir: string): TrashEntry[] {
  const file = path.join(trashDirOf(uploadsDir), MANIFEST);
  if (!fs.existsSync(file)) return [];
  const out: TrashEntry[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as TrashEntry);
    } catch {
      /* 跳过坏行 */
    }
  }
  return out;
}

/** manifest 原子重写(tmp + rename):中途崩了也不会截断整份。 */
function rewriteManifest(dir: string, lines: string[]): void {
  const file = path.join(dir, MANIFEST);
  const tmp = path.join(dir, '.manifest.tmp');
  fs.writeFileSync(tmp, lines.length ? `${lines.join('\n')}\n` : '');
  fs.renameSync(tmp, file);
}

/**
 * 清掉过期内容。**以 manifest 条目的 at(删除时刻)为准**,不看文件 mtime ——
 * rename 会把原文件的旧 mtime 带进回收站,按 mtime 判会把刚删的老图当场清掉。
 * manifest 里没有引用的孤儿文件,仍用 mtime 兜底(trashAssets 已把 mtime 设成删除时刻)。
 */
export function pruneTrash(
  uploadsDir: string,
  opts: { now?: number; days?: number } = {},
): number {
  const days = opts.days ?? keepDays();
  if (days === 0) return 0; // 0 = 永久保留
  const dir = trashDirOf(uploadsDir);
  if (!fs.existsSync(dir)) return 0;

  const now = opts.now ?? Date.now();
  const cutoff = now - days * DAY_MS;
  const manifestPath = path.join(dir, MANIFEST);
  const rawLines = fs.existsSync(manifestPath)
    ? fs.readFileSync(manifestPath, 'utf8').split('\n').filter((l) => l.trim())
    : [];

  const kept: string[] = [];
  const referenced = new Set<string>();
  let removed = 0;

  for (const line of rawLines) {
    let entry: TrashEntry | null = null;
    try {
      entry = JSON.parse(line) as TrashEntry;
    } catch {
      /* 坏行:原样留着,不因解析失败丢记录 */
    }
    const at = entry ? Date.parse(entry.at) : Number.NaN;
    if (!entry || !Number.isFinite(at)) {
      kept.push(line);
      continue;
    }
    if (at >= cutoff) {
      kept.push(line);
      for (const f of entry.files ?? []) referenced.add(f.trashedAs);
      continue;
    }
    let allGone = true;
    for (const f of entry.files ?? []) {
      const full = path.join(dir, f.trashedAs);
      try {
        if (fs.existsSync(full)) {
          fs.rmSync(full, { force: true });
          if (fs.existsSync(full)) allGone = false;
          else removed += 1;
        }
      } catch {
        allGone = false; // 删不掉:这条记录留着,下次再试
      }
      if (fs.existsSync(full)) allGone = false;
    }
    if (!allGone) {
      kept.push(line);
      for (const f of entry.files ?? []) referenced.add(f.trashedAs);
    }
  }

  // 孤儿文件(manifest 没引用,比如上次崩在 rename 与写 manifest 之间)
  for (const name of fs.readdirSync(dir)) {
    if (name === MANIFEST || name.startsWith('.')) continue;
    if (referenced.has(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      if (st.mtimeMs < cutoff) {
        fs.rmSync(full, { force: true });
        removed += 1;
      }
    } catch {
      /* 并发删掉了:忽略 */
    }
  }

  rewriteManifest(dir, kept);
  return removed;
}
