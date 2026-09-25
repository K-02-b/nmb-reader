# 接口契约与错误码

一句话：**前端只有 `client.ts` 一个数据入口**，请求与响应都是 camelCase，时间一律用 Unix 秒级整数。

- 前端唯一数据入口：`frontend/src/api/client.ts`；类型定义：`frontend/src/api/types.ts`
- 所有接口都在 `/api/*` 下；SPA 路由由后端回退到 `index.html`
- 时间字段一律是 **Unix 秒级整数**
- 鉴权：Cookie Session（`THREAD_READER_SESSION_TTL`，默认 43200 秒）；未登录返回 `401`
- 错误响应统一为 `{"code": "...", "detail": "可直接展示给用户的中文文案"}`；前端按 `code` 分支，不解析 `detail`

## 认证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` | body `{username, password}` → `Session`；失败 `BAD_CREDENTIALS`，锁定期 `BANNED` |
| POST | `/api/auth/register` | body `{username, password, inviteCode}` → `204`；错误码 `BAD_USERNAME` / `BAD_PASSWORD` / `USER_EXISTS` / `BAD_INVITE` / `INVITE_EXPIRED` / `INVITE_EXHAUSTED` |
| POST | `/api/auth/logout` | `204` |
| PUT | `/api/auth/password` | body `{currentPassword, newPassword}` → `Session`（改完其它会话全部作废，当前这台重发一个）；旧密码不对 `BAD_CREDENTIALS`，新密码太弱 `BAD_PASSWORD`，与原密码相同 `SAME_PASSWORD` |
| GET | `/api/auth/me` | → `Session`；未登录返回 `200 null`（前端启动时探一次，避免控制台刷 401） |

```ts
interface Session { username: string; group: 'admin' | 'editor' | 'user'; permissions: Permission[] }
```

## 串与楼层

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/threads` | 查询参数 `keyword, threadId, board, cookie, genre, series, status, tags(可重复), bookmarkedOnly, sort, page, pageSize` → `Paged<Thread>` |
| GET | `/api/threads/{threadId}` | → `Thread`；不存在或非主串 → `404 THREAD_NOT_FOUND` |
| GET | `/api/threads/{threadId}/position` | 查询参数同 `/api/threads` → `{index, page, pageSize}`；这个串在当前筛选与排序下排第几条（目录页「在目录显示」用），不在结果里 → `404 THREAD_NOT_IN_LIST` |
| GET | `/api/threads/{threadId}/posts` | `page, pageSize, pagingMode=island\|custom, keyword, poOnly` → `Paged<Post>` |
| GET | `/api/posts/{postId}` | 跨串引用跳转用 → `Post` |
| GET | `/api/tags` | 标签词汇表 → `{genre, series, status, installment, tags}`（均为 `string[]`），卷次按数值排序 |
| PUT | `/api/threads/{threadId}/tags` | body `{tags: Tag[]}` → `Tag[]`（需 `thread.edit`） |
| DELETE | `/api/threads/{threadId}` | `204`（需 `thread.edit`） |
| POST | `/api/threads/{threadId}/suggest` | body `{kind, detail}` → `204`（任何登录用户） |
| GET | `/api/threads/{threadId}/export?format=md\|json\|docx\|pdf&images=&quality=` | 导出文件（`Content-Disposition: attachment`）；`images` 只对 docx / pdf 生效，`quality=high\|medium\|low` 决定内嵌图片的长边与压缩率；总内嵌张数上限 500 |
| GET | `/api/images/{threadId}/{postId}` | 本地优先；缺失 302 到 `imgSource` 图床；无图 `404 IMAGE_NOT_FOUND` |

`sort` 取值：`updated_desc`（默认）/ `created_desc` / `created_asc` / `replies_desc`。

分页语义：

- `pagingMode=island`：按岛上 `pageNum` 取整页（第 1 页 = 串首 `pageNum=0` + `pageNum=1` 的楼层，
  第 N 页 = `pageNum=N`），页数由 `thread.pageCount` 决定
- `pagingMode=custom`：按 `id` 连续切片，页数 = `ceil(total / pageSize)`
- `total` 在两种模式下都是该串 post 总数（含串首）；`keyword` 非空或 `poOnly=true` 时改为过滤后的楼层数
- `keyword` 非空或 `poOnly=true` 时忽略 `pagingMode`，一律按过滤结果分页，否则会出现「命中 13 楼但本页空白」

## 全文检索

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/search/fulltext?keyword=&limit=` | → `Array<{thread, post}>`，只覆盖已下载的串 |
| GET | `/api/search/status` | → `{backend, fts5, indexedPosts, db}` |

