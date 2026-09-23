#!/usr/bin/env python3
"""按当前解析规则重刷已入库的正文：重新抓一遍页面，只更新变化的 post_body.content。

抓取规则修好之后（例如换行处理），老数据的正文不会自己变，用这个脚本补齐。
跑完记得执行 `make build-index`：正文变了，全文索引要重建。
"""

from __future__ import annotations

import argparse
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import func, select  # noqa: E402

from app.db import SessionLocal, init_db  # noqa: E402
from app.models import Post, PostBody, Thread  # noqa: E402
from app.services.cookies import decrypt_for_user  # noqa: E402
from app.services.nmb_parse import BASE, FetchError, HttpSession, parse_page  # noqa: E402


def page_count(db, thread_id: int) -> int:
    return int(db.scalar(select(func.max(Post.page_num)).where(Post.thread_id == thread_id)) or 1)


def reparse(db, thread_id: int, cookie: str, pause: float, workers: int, from_page: int = 1, retries: int = 2) -> int:
    """重刷一个串的正文，返回改动的楼层数；抓失败的页会再补抓几轮。"""
    known = dict(db.execute(select(PostBody.id, PostBody.content).where(PostBody.thread_id == thread_id)).all())
    changed = 0

    with HttpSession(cookie=cookie) as session:

        def fetch(number: int) -> tuple[int, list[dict]]:
            """只抓取 + 解析；SQLAlchemy 的 Session 不是线程安全的，写库留在主线程做。"""
            time.sleep(pause)  # 每个通道自己的间隔
            html = session.get(f'{BASE}/t/{thread_id}?page={number}')
            op, replies = parse_page(html, thread_id, number)
            return number, ([op] if op else []) + replies

        def run(pages: list[int], round_no: int) -> list[int]:
            """跑一轮，返回这一轮抓失败的页。"""
            nonlocal changed
            failed: list[int] = []
            total = len(pages)
            with ThreadPoolExecutor(max_workers=max(1, workers), thread_name_prefix='nmb-reparse') as pool:
                futures = {pool.submit(fetch, number): number for number in pages}
                for done, future in enumerate(as_completed(futures), start=1):
                    try:
                        _number, posts = future.result()
                    except FetchError as exc:
                        failed.append(futures[future])
                        print(f'  第 {futures[future]} 页抓取失败：{exc}')
                        continue
                    for post in posts:
                        post_id, content = post['id'], post['content']
                        if known.get(post_id) == content:
                            continue
                        row = db.get(PostBody, (thread_id, post_id))
                        if row is None:
                            continue
                        row.content = content
                        known[post_id] = content
                        changed += 1
                    if done % 50 == 0 or done == total:
                        db.commit()
                        print(f'  第 {round_no} 轮 {done}/{total} 页，累计更新 {changed} 楼')
            db.commit()
            return failed

        pages = list(range(max(1, from_page), page_count(db, thread_id) + 1))
        for round_no in range(1, retries + 2):
            if not pages:
                break
            failed = run(pages, round_no)
            if not failed:
                break
            print(f'  这一轮有 {len(failed)} 页没抓到，重试：{failed}')
            pages = failed
    return changed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--thread', type=int, action='append', default=[], help='串号，可重复；省略 = 全部串')
    parser.add_argument('--user', default='admin', help='用哪个账号的 Cookie 抓取')
    parser.add_argument('--pause', type=float, default=1.0, help='每个抓取通道的间隔（秒）')
    parser.add_argument('--concurrency', type=int, default=4, help='并发通道数')
    parser.add_argument('--from-page', type=int, default=1, help='从第几页开始（上次抓失败的页可以补抓）')
    parser.add_argument('--retries', type=int, default=2, help='抓失败的页再补抓几轮')
    parser.add_argument('--dry-run', action='store_true', help='只列出要处理的串，不发请求')
    args = parser.parse_args()

    init_db()
    with SessionLocal() as db:
        targets = [t for t in (args.thread or list(db.scalars(select(Thread.thread_id)))) if db.get(Thread, t)]
        if not targets:
            print('没有需要处理的串')
            return 0
        print(f'待重刷 {len(targets)} 个串：{targets}')
        if args.dry_run:
            return 0

        cookie, _source = decrypt_for_user(db, args.user)
        if not cookie:
            print(f'账号 {args.user} 没有可用的 Cookie，先到「设置 → 账号与权限」导入')
            return 1

        total = 0
        for thread_id in targets:
            pages = page_count(db, thread_id)
            print(f'No.{thread_id}（{pages} 页）')
            total += reparse(db, thread_id, cookie, args.pause, args.concurrency, args.from_page, args.retries)

    print(f'完成：共更新 {total} 楼正文。正文变了，记得跑一次 make build-index 重建索引')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
