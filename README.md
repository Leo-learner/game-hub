# Game Hub 小游戏后端

首版已部署：[网站入口](https://games.dkz12345.com/) · [接口文档](https://games.dkz12345.com/docs)。完整验收结果见 [DEPLOYMENT.md](docs/DEPLOYMENT.md)。

项目根目录：`/Users/leo/Desktop/game_site/`。所有源码、完整计划、文档、SDK、示例和本地测试数据都在此目录内。

提供游客直接游玩、用户名密码登录、多个云存档槽、管理员 ZIP 上传、版本发布/回滚/下架。`public/` 中是正式前端（游戏库、详情、游玩、登录注册、个人中心），也可以整体替换成你自己的前端。

## 先读这些文件

- [完整实施计划](PLAN.md)
- [MCP 工具接口与 Codex / Claude Code 配置](docs/MCP.md)
- [中文接口与 SDK 接入文档](docs/API.md)
- [部署与运维说明](docs/OPERATIONS.md)
- [实际部署结果与验证记录](docs/DEPLOYMENT.md)
- [自动生成的 OpenAPI](docs/openapi.json)

## 本地启动

需要 Node.js 22 和 npm。使用 nvm 时先运行 `nvm use 22`。

```bash
cd /Users/leo/Desktop/game_site
npm ci
cp .env.example .env
npm run migrate
npm run build
npm start
```

默认地址为 http://localhost:3220，接口文档为 http://localhost:3220/docs。开发时使用 `npm run dev`；修改 SDK 后重新 `npm run build`。

生产环境使用 Node.js 22、SQLite、systemd 和 Nginx。数据库迁移显式执行，服务启动不会自动修改表结构。

## 初始化管理员与发布示例游戏

```bash
npm run admin -- create-admin admin
npm run admin -- games create example-clicker "存档接入示例"
npm run admin -- games import examples/example-clicker --game example-clicker
npm run admin -- games publish example-clicker <上一条命令返回的版本ID>
```

创建管理员时隐藏输入密码。公网注册始终只能创建普通玩家。也可以通过管理员 API 上传 ZIP 并发布，无需制作管理页面后才能使用。

游戏发布后从 `GET /api/v1/games/example-clicker` 的 `launchUrl` 打开。示例支持游客点击、注册、登录、云端保存、刷新读档和删除存档，不使用游客本地存储。

初始管理员用户名为 admin，密码保存在本地 `docs/deployment-private/admin-credentials.txt`（仅文件所有者可读，不进入部署包或 Git）；上线状态以 [DEPLOYMENT.md](docs/DEPLOYMENT.md) 为准。

## 前端接入

全部业务 API 位于 `/api/v1`。Cookie 由浏览器保管，无需把 token 存进 localStorage。所有写请求必须携带 `X-GameHub-Request: 1`。

```js
import { createClient } from '/sdk/game-hub.js';

const client = createClient();
const user = await client.auth.me(); // 未登录为 null
const games = await client.games.list();

if (user) {
  const previous = await client.saves.load('example-clicker', 'auto');
  const result = await client.saves.save('example-clicker', 'auto', {
    data: { score: 10 },
    schemaVersion: 1,
    expectedRevision: previous?.revision ?? 0,
  });
  console.log(result.revision);
}
```

普通 script 引入：`<script src="/sdk/game-hub.global.js"></script>`，然后使用 `GameHub.createClient()`。类型位于 `public/sdk/index.d.ts` 和 `sdk/generated.ts`。也可完全不使用 SDK，直接调用 fetch。

正式前端由 `public/index.html`、`public/app.js`、`public/app.css` 组成：原生 JS，通过 `/sdk/game-hub.js` 调用接口，使用 hash 路由（`#/games/<slug>`、`#/play/<slug>`、`#/me`），不需要 `SPA_FALLBACK`，也没有构建步骤。本地运行 `npm run build` 生成 SDK 后，打开 http://localhost:3220 即可。

服务器前端目录为 `/opt/apps/game-hub/frontend/`，应用升级不会覆盖其中已有的页面。更新前端时需手动复制这三个文件：

```bash
sudo install -m 644 public/index.html public/app.js public/app.css /opt/apps/game-hub/frontend/
```

也可以换成自己的页面。框架构建产物放入该目录即可；SPA 路由需设置 `SPA_FALLBACK=true`。API、SDK、文档、健康检查、`/mcp` 和游戏资源路径为保留路径。

## 游戏包约定

ZIP 根目录包含 `index.html`，资源使用相对路径。可选 `game.json` 示例见 `examples/example-clicker/game.json`。封面随版本发布；名称、简介、标签等目录资料由管理员 API 管理。

默认 ZIP 上限 50 MiB、解压后 200 MiB、最多 10,000 项。只有管理员能上传。服务器只托管文件，不执行包内安装或构建脚本。当前部署将你维护的游戏与网站视为同域可信代码，不开放玩家上传游戏。

## 数据与存档规则

- 游客只游玩；平台和 SDK 不保存游客本地进度。
- 每个玩家、每款游戏默认最多 10 个存档槽，每槽最多 1 MiB JSON。
- 保存必须带 `expectedRevision`。首次创建用 0，更新用读取到的 `revision`。
- 冲突返回 409；前端应提示重新读取或另选槽位。后端不会静默覆盖或自动合并。
- SDK 自动生成幂等键，并对网络错误/临时服务错误有限重试；重试发送同一份数据快照。
- 删除后保留版本墓碑，防止旧请求误写重建的存档。
- 下架停止新资源访问，保留存档；正在游玩的页面仍能保存。
- 排行榜、成就、游客迁移未纳入首版，后续可独立扩展。

## 验证与部署

```bash
npm run check     # 构建、契约生成、类型检查、集成测试
bash scripts/deploy.sh
```

部署脚本针对已确认的 Azure Ubuntu 服务器和 `games.dkz12345.com`，先检查本地工程，再安装独立 systemd 服务、HTTPS 站点和每日备份。初始管理员、示例发布和实际线上验收记录见部署文档。部署不会上传本地私密凭据、数据库或 node_modules。

版本发布遵循本地验证 → GitHub 提交推送 → 部署该提交。独立私有仓库：`Leo-learner/game-hub`。部署脚本拒绝脏工作树和未推送的版本。

## AI 维护与运营

MCP 地址：`https://games.dkz12345.com/mcp`。提供 17 个工具，覆盖游戏资料、ZIP 上传、上架/回滚/下架、普通玩家密码与会话、备份校验、日志和网站重启。两个客户端使用可单独撤销的 90 天密钥。

Codex 桌面版使用 `docs/deployment-private/codex-mcp.toml`；Claude Code 可直接执行 `claude --mcp-config /Users/leo/Desktop/game_site/docs/deployment-private/claude-code.mcp.json`。完整步骤、权限范围和工具参数见 [MCP.md](docs/MCP.md)。私有文件不会进入 Git 或部署包。
