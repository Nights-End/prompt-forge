# Prompt Forge ⚒

提示词管理 / 生成工具（Monorepo）。创建、编辑、分类、搜索、收藏提示词；模板支持 `{variable}` 占位符，填入参数后一键渲染并复制。内置**文生图提示词工作台**：AI 编写/优化提示词，支持多轮聊天修改、SSE 流式输出、会话持久化、参考图上传分析、联网检索增强提示词。

## 技术栈

| 层 | 选型 |
|----|------|
| 前端 | React 18 + Vite + TypeScript |
| 后端 | Node.js + Express + TypeScript |
| 数据库 | SQLite（better-sqlite3） |
| 共享 | `packages/shared`（TS 类型 + 渲染逻辑） |
| 部署 | Docker + docker-compose |

## 目录结构

```
prompt-forge/
├─ packages/shared/   # 共享类型与模板渲染
├─ apps/web/          # React + Vite 前端
├─ apps/api/          # Express 后端 + SQLite
├─ docker-compose.yml
└─ package.json       # npm workspaces 根脚本
```

## 本地开发

前置要求：Node.js >= 20，pnpm（本仓库使用 pnpm 管理依赖，勿用 npm 混装）。

```bash
pnpm install
pnpm run dev      # 同时启动 api(http://localhost:3000) + web(http://localhost:5173)
```

- Vite 已配置代理，前端通过 `/api/*` 访问后端，无跨域问题。
- SQLite 数据文件位于 `apps/api/data/`（自动创建）。

其它脚本：

```bash
pnpm run build       # 构建 shared → api → web
pnpm run typecheck   # 全 workspace 类型检查
pnpm --filter @prompt-forge/api test   # 后端接口测试
```

## REST API

```
GET    /api/prompts               列表（?q= &category= &tag= &favorite=）
POST   /api/prompts               新建
GET    /api/prompts/:id           详情
PUT    /api/prompts/:id           更新
DELETE /api/prompts/:id           删除
GET    /api/prompts/:id/variables 解析变量列表
POST   /api/prompts/render        渲染模板 {content, values}
GET    /api/prompts/default       获取默认提示词（未设置时 404）
POST   /api/prompts/:id/default   将指定提示词设为默认（全局唯一，自动替换旧的）
GET    /api/meta/categories       所有分类
GET    /api/export                导出全部为 JSON
POST   /api/import                从 JSON 导入
GET    /api/health                健康检查
```

### 文生图工作台 API（`/api/workshop`）

```
GET    /api/workshop/conversations               会话列表（?promptId= 过滤，updatedAt 倒序）
POST   /api/workshop/conversations               创建会话 {promptId?, title?, providerId?, presetId?, extraSystemPrompt?}
GET    /api/workshop/conversations/:id           会话详情 + messages 列表
PUT    /api/workshop/conversations/:id           更新 {title?, providerId?, presetId?, extraSystemPrompt?, enableSearch?}
DELETE /api/workshop/conversations/:id           删除（级联删消息）
POST   /api/workshop/conversations/:id/undo      撤销：删除最后一条 user 消息及其后的全部消息
POST   /api/workshop/conversations/:id/chat      SSE 流式对话 {content, currentPrompt?, images?}
GET    /api/workshop/presets                     预设列表（内置 + 自定义合并，同 id 自定义覆盖内置）
POST   /api/workshop/presets                     创建自定义预设 {id, name, description, instructions}
PUT    /api/workshop/presets/:id                 更新自定义预设（内置预设返回 404）
DELETE /api/workshop/presets/:id                 删除自定义预设（内置预设返回 404，删除覆盖后内置恢复）
GET    /api/workshop/config                      { defaultExtraSystemPrompt }
PUT    /api/workshop/config                      { defaultExtraSystemPrompt? } 保存全局默认破限提示词
```

