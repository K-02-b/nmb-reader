# 匿名版阅读器一体化镜像：前端构建产物 + FastAPI 后端 + 下载 worker
# api 与 worker 用同一个镜像，只是启动命令不同（见 compose.yaml）。

# 构建期镜像源：默认走国内源，可用 --build-arg / .env 覆盖回官方源
#   pip → 清华（TUNA）；npm → npmmirror（清华的 npm 镜像已下线）
ARG NPM_REGISTRY=https://registry.npmmirror.com/
ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
# 基础镜像也可覆盖：Docker Hub 不可达时指向国内加速器，例如
#   NODE_IMAGE=docker.m.daocloud.io/library/node:20-bookworm-slim
# PDF 导出用的中文字体来自 nmb-exporter，按 commit 固定
ARG NMB_EXPORTER_SHA=76cd82660a00ebb8417257b5c4447f0a16e89282
ARG NODE_IMAGE=node:20-bookworm-slim
ARG PYTHON_IMAGE=python:3.12-slim

# ---------- 阶段 1：构建前端 ----------
FROM ${NODE_IMAGE} AS web
ARG NPM_REGISTRY
WORKDIR /web
RUN npm config set registry "$NPM_REGISTRY"
# 先装依赖，利用层缓存
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --include=dev --include=optional
COPY frontend/ ./
# 生产构建走同源相对路径，不需要 VITE_API_BASE
RUN npm run build

# ---------- 阶段 2：运行时 ----------
FROM ${PYTHON_IMAGE}
ARG PIP_INDEX_URL

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# 抓取需要 TLS 证书；tini 负责正确转发信号（worker 的协作式取消依赖信号处理）
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 只装运行期依赖
COPY backend/requirements.txt ./backend/requirements.txt
RUN if [ -n "$PIP_INDEX_URL" ]; then PIP_ARGS="-i $PIP_INDEX_URL"; fi; \
    pip install --no-cache-dir $PIP_ARGS -r backend/requirements.txt

COPY backend/app ./backend/app
COPY backend/scripts ./backend/scripts
# 中文字体（约 15MB）：仓库里不带，构建时从 nmb-exporter 按 commit 取
ARG NMB_EXPORTER_SHA
RUN mkdir -p /app/backend/app/assets/fonts \
    && python -c "import urllib.request; urllib.request.urlretrieve('https://raw.githubusercontent.com/K-02-b/nmb-exporter/${NMB_EXPORTER_SHA}/fonts/GoNotoCJKCore.ttf', '/app/backend/app/assets/fonts/GoNotoCJKCore.ttf')"
COPY deploy/docker ./deploy/docker
# 前端构建产物：FastAPI 会自动托管 frontend/dist（见 app/main.py）
COPY --from=web /web/dist ./frontend/dist

# 数据目录（SQLite/图片/备份）与运行用户
RUN useradd --system --create-home --uid 10001 xdnmb \
    && mkdir -p /app/backend/data \
    && chown -R xdnmb:xdnmb /app

USER xdnmb
ENV THREAD_READER_DATA_DIR=/app/backend/data \
    PYTHONPATH=/app/backend
WORKDIR /app/backend

EXPOSE 8080

# 健康检查不依赖 curl（slim 镜像没有）
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=3).status==200 else 1)"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
