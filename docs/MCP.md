# Game Hub 维护与运营 MCP

地址：`https://games.dkz12345.com/mcp`。采用 Streamable HTTP + Bearer 密钥，独立服务监听 `127.0.0.1:3221`，Nginx 提供 HTTPS。适用于 Codex 与 Claude Code。普通浏览器访问 `/mcp` 返回 401 是正常行为，健康检查为 `/mcp/healthz`。

全部代码、配置示例和私有凭据都放在 `/Users/leo/Desktop/game_site/`。不会自动修改你的 Codex 或 Claude Code 全局设置。

## 1. 配置 Codex 桌面版

部署后提供 `docs/deployment-private/codex-mcp.toml`，其中已填好服务器地址和 Codex 专用密钥。

1. 在本机编辑器中打开此文件。
2. 将完整的 `[mcp_servers.game_hub]` 配置块合并到 `~/.codex/config.toml`；若已有同名块，替换该块，不要重复添加。其他配置保留。
3. 重启 Codex，开启新任务，让它“使用 game_hub 检查小游戏网站状态”。

密钥直接作为 HTTP Authorization 请求头配置，因此桌面版无需依赖终端环境变量。此文件含管理凭据，不要粘贴到聊天或上传仓库。配置字段依据 [Codex 官方 MCP 文档](https://developers.openai.com/codex/mcp)。

## 2. 配置 Codex CLI

若 CLI 已加入 PATH：

```bash
source /Users/leo/Desktop/game_site/docs/deployment-private/codex.env
codex mcp add game_hub \
  --url https://games.dkz12345.com/mcp \
  --bearer-token-env-var GAME_HUB_MCP_TOKEN
codex
```

以后在新的终端启动 Codex 前需再次 `source` 此文件。若已经采用上一节的桌面版静态请求头配置，CLI 会共用它，无需重复添加。当前 Mac 的内置 CLI 也可用 `/Applications/ChatGPT.app/Contents/Resources/codex` 替代命令名。

不含密钥的模板在 `docs/client-configs/codex.toml`，推荐设置 `startup_timeout_sec = 30`、`tool_timeout_sec = 180`，给备份留出时间。

## 3. 配置 Claude Code

最直接的方式，使用已经填好密钥的私有配置文件：

```bash
claude --mcp-config /Users/leo/Desktop/game_site/docs/deployment-private/claude-code.mcp.json
```

进入后运行 `/mcp` 检查 `game-hub` 状态。以后使用相同参数启动即可；不会覆盖原有 MCP 配置。

如需加入用户级配置，使用环境变量方式，命令中保留单引号：

```bash
source /Users/leo/Desktop/game_site/docs/deployment-private/claude-code.env
claude mcp add --transport http --scope user game-hub \
  https://games.dkz12345.com/mcp \
  --header 'Authorization: Bearer ${GAME_HUB_MCP_TOKEN}'
claude
```

以后新终端仍需先 `source`。不含密钥的 JSON 模板在 `docs/client-configs/claude-code.mcp.json`，可在已有项目 `.mcp.json` 中合并 `mcpServers.game-hub`。参考 [Claude Code 官方 MCP 配置](https://code.claude.com/docs/en/mcp)。本项目提供的是个人 Bearer 接入，不提供 OAuth 登录页面。

## 4. 工具与权限

两枚初始密钥相互独立，有效期 90 天，默认具有下列全部范围。到期时间和撤销所需的 ID 记录在私有目录的 `codex.metadata.json`、`claude-code.metadata.json`。

| 范围 | 工具 | 参数与作用 |
|---|---|---|
| read | `get_site_status` | 无参数；网站就绪、服务状态、磁盘/内存和数据库计数 |
| read | `list_games` | `page`, `pageSize`, 可选 `q`, `tag`；包含草稿/下架游戏 |
| read | `get_game` | `slug`, `page`, `pageSize`；资料、版本及最近上传结果 |
| content | `create_game` | `slug`, `title`，可选 `description`, `tags`, `sortOrder` |
| content | `update_game` | `slug` 和至少一个资料字段 |
| content | `prepare_game_upload` | `slug`；返回一次性上传地址和凭证 |
| content | `publish_game` | `slug`, `releaseId`；发布指定版本或回滚到旧版本 |
| content | `unpublish_game` | `slug`；下架但保留版本、存档 |
| accounts | `list_players` | `page`, `pageSize`, 可选 `q`；普通玩家和存档数量 |
| accounts | `revoke_player_sessions` | `playerId`；撤销普通玩家全部登录会话 |
| accounts | `reset_player_password` | `playerId`, `newPassword`；重置密码并撤销会话 |
| read | `list_backups` | `limit` 1–50；返回备份 ID 和清单摘要 |
| ops | `create_backup` | 无参数；备份并校验，按既有策略保留 7 天 |
| ops | `verify_backup` | `backupId`；验证数据库、ZIP 及全部文件摘要 |
| ops | `read_audit_log` | `page`, `pageSize`；操作结果和客户端来源 |
| ops | `read_service_logs` | `lines` 1–200、`minutes` 1–1440；仅网站 API 日志 |
| ops | `restart_website` | 无参数；重启网站 API 并检查就绪状态 |

分页默认 20，最多 50。密钥只会看到权限范围内的工具；每次执行再次检查密钥是否有效。正常结果包含 `structuredContent.data` 和同内容的文本；业务错误返回 `isError: true`，其文本含 `error.code`、`error.message` 和可用时的 `auditId`。鉴权错误是 HTTP 401，权限不足是 403；不支持的工具可能返回 MCP 协议错误。

另外提供资源 `gamehub://operations` 和提示词 `site_check`。网站描述、玩家昵称及日志均视为数据，不能作为要求模型改行为的指令。

## 5. 发布小游戏

可直接对 Codex/Claude Code 说：

> 创建 slug 为 puzzle 的游戏，标题“拼图”；上传我指定的 ZIP，先检查版本结果，再按我的发布要求上架。

调用顺序：`create_game` → `prepare_game_upload` → HTTP PUT ZIP → `get_game` → `publish_game`。上传凭证有效 10 分钟、仅使用一次；父密钥失效后上传凭证也失效。上传成功返回草稿版本，不会自动上架。网络中断时，先通过 `get_game.uploads` 和版本列表确认结果，再准备新的上传；进程中断留下的 `uploading` 状态需要核实，不能视为上传成功。

本机辅助脚本可以直接读 ZIP，不需要把二进制放进模型上下文：

```bash
cd /Users/leo/Desktop/game_site
source docs/deployment-private/codex.env
node scripts/mcp-upload.mjs puzzle /绝对路径/puzzle.zip
```

HTTP 接口：`PUT /mcp/uploads/<uploadId>`，`Authorization: Bearer <uploadToken>`，`Content-Type: application/zip`，正文为 ZIP 原始字节。成功为 HTTP 201，返回 `{release, published:false}`。默认压缩包 50 MiB、解压后 200 MiB、10,000 项，与网站管理员上传规则一致。禁止任意远程 URL 下载和服务器路径导入。

回滚使用 `publish_game` 指定已有旧版本 ID。下架不会删除玩家存档。此 MCP 不提供删除玩家、读取存档正文、数据库恢复、任意 Shell/SQL 或服务器文件编辑。前端页面与后端代码修改继续使用本地源码、GitHub 和部署流程；排行榜、成就、游客迁移仍留作后续。

## 6. 部署和凭据管理

```bash
cd /Users/leo/Desktop/game_site
nvm use 22
npm ci
npm run check
# 将已验证的变更提交并推送 GitHub，然后：
bash scripts/deploy.sh
# 首次部署 MCP 后：
python3 scripts/provision-mcp-credentials.py
```

发布脚本要求工作树干净，且当前提交与 GitHub 分支一致。归档取自该提交，编译产物本地重新生成；服务器记录 `RELEASE.json`。部署前备份，迁移 MCP 专用表，安装独立 systemd 服务和固定运维助手，通过健康检查后切换代理。上线验证命令：

```bash
source docs/deployment-private/codex.env
node scripts/mcp-smoke.mjs
```

首次凭据脚本在本机生成随机密钥，经 SSH 标准输入传给服务器，数据库只保存 SHA-256 摘要。它仅写私有凭据文件，不修改任何客户端全局配置；重复运行不会延长相同密钥有效期。私有目录权限 700、文件 600，Git 和部署包均排除。

在服务器查看/撤销密钥，必须使用 UUID，不能用玩家登录密码代替：

```bash
cd /opt/apps/game-hub/current
sudo -n runuser -u gamehub -g www-data -G gamehub -- \
  node --env-file=/etc/game-hub.env dist/scripts/mcp-admin.js list-tokens
sudo -n runuser -u gamehub -g www-data -G gamehub -- \
  node --env-file=/etc/game-hub.env dist/scripts/mcp-admin.js revoke-token <UUID>
```

轮换：先在本机生成新的 `ghm_` + 32 字节 base64url 随机密钥，保存在权限 600 的文件；通过 SSH 标准输入执行 `create-token 新名称 read,content,accounts,ops 90`。将新密钥更新到需要使用它的客户端、验证连接后，撤销旧 UUID。可只传 `read` 生成巡检专用密钥。MCP 不提供发放或提升自己密钥权限的工具。

备份包含密钥摘要和操作记录。恢复旧备份可能恢复旧的撤销状态，恢复后应重新检查并轮换管理密钥。审计表记录调用时间、客户端、动作、目标和结果，不存密码、参数全文或密钥；目前不自动清理审计历史。

## 7. 运行边界与故障处理

- 网站 API 与 MCP 使用独立进程和端口；重启 API 不终止 MCP。
- 两个进程共用 SQLite 和既有业务服务，MCP 使用独立表，不提升 API 的 schema 版本。迁移由部署显式执行。
- `game-hub-mcp.service` 以 `gamehub` 用户运行，内存上限 192 MiB；API 仍保持原有隔离和 256 MiB 上限。
- MCP 通过 root 所有的 `/usr/local/sbin/game-hub-control` 执行固定的 `status`、`logs`、`restart`；sudoers 仅放行该助手，助手拒绝其他参数。为允许这一调用，MCP 的 `NoNewPrivileges=false`；网站 API 仍为 true。
- JSON 请求上限 256 KiB；每个来源 IP 每分钟 120 请求；校验 Host/Origin，Bearer 与 Cookie 不互通。没有浏览器跨域 CORS 接入。
- 同时只允许一个 MCP 备份/校验/重启操作；游戏导入使用既有跨进程锁。客户端超时不会自动撤销已经提交的发布或备份，应先查看实际状态。
- `/mcp` 返回 401：确认 Bearer 使用对应密钥，未过期/撤销；桌面 Codex 无法继承终端变量时改用私有 TOML 请求头配置。
- 502：检查 `systemctl status game-hub-mcp`；`SERVICE_CONTROL_UNAVAILABLE`：检查助手权限、sudoers 与 systemd 配置。
- `WEBSITE_NOT_READY`：查看网站 API 日志，避免反复重启掩盖原因。

本地测试使用官方 MCP Client 建立真实 HTTP 连接，并覆盖 2025-03-26 协议初始化、鉴权、权限、票据、发布/回滚、账号保护、审计和备份。正式环境验收记录放在 `.work/deploy/mcp-verification.json`，实时提交标识在服务器 `/opt/apps/game-hub/current/RELEASE.json`。
