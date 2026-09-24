# 架构：两个数据层，各司其职

一句话：**关系库是事实来源，检索引擎是可重建的派生索引。** 它们不是替代关系，
所以选型时不能放在一起比。

## 1. 两个层的职责边界

```text
                    ┌──────────────────────────────┐
   浏览器 ──────────▶│  FastAPI（api 容器）          │
   (SPA 由同一个      │  /api/*  鉴权/分页/写操作      │
    进程托管)         └───────┬──────────────┬───────┘
                              │              │
                 读写（唯一事实来源）      查询（派生索引）
                              │              │
                    ┌─────────▼──────┐  ┌────▼─────────────┐
                    │ 关系库          │  │ 检索引擎          │
                    │ SQLite/PG/MySQL │  │ FTS5 / Manticore │
                    │ 帖子/串/标签/   │  │ content 全文索引  │
                    │ 用户/书签/任务  │  │ (thread_id,post_id)│
                    └─────────▲──────┘  └────▲─────────────┘
                              │              │
                              │  写索引（可重放）
                    ┌─────────┴──────────────┴───────┐
                    │  worker（独立进程/容器）        │
                    │  抓取 → 入关系库 → 推索引 → 图片 │
                    └────────────────────────────────┘
```

| | 关系库 | 检索引擎 |
| --- | --- | --- |
| 存什么 | 帖子正文与元数据、串、标签、用户、书签/进度/黑名单、下载任务、日志 | 只有正文倒排索引 + `thread_id` / `post_id` 两个属性 |
| 是不是事实来源 | **是**（要备份） | 否（随时可从关系库重建） |
| 写入时机 | 下载入库、用户操作 | 每次入库后由 worker 推送，或 `scripts/build_index.py` 全量重建 |
| 挂了会怎样 | 站点不可用 | 搜索退化为 `LIKE`（写 warn 日志），阅读与下载不受影响 |

这条边界在代码里的体现：

- `app/services/search.py` 的 `SearchBackend` 协议只有三个方法：
  `search()`（回 id 对）、`index_thread()`、`drop_thread()`——全部只碰索引，不碰业务数据
- `app/services/importer.py` 先写关系库，提交成功后再调 `search.index_thread()`；
  索引失败只记 warn，**不回滚入库**（因为索引可重建）
- `search.ManticoreBackend.search()` 捕获异常后自动用 `LikeBackend()` 兜底

## 2. 选型其实是「每层各选一个」

| 形态 | 关系库 | 检索引擎 |
| --- | --- | --- |
| 单机零依赖（默认） | SQLite | **FTS5**（trigram） |
| 生产容器化 | **PostgreSQL 16** | **Manticore** |
| 已有 MySQL 的团队 | MySQL 8 | Manticore |

注意 **FTS5 与 SQLite 绑定**：它是 SQLite 的虚拟表，换掉 SQLite 就没有它，
所以「PG/MySQL + FTS5」这个组合不存在，要么 Manticore，要么退化成 `LIKE`。

## 3. 一次下载的数据流

```text
用户提交申请（记录 submitted_by）→ download_task(queued)
  worker claim → downloading → nmb_parse.download_thread() 抓岛上各页
  → downloaded → importer 写入关系库（post / post_body / thread / thread_tag）
  → writing → written → search.index_thread() 推倒排索引
  → indexing → images.fetch_thread_images_progress() 图片本地化
  → indexed（前端可读、可搜、可导出）
```

失败态见 [`state-machine.md`](state-machine.md)。索引失败不影响已入库的数据——
重跑 `scripts/build_index.py` 即可修复。

入库时楼层上的派生标记也一并算好：`is_po` 按「显示 ID 与串首相同」判定，而不是看岛上的
`(PO主)` 字样——那个标记不是每层都带，只认它会漏掉大量楼主楼层。`init_db()` 会用同一条
规则补一遍老库（`repair_post_flags()`），所以升级只重启一次即可，不必重新抓串。

## 4. 任务队列与状态

下载任务（`download_task`）存在关系库里：重启不丢任务，管理页与所有用户看到的状态
就是表里的状态，不存在两处状态不一致。单 worker 串行消费，领取语义是一条
`WHERE status='queued' ORDER BY submitted_at LIMIT 1`；将来要多 worker 并行，
再上 PostgreSQL 的 `FOR UPDATE SKIP LOCKED`。

## 5. Cookie 归属

抓取需要登录 Cookie，而 Cookie 等同于账号身份，所以不做成全局配置：

```text
用户在前端「设置 → Cookie」粘贴或扫码导入
  → PUT /api/me/nmb-cookie（Fernet 加密 → user_cookie 表）
worker 领到任务
  → 按 download_task.submitted_by 找到提交者
  → 解密该用户的 Cookie（解不开就提示重新导入）
  → 没有则退回服务器级 THREAD_READER_NMB_COOKIE（仅自用实例）
```

- 接口只返回状态元信息，不返回明文；日志与任务消息里也不出现
- 主密钥来自 `THREAD_READER_SECRET_KEY`，留空则自动生成 `data/secret.key`（0600）
- A 的 Cookie 只用于 A 提交的任务
