#!/usr/bin/env python3
"""重建全文检索索引（FTS5 或 Manticore）。"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import SessionLocal, init_db  # noqa: E402
from app.services import search as search_service  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--thread', type=int, help='只重建某个串')
    parser.add_argument('--reset', action='store_true', help='先清空索引（Manticore 会 TRUNCATE 整表）')
    args = parser.parse_args()

    init_db()
    with SessionLocal() as db:
        backend = search_service.get_backend(db)
        if args.reset:
            if isinstance(backend, search_service.ManticoreBackend):
                backend.ensure_table()
                backend._sql(f'TRUNCATE TABLE {backend.index}')
                print(f'✓ 已清空 Manticore 表 {backend.index}')
            elif isinstance(backend, search_service.Fts5Backend) and backend.available(db):
                from sqlalchemy import text as sql_text

                db.execute(sql_text(f'DELETE FROM {search_service.FTS_TABLE}'))
                db.commit()
                print('✓ 已清空 FTS5 索引')
        if args.thread:
            count = search_service.get_backend(db).index_thread(db, args.thread)
            print(f'✓ No.{args.thread} 索引 {count} 楼')
            return 0
        count = search_service.rebuild_index(db)
    print(f'✓ 索引重建完成：{count} 楼')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
