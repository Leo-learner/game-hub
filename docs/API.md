# Game Hub API 与 SDK 接入

线上根地址为 https://games.dkz12345.com，业务前缀 `/api/v1`。可交互文档在 `/docs`，完整字段、必填项、限制和所有响应类型在自动生成的 `/openapi.json`。

本地前端若运行在独立端口（例如 http://localhost:5173），在后端 .env 中添加 `ALLOWED_ORIGINS=http://localhost:5173`。前端开发服务器可将 `/api`、`/sdk`、`/play` 代理到 http://127.0.0.1:3220；SDK 继续使用相对地址，正式部署时仍为同域。

## 通用约定

- JSON 字段 camelCase；时间 UTC ISO 8601。
- 登录使用 HttpOnly Cookie；浏览器 fetch 设置 `credentials: 'include'`。生产同域，不需要前端读写登录令牌。
- 所有 POST、PUT、PATCH、DELETE 都带 `X-GameHub-Request: 1`，包括登录、退出、上传和无请求体操作。
- JSON 请求用 `Content-Type: application/json`；上传用 FormData，不手工设置 multipart boundary。
- CORS 只允许明确配置的来源。生产 Cookie 为 Secure、SameSite=Lax、host-only；跨站第三方域名的嵌入式登录不属于本版部署方式。
- `X-GameHub-User` 可携带预期当前用户 ID，只检查它与会话相等，不能用来选择操作其他用户。SDK 保存/读档/删除会自动设置，用于拦截跨标签页切换账号后的旧请求。
- 私有数据和业务 API 不缓存。错误不包含密码、会话值、堆栈或 SQL。

错误结构：

```json
{"error":{"code":"SAVE_CONFLICT","message":"存档已变化，请重新读取","details":{"currentRevision":8}},"requestId":"req-..."}
```

主要状态码：400 参数/包格式错误；401 需要登录或密码错误；403 来源/权限错误；404 资源不存在；409 存档、幂等键或状态冲突；413 大小/文件数量超限；415 内容类型错误；429 限流；503 存储忙或资源暂不可用。

## 账号

| 方法与路径 | 输入 | 输出/行为 |
|---|---|---|
| POST /auth/register | username, password, displayName? | 201，{user}，设置 Cookie |
| POST /auth/login | username, password | 200，{user}，轮换当前会话 |
| POST /auth/logout | 无请求体 | {ok:true}，当前会话失效 |
| POST /auth/logout-all | 需登录，无请求体 | 所有会话失效 |
| GET /auth/me | 无 | {user}；游客 {user:null} |
| PATCH /auth/me | {displayName} | 更新后的 {user} |
| PUT /auth/password | {oldPassword,newPassword} | {ok:true}，其他会话失效，当前会话轮换 |

User 字段：id、username、displayName、role（player/admin）、createdAt。用户名 3–20 位字母/数字/下划线，大小写不敏感；昵称 1–24 字符；密码 8–128 字符。未知输入字段拒绝，例如注册时传 role 会返回 400。

忘记密码由服务器 CLI 重置，重置撤销该玩家所有会话。会话默认闲置 30 天过期，最多每日续期一次。

## 游戏目录

`GET /games?q=&tag=&page=1&pageSize=20` 返回：

```json
{"items":[],"page":1,"pageSize":20,"total":0}
```

pageSize 上限 100；q 搜索名称/简介，tag 精确匹配；只返回已发布游戏，按 sortOrder、slug 排序。

`GET /games/{slug}` 返回：

```json
{
  "id":"UUID","slug":"example-clicker","title":"存档接入示例","description":"",
  "tags":[],"sortOrder":0,"published":true,"currentReleaseId":"UUID",
  "coverUrl":"/play/example-clicker/UUID/cover.svg",
  "launchUrl":"/play/example-clicker/UUID/index.html",
  "saveCapabilities":{"maxSlots":10,"maxBytes":1048576,"schemaVersion":1},
  "createdAt":"2026-09-25T00:00:00.000Z","updatedAt":"2026-09-25T00:00:00.000Z"
}
```

slug 创建后不修改。前端使用返回的 launchUrl，可直接跳转或通过同域 iframe 嵌入；发布新版本时 URL 指向新版本，旧页面继续请求原版本资源。隐藏的草稿不会出现在公开目录。

## 云存档

以下接口均需登录，只访问会话所属玩家的数据：

| 方法与路径 | 输入/输出 |
|---|---|
| GET /me/saves?page=1&pageSize=20 | 跨游戏摘要分页；包含 gameId、slug、gameTitle |
| GET /games/{slug}/saves | {items:[SaveMeta]}，不含 data |
| GET /games/{slug}/saves/{slot} | SaveMeta + data，不存在返回 404 |
| PUT /games/{slug}/saves/{slot} | {data,schemaVersion,expectedRevision} → SaveMeta |
| DELETE /games/{slug}/saves/{slot}?expectedRevision=N | {ok:true} |

slot 为 1–32 位字母、数字、下划线或连字符；`auto` 只是推荐的自动存档槽名称，不是后端定时保存任务。

SaveMeta：

```json
{"slot":"auto","schemaVersion":1,"revision":2,"updatedAt":"2026-09-25T00:00:00.000Z","sizeBytes":12}
```

保存示例：

```js
const result = await fetch('/api/v1/games/example-clicker/saves/auto', {
  method: 'PUT',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json',
    'X-GameHub-Request': '1',
    'Idempotency-Key': crypto.randomUUID(),
  },
  body: JSON.stringify({
    data: { score: 12 },
    schemaVersion: 1,
    expectedRevision: previousSave?.revision ?? 0,
  }),
});
```

