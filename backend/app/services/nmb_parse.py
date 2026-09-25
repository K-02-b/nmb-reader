"""X岛串的抓取与解析。

约定：跳过板块公告楼（No.9999999）；串首 pageNum=0 且 isPo=True，岛上第 N 页的回复 pageNum=N。

PO 的判定见 `build_thread`：同一串里显示 ID 与串首相同的楼层就是楼主本人。
信息行里的 `(PO主)` 只是展示标记，只作提示，判定以显示 ID 为准。
"""

from __future__ import annotations

import html
import logging
import re
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

log = logging.getLogger('xdnmb.fetch')

BASE = 'https://www.nmbxd1.com'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
CST = timezone(timedelta(hours=8))
TIPS_ID = 9999999


class FetchError(RuntimeError):
    """抓取失败；code 映射任务状态。"""

    def __init__(self, message: str, code: str = 'FETCH_FAILED') -> None:
        super().__init__(message)
        self.code = code


class CookieInvalid(FetchError):
    """Cookie 未生效：翻页拿到重复页面。"""

    def __init__(self, message: str = 'Cookie 未生效，下载到第 100 页后数据重复') -> None:
        super().__init__(message, code='COOKIE_INVALID')


# ---- HTTP ----
def board_url(board: str, page: int = 1) -> str:
    """板块地址；板块名可能含中文，需要百分号编码。"""
    return f'{BASE}/f/{urllib.parse.quote(board)}?page={page}'


def _headers(cookie: str = '') -> dict[str, str]:
    headers = {'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9'}
    if cookie:
        headers['Cookie'] = cookie
    return headers


def _quote(url: str) -> str:
    """显式百分号编码；已编码的 % 保留原样。"""
    return urllib.parse.quote(url, safe=':/?&=#%+')


# 被限流时最多额外重试几次，以及单次最长等待
RATE_LIMIT_STATUS = {429, 503}
RATE_LIMIT_RETRIES = 3
RATE_LIMIT_MAX_WAIT = 120.0


def _retry_after(response, fallback: float) -> float:
    """优先按响应里的 Retry-After（秒数或 HTTP 日期）等待，取不到就用退避值。"""
    raw = (response.headers.get('Retry-After') or '').strip()
    if raw:
        try:
            return min(RATE_LIMIT_MAX_WAIT, max(1.0, float(raw)))
        except ValueError:
            pass
        try:
            when = parsedate_to_datetime(raw)
            delay = (when - datetime.now(UTC)).total_seconds()
            return min(RATE_LIMIT_MAX_WAIT, max(1.0, delay))
        except (TypeError, ValueError):
            pass
    return min(RATE_LIMIT_MAX_WAIT, max(1.0, fallback))


class HttpSession:
    """带 keep-alive 的抓取会话：复用连接省掉重复的 TLS 握手。"""

    def __init__(self, cookie: str = '', timeout: int = 30) -> None:
        import httpx

        self.timeout = timeout
        self._client = httpx.Client(timeout=timeout, follow_redirects=True, headers=_headers(cookie))

    def _wait_if_rate_limited(self, response, url: str, waited: int) -> bool:
        """命中限流就等一会再返回 True（由调用方重试）；超过次数抛错。"""
        if response.status_code not in RATE_LIMIT_STATUS:
            return False
        if waited >= RATE_LIMIT_RETRIES:
            raise FetchError(
                f'被限流（HTTP {response.status_code}），重试 {waited} 次仍未通过：{url}', code='RATE_LIMITED'
            )
        delay = _retry_after(response, fallback=5.0 * (waited + 1))
        log.warning(
            '被限流 HTTP %s，等待 %.0fs 后重试（%s/%s）：%s',
            response.status_code,
            delay,
            waited + 1,
            RATE_LIMIT_RETRIES,
            url,
        )
        time.sleep(delay)
        return True

    def get(self, url: str, retries: int = 3, pause: float = 1.0) -> str:
        last: Exception | None = None
        attempt = 0
        waited = 0
        while attempt < retries:
            try:
                response = self._client.get(_quote(url))
                if response.status_code == 404:
                    raise FetchError(f'串不存在（HTTP 404）：{url}', code='THREAD_NOT_FOUND')
                if self._wait_if_rate_limited(response, url, waited):
                    waited += 1
                    continue  # 限流不计入普通重试次数
                response.raise_for_status()
                return response.content.decode('utf-8', errors='replace')
            except FetchError:
                raise
            except Exception as exc:  # noqa: BLE001 - 网络抖动就重试
                last = exc
            attempt += 1
            if attempt < retries:
                time.sleep(pause * attempt)
        raise FetchError(f'抓取失败 {url}: {last}')

    def get_bytes(self, url: str, retries: int = 2, pause: float = 1.0) -> bytes:
        """取二进制（图片）。"""
        last: Exception | None = None
        attempt = 0
        waited = 0
        while attempt < retries:
            try:
                response = self._client.get(url)
                if self._wait_if_rate_limited(response, url, waited):
                    waited += 1
                    continue
                response.raise_for_status()
                return response.content
            except FetchError:
                raise
            except Exception as exc:  # noqa: BLE001
                last = exc
            attempt += 1
            if attempt < retries:
                time.sleep(pause * attempt)
        raise FetchError(f'图片下载失败 {url}: {last}')

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> HttpSession:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()


