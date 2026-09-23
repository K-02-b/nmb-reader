# 裸机部署：systemd + nginx

形态：`nginx → uvicorn(app.main) → SQLite`，另起一个 `app.worker` 进程消费下载队列。
低配 VPS（1 核 1G）足够；换 PostgreSQL / MySQL 与 Manticore 见第 7、8 节。

## 0. 目录约定

```text
/opt/xdnmb-reader/
├── backend/
│   ├── .venv/
│   └── data/           # SQLite 数据库 + 图片 + 备份
├── frontend/
│   └── dist/           # 前端构建产物（由 FastAPI 直接托管）
└── .env                # 环境变量（模板见 deploy/systemd/xdnmb.env.example）
```

## 1. 拉取代码 + 准备环境

```bash
sudo apt update
sudo apt install -y python3 python3-venv nginx git
sudo useradd --system --home /opt/xdnmb-reader --shell /usr/sbin/nologin xdnmb
sudo mkdir -p /opt/xdnmb-reader
sudo chown -R $USER:$USER /opt/xdnmb-reader

git clone https://github.com/K-02-b/nmb-reader.git /opt/xdnmb-reader
cd /opt/xdnmb-reader
```

装后端依赖：

```bash
cd /opt/xdnmb-reader/backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt      # 国内机器慢就加 -i https://pypi.tuna.tsinghua.edu.cn/simple
```

## 2. 构建前端

```bash
cd /opt/xdnmb-reader/frontend
npm install --include=dev --include=optional
npm run build          # 产物在 frontend/dist，FastAPI 会自动托管
```

生产模式下前端与 API 同源，不需要 Vite 代理，也不需要设置 `VITE_API_BASE`。

## 3. 初始化数据库与账号

```bash
cd /opt/xdnmb-reader/backend
cp ../deploy/systemd/xdnmb.env.example ../.env   # 然后按需修改
.venv/bin/python scripts/init_db.py              # 建表 + 建管理员
.venv/bin/python scripts/build_index.py          # 建全文索引（FTS5）
```

首次启动会创建 `admin`，口令取 `THREAD_READER_ADMIN_PASSWORD`（未设置时为 `admin`）。**上线前务必改掉**
（也可以在「设置 → 账户与权限」里自助改）：

```bash
.venv/bin/python scripts/manage_users.py --user admin --password '你的新密码'
.venv/bin/python scripts/manage_users.py --invite CODE --max-uses 1 --note '给某某'   # 需要注册时
.venv/bin/python scripts/manage_users.py --unban admin                               # 管理员被封/停用时
```

## 4. 配置 systemd

```bash
sudo cp deploy/systemd/xdnmb-api.service deploy/systemd/xdnmb-worker.service /etc/systemd/system/
sudo cp .env /opt/xdnmb-reader/.env
sudo chown -R xdnmb:xdnmb /opt/xdnmb-reader
sudo systemctl daemon-reload
sudo systemctl enable --now xdnmb-api xdnmb-worker
sudo systemctl status xdnmb-api
```

两个服务共用一个数据库：API 只处理请求，worker 负责下载/入库/建索引。
状态机见 [`../docs/state-machine.md`](../docs/state-machine.md)。

## 5. 配置 nginx

```bash
sudo cp deploy/nginx/xdnmb-reader.conf /etc/nginx/sites-available/xdnmb-reader
sudo ln -sf /etc/nginx/sites-available/xdnmb-reader /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

HTTPS 用 certbot：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d reader.example.com
```

启用 HTTPS 后，把 `.env` 里的 `THREAD_READER_COOKIE_SECURE` 设为 `true`。

## 6. Cookie

推荐让每个用户在前端「设置 → Cookie」里导入自己的（加密存库，按提交者取用，接口不回显）。
支持直接粘贴 Cookie 头，也支持上传二维码图片。服务端只需要一个加密主密钥：

```bash
# .env（留空则自动生成 data/secret.key，权限 600）
THREAD_READER_SECRET_KEY=$(python3 -c "import secrets;print(secrets.token_urlsafe(48))")
```

自用实例也可以配一个服务器级兜底：

```bash
THREAD_READER_NMB_COOKIE='PHPSESSID=...; memberUserspapapa=...; userhash=...'
```

- 两者可共存：**用户自己导入的优先**
- 校验方式：访问受限板块「速报2」——匿名只能拿到没有串列表的提示页；每次下载前也会自动预检
- 长串（例如 840 页）是正常的，页数上限 `THREAD_READER_FETCH_MAX_PAGES` 默认 2000，按需调大
- 建议用专用小号，别用主号

