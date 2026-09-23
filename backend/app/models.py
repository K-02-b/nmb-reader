"""数据库模型：表结构的唯一来源。时间字段一律 Unix 秒，post 只插入不更新不删除。"""

from __future__ import annotations

from sqlalchemy import (
    BigInteger,
    Boolean,
    Computed,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    and_,
)
from sqlalchemy.orm import Mapped, foreign, mapped_column, relationship

from .db import Base


class Post(Base):
    __tablename__ = 'post'

    thread_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    cookie: Mapped[str] = mapped_column(String(16), nullable=False)
    page_num: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_po: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_sage: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    body: Mapped[PostBody] = relationship(
        'PostBody',
        primaryjoin=lambda: and_(foreign(PostBody.thread_id) == Post.thread_id, foreign(PostBody.id) == Post.id),
        uselist=False,
        viewonly=True,
    )

    __table_args__ = (
        Index('idx_post_page', 'thread_id', 'page_num'),
        Index('idx_post_cookie', 'thread_id', 'cookie'),
        Index('idx_post_cookie_global', 'cookie', 'id'),
        UniqueConstraint('id', name='uk_post_id'),
    )


class PostBody(Base):
    __tablename__ = 'post_body'

    thread_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    content: Mapped[str] = mapped_column(Text, nullable=False, default='')
    img: Mapped[str | None] = mapped_column(String(255), nullable=True)
    img_source: Mapped[str | None] = mapped_column(String(255), nullable=True)
    title: Mapped[str | None] = mapped_column(String(64), nullable=True)
    name: Mapped[str | None] = mapped_column(String(64), nullable=True)

    __table_args__ = (
        ForeignKeyConstraint(
            ['thread_id', 'id'], ['post.thread_id', 'post.id'], name='fk_body_post', ondelete='CASCADE'
        ),
        UniqueConstraint('id', name='uk_body_id'),
    )


class Thread(Base):
    __tablename__ = 'thread'

    thread_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # 所属板块，从串页面包屑解析
    board: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    cookie: Mapped[str] = mapped_column(String(16), nullable=False)
    replies: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_sage: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    installment: Mapped[float | None] = mapped_column(Numeric(5, 2), nullable=True)
    created_at: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_at: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    page_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    image_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    body: Mapped[PostBody | None] = relationship(
        'PostBody',
        primaryjoin=lambda: and_(
            foreign(PostBody.thread_id) == Thread.thread_id, foreign(PostBody.id) == Thread.thread_id
        ),
        uselist=False,
        viewonly=True,
    )
    tags: Mapped[list[ThreadTag]] = relationship(
        'ThreadTag', back_populates='thread', lazy='selectin', cascade='all, delete-orphan'
    )

    __table_args__ = (
        Index('idx_thread_replies', 'replies'),
        Index('idx_thread_cookie', 'cookie'),
        Index('idx_thread_updated', 'updated_at'),
    )


class TagRegistry(Base):
    __tablename__ = 'tag_registry'

    tag_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tag_type: Mapped[str] = mapped_column(String(16), nullable=False)
    tag_name: Mapped[str] = mapped_column(String(64), nullable=False)

    __table_args__ = (UniqueConstraint('tag_type', 'tag_name', name='uk_tag'),)


class ThreadTag(Base):
    __tablename__ = 'thread_tag'

    thread_id: Mapped[int] = mapped_column(
        Integer, ForeignKey('thread.thread_id', ondelete='CASCADE'), primary_key=True
    )
    tag_id: Mapped[int] = mapped_column(
        Integer, ForeignKey('tag_registry.tag_id', ondelete='CASCADE'), primary_key=True
    )
    tag_type: Mapped[str] = mapped_column(String(16), nullable=False)
    # 必须 STORED：PG 不支持 VIRTUAL
    single_type: Mapped[str | None] = mapped_column(
        String(16),
        Computed("CASE WHEN tag_type = 'CUSTOM_TAG' THEN NULL ELSE tag_type END", persisted=True),
        nullable=True,
    )

    thread: Mapped[Thread] = relationship('Thread', back_populates='tags')
    registry: Mapped[TagRegistry] = relationship('TagRegistry', lazy='joined')

    __table_args__ = (
        UniqueConstraint('thread_id', 'single_type', name='uk_thread_single'),
        Index('idx_thread_tag', 'tag_id', 'thread_id'),
    )


class AppUser(Base):
    __tablename__ = 'app_user'

    user_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(32), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    group_name: Mapped[str] = mapped_column(String(16), nullable=False, default='user')
    banned_until: Mapped[int | None] = mapped_column(Integer, nullable=True)
    failed_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_login_at: Mapped[int | None] = mapped_column(Integer, nullable=True)

    __table_args__ = (UniqueConstraint('username', name='uk_username'),)


