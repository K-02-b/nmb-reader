"""导出：Markdown / JSON 由本项目生成，DOCX / PDF 复用 nmb-exporter 的排版实现。

`services/nmb_export.py` 是 https://github.com/K-02-b/nmb-exporter 的 export.py
@ 76cd826 的**原样副本**（AGPL-3.0，与本项目同许可）——不要在这里改代码，上游更新后整份替换即可。
它需要宿主提供两样东西，我们在下面用 `configure(ExportEnv(...))` 注入一次：

- `font_dir`：PDF / JPG 用的中文字体目录（仓库不放字体，`make fetch-fonts` 下载）
- `image_resolver`：我们的图片直接放在临时目录根下（<楼号>.jpg），不是它的 base_dir/quality/ 布局

本项目在导出里只做两件事：把 `PostOut` 转成它要的 dict 形状；按「图片质量」档位把图片
缩放成 JPEG 放进临时目录交给它内嵌（它的 image_opts 只区分缩略图/原图，压缩档位归我们定）。
"""

from __future__ import annotations

import io
import json
import logging
import re
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy.orm import Session

from ..schemas import PostOut
from ..services import images as image_service
from ..services import nmb_export
from ..services import threads as thread_service
from ..services.nmb_export import ExportEnv

log = logging.getLogger('xdnmb.exporter')

# PDF / JPG 用的中文字体（make fetch-fonts 下载到包内）
FONT_DIR = Path(__file__).resolve().parent.parent / 'assets' / 'fonts'


def _resolve_image(img: str, ext: str, quality: str, base_dir: str) -> str:
    """图片已按质量档位准备好放在 base_dir 根下，文件名就是 <楼号>.jpg。"""
    return str(Path(base_dir) / f'{img}{ext}')


# 进程级注入一次；上游的默认实现依赖它自己的 images.py，这里换成我们的布局
nmb_export.configure(ExportEnv(font_dir=str(FONT_DIR), image_resolver=_resolve_image))

CST = timezone(timedelta(hours=8))
MD_ESCAPES = [
    (re.compile(r'>>'), r'\\>\\>'),
    (re.compile(r'`'), r'\\`'),
    (re.compile(r'^(\s*)([-*+]|\d+\.)\s', re.M), r'\1\\\2 '),
    (re.compile(r'^(\s*)#', re.M), r'\1\\#'),
]

# 导出档位 → (最大边长 px, JPEG 质量)
QUALITY_PRESETS = {
    'high': (1600, 85),
    'medium': (1000, 75),
    'low': (640, 60),
}
DEFAULT_QUALITY = 'medium'
# 单次导出最多内嵌多少张图，避免把内存和文件撑爆
MAX_EMBEDDED_IMAGES = 500


@dataclass
class ExportOptions:
    images: bool = False
    quality: str = DEFAULT_QUALITY


def escape_markdown(text: str) -> str:
    result = text
    for pattern, replacement in MD_ESCAPES:
        result = pattern.sub(replacement, result)
    return result


def fmt_time(ts: int) -> str:
    if not ts:
        return '-'
    return datetime.fromtimestamp(ts, CST).strftime('%Y-%m-%d %H:%M:%S')


def _require_thread(db: Session, thread_id: int):
    thread = thread_service.get_thread(db, thread_id)
    if thread is None:
        raise ValueError(f'串不存在：{thread_id}')
    return thread


def _posts(db: Session, thread_id: int) -> list[PostOut]:
    posts, _total, _pages = thread_service.list_posts(db, thread_id, page=1, page_size=10**6, paging_mode='custom')
    return posts


def _meta_lines(thread) -> list[str]:
    return [
        f'串号：No.{thread.thread_id}',
        f'作者：ID:{thread.cookie}',
        f'发布：{fmt_time(thread.created_at)}',
        f'更新：{fmt_time(thread.updated_at)}',
        f'规模：{thread.reply_count} 楼 / {thread.page_count} 页 / {thread.image_count} 图',
        f'标签：{"、".join(tag.tag_name for tag in thread.tags) or "（无）"}',
        f'来源：https://www.nmbxd1.com/t/{thread.thread_id}',
    ]


def _markers(post: PostOut) -> str:
    marks = ['PO'] if post.is_po else []
    if post.is_sage:
        marks.append('SAGE')
    if post.is_admin:
        marks.append('管理')
    return f'（{"、".join(marks)}）' if marks else ''


# ---- 图片：本地优先，缺失回源图床，按档位压成 JPEG ----
def _load_image_bytes(thread_id: int, post: PostOut) -> bytes | None:
    local = image_service.find_local(thread_id, post.id)
    if local is not None:
        return local.read_bytes()
    source = post.img_source or post.img
    if not source:
        return None
    try:
        from .nmb_parse import HttpSession

        with HttpSession() as session:
            return session.get_bytes(source, retries=2)
    except Exception as exc:  # noqa: BLE001 - 单张失败不该中断导出
        log.warning('导出取图失败 %s: %s', source, exc)
        return None


def _prepare_image(raw: bytes, quality: str) -> bytes | None:
    from PIL import Image

    max_edge, jpeg_quality = QUALITY_PRESETS.get(quality, QUALITY_PRESETS[DEFAULT_QUALITY])
    try:
        with Image.open(io.BytesIO(raw)) as im:
            im = im.convert('RGB')
            if max(im.size) > max_edge:
                im.thumbnail((max_edge, max_edge))
            out = io.BytesIO()
            im.save(out, 'JPEG', quality=jpeg_quality, optimize=True)
            return out.getvalue()
    except Exception as exc:  # noqa: BLE001 - 坏图跳过
        log.warning('导出处理图片失败: %s', exc)
        return None