`keyword` 的写法（全文检索、串内检索、目录筛选共用一套规则）：空白分词，词与词之间是 AND
（各词都要出现）；英文双引号内的整段算一个词、要求完全匹配（`"B事 量化"` 与 `B事 量化` 结果不同）；
落单的 `"` 当普通字符，最多 8 个词。全文检索里短于 3 字的词走 LIKE，其余走 FTS5。

## 下载队列（需 `thread.download`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/downloads?limit=&since=&status=` | → `DownloadTask[]`（含 `kind: download\|images`），所有登录用户可见全部任务；`since` 只返回该 Unix 秒之后提交的；`status` 取 `active`（进行中）/ `done`（已完成）/ `failed`（失败），状态归哪档由后端定义 |
| POST | `/api/downloads` | body `{threadId, source: XD, title?}` → `DownloadTask`；`threadId` 接受数字或 `No.59775198` 这类写法；串号非法 `BAD_THREAD_ID`，来源非 XD 或已有在跑的任务 `BAD_SOURCE` / `409 TASK_EXISTS` |
| POST | `/api/downloads/{taskId}/cancel` | → `DownloadTask`；排队中直接置 `cancelled`，下载中置 `cancelling` 由 worker 在页边界终止；已完成 `409 TASK_FINISHED` |
| POST | `/api/downloads/{taskId}/retry` | → `DownloadTask`，回到 `queued` |
| GET | `/api/downloads/stream` | SSE，事件名 `tasks`；每 1s 比对一次任务状态，有变化才推 |

串已存在且来源为 XD 时自动降级为**增量更新**（只补最后一页及之后），任务 `message` 会注明。

## 个人数据（任何登录用户）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/PUT | `/api/settings` | 用户设置（主题/强调色/字号/行距/亮度/分页/黑名单/单串下载页数上限/并发度/导出是否带图与图片质量），多端同步 |
| GET | `/api/meta` | 服务器侧限制与开关：`{fetchMaxPagesDefault, fetchMaxPagesCeiling, fetchConcurrencyDefault, fetchConcurrencyCeiling, imagesEnabled, searchBackend}` |
| GET | `/api/progress` | 全部阅读进度 |
| PUT | `/api/progress/{threadId}` | body `{page}`，记录岛页码 |
| GET | `/api/bookmarks` | → `Bookmark[]` |
| POST | `/api/bookmarks/{threadId}/toggle` | → `boolean`（true = 已加入） |
| GET | `/api/post-bookmarks?threadId=` | 楼层书签 → `PostBookmark[]`（含 `threadId` / `threadTitle` / `tags`），按添加时间从晚到早；给 `threadId` 就只要那个串的 |
| POST | `/api/threads/{threadId}/post-bookmarks/{postId}` | 加一条楼层书签，`204` |
| PATCH | `/api/threads/{threadId}/post-bookmarks/{postId}` | body `{title}` 改书签名（最多 60 字，空串 = 不要名字），`204` |
| DELETE | `/api/threads/{threadId}/post-bookmarks/{postId}` | 取消一条楼层书签，`204` |
| POST / DELETE | `/api/blacklist/cookies/{cookie}` | 饼干黑名单 |
| POST / DELETE | `/api/blacklist/threads/{threadId}` | 串黑名单 |

`fetchMaxPages` / `fetchConcurrency` 为 `null` 时用服务器默认值；填数字则夹到
`[1, 服务器硬上限]`，**响应里返回实际生效值**（越界取边界，不报错）。只影响该用户自己提交的下载任务。

