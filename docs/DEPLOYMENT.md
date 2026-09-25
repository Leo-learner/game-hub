# 首版部署与验证记录

完成日期：2026-09-25（北京时间）。本文件保留首版部署快照。MCP 后续版本配置见 MCP.md；当前发布 ID/提交以服务器 RELEASE.json 与本地 .work/deploy/latest-release 为准，MCP 公网验收见 .work/deploy/mcp-verification.json。

## 访问入口

- 网站与前端预留页：https://games.dkz12345.com/
- 交互式接口文档：https://games.dkz12345.com/docs
- OpenAPI：https://games.dkz12345.com/openapi.json
- SDK（ESM）：https://games.dkz12345.com/sdk/game-hub.js
- 存档接入示例：https://games.dkz12345.com/play/example-clicker/fa22d7e6-f517-4bd7-8f3f-fdb2be970180/index.html
- 游戏目录：https://games.dkz12345.com/api/v1/games

## 首版版本与运行配置

| 项目 | 已部署状态 |
|---|---|
| 应用版本 | `20260925T022802Z` |
| 示例游戏当前版本 | `fa22d7e6-f517-4bd7-8f3f-fdb2be970180` |
| 主机 | 用户现有 Azure Ubuntu 22.04 服务器 20.48.14.96 |
| Node.js | 22.23.0（Linux） |
| 服务 | game-hub.service，专用 gamehub 用户 |
| 内部监听 | 127.0.0.1:3220 |
| 代码 | /opt/apps/game-hub/current 指向 releases/20260925T022802Z |
| 数据 | /var/lib/game-hub/game-hub.sqlite 及 releases/ |
| 前端目录 | /opt/apps/game-hub/frontend/，可独立替换 |
| 配置 | /etc/game-hub.env |
| 内存样本 | 完成验收时约 45–54 MiB；随访问和上传变化 |
| HTTPS | Let's Encrypt 证书，当前证书到期日 2026-12-24 |
| 续期 | Certbot 已有定时任务；本域名续期演练成功 |
| 续期重载 | /etc/letsencrypt/renewal-hooks/deploy/game-hub-nginx，仅匹配本域证书路径 |

公开注册开启，只能创建 player。管理员 ZIP 上传、草稿、发布、历史版本回滚与下架已可用。示例游戏有两个通过正式导入流程生成的版本。

## 管理员交付

用户名为 `admin`。初始随机密码仅保存在本地：

`/Users/leo/Desktop/game_site/docs/deployment-private/admin-credentials.txt`

父目录权限 700，文件权限 600；未进入部署包或 Git。可在存档接入示例登录，再在同域 `/docs` 调用管理员接口。正式管理界面由你自行实现。密码修改接口为 `PUT /api/v1/auth/password`；服务器重置方法见 OPERATIONS.md。

## 验证结果

| 验证 | 结果 |
|---|---|
| TypeScript 服务与 SDK 构建 | 通过，含 OpenAPI 及类型生成 |
| 类型检查 | 通过 |
| 自动化测试 | 13 组通过：账号、隔离、CSRF/来源、限流、版本冲突、幂等、ZIP、发布边界、备份恢复及 SDK |
| SDK 补充测试 | 自动保存成功回调、队列数据快照、退出取消和迟到结果隔离通过 |
| 生产依赖审计 | 官方 npm registry 返回 0 项已知漏洞（仅生产依赖，验收时结果） |
| 真实浏览器 | 游客点击/刷新清空、注册、保存/刷新恢复、删除重建、退出清空通过；localStorage 为空 |
| 线上 HTTP | 31 项检查通过，覆盖 HTTPS、Cookie、注册存档、幂等冲突、管理员上传、草稿不可读、发布/下架、旧资源与存档保留 |
| 接口文档 | 正式域名 Swagger UI 渲染成功，修正后控制台 0 错误/0 警告 |
| 部署数据保留 | 应用升级执行迁移前备份，管理员和示例版本保留 |
| 线上测试数据 | 本次临时 QA 玩家、会话、存档及幂等记录已按唯一 ID 清理；管理员测试会话已撤销 |
| 原门户 | dkz12345.com 检查为 HTTP 200 |
| 部署包检查 | 不含本地凭据、.env、数据库、node_modules 或 macOS AppleDouble 文件 |

本次验证是功能与部署验收，未进行大规模并发压测。

## 备份与恢复演练

- game-hub-backup.timer 已启用，每日北京时间 04:00 后随机延迟最多 5 分钟执行，保留七天。
- 正式备份任务执行结果为 success / exit 0。
- 实际恢复演练使用 `/var/lib/game-hub/backups/2026-09-25T02-24-45-188Z`。
- 快照恢复到新建空目录后，SQLite integrity_check 为 ok；核实 1 个管理员、1 个游戏、2 个游戏版本，数据库及游戏文件摘要验证通过。
- 恢复演练副本已清理，生产数据未替换。后续部署还生成了新的升级前快照。
- 本地集成测试另验证了带玩家云存档的备份恢复、拒绝非空目标和拒绝篡改的备份。
- 当前为同机备份；异机副本留作后续运维扩展。

## 前端接手

本地入口为 public/index.html；服务器入口为 /opt/apps/game-hub/frontend/index.html。你可以使用任意框架替换页面，首页、登录界面、存档槽 UI、管理页面均不被当前示例限制。独立端口开发的代理配置与 Cookie 约定见 API.md。

首版不包含排行榜、成就和游客迁移。平台及 SDK 不为游客持久化游戏进度。

## 复查资料

- 自动化测试：test/api.test.ts、test/sdk.test.ts。
- 线上 HTTP 明细：.work/deploy/https-smoke.json。
- 备份恢复输出：.work/deploy/backup-verification.txt。
- 当前部署版本：.work/deploy/latest-release。
- 浏览器联调记录：.playwright-cli/（本地临时测试数据，不进入 Git/部署）。
- 运维命令与恢复步骤：OPERATIONS.md。
