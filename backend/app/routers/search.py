"""全文检索接口。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_db
from ..schemas import FulltextResult
from ..services import search as search_service
from ..services import threads as thread_service
from ..settings import settings

router = APIRouter(prefix='/api/search', tags=['search'])


@router.get('/fulltext', response_model=FulltextResult, summary='全文检索（只覆盖已下载的串）')
def fulltext(
    keyword: str = Query(min_length=1, max_length=64),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
) -> FulltextResult:
    kw = search_service.clean_keyword(keyword)
    hits, truncated = search_service.search_hits(db, kw, limit)
    posts = thread_service.get_posts(db, [hit.post_id for hit in hits])
    return FulltextResult(
        hits=[post for post in (posts.get(hit.post_id) for hit in hits) if post is not None],
        limit=limit,
        truncated=truncated,
    )


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
