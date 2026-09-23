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


def init_db() -> list[str]:
    """建表（结构见 app/models.py）、补新增列、创建 FTS5 虚拟表；返回补出来的列。"""
    from . import models  # noqa: F401  确保模型已注册
    from .services.search import create_fts_table

    Base.metadata.create_all(bind=engine)
    added = add_missing_columns()
    with SessionLocal() as db:
        create_fts_table(db)
    return added