- data 必须是 JSON 对象；可以含嵌套对象和数组。
- schemaVersion 是游戏的数据格式；revision 是服务器用于防覆盖的修订号。
- expectedRevision 必填，0 仅用于创建当前不存在的槽；更新和删除必须匹配当前版本。
- 冲突返回 SAVE_CONFLICT 和 currentRevision。重新读取后由前端决定是否保留本地状态、另存槽位或采用云端内容。
- 重复请求使用相同 Idempotency-Key 和相同请求内容。结果保留 24 小时，重放返回首次保存的元数据，可能低于之后的新版本；若要查看当前状态请 GET。
- 同一幂等键换内容返回 IDEMPOTENCY_CONFLICT。用户不能通过幂等键绕过账号隔离。
- 删除后的版本号不会重置；GET 返回 404 后可用 expectedRevision:0 创建新档，新 revision 仍继续递增。
- 超过字节上限返回 SAVE_TOO_LARGE；超出槽位数返回 SAVE_SLOT_LIMIT。降低游戏槽位上限不会删除已有档。
- SDK 不为游客落盘，保存失败不会偷偷转为浏览器本地存档。游戏自身也应遵循游客不持久化的接入约定。

## 管理 API

以下路径都在 `/api/v1/admin` 下，需要管理员会话及写请求头。

| 方法与路径 | 输入/行为 |
|---|---|
| GET /games | 与公开目录相同分页参数，包含草稿及下架游戏 |
| POST /games | {slug,title,description?,tags?,sortOrder?} → 201 Game |
| GET /games/{slug} | 游戏资料 |
| PATCH /games/{slug} | {title?,description?,tags?,sortOrder?}，不能改 slug |
| GET /games/{slug}/releases | {items:[Release]} |
| POST /games/{slug}/releases | multipart 唯一 file 字段为 ZIP → 201 Release |
| POST /games/{slug}/publish | {releaseId} → Game，历史版本同样可发布 |
| POST /games/{slug}/unpublish | 无请求体 → Game |

Release 包含 id、gameId、sha256、archiveBytes、manifest、fileCount、createdAt、publishedAt（未发布为 null）。上传成功只创建草稿，不自动发布。

```js
const form = new FormData();
form.append('file', zipFile);
const response = await fetch('/api/v1/admin/games/example-clicker/releases', {
  method: 'POST', credentials: 'include',
  headers: { 'X-GameHub-Request': '1' },
  body: form,
});
```

目录资料与 ZIP 清单各自有唯一来源。ZIP 中只允许这几个清单字段：

```json
{"manifestVersion":1,"cover":"cover.svg","saveSchemaVersion":1,"saveSlots":10}
```

缺省值见 README；cover 必须是包内图片。ZIP 根入口固定为 index.html。发布或回滚不清理玩家存档；下架停止后续文件访问，无法撤回已下载的代码。

## SDK

ESM：`/sdk/game-hub.js`；普通 script：`/sdk/game-hub.global.js`，全局对象 GameHub；所有方法返回 Promise。

```js
const client = createClient({ baseUrl: '/api/v1' });
await client.auth.me();
await client.auth.register({ username, password, displayName });
await client.auth.login({ username, password });
await client.auth.updateProfile('新的昵称');
await client.auth.changePassword(oldPassword, newPassword);
await client.auth.logout();
await client.auth.logoutAll();

await client.games.list({ q: '益智', page: 1, pageSize: 20 });
await client.games.get('example-clicker');

await client.saves.list('example-clicker');
await client.saves.listAll(1, 20);
const saved = await client.saves.load('example-clicker', 'auto'); // 不存在为 null
const updated = await client.saves.save('example-clicker', 'auto', {
  data: { score: 12 }, schemaVersion: 1, expectedRevision: saved?.revision ?? 0,
});
await client.saves.remove('example-clicker', 'auto', updated.revision);

await client.admin.createGame({ slug: 'my-game', title: '我的游戏' });
const release = await client.admin.uploadRelease('my-game', zipFile);
await client.admin.publish('my-game', release.id);
```

其他管理方法：listGames、getGame、updateGame、listReleases、unpublish。

ApiError 包含 status、code、message、details、requestId。保存参数还可传 `{idempotencyKey,signal,retries}`；默认最多重试一次，仅针对网络错误和 502/503/504，绝不自动重试版本冲突。

```js
const unsubscribe = client.onAuthChange(user => {
  // 更新你自己的登录界面；切换账号时清理游戏中上一位玩家的内存状态。
});
const saver = client.createDebouncedSaver('example-clicker', 'auto', error => {
  // 必须向用户反馈失败，避免显示“已保存”。
}, 1000, saved => {
  revision = saved.revision; // 定时发送和手动 flush 成功时都会调用
});
saver.schedule({data:{score:12},schemaVersion:1,expectedRevision:revision});
await saver.flush(); // 立即执行时可取得结果，用新 revision 更新自己的状态
saver.dispose();
unsubscribe();
```

防抖只合并尚未发送的请求；不自动读取游戏内存、不自动修改调用者持有的 revision。通过 onSaved 回调或手动 flush 的返回值取得保存结果，再使用最新 revision 保存。等待上一次保存完成后再排下一次更新；并行的过期版本写入仍会返回冲突。schedule 会复制传入数据，之后修改原对象不会改变待发送快照。退出或切换账号会取消待发送任务。

## 保留路由

/api/*、/play/*、/sdk/*、/docs/*、/openapi.json、/healthz、/readyz、/_gamehub_internal/* 为后端保留路径。内部资源前缀禁止外部请求；其他前端页面路由由用户自由设计。API_DOCS=false 同时关闭 /docs 和 /openapi.json。
