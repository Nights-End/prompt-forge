#!/usr/bin/env node
/**
 * 把酒馆抽出来的提示词清单（prompts.jsonl）灌进 prompt-forge。
 *
 * 源文件由 Hermes 侧从 SillyTavern 的聊天记录抽取，每行一个 JSON：
 *   {"chat":"魔法少女MVU测试","line":1108,"seq":1,"prompt":"Scene Composition:..."}
 * 账本 ran.jsonl（st_batch.ps1 写的）用来给条目打「已生成」标签。
 *
 * 用法（先在仓库根目录把后端起起来：pnpm dev）：
 *   node .kilo/tools/import-st-prompts.mjs                     # 默认：魔法少女MVU测试
 *   node .kilo/tools/import-st-prompts.mjs --chat 气运平衡系统
 *   node .kilo/tools/import-st-prompts.mjs --src D:\hermes-tmp\picks.jsonl
 *   node .kilo/tools/import-st-prompts.mjs --dry               # 只统计，不写库
 *
 * 参数：
 *   --src      源清单，默认 %USERPROFILE%\.hermes\st-collect\prompts.jsonl
 *   --chat     只导入这个聊天，默认「魔法少女MVU测试」；--chat all 表示全都导
 *   --ledger   账本，默认 %USERPROFILE%\.hermes\st-collect\ran.jsonl（可选）
 *   --api      后端地址，默认 http://localhost:3000
 *   --category 分类前缀，默认「酒馆」（最终分类形如 酒馆/魔法少女MVU测试）
 *   --batch    每批提交条数，默认 200
 *   --dry      只统计不写库
 *   --no-dedupe 不去重（默认按提示词正文去重，保留最先出现的一条）
 *
 * 注意：prompt-forge 的导入是「新建」，重复跑会重复入库 —— 一次导一个聊天，
 *       想重来先在网页里把该分类的条目删掉。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const HOME = os.homedir();
const COLLECT = path.join(HOME, '.hermes', 'st-collect');
const SRC = opt('src', path.join(COLLECT, 'prompts.jsonl'));
const LEDGER = opt('ledger', path.join(COLLECT, 'ran.jsonl'));
const CHAT = opt('chat', '魔法少女MVU测试');
const API = opt('api', 'http://localhost:3000').replace(/\/+$/, '');
const CATEGORY = opt('category', '酒馆');
const BATCH = Math.max(1, parseInt(opt('batch', '200'), 10) || 200);
const DRY = has('dry');
const DEDUPE = !has('no-dedupe');

const TITLE_HEAD = 32;

function fail(msg) {
    console.error(`[x] ${msg}`);
    process.exit(1);
}

async function readJsonl(file, onObject) {
    if (!fs.existsSync(file)) fail(`找不到文件：${file}`);
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let n = 0;
    for await (const raw of rl) {
        const line = (n === 0 ? raw.replace(/^\uFEFF/, '') : raw).trim();
        n += 1;
        if (!line) continue;
        try {
            onObject(JSON.parse(line));
        } catch {
            // 单行坏了就跳过，最后统一报数
            onObject(null);
        }
    }
    return n;
}

function expandNewlines(s) {
    return String(s).replace(/\\n/g, '\n');
}

function shorten(s, n) {
    const t = String(s).replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
}

async function main() {
    if (!fs.existsSync(SRC)) fail(`源清单不存在：${SRC}\n（先在 Hermes 那边抽一次，或用 --src 指到别的文件）`);

    // 账本：已生成过的 (chat,line,seq)
    const done = new Set();
    if (fs.existsSync(LEDGER)) {
        await readJsonl(LEDGER, (o) => {
            if (o && o.status === 'done') done.add(`${o.chat}|${o.line}|${o.seq}`);
        });
    }

    const all = CHAT.toLowerCase() === 'all';
    const seen = new Set();
    const items = [];
    let scanned = 0;
    let bad = 0;
    let dup = 0;

    await readJsonl(SRC, (o) => {
        scanned += 1;
        if (!o) { bad += 1; return; }
        if (!all && o.chat !== CHAT) return;
        const prompt = String(o.prompt ?? '');
        if (!prompt.trim()) return;
        if (DEDUPE) {
            const key = prompt.trim();
            if (seen.has(key)) { dup += 1; return; }
            seen.add(key);
        }
        const wasDone = done.has(`${o.chat}|${o.line}|${o.seq}`);
        items.push({
            title: `#${o.line}-${o.seq} ${shorten(prompt, TITLE_HEAD)}`,
            content: expandNewlines(prompt),
            description: `来自酒馆聊天「${o.chat}」消息 #${o.line} 第 ${o.seq} 段` +
                (wasDone ? '（这份跑过图）' : ''),
            category: `${CATEGORY}/${o.chat}`,
            tags: ['酒馆', 'st-chatu8', o.chat, wasDone ? '已生成' : '未生成'],
            type: 'text',
        });
    });

    console.log(`[i] 源文件      ${SRC}`);
    console.log(`[i] 账本        ${fs.existsSync(LEDGER) ? LEDGER : '(没有，全部记未生成)'}`);
    console.log(`[i] 扫描行数    ${scanned}${bad ? `（坏行 ${bad}）` : ''}`);
    console.log(`[i] 过滤        ${all ? '全部聊天' : `chat=${CHAT}`}`);
    console.log(`[i] 去重丢弃    ${dup}`);
    console.log(`[i] 待导入      ${items.length}`);
    if (items.length) {
        const doneN = items.filter((i) => i.tags.includes('已生成')).length;
        console.log(`[i] 已生成标记  ${doneN} / 未生成 ${items.length - doneN}`);
        console.log(`[i] 样例        ${items[0].title}`);
    }
    if (DRY) { console.log('[i] --dry：到此为止，没有写库。'); return; }
    if (!items.length) { console.log('[i] 没有可导入的条目。'); return; }

    const health = await fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false);
    if (!health) fail(`后端没响应：${API}/api/health\n（先在仓库根目录跑 pnpm dev）`);

    let imported = 0;
    let skipped = 0;
    for (let i = 0; i < items.length; i += BATCH) {
        const batch = items.slice(i, i + BATCH);
        const res = await fetch(`${API}/api/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompts: batch }),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            fail(`第 ${i / BATCH + 1} 批失败：HTTP ${res.status} ${text.slice(0, 200)}`);
        }
        const data = await res.json();
        imported += data.imported || 0;
        skipped += data.skipped || 0;
        console.log(`[+] ${Math.min(i + BATCH, items.length)}/${items.length}  已入库 ${imported} 跳过 ${skipped}`);
    }

    console.log(`\n完成：入库 ${imported}，跳过 ${skipped}。`);
    console.log(`打开 ${API} → 列表按分类「${CATEGORY}」筛选即可看到。`);
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)));
