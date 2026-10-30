#!/usr/bin/env node
/**
 * 清掉 uploads/ 下「库里已经没有这条」的空目录。
 *
 *   node tools/clean-orphan-dirs.mjs                      # 只看数
 *   node tools/clean-orphan-dirs.mjs --yes                # 真删空目录
 *   node tools/clean-orphan-dirs.mjs --api http://127.0.0.1:3200 --uploads ../../apps/api/data/uploads --yes
 *
 * 只删空目录;有文件的孤儿目录只报告、不动(可能是上传中途失败或手工放进去的)。
 * ⚠️ 必须跳过 `.` 开头的目录:`uploads/.tmp` 是 multer 的落盘暂存区(api 启动时建),
 *    删掉它会让所有上传 500;`.trash` 同理。
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const YES = args.includes('--yes');
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const API = argOf('--api', 'http://127.0.0.1:3200').replace(/\/$/, '');
const UPLOADS = path.resolve(argOf('--uploads', '../../apps/api/data/uploads'));

const res = await fetch(`${API}/api/prompts?limit=5000`);
if (!res.ok) {
  console.error(`读不到条目列表:HTTP ${res.status}`);
  process.exit(1);
}
const prompts = await res.json();
const ids = new Set(prompts.map((p) => p.id));

let empty = 0;
let removed = 0;
let keptNonEmpty = 0;
let keptBytes = 0;
const samples = [];

for (const name of fs.readdirSync(UPLOADS)) {
  if (name.startsWith('.')) continue; // .tmp / .trash 绝不能碰
  const dir = path.join(UPLOADS, name);
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    continue;
  }
  if (!st.isDirectory() || ids.has(name)) continue;

  const files = fs.readdirSync(dir);
  if (files.length === 0) {
    empty += 1;
    if (YES) {
      try {
        fs.rmdirSync(dir);
        removed += 1;
      } catch (e) {
        console.error(`删不掉 ${name}:`, e instanceof Error ? e.message : e);
      }
    }
    continue;
  }

  let bytes = 0;
  for (const f of files) {
    try {
      bytes += fs.statSync(path.join(dir, f)).size;
    } catch {
      /* 跳过 */
    }
  }
  keptNonEmpty += 1;
  keptBytes += bytes;
  if (samples.length < 10) samples.push({ dir: name, files: files.length, mb: +(bytes / 1048576).toFixed(1) });
}

console.log(
  `mode=${YES ? 'yes' : 'dry'} prompts=${prompts.length} empty_orphan_dirs=${empty} ` +
    `removed=${removed} kept_with_files=${keptNonEmpty} kept_MB=${(keptBytes / 1048576).toFixed(1)}`,
);
if (samples.length) console.log('有文件的孤儿目录(不删,自己看看要不要留):', JSON.stringify(samples, null, 1));
