"""SQLAlchemy 引擎 / 会话 / Base。"""

from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .settings import settings

connect_args = {'check_same_thread': False} if settings.db_url.startswith('sqlite') else {}
engine = create_engine(settings.db_url, future=True, pool_pre_ping=True, connect_args=connect_args)

if settings.db_url.startswith('sqlite'):

    @event.listens_for(engine, 'connect')
    def _sqlite_pragma(dbapi_connection, _record):  # pragma: no cover - 连接级设置
        cursor = dbapi_connection.cursor()
        cursor.execute('PRAGMA foreign_keys=ON')
        # api 与 worker 共用库文件，WAL 让读写不互相阻塞
        cursor.execute('PRAGMA journal_mode=WAL')
        cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, class_=Session)


class Base(DeclarativeBase):
    pass


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _literal(value: object) -> str:
    """DDL 里不能绑参数，这里只处理我们自己写的标量默认值。"""
    if isinstance(value, bool):
        return '1' if value else '0'
    if isinstance(value, int | float):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def add_missing_columns() -> list[str]:
    """给已存在的老库补上模型里新增的列。

    create_all 只建缺失的表、不会 ALTER，所以这里按模型逐个比对；
    新加的列请在模型里给 scalar 默认值（SQLite 加 NOT NULL 列必须带默认值）。
    """
    from sqlalchemy import inspect, text
    from sqlalchemy import types as sqltypes

    inspector = inspect(engine)
    added: list[str] = []
    for table in Base.metadata.sorted_tables:
        if not inspector.has_table(table.name):
            continue
        existing = {column['name'] for column in inspector.get_columns(table.name)}
        for column in table.columns:
            if column.name in existing:
                continue
            default = column.default.arg if column.default is not None and column.default.is_scalar else None
            if default is None and not column.nullable:
                default = '' if isinstance(column.type, sqltypes.String) else 0
            clause = f'ALTER TABLE {table.name} ADD COLUMN {column.name} {column.type.compile(engine.dialect)}'
            if default is not None:
                clause += f' DEFAULT {_literal(default)}'
            with engine.begin() as connection:
                connection.execute(text(clause))
            added.append(f'{table.name}.{column.name}')
    return added


def repair_post_flags() -> int:
    """按 ID 重算派生字段 `is_po`，返回补回来的楼层数（幂等）。

    同一串里显示 ID 与串首相同就是楼主。老库（早期版本或归档器写入的库）里 `is_po`
    可能整片为 false，用这条规则纯 SQL 补回，不必重新抓串。
    先探一下有没有要改的：稳定状态下就省掉一次全表写。
    """
    from sqlalchemy import text

    where = (
        "is_po = :no AND cookie <> '' "
        'AND EXISTS (SELECT 1 FROM thread WHERE thread.thread_id = post.thread_id AND thread.cookie = post.cookie)'
    )
    params = {'yes': True, 'no': False}
    with engine.begin() as connection:
        if connection.execute(text(f'SELECT 1 FROM post WHERE {where} LIMIT 1'), params).first() is None:
            return 0
        return connection.execute(text(f'UPDATE post SET is_po = :yes WHERE {where}'), params).rowcount or 0


def init_db() -> list[str]:
    """建表（结构见 app/models.py）、补新增列、修正派生标记、创建 FTS5 虚拟表；返回本次改动。"""
    from . import models  # noqa: F401  确保模型已注册
    from .services.search import create_fts_table

    Base.metadata.create_all(bind=engine)
    notes = [f'新增列 {name}' for name in add_missing_columns()]
    fixed = repair_post_flags()
    if fixed:
        notes.append(f'补回 {fixed} 个楼层的 PO 标记')
    with SessionLocal() as db:
        create_fts_table(db)
    return notes
