# Prompt Forge — 项目现状说明

> 供 AI 助手快速了解本项目。修改代码前先读本节；重要约定见文末。

## 项目是什么

Web 应用：**提示词管理 + 文生图提示词工作台**。

- 提示词库：CRUD、分类/标签/搜索/收藏、`{variable}` 模板渲染、图片资产、JSON/ZIP 导入导出、提示词"设为默认"。
- 工作台（`/workshop`）：AI 编写/优化文生图提示词，多轮聊天、SSE 流式输出、会话持久化（SQLite）、破限提示词（会话级附加 system 指令）、自定义预设管理、参考图上传分析（视觉模型）、联网检索（function calling：Tavily / Exa / DuckDuckGo）。

**功能已全部实现并测试通过**（85 个 API 测试 + typecheck）。没有"未完成"的规划功能。

## 技术栈

| 层 | 选型 |
|----|------|
| 前端 | React 18 + Vite 5 + TypeScript，CSS Modules，react-router 6 |
| 后端 | Node.js 20 + Express 4 + TypeScript（ESM）|
| 数据库 | SQLite（better-sqlite3），迁移机制 `PRAGMA user_version`（v1~v5）|
| 共享包 | `packages/shared`（类型 + 预设 + SSE 解析），workspace 协议 `"@prompt-forge/shared": "workspace:*"` |
| 包管理 | **pnpm 10**（勿用 npm 混装；`package.json` 有 `pnpm.onlyBuiltDependencies: ["better-sqlite3"]`）|
| 部署 | Docker + docker-compose（Dockerfile 均为 pnpm 构建）|

## 常用命令

```bash
pnpm install                     # 安装依赖
pnpm run dev                     # api(3000) + web(5173) 同时启动
pnpm run typecheck               # 全 workspace 类型检查
pnpm --filter @prompt-forge/api test   # 后端测试（vitest）
pnpm run build                   # shared → api → web
```

注意：shared 包改动后需先 `pnpm --filter @prompt-forge/shared build` 再重启 api（api 通过 dist 引用）。

## 代码结构速览

```
apps/api/src/
  app.ts               # 路由注册；express.json limit 20mb
  db/index.ts          # 迁移 v1~v5（prompts/assets/conversations/conversation_messages）
  db/prompts.ts        # 提示词仓库
  db/conversations.ts  # 会话+消息仓库（支持 multimodal_content、tool 消息）
  llm/config.ts        # provider 配置（provider.json，local=Ollama / cloud=OpenAI兼容）
  llm/provider.ts      # resolveUpstream / chatCompletions / buildMessages / accumulateToolCalls
  search/config.ts     # 搜索配置（search.json：tavily/exa/duckduckgo/none）
  search/execute.ts    # 搜索执行（8s 超时，结果格式化）
  workshop/config.ts   # 工作台配置（workshop.json：defaultExtraSystemPrompt + customPresets）
  routes/workshop.ts   # 工作台：presets CRUD / config / conversations CRUD / undo / chat(SSE+tool循环)
  routes/settings.ts   # provider + search 配置 API
apps/web/src/
  pages/WorkshopPage.tsx   # 工作台（聊天/流式/参考图/搜索开关/保存）
  pages/SettingsPage.tsx   # provider + 搜索服务配置
  api/client.ts            # API 封装 + streamChat（SSE 解析，onToolSearch 事件）
packages/shared/src/
  types.ts / presets.ts / constants.ts / sse.ts   # 共享类型、内置预设、常量、SSE 解析器
```

## 关键机制（改代码前必读）

- **聊天消息流**：`POST /api/workshop/conversations/:id/chat` 接收 `{content, currentPrompt?, images?}`，SSE 事件：`chunk` → `tool_search`（搜索插曲）→ `done` / `error`。消息按 `system → user → assistant(tool_calls) → tool → assistant` 落库；`tool` 消息回放时转为 `[Web search result]` 的 user 内容（兼容严格 OpenAI 格式）。
- **搜索**：会话 `enableSearch=1` 时请求带 `search_web` 工具 + `tool_choice:auto`；检测到 tool_call → 执行搜索 → 第二轮不带 tools 防死循环。**每轮最多一轮搜索**。
- **参考图**：前端 Canvas 压缩（1024px / JPEG 80%），最多 5 张，base64 存 `conversation_messages.multimodal_content`；历史请求中最多携带最近 5 张图。
- **错误回滚**：任何失败路径（上游错误/超时/空回复）都删除刚追加的 user 消息；前端收到 error 事件即移除乐观消息。
- **会话级配置**：title / providerId / presetId / extraSystemPrompt（≤4000 字符）/ enableSearch，均可通过 PUT 修改。

## 安全与数据（重要）

- `apps/api/data/` 全部运行数据**已被 .gitignore 排除**：`*.db`、`uploads/`、`provider.json`、`search.json`、`workshop.json`。**禁止把这些文件加入 git**。
- 远程仓库 `github.com/Nights-End/prompt-forge` 是**公开仓库**。API key 只通过环境变量或本地 data 文件配置，绝不可出现在代码/提交中。
- 提交前运行 `git status` + `git diff` 核对，只暂存预期文件。

## 约定

- 代码注释只写"为什么"；不引入新依赖需先说明。
- 后端测试沿用 `deps.fetchImpl` 注入 mock fetch 的模式（见 `workshop.test.ts` / `llm.test.ts`）。
- 新增共享常量放 `packages/shared/src/constants.ts`（前后端共用，勿两端硬编码）。
- 计划文档在 `.kilo/plans/`；新命令/agent 放 `.kilo/` 下（不用 `.kilocode/`）。
