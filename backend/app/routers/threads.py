"""串与楼层接口。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Response
from pydantic import Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require_thread_edit, require_user
from ..errors import not_found
from ..models import AppUser, Post, PostBody, PostBookmark, TagRegistry, Thread, ThreadTag
from ..schemas import CamelModel, Paged, PostBookmarkOut, PostOut, TagOut, TagVocabulary, ThreadOut
from ..services import auth as auth_service
from ..services import threads as service

router = APIRouter(prefix='/api', tags=['threads'])


class BookmarkTitleIn(CamelModel):
    title: str = Field('', max_length=60)


@router.get('/threads', response_model=Paged[ThreadOut], summary='目录检索')
def list_threads(
    keyword: str | None = None,
    thread_id: int | None = Query(None, alias='threadId'),
    board: str | None = None,
    cookie: str | None = None,
    genre: str | None = None,
    series: str | None = None,
    status: str | None = None,
    tags: list[str] = Query(default=[]),
    bookmarked_only: bool = Query(False, alias='bookmarkedOnly'),
    sort: str = 'updated_desc',
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100, alias='pageSize'),
    db: Session = Depends(get_db),
) -> Paged[ThreadOut]:
    query = service.ThreadQuery(
        keyword=keyword,
        thread_id=thread_id,
        board=board,
        cookie=cookie,
        genre=genre,
        series=series,
        status=status,
        tags=[t for t in tags if t],
        bookmarked_only=bookmarked_only,
        sort=sort,
        page=page,
        page_size=page_size,
    )
    items, total = service.list_threads(db, query)
    return Paged[ThreadOut](items=items, total=total, page=page, page_size=page_size)


@router.get('/tags', response_model=TagVocabulary, summary='筛选下拉框的标签词汇表')
def list_tags(db: Session = Depends(get_db)) -> TagVocabulary:
    return service.tag_vocabulary(db)


@router.get('/threads/{thread_id}/position', response_model=dict, summary='这个串在当前筛选下排第几条')
def thread_position(
    thread_id: int,
    keyword: str | None = None,
    board: str | None = None,
    cookie: str | None = None,
    genre: str | None = None,
    series: str | None = None,
    status: str | None = None,
    tags: list[str] = Query(default=[]),
    bookmarked_only: bool = Query(False, alias='bookmarkedOnly'),
    sort: str = 'updated_desc',
    page_size: int = Query(10, ge=1, le=100, alias='pageSize'),
    db: Session = Depends(get_db),
    _user: AppUser = Depends(require_user),
) -> dict:
    query = service.ThreadQuery(
        keyword=keyword,
        board=board,
        cookie=cookie,
        genre=genre,
        series=series,
        status=status,
        tags=[t for t in tags if t],
        bookmarked_only=bookmarked_only,
        sort=sort,
        page_size=page_size,
    )
    index = service.thread_position(db, query, thread_id)
    if index is None:
        raise not_found('当前筛选条件下没有这个串', 'THREAD_NOT_IN_LIST')
    return {'index': index, 'page': index // page_size + 1, 'pageSize': page_size}


@router.get('/threads/{thread_id}', response_model=ThreadOut, summary='串详情')
def get_thread(thread_id: int, db: Session = Depends(get_db)) -> ThreadOut:
    thread = service.get_thread(db, thread_id)
    if thread is None:
        raise not_found('串不存在或不是主串', 'THREAD_NOT_FOUND')
    return thread


@router.get('/threads/{thread_id}/posts', response_model=Paged[PostOut], summary='阅读页楼层')
def list_posts(
    thread_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200, alias='pageSize'),
    paging_mode: str = Query('island', alias='pagingMode', pattern='^(island|custom)$'),
    keyword: str | None = None,
    po_only: bool = Query(False, alias='poOnly'),
    db: Session = Depends(get_db),
) -> Paged[PostOut]:
    if service.get_thread(db, thread_id) is None:
        raise not_found('串不存在或不是主串', 'THREAD_NOT_FOUND')
    items, total, _page_count = service.list_posts(db, thread_id, page, page_size, paging_mode, keyword, po_only)
    return Paged[PostOut](items=items, total=total, page=page, page_size=page_size)


@router.get('/posts/{post_id}', response_model=PostOut, summary='按串号取单楼（引用跳转）')
def get_post(post_id: int, db: Session = Depends(get_db)) -> PostOut:
    post = service.get_post(db, post_id)
    if post is None:
        raise not_found('找不到这一楼（可能未被下载）', 'POST_NOT_FOUND')
    return post


# ---- 写操作（需要 thread.edit 权限） ----
class TagIn(CamelModel):
    tag_type: str = Field(alias='tagType', max_length=16)
    tag_name: str = Field(alias='tagName', max_length=64)
    tag_id: int = Field(0, alias='tagId')


class TagsIn(CamelModel):
    tags: list[TagIn] = []


class SuggestIn(CamelModel):
    kind: str = Field('其他', max_length=32)
    detail: str = Field('', max_length=512)


SINGLE_TYPES = {'genre', 'series', 'status', 'installment'}


@router.put('/threads/{thread_id}/tags', response_model=list[TagOut], summary='修改串标签（thread.edit）')
def put_tags(
    thread_id: int,
    payload: TagsIn,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_thread_edit),
) -> list[TagOut]:
    if db.get(Thread, thread_id) is None:
        raise not_found('串不存在', 'THREAD_NOT_FOUND')

    db.execute(delete(ThreadTag).where(ThreadTag.thread_id == thread_id))
    db.flush()
    seen_single: set[str] = set()
    for tag in payload.tags:
        tag_type = tag.tag_type if tag.tag_type in SINGLE_TYPES | {'CUSTOM_TAG'} else 'CUSTOM_TAG'
        name = tag.tag_name.strip()
        if not name:
            continue
        if tag_type in SINGLE_TYPES:
            if tag_type in seen_single:  # 每串每类只保留第一个
                continue
            seen_single.add(tag_type)
        registry = db.scalar(select(TagRegistry).where(TagRegistry.tag_type == tag_type, TagRegistry.tag_name == name))
        if registry is None:
            registry = TagRegistry(tag_type=tag_type, tag_name=name)
            db.add(registry)
            db.flush()
        db.add(ThreadTag(thread_id=thread_id, tag_id=registry.tag_id, tag_type=tag_type))
    db.commit()
    db.refresh(db.get(Thread, thread_id))
    auth_service.log(db, 'info', 'thread', f'修改串 No.{thread_id} 的标签', user.user_id)
    thread = service.get_thread(db, thread_id)
    return thread.tags if thread else []


@router.delete('/threads/{thread_id}', status_code=204, summary='删除串（thread.edit）')
def delete_thread(
    thread_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_thread_edit),
) -> Response:
    if db.get(Thread, thread_id) is None:
        raise not_found('串不存在', 'THREAD_NOT_FOUND')
    db.execute(delete(PostBody).where(PostBody.thread_id == thread_id))
    db.execute(delete(Post).where(Post.thread_id == thread_id))
    db.execute(delete(ThreadTag).where(ThreadTag.thread_id == thread_id))
    db.execute(delete(Thread).where(Thread.thread_id == thread_id))
    db.commit()
    auth_service.log(db, 'warn', 'thread', f'删除串 No.{thread_id}', user.user_id)
    return Response(status_code=204)


@router.post('/threads/{thread_id}/suggest', status_code=204, summary='提交建议修正（任何登录用户）')
def suggest(
    thread_id: int,
    payload: SuggestIn,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
) -> Response:
    if db.get(Thread, thread_id) is None:
        raise not_found('串不存在', 'THREAD_NOT_FOUND')
    auth_service.add_suggestion(db, thread_id, user.user_id, payload.kind, payload.detail)
    return Response(status_code=204)


# ---- 楼层书签（每个用户各自一份，按串归属）----
@router.get('/post-bookmarks', response_model=list[PostBookmarkOut], summary='我的楼层书签')
def list_post_bookmarks(
    thread_id: int | None = Query(None, alias='threadId', description='只要这个串的'),
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
) -> list[PostBookmarkOut]:
    return service.list_post_bookmarks(db, user.user_id, thread_id)


@router.post('/threads/{thread_id}/post-bookmarks/{post_id}', status_code=204, summary='给某楼加书签')
def add_post_bookmark(
    thread_id: int,
    post_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
) -> Response:
    if db.get(PostBody, (thread_id, post_id)) is None:
        raise not_found('找不到这一楼', 'POST_NOT_FOUND')
    service.add_post_bookmark(db, user.user_id, thread_id, post_id)
    return Response(status_code=204)


@router.patch('/threads/{thread_id}/post-bookmarks/{post_id}', status_code=204, summary='给书签改名字')
def rename_post_bookmark(
    thread_id: int,
    post_id: int,
    payload: BookmarkTitleIn,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
) -> Response:
    if db.get(PostBookmark, (user.user_id, thread_id, post_id)) is None:
        raise not_found('没有这条书签', 'BOOKMARK_NOT_FOUND')
    service.set_post_bookmark_title(db, user.user_id, thread_id, post_id, payload.title)
    return Response(status_code=204)


@router.delete('/threads/{thread_id}/post-bookmarks/{post_id}', status_code=204, summary='取消某楼的书签')
def remove_post_bookmark(
    thread_id: int,
    post_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
) -> Response:
    service.remove_post_bookmark(db, user.user_id, thread_id, post_id)
    return Response(status_code=204)
