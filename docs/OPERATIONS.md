# 部署与运维

## 本地与生产配置

配置样例在 .env.example；生产实际配置在 /etc/game-hub.env，仅 root 和 gamehub 运维身份可读取。

| 配置 | 默认值/用途 |
|---|---|
| HOST / PORT | 127.0.0.1 / 3220 |
| PUBLIC_ORIGIN | 本地 http://localhost:3220；生产为 HTTPS 域名 |
| ALLOWED_ORIGINS | 额外开发来源，逗号分隔，精确匹配 |
| DATA_DIR | ./data；生产 /var/lib/game-hub |
| PUBLIC_DIR | ./public；生产 /opt/apps/game-hub/frontend |
| COOKIE_SECURE | 生产必须 true |
| TRUST_PROXY | 生产 true，仅信任回环代理 |
| SESSION_TTL_DAYS | 30 |
| SAVE_MAX_BYTES / SAVE_MAX_SLOTS | 1048576 / 10 |
| UPLOAD_MAX_BYTES / EXTRACT_MAX_BYTES / UPLOAD_MAX_FILES | 52428800 / 209715200 / 10000 |
| ALLOW_REGISTRATION / API_DOCS | true / true |
| SPA_FALLBACK | false |
| X_ACCEL_REDIRECT | 本地 false，配套 Nginx 后生产 true |
| LOG_LEVEL | info |

修改配置后重启 game-hub。生产 NODE_ENV=production 时拒绝不安全 Cookie 或 HTTP PUBLIC_ORIGIN。当前身份与私有数据响应均不缓存。

## 首次部署及后续升级

在 Node.js 22 环境中运行：

```bash
bash scripts/deploy.sh
```

脚本先执行 npm run check；将代码及已构建 SDK 打包到项目 .work/deploy 中，经 SSH 传到已确认服务器；在 Linux 安装生产依赖，并验证 SQLite/Argon2 原生模块。不会复制 macOS 的 node_modules、.env、数据库和私密凭据。

服务器目录：

- /opt/apps/game-hub/releases/：不可变应用版本。
- /opt/apps/game-hub/current：当前应用版本链接。
- /opt/apps/game-hub/frontend/：你的前端；应用升级不覆盖已存在的首页。
- /var/lib/game-hub/game-hub.sqlite：数据库，600 权限。
- /var/lib/game-hub/releases/：不可变游戏版本与原 ZIP。
- /var/lib/game-hub/tmp/：临时上传与处理锁。
- /var/lib/game-hub/backups/：每日已校验备份，仅运维身份可读取。

部署使用独立 systemd 服务和 Nginx 站点，端口 3220 若被其他服务占用会停止。HTTPS 证书通过 Certbot webroot 申请，Nginx 配置检查通过才 reload。

每次更新前备份；依赖安装成功后再停当前应用并执行迁移；新版本就绪检查通过后对外服务。只有兼容当前数据库结构的旧代码可以回退，数据库降级需独立维护流程。脚本不自动恢复旧数据库，避免覆盖新玩家数据。

## 服务器管理命令

```bash
cd /opt/apps/game-hub/current
sudo runuser -u gamehub -g www-data -G gamehub -- node --env-file=/etc/game-hub.env dist/scripts/admin.js users list
sudo runuser -u gamehub -g www-data -G gamehub -- node --env-file=/etc/game-hub.env dist/scripts/admin.js create-admin admin
sudo runuser -u gamehub -g www-data -G gamehub -- node --env-file=/etc/game-hub.env dist/scripts/admin.js reset-password player_name
sudo runuser -u gamehub -g www-data -G gamehub -- node --env-file=/etc/game-hub.env dist/scripts/admin.js games create my-game "我的游戏"
sudo runuser -u gamehub -g www-data -G gamehub -- node --env-file=/etc/game-hub.env dist/scripts/admin.js games import /path/to/game --game my-game
sudo runuser -u gamehub -g www-data -G gamehub -- node --env-file=/etc/game-hub.env dist/scripts/admin.js games publish my-game <releaseId>
sudo runuser -u gamehub -g www-data -G gamehub -- node --env-file=/etc/game-hub.env dist/scripts/admin.js games unpublish my-game
```

密码默认从终端隐藏输入；自动化可用 --password-stdin 从受控标准输入读取。不要把密码放到 shell 参数、命令历史或版本库。首次部署完成后的本地初始凭据由本项目独立的私密交付文件保存，首次使用后请通过 API 改密。

游戏目录导入和 HTTP 上传走同一校验服务，均生成草稿。只在确认版本后调用 publish。游戏 slug 不修改，标题、简介、标签可通过 API 修改。

## 备份与恢复

每日北京时间约 04:00 运行备份，保留七天。使用 SQLite 在线备份，复制快照引用的不可变游戏版本，校验数据库完整性及所有文件 SHA-256；不直接复制运行中的主数据库文件。

```bash
sudo systemctl start game-hub-backup.service
sudo systemctl list-timers game-hub-backup.timer
sudo journalctl -u game-hub-backup.service --no-pager -n 30
sudo runuser -u gamehub -g www-data -G gamehub -- node --env-file=/etc/game-hub.env /opt/apps/game-hub/current/dist/scripts/admin.js verify-backup /var/lib/game-hub/backups/<backup-name>
```

restore 只写入空目录，不覆盖运行数据。维护时停止服务，在专用恢复目录执行校验及恢复；核实账号、版本和存档后，再调整 DATA_DIR 以及 Nginx 内部资源 alias 到恢复目录，检查配置后启动。也可在停机状态保留当前数据目录后，将恢复出的数据库和 releases 迁入原 DATA_DIR，恢复原有所有者及权限。

```bash
node dist/scripts/admin.js restore <backup-directory> <empty-target-directory>
```

同机备份用于误操作和代码升级恢复，不具备整机磁盘故障容灾能力。异机备份留作运维扩展。

## 诊断与运行边界

```bash
sudo systemctl status game-hub --no-pager
sudo journalctl -u game-hub -n 50 --no-pager
curl -fsS http://127.0.0.1:3220/readyz
sudo nginx -t
```

- 对用户暴露的错误带 requestId，可据此定位日志；日志不记录密码或 Cookie。
- 同时只处理一个 ZIP 解压任务。崩溃遗留锁会检查进程是否仍存在；异常锁需运维确认后清理，不能在另一个导入进行时删除。
- 游戏资源必须先经过发布状态检查，Nginx 的内部目录不可直接访问。不要另加公开 alias 暴露 releases。
- SQLite 采用单进程，首次上线不运行集群/多副本。需要扩容时再引入独立数据库及对象存储。
- 当前游戏代码和前端同域，只接受你管理的可信代码。不要向普通玩家开放游戏上传。
- 前端应在暂停、关卡完成等明确时机存档；不要依赖页面关闭事件才写入。


## MCP 运维入口

新增 `game-hub-mcp.service`（回环 3221）和 HTTPS `/mcp`；完整工具、凭据和客户端配置见 [MCP.md](MCP.md)。发布脚本现在要求已推送的干净 Git 提交，并自动迁移 MCP 专用表。网站 API 回滚无需删除 MCP 表。数据库恢复后需核实并重新撤销已作废的 MCP 密钥。
