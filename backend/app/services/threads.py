"""串查询：目录、阅读、标签词汇表、引用跳转。目录查询不碰正文，只取串首前 200 字做摘要。"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Select, String, and_, func, or_, select
from sqlalchemy.orm import Session

from ..models import Post, PostBody, PostBookmark, TagRegistry, Thread, ThreadTag
from ..schemas import PostBookmarkOut, PostOut, TagOut, TagVocabulary, ThreadOut
from .auth import now_ts
from .search import query_terms

# 排序字段 + 是否倒序；串号是同值时的次级排序，保证分页与「第几条」一致
SORT_FIELDS: dict[str, tuple[Any, bool]] = {
    'updated_desc': (Thread.updated_at, True),
    'created_desc': (Thread.created_at, True),
    'created_asc': (Thread.created_at, False),
    'replies_desc': (Thread.replies, True),
}


def sort_clause(sort: str) -> tuple[Any, bool]:
    return SORT_FIELDS.get(sort, SORT_FIELDS['updated_desc'])


@dataclass
class ThreadQuery:
    keyword: str | None = None
    thread_id: int | None = None
    board: str | None = None
    cookie: str | None = None
    genre: str | None = None
    series: str | None = None
    status: str | None = None
    tags: list[str] | None = None
    bookmarked_only: bool = False
    user_id: int | None = None
    sort: str = 'updated_desc'
    page: int = 1
    page_size: int = 20


def _excerpt(content: str, limit: int = 90) -> str:
    return re.sub(r'\s+', ' ', content or '').strip()[:limit]


def thread_out(thread: Thread, op: PostBody, tags: list[TagOut]) -> ThreadOut:
    title = (op.title or '').strip() if op else ''
    if not title and op and op.content:
        for line in op.content.splitlines():
            if line.strip():
                title = line.strip()[:40]
                break
    return ThreadOut(
        thread_id=thread.thread_id,
        board=thread.board,
        cookie=thread.cookie,
        replies=thread.replies,
        is_sage=thread.is_sage,
        is_admin=thread.is_admin,
        installment=float(thread.installment) if thread.installment is not None else None,
        created_at=thread.created_at,
        updated_at=thread.updated_at,
        title=title or f'No.{thread.thread_id}',
        excerpt=_excerpt(op.content if op else ''),
        img=(op.img if op else None),
        tags=tags,
        reply_count=thread.replies,
        image_count=thread.image_count,
        page_count=thread.page_count,
    )


def _tags_by_thread(db: Session, thread_ids: list[int]) -> dict[int, list[TagOut]]:
    if not thread_ids:
        return {}
    rows = db.execute(
        select(ThreadTag.thread_id, TagRegistry.tag_id, TagRegistry.tag_type, TagRegistry.tag_name)
        .join(TagRegistry, TagRegistry.tag_id == ThreadTag.tag_id)
        .where(ThreadTag.thread_id.in_(thread_ids))
        .order_by(ThreadTag.thread_id, TagRegistry.tag_id)
    ).all()
    result: dict[int, list[TagOut]] = {}
    for thread_id, tag_id, tag_type, tag_name in rows:
        result.setdefault(thread_id, []).append(TagOut(tag_id=tag_id, tag_type=tag_type, tag_name=tag_name))
    return result


def thread_conditions(query: ThreadQuery) -> list[Any]:
    """目录筛选条件，全部落在 `thread` 表上（关键词/标签走 IN 子查询）。

    这样分页和计数都不必 join `post_body`——深分页时那个 join 会把 198 万行的正文表扫一遍。
    """
    conditions: list[Any] = []
    if query.board:
        conditions.append(Thread.board.like(f'%{query.board}%'))
    if query.thread_id:
        # 串号很长，按片段模糊匹配
        conditions.append(func.cast(Thread.thread_id, String).like(f'%{query.thread_id}%'))
    if query.cookie:
        conditions.append(Thread.cookie == query.cookie)
    for term in query_terms(query.keyword or ''):
        like = f'%{term}%'
        conditions.append(
            or_(
                Thread.thread_id.in_(
                    select(PostBody.thread_id).where(
                        PostBody.id == PostBody.thread_id,
                        or_(PostBody.title.like(like), PostBody.content.like(like)),
                    )
                ),
                Thread.thread_id.in_(
                    select(ThreadTag.thread_id)
                    .join(TagRegistry, TagRegistry.tag_id == ThreadTag.tag_id)
                    .where(TagRegistry.tag_name.like(like))
                ),
            )
        )
    for tag_type, value in (('genre', query.genre), ('series', query.series), ('status', query.status)):
        if value:
            conditions.append(
                Thread.thread_id.in_(
                    select(ThreadTag.thread_id)
                    .join(TagRegistry, TagRegistry.tag_id == ThreadTag.tag_id)
                    .where(TagRegistry.tag_type == tag_type, TagRegistry.tag_name == value)
                )
            )
    for tag_name in query.tags or []:
        conditions.append(
            Thread.thread_id.in_(
                select(ThreadTag.thread_id)
                .join(TagRegistry, TagRegistry.tag_id == ThreadTag.tag_id)
                .where(TagRegistry.tag_name == tag_name)
            )
        )
    if query.bookmarked_only:
        from ..models import Bookmark

        if query.user_id is None:
            conditions.append(False)
        else:
            conditions.append(Thread.thread_id.in_(select(Bookmark.thread_id).where(Bookmark.user_id == query.user_id)))
    return conditions


def build_thread_query(query: ThreadQuery) -> Select:
    """目录分页查询：只查 `thread` 表，页内串首正文由 `_op_bodies()` 按 id 另取。"""
    column, desc = sort_clause(query.sort)
    return (
        select(Thread)
        .where(*thread_conditions(query))
        .order_by(column.desc() if desc else column.asc(), Thread.thread_id.desc())
    )


def count_threads(db: Session, query: ThreadQuery) -> int:
    return int(db.scalar(select(func.count()).select_from(Thread).where(*thread_conditions(query))) or 0)


def _op_bodies(db: Session, thread_ids: list[int]) -> dict[int, PostBody]:
    """取这一页的串首正文（走 post_body 主键，只碰这一页的条数）。"""
    if not thread_ids:
        return {}
    rows = db.scalars(
        select(PostBody).where(PostBody.thread_id.in_(thread_ids), PostBody.id == PostBody.thread_id)
    ).all()
    return {row.thread_id: row for row in rows}


def list_threads(db: Session, query: ThreadQuery) -> tuple[list[ThreadOut], int]:
    total = count_threads(db, query)
    threads = db.scalars(
        build_thread_query(query).limit(query.page_size).offset((query.page - 1) * query.page_size)
    ).all()
    ids = [thread.thread_id for thread in threads]
    bodies = _op_bodies(db, ids)
    tag_map = _tags_by_thread(db, ids)
    items = [thread_out(thread, bodies.get(thread.thread_id), tag_map.get(thread.thread_id, [])) for thread in threads]
    return items, total


def thread_position(db: Session, query: ThreadQuery, thread_id: int) -> int | None:
    """目标串在当前筛选与排序下排第几条（0 起）；不在结果里返回 None。

    目录页「在目录显示」用它算出该翻到第几页，不用把结果筛成一个串。
    """
    row = db.execute(build_thread_query(query).where(Thread.thread_id == thread_id)).first()
    if row is None:
        return None
    column, desc = sort_clause(query.sort)
    target = getattr(row[0], column.key)
    before = or_(
        column > target if desc else column < target,
        and_(column == target, Thread.thread_id > thread_id),
    )
    stmt = build_thread_query(query).where(before)
    return int(db.scalar(select(func.count()).select_from(stmt.subquery())) or 0)


def get_thread(db: Session, thread_id: int) -> ThreadOut | None:
    row = db.execute(
        select(Thread, PostBody)
        .join(PostBody, and_(PostBody.thread_id == Thread.thread_id, PostBody.id == Thread.thread_id))
        .where(Thread.thread_id == thread_id)
    ).first()
    if row is None:
        return None
    thread, body = row
    return thread_out(thread, body, _tags_by_thread(db, [thread_id]).get(thread_id, []))


def _post_out(post: Post, body: PostBody | None) -> PostOut:
    return PostOut(
        thread_id=post.thread_id,
        id=post.id,
        cookie=post.cookie,
        page_num=post.page_num,
        is_po=post.is_po,
        is_sage=post.is_sage,
        is_admin=post.is_admin,
        created_at=post.created_at,
        content=(body.content if body else '') or '',
        img=(body.img if body else None),
        img_source=(body.img_source if body else None),
        title=(body.title if body else None),
        name=(body.name if body else None),
    )


def list_posts(
    db: Session,
    thread_id: int,
    page: int,
    page_size: int,
    paging_mode: str = 'island',
    keyword: str | None = None,
    po_only: bool = False,
) -> tuple[list[PostOut], int, int]:
    """返回 (items, total, page_count)；分页语义见 docs/contract.md。"""
    conditions = [Post.thread_id == thread_id]
    terms = query_terms(keyword or '')
    if terms:
        # 与全文检索同一套切词：每个词都要出现；纯串号另外按楼号命中
        matched: Any = and_(*(PostBody.content.like(f'%{term}%') for term in terms))
        if keyword and keyword.isdigit():
            matched = or_(matched, PostBody.id == int(keyword))
        conditions.append(Post.id.in_(select(PostBody.id).where(PostBody.thread_id == thread_id, matched)))
    if po_only:
        conditions.append(Post.is_po.is_(True))

    total = db.scalar(select(func.count()).select_from(Post).where(*conditions)) or 0

    # 只看 Po 和检索一样是「过滤后的列表」，按每页条数分页，不再按岛页码
    filtered = bool(terms) or po_only
    page_conditions = list(conditions)
    if paging_mode == 'island' and not filtered:
        page_conditions.append(or_(Post.page_num == page, and_(page == 1, Post.page_num == 0)))
        limit, offset = None, None
        island_page_count = int(db.scalar(select(func.max(Post.page_num)).where(Post.thread_id == thread_id)) or 0)
        page_count = max(1, island_page_count)
    else:
        limit, offset = page_size, (page - 1) * page_size
        page_count = max(1, -(-total // page_size))

    stmt = (
        select(Post, PostBody)
        .join(PostBody, and_(PostBody.thread_id == Post.thread_id, PostBody.id == Post.id))
        .where(*page_conditions)
        .order_by(Post.id)
    )
    if limit is not None:
        stmt = stmt.limit(limit).offset(offset)
    rows = db.execute(stmt).all()
    return [_post_out(p, b) for p, b in rows], int(total), page_count


def get_post(db: Session, post_id: int) -> PostOut | None:
    row = db.execute(
        select(Post, PostBody)
        .join(PostBody, and_(PostBody.thread_id == Post.thread_id, PostBody.id == Post.id))
        .where(Post.id == post_id)
    ).first()
    if row is None:
        return None
    return _post_out(*row)


def get_posts(db: Session, post_ids: list[int]) -> dict[int, PostOut]:
    """一次取多楼（全文检索命中列表用；一条一个查询的话 200 条就是 200 次往返）。"""
    if not post_ids:
        return {}
    rows = db.execute(
        select(Post, PostBody)
        .join(PostBody, and_(PostBody.thread_id == Post.thread_id, PostBody.id == Post.id))
        .where(Post.id.in_(post_ids))
    ).all()
    return {post.id: _post_out(post, body) for post, body in rows}


def tag_vocabulary(db: Session) -> TagVocabulary:
    rows = db.execute(select(TagRegistry.tag_type, TagRegistry.tag_name).order_by(TagRegistry.tag_name)).all()
    vocab = TagVocabulary()
    for tag_type, tag_name in rows:
        if tag_type == 'genre':
            vocab.genre.append(tag_name)
        elif tag_type == 'series':
            vocab.series.append(tag_name)
        elif tag_type == 'status':
            vocab.status.append(tag_name)
        elif tag_type == 'installment':
            vocab.installment.append(tag_name)
        elif tag_type == 'CUSTOM_TAG':
            vocab.tags.append(tag_name)

    # 按数值排，避免 "13.5" 排在 "2" 前面
    def as_number(value: str) -> tuple[int, float, str]:
        try:
            return (0, float(value), value)
        except ValueError:
            return (1, 0.0, value)

    vocab.installment.sort(key=as_number)
    return vocab


# ---- 楼层书签（阅读页右侧书签栏）----
def list_post_bookmarks(db: Session, user_id: int, thread_id: int | None = None) -> list[PostBookmarkOut]:
    """返回该用户的楼层书签，按添加时间从晚到早；给 thread_id 就只要那个串的。"""
    stmt = (
        select(
            PostBookmark.thread_id,
            PostBookmark.post_id,
            PostBookmark.title,
            PostBookmark.created_at,
            Post.page_num,
            PostBody.content,
        )
        .outerjoin(Post, and_(Post.thread_id == PostBookmark.thread_id, Post.id == PostBookmark.post_id))
        .outerjoin(PostBody, and_(PostBody.thread_id == PostBookmark.thread_id, PostBody.id == PostBookmark.post_id))
        .where(PostBookmark.user_id == user_id)
        .order_by(PostBookmark.created_at.desc(), PostBookmark.post_id.desc())
    )
    if thread_id is not None:
        stmt = stmt.where(PostBookmark.thread_id == thread_id)
    rows = db.execute(stmt).all()

    # 标题和目录页一样取自串首：Thread 本身不存标题
    thread_ids = list({row[0] for row in rows})
    titles: dict[int, str] = {}
    for thread, body in db.execute(
        select(Thread, PostBody)
        .join(PostBody, and_(PostBody.thread_id == Thread.thread_id, PostBody.id == Thread.thread_id))
        .where(Thread.thread_id.in_(thread_ids))
    ).all():
        titles[thread.thread_id] = thread_out(thread, body, []).title
    tag_map = _tags_by_thread(db, thread_ids)
    return [
        PostBookmarkOut(
            post_id=post_id,
            thread_id=bookmark_thread_id,
            thread_title=titles.get(bookmark_thread_id) or f'No.{bookmark_thread_id}',
            title=bookmark_title or '',
            page_num=int(page_num or 0),
            excerpt=_excerpt(content or ''),
            created_at=created_at,
            tags=tag_map.get(bookmark_thread_id, []),
        )
        for bookmark_thread_id, post_id, bookmark_title, created_at, page_num, content in rows
    ]


def set_post_bookmark_title(db: Session, user_id: int, thread_id: int, post_id: int, title: str) -> None:
    """给书签改名字（空字符串 = 不要名字）。"""
    row = db.get(PostBookmark, (user_id, thread_id, post_id))
    if row is None:
        return
    row.title = title.strip()[:60]
    db.commit()


def add_post_bookmark(db: Session, user_id: int, thread_id: int, post_id: int) -> None:
    """幂等：已经收藏过就什么都不做。"""
    if db.get(PostBookmark, (user_id, thread_id, post_id)) is not None:
        return
    db.add(PostBookmark(user_id=user_id, thread_id=thread_id, post_id=post_id, created_at=now_ts()))
    db.commit()


def remove_post_bookmark(db: Session, user_id: int, thread_id: int, post_id: int) -> None:
    row = db.get(PostBookmark, (user_id, thread_id, post_id))
    if row is not None:
        db.delete(row)
        db.commit()
