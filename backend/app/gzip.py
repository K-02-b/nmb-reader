"""按内容类型做 gzip 的 ASGI 中间件。

不用 Starlette 自带的 `GZipMiddleware`：它按体积决定，不看内容类型，而这里大量响应
本身就是压缩格式——本地化的 jpg/png 图片、docx/pdf 导出——再压一遍只是白烧 CPU，
体积还可能变大。这里用内容类型白名单（JSON / 文本 / JS / CSS / SVG）收口，并且：

- 只处理 `Content-Length` 已知且不大的整块响应；SSE 这类流式响应天然跳过；
- 不碰已经带 `Content-Encoding` 的响应；
- 该压的内容类型一律补 `Vary: Accept-Encoding`，避免中间缓存把两种版本串味。
"""

from __future__ import annotations

import gzip
from collections.abc import Awaitable, Callable
from typing import Any

Message = dict[str, Any]
Scope = dict[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]

# 太小的响应压了反而更大；太大的（比如 Markdown 导出）不值得占着内存等压缩
MIN_SIZE = 1024
MAX_SIZE = 8 * 1024 * 1024
COMPRESS_LEVEL = 5

# 白名单：这些类型压了确实省流量
COMPRESSIBLE_TYPES = frozenset(
    {
        'application/json',
        'application/javascript',
        'text/javascript',
        'application/xml',
        'application/xhtml+xml',
        'image/svg+xml',
    }
)
COMPRESSIBLE_PREFIXES = ('text/',)
# 流式推送必须原样走
STREAM_TYPES = frozenset({'text/event-stream'})


def _get_header(headers: list[tuple[bytes, bytes]], name: bytes) -> bytes | None:
    for key, value in headers:
        if key.lower() == name:
            return value
    return None


def _with_vary(headers: list[tuple[bytes, bytes]]) -> list[tuple[bytes, bytes]]:
    """确保有 `Vary: Accept-Encoding`（压缩与否都要，缓存才不会串）。"""
    current = _get_header(headers, b'vary')
    if current is None:
        return [*headers, (b'vary', b'Accept-Encoding')]
    if b'accept-encoding' in current.lower():
        return headers
    return [(key, b'Accept-Encoding, ' + value) if key.lower() == b'vary' else (key, value) for key, value in headers]


def _compressible(content_type: str) -> bool:
    media = content_type.split(';', 1)[0].strip().lower()
    if media in STREAM_TYPES:
        return False
    return media in COMPRESSIBLE_TYPES or media.startswith(COMPRESSIBLE_PREFIXES)


class GzipMiddleware:
    """给该压的响应加 gzip；其余原样透传（包含流式响应与图片）。"""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get('type') != 'http':
            await self.app(scope, receive, send)
            return
        accept = (_get_header(scope.get('headers') or [], b'accept-encoding') or b'').decode('latin-1').lower()
        if 'gzip' not in accept:
            await self.app(scope, receive, send)
            return

        state: dict[str, Any] = {'started': False, 'compress': False, 'too_big': False, 'total': 0, 'chunks': []}

        async def send_wrapper(message: Message) -> None:
            kind = message['type']
            if kind == 'http.response.start':
                status = int(message['status'])
                headers = list(message.get('headers') or [])
                content_type = (_get_header(headers, b'content-type') or b'').decode('latin-1')
                raw_length = _get_header(headers, b'content-length')
                length = int(raw_length) if raw_length and raw_length.isdigit() else None
                if _compressible(content_type):
                    headers = _with_vary(headers)
                state['compress'] = (
                    _compressible(content_type)
                    and _get_header(headers, b'content-encoding') is None
                    and length is not None
                    and MIN_SIZE <= length <= MAX_SIZE
                )
                state['status'] = status
                state['headers'] = headers
                state['started'] = True
                if not state['compress']:
                    await send({'type': 'http.response.start', 'status': status, 'headers': headers})
                return

            if kind == 'http.response.body':
                body = message.get('body') or b''
                if not state['compress']:
                    await send(message)
                    return
                state['chunks'].append(body)
                state['total'] += len(body)
                state['too_big'] = state['total'] > MAX_SIZE
                if message.get('more_body') and not state['too_big']:
                    return
                data = b''.join(state['chunks'])
                headers = list(state['headers'])
                if state['too_big']:  # 说好不大却超了：原样放行，别再压
                    await send({'type': 'http.response.start', 'status': state['status'], 'headers': headers})
                    await send({'type': 'http.response.body', 'body': data, 'more_body': False})
                    return
                packed = gzip.compress(data, compresslevel=COMPRESS_LEVEL, mtime=0)
                headers = [(k, v) for k, v in headers if k.lower() != b'content-length']
                headers.append((b'content-encoding', b'gzip'))
                headers.append((b'content-length', str(len(packed)).encode()))
                await send({'type': 'http.response.start', 'status': state['status'], 'headers': headers})
                await send({'type': 'http.response.body', 'body': packed, 'more_body': False})
                return

            await send(message)

        await self.app(scope, receive, send_wrapper)
