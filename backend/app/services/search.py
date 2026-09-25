"""全文检索：可插拔后端（FTS5 / Manticore，退路为 LIKE）。只检索已下载的串。

检索词按 `query_terms` 切分：空白分隔（词与词之间是 AND），英文双引号内的整段
算一个词、要求完全匹配。三个后端都用同一套切词，结果才一致。
"""

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
MAX_TERMS = 8
# `"整段"` 优先，剩下的按空白切；落单的引号当普通字符
TERM_PATTERN = re.compile(r'"([^"]*)"|(\S+)')


@dataclass
class Hit:
    thread_id: int
    post_id: int


class SearchBackend(Protocol):
    name: str

    def search(self, db: Session, keyword: str, limit: int = 50) -> list[Hit]: ...

    def index_thread(self, db: Session, thread_id: int) -> int: ...

    def drop_thread(self, db: Session, thread_id: int) -> None: ...


def query_terms(keyword: str) -> list[str]:
    """切检索词：空白分词，英文双引号内的整段算一个词。

    `B事 量化` → ['B事', '量化']（两词都要出现）；`"B事 量化"` → ['B事 量化']（整段完全匹配）。
    """
    terms: list[str] = []
    for quoted, bare in TERM_PATTERN.findall(keyword):
        term = (quoted or bare).strip().strip('"')
        if term and term not in terms:
            terms.append(term)
    return terms[:MAX_TERMS]


def _fts_query(terms: list[str]) -> str:
    """把词列表变成 FTS5 查询：每个词一个短语，词与词之间 AND（trigram 下短语就是子串）。"""
    escaped = (term.replace('"', '""') for term in terms)
    return ' AND '.join(f'"{term}"' for term in escaped)


class LikeBackend:
    """退路：短关键词或索引不可用时。"""

    name = 'like'

    def search(self, db: Session, keyword: str, limit: int = 50) -> list[Hit]:
        terms = query_terms(keyword)
        if not terms:
            return []
        rows = db.execute(
            select(PostBody.thread_id, PostBody.id)
            .where(*(PostBody.content.like(f'%{term}%') for term in terms))
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
        terms = query_terms(keyword)
        if not terms:
            return []
        # trigram 分词器认不了短于 3 字的词，只要有一个这种词就整句走 LIKE
        if any(len(term) < MIN_TRIGRAM for term in terms) or not self.available(db):
            return LikeBackend().search(db, keyword, limit)
        rows = db.execute(
            text(f'SELECT thread_id, post_id FROM {FTS_TABLE} WHERE content MATCH :q ORDER BY rank LIMIT :limit'),
            {'q': _fts_query(terms), 'limit': limit},
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
        terms = query_terms(keyword)
        if not terms:
            return []
        # 每个词都要求连续命中（match_phrase），词与词之间是 AND
        query: dict = {'match_phrase': {'content': terms[0]}}
        if len(terms) > 1:
            query = {'bool': {'must': [{'match_phrase': {'content': term}} for term in terms]}}
        try:
            data = self._post(
                '/search',
                json_body={
                    'index': self.index,
                    'query': query,
                    'limit': limit,
                    '_source': ['thread_id', 'post_id'],
                },
            )
        except Exception as exc:  # noqa: BLE001 - Manticore 挂了就退回本地实现，别让阅读页整体不可用
            from ..services.auth import log

            log(db, 'warn', 'search', f'Manticore 查询失败，回退 LIKE：{keyword.strip()[:40]}（{exc}）')
            return LikeBackend().search(db, keyword, limit)

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


def search_hits(db: Session, keyword: str, limit: int) -> tuple[list[Hit], bool]:
    """返回 (命中, 是否被 limit 截断)：多取一条就知道后面还有没有，不必数总数。"""
    hits = get_backend(db).search(db, keyword, limit + 1)
    return hits[:limit], len(hits) > limit


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
    'query_terms',
    'rebuild_index',
    'search_hits',
]
