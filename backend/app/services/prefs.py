"""用户级下载偏好：服务器环境变量是默认值，用户调整的值夹在服务器硬上限内。"""

from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import AppUser, UserSetting
from ..settings import settings

MAX_PAGES_KEY = 'fetch_max_pages'
CONCURRENCY_KEY = 'fetch_concurrency'


def _clamp(value: int | None, ceiling: int) -> int | None:
    """把用户填的值夹到 [1, ceiling]；None/非法值返回 None。"""
    if value is None:
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return max(1, min(number, ceiling))


def clamp(value: int | None) -> int | None:
    return _clamp(value, settings.fetch_max_pages_ceiling)


def clamp_concurrency(value: int | None) -> int | None:
    return _clamp(value, settings.fetch_concurrency_ceiling)


def user_override(db: Session, user_id: int, key: str = MAX_PAGES_KEY) -> int | None:
    row = db.get(UserSetting, (user_id, key))
    if row is None:
        return None
    return clamp(row.value) if key == MAX_PAGES_KEY else clamp_concurrency(row.value)


def effective_for_user(db: Session, username: str) -> tuple[int, int, str]:
    """返回 (页数上限, 并发度, 来源)，供 worker 使用并记日志。"""
    user = db.query(AppUser).filter(AppUser.username == username).first()
    if user is not None:
        max_pages = user_override(db, user.user_id, MAX_PAGES_KEY)
        concurrency = user_override(db, user.user_id, CONCURRENCY_KEY)
        if max_pages is not None or concurrency is not None:
            return (
                max_pages if max_pages is not None else settings.fetch_max_pages,
                concurrency if concurrency is not None else settings.fetch_concurrency,
                'user',
            )
    return settings.fetch_max_pages, settings.fetch_concurrency, 'server'
