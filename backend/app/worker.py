"""下载 worker：串行消费队列，执行抓取 → 入库 → 建索引。独立进程跑 `python -m app.worker`。"""

from __future__ import annotations

import logging
import threading
import time

from sqlalchemy.orm import Session

from .db import SessionLocal, init_db
from .services import cookies as cookie_service
from .services import images as image_service
from .services import nmb_parse
from .services import prefs as prefs_service
from .services import queue as queue_service
from .services import search as search_service
from .services.auth import log as write_log
from .services.importer import import_thread_payload
from .settings import settings

log = logging.getLogger('xdnmb.worker')


def _run_images_task(db: Session, task: queue_service.QueuedTask) -> None:
    """图片本地化任务：只拉图，不碰页面与入库。"""
    task_id = task.task_id
    cookie, _source = cookie_service.decrypt_for_user(db, task.submitted_by)
    if not cookie:
        queue_service.set_status(db, task_id, 'images_failed', '没有可用的 Cookie：请先导入')
        write_log(db, 'error', 'images', f'任务 {task_id} 失败：提交者 {task.submitted_by} 未导入 Cookie')
        return

    def report(done: int, total: int) -> None:
        queue_service.set_progress(db, task_id, done, total, f'图片 {done}/{total} 张')

    try:
        saved, total = image_service.fetch_thread_images_progress(db, task.thread_id, cookie=cookie, on_progress=report)
    except Exception as exc:  # noqa: BLE001 - 兜底，别让 worker 崩掉
        queue_service.set_status(db, task_id, 'images_failed', f'图片本地化异常：{exc}')
        write_log(db, 'error', 'images', f'任务 {task_id} 图片本地化异常：{exc}')
        return

    queue_service.set_progress(db, task_id, saved, total)
    queue_service.set_status(db, task_id, 'images_done', f'完成：本地化 {saved}/{total} 张图片')
    write_log(db, 'info', 'images', f'任务 {task_id} 完成 No.{task.thread_id} 图片本地化（{saved}/{total}）')