def _payload(posts: list[PostOut]) -> list[dict]:
    """转成 nmb_export 要的形状；img/ext 用「楼号 + .jpg」对应临时目录里的文件名。"""
    payload: list[dict] = []
    for post in posts:
        has_image = bool(post.img or post.img_source)
        payload.append(
            {
                'id': post.id,
                'cookie': post.cookie,
                'timestamp': fmt_time(post.created_at),
                'title': post.title or '',
                'name': post.name or '',
                'content': post.content or '',
                'is_po': post.is_po,
                'is_admin': post.is_admin,
                'is_sage': post.is_sage,
                'img': str(post.id) if has_image else '',
                'ext': '.jpg' if has_image else '',
            }
        )
    return payload


def _prepare_images(thread_id: int, posts: list[PostOut], options: ExportOptions, tmp_dir: Path) -> int:
    if not options.images:
        return 0
    saved = 0
    for post in posts:
        if saved >= MAX_EMBEDDED_IMAGES:
            log.warning('导出图片达到上限 %s 张，其余只保留文字', MAX_EMBEDDED_IMAGES)
            break
        if not (post.img or post.img_source):
            continue
        raw = _load_image_bytes(thread_id, post)
        if not raw:
            continue
        prepared = _prepare_image(raw, options.quality)
        if not prepared:
            continue
        (tmp_dir / f'{post.id}.jpg').write_bytes(prepared)
        saved += 1
    return saved


def _image_opts(tmp_dir: Path, options: ExportOptions) -> dict | None:
    if not options.images:
        return None
    # 图片已按档位准备好放在 tmp_dir，文件名就是 <楼号>.jpg，不用它再下载
    return {'quality': 'image', 'base_dir': str(tmp_dir), 'fetch': False}


def _render(kind: str, data: list[dict], image_opts: dict | None) -> bytes:
    """调用 nmb_export 写到临时文件，再读成 bytes 返回给 HTTP。"""
    with tempfile.TemporaryDirectory(prefix='nmb-export-') as tmp:
        out = Path(tmp) / f'out.{kind}'
        exporter = nmb_export.export_doc if kind == 'docx' else nmb_export.export_pdf
        exporter(data, str(out), image_opts=image_opts)
        if not out.is_file() or out.stat().st_size == 0:
            raise RuntimeError(f'{kind} 导出没有产出内容')
        return out.read_bytes()


def ensure_pdf_font() -> Path:
    """PDF 走 fpdf2 + 中文字体；缺字体时中文会变成空白，所以先自检。"""
    font = FONT_DIR / nmb_export.FONT_CJK
    if not font.is_file():
        raise FileNotFoundError(
            f'PDF 导出需要中文字体 {font}；先跑 make fetch-fonts（或把它放到 backend/app/assets/fonts/）'
        )
    return font


# ---- Markdown / JSON ----
def thread_to_markdown(db: Session, thread_id: int, escape: bool = True) -> str:
    thread = _require_thread(db, thread_id)
    lines: list[str] = [f'# {thread.title}', '', *[f'- {line}' for line in _meta_lines(thread)], '', '---', '']

    for post in _posts(db, thread_id):
        lines.append(
            f'### No.{post.id} · {post.name or "无名氏"} · {fmt_time(post.created_at)} · ID:{post.cookie}{_markers(post)}'
        )
        lines.append('')
        body = escape_markdown(post.content) if escape else post.content
        lines.append(body if body else '（无内容）')
        lines.append('')
        if post.img_source:
            lines.append(f'![No.{post.id} 附图]({post.img_source})')
        elif post.img:
            lines.append(f'![No.{post.id} 附图]({post.img})')
        lines.append('')
        lines.append('---')
        lines.append('')

    return '\n'.join(lines)


def thread_to_json(db: Session, thread_id: int) -> dict:
    thread = _require_thread(db, thread_id)
    return {
        'thread': thread.model_dump(by_alias=True),
        'posts': [post.model_dump(by_alias=True) for post in _posts(db, thread_id)],
        'exportedAt': int(datetime.now(tz=CST).timestamp()),
    }


def thread_to_json_text(db: Session, thread_id: int) -> str:
    return json.dumps(thread_to_json(db, thread_id), ensure_ascii=False, indent=1)


# ---- DOCX / PDF（排版交给 nmb_export）----
def thread_to_docx(db: Session, thread_id: int, options: ExportOptions | None = None) -> bytes:
    options = options or ExportOptions()
    _require_thread(db, thread_id)
    posts = _posts(db, thread_id)
    with tempfile.TemporaryDirectory(prefix='nmb-export-img-') as tmp:
        tmp_dir = Path(tmp)
        _prepare_images(thread_id, posts, options, tmp_dir)
        return _render('docx', _payload(posts), _image_opts(tmp_dir, options))


def thread_to_pdf(db: Session, thread_id: int, options: ExportOptions | None = None) -> bytes:
    options = options or ExportOptions()
    _require_thread(db, thread_id)
    ensure_pdf_font()
    posts = _posts(db, thread_id)
    with tempfile.TemporaryDirectory(prefix='nmb-export-img-') as tmp:
        tmp_dir = Path(tmp)
        _prepare_images(thread_id, posts, options, tmp_dir)
        return _render('pdf', _payload(posts), _image_opts(tmp_dir, options))
