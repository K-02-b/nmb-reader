"""全文检索：可插拔后端（FTS5 / Manticore，退路为 LIKE）。只检索已下载的串。"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Protocol

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..models import Post, PostBody
from ..settings import settings

FTS_TABLE = 'post_fts'
MIN_TRIGRAM = 3


@dataclass
class Hit:
    thread_id: int
    post_id: int


class SearchBackend(Protocol):
    name: str

    def search(self, db: Session, keyword: str, limit: int = 50) -> list[Hit]: ...

    def index_thread(self, db: Session, thread_id: int) -> int: ...

    def drop_thread(self, db: Session, thread_id: int) -> None: ...


def _fts_query(keyword: str) -> str:
    """把用户输入变成 FTS5 短语查询。"""
    escaped = keyword.strip().replace('"', '""')
    return f'"{escaped}"'


class LikeBackend:
    """退路：短关键词或索引不可用时。"""

    name = 'like'

    def search(self, db: Session, keyword: str, limit: int = 50) -> list[Hit]:
        kw = keyword.strip()
        if not kw:
            return []
        rows = db.execute(
            select(PostBody.thread_id, PostBody.id)
            .where(PostBody.content.like(f'%{kw}%'))
            .order_by(PostBody.id.desc())
            .limit(limit)
        ).all()
        return [Hit(thread_id=t, post_id=p) for t, p in rows]

    def index_thread(self, db: Session, thread_id: int) -> int:  # pragma: no cover - 无需索引
        return 0

    def drop_thread(self, db: Session, thread_id: int) -> None:  # pragma: no cover
        return None


class Fts5Backend:
    name = 'fts5'

    @staticmethod
    def available(db: Session) -> bool:
        if not settings.db_url.startswith('sqlite'):
            return False
        try:
            db.execute(text(f'SELECT count(*) FROM {FTS_TABLE}'))
            return True
        except Exception:  # noqa: BLE001 - 表不存在
            return False

    def search(self, db: Session, keyword: str, limit: int = 50) -> list[Hit]:
        kw = keyword.strip()
        if not kw:
            return []
        if len(kw) < MIN_TRIGRAM or not self.available(db):
            return LikeBackend().search(db, kw, limit)
        rows = db.execute(
            text(f'SELECT thread_id, post_id FROM {FTS_TABLE} WHERE content MATCH :q ORDER BY rank LIMIT :limit'),
            {'q': _fts_query(kw), 'limit': limit},
        ).all()
        return [Hit(thread_id=int(t), post_id=int(p)) for t, p in rows]

    def index_thread(self, db: Session, thread_id: int) -> int:
        if not self.available(db):
            return 0
        self.drop_thread(db, thread_id)
        rows = db.execute(select(PostBody.id, PostBody.content).where(PostBody.thread_id == thread_id)).all()
        if not rows:
            return 0
        db.execute(
            text(f'INSERT INTO {FTS_TABLE} (content, thread_id, post_id) VALUES (:content, :thread_id, :post_id)'),
            [{'content': content or '', 'thread_id': thread_id, 'post_id': post_id} for post_id, content in rows],
        )
        db.commit()
        return len(rows)

    def drop_thread(self, db: Session, thread_id: int) -> None:
        if not self.available(db):
            return
        db.execute(text(f'DELETE FROM {FTS_TABLE} WHERE thread_id = :t'), {'t': thread_id})
        db.commit()

    def rebuild(self, db: Session) -> int:
        if not self.available(db):
            return 0
        db.execute(text(f'DELETE FROM {FTS_TABLE}'))
        db.commit()
        thread_ids = list(db.scalars(select(Post.thread_id).distinct()))
        total = 0
        for thread_id in thread_ids:
            total += self.index_thread(db, thread_id)
        return total


class ManticoreBackend:
    """Manticore 后端：content 全文 + thread_id / post_id，中文按单字切分。"""

    name = 'manticore'

    def __init__(self, url: str | None = None, index: str | None = None) -> None:
        self.url = (url or settings.manticore_url).rstrip('/')
        self.index = index or settings.manticore_index
        self.timeout = settings.manticore_timeout
        self._ensured = False

    # ---- 基础请求 ----
    def _post(self, path: str, *, json_body: dict | None = None, data: dict | None = None, content: str | None = None):
        import httpx

        headers = {}
        if content is not None:
            headers['Content-Type'] = 'application/x-ndjson'
        with httpx.Client(timeout=self.timeout) as client:
            response = client.post(
                f'{self.url}{path}',
                json=json_body,
                data=data,
                content=content.encode('utf-8') if content is not None else None,
                headers=headers or None,
            )
            response.raise_for_status()
            return response.json()

    def _sql(self, query: str) -> dict:
        return self._post('/sql?mode=raw', data={'query': query})

    def ensure_table(self) -> None:
        """建表（幂等）。"""
        if self._ensured:
            return
        self._sql(
            f'CREATE TABLE IF NOT EXISTS {self.index} '
            '(content text, thread_id bigint, post_id bigint) '
            "ngram_len='1' ngram_chars='cjk' charset_table='non_cjk'"
        )
        self._ensured = True

    # ---- 检索 ----
    def search(self, db: Session, keyword: str, limit: int = 50) -> list[Hit]:
        kw = keyword.strip()
        if not kw:
            return []
        try:
            data = self._post(
                '/search',
                json_body={
                    'index': self.index,
                    'query': {'match_phrase': {'content': kw}},
                    'limit': limit,
                    '_source': ['thread_id', 'post_id'],
                },
            )
        except Exception as exc:  # noqa: BLE001 - Manticore 挂了就退回本地实现，别让阅读页整体不可用
            from ..services.auth import log

            log(db, 'warn', 'search', f'Manticore 查询失败，回退 LIKE：{kw[:40]}（{exc}）')
            return LikeBackend().search(db, kw, limit)

        hits: list[Hit] = []
        for row in data.get('hits', {}).get('hits', []):
            source = row.get('_source') or {}
            thread_id = int(source.get('thread_id') or 0)
            post_id = int(source.get('post_id') or 0)
            if thread_id and post_id:
                hits.append(Hit(thread_id=thread_id, post_id=post_id))
        return hits

    def count(self) -> int:
        try:
            data = self._sql(f'SELECT count(*) FROM {self.index}')
            return int(data[0]['data'][0]['count(*)'])
        except Exception:  # noqa: BLE001
            return 0

    # ---- 写入 ----
    def index_thread(self, db: Session, thread_id: int, batch_size: int = 500) -> int:
        self.ensure_table()
        rows = db.execute(
            select(PostBody.thread_id, PostBody.id, PostBody.content).where(PostBody.thread_id == thread_id)
        ).all()
        if not rows:
            return 0
        written = 0
        for start in range(0, len(rows), batch_size):
            chunk = rows[start : start + batch_size]
            lines = [
                json.dumps(
                    {
                        'replace': {
                            'index': self.index,
                            'id': int(post_id),
                            'doc': {'content': content or '', 'thread_id': int(tid), 'post_id': int(post_id)},
                        }
                    },
                    ensure_ascii=False,
                )
                for tid, post_id, content in chunk
            ]
            result = self._post('/bulk', content='\n'.join(lines) + '\n')
            if result.get('errors'):
                raise RuntimeError(f'Manticore bulk 写入报错：{result}')
            written += len(chunk)
        return written

    def drop_thread(self, db: Session, thread_id: int) -> None:
        try:
            self._post(
                '/delete',
                json_body={'index': self.index, 'query': {'equals': {'thread_id': int(thread_id)}}},
            )
        except Exception:  # noqa: BLE001 - 表不存在等情况忽略
            return


def get_backend(db: Session | None = None) -> SearchBackend:
    if settings.search_backend == 'manticore':
        return ManticoreBackend()
    if db is not None and Fts5Backend.available(db):
        return Fts5Backend()
    return LikeBackend()


def create_fts_table(db: Session) -> None:
    """建 FTS5 虚拟表（create_all 管不到）。"""
    if not settings.db_url.startswith('sqlite'):
        return
    db.execute(
        text(
            f'CREATE VIRTUAL TABLE IF NOT EXISTS {FTS_TABLE} '
            "USING fts5(content, thread_id UNINDEXED, post_id UNINDEXED, tokenize='trigram')"
        )
    )
    db.commit()


def index_thread(db: Session, thread_id: int) -> int:
    return get_backend(db).index_thread(db, thread_id)


def drop_thread(db: Session, thread_id: int) -> None:
    get_backend(db).drop_thread(db, thread_id)


def rebuild_index(db: Session) -> int:
    backend = get_backend(db)
    if isinstance(backend, Fts5Backend):
        return backend.rebuild(db)
    total = 0
    for thread_id in db.scalars(select(Post.thread_id).distinct()):
        total += backend.index_thread(db, thread_id)
    return total


def highlight(content: str, keyword: str, radius: int = 60) -> str:
    """截一段包含关键词的摘要，供前端加 <mark>。"""
    kw = keyword.strip()
    if not kw:
        return content[: radius * 2]
    index = content.lower().find(kw.lower())
    if index < 0:
        return content[: radius * 2]
    start = max(0, index - radius)
    end = min(len(content), index + len(kw) + radius)
    prefix = '…' if start > 0 else ''
    suffix = '…' if end < len(content) else ''
    return f'{prefix}{content[start:end]}{suffix}'


def clean_keyword(keyword: str) -> str:
    return re.sub(r'\s+', ' ', keyword).strip()[:64]


__all__ = [
    'Fts5Backend',
    'Hit',
    'LikeBackend',
    'ManticoreBackend',
    'clean_keyword',
    'create_fts_table',
    'drop_thread',
    'get_backend',
    'highlight',
    'index_thread',
    'rebuild_index',
]