- `presetId`：`tags`（SD/Flux 标签式）/ `mj`（Midjourney 参数式）/ `plain`（简洁描述式），以及用户自定义预设。自定义预设的 `instructions` 就是该模型/引擎的提示词写法指导，选中后替换 system 消息中的结构要求段。
- 预设配置存于 `data/workshop.json`（`customPresets` + `defaultExtraSystemPrompt`），与 `provider.json` 同模式。
- `extraSystemPrompt`：会话级附加 system 指令（≤4000 字符），拼接在预设指令后随每次对话注入，可随时修改。创建会话时未传则自动使用全局默认（`defaultExtraSystemPrompt`）。
- `enableSearch`：会话级联网搜索开关（默认关闭）。开启后请求携带 `search_web` tool 声明，模型可通过 function calling 主动搜索网络。
- `images`：可选的参考图 base64 data URL 数组（最多 5 张），作为多模态消息发送给视觉模型。
- 每次请求由服务端重建 system 消息（预设指令 + 附加指令 + 当前提示词），仅持久化 user/assistant/tool 消息；发送前截取最近 40 条历史（上游 100 条上限以内）。
- 流式事件：`{"type":"chunk","text"}` → … → `{"type":"done","content","model"}`；失败时 `{"type":"error","message"}`。搜索时额外 `{"type":"tool_search","query"}` 插曲事件。上游不支持流式时自动降级为整段 JSON 返回。
- 客户端中断：服务端中止上游请求并回滚刚追加的 user 消息，会话保持一致。
- 搜索流程：第一轮请求带 tools → 检测 tool_call → 执行搜索（Tavily / Exa / DuckDuckGo）→ 第二轮请求不带 tools → 流式输出最终回复。tool 消息全落库，刷新可完整重放。

## 文生图工作台使用

1. 在 **Settings** 配置 provider（`local` = Ollama，`cloud` = OpenAI 兼容服务，如 DeepSeek）；可选配置搜索服务（Tavily / Exa API Key 或 DuckDuckGo 兜底）。
2. 顶部导航进入 **工作台**，选择预设与模型，输入想法（如"一只戴帽子的猫，赛博朋克风格"），Enter 发送。
3. 流式结果逐字渲染；可继续追问修改（如"光线改成霓虹感"）；刷新页面会话不丢。
4. 点击 assistant 消息的 **采用** 将结果带入右侧编辑区，修改后可 **保存为提示词** 入库。
5. 工作台可展开 **破限提示词** 面板，填写附加 system 指令（随每次对话注入预设指令之后）。面板内 **保存为默认** 可将当前内容设为全局默认破限提示词，之后新建的会话自动带上。
6. 提示词详情页的 **AI 优化** 按钮可直接带着该提示词进入工作台续聊。
7. **默认提示词**：详情页点 **设为默认**（全局唯一，自动替换旧的）；之后直接打开工作台（不带 `?promptId=`）会自动把默认提示词加载进右侧编辑区，未设置则留空。
8. **自定义预设**：预设下拉框旁点 **管理预设**，可新建/编辑/删除自定义预设（id 唯一，含名称/说明/指令）。指令是"该模型提示词的写法指导"，可通过 AI 研究后填入；同 id 时自定义覆盖内置，删除覆盖后内置恢复。
9. **参考图**：输入框可粘贴/拖拽/选择图片文件（自动压缩至 1024px、JPEG 80%），最多 5 张，作为多模态参考发给视觉模型。
10. **联网搜索**：工作台设置栏开启 🔍 开关后，模型可使用 function calling 调用 Tavily/DuckDuckGo 搜索最新趋势、风格等来丰富提示词。搜索过程显示透明插曲提示。

## Docker 部署（Linux 服务器）

```bash
# 上传项目（或用 git clone）后：
cd prompt-forge
docker compose up -d --build
# 访问 http://<服务器IP>:8080
```

- 后端 `apps/api/Dockerfile`：多阶段构建，`node:20-slim`，挂载 `api-data` 卷持久化 SQLite。
- 前端 `apps/web/Dockerfile`：构建静态文件后由 nginx 托管，并反向代理 `/api` 到 `api` 服务。
- 数据持久化在命名卷 `api-data`；升级 `docker compose build && docker compose up -d`。
- 备份：`docker run --rm -v prompt-forge_api-data:/data -v $PWD:/backup alpine tar czf /backup/api-data.tar.gz -C /data .`

## 说明

- 本地 Windows 若 `better-sqlite3` 编译失败（缺 VS C++ 工具），会优先下载预编译二进制，无需本机编译。
- 现阶段为单用户场景；如需多用户并发，可将 SQLite 平滑迁移至 PostgreSQL。