## 7. 可选：PostgreSQL + Manticore

多人使用或数据量较大时换成这套。

```bash
# 1) PostgreSQL
sudo apt install -y postgresql-16 postgresql-contrib-16
sudo -u postgres psql -c "CREATE ROLE xdnmb LOGIN PASSWORD 'xdnmb';"
sudo -u postgres createdb -O xdnmb xdnmb

# 2) Manticore（官方源；国内机器加 -4 走 IPv4）
wget -4 https://repo.manticoresearch.com/manticore-repo.noarch.deb
sudo dpkg -i manticore-repo.noarch.deb && sudo apt update && sudo apt install -y manticore

# 3) 建 Manticore 表：中文按单字切分，任意子串都能命中
curl -s -X POST 'http://127.0.0.1:9308/sql?mode=raw' --data-urlencode \
  "query=CREATE TABLE IF NOT EXISTS xdnmb_posts (content text, thread_id bigint, post_id bigint) ngram_len='1' ngram_chars='cjk' charset_table='non_cjk'"

# 4) .env
# THREAD_READER_DB_URL=postgresql+psycopg://xdnmb:xdnmb@127.0.0.1:5432/xdnmb
# THREAD_READER_SEARCH_BACKEND=manticore
# THREAD_READER_MANTICORE_URL=http://127.0.0.1:9308

# 5) 建表、推索引
.venv/bin/python scripts/init_db.py              # 建表 + 建管理员
.venv/bin/python scripts/build_index.py --reset  # 清空并重建 Manticore 索引
```

验证：

```bash
curl -s localhost:8080/api/search/status
# {"backend":"manticore","fts5":false,"indexedPosts":0,"db":"postgresql+psycopg"}
```

注意点：

- `thread_tag.single_type` 生成列用 **STORED**（PG 不支持 VIRTUAL），三种库通用
- 备份/恢复接口只覆盖 SQLite；PG 请用 `pg_dump`（调用会返回 `501 BACKUP_UNSUPPORTED`，不会静默失败）
- Manticore 挂掉时检索自动退回 `LIKE` 并写 warn 日志，阅读页不会整体不可用
- 用 `scripts/build_index.py --reset` 重建，避免残留旧文档

## 8. 可选：MySQL

```bash
sudo apt install -y mysql-server
sudo mysql -e "CREATE DATABASE xdnmb CHARACTER SET utf8mb4; CREATE USER 'xdnmb'@'127.0.0.1' IDENTIFIED BY 'password'; GRANT ALL ON xdnmb.* TO 'xdnmb'@'127.0.0.1';"
```

```ini
# .env
THREAD_READER_DB_URL=mysql+pymysql://xdnmb:password@127.0.0.1/xdnmb?charset=utf8mb4
THREAD_READER_SEARCH_BACKEND=manticore
```

`.venv/bin/pip install pymysql`，然后照常用 `scripts/init_db.py` 建表、`scripts/build_index.py` 推索引。

## 9. 运维要点

| 事项 | 做法 |
| --- | --- |
| 备份 | 管理页「数据库管理 → 备份」，或直接拷 `backend/data/app-*.db` |
| 恢复 | 管理页「从备份恢复」（SQLite），恢复后重启 `xdnmb-api` |
| 清理 | 管理页「清理孤立数据」（删孤儿楼层 + VACUUM） |
| 日志 | 管理页「日志」，或 `journalctl -u xdnmb-api -u xdnmb-worker -f` |
| 图片 | 存在 `backend/data/images/<串号>/<楼号>.<ext>`，缺失时接口 302 到岛图床 |
| 导出 | `GET /api/threads/<串号>/export?format=md\|json` |
| 磁盘 | 图片是大头；`THREAD_READER_IMAGES_ENABLED=false` 可只存链接 |

## 10. 常见问题

- **登录后立刻掉线**：HTTPS 下必须 `THREAD_READER_COOKIE_SECURE=true`，HTTP 下必须为 `false`。
- **下载一直失败**：先看日志里是不是 Cookie 校验未通过；Cookie 里的特殊字符要原样带 `%`。
- **任务卡在 downloading**：worker 没跑（`systemctl status xdnmb-worker`）；重启后任务会被重新排队。
- **SSE 不推送**：nginx 没关 `proxy_buffering`，用仓库里的 `deploy/nginx/xdnmb-reader.conf`。
