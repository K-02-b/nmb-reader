#!/usr/bin/env python3
"""清空内容数据（串 / 楼层 / 标签 / 任务 / 日志 / 图片），保留账号、设置、Cookie、收藏。

不加 --yes 时只预演。
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import delete, func, select  # noqa: E402

from app.db import SessionLocal, init_db  # noqa: E402
from app.models import (  # noqa: E402
    DownloadTask,
    Post,
    PostBody,
    SysLog,
    TagRegistry,
    Thread,
    ThreadTag,
)
from app.settings import settings  # noqa: E402

# 先删引用方，再删被引用方（SQLite 上外键未必开着级联）
TABLES = [
    ('thread_tag', ThreadTag),
    ('tag_registry', TagRegistry),
    ('download_task', DownloadTask),
    ('sys_log', SysLog),
    ('post_body', PostBody),
    ('post', Post),
    ('thread', Thread),
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--yes', action='store_true', help='确认执行（不加则只报告将要删什么）')
    parser.add_argument('--keep-images', action='store_true', help='保留本地图片文件')
    args = parser.parse_args()

    init_db()
    with SessionLocal() as db:
        counts = {name: db.scalar(select(func.count()).select_from(model)) or 0 for name, model in TABLES}

        image_dir = Path(settings.data_dir) / 'images'
        image_files = sum(1 for _ in image_dir.rglob('*')) if image_dir.exists() else 0

        print('将要删除：')
        for name, count in counts.items():
            print(f'  {name:<14} {count} 行')
        if not args.keep_images:
            print(f'  {"images":<14} {image_files} 个文件（{image_dir}）')

        if not args.yes:
            print('\n这是预演。确认无误后加 --yes 执行。')
            return 0

        for _name, model in TABLES:
            db.execute(delete(model))
        db.commit()

        if not args.keep_images and image_dir.exists():
            for entry in image_dir.iterdir():
                shutil.rmtree(entry) if entry.is_dir() else entry.unlink()

    print('\n已清空内容数据。账号、设置、Cookie、收藏都保留。')
    print('检索索引里可能还有这些串的残留，建议接着跑：python scripts/build_index.py --reset')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
