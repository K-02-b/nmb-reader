"""下载队列：任务提交 / 去重 / 状态机推进（状态定义见 docs/state-machine.md）。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..errors import ApiError, conflict, not_found
from ..models import DownloadTask, Thread
from ..services.auth import log, now_ts
from ..settings import settings

FINISHED = {'indexed', 'cancelled', 'failed', 'write_failed', 'index_failed', 'images_done', 'images_failed'}

# 任务列表的状态筛选：前端只给这三档，具体状态归哪档由后端说了算
TASK_KINDS: dict[str, set[str]] = {
    'active': {
        'queued',
        'downloading',
        'downloaded',
        'writing',
        'written',
        'indexing',
        'cancelling',
        'images_running',
    },
    'done': {'indexed', 'cancelled', 'images_done'},
    'failed': {'failed', 'write_failed', 'index_failed', 'images_failed'},
}
# worker 领走后的中间态；进程异常退出时会悬空，需要重新排队
IN_FLIGHT = {'downloading', 'downloaded', 'writing', 'written', 'indexing', 'images_running'}
KIND_DOWNLOAD = 'download'
KIND_IMAGES = 'images'
CANCELLABLE = {'queued', 'downloading', 'downloaded', 'writing', 'cancelling'}
# 目前只有 X岛（XD）接入了抓取链路；AWD / BOG 尚未实现，不接受提交
SOURCES = {'XD'}


def new_task_id() -> str:
    return f'T{uuid.uuid4().hex[:8]}'


@dataclass
class QueuedTask:
    task_id: str
    kind: str
    thread_id: int
    source: str
    start_page: int
    replace: bool
    title: str | None
    # 提交者：worker 据此取该用户的 Cookie
    submitted_by: str


# ---- 提交 / 取消 / 重试 ----
def submit_task(
    db: Session,
    thread_id: int,
    source: str,
    title: str | None,
    username: str,
    user_id: int | None = None,
) -> DownloadTask:
    if thread_id <= 0 or thread_id > 10**12:
        raise ApiError('串号不合法，请输入纯数字的串号', 'BAD_THREAD_ID')
    source = (source or 'XD').upper()
    if source not in SOURCES:
        raise ApiError('下载来源目前只支持 XD（X岛）；AWD / BOG 暂未接入', 'BAD_SOURCE')

    running = db.scalar(
        select(DownloadTask).where(
            DownloadTask.thread_id == thread_id, DownloadTask.status.notin_(FINISHED | {'cancelled'})
        )
    )
    if running is not None:
        raise conflict('该串已有下载任务在进行中', 'TASK_EXISTS')

    existing = db.get(Thread, thread_id)
    incremental = existing is not None and existing.page_count > 0
    task = DownloadTask(
        task_id=new_task_id(),
        kind=KIND_DOWNLOAD,
        thread_id=thread_id,
        source=source,
        title=title or None,
        status='queued',
        page=existing.page_count if incremental else 0,
        total_pages=0,
        written=0,
        message='串已存在，将只更新最后一页及之后的内容' if incremental else None,
        submitted_by=username,
        submitted_at=now_ts(),
    )
    db.add(task)
    db.commit()
    log(
        db,
        'info',
        'download',
        f'提交{"增量更新" if incremental else "下载"}任务 {task.task_id}（No.{thread_id}）',
        user_id,
    )
    return task


def enqueue_images(db: Session, thread_id: int, username: str, total: int = 0) -> DownloadTask | None:
    """给某个串排一个图片本地化任务；已有未结束的同串任务则不重复排。"""
    running = db.scalar(
        select(DownloadTask).where(
            DownloadTask.thread_id == thread_id,
            DownloadTask.kind == KIND_IMAGES,
            DownloadTask.status.notin_(FINISHED),
        )
    )
    if running is not None:
        return None

    task = DownloadTask(
        task_id=new_task_id(),
        kind=KIND_IMAGES,
        thread_id=thread_id,
        source='XD',
        title=f'No.{thread_id} 图片本地化',
        status='queued',
        page=0,
        total_pages=total,
        written=0,
        message='等待本地化图片',
        submitted_by=username,
        submitted_at=now_ts(),
    )
    db.add(task)
    db.commit()
    log(db, 'info', 'images', f'已排队图片任务 {task.task_id}（No.{thread_id}，待下载 {total} 张）')
    return task


def cancel_task(db: Session, task_id: str, user_id: int | None = None) -> DownloadTask:
    task = db.get(DownloadTask, task_id)
    if task is None:
        raise not_found('任务不存在', 'TASK_NOT_FOUND')
    if task.status in FINISHED:
        raise conflict('任务已完成，无法取消', 'TASK_FINISHED')
    if task.status not in CANCELLABLE:
        raise conflict('当前状态无法取消', 'TASK_NOT_CANCELLABLE')
    if task.status == 'queued':
        # 未被领取则直接取消，否则置 cancelling 由 worker 在页边界终止
        task.status = 'cancelled'
        task.message = '已取消'
        task.finished_at = now_ts()
    else:
        task.status = 'cancelling'
        task.message = '正在取消'
    db.commit()
    log(db, 'warn', 'download', f'请求取消任务 {task_id}', user_id)
    return task


def retry_task(db: Session, task_id: str, user_id: int | None = None) -> DownloadTask:
    task = db.get(DownloadTask, task_id)
    if task is None:
        raise not_found('任务不存在', 'TASK_NOT_FOUND')
    task.status = 'queued'
    task.message = None
    task.page = 0
    task.written = 0
    task.finished_at = None
    db.commit()
    log(db, 'info', 'download', f'重新提交任务 {task_id}', user_id)
    return task


# ---- 查询 ----
def list_tasks(db: Session, limit: int = 100, since: int | None = None, kind: str | None = None) -> list[DownloadTask]:
    """按提交时间倒序取任务；since 只返回该 Unix 秒之后提交的，kind 按 active/done/failed 过滤。"""
    stmt = select(DownloadTask)
    if since:
        stmt = stmt.where(DownloadTask.submitted_at >= since)
    if kind in TASK_KINDS:
        stmt = stmt.where(DownloadTask.status.in_(TASK_KINDS[kind]))
    return list(db.scalars(stmt.order_by(DownloadTask.submitted_at.desc()).limit(limit)))


def ahead_of(db: Session, task: DownloadTask) -> int:
    if task.status != 'queued':
        return 0
    return int(
        db.scalar(
            select(func.count())
            .select_from(DownloadTask)
            .where(DownloadTask.status == 'queued', DownloadTask.submitted_at < task.submitted_at)
        )
        or 0
    )


# ---- worker 侧 ----
def requeue_orphans(db: Session) -> int:
    """把上次 worker 异常退出时悬空的任务重新排队；只在 worker 启动时调用一次。"""
    rows = list(db.scalars(select(DownloadTask).where(DownloadTask.status.in_(IN_FLIGHT))))
    for task in rows:
        task.status = 'queued'
        task.page = 0
        task.message = '上次下载中断，已自动重新排队'
        log(db, 'warn', 'download', f'任务 {task.task_id} 上次执行中断，已重新排队')
    if rows:
        db.commit()
    return len(rows)


def finalize_cancelling(db: Session) -> int:
    """把停留在 cancelling 的残留任务收尾（worker 重启前未确认的取消）。"""
    rows = list(db.scalars(select(DownloadTask).where(DownloadTask.status == 'cancelling')))
    for task in rows:
        task.status = 'cancelled'
        task.message = '已取消'
        task.finished_at = now_ts()
    if rows:
        db.commit()
    return len(rows)


def claim_next(db: Session) -> QueuedTask | None:
    """取最早的一个排队任务并置为 downloading。"""
    finalize_cancelling(db)
    task = db.scalar(
        select(DownloadTask).where(DownloadTask.status == 'queued').order_by(DownloadTask.submitted_at).limit(1)
    )
    if task is None:
        return None

    if task.kind == KIND_IMAGES:
        task.status = 'images_running'
        task.page = 0
        task.message = '正在本地化图片'
        db.commit()
        return QueuedTask(
            task_id=task.task_id,
            kind=KIND_IMAGES,
            thread_id=task.thread_id,
            source=task.source,
            start_page=1,
            replace=False,
            title=task.title,
            submitted_by=task.submitted_by,
        )

    existing = db.get(Thread, task.thread_id)
    start_page = 1
    replace = True
    if existing is not None and existing.page_count > 0 and task.source == 'XD':
        start_page = max(1, existing.page_count)
        replace = False

    task.status = 'downloading'
    task.page = 0
    task.message = '开始下载' if replace else '增量更新：只补最后一页及之后'
    db.commit()
    return QueuedTask(
        task_id=task.task_id,
        kind=task.kind,
        thread_id=task.thread_id,
        source=task.source,
        start_page=start_page,
        replace=replace,
        title=task.title,
        submitted_by=task.submitted_by,
    )


def set_progress(db: Session, task_id: str, page: int, total_pages: int, message: str | None = None) -> None:
    task = db.get(DownloadTask, task_id)
    if task is None:
        return
    task.page = page
    task.total_pages = total_pages or task.total_pages
    if message:
        task.message = message
    db.commit()


def set_status(db: Session, task_id: str, status: str, message: str | None = None) -> DownloadTask | None:
    task = db.get(DownloadTask, task_id)
    if task is None:
        return None
    task.status = status
    if message is not None:
        task.message = message[:512]
    if status in FINISHED:
        task.finished_at = now_ts()
    db.commit()
    return task


def is_cancelling(db: Session, task_id: str) -> bool:
    task = db.get(DownloadTask, task_id)
    return task is not None and task.status == 'cancelling'


def set_written(db: Session, task_id: str, written: int) -> None:
    task = db.get(DownloadTask, task_id)
    if task is None:
        return
    task.written = written
    db.commit()


def fetch_pause() -> float:
    """每个请求通道之间的间隔。"""
    return settings.fetch_pause
