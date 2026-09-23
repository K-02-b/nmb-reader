# 匿名版阅读器 —— 常用命令入口
#
#   make            # 显示所有可用目标
#   make setup      # 建虚拟环境 + 装后端依赖 + 装前端依赖
#   make dev        # 单机 SQLite + FTS5，一条命令起服务
#   make up         # Docker Compose：PostgreSQL + Manticore + api + worker
#
# 需要本机已有：python3(>=3.11)、node(>=18)、npm；Docker 相关目标额外需要 docker compose。

SHELL := /bin/bash
BACKEND := backend
FRONTEND := frontend
VENV := $(BACKEND)/.venv
PY := $(VENV)/bin/python
PIP := $(VENV)/bin/pip
COMPOSE ?= docker compose
COMPOSE_LOCAL ?= docker compose -f compose.sqlite.yaml
# PDF 导出的中文字体复用 nmb-exporter 的，按这个 commit 取
NMB_EXPORTER_SHA ?= 76cd82660a00ebb8417257b5c4447f0a16e89282

.DEFAULT_GOAL := help

.PHONY: help setup setup-backend setup-frontend build dev \
        init-db build-index users reset-data reparse backfill-board fetch-fonts lint-md \
        up init-compose up-local init-local down logs logs-local ps clean

help: ## 显示所有目标
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# --------------------------------------------------------------------------- #
# 安装与构建
# --------------------------------------------------------------------------- #
setup: setup-backend setup-frontend ## 安装全部依赖

setup-backend: ## 建 venv、装后端依赖并取回导出用的中文字体
	python3 -m venv $(VENV)
	$(PIP) install -U pip
	$(PIP) install -r $(BACKEND)/requirements.txt
	$(MAKE) fetch-fonts

setup-frontend: ## 安装前端依赖
	cd $(FRONTEND) && npm install --include=dev --include=optional

build: ## 构建前端产物（后端会直接托管 frontend/dist）
	cd $(FRONTEND) && npm run build

fetch-fonts: ## 下载 PDF 导出用的中文字体（15MB，复用 nmb-exporter）
	mkdir -p $(BACKEND)/app/assets/fonts
	curl -fsSL -o $(BACKEND)/app/assets/fonts/GoNotoCJKCore.ttf \
	  https://raw.githubusercontent.com/K-02-b/nmb-exporter/$(NMB_EXPORTER_SHA)/fonts/GoNotoCJKCore.ttf
	@echo "✓ 已就位：$(BACKEND)/app/assets/fonts/GoNotoCJKCore.ttf"

# --------------------------------------------------------------------------- #
# 单机直跑（零外部依赖：SQLite + FTS5）
# --------------------------------------------------------------------------- #
dev: ## 建表并启动后端（SQLite + FTS5，托管前端构建产物）
	cd $(BACKEND) && .venv/bin/python scripts/init_db.py
	cd $(BACKEND) && .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8080 --reload

# --------------------------------------------------------------------------- #
# 数据维护
# --------------------------------------------------------------------------- #
init-db: ## 建表 + 建管理员（幂等；加 ARGS="--reset" 会清空数据重建）
	cd $(BACKEND) && .venv/bin/python scripts/init_db.py $(ARGS)

build-index: ## 重建全文索引（FTS5 或 Manticore）
	cd $(BACKEND) && .venv/bin/python scripts/build_index.py $(ARGS)

users: ## 账号与邀请码管理（用法：make users ARGS="--list"）
	cd $(BACKEND) && .venv/bin/python scripts/manage_users.py $(ARGS)

reset-data: ## 清空内容数据，保留账号与设置（用法：make reset-data ARGS="--yes"）
	cd $(BACKEND) && .venv/bin/python scripts/reset_data.py $(ARGS)

reparse: ## 按当前解析规则重刷已入库的正文（用法：make reparse ARGS="--thread 59775198"）
	cd $(BACKEND) && .venv/bin/python scripts/reparse.py $(ARGS)

backfill-board: ## 给老数据回填板块（每个串只抓第 1 页）
	cd $(BACKEND) && .venv/bin/python scripts/backfill_board.py $(ARGS)

# --------------------------------------------------------------------------- #
# Docker Compose
# --------------------------------------------------------------------------- #
up: ## 【服务器】构建并启动 PostgreSQL + Manticore + api + worker
	$(COMPOSE) build
	$(COMPOSE) up -d
	@echo "→ http://127.0.0.1:$${XDNMB_PORT:-$$(grep -E '^XDNMB_PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '[:space:]')}（端口见 .env；首次部署先跑 make init-compose）"

init-compose: ## 【服务器】容器首次初始化：建表 + 管理员 + 重建检索索引
	# init 服务在 profile 后面，up --build 不会重建它，这里显式构建，否则它会一直用旧镜像
	$(COMPOSE) --profile init build init
	$(COMPOSE) --profile init run --rm init

up-local: ## 【单机】构建并启动 SQLite + FTS5 形态的 api + worker
	$(COMPOSE_LOCAL) build
	$(COMPOSE_LOCAL) up -d
	@echo "→ http://127.0.0.1:$${XDNMB_PORT:-$$(grep -E '^XDNMB_PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '[:space:]')}（端口见 .env；首次部署先跑 make init-local）"

init-local: ## 【单机】容器首次初始化：建表 + 管理员 + 建 FTS5 索引
	$(COMPOSE_LOCAL) --profile init build init
	$(COMPOSE_LOCAL) run --rm init

down: ## 停止容器（保留数据卷）
	$(COMPOSE) down
	$(COMPOSE_LOCAL) down

logs: ## 跟踪服务器形态的 worker 日志
	$(COMPOSE) logs -f worker

logs-local: ## 跟踪单机形态的 worker 日志
	$(COMPOSE_LOCAL) logs -f worker

ps: ## 查看容器状态
	$(COMPOSE) ps
	$(COMPOSE_LOCAL) ps

lint-md: ## 检查 markdown 写法（npx markdownlint-cli2，规则见 .markdownlint.json）
	npx --yes markdownlint-cli2 "*.md" "docs/*.md" "deploy/**/*.md"

clean: ## 删除前端构建产物与 Python 缓存（不动数据库与图片）
	rm -rf $(FRONTEND)/dist
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
