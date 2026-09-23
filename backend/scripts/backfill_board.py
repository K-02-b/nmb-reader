#!/usr/bin/env python3
"""回填 thread.board：老数据该列为空，每个串只抓第 1 页解析面包屑。"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import or_, select  # noqa: E402

from app.db import SessionLocal, init_db  # noqa: E402
from app.models import Thread  # noqa: E402
from app.services.nmb_parse import BASE, FetchError, HttpSession, parse_board  # noqa: E402
from app.settings import settings  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit', type=int, default=0, help='最多处理多少个串（0 = 全部）')
    parser.add_argument('--pause', type=float, default=1.2, help='每个请求之间的间隔（秒）')
    parser.add_argument('--dry-run', action='store_true', help='只列出待回填的串，不发请求')
    args = parser.parse_args()

    init_db()
    with SessionLocal() as db:
        stmt = select(Thread).where(or_(Thread.board.is_(None), Thread.board == '')).order_by(Thread.thread_id)
        if args.limit:
            stmt = stmt.limit(args.limit)
        threads = list(db.scalars(stmt))

        if not threads:
            print('没有需要回填的串')
            return 0
        print(f'待回填 {len(threads)} 个串：{[t.thread_id for t in threads]}')
        if args.dry_run:
            return 0

        filled = failed = 0
        with HttpSession(cookie=settings.nmb_cookie) as session:
            for index, thread in enumerate(threads):
                try:
                    html = session.get(f'{BASE}/t/{thread.thread_id}?page=1')
                    board = parse_board(html)
                except FetchError as exc:
                    failed += 1
                    print(f'  No.{thread.thread_id} 抓取失败：{exc}')
                else:
                    if board:
                        thread.board = board[:64]
                        filled += 1
                        print(f'  No.{thread.thread_id} → {board}')
                    else:
                        failed += 1
                        print(f'  No.{thread.thread_id} 解析不出板块（页面结构变了？）')
                if index < len(threads) - 1:
                    time.sleep(args.pause)
            db.commit()

    print(f'完成：回填 {filled} 个，失败/未识别 {failed} 个')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
