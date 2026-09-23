"""全文检索接口。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_db
from ..schemas import SearchHit, ThreadOut
from ..services import search as search_service
from ..services import threads as thread_service
from ..settings import settings

router = APIRouter(prefix='/api/search', tags=['search'])


@router.get('/fulltext', response_model=list[SearchHit], summary='全文检索（只覆盖已下载的串）')
def fulltext(
    keyword: str = Query(min_length=1, max_length=64),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
) -> list[SearchHit]:
    kw = search_service.clean_keyword(keyword)
    hits = search_service.get_backend(db).search(db, kw, limit)

    results: list[SearchHit] = []
    seen_threads: dict[int, ThreadOut] = {}
    for hit in hits:
        post = thread_service.get_post(db, hit.post_id)
        if post is None:
            continue
        thread = seen_threads.get(hit.thread_id)
        if thread is None:
            thread_out = thread_service.get_thread(db, hit.thread_id)
            if thread_out is None:
                continue
            thread = thread_out
            seen_threads[hit.thread_id] = thread
        results.append(SearchHit(thread=thread, post=post))
    return results


@router.get('/status', summary='检索后端状态')
def status(db: Session = Depends(get_db)) -> dict[str, object]:
    backend = search_service.get_backend(db)
    fts_available = search_service.Fts5Backend.available(db)
    if fts_available:
        indexed = int(db.execute(text(f'SELECT count(*) FROM {search_service.FTS_TABLE}')).scalar() or 0)
    elif isinstance(backend, search_service.ManticoreBackend):
        indexed = backend.count()
    else:
        indexed = 0
    return {
        'backend': backend.name,
        'fts5': fts_available,
        'indexedPosts': indexed,
        'db': settings.db_url.split('://')[0],
    }
