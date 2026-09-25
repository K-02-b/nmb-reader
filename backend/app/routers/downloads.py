"""下载队列接口：提交 / 查看 / 取消 / 重试 / SSE 推送。"""

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


def task_out(db: Session, task: DownloadTask, with_ahead: bool = True) -> DownloadTaskOut:
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
        # 排队位置要一条一个 COUNT；只有管理页要，全局轮询（limit=20、几秒一次）不算
        ahead=queue_service.ahead_of(db, task) if with_ahead else 0,
    )


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
    return [
        task_out(db, task, with_ahead=with_ahead) for task in queue_service.list_tasks(db, limit, since, status_kind)
    ]


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


@router.get('/stream', summary='任务状态推送（SSE）')
async def stream(request: Request, _user: AppUser = Depends(require_user)) -> StreamingResponse:
    """数据库轮询式 SSE：worker 可能是独立进程，所以不做进程内事件总线。"""

    async def event_source() -> AsyncIterator[str]:
        last: dict[str, str] = {}
        idle = 0
        while True:
            if await request.is_disconnected():
                break
            with SessionLocal() as db:
                tasks = queue_service.list_tasks(db, 100)
                # 每秒推一次，不含排队位置（要一条一个 COUNT）
                payload = [task_out(db, task, with_ahead=False).model_dump(by_alias=True) for task in tasks]
            snapshot = {item['taskId']: item['status'] for item in payload}
            if snapshot != last:
                last = snapshot
                yield f'event: tasks\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n'
                idle = 0
            else:
                idle += 1
                if idle % 15 == 0:  # 心跳，避免代理断连
                    yield ': keep-alive\n\n'
            await asyncio.sleep(1.0)

    return StreamingResponse(
        event_source(),
        media_type='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
    )
