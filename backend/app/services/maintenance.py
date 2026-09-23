"""数据库运维：备份 / 恢复 / 清理（需要 db.manage 权限）。"""

from __future__ import annotations

import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import Session

from ..db import engine
from ..errors import ApiError, not_found
from ..models import Post, PostBody, Thread, ThreadTag
from ..settings import settings

CST = timezone(timedelta(hours=8))


def _is_sqlite() -> bool:
    return settings.db_url.startswith('sqlite')


def _db_path() -> Path:
    return Path(settings.db_url.replace('sqlite:///', '', 1))


def backup(db: Session) -> str:
    """SQLite 用官方 backup API 做一致性快照（直接拷文件会漏掉 WAL 数据）。"""
    stamp = datetime.now(tz=CST).strftime('%Y%m%d-%H%M%S')
    if _is_sqlite():
        import sqlite3

        source_path = _db_path()
        if not source_path.is_file():
            raise ApiError('数据库文件不存在', 'DB_NOT_FOUND', 500)
        target = settings.backup_dir / f'app-{stamp}.db'
        source = sqlite3.connect(str(source_path))
        try:
            destination = sqlite3.connect(str(target))
            try:
                source.backup(destination)
            finally:
                destination.close()
        finally:
            source.close()
        size = target.stat().st_size / 1024 / 1024
        return f'备份完成：{target}（{size:.1f} MB）'

    raise ApiError('MySQL 备份请直接用 mysqldump 导出（本接口只覆盖 SQLite）', 'BACKUP_UNSUPPORTED', 501)


def list_backups() -> list[Path]:
    return sorted(settings.backup_dir.glob('app-*.db'), reverse=True)


def restore(db: Session, name: str | None = None) -> str:
    if not _is_sqlite():
        raise ApiError('只有 SQLite 部署支持在线恢复，MySQL 请用导入', 'RESTORE_UNSUPPORTED', 501)
    backups = list_backups()
    if not backups:
        raise not_found('没有可用的备份', 'BACKUP_NOT_FOUND')
    source = settings.backup_dir / name if name else backups[0]
    if name and not source.is_file():
        raise not_found('找不到指定的备份', 'BACKUP_NOT_FOUND')
    target = _db_path()
    engine.dispose()
    shutil.copy2(source, target)
    # WAL/SHM 是旧数据，必须一起清掉
    for suffix in ('-wal', '-shm'):
        leftover = Path(f'{target}{suffix}')
        if leftover.exists():
            leftover.unlink()
    return f'已从 {source.name} 恢复，请重启服务以加载新数据'


def clean(db: Session) -> str:
    """清理孤立数据并 VACUUM。"""
    orphans_body = db.execute(
        delete(PostBody).where(
            ~select(Post.id).where(Post.thread_id == PostBody.thread_id, Post.id == PostBody.id).exists()
        )
    ).rowcount
    orphans_tag = db.execute(
        delete(ThreadTag).where(~select(Thread.thread_id).where(Thread.thread_id == ThreadTag.thread_id).exists())
    ).rowcount
    orphans_post = db.execute(
        delete(Post).where(~select(Thread.thread_id).where(Thread.thread_id == Post.thread_id).exists())
    ).rowcount
    db.commit()

    freed = ''
    if _is_sqlite():
        before = _db_path().stat().st_size if _db_path().is_file() else 0
        db.execute(text('VACUUM'))
        db.commit()
        after = _db_path().stat().st_size if _db_path().is_file() else 0
        freed = f'，释放 {(before - after) / 1024:.0f} KB'
    return f'清理完成：孤立楼层 {orphans_post} / 正文 {orphans_body} / 标签 {orphans_tag}{freed}'


def stats(db: Session) -> dict[str, object]:
    return {
        'threads': db.scalar(select(func.count()).select_from(Thread)) or 0,
        'posts': db.scalar(select(func.count()).select_from(Post)) or 0,
        'bodies': db.scalar(select(func.count()).select_from(PostBody)) or 0,
        'backups': [path.name for path in list_backups()[:10]],
        'dbSize': (_db_path().stat().st_size if _is_sqlite() and _db_path().is_file() else 0),
    }
