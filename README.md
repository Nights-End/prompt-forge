# Prompt Forge ⚒

提示词管理 / 生成工具（Monorepo）。创建、编辑、分类、搜索、收藏提示词；模板支持 `{variable}` 占位符，填入参数后一键渲染并复制。

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

前置要求：Node.js >= 20，npm。

```bash
npm install
npm run dev      # 同时启动 api(http://localhost:3000) + web(http://localhost:5173)
```

- Vite 已配置代理，前端通过 `/api/*` 访问后端，无跨域问题。
- SQLite 数据文件位于 `apps/api/data/`（自动创建）。

其它脚本：

```bash
npm run build       # 构建 shared → api → web
npm run typecheck   # 全 workspace 类型检查
npm run test --workspace @prompt-forge/api   # 后端接口测试
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
GET    /api/meta/categories       所有分类
GET    /api/export                导出全部为 JSON
POST   /api/import                从 JSON 导入
GET    /api/health                健康检查
```

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
