"""FastAPI 应用装配。路由注册顺序：API → 静态资源 → SPA 回退。"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .db import SessionLocal, init_db
from .errors import install_error_handlers, not_found
from .gzip import GzipMiddleware
from .routers import admin as admin_router
from .routers import assets as assets_router
from .routers import auth as auth_router
from .routers import downloads as downloads_router
from .routers import me as me_router
from .routers import search as search_router
from .routers import threads as threads_router
from .services import auth as auth_service
from .settings import REPO_ROOT, settings

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s %(message)s')
# httpx 每个请求都打 INFO，压到 WARNING
logging.getLogger('httpx').setLevel(logging.WARNING)
logging.getLogger('httpcore').setLevel(logging.WARNING)

log = logging.getLogger('xdnmb.app')


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    init_db()
    with SessionLocal() as db:
        created = auth_service.bootstrap(db)
        if created:
            log.warning('bootstrap 创建/恢复账号：%s', ', '.join(created))
        auth_service.prune_sessions(db)

    stop_event = None
    if settings.worker_enabled:
        # 单机可随 API 起 worker 线程；生产建议独立进程
        from .worker import start_background_worker

        stop_event = start_background_worker()
        log.info('内置 worker 已启动（THREAD_READER_WORKER_ENABLED=false 可关闭）')
    yield
    if stop_event is not None:
        stop_event.set()


def create_app() -> FastAPI:
    app = FastAPI(
        title='匿名版阅读器',
        version='0.1.0',
        description='X岛数据阅读器后端',
        lifespan=lifespan,
    )
    install_error_handlers(app)

    # 该压的压（JSON / 文本 / JS / CSS / SVG），图片与导出原样走，理由见 app/gzip.py
    app.add_middleware(GzipMiddleware)

    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_credentials=True,
            allow_methods=['*'],
            allow_headers=['*'],
        )

    # ---------------- API ----------------
    app.include_router(auth_router.router)
    app.include_router(me_router.router)
    app.include_router(admin_router.router)
    app.include_router(assets_router.router)
    app.include_router(downloads_router.router)
    app.include_router(search_router.router)
    app.include_router(threads_router.router)

    @app.get('/api/health', tags=['meta'], summary='健康检查')
    def health() -> dict[str, object]:
        return {
            'ok': True,
            'db': settings.db_url.split('://')[0],
            'search': settings.search_backend,
            'worker': settings.worker_enabled,
            'images': settings.images_enabled,
        }

    # ---------------- 前端静态产物 ----------------
    dist = REPO_ROOT / 'frontend' / 'dist'
    if dist.is_dir():
        assets = dist / 'assets'
        if assets.is_dir():
            app.mount('/assets', StaticFiles(directory=assets), name='assets')

        @app.middleware('http')
        async def cache_headers(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
            """按路径分档设置缓存策略。

            /assets/      文件名带内容哈希              → 长缓存，immutable
            /favicon.ico  根目录图标，没有内容哈希       → 短 TTL（边缘能缓存，换图后一天内生效）
            /api/         动态、含会话数据              → 明确禁止缓存（no-store）
            其余          SPA 回退，都是同一份 index.html → 必须回源校验，
                          否则重新部署后浏览器拿旧 index.html 去请求已不存在的旧 JS。
            """
            response = await call_next(request)
            path = request.url.path
            if path.startswith('/assets/'):
                # 文件名带内容哈希，可以长缓存
                response.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
            elif path == '/favicon.ico':
                # 没有内容哈希，所以给短 TTL：既能被浏览器和 CDN 边缘缓存，
                # 换了图标最多一天也就生效了。（再往根目录放静态文件就照这条加分支）
                response.headers['Cache-Control'] = 'public, max-age=86400'
            elif path.startswith('/api/'):
                # 接口一律显式禁止缓存。正文/检索/会话相关，不写的话响应没有任何缓存头，
                # 浏览器和中间代理可能按启发式规则把 GET 响应缓存下来。
                response.headers['Cache-Control'] = 'no-store'
            else:
                # SPA 回退：任意路径都返回同一份 index.html，必须回源校验，
                # 否则重新部署后前端还拿着旧 index.html 去请求已经不存在的旧 JS（白屏）。
                response.headers['Cache-Control'] = 'no-cache'
            return response

        @app.get('/{full_path:path}', include_in_schema=False)
        def spa(full_path: str) -> FileResponse:
            """SPA 回退：前端路由交给 index.html，未知 /api 仍返回 404。"""
            if full_path.startswith('api/'):
                raise not_found('接口不存在', 'NOT_FOUND')
            candidate = (dist / full_path).resolve()
            if full_path and candidate.is_file() and str(candidate).startswith(str(dist.resolve())):
                return FileResponse(candidate)
            return FileResponse(dist / 'index.html')

    return app


app = create_app()