def fetch_html(url: str, cookie: str = '', retries: int = 3, timeout: int = 30, pause: float = 1.0) -> str:
    """一次性抓取（每次新建连接）；抓多页请用 HttpSession。"""
    import httpx

    last: Exception | None = None
    attempt = 0
    waited = 0
    while attempt < retries:
        try:
            with httpx.Client(timeout=timeout, follow_redirects=True, headers=_headers(cookie)) as client:
                response = client.get(_quote(url))
                if response.status_code == 404:
                    raise FetchError(f'串不存在（HTTP 404）：{url}', code='THREAD_NOT_FOUND')
                if response.status_code in RATE_LIMIT_STATUS:
                    if waited >= RATE_LIMIT_RETRIES:
                        raise FetchError(
                            f'被限流（HTTP {response.status_code}），重试 {waited} 次仍未通过：{url}',
                            code='RATE_LIMITED',
                        )
                    delay = _retry_after(response, fallback=5.0 * (waited + 1))
                    log.warning(
                        '被限流 HTTP %s，等待 %.0fs 后重试（%s/%s）',
                        response.status_code,
                        delay,
                        waited + 1,
                        RATE_LIMIT_RETRIES,
                    )
                    time.sleep(delay)
                    waited += 1
                    continue
                response.raise_for_status()
                return response.content.decode('utf-8', errors='replace')
        except FetchError:
            raise
        except Exception as exc:  # noqa: BLE001 - 网络抖动就重试
            last = exc
        attempt += 1
        if attempt < retries:
            time.sleep(pause * attempt)
    raise FetchError(f'抓取失败 {url}: {last}')


# ---- 解析 ----
def strip_tags(fragment: str) -> str:
    # 岛的 HTML 是「<br />\n」这种写法，换行符是排版用的，不能算成空行
    text = re.sub(r'(?is)<br\s*/?>[ \t]*(?:\r?\n)?', '\n', fragment)
    text = re.sub(r'(?is)</(p|div|li)>', '\n', text)
    text = re.sub(r'(?s)<[^>]+>', '', text)
    text = html.unescape(text)
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    lines = [line.strip() for line in text.split('\n')]
    text = '\n'.join(lines)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def balanced_div(page: str, start: int) -> str:
    """取 h-threads-content 里配对 </div> 的内容。"""
    open_tag = page.index('>', start) + 1
    depth = 1
    pos = open_tag
    for match in re.finditer(r'</?div\b', page[open_tag:]):
        if match.group(0) == '<div':
            depth += 1
        else:
            depth -= 1
            if depth == 0:
                pos = open_tag + match.start()
                break
    return page[open_tag:pos]


def parse_island_time(raw: str) -> int:
    """2026-06-01(一)18:07:05 → Unix 秒（东八区）"""
    match = re.search(r'(\d{4})-(\d{2})-(\d{2})\(.\)(\d{2}):(\d{2}):(\d{2})', raw)
    if match:
        year, month, day, hour, minute, second = (int(x) for x in match.groups())
    else:
        match = re.search(r'(\d{4})-(\d{2})-(\d{2})', raw)
        if not match:
            return 0
        year, month, day = (int(x) for x in match.groups())
        hour = minute = second = 0
    return int(datetime(year, month, day, hour, minute, second, tzinfo=CST).timestamp())


