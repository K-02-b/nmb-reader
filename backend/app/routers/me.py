"""个人数据：书签、阅读进度、用户设置、黑名单。"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, File, Path, UploadFile
from pydantic import ConfigDict, Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require_user
from ..errors import ApiError, not_found
from ..models import (
    AppUser,
    BlacklistCookie,
    BlacklistThread,
    Bookmark,
    ReadProgress,
    Thread,
    UserSetting,
)
from ..schemas import BookmarkOut, CamelModel, CookieStatusOut, OkResponse, UserSettingsOut, to_camel
from ..services import cookies as cookie_service
from ..services import prefs as prefs_service
from ..services import qrcode as qrcode_service
from ..services import threads as thread_service
from ..services.auth import now_ts

logger = logging.getLogger('xdnmb.me')

router = APIRouter(prefix='/api', tags=['me'])

SETTING_TYPES: dict[str, type] = {
    'font_size': float,
    'line_height': float,
    'brightness': float,
    'page_size': int,
    'fetch_max_pages': int,
    'fetch_concurrency': int,
}

# 布尔项要单独解析：bool('false') 是 True
SETTING_BOOLS = {'export_images'}

SETTING_KEYS = (
    'theme',
    'accent',
    'font_size',
    'font_family',
    'line_height',
    'brightness',
    'page_size',
    'paging_mode',
    'fetch_max_pages',
    'fetch_concurrency',
    # 上次导出时选的「是否带图 / 图片质量」，记住下次默认
    'export_images',
    'export_quality',
)


def _to_bool(value: str) -> bool:
    return value.strip().lower() in ('1', 'true', 'yes', 'on')


class SettingsIn(CamelModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra='ignore')

    theme: str | None = None
    accent: str | None = None
    font_size: float | None = None
    font_family: str | None = None
    line_height: float | None = None
    brightness: float | None = None
    page_size: int | None = Field(None, ge=5, le=200)
    paging_mode: str | None = Field(None, pattern='^(island|custom)$')
    # 夹到 [1, 服务器硬上限]，越界取边界值
    fetch_max_pages: int | None = Field(None, ge=1)
    fetch_concurrency: int | None = Field(None, ge=1)
    export_images: bool | None = None
    export_quality: str | None = Field(None, pattern='^(high|medium|low)$')
    blacklist_cookies: list[str] | None = None
    blacklist_threads: list[int] | None = None


class ProgressIn(CamelModel):
    page: int = Field(1, ge=1)


class CookieIn(CamelModel):
    """用户导入的 Cookie；只入不出。"""

    cookie: str = Field(min_length=1, max_length=4000)
    verify: bool = True


# ---- 用户设置 ----
def _read_settings(db: Session, user: AppUser) -> UserSettingsOut:
    rows = db.execute(select(UserSetting.key_name, UserSetting.value).where(UserSetting.user_id == user.user_id)).all()
    raw = {key: value for key, value in rows}
    out = UserSettingsOut()
    for key in SETTING_KEYS:
        if key not in raw:
            continue
        coerce = SETTING_TYPES.get(key, str)  # 显式声明类型，不能靠默认值的 type()（15 是 int、15.0 才是 float）
        try:
            value = _to_bool(raw[key]) if key in SETTING_BOOLS else coerce(raw[key])
            if key in ('fetch_max_pages', 'fetch_concurrency'):
                value = prefs_service.clamp(value)
            setattr(out, key, value)
        except (TypeError, ValueError):
            continue
    out.blacklist_cookies = list(
        db.scalars(
            select(BlacklistCookie.cookie)
            .where(BlacklistCookie.user_id == user.user_id)
            .order_by(BlacklistCookie.cookie)
        )
    )
    out.blacklist_threads = list(
        db.scalars(
            select(BlacklistThread.thread_id)
            .where(BlacklistThread.user_id == user.user_id)
            .order_by(BlacklistThread.thread_id)
        )
    )
    return out


def _write_setting(db: Session, user_id: int, key: str, value: str) -> None:
    row = db.get(UserSetting, (user_id, key))
    if row is None:
        db.add(UserSetting(user_id=user_id, key_name=key, value=value))
    else:
        row.value = value


@router.get('/settings', response_model=UserSettingsOut, summary='读取个人设置（多端同步）')
def get_settings(db: Session = Depends(get_db), user: AppUser = Depends(require_user)) -> UserSettingsOut:
    return _read_settings(db, user)


@router.put('/settings', response_model=UserSettingsOut, summary='保存个人设置')
def put_settings(
    payload: SettingsIn, db: Session = Depends(get_db), user: AppUser = Depends(require_user)
) -> UserSettingsOut:
    for key in SETTING_KEYS:
        if key not in payload.model_fields_set:
            continue
        value = getattr(payload, key)
        if key in ('fetch_max_pages', 'fetch_concurrency'):
            # null 表示清除个人覆盖，回到服务器默认
            clamped = prefs_service.clamp(value) if key == 'fetch_max_pages' else prefs_service.clamp_concurrency(value)
            if clamped is None:
                row = db.get(UserSetting, (user.user_id, key))
                if row is not None:
                    db.delete(row)
            else:
                _write_setting(db, user.user_id, key, str(clamped))
            continue
        if value is not None:
            coerce = SETTING_TYPES.get(key, str)
            _write_setting(db, user.user_id, key, str(coerce(value)))
    if payload.blacklist_cookies is not None:
        db.execute(delete(BlacklistCookie).where(BlacklistCookie.user_id == user.user_id))
        for cookie in {c.strip().upper() for c in payload.blacklist_cookies if c.strip()}:
            db.add(BlacklistCookie(user_id=user.user_id, cookie=cookie[:16]))
    if payload.blacklist_threads is not None:
        db.execute(delete(BlacklistThread).where(BlacklistThread.user_id == user.user_id))
        for thread_id in {int(t) for t in payload.blacklist_threads if t}:
            db.add(BlacklistThread(user_id=user.user_id, thread_id=thread_id))
    db.commit()
    return _read_settings(db, user)


# ---- 书签 ----
@router.get('/bookmarks', response_model=list[BookmarkOut], summary='我的书签')
def list_bookmarks(db: Session = Depends(get_db), user: AppUser = Depends(require_user)) -> list[BookmarkOut]:
    rows = list(
        db.scalars(select(Bookmark).where(Bookmark.user_id == user.user_id).order_by(Bookmark.created_at.desc()))
    )
    items: list[BookmarkOut] = []
    for bookmark in rows:
        thread = thread_service.get_thread(db, bookmark.thread_id)
        items.append(
            BookmarkOut(
                thread_id=bookmark.thread_id,
                title=thread.title if thread else f'No.{bookmark.thread_id}',
                page=bookmark.page_num,
                created_at=bookmark.created_at,
            )
        )
    return items


@router.post('/bookmarks/{thread_id}/toggle', response_model=bool, summary='收藏/取消收藏')
def toggle_bookmark(thread_id: int, db: Session = Depends(get_db), user: AppUser = Depends(require_user)) -> bool:
    existing = db.get(Bookmark, (user.user_id, thread_id))
    if existing is not None:
        db.delete(existing)
        db.commit()
        return False
    if db.get(Thread, thread_id) is None:
        raise not_found('串不存在', 'THREAD_NOT_FOUND')
    db.add(Bookmark(user_id=user.user_id, thread_id=thread_id, page_num=1, created_at=now_ts()))
    db.commit()
    return True


# ---- 阅读进度 ----
@router.get('/progress', response_model=dict, summary='我的阅读进度')
def list_progress(db: Session = Depends(get_db), user: AppUser = Depends(require_user)) -> dict:
    rows = db.execute(
        select(ReadProgress.thread_id, ReadProgress.page_num).where(ReadProgress.user_id == user.user_id)
    ).all()
    return {'items': [{'threadId': thread_id, 'page': page} for thread_id, page in rows]}


@router.put('/progress/{thread_id}', response_model=OkResponse, summary='记录阅读进度')
def put_progress(
    thread_id: int,
    payload: ProgressIn,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
) -> OkResponse:
    row = db.get(ReadProgress, (user.user_id, thread_id))
    if row is None:
        db.add(ReadProgress(user_id=user.user_id, thread_id=thread_id, page_num=payload.page, updated_at=now_ts()))
    else:
        row.page_num = payload.page
        row.updated_at = now_ts()
    db.commit()
    return OkResponse()


# ---- 黑名单 ----
@router.post('/blacklist/cookies/{cookie}', response_model=OkResponse, summary='屏蔽饼干')
def block_cookie(
    cookie: str = Path(min_length=1, max_length=16),
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
) -> OkResponse:
    value = cookie.strip().upper()
    if db.get(BlacklistCookie, (user.user_id, value)) is None:
        db.add(BlacklistCookie(user_id=user.user_id, cookie=value))
        db.commit()
    return OkResponse()


@router.delete('/blacklist/cookies/{cookie}', response_model=OkResponse, summary='解除饼干屏蔽')
def unblock_cookie(cookie: str, db: Session = Depends(get_db), user: AppUser = Depends(require_user)) -> OkResponse:
    row = db.get(BlacklistCookie, (user.user_id, cookie.upper()))
    if row is not None:
        db.delete(row)
        db.commit()
    return OkResponse()


@router.post('/blacklist/threads/{thread_id}', response_model=OkResponse, summary='屏蔽串')
def block_thread(thread_id: int, db: Session = Depends(get_db), user: AppUser = Depends(require_user)) -> OkResponse:
    if db.get(BlacklistThread, (user.user_id, thread_id)) is None:
        db.add(BlacklistThread(user_id=user.user_id, thread_id=thread_id))
        db.commit()
    return OkResponse()


@router.delete('/blacklist/threads/{thread_id}', response_model=OkResponse, summary='解除串屏蔽')
def unblock_thread(thread_id: int, db: Session = Depends(get_db), user: AppUser = Depends(require_user)) -> OkResponse:
    row = db.get(BlacklistThread, (user.user_id, thread_id))
    if row is not None:
        db.delete(row)
        db.commit()
    return OkResponse()


# ---- Cookie（用户自行导入；密文入库，接口不回显） ----
@router.get('/me/nmb-cookie', response_model=CookieStatusOut, summary='我的 Cookie 状态')
def get_cookie_status(db: Session = Depends(get_db), user: AppUser = Depends(require_user)) -> CookieStatusOut:
    return CookieStatusOut(**cookie_service.status_of(db, user).as_dict())


@router.put('/me/nmb-cookie', response_model=CookieStatusOut, summary='导入/更新我的 Cookie')
def put_cookie(
    payload: CookieIn, db: Session = Depends(get_db), user: AppUser = Depends(require_user)
) -> CookieStatusOut:
    status = cookie_service.save(db, user, payload.cookie, verify=payload.verify)
    return CookieStatusOut(**status.as_dict())


@router.post('/me/nmb-cookie/verify', response_model=CookieStatusOut, summary='重新校验已保存的 Cookie')
def verify_cookie(db: Session = Depends(get_db), user: AppUser = Depends(require_user)) -> CookieStatusOut:
    return CookieStatusOut(**cookie_service.verify_saved(db, user).as_dict())


@router.post(
    '/me/nmb-cookie/qrcode',
    response_model=CookieStatusOut,
    summary='从二维码图片导入 Cookie（扫码导入）',
)
async def put_cookie_from_qrcode(
    image: UploadFile = File(..., description='包含 cookie 的二维码图片（PNG/JPG）'),
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
) -> CookieStatusOut:
    """上传二维码图片 → 解码 → 加密保存并校验；图片只在内存里处理。"""
    data = await image.read()
    try:
        parsed = qrcode_service.parse_qr_image(data)
    except qrcode_service.QrDecodeError as exc:
        raise ApiError(str(exc), 'QR_DECODE_FAILED') from exc

    status = cookie_service.save(db, user, parsed.cookie, verify=True)
    if parsed.name:
        logger.info('用户 %s 通过二维码导入 Cookie（二维码标注的饼干 ID：%s）', user.username, parsed.name)
    return CookieStatusOut(**status.as_dict(), label=parsed.name or None)


@router.delete('/me/nmb-cookie', response_model=CookieStatusOut, summary='清除我的 Cookie')
def delete_cookie(db: Session = Depends(get_db), user: AppUser = Depends(require_user)) -> CookieStatusOut:
    return CookieStatusOut(**cookie_service.clear(db, user).as_dict())
