#!/usr/bin/env python3
"""建表 + 创建管理员账号。

不带参数时幂等：表已存在就只补建缺失的表。加 --reset 会先删掉所有表再重建（清空数据）。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import Base, SessionLocal, engine, init_db  # noqa: E402
from app.services import auth as auth_service  # noqa: E402
from app.settings import settings  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description='建表并创建管理员账号')
    parser.add_argument('--reset', action='store_true', help='先删掉所有表再重建（会清空数据）')
    args = parser.parse_args()

    if args.reset:
        init_db()
        Base.metadata.drop_all(bind=engine)
    notes = init_db()
    print(f'✓ 建表完成：{settings.db_url}')
    for note in notes:
        print(f'✓ {note}')

    with SessionLocal() as db:
        created = auth_service.bootstrap(db)
    if created:
        source = (
            'THREAD_READER_ADMIN_PASSWORD 里的口令'
            if settings.admin_password != 'admin'
            else 'admin（默认口令，请尽快修改）'
        )
        print(f'✓ 创建账号：{", ".join(created)}｜admin 的口令：{source}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
