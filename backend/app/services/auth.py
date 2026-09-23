"""用户、会话、邀请码、建议修正与系统日志的服务层。"""

from __future__ import annotations

import re
import secrets
import time

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..errors import ApiError, conflict, forbidden, not_found, unauthorized
from ..models import AppUser, InviteCode, SysLog, ThreadSuggestion, UserSession
from ..security import USERNAME_RE, check_password_strength, hash_password, new_session_token, verify_password
from ..settings import settings

# 管理员「停用」用这个哨兵值：等于把封禁时间设在未来很远，等同于永久停用（不用加字段、不用迁移）
DISABLED_UNTIL = 2**31 - 1

GROUP_PERMISSIONS: dict[str, list[str]] = {
    'admin': ['thread.download', 'thread.edit', 'user.manage', 'db.manage', 'log.view'],
    'editor': ['thread.download', 'thread.edit', 'log.view'],
    'user': ['thread.download'],
}


def now_ts() -> int:
    return int(time.time())


def permissions_of(group: str) -> list[str]:
    return GROUP_PERMISSIONS.get(group, GROUP_PERMISSIONS['user'])


def log(db: Session, level: str, scope: str, message: str, user_id: int | None = None) -> None:
    db.add(SysLog(ts=now_ts(), level=level, scope=scope, user_id=user_id, message=message[:1024]))
    db.commit()


# ---- 会话 ----
def create_session(db: Session, user: AppUser) -> str:
    token = new_session_token()
    ts = now_ts()
    db.add(UserSession(token=token, user_id=user.user_id, created_at=ts, expires_at=ts + settings.session_ttl))
    db.commit()
    return token


def resolve_session(db: Session, token: str | None) -> AppUser | None:
    if not token:
        return None
    row = db.execute(
        select(UserSession, AppUser)
        .join(AppUser, AppUser.user_id == UserSession.user_id)
        .where(UserSession.token == token)
    ).first()
    if row is None:
        return None
    session, user = row
    if session.expires_at < now_ts() or (user.banned_until and user.banned_until > now_ts()):
        # 过期的会话、以及被停用/封禁账号的会话，一律作废
        if user.banned_until and user.banned_until > now_ts():
            db.execute(delete(UserSession).where(UserSession.user_id == user.user_id))
        else:
            db.execute(delete(UserSession).where(UserSession.token == token))
        db.commit()
        return None
    return user


def destroy_session(db: Session, token: str | None) -> None:
    if not token:
        return
    db.execute(delete(UserSession).where(UserSession.token == token))
    db.commit()


def prune_sessions(db: Session) -> int:
    result = db.execute(delete(UserSession).where(UserSession.expires_at < now_ts()))
    db.commit()
    return result.rowcount or 0


# ---- 注册 / 登录 ----
def register(db: Session, username: str, password: str, invite_code: str) -> AppUser:
    username = username.strip()
    if not re.match(USERNAME_RE, username):
        raise ApiError('用户名需 3-32 位，仅允许字母、数字、_、-', 'BAD_USERNAME')
    problem = check_password_strength(password)
    if problem:
        raise ApiError(problem, 'BAD_PASSWORD')
    if db.scalar(select(AppUser).where(AppUser.username == username)) is not None:
        raise conflict('用户名已存在', 'USER_EXISTS')

    invite = db.get(InviteCode, invite_code.strip())
    if invite is None or not invite.enabled:
        raise ApiError('邀请码无效', 'BAD_INVITE')
    if invite.expires_at and invite.expires_at < now_ts():
        raise ApiError('邀请码已过期', 'INVITE_EXPIRED')
    if invite.max_uses > 0 and invite.used_count >= invite.max_uses:
        raise ApiError('邀请码使用次数已达上限', 'INVITE_EXHAUSTED')

    user = AppUser(
        username=username,
        password_hash=hash_password(password),
        group_name='user',
        created_at=now_ts(),
        failed_count=0,
    )
    db.add(user)
    invite.used_count += 1
    db.commit()
    log(db, 'info', 'auth', f'新用户 {username} 注册成功（邀请码 {invite.code}）', user.user_id)
    return user


def change_password(db: Session, user: AppUser, current: str, new: str) -> None:
    """本人改密码：要验旧密码，改完把其它会话都踢掉（当前这次会话由调用方重新建）。"""
    if not verify_password(current, user.password_hash):
        raise ApiError('当前密码不正确', 'BAD_CREDENTIALS')
    problem = check_password_strength(new)
    if problem:
        raise ApiError(problem, 'BAD_PASSWORD')
    if verify_password(new, user.password_hash):
        raise ApiError('新密码不能和当前密码相同', 'SAME_PASSWORD')
    user.password_hash = hash_password(new)
    user.failed_count = 0
    db.execute(delete(UserSession).where(UserSession.user_id == user.user_id))
    db.commit()
    log(db, 'warn', 'auth', f'用户 {user.username} 修改了密码', user.user_id)


