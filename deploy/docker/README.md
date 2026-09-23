# 容器部署：两个编排文件，同一个镜像

```bash
git clone https://github.com/K-02-b/nmb-reader.git
cd nmb-reader
```

只差两个数据层，其余完全相同：

| 文件 | 关系库 | 检索引擎 | 用途 | 命令 |
| --- | --- | --- | --- | --- |
| `compose.sqlite.yaml` | SQLite 单文件 | FTS5 | 本地/单机、单人自用 | `make up-local` / `make init-local` |
| `compose.yaml` | PostgreSQL 16 | Manticore | 服务器、多人使用 | `make up` / `make init-compose` |

> SQLite 是单写者：api 与 worker 两个容器共用一个库文件时靠 WAL + 忙等兜底，单人够用；
> 多人请用 `compose.yaml` 那一套。

## 服务器形态（PostgreSQL + Manticore）

| 容器 | 角色 | 数据 | 要不要备份 |
| --- | --- | --- | --- |
| `db` | PostgreSQL 16 | 帖子/串/标签/用户/收藏/任务状态——**唯一事实来源** | **要**（`pg_dump` 或卷快照） |
| `search` | Manticore Search | 正文倒排索引，可由 `db` 随时重建 | 不用 |
| `api` | FastAPI + 前端静态产物 | 图片、备份（`appdata` 卷） | 图片要 |
| `worker` | 下载队列消费者 | 与 api 共享 `appdata` | — |
| `init` | 一次性初始化（在 `init` profile 下，**不参与 `up`**） | — | — |

## 起停

起停与首次初始化的命令见主 README 的「部署」一节（服务器形态 `make up` + `make init-compose`，
单机形态换成 `make up-local` + `make init-local`）。这里只记 docker 特有的部分：

- 改了代码之后 `init` 服务不会自动重建，要显式跑一次：

  ```bash
  docker compose --profile init build init && docker compose --profile init run --rm init
  ```

- 提交下载前先在「设置 → Cookie」导入 Cookie，否则任务会失败
- 验证：

  ```bash
  curl -s localhost:8080/api/health
  # {"ok":true,"db":"postgresql+psycopg","search":"manticore","worker":false,"images":true}
  curl -s localhost:8080/api/search/status
  # {"backend":"manticore","fts5":false,"indexedPosts":0,"db":"postgresql+psycopg"}
  ```

## 日常操作

```bash
docker compose logs -f worker          # 看抓取进度
docker compose restart worker          # 改完 .env 里的 Cookie 后重启 worker
docker compose --profile init run --rm init python scripts/build_index.py --reset   # 重建索引
docker compose exec db pg_dump -U xdnmb xdnmb > backup.sql                          # 备份关系库
docker compose exec api python scripts/manage_users.py --user admin --password '新口令'
docker compose down                    # 停止（数据在命名卷里，不会丢）
docker compose down -v                 # 连数据一起删（慎用）
```

## 构建期镜像源与基础镜像

默认已经是国内源，一般不用改；**Docker Hub 不可达时**（`registry-1.docker.io` 会超时）
把基础镜像也指向加速器：

```bash
# .env
NPM_REGISTRY=https://registry.npmmirror.com/           # 默认值
PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple  # 默认值

# Docker Hub 连不上时：
NODE_IMAGE=docker.m.daocloud.io/library/node:20-bookworm-slim
PYTHON_IMAGE=docker.m.daocloud.io/library/python:3.12-slim
```

其它可用的加速器：`docker.1panel.live`、`docker.1ms.run`、`docker.nju.edu.cn`。

## 注意事项

- **HTTPS**：挂在 nginx/caddy 后面时把 `THREAD_READER_COOKIE_SECURE=true`，否则浏览器不保存会话 Cookie。
- **Cookie**：`THREAD_READER_NMB_COOKIE` 只从环境读，不入库、不进镜像；`.env` 已在 `.gitignore` 里。
- **端口**：`XDNMB_PORT` 默认 8080；容器内监听 8080。
- **图片卷**：原图很占空间（一个串 1G 量级不罕见），可以设 `THREAD_READER_IMAGES_ENABLED=false`
  只存链接，访问时回源图床。
- **检索降级**：Manticore 没起来时搜索会自动退回 `LIKE` 并写 warn 日志，阅读/下载不受影响，
  所以 `search` 用 `service_started` 而不是 `service_healthy`，不会把整个栈卡住。
- **重建索引**：任何「搜索结果不对/缺失」的情况，先跑 `build_index.py --reset`——
  索引是派生数据，重建永远安全。

## 排错

```bash
# 端口被占（比如本机还跑着一个 uvicorn）
docker compose up -d --force-recreate api

# 完全重来（会删数据卷）
docker compose down -v && docker compose up -d && docker compose --profile init run --rm init

# 看某个容器日志
docker compose logs -f api|worker|db|search

# 验证数据真的落盘了
docker compose exec api ls -la /app/backend/data /app/backend/data/images
docker compose exec db psql -U xdnmb -d xdnmb -c '\dt'
```
