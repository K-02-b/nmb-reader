"""应用配置。环境变量前缀 THREAD_READER_，也可写进 backend/.env。"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPO_ROOT / 'backend'


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix='THREAD_READER_',
        env_file=str(BACKEND_ROOT / '.env'),
        extra='ignore',
    )

    # 服务
    host: str = '127.0.0.1'
    port: int = 8080

    # 存储
    data_dir: Path = BACKEND_ROOT / 'data'
    db_url: str = ''

    # 会话
    cookie_name: str = 'xdnmb_session'
    session_ttl: int = 43200  # 秒
    cookie_secure: bool = False
    login_fail_limit: int = 5
    login_ban_seconds: int = 86400

    # Cookie：用户各自导入（加密存 user_cookie 表），nmb_cookie 是服务器级兜底
    nmb_cookie: str = ''
    # 加密主密钥；留空则自动生成 <data_dir>/secret.key
    secret_key: str = ''
    # 校验 Cookie 用的受限板块
    cookie_verify_board: str = '速报2'
    fetch_pause: float = 1.2
    # 单串页数上限（用户可调，夹在此范围内）
    fetch_max_pages: int = 2000
    fetch_max_pages_ceiling: int = 20000
    # 页请求并发度
    fetch_concurrency: int = 4
    fetch_concurrency_ceiling: int = 8
    image_concurrency: int = 4

    # 下载队列
    worker_poll_seconds: float = 1.0
    worker_enabled: bool = True

    # 图片
    images_enabled: bool = True

    # 检索
    search_backend: str = 'fts5'  # fts5 | manticore
    manticore_url: str = 'http://127.0.0.1:9308'
    manticore_index: str = 'xdnmb_posts'
    manticore_timeout: float = 10.0

    # 首次启动创建的管理员口令
    admin_password: str = 'admin'

    # 允许的前端来源；同源留空
    cors_origins: list[str] = []

    def model_post_init(self, _context: object) -> None:
        if not self.db_url:
            self.db_url = f'sqlite:///{self.data_dir / "app.db"}'

    @property
    def images_dir(self) -> Path:
        return self.data_dir / 'images'

    @property
    def backup_dir(self) -> Path:
        return self.data_dir / 'backup'


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.images_dir.mkdir(parents=True, exist_ok=True)
    settings.backup_dir.mkdir(parents=True, exist_ok=True)
    return settings


settings = get_settings()
