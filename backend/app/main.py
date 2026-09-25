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
            """带哈希的资源长缓存，其余一律先回源校验。

            否则浏览器会拿旧的 index.html 启发式缓存继续跑旧 JS：部署完了页面还是老样子。
            """
            response = await call_next(request)
            if request.url.path.startswith('/assets/'):
                response.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
            elif not request.url.path.startswith('/api/'):
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