class InviteCode(Base):
    __tablename__ = 'invite_code'

    code: Mapped[str] = mapped_column(String(64), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    max_uses: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    used_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    expires_at: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)


class UserSession(Base):
    """服务端会话：Cookie 里只放随机 token，可随时吊销。"""

    __tablename__ = 'user_session'

    token: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey('app_user.user_id', ondelete='CASCADE'))
    created_at: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    expires_at: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class UserCookie(Base):
    """用户导入的 Cookie：密文入库，接口不回显。"""

    __tablename__ = 'user_cookie'

    user_id: Mapped[int] = mapped_column(Integer, ForeignKey('app_user.user_id', ondelete='CASCADE'), primary_key=True)
    ciphertext: Mapped[str] = mapped_column(String(1024), nullable=False)
    created_at: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_at: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    verified_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    verify_ok: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    last_error: Mapped[str | None] = mapped_column(String(255), nullable=True)


class Bookmark(Base):
    __tablename__ = 'bookmark'

    user_id: Mapped[int] = mapped_column(Integer, ForeignKey('app_user.user_id', ondelete='CASCADE'), primary_key=True)
    thread_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    page_num: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class PostBookmark(Base):
    """楼层书签：每个用户在自己看过的串里标记某几层，用来做阅读页右侧的书签栏。"""

    __tablename__ = 'post_bookmark'

    user_id: Mapped[int] = mapped_column(Integer, ForeignKey('app_user.user_id', ondelete='CASCADE'), primary_key=True)
    thread_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    post_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # 用户自己起的书签名，默认空
    title: Mapped[str] = mapped_column(String(60), nullable=False, default='')
    created_at: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    __table_args__ = (Index('idx_post_bookmark_thread', 'user_id', 'thread_id', 'created_at'),)


class ReadProgress(Base):
    __tablename__ = 'read_progress'

    user_id: Mapped[int] = mapped_column(Integer, ForeignKey('app_user.user_id', ondelete='CASCADE'), primary_key=True)
    thread_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    page_num: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    updated_at: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class UserSetting(Base):
    __tablename__ = 'user_setting'

    user_id: Mapped[int] = mapped_column(Integer, ForeignKey('app_user.user_id', ondelete='CASCADE'), primary_key=True)
    key_name: Mapped[str] = mapped_column(String(32), primary_key=True)
    value: Mapped[str] = mapped_column(String(255), nullable=False)


class BlacklistCookie(Base):
    __tablename__ = 'blacklist_cookie'

    user_id: Mapped[int] = mapped_column(Integer, ForeignKey('app_user.user_id', ondelete='CASCADE'), primary_key=True)
    cookie: Mapped[str] = mapped_column(String(16), primary_key=True)


class BlacklistThread(Base):
    __tablename__ = 'blacklist_thread'

    user_id: Mapped[int] = mapped_column(Integer, ForeignKey('app_user.user_id', ondelete='CASCADE'), primary_key=True)
    thread_id: Mapped[int] = mapped_column(Integer, primary_key=True)


class ThreadSuggestion(Base):
    __tablename__ = 'thread_suggestion'

    suggestion_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    thread_id: Mapped[int] = mapped_column(Integer, nullable=False)
    user_id: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    detail: Mapped[str] = mapped_column(String(512), nullable=False, default='')
    status: Mapped[str] = mapped_column(String(16), nullable=False, default='open')
    created_at: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    __table_args__ = (Index('idx_suggestion_thread', 'thread_id', 'status'),)


class DownloadTask(Base):
    """下载/图片任务；kind=images 时 page/total_pages 表示已本地化/待本地化张数。"""

    __tablename__ = 'download_task'

    task_id: Mapped[str] = mapped_column(String(16), primary_key=True)
    kind: Mapped[str] = mapped_column(String(16), nullable=False, default='download', server_default='download')
    thread_id: Mapped[int] = mapped_column(Integer, nullable=False)
    source: Mapped[str] = mapped_column(String(8), nullable=False, default='XD')
    title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default='queued')
    page: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_pages: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    written: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    message: Mapped[str | None] = mapped_column(String(512), nullable=True)
    submitted_by: Mapped[str] = mapped_column(String(32), nullable=False, default='')
    submitted_at: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    finished_at: Mapped[int | None] = mapped_column(Integer, nullable=True)

    __table_args__ = (Index('idx_task_status', 'status', 'submitted_at'),)


class SysLog(Base):
    __tablename__ = 'sys_log'

    log_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'), primary_key=True, autoincrement=True
    )
    ts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    level: Mapped[str] = mapped_column(String(8), nullable=False, default='info')
    scope: Mapped[str] = mapped_column(String(32), nullable=False, default='app')
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    message: Mapped[str] = mapped_column(String(1024), nullable=False, default='')

    __table_args__ = (Index('idx_log_ts', 'ts'),)
