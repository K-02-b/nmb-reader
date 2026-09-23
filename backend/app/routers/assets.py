"""图片、导出与数据库运维接口。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from fastapi.responses import FileResponse, RedirectResponse, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require_db_manage
from ..errors import not_found
from ..models import AppUser, PostBody
from ..schemas import CamelModel
from ..services import exporter, images, maintenance
from ..services import threads as thread_service

router = APIRouter(prefix='/api', tags=['assets'])


# ---- 图片 ----
@router.get('/images/{thread_id}/{post_id}', summary='图片：本地优先，缺失回源图床')
def get_image(thread_id: int, post_id: int, db: Session = Depends(get_db)) -> Response:
    local = images.find_local(thread_id, post_id)
    if local is not None:
        return FileResponse(local, media_type=images.content_type(local))
    row = db.get(PostBody, (thread_id, post_id))
    if row is None:
        raise not_found('找不到这一楼', 'POST_NOT_FOUND')
    if row.img_source:
        return RedirectResponse(row.img_source, status_code=302)
    raise not_found('这一楼没有图片', 'IMAGE_NOT_FOUND')


# ---- 导出 ----
EXPORT_FORMATS = {
    'md': ('text/markdown; charset=utf-8', 'md'),
    'json': ('application/json; charset=utf-8', 'json'),
    'docx': ('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'),
    'pdf': ('application/pdf', 'pdf'),
}


@router.get('/threads/{thread_id}/export', summary='导出串（md / json / docx / pdf）')
def export_thread(
    thread_id: int,
    format: str = Query('md', pattern='^(md|json|docx|pdf)$'),
    images: bool = Query(False, description='docx / pdf 是否内嵌图片'),
    quality: str = Query('medium', pattern='^(high|medium|low)$', description='内嵌图片的质量档位'),
    db: Session = Depends(get_db),
) -> Response:
    if thread_service.get_thread(db, thread_id) is None:
        raise not_found('串不存在或不是主串', 'THREAD_NOT_FOUND')

    options = exporter.ExportOptions(images=images, quality=quality)
    if format == 'json':
        body: bytes | str = exporter.thread_to_json_text(db, thread_id)
    elif format == 'docx':
        body = exporter.thread_to_docx(db, thread_id, options)
    elif format == 'pdf':
        body = exporter.thread_to_pdf(db, thread_id, options)
    else:
        body = exporter.thread_to_markdown(db, thread_id)

    media, ext = EXPORT_FORMATS[format]
    return Response(
        content=body,
        media_type=media,
        headers={'Content-Disposition': f'attachment; filename="No.{thread_id}.{ext}"'},
    )


# ---- 数据库运维 ----
class DbOperationOut(CamelModel):
    message: str


class BackupIn(BaseModel):
    name: str | None = None


@router.get('/db/stats', summary='数据库概况（db.manage）')
def db_stats(db: Session = Depends(get_db), _user: AppUser = Depends(require_db_manage)) -> dict[str, object]:
    return maintenance.stats(db)


@router.post('/db/backup', response_model=DbOperationOut, summary='备份数据库（db.manage）')
def db_backup(db: Session = Depends(get_db), user: AppUser = Depends(require_db_manage)) -> DbOperationOut:
    message = maintenance.backup(db)
    from ..services.auth import log as write_log

    write_log(db, 'info', 'db', message, user.user_id)
    return DbOperationOut(message=message)


@router.post('/db/restore', response_model=DbOperationOut, summary='从备份恢复（db.manage）')
def db_restore(
    payload: BackupIn | None = None,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_db_manage),
) -> DbOperationOut:
    message = maintenance.restore(db, payload.name if payload else None)
    from ..services.auth import log as write_log

    write_log(db, 'warn', 'db', message, user.user_id)
    return DbOperationOut(message=message)


@router.post('/db/clean', response_model=DbOperationOut, summary='清理孤立数据（db.manage）')
def db_clean(db: Session = Depends(get_db), user: AppUser = Depends(require_db_manage)) -> DbOperationOut:
    message = maintenance.clean(db)
    from ..services.auth import log as write_log

    write_log(db, 'info', 'db', message, user.user_id)
    return DbOperationOut(message=message)