def _run_task(db: Session, task: queue_service.QueuedTask) -> None:
    """执行一个任务；异常统一转成失败状态。"""
    if task.kind == queue_service.KIND_IMAGES:
        _run_images_task(db, task)
        return
    task_id = task.task_id
    pause = queue_service.fetch_pause()
    # 页数上限与并发度取用户设置，服务器侧有硬上限
    max_pages, concurrency, limits_source = prefs_service.effective_for_user(db, task.submitted_by)

    # Cookie 按提交者取，用户自己的优先
    cookie, cookie_source = cookie_service.decrypt_for_user(db, task.submitted_by)
    if not cookie:
        queue_service.set_status(db, task_id, 'failed', '没有可用的 Cookie：请在「设置 → Cookie」里导入你自己的')
        write_log(db, 'error', 'download', f'任务 {task_id} 失败：提交者 {task.submitted_by} 未导入 Cookie')
        return
    # 下载前预检登录态，避免白跑一场
    ok, reason = cookie_service.verify_cookie(cookie)
    if not ok:
        queue_service.set_status(db, task_id, 'failed', f'Cookie 校验未通过：{reason}')
        write_log(db, 'error', 'download', f'任务 {task_id} 失败：Cookie 校验未通过（{reason}）')
        return
    write_log(
        db,
        'info',
        'download',
        f'任务 {task_id} 使用 {cookie_source} 来源的 Cookie、上限 {max_pages} 页、并发 {concurrency}（{limits_source}）开始下载',
    )

    # should_stop 会在抓取线程里被调用，而 Session 不是线程安全的；回调里的库访问过这把锁
    db_lock = threading.Lock()
    cancel_state = {'checked_at': 0.0, 'cancelling': False}

    def on_page(page_num: int, total_pages: int, replies: int) -> None:
        with db_lock:
            queue_service.set_progress(
                db, task_id, page_num, total_pages, f'第 {page_num}/{total_pages} 页（{replies} 楼）'
            )

    def should_stop() -> bool:
        now = time.monotonic()
        with db_lock:
            if now - cancel_state['checked_at'] < 1.0:
                return bool(cancel_state['cancelling'])
            cancel_state['cancelling'] = queue_service.is_cancelling(db, task_id)
            cancel_state['checked_at'] = now
            return bool(cancel_state['cancelling'])

    try:
        payload = nmb_parse.download_thread(
            task.thread_id,
            cookie=cookie,
            start_page=task.start_page,
            pause=pause,
            max_pages=max_pages,
            concurrency=concurrency,
            on_page=on_page,
            should_stop=should_stop,
        )
    except nmb_parse.FetchError as exc:
        if exc.code == 'CANCELLED':
            queue_service.set_status(db, task_id, 'cancelled', '已取消')
            write_log(db, 'warn', 'download', f'任务 {task_id} 已取消')
            return
        queue_service.set_status(db, task_id, 'failed', str(exc))
        write_log(db, 'error', 'download', f'任务 {task_id} 失败：[{exc.code}] {exc}')
        return
    except Exception as exc:  # noqa: BLE001 - 兜底，别让 worker 崩掉
        queue_service.set_status(db, task_id, 'failed', f'下载异常：{exc}')
        write_log(db, 'error', 'download', f'任务 {task_id} 下载异常：{exc}')
        return

    total_pages = int(payload['thread']['pageCount'])
    queue_service.set_status(db, task_id, 'downloaded', f'下载完成：{payload["thread"]["replies"]} 楼')
    queue_service.set_progress(db, task_id, total_pages, total_pages)

    queue_service.set_status(db, task_id, 'writing')
    try:
        result = import_thread_payload(db, payload, replace=task.replace)
    except Exception as exc:  # noqa: BLE001
        queue_service.set_status(db, task_id, 'write_failed', f'写库失败：{exc}')
        write_log(db, 'error', 'download', f'任务 {task_id} 写库失败：{exc}')
        return
    queue_service.set_written(db, task_id, result.posts)
    queue_service.set_status(db, task_id, 'written', f'已入库 {result.posts} 楼')

    queue_service.set_status(db, task_id, 'indexing')
    try:
        indexed = search_service.index_thread(db, result.thread_id)
    except Exception as exc:  # noqa: BLE001
        queue_service.set_status(db, task_id, 'index_failed', f'索引失败：{exc}')
        write_log(db, 'error', 'download', f'任务 {task_id} 索引失败：{exc}')
        return

    # 图片本地化单独排队，不阻塞下载队列；已经全在本地就不用排了
    queued_images = None
    missing = image_service.count_pending_images(db, result.thread_id) if settings.images_enabled else 0
    if missing:
        try:
            queued_images = queue_service.enqueue_images(db, result.thread_id, task.submitted_by, missing)
        except Exception as exc:  # noqa: BLE001
            write_log(db, 'warn', 'download', f'任务 {task_id} 排队图片任务失败：{exc}')

    tail = f'，已排队图片任务 {queued_images.task_id}' if queued_images else ''
    queue_service.set_status(db, task_id, 'indexed', f'完成：{result.posts} 楼，索引 {indexed} 楼{tail}')
    write_log(db, 'info', 'download', f'任务 {task_id} 完成 No.{result.thread_id}')


def run_once(db: Session) -> bool:
    """取一个任务执行；没有任务返回 False。"""
    task = queue_service.claim_next(db)
    if task is None:
        return False
    log.info('claim task %s (No.%s, source=%s)', task.task_id, task.thread_id, task.source)
    _run_task(db, task)
    return True


def worker_loop(stop_event: threading.Event | None = None, poll_seconds: float | None = None) -> None:
    poll = poll_seconds if poll_seconds is not None else settings.worker_poll_seconds
    init_db()
    with SessionLocal() as db:
        requeued = queue_service.requeue_orphans(db)
        if requeued:
            log.warning('已把 %s 个中断的任务重新排队', requeued)
    log.info('worker started (poll=%.1fs, source=%s)', poll, settings.db_url)
    while not (stop_event and stop_event.is_set()):
        with SessionLocal() as db:
            try:
                worked = run_once(db)
            except Exception as exc:  # noqa: BLE001 - 单轮异常不影响下一轮
                log.exception('worker 轮询异常：%s', exc)
                worked = False
        if not worked:
            time.sleep(poll)


def start_background_worker() -> threading.Event:
    stop_event = threading.Event()
    thread = threading.Thread(target=worker_loop, args=(stop_event,), name='xdnmb-worker', daemon=True)
    thread.start()
    return stop_event


def main() -> int:
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s %(message)s')
    # httpx 每个请求都打 INFO，会淹掉进度日志
    logging.getLogger('httpx').setLevel(logging.WARNING)
    logging.getLogger('httpcore').setLevel(logging.WARNING)
    try:
        worker_loop()
    except KeyboardInterrupt:
        log.info('worker stopped')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
