"""数据导入：把抓取结果写入关系库；重复导入同一串会覆盖其 post / post_body / thread_tag。"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..models import Post, PostBody, TagRegistry, Thread, ThreadTag

log = logging.getLogger('xdnmb.importer')

SINGLE_TYPES = {'genre', 'series', 'status', 'installment'}


@dataclass
class ImportResult:
    thread_id: int
    posts: int
    images: int
    tags: int


def _get_registry(db: Session, tag_type: str, tag_name: str) -> TagRegistry:
    registry = db.scalar(select(TagRegistry).where(TagRegistry.tag_type == tag_type, TagRegistry.tag_name == tag_name))
    if registry is None:
        registry = TagRegistry(tag_type=tag_type, tag_name=tag_name)
        db.add(registry)
        db.flush()
    return registry


def import_thread_payload(db: Session, payload: dict, replace: bool = True) -> ImportResult:
    """payload = {"thread": Thread, "posts": Post[]}；replace=False 时只 upsert 本次带来的楼层。"""
    thread_data = payload['thread']
    posts_data = payload['posts']
    thread_id = int(thread_data['threadId'])

    if replace:
        db.execute(delete(PostBody).where(PostBody.thread_id == thread_id))
        db.execute(delete(Post).where(Post.thread_id == thread_id))
        db.execute(delete(ThreadTag).where(ThreadTag.thread_id == thread_id))
        db.flush()

    image_count = 0
    for raw in posts_data:
        post = Post(
            thread_id=thread_id,
            id=int(raw['id']),
            cookie=(raw.get('cookie') or '')[:16],
            page_num=int(raw.get('pageNum') or 0),
            is_po=bool(raw.get('isPo')),
            is_sage=bool(raw.get('isSage')),
            is_admin=bool(raw.get('isAdmin')),
            created_at=int(raw.get('createdAt') or 0),
        )
        body = PostBody(
            thread_id=thread_id,
            id=post.id,
            content=raw.get('content') or '',
            img=raw.get('img'),
            img_source=raw.get('imgSource'),
            title=raw.get('title'),
            name=raw.get('name'),
        )
        if body.img:
            image_count += 1
        db.merge(post)
        db.merge(body)

    thread = db.get(Thread, thread_id)
    if thread is None:
        thread = Thread(thread_id=thread_id)
        db.add(thread)
    thread.cookie = (thread_data.get('cookie') or '')[:16]
    # 增量更新时可能解析不到板块，只在解析到时覆盖
    board = (thread_data.get('board') or '').strip()
    if board:
        thread.board = board[:64]
    thread.replies = int(thread_data.get('replies') or max(len(posts_data) - 1, 0))
    thread.is_sage = bool(thread_data.get('isSage'))
    thread.is_admin = bool(thread_data.get('isAdmin'))
    thread.installment = thread_data.get('installment')
    thread.created_at = int(thread_data.get('createdAt') or 0)
    thread.updated_at = int(thread_data.get('updatedAt') or thread.created_at)

    existing_pages = int(thread.page_count or 0)
    new_pages = int(thread_data.get('pageCount') or 0)
    thread.page_count = new_pages if replace else max(existing_pages, new_pages)
    existing_images = int(thread.image_count or 0)
    new_images = int(thread_data.get('imageCount') or image_count)
    thread.image_count = new_images if replace else max(existing_images, new_images)
    if not replace:
        # 增量：按实际 post 数重算回复数
        total_posts = db.scalar(select(func.count()).select_from(Post).where(Post.thread_id == thread_id)) or 0
        thread.replies = int(total_posts) - 1

    tag_count = 0
    for tag in (thread_data.get('tags') or []) if replace else []:
        tag_type = tag.get('tagType') or 'CUSTOM_TAG'
        tag_name = (tag.get('tagName') or '').strip()
        if not tag_name:
            continue
        if tag_type in SINGLE_TYPES:
            existing = db.scalars(
                select(ThreadTag).where(ThreadTag.thread_id == thread_id, ThreadTag.tag_type == tag_type)
            ).all()
            for row in existing:  # 每串每类只保留一个
                db.delete(row)
        registry = _get_registry(db, tag_type, tag_name)
        db.merge(ThreadTag(thread_id=thread_id, tag_id=registry.tag_id, tag_type=tag_type))
        tag_count += 1

    db.commit()

    # 索引是派生数据，失败不影响入库
    try:
        from . import search as search_service

        search_service.index_thread(db, thread_id)
    except Exception as exc:  # noqa: BLE001
        log.warning('index No.%s failed: %s', thread_id, exc)

    log.info('imported No.%s: %s posts / %s images / %s tags', thread_id, len(posts_data), image_count, tag_count)
    return ImportResult(thread_id=thread_id, posts=len(posts_data), images=image_count, tags=tag_count)
