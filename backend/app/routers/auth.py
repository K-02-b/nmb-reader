"""认证接口：登录 / 注册 / 注销 / 当前用户。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import current_user
from ..errors import unauthorized
from ..models import AppUser
from ..schemas import SessionOut
from ..services import auth as auth_service
from ..settings import settings

router = APIRouter(prefix='/api/auth', tags=['auth'])


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=32)
    password: str = Field(min_length=1, max_length=128)


class PasswordIn(BaseModel):
    current_password: str = Field(alias='currentPassword', min_length=1, max_length=128)
    new_password: str = Field(alias='newPassword', min_length=6, max_length=128)


class RegisterIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)  # 具体规则由服务层给 BAD_USERNAME
    password: str = Field(min_length=6, max_length=128)
    invite_code: str = Field(alias='inviteCode', min_length=1, max_length=64)


def _session_out(user: AppUser) -> SessionOut:
    return SessionOut(
        username=user.username,
        group=user.group_name,
        permissions=auth_service.permissions_of(user.group_name),
    )


def _set_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        settings.cookie_name,
        token,
        max_age=settings.session_ttl,
        httponly=True,
        samesite='lax',
        secure=settings.cookie_secure,
        path='/',
    )


@router.post('/login', response_model=SessionOut, summary='登录')
def login(payload: LoginIn, response: Response, db: Session = Depends(get_db)) -> SessionOut:
    user = auth_service.login(db, payload.username, payload.password)
    token = auth_service.create_session(db, user)
    _set_cookie(response, token)
    return _session_out(user)


@router.post('/register', status_code=204, summary='注册（需要邀请码）')
def register(payload: RegisterIn, db: Session = Depends(get_db)) -> Response:
    auth_service.register(db, payload.username, payload.password, payload.invite_code)
    return Response(status_code=204)


@router.post('/logout', status_code=204, summary='注销')
def logout(request: Request, response: Response, db: Session = Depends(get_db)) -> Response:
    auth_service.destroy_session(db, request.cookies.get(settings.cookie_name))
    response.delete_cookie(settings.cookie_name, path='/')
    return Response(status_code=204)


@router.put('/password', response_model=SessionOut, summary='修改自己的登录密码')
def change_password(
    payload: PasswordIn,
    response: Response,
    db: Session = Depends(get_db),
    user: AppUser | None = Depends(current_user),
) -> SessionOut:
    if user is None:
        raise unauthorized()
    auth_service.change_password(db, user, payload.current_password, payload.new_password)
    # 旧会话全部作废，给当前这次重新发一个，免得改完自己被踢出去
    token = auth_service.create_session(db, user)
    _set_cookie(response, token)
    return _session_out(user)


@router.get('/me', response_model=SessionOut | None, summary='当前登录用户（未登录返回 null）')
def me(user: AppUser | None = Depends(current_user)) -> SessionOut | None:
    # 未登录也返回 200 + null：前端启动时会探一次，没必要在控制台刷 401
    return _session_out(user) if user is not None else None
