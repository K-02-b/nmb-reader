"""Cookie 的管理与校验：用户自行导入、Fernet 加密、按提交者取用，接口只回状态。"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy.orm import Session

from ..models import AppUser, UserCookie
from ..security import decrypt_secret, encrypt_secret
from ..services.nmb_parse import FetchError, board_url, fetch_html
from ..settings import settings

log = logging.getLogger('xdnmb.cookie')

MAX_COOKIE_LENGTH = 4000  # 正常 Cookie 几百字节；超过这个长度基本是误粘贴


@dataclass
class CookieStatus:
    configured: bool
    source: str  # user | server | none
    updated_at: int | None = None
    verified_at: int | None = None
    verify_ok: bool | None = None
    last_error: str | None = None

    def as_dict(self) -> dict[str, object]:
        return {
            'configured': self.configured,
            'source': self.source,
            'updatedAt': self.updated_at,
            'verifiedAt': self.verified_at,
            'verifyOk': self.verify_ok,
            'lastError': self.last_error,
        }


# ---- 校验 ----
def verify_cookie(cookie: str, timeout: int = 20) -> tuple[bool, str]:
    """访问受限板块，判断 Cookie 是否处于登录态。"""
    value = (cookie or '').strip()
    if not value:
        return False, 'Cookie 不能为空'
    if len(value) > MAX_COOKIE_LENGTH:
        return False, f'Cookie 过长（{len(value)} 字符），看起来不是浏览器里复制的那一段'
    if '=' not in value:
        return False, '格式不像 Cookie（应形如 name=value; name2=value2）'

    url = board_url(settings.cookie_verify_board, page=1)
    try:
        page = fetch_html(url, value, retries=2, timeout=timeout)
    except FetchError as exc:
        return False, f'校验请求失败：{exc}'

    if 'h-threads-item-index' in page:
        return True, 'Cookie 有效（受限板块可正常访问）'
    if len(page) < 3000:
        return False, 'Cookie 无效或已过期（受限板块返回未登录提示页）'
    return False, '无法确认登录状态，请在浏览器里重新复制一份完整的 Cookie'


# ---- 读写 ----
def _row(db: Session, user_id: int) -> UserCookie | None:
    return db.get(UserCookie, user_id)


def status_of(db: Session, user: AppUser) -> CookieStatus:
    row = _row(db, user.user_id)
    if row is not None:
        return CookieStatus(
            configured=True,
            source='user',
            updated_at=row.updated_at,
            verified_at=row.verified_at,
            verify_ok=row.verify_ok,
            last_error=row.last_error,
        )
    if settings.nmb_cookie:
        return CookieStatus(configured=True, source='server', verify_ok=None)
    return CookieStatus(configured=False, source='none')


def save(db: Session, user: AppUser, cookie: str, verify: bool = True) -> CookieStatus:
    """保存（覆盖）用户的 Cookie，默认顺手校验一次。"""
    from .auth import log as write_log
    from .auth import now_ts

    value = (cookie or '').strip()
    ok: bool | None = None
    message: str | None = None
    if verify:
        ok, message = verify_cookie(value)

    ts = now_ts()
    row = _row(db, user.user_id)
    if row is None:
        row = UserCookie(user_id=user.user_id, created_at=ts)
        db.add(row)
    row.ciphertext = encrypt_secret(value)
    row.updated_at = ts
    row.verified_at = ts if verify else None
    row.verify_ok = ok
    row.last_error = None if ok else message
    db.commit()

    write_log(
        db,
        'info' if ok else 'warn',
        'auth',
        f'用户 {user.username} 更新了 Cookie（{"校验通过" if ok else "校验未通过"}）',
        user.user_id,
    )
    return status_of(db, user)


def verify_saved(db: Session, user: AppUser) -> CookieStatus:
    """重新校验已保存的 Cookie。"""
    from .auth import now_ts

    row = _row(db, user.user_id)
    if row is None:
        return status_of(db, user)
    plain = decrypt_secret(row.ciphertext)
    if plain is None:
        row.verify_ok = False
        row.last_error = '无法解密（服务端密钥已更换），请重新导入'
        row.verified_at = now_ts()
        db.commit()
        return status_of(db, user)
    ok, message = verify_cookie(plain)
    row.verified_at = now_ts()
    row.verify_ok = ok
    row.last_error = None if ok else message
    db.commit()
    return status_of(db, user)


def clear(db: Session, user: AppUser) -> CookieStatus:
    from .auth import log as write_log

    row = _row(db, user.user_id)
    if row is not None:
        db.delete(row)
        db.commit()
        write_log(db, 'warn', 'auth', f'用户 {user.username} 清除了 Cookie', user.user_id)
    return status_of(db, user)


def decrypt_for_user(db: Session, username: str) -> tuple[str | None, str]:
    """worker 用：取某用户可用的 Cookie 明文，返回 (cookie, 来源 user/server/none)。"""
    user = db.query(AppUser).filter(AppUser.username == username).first()
    if user is not None:
        row = _row(db, user.user_id)
        if row is not None:
            plain = decrypt_secret(row.ciphertext)
            if plain:
                return plain, 'user'
            log.warning('用户 %s 的 Cookie 解密失败（密钥可能已更换）', username)
    if settings.nmb_cookie:
        return settings.nmb_cookie, 'server'
    return None, 'none'
