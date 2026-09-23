#!/usr/bin/env python3
"""账号与邀请码管理（用法见 --help）。"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from app.db import SessionLocal, init_db  # noqa: E402
from app.models import AppUser, InviteCode  # noqa: E402
from app.security import check_password_strength, hash_password  # noqa: E402
from app.services.auth import GROUP_PERMISSIONS, now_ts, unban_user  # noqa: E402


def list_users() -> None:
    with SessionLocal() as db:
        users = db.scalars(select(AppUser).order_by(AppUser.user_id)).all()
        print(f'{"用户名":<16}{"用户组":<10}{"状态":<8}最近登录')
        for user in users:
            banned = user.banned_until and user.banned_until > now_ts()
            state = '已封禁' if banned else '正常'
            print(f'{user.username:<16}{user.group_name:<10}{state:<8}{user.last_login_at or "-"}')


def list_invites() -> None:
    with SessionLocal() as db:
        codes = db.scalars(select(InviteCode).order_by(InviteCode.code)).all()
        for code in codes:
            used = f'{code.used_count}/{code.max_uses or "∞"}'
            print(f'{code.code:<24} 启用={code.enabled} 已用={used} 过期={code.expires_at or "永不"} {code.note or ""}')


def upsert_user(username: str, password: str | None, group: str | None) -> int:
    if password:
        problem = check_password_strength(password)
        if problem:
            print(f'✗ {problem}', file=sys.stderr)
            return 2
    if group and group not in GROUP_PERMISSIONS:
        print(f'✗ 用户组只能是 {"/".join(GROUP_PERMISSIONS)}', file=sys.stderr)
        return 2

    with SessionLocal() as db:
        user = db.scalar(select(AppUser).where(AppUser.username == username))
        if user is None:
            if not password:
                print('✗ 新用户必须给 --password', file=sys.stderr)
                return 2
            user = AppUser(
                username=username,
                password_hash=hash_password(password),
                group_name=group or 'user',
                created_at=now_ts(),
            )
            db.add(user)
            print(f'✓ 已创建用户 {username}（{user.group_name}）')
        else:
            if password:
                user.password_hash = hash_password(password)
                user.failed_count = 0
                user.banned_until = None
                print(f'✓ 已更新 {username} 的密码（顺带解封）')
            if group:
                user.group_name = group
                print(f'✓ 已把 {username} 的用户组设为 {group}')
            if not password and not group:
                print('（没有要改的内容，用 --password / --group）')
        db.commit()
    return 0


def create_invite(code: str, max_uses: int, note: str, days: int) -> int:
    with SessionLocal() as db:
        if db.get(InviteCode, code) is not None:
            print('✗ 邀请码已存在', file=sys.stderr)
            return 2
        db.add(
            InviteCode(
                code=code,
                enabled=True,
                max_uses=max_uses,
                used_count=0,
                expires_at=(now_ts() + days * 86400) if days else 0,
                note=note,
            )
        )
        db.commit()
    print(f'✓ 已创建邀请码 {code}（次数 {max_uses or "不限"}，{"不过期" if not days else f"{days} 天有效"}）')
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description='账号与邀请码管理')
    parser.add_argument('--unban', metavar='用户名', help='解除封禁/停用（唯一管理员被锁时用这个）')
    parser.add_argument('--user', help='用户名')
    parser.add_argument('--password', help='新密码（会做强度校验）')
    parser.add_argument('--group', choices=sorted(GROUP_PERMISSIONS), help='用户组')
    parser.add_argument('--list', action='store_true', help='列出用户')
    parser.add_argument('--invite', help='创建邀请码')
    parser.add_argument('--max-uses', type=int, default=0, help='邀请码可用次数，0 表示不限')
    parser.add_argument('--days', type=int, default=0, help='邀请码有效天数，0 表示不过期')
    parser.add_argument('--note', default='', help='邀请码备注')
    parser.add_argument('--invites', action='store_true', help='列出邀请码')
    args = parser.parse_args()

    init_db()
    if args.list:
        list_users()
        return 0
    if args.invites:
        list_invites()
        return 0
    if args.unban:
        with SessionLocal() as db:
            unban_user(db, args.unban)
        print(f'✓ 已解除 {args.unban} 的封禁/停用')
        return 0
    if args.invite:
        return create_invite(args.invite, args.max_uses, args.note, args.days)
    if args.user:
        return upsert_user(args.user, args.password, args.group)
    parser.print_help()
    return 2


if __name__ == '__main__':
    raise SystemExit(main())
