# Prompt Forge — 提示词管理/生成工具

> 单仓库（Monorepo）· React + Vite + TypeScript 前端 · Node.js (Express) + TypeScript 后端 · SQLite 存储 · Docker 容器化
> 服务器：Linux

---

## 1. 目标

一个 Web 应用，让用户：
- **管理**：创建、编辑、删除、分类、搜索、收藏提示词（Prompt）。
- **模板化**：提示词支持变量占位符（如 `{topic}`），填入参数自动渲染成最终文本。
- **生成**：基于模板 + 变量，一键生成并复制最终提示词。
- **组织**：用标签 / 分类对提示词分组，支持本地导入导出（JSON）。

## 2. 技术栈

| 层 | 选型 | 说明 |
|----|------|------|
| 前端 | React 18 + Vite + TypeScript | 你熟悉的方向，学习成本低 |
| UI | 轻量（CSS Modules 或 Tailwind） | 先不用重型组件库，减少学习负担 |
| 状态 | React 内置 + fetch | 先不引入 Redux，保持简单 |
| 后端 | Node.js + Express + TypeScript | 单一 REST API |
| 数据库 | SQLite（better-sqlite3） | 单文件、零配置，适合 MVP 与单机 |
| 校验/类型共享 | 共享 TS 类型包 | `packages/shared` |
| 部署 | Docker + docker-compose | Linux 服务器一键启动 |
| 测试 | Vitest（前端）+ 后端接口测试 | 可选，入门 |

> 说明：SQLite 足够单用户/小团队使用；后续如需多用户并发，可平滑切换 PostgreSQL（Docker 中换镜像 + 驱动即可）。

## 3. 目录结构

```
prompt-forge/
├─ packages/
│  ├─ shared/          # 共享 TypeScript 类型与校验
│  └─ ...
├─ apps/
│  ├─ web/             # React + Vite 前端
│  │  ├─ src/
│  │  │  ├─ api/       # 调用后端 API 的封装
│  │  │  ├─ components/
│  │  │  ├─ pages/
│  │  │  └─ types/
│  │  ├─ Dockerfile
│  │  └─ nginx.conf    # 生产环境前端静态托管
│  └─ api/             # Express 后端
│      ├─ src/
│      │  ├─ routes/
│      │  ├─ db/       # SQLite 初始化与迁移
│      │  └─ services/ # 模板渲染逻辑
│      ├─ data/        # SQLite 数据文件（挂载卷）
│      └─ Dockerfile
├─ docker-compose.yml
├─ package.json        # 根工作区脚本（npm workspaces）
├─ tsconfig.base.json
└─ README.md
```

## 4. 数据模型

`Prompt`（提示词）：
- `id` (string, 主键)
- `title` (string)
- `content` (string) — 支持 `{variable}` 占位符
- `description` (string, 可选)
- `category` (string) — 分类名
- `tags` (string[]) — 标签
- `variables` (string[]) — 从内容中解析出的占位符列表
- `isFavorite` (boolean)
- `createdAt` / `updatedAt` (ISO datetime)

`TemplateRenderInput`：`{ promptId, values: Record<string,string> }`

## 5. REST API

```
GET    /api/prompts           列表（支持 ?q= 搜索、?category=、?tag=、?favorite=）
POST   /api/prompts           新建
GET    /api/prompts/:id       详情
PUT    /api/prompts/:id       更新
DELETE /api/prompts/:id       删除
GET    /api/prompts/:id/variables   解析模板变量列表
POST   /api/prompts/render    渲染模板（body: { content, values }）→ 最终文本
GET    /api/meta/categories   所有分类
GET    /api/export            导出全部为 JSON
POST   /api/import            从 JSON 导入
GET    /api/health            健康检查
```

渲染逻辑：用正则 `/\{([a-zA-Z0-9_]+)\}/g` 提取变量并替换；缺失变量保留占位符或提示。

## 6. 实施步骤（里程碑）

### M0 — 脚手架（1 次）
- npm workspaces 初始化，`packages/shared`、`apps/api`、`apps/web`。
- 根脚本：`dev`、`build`、`start`。
- Vite 代理 `/api` 到后端，避免跨域。

### M1 — 后端 API + 数据库
- Express 应用骨架，`better-sqlite3` 建表（含默认数据文件）。
- 实现 CRUD、搜索、变量解析、渲染、导入导出。
- 用 curl 或接口测试验证。

### M2 — 前端基础页
- 提示词列表页（搜索/分类/收藏筛选）。
- 新建/编辑弹窗或表单。
- 详情页：展示变量，填入值 → 实时渲染 → 一键复制。

### M3 — 前后端联调 + 打磨
- 类型共享（shared 包）两端引用。
- 空状态、加载、错误提示；移动端可用。

### M4 — Docker 部署
- 后端 `Dockerfile`（node 镜像，构建 + 运行，挂载 `data` 卷）。
- 前端 `Dockerfile`（构建静态文件 + nginx 托管，nginx 反代 `/api`）。
- `docker-compose.yml` 编排 web + api，`docker compose up -d` 一键启动。

### M5 — 收尾
- README（本地开发 + Linux 服务器部署说明）。
- 可选：Vitest 单测、GitHub Actions 构建镜像。

## 7. 开发与运行命令（本地）

```bash
# 根目录（npm workspaces）
npm install
npm run dev        # 同时启动 api(3000) + web(5173)
npm run build      # 构建前后端
```

## 8. Linux 服务器部署（docker-compose）

```bash
# 上传项目（或用 git clone）
cd prompt-forge
docker compose up -d --build
# 访问 http://<服务器IP>:8080
```

- 数据持久化：`api/data/` 挂载到宿主机目录（或命名卷）。
- 升级：`docker compose build && docker compose up -d`。

## 9. 范围与后续扩展（暂不做）

- 多用户 / 登录鉴权
- LLM API 调用（如让模型帮你优化提示词）
- 在线协作 / 分享链接
- PostgreSQL 多实例集群

---

## 10. 关键取舍说明

1. **为什么不用 Python**：你是前端，Node 全栈只需一种语言，学习曲线最平，可复用 JS/TS 经验；本工具无重计算需求。
2. **为什么先 SQLite**：单机、零配置、无需额外容器；数据文件可直接挂卷备份。多用户需求出现后再迁移 Postgres。
3. **为什么 Express 而非 Next.js**：后端职责清晰独立，前端 Vite 灵活，API 明确；对初学者更直观。
