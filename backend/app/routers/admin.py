"""用户与权限、日志、服务器开关（需要相应权限）。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Response
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require_log_view, require_user, require_user_manage
from ..models import AppUser, InviteCode, SysLog
from ..schemas import CamelModel, InviteOut, LogOut, UserOut
from ..services import auth as auth_service
from ..settings import settings

router = APIRouter(prefix='/api', tags=['admin'])


class UserPatch(CamelModel):
    group: str | None = None
    banned: bool | None = None


class UserCreate(CamelModel):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=1, max_length=128)
    group: str = 'user'


class InviteCreate(CamelModel):
    """code 留空就自动生成一个随机码。"""

    code: str = ''
    max_uses: int = Field(0, ge=0, le=100000)
    days: int = Field(0, ge=0, le=3650)
    note: str = ''


class InvitePatch(CamelModel):
    enabled: bool | None = None
    max_uses: int | None = Field(None, ge=0, le=100000)
    days: int | None = Field(None, ge=0, le=3650)
    note: str | None = None


def _invite_out(invite: InviteCode) -> InviteOut:
    return InviteOut(
        code=invite.code,
        enabled=invite.enabled,
        max_uses=invite.max_uses,
        used_count=invite.used_count,
        expires_at=invite.expires_at,
        note=invite.note,
    )


def _user_out(user: AppUser) -> UserOut:
    ts = auth_service.now_ts()
    return UserOut(
        username=user.username,
        group=user.group_name,
        created_at=user.created_at,
        last_login_at=user.last_login_at or 0,
        banned=bool(user.banned_until and user.banned_until > ts),
    )


@router.get('/users', response_model=list[UserOut], summary='用户列表（user.manage）')
def list_users(db: Session = Depends(get_db), _user: AppUser = Depends(require_user_manage)) -> list[UserOut]:
    return [_user_out(user) for user in auth_service.list_users(db)]


@router.post('/users', response_model=UserOut, status_code=201, summary='新建用户（user.manage）')
def create_user(
    payload: UserCreate,
    db: Session = Depends(get_db),
    actor: AppUser = Depends(require_user_manage),
) -> UserOut:
    return _user_out(auth_service.create_user(db, payload.username, payload.password, payload.group, actor.user_id))


@router.delete('/users/{username}', status_code=204, summary='删除用户（user.manage）')
def delete_user(
    username: str,
    db: Session = Depends(get_db),
    actor: AppUser = Depends(require_user_manage),
) -> Response:
    auth_service.delete_user(db, username, actor)
    return Response(status_code=204)


@router.patch('/users/{username}', response_model=UserOut, summary='修改用户组 / 封禁（user.manage）')
def patch_user(
    username: str,
    payload: UserPatch,
    db: Session = Depends(get_db),
    _user: AppUser = Depends(require_user_manage),
) -> UserOut:
    return _user_out(auth_service.update_user(db, username, payload.group, payload.banned))


@router.get('/invites', response_model=list[InviteOut], summary='邀请码列表（user.manage）')
def list_invites(db: Session = Depends(get_db), _user: AppUser = Depends(require_user_manage)) -> list[InviteOut]:
    return [_invite_out(invite) for invite in auth_service.list_invites(db)]


@router.post('/invites', response_model=InviteOut, status_code=201, summary='新建邀请码（user.manage）')
def create_invite(
    payload: InviteCreate,
    db: Session = Depends(get_db),
    actor: AppUser = Depends(require_user_manage),
) -> InviteOut:
    invite = auth_service.create_invite(db, payload.code, payload.max_uses, payload.days, payload.note, actor.user_id)
    return _invite_out(invite)


@router.patch('/invites/{code}', response_model=InviteOut, summary='启用 / 停用 / 改次数与有效期（user.manage）')
def patch_invite(
    code: str,
    payload: InvitePatch,
    db: Session = Depends(get_db),
    _user: AppUser = Depends(require_user_manage),
) -> InviteOut:
    invite = auth_service.update_invite(db, code, payload.enabled, payload.max_uses, payload.days, payload.note)
    return _invite_out(invite)


@router.delete('/invites/{code}', status_code=204, summary='删除邀请码（user.manage）')
def delete_invite(
    code: str,
    db: Session = Depends(get_db),
    actor: AppUser = Depends(require_user_manage),
) -> Response:
    auth_service.delete_invite(db, code, actor.user_id)
    return Response(status_code=204)


@router.get('/logs', response_model=list[LogOut], summary='系统日志（log.view）')
def list_logs(
    limit: int = Query(100, ge=1, le=500),
    scope: str | None = Query(None, max_length=32, description='按模块筛选'),
    level: str | None = Query(None, pattern='^(info|warn|error)$', description='按级别筛选'),
    db: Session = Depends(get_db),
    _user: AppUser = Depends(require_log_view),
) -> list[LogOut]:
    stmt = select(SysLog)
    if scope:
        stmt = stmt.where(SysLog.scope == scope)
    if level:
        stmt = stmt.where(SysLog.level == level)
    rows = db.scalars(stmt.order_by(SysLog.ts.desc(), SysLog.log_id.desc()).limit(limit))
    return [LogOut(ts=row.ts, level=row.level, scope=row.scope, message=row.message) for row in rows]


class MetaOut(CamelModel):
    """前端需要的服务器侧限制与开关（不含任何敏感信息）。"""

    fetch_max_pages_default: int
    fetch_max_pages_ceiling: int
    fetch_concurrency_default: int
    fetch_concurrency_ceiling: int
    images_enabled: bool
    search_backend: str


@router.get('/meta', response_model=MetaOut, summary='服务器限制与开关（登录可见）')
def meta(_user: AppUser = Depends(require_user)) -> MetaOut:
    return MetaOut(
        fetch_max_pages_default=settings.fetch_max_pages,
        fetch_max_pages_ceiling=settings.fetch_max_pages_ceiling,
        fetch_concurrency_default=settings.fetch_concurrency,
        fetch_concurrency_ceiling=settings.fetch_concurrency_ceiling,
        images_enabled=settings.images_enabled,
        search_backend=settings.search_backend,
    )