def parse_post_block(block: str, thread_id: int, page_num: int, is_op: bool) -> dict | None:
    def grab(pattern: str) -> str | None:
        match = re.search(pattern, block, re.S)
        return html.unescape(re.sub(r'(?s)<[^>]+>', '', match.group(1))).strip() if match else None

    post_id = int(re.search(r'data-threads-id="(\d+)"', block).group(1)) if 'data-threads-id' in block else thread_id
    if post_id == TIPS_ID:
        return None

    cookie = grab(r'h-threads-info-uid">\s*ID:([^<\s]+)') or ''
    title = grab(r'h-threads-info-title">(.*?)</span>')
    if title in ('无标题', 'Tips', ''):
        title = None
    name = grab(r'h-threads-info-email">(.*?)</span>') or '无名氏'
    created_raw = grab(r'h-threads-info-createdat">(.*?)</span>') or ''
    # (PO主) 只作提示：只看信息行（正文之前），免得正文里写上这三个字就被当成楼主
    is_po = is_op or '(PO主)' in block.split('<div class="h-threads-content">', 1)[0]

    content = ''
    marker = block.find('<div class="h-threads-content">')
    if marker >= 0:
        content = strip_tags(balanced_div(block, marker))

    image_source = None
    match = re.search(r'<a href="(https?://[^"]+)"[^>]*class="h-threads-img-a"', block)
    if match:
        image_source = match.group(1)
    image = None
    match = re.search(r'class="h-threads-img-a"><img[^>]*data-src="([^"]+)"', block)
    if match:
        image = match.group(1)
    if not image and image_source:
        image = image_source

    return {
        'threadId': thread_id,
        'id': post_id,
        'cookie': cookie,
        'pageNum': 0 if is_op else page_num,
        'isPo': is_po,
        'isSage': False,
        'isAdmin': False,
        'createdAt': parse_island_time(created_raw),
        'content': content,
        'img': image,
        'imgSource': image_source,
        'title': title,
        'name': name,
    }


def last_page_of(page: str) -> int:
    pages = [int(p) for p in re.findall(r'/t/\d+\?page=(\d+)', page)]
    return max(pages) if pages else 1


def parse_page(page: str, thread_id: int, page_num: int) -> tuple[dict | None, list[dict]]:
    op = None
    match = re.search(r'<div[^>]*class="h-threads-item uk-clearfix"', page)
    if match:
        block = page[match.start() :]
        replies_at = block.find('<div class="h-threads-item-replies"')
        if replies_at > 0:
            block = block[:replies_at]
        if 'data-threads-id' not in block:
            block = re.sub(r'<div', f'<div data-threads-id="{thread_id}"', block, count=1)
        op = parse_post_block(block, thread_id, 0, True)

    replies: list[dict] = []
    for match in re.finditer(r'<div data-threads-id="(\d+)" class="h-threads-item-reply">', page):
        end = page.find('<div data-threads-id="', match.end())
        chunk = page[match.start() : end if end > 0 else len(page)]
        post = parse_post_block(chunk, thread_id, page_num, False)
        if post:
            replies.append(post)
    return op, replies


def fallback_title(op: dict) -> str:
    if op.get('title'):
        return op['title']
    for line in op['content'].split('\n'):
        line = line.strip()
        if line:
            return line[:40]
    return f'No.{op["id"]}'


# ---- 组装 / 抓取 ----
# 面包屑形如 <a href="/">X岛揭示板</a></li><li><a href="/f/技术宅">…；页面首个 /f/ 链接是导航菜单，不能用
BOARD_BREADCRUMB = re.compile(r'<a href="/">X岛揭示板</a>\s*</li>\s*<li>\s*<a href="/f/([^"?]+)"[^>]*>(.*?)</a>', re.S)
BOARD_IN_TITLE = re.compile(r'<h2 class="h-title">No\.(\d+)\s*-\s*(.*?)\s*-\s*([^<]+)</h2>', re.S)


def parse_board(page_html: str) -> str | None:
    """取本串板块：优先面包屑，退回标题尾段。"""
    match = BOARD_BREADCRUMB.search(page_html)
    if match:
        name = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', '', match.group(2))).strip()
        return name or urllib.parse.unquote(match.group(1)).strip()
    fallback = BOARD_IN_TITLE.search(page_html)
    if fallback:
        return fallback.group(3).strip() or None
    return None


