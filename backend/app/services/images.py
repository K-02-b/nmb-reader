"""图片本地化：存到 `data/images/<串号>/<楼号>.<ext>`，失败不重试，留给访问时回源图床。"""

from __future__ import annotations

import logging
import mimetypes
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import PostBody
from ..settings import settings

log = logging.getLogger('xdnmb.images')

SUFFIXES = ('.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp')


def image_dir(thread_id: int) -> Path:
    path = settings.images_dir / str(thread_id)
    path.mkdir(parents=True, exist_ok=True)
    return path


def guess_ext(url: str) -> str:
    suffix = Path(url.split('?')[0]).suffix.lower()
    return suffix if suffix in SUFFIXES else '.jpg'


def local_path(thread_id: int, post_id: int, url: str = '') -> Path:
    return image_dir(thread_id) / f'{post_id}{guess_ext(url)}'


def find_local(thread_id: int, post_id: int) -> Path | None:
    for suffix in SUFFIXES:
        candidate = settings.images_dir / str(thread_id) / f'{post_id}{suffix}'
        if candidate.is_file() and candidate.stat().st_size > 0:
            return candidate
    return None


def count_pending_images(db: Session, thread_id: int, limit: int = 5000) -> int:
    """还没本地化的图片张数（只查库和文件，不发请求）。"""
    if not settings.images_enabled:
        return 0
    rows = db.execute(
        select(PostBody.id, PostBody.img_source).where(
            PostBody.thread_id == thread_id, PostBody.img_source.is_not(None)
        )
    ).all()
    pending = 0
    for post_id, source in rows[:limit]:
        if not source:
            continue
        target = local_path(thread_id, post_id, source)
        if target.is_file() and target.stat().st_size > 0:
            continue
        pending += 1
    return pending


def fetch_thread_images_progress(
    db: Session,
    thread_id: int,
    cookie: str = '',
    limit: int = 5000,
    concurrency: int | None = None,
    on_progress=None,
) -> tuple[int, int]:
    """拉取该串尚未本地化的图片，返回 (成功张数, 待下载张数)；on_progress 在调用线程回调。"""
    if not settings.images_enabled:
        return 0, 0
    workers = max(1, int(concurrency if concurrency is not None else settings.image_concurrency))
    rows = db.execute(
        select(PostBody.id, PostBody.img_source).where(
            PostBody.thread_id == thread_id, PostBody.img_source.is_not(None)
        )
    ).all()

    pending: list[tuple[int, str, Path]] = []
    for post_id, source in rows[:limit]:
        if not source:
            continue
        target = local_path(thread_id, post_id, source)
        if target.is_file() and target.stat().st_size > 0:
            continue
        pending.append((post_id, source, target))
    total = len(pending)
    if not pending:
        return 0, 0

    from .nmb_parse import HttpSession  # 延迟导入，避免循环依赖

    def one(item: tuple[int, str, Path]) -> bool:
        _post_id, source, target = item
        try:
            with HttpSession(cookie=cookie) as session:
                data = session.get_bytes(source)
        except Exception as exc:  # noqa: BLE001 - 单张失败不影响其它
            log.warning('图片下载失败 %s: %s', source, exc)
            return False
        if not data:
            return False
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return True

    saved = 0
    done = 0
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix='nmb-image') as pool:
        for ok in pool.map(one, pending):
            done += 1
            if ok:
                saved += 1
            if on_progress:
                on_progress(done, total)
    return saved, total


def content_type(path: Path) -> str:
    return mimetypes.guess_type(path.name)[0] or 'image/jpeg'