def login(db: Session, username: str, password: str) -> AppUser:
    user = db.scalar(select(AppUser).where(AppUser.username == username.strip()))
    if user is None:
        raise not_found('用户不存在', 'USER_NOT_FOUND')
    ts = now_ts()
    if user.banned_until and user.banned_until > ts:
        if is_disabled(user):
            raise ApiError('账号已被管理员停用，请联系管理员', 'BANNED', 423)
        remaining = max(1, (user.banned_until - ts) // 3600 + 1)
        raise ApiError(f'账号被封禁，请 {remaining} 小时后再试', 'BANNED', 423)
    if not verify_password(password, user.password_hash):
        user.failed_count += 1
        if user.failed_count >= settings.login_fail_limit:
            user.banned_until = ts + settings.login_ban_seconds
            user.failed_count = 0
            db.commit()
            log(db, 'warn', 'auth', f'用户 {user.username} 连续登录失败，已封禁 1 天', user.user_id)
            raise ApiError('登录失败次数过多，账号已封禁 1 天', 'BANNED', 423)
        db.commit()
        left = max(0, settings.login_fail_limit - user.failed_count)
        raise ApiError(f'用户名或密码错误（再错 {left} 次将临时封禁账号）', 'BAD_CREDENTIALS')
    user.failed_count = 0
    user.banned_until = None
    user.last_login_at = ts
    db.commit()
    log(db, 'info', 'auth', f'用户 {user.username} 登录成功', user.user_id)
    return user


# ---- 权限 ----
def require_user(user: AppUser | None) -> AppUser:
    if user is None:
        raise unauthorized()
    return user


def has_permission(user: AppUser, permission: str) -> bool:
    if user.banned_until and user.banned_until > now_ts():
        return False
    return permission in permissions_of(user.group_name)


def require_permission(user: AppUser, permission: str) -> None:
    if not has_permission(user, permission):
        raise forbidden(f'需要权限：{permission}')


# ---- 用户管理 ----
def is_disabled(user: AppUser) -> bool:
    """管理员手动停用（区别于登录失败触发的临时封禁）。"""
    return bool(user.banned_until and user.banned_until >= DISABLED_UNTIL)


def list_users(db: Session) -> list[AppUser]:
    return list(db.scalars(select(AppUser).order_by(AppUser.user_id)))


def create_user(db: Session, username: str, password: str, group: str = 'user', actor_id: int | None = None) -> AppUser:
    """管理员直接建号（不走邀请码）。校验规则与注册一致。"""
    username = username.strip()
    if not re.match(USERNAME_RE, username):
        raise ApiError('用户名需 3-32 位，仅允许字母、数字、_、-', 'BAD_USERNAME')
    problem = check_password_strength(password)
    if problem:
        raise ApiError(problem, 'BAD_PASSWORD')
    if group not in GROUP_PERMISSIONS:
        raise ApiError('用户组不合法', 'BAD_GROUP')
    if db.scalar(select(AppUser).where(AppUser.username == username)) is not None:
        raise conflict('用户名已存在', 'USER_EXISTS')

    user = AppUser(
        username=username,
        password_hash=hash_password(password),
        group_name=group,
        created_at=now_ts(),
        failed_count=0,
    )
    db.add(user)
    db.commit()
    log(db, 'warn', 'auth', f'管理员新建用户 {username}（{group}）', actor_id)
    return user


def unban_user(db: Session, username: str) -> AppUser:
    """清掉封禁/停用状态（命令行兜底：唯一的管理员被封时前端没人能解锁）。"""
    user = db.scalar(select(AppUser).where(AppUser.username == username.strip()))
    if user is None:
        raise not_found('用户不存在', 'USER_NOT_FOUND')
    user.banned_until = None
    user.failed_count = 0
    db.execute(delete(UserSession).where(UserSession.user_id == user.user_id))
    db.commit()
    log(db, 'warn', 'auth', f'用户 {username} 的封禁已被解除')
    return user


def delete_user(db: Session, username: str, actor: AppUser) -> None:
    """删除账号；不能删自己，也不能删最后一个管理员。"""
    user = db.scalar(select(AppUser).where(AppUser.username == username))
    if user is None:
        raise not_found('用户不存在', 'USER_NOT_FOUND')
    if user.user_id == actor.user_id:
        raise forbidden('不能删除当前登录的账号', 'CANNOT_DELETE_SELF')
    if (
        user.group_name == 'admin'
        and db.scalar(select(func.count()).select_from(AppUser).where(AppUser.group_name == 'admin')) <= 1
    ):
        raise forbidden('至少要保留一个管理员', 'CANNOT_DELETE_LAST_ADMIN')
    db.delete(user)
    db.commit()
    log(db, 'warn', 'auth', f'管理员 {actor.username} 删除了用户 {username}', actor.user_id)


def update_user(db: Session, username: str, group: str | None, banned: bool | None) -> AppUser:
    user = db.scalar(select(AppUser).where(AppUser.username == username))
    if user is None:
        raise not_found('用户不存在', 'USER_NOT_FOUND')
    # 管理员账号冻结：既不能封禁、也不能改用户组。
    # user.manage 只有管理员有，所以这同时意味着「管理员之间不能互相封禁/降级」，
    # 也就保证了系统里始终至少有一个管理员，不会被锁死。
    if user.group_name == 'admin':
        if banned:
            raise forbidden('管理员账号不能被封禁；要先取消其管理员身份才能封禁', 'CANNOT_BAN_ADMIN')
        if group is not None and group != 'admin':
            raise forbidden(
                '管理员账号不能被降级；确需变更请用 scripts/manage_users.py --user <用户名> --group <组>',
                'CANNOT_CHANGE_ADMIN_GROUP',
            )
    if group is not None:
        if group not in GROUP_PERMISSIONS:
            raise ApiError('用户组不合法', 'BAD_GROUP')
        user.group_name = group
    if banned is not None:
        # 管理员停用 = 一直停到手动启用；登录失败的临时封禁另有 login() 自己处理
        user.banned_until = DISABLED_UNTIL if banned else None
        user.failed_count = 0
    db.commit()
    log(db, 'warn', 'auth', f'用户 {username} 的用户组/状态被修改')
    return user


# ---- 邀请码 ----
def list_invites(db: Session) -> list[InviteCode]:
    return list(db.scalars(select(InviteCode).order_by(InviteCode.code)))


def create_invite(
    db: Session, code: str, max_uses: int, days: int, note: str = '', actor_id: int | None = None
) -> InviteCode:
    code = (code or '').strip() or secrets.token_hex(8)
    if len(code) > 64:
        raise ApiError('邀请码最长 64 个字符', 'BAD_INVITE_CODE')
    if db.get(InviteCode, code) is not None:
        raise conflict('邀请码已存在', 'INVITE_EXISTS')
    invite = InviteCode(
        code=code,
        enabled=True,
        max_uses=max(0, max_uses),
        used_count=0,
        expires_at=(now_ts() + days * 86400) if days > 0 else 0,
        note=(note or '')[:255] or None,
    )
    db.add(invite)
    db.commit()
    log(
        db,
        'warn',
        'auth',
        f'新建邀请码 {code}（次数 {max_uses or "不限"}，{"不过期" if not days else f"{days} 天"}）',
        actor_id,
    )
    return invite


def update_invite(
    db: Session,
    code: str,
    enabled: bool | None = None,
    max_uses: int | None = None,
    days: int | None = None,
    note: str | None = None,
) -> InviteCode:
    invite = db.get(InviteCode, code)
    if invite is None:
        raise not_found('邀请码不存在', 'INVITE_NOT_FOUND')
    if enabled is not None:
        invite.enabled = enabled
    if max_uses is not None:
        invite.max_uses = max(0, max_uses)
    if days is not None:
        # days = 0 表示不过期；重新设置有效期从当下算起
        invite.expires_at = (now_ts() + days * 86400) if days > 0 else 0
    if note is not None:
        invite.note = note[:255] or None
    db.commit()
    log(db, 'warn', 'auth', f'邀请码 {code} 已更新（启用={invite.enabled}，次数上限={invite.max_uses}）')
    return invite


def delete_invite(db: Session, code: str, actor_id: int | None = None) -> None:
    invite = db.get(InviteCode, code)
    if invite is None:
        raise not_found('邀请码不存在', 'INVITE_NOT_FOUND')
    db.delete(invite)
    db.commit()
    log(db, 'warn', 'auth', f'删除了邀请码 {code}', actor_id)


# ---- 建议修正 ----
def add_suggestion(db: Session, thread_id: int, user_id: int, kind: str, detail: str) -> None:
    db.add(
        ThreadSuggestion(
            thread_id=thread_id,
            user_id=user_id,
            kind=(kind or '其他')[:32],
            detail=(detail or '')[:512],
            created_at=now_ts(),
        )
    )
    db.commit()
    log(db, 'info', 'suggest', f'No.{thread_id} 建议修正（{kind}）：{detail[:80]}', user_id)


def bootstrap(db: Session) -> list[str]:
    """保证至少有一个管理员，返回本次新建或恢复的用户名。"""
    if db.scalar(select(AppUser).where(AppUser.group_name == 'admin')) is not None:
        return []

    # 没有任何管理员了：如果 admin 账号还在（只是被别人降级过），就地恢复，
    # 否则新建。这里不能直接 INSERT admin —— 用户名已存在会让整个实例起不来。
    existing = db.scalar(select(AppUser).where(AppUser.username == 'admin'))
    if existing is not None:
        existing.group_name = 'admin'
        db.commit()
        log(db, 'warn', 'auth', 'admin 账号不是管理员，已自动恢复为管理员（否则实例将没有管理员）')
        return ['admin']

    db.add(
        AppUser(
            username='admin',
            password_hash=hash_password(settings.admin_password),
            group_name='admin',
            created_at=now_ts(),
        )
    )
    db.commit()
    if settings.admin_password == 'admin':
        log(db, 'warn', 'auth', '已创建默认管理员 admin/admin，请尽快改密码')
    else:
        log(db, 'info', 'auth', '已创建管理员 admin（口令来自 THREAD_READER_ADMIN_PASSWORD）')
    return ['admin']
