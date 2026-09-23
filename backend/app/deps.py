"""FastAPI 依赖：当前用户与权限校验。"""

from __future__ import annotations

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from .db import get_db
from .models import AppUser
from .services import auth as auth_service
from .settings import settings


def current_user(request: Request, db: Session = Depends(get_db)) -> AppUser | None:
    token = request.cookies.get(settings.cookie_name)
    return auth_service.resolve_session(db, token)


def require_user(user: AppUser | None = Depends(current_user)) -> AppUser:
    return auth_service.require_user(user)


def require_permission(permission: str):
    def _dependency(user: AppUser = Depends(require_user)) -> AppUser:
        auth_service.require_permission(user, permission)
        return user

    return _dependency


# 模块级单例：FastAPI 依赖可安全复用
require_download = require_permission('thread.download')
require_thread_edit = require_permission('thread.edit')
require_user_manage = require_permission('user.manage')
require_db_manage = require_permission('db.manage')
require_log_view = require_permission('log.view')
