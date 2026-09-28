"""下载队列接口：提交 / 查看 / 取消 / 重试 / SSE 实时推送。"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import Field, field_validator
from sqlalchemy.orm import Session

from ..db import SessionLocal, get_db
from ..deps import require_download, require_user
from ..models import AppUser, DownloadTask
from ..schemas import CamelModel, DownloadTaskOut
from ..services import queue as queue_service

router = APIRouter(prefix='/api/downloads', tags=['downloads'])

# SSE 的轮询节奏：有任务在跑就勤快些，全空闲时放慢（worker 可能是别的进程，
# 没有进程内事件总线，只能靠查库发现变化）
TICK_ACTIVE = 1.0
TICK_IDLE = 3.0
# 连续多少个空转 tick 发一次心跳注释，避免中间代理把闲置连接掐掉
KEEPALIVE_TICKS = 15
ACTIVE_STATUSES = queue_service.TASK_KINDS['active']
# 全量推送的上限；管理页的列表就在这个窗口里做筛选与翻页
STREAM_LIMIT = 200
STREAM_LIMIT_MAX = 500


class SubmitIn(CamelModel):
    thread_id: int = Field(alias='threadId')
    source: str = 'XD'
    title: str | None = None

    @field_validator('thread_id', mode='before')
    @classmethod
    def _accept_no_prefix(cls, value: object) -> object:
        """允许直接粘贴「No.59775198」这种写法。"""
        if isinstance(value, str):
            cleaned = value.strip().removeprefix('No.').removeprefix('no.').strip()
            if cleaned.isdigit():
                return int(cleaned)
        return value


def task_out(
    db: Session, task: DownloadTask, with_ahead: bool = True, ahead_map: dict[str, int] | None = None
) -> DownloadTaskOut:
    """ahead_map 是 ahead_positions 的结果：一批任务共用，别一个任务查一次库。"""
    if not with_ahead:
        ahead = 0
    elif ahead_map is not None:
        ahead = ahead_map.get(task.task_id, 0)
    else:
        ahead = queue_service.ahead_of(db, task)
    return DownloadTaskOut(
        task_id=task.task_id,
        kind=task.kind,
        thread_id=task.thread_id,
        title=task.title,
        source=task.source,
        status=task.status,
        submitted_by=task.submitted_by,
        submitted_at=task.submitted_at,
        finished_at=task.finished_at,
        page=task.page,
        total_pages=task.total_pages,
        written=task.written,
        message=task.message,
        ahead=ahead,
    )


def _tasks(
    db: Session, limit: int, since: int | None, status_kind: str | None, with_ahead: bool
) -> list[DownloadTaskOut]:
    """列表接口与 SSE 共用：排队位置一次算好，避免每个任务一条 COUNT。"""
    ahead_map = queue_service.ahead_positions(db) if with_ahead else None
    return [
        task_out(db, task, with_ahead=with_ahead, ahead_map=ahead_map)
        for task in queue_service.list_tasks(db, limit, since, status_kind)
    ]


def _sse(event: str, data: object) -> str:
    return f'event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n'


@router.get('', response_model=list[DownloadTaskOut], summary='下载任务列表（所有登录用户可见）')
def list_downloads(
    limit: int = Query(100, ge=1, le=500),
    since: int | None = Query(None, ge=0, description='只返回该 Unix 秒之后提交的任务'),
    status_kind: str | None = Query(
        None, alias='status', pattern='^(active|done|failed)$', description='按状态档筛选：进行中 / 已完成 / 失败'
    ),
    with_ahead: bool = Query(False, alias='withAhead', description='是否算排队位置（管理页用；默认不算）'),
    db: Session = Depends(get_db),
    _user: AppUser = Depends(require_user),
) -> list[DownloadTaskOut]:
    return _tasks(db, limit, since, status_kind, with_ahead)


@router.post('', response_model=DownloadTaskOut, summary='提交下载申请')
def submit(
    payload: SubmitIn,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_download),
) -> DownloadTaskOut:
    task = queue_service.submit_task(db, payload.thread_id, payload.source, payload.title, user.username, user.user_id)
    return task_out(db, task)


@router.post('/{task_id}/cancel', response_model=DownloadTaskOut, summary='取消任务')
def cancel(
    task_id: str,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_download),
) -> DownloadTaskOut:
    task = queue_service.cancel_task(db, task_id, user.user_id)
    return task_out(db, task)


@router.post('/{task_id}/retry', response_model=DownloadTaskOut, summary='重新提交任务')
def retry(
    task_id: str,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_download),
) -> DownloadTaskOut:
    task = queue_service.retry_task(db, task_id, user.user_id)
    return task_out(db, task)


@router.get('/stream', summary='任务状态实时推送（SSE：全量快照 + 增量）')
async def stream(
    request: Request,
    limit: int = Query(STREAM_LIMIT, ge=1, le=STREAM_LIMIT_MAX, description='推送窗口大小（最新 N 条）'),
    since: int | None = Query(None, ge=0),
    status_kind: str | None = Query(None, alias='status', pattern='^(active|done|failed)$'),
    with_ahead: bool = Query(False, alias='withAhead', description='是否带排队位置（管理页用）'),
    _user: AppUser = Depends(require_user),
) -> StreamingResponse:
    """连上先推一次全量（`event: tasks`），之后只推变化的任务。

    - `event: patch`  新增或字段有变化的任务（`page` / `written` / `message` 这类进度也算变化）
    - `event: remove` 已经不在推送窗口里的 taskId（超出 limit 或被筛选掉）
    - 没有变化时不发数据，只按 KEEPALIVE_TICKS 发心跳注释，前端不必轮询

    worker 可能是独立进程，没有进程内事件总线，所以这里按需查库：
    有任务在跑 1s 一次，全空闲 3s 一次。
    """

    async def event_source() -> AsyncIterator[str]:
        # 断线后浏览器隔多久重连（毫秒）
        yield 'retry: 3000\n\n'
        known: dict[str, str] = {}
        first = True
        idle = 0
        while True:
            if await request.is_disconnected():
                break
            with SessionLocal() as db:
                payload = [task.model_dump(by_alias=True) for task in _tasks(db, limit, since, status_kind, with_ahead)]
            # 逐条比对序列化结果：状态、进度、排队位置、消息有任何变化都算
            current = {item['taskId']: json.dumps(item, ensure_ascii=False, sort_keys=True) for item in payload}
            if first:
                yield _sse('tasks', payload)
                first = False
                idle = 0
            else:
                changed = [item for item in payload if current[item['taskId']] != known.get(item['taskId'])]
                removed = [task_id for task_id in known if task_id not in current]
                if changed or removed:
                    if changed:
                        yield _sse('patch', changed)
                    if removed:
                        yield _sse('remove', removed)
                    idle = 0
                else:
                    idle += 1
                    if idle % KEEPALIVE_TICKS == 0:
                        # 心跳用事件而不是注释行：注释浏览器看不见，前端就没法判断「连接是活的但没数据」
                        # 还是「连接早死了」——半开的连接（对端没了却没有 FIN）不会触发 error。
                        yield _sse('ping', {})
            known = current
            busy = any(item['status'] in ACTIVE_STATUSES for item in payload)
            await asyncio.sleep(TICK_ACTIVE if busy else TICK_IDLE)

    return StreamingResponse(
        event_source(),
        media_type='text/event-stream',
        headers={'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no'},
    )
