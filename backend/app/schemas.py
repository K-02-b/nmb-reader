"""Pydantic 出参模型：字段名与 frontend/src/api/types.ts 完全一致（camelCase）。"""

from __future__ import annotations

from typing import Generic, TypeVar

from pydantic import BaseModel, ConfigDict


def to_camel(name: str) -> str:
    head, *rest = name.split('_')
    return head + ''.join(word.capitalize() for word in rest)


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)


class TagOut(CamelModel):
    tag_id: int
    tag_type: str
    tag_name: str


class PostOut(CamelModel):
    thread_id: int
    id: int
    cookie: str
    page_num: int
    is_po: bool
    is_sage: bool
    is_admin: bool
    created_at: int
    content: str = ''
    img: str | None = None
    img_source: str | None = None
    title: str | None = None
    name: str | None = None


class ThreadOut(CamelModel):
    thread_id: int
    # 所属板块
    board: str | None = None
    cookie: str
    replies: int
    is_sage: bool
    is_admin: bool
    installment: float | None = None
    created_at: int
    updated_at: int
    title: str
    excerpt: str
    img: str | None = None
    tags: list[TagOut] = []
    reply_count: int
    image_count: int
    page_count: int


class TagVocabulary(CamelModel):
    genre: list[str] = []
    series: list[str] = []
    status: list[str] = []
    # 卷次；数字字符串，支持 13.5 这类间章
    installment: list[str] = []
    tags: list[str] = []


class SessionOut(CamelModel):
    username: str
    group: str
    permissions: list[str]


class UserOut(CamelModel):
    username: str
    group: str
    created_at: int
    last_login_at: int
    banned: bool


class InviteOut(CamelModel):
    code: str
    enabled: bool
    max_uses: int
    used_count: int
    expires_at: int
    note: str | None = None


class BookmarkOut(CamelModel):
    thread_id: int
    title: str
    page: int
    created_at: int


class PostBookmarkOut(CamelModel):
    """一条楼层书签：楼层号 + 所属串 + 该楼所在岛页 + 正文摘要 + 用户起的名字。"""

    post_id: int
    thread_id: int
    thread_title: str = ''
    title: str = ''
    page_num: int
    excerpt: str
    created_at: int
    tags: list[TagOut] = []


class DownloadTaskOut(CamelModel):
    task_id: str
    # download = 抓页入库；images = 图片本地化
    kind: str = 'download'
    thread_id: int
    # 提交时填的标题；没填就是 null（前端只显示任务自己的串号）
    title: str | None = None
    source: str
    status: str
    submitted_by: str
    submitted_at: int
    finished_at: int | None = None
    page: int
    total_pages: int
    written: int = 0
    message: str | None = None
    ahead: int = 0


class LogOut(CamelModel):
    ts: int
    level: str
    scope: str
    message: str


class FulltextResult(CamelModel):
    """全文检索结果。只带命中楼本身——每条再塞一份完整串首纯属浪费（前端从不读）。

    `truncated` 表示命中数超过 `limit`，界面要明确告诉用户结果被截断了。
    """

    hits: list[PostOut]
    limit: int
    truncated: bool


class UserSettingsOut(CamelModel):
    """与前端 UserSettings 对齐；值统一用字符串存 user_setting 表。"""

    theme: str = 'dark'
    accent: str = '#6ea8fe'
    font_size: float = 15.0
    font_family: str = 'system'
    line_height: float = 1.75
    brightness: float = 100.0
    page_size: int = 20
    paging_mode: str = 'island'
    # 单串最大下载页数；None 表示用服务器默认值
    fetch_max_pages: int | None = None
    # 页请求并发度；None 表示用服务器默认值
    fetch_concurrency: int | None = None
    # 上次导出时选的「是否内嵌图片 / 图片质量」
    export_images: bool = False
    export_quality: str = 'medium'
    blacklist_cookies: list[str] = []
    blacklist_threads: list[int] = []


T = TypeVar('T')


class Paged(CamelModel, Generic[T]):
    """分页语义见 docs/contract.md。"""

    items: list[T]
    total: int
    page: int
    page_size: int


class CookieStatusOut(CamelModel):
    """Cookie 状态：只有元信息，不含明文。"""

    configured: bool = False
    source: str = 'none'  # user | server | none
    updated_at: int | None = None
    verified_at: int | None = None
    verify_ok: bool | None = None
    last_error: str | None = None
    # 二维码里标注的饼干 ID，只在扫码导入的响应里返回
    label: str | None = None


class OkResponse(CamelModel):
    ok: bool = True
    message: str | None = None