def build_thread(thread_id: int, pages: list[tuple[int, str]], tags: list[dict] | None = None) -> dict:
    """pages = [(page_num, html), ...]，必须包含第 1 页。"""
    op: dict | None = None
    posts: list[dict] = []
    for page_num, page_html in pages:
        current_op, replies = parse_page(page_html, thread_id, page_num)
        if page_num == 1 or op is None:
            op = current_op or op
        posts.extend(replies)

    if op is None:
        raise FetchError('未能解析出串首', code='PARSE_FAILED')

    seen: set[int] = set()
    unique: list[dict] = []
    for post in [op, *posts]:
        if post['id'] in seen:
            continue
        seen.add(post['id'])
        unique.append(post)

    # 一串里的显示 ID 是认人的：与串首 ID 相同就是楼主，以此收口。
    # 信息行的 (PO主) 标记只作提示，不作为判定依据。
    op_cookie = op['cookie']
    if op_cookie:
        for post in unique:
            if post['cookie'] == op_cookie:
                post['isPo'] = True

    return {
        'thread': {
            'threadId': thread_id,
            'cookie': op['cookie'],
            'replies': len(unique) - 1,
            'isSage': False,
            'isAdmin': False,
            'installment': None,
            'createdAt': op['createdAt'],
            'updatedAt': unique[-1]['createdAt'],
            'board': next((parse_board(html) for page_num, html in pages if page_num == 1), None),
            'title': fallback_title(op),
            'excerpt': re.sub(r'\s+', ' ', op['content'])[:90],
            'img': op['img'],
            'tags': tags or [],
            'replyCount': len(unique) - 1,
            'imageCount': sum(1 for post in unique if post['img']),
            'pageCount': max((post['pageNum'] for post in unique), default=0),
        },
        'posts': unique,
    }


def download_thread(
    thread_id: int,
    cookie: str = '',
    start_page: int = 1,
    pause: float = 1.2,
    max_pages: int = 200,
    concurrency: int = 1,
    on_page=None,
    should_stop=None,
) -> dict:
    """抓取整个串。start_page > 1 时增量更新；pause 是每个请求通道的间隔。

    并发 >1 时 should_stop() 会在抓取线程里被调用，实现必须线程安全。
    """
    first_page_num = max(1, start_page)
    workers = max(1, int(concurrency))

    with HttpSession(cookie=cookie) as session:
        first_html = session.get(f'{BASE}/t/{thread_id}?page={first_page_num}')
        if 'h-threads-content' not in first_html and 'h-threads-item-reply' not in first_html:
            raise FetchError(f'No.{thread_id} 打不开，串号不存在或 Cookie 失效', code='THREAD_NOT_FOUND')

        total_pages = last_page_of(first_html)
        # 安全阀：防止误输入串号抓一个超大串（页数多不等于 Cookie 失效）
        if total_pages > max_pages:
            raise FetchError(
                f'该串共 {total_pages} 页，超过安全上限 {max_pages} 页；'
                f'确认要整串下载请调大「设置 → 下载 → 下载页数上限」',
                code='PAGE_LIMIT_EXCEEDED',
            )

        plan = [page for page in range(first_page_num, total_pages + 1) if page != first_page_num]
        need = total_pages - first_page_num + 1
        pages: dict[int, str] = {}
        seen_signatures: set[tuple] = set()
        state = {'done': 0}
        lock = threading.Lock()

        def absorb(page_num: int, page_html: str) -> None:
            """解析一页、检测重复、记进度。"""
            _op, replies = parse_page(page_html, thread_id, page_num)
            # Cookie 失效的症状是翻页拿到同样的楼层，按楼层 ID 指纹判断（不能用页面长度，会误判）
            if replies:
                signature = (len(replies), tuple(post['id'] for post in replies))
                if signature in seen_signatures:
                    raise CookieInvalid()
                seen_signatures.add(signature)
            pages[page_num] = page_html
            state['done'] += 1

        absorb(first_page_num, first_html)
        if on_page:
            on_page(state['done'], need, len(pages[first_page_num]))

        def fetch_one(page_num: int) -> tuple[int, str]:
            if should_stop and should_stop():
                raise FetchError('任务已取消', code='CANCELLED')
            time.sleep(pause)  # 每个通道自己的间隔
            return page_num, session.get(f'{BASE}/t/{thread_id}?page={page_num}')

        if workers == 1:
            for page_num in plan:
                page_number, page_html = fetch_one(page_num)
                absorb(page_number, page_html)
                if on_page:
                    on_page(state['done'], need, len(pages[page_number]))
        else:
            with ThreadPoolExecutor(max_workers=workers, thread_name_prefix='nmb-fetch') as pool:
                futures = {pool.submit(fetch_one, page_num): page_num for page_num in plan}
                try:
                    for future in as_completed(futures):
                        page_number, page_html = future.result()
                        with lock:
                            absorb(page_number, page_html)
                            done = state['done']
                        if on_page:
                            on_page(done, need, len(page_html))
                except BaseException:
                    for future in futures:
                        future.cancel()
                    raise

        if first_page_num > 1:
            # 增量：补一次第 1 页，保证串首/标题能解析出来
            pages[1] = session.get(f'{BASE}/t/{thread_id}?page=1')

    return build_thread(thread_id, sorted(pages.items()))