## Cookie

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/me/nmb-cookie` | 状态：`{configured, source, updatedAt, verifiedAt, verifyOk, lastError}`，**不含明文** |
| PUT | `/api/me/nmb-cookie` | body `{cookie, verify?}`，加密入库并（默认）立即校验 |
| POST | `/api/me/nmb-cookie/verify` | 重新校验已保存的 Cookie |
| POST | `/api/me/nmb-cookie/qrcode` | `multipart/form-data`，字段 `image`；解码二维码 → 加密保存并校验，响应多一个 `label`（二维码里标注的饼干 ID） |
| DELETE | `/api/me/nmb-cookie` | 清除自己的 Cookie |

二维码内容支持三种形式：

| 内容 | 处理方式 |
| --- | --- |
| `{"cookie": "PHPSESSID=…; userhash=…", "name": "xxx"}` | 已是完整 Cookie 头，原样使用 |
| `{"cookie": "%1B%CF…", "name": "SAMPLE1"}` | 裸 userhash 值 → 补成 `userhash=<值>`；裸字节按 `%XX` 编码 |
| 裸字符串 | 带 `名字=` 视为完整 Cookie 头；否则同样补成 `userhash=<值>` |

## 用户与运维

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/users` | `user.manage` |
| POST | `/api/users` | `user.manage`，body `{username, password, group}` → `201 User`（口令强度与注册同规则；重名 `409 USER_EXISTS`） |
| PATCH | `/api/users/{username}` | `user.manage`，body `{group?, banned?}`；`banned=true` 是**停用**（一直停到手动启用，被停用账号的会话立刻作废），管理员账号不能停用、也不能改用户组（`403 CANNOT_BAN_ADMIN` / `CANNOT_CHANGE_ADMIN_GROUP`） |
| DELETE | `/api/users/{username}` | `user.manage` → `204`；不能删自己（`CANNOT_DELETE_SELF`），不能删最后一个管理员（`CANNOT_DELETE_LAST_ADMIN`），其余个人数据随外键级联清理 |
| GET | `/api/invites` | `user.manage` → `Invite[]`（`code/enabled/maxUses/usedCount/expiresAt/note`） |
| POST | `/api/invites` | `user.manage`，body `{code?, maxUses, days, note?}`；`code` 留空自动生成，`maxUses=0` 不限，`days=0` 不过期 → `201 Invite` |
| PATCH | `/api/invites/{code}` | `user.manage`，body `{enabled?, maxUses?, days?, note?}`；`days` 重新计时 |
| DELETE | `/api/invites/{code}` | `user.manage` → `204` |
| GET | `/api/logs?limit=&scope=&level=` | `log.view`；`scope` 按模块筛选（`auth` / `download` / `images` / `search` / `thread` / `suggest` / `db`），`level` 按级别筛选（`info` / `warn` / `error`），留空返回全部 |
| GET | `/api/db/stats` | `db.manage` → `{threads, posts, bodies, backups[], dbSize}` |
| POST | `/api/db/backup` \| `/api/db/restore` \| `/api/db/clean` | `db.manage` → `{message}` |

备份与恢复只覆盖 SQLite；其他数据库返回 `501 BACKUP_UNSUPPORTED` / `RESTORE_UNSUPPORTED`。
恢复后需要重启服务才能加载新数据。

## 错误码

| code | HTTP | 文案 |
| --- | --- | --- |
| `VALIDATION_ERROR` | 422 | 参数不合法（FastAPI 校验失败） |
| `UNAUTHORIZED` | 401 | 请先登录 |
| `FORBIDDEN` | 403 | 需要权限：`<permission>` |
| `USER_NOT_FOUND` | 404 | 用户不存在 |
| `BAD_CREDENTIALS` | 400 | 用户名或密码错误 |
| `BANNED` | 423 | 账号已被封禁，请 N 小时后再试 |
| `BAD_USERNAME` / `BAD_PASSWORD` | 400 | 用户名或密码不符合规则 |
| `USER_EXISTS` | 409 | 用户名已存在 |
| `BAD_INVITE` / `INVITE_EXPIRED` / `INVITE_EXHAUSTED` | 400 | 邀请码无效 / 已过期 / 次数达上限 |
| `BAD_GROUP` | 400 | 用户组不合法 |
| `CANNOT_BAN_ADMIN` | 403 | 管理员账号不能被封禁；要先取消其管理员身份才能封禁 |
| `CANNOT_CHANGE_ADMIN_GROUP` | 403 | 管理员账号不能被降级；确需变更请用 scripts/manage_users.py |
| `CANNOT_DELETE_SELF` / `CANNOT_DELETE_LAST_ADMIN` | 403 | 删除用户时的两道保护 |
| `BAD_INVITE` / `INVITE_EXPIRED` / `INVITE_EXHAUSTED` | 400 | 注册时邀请码的三种失效原因 |
| `THREAD_NOT_FOUND` | 404 | 串不存在或不是主串 |
| `POST_NOT_FOUND` | 404 | 找不到这一楼（可能未被下载） |
| `IMAGE_NOT_FOUND` | 404 | 这一楼没有图片 |
| `BAD_THREAD_ID` | 400 | 串号不合法，请输入纯数字的串号 |
| `BAD_SOURCE` | 400 | 下载来源目前只支持 XD（X岛）；AWD / BOG 暂未接入 |
| `TASK_EXISTS` | 409 | 该串已有下载任务在进行中 |
| `TASK_NOT_FOUND` / `TASK_FINISHED` / `TASK_NOT_CANCELLABLE` | 404 / 409 / 409 | 任务不存在 / 已完成无法取消 / 当前状态无法取消 |
| `QR_DECODE_FAILED` | 400 | 二维码解析失败 |
| `BACKUP_NOT_FOUND` / `DB_NOT_FOUND` | 404 / 500 | 没有可用的备份 / 数据库文件不存在 |
| `BACKUP_UNSUPPORTED` / `RESTORE_UNSUPPORTED` | 501 | 当前数据库不支持在线备份 / 恢复 |
