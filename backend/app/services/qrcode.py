"""二维码导入：解码二维码取出 Cookie；解码库按 zxing-cpp → pyzbar → opencv 依次尝试。"""

from __future__ import annotations

import io
import json
import logging
import re
from dataclasses import dataclass

log = logging.getLogger('xdnmb.qrcode')

MAX_IMAGE_BYTES = 4 * 1024 * 1024  # 4MB，足够放一张手机截图
DECODER_HINT = '未安装二维码解码库：pip install zxing-cpp Pillow（或 pyzbar / opencv-python）'


class QrDecodeError(RuntimeError):
    """解码失败：图片无效、没识别到二维码、或内容里没有 Cookie。"""


@dataclass
class QrCookie:
    cookie: str
    name: str = ''


def _decode_with_zxing(data: bytes) -> str | None:
    try:
        import zxingcpp
        from PIL import Image
    except ImportError:
        return None
    result = zxingcpp.read_barcode(Image.open(io.BytesIO(data)))
    return result.text if result and result.text else None


def _decode_with_pyzbar(data: bytes) -> str | None:
    try:
        from PIL import Image
        from pyzbar.pyzbar import decode
    except ImportError:
        return None
    results = decode(Image.open(io.BytesIO(data)))
    return results[0].data.decode('utf-8') if results else None


def _decode_with_opencv(data: bytes) -> str | None:
    try:
        import cv2
        import numpy as np
        from PIL import Image
    except ImportError:
        return None
    frame = np.array(Image.open(io.BytesIO(data)).convert('RGB'))[:, :, ::-1]  # RGB → BGR
    text, _points, _ = cv2.QRCodeDetector().detectAndDecode(frame)
    return text or None


def decode_qr(data: bytes) -> str:
    """把二维码图片解成原始字符串。"""
    if not data:
        raise QrDecodeError('上传的图片是空的')
    if len(data) > MAX_IMAGE_BYTES:
        raise QrDecodeError(f'图片过大（{len(data) // 1024}KB），请裁剪到 4MB 以内')

    for decoder in (_decode_with_zxing, _decode_with_pyzbar, _decode_with_opencv):
        try:
            text = decoder(data)
        except Exception as exc:  # noqa: BLE001 - 解码器内部异常统一转成友好错误
            log.warning('二维码解码器 %s 失败：%s', decoder.__name__, exc)
            text = None
        if text:
            return text.strip()

    raise QrDecodeError(f'没能从图片里识别出二维码。{DECODER_HINT}')


# 形如 `PHPSESSID=xxx` / `userhash=yyy; memberUserspapapa=zzz` 的完整 Cookie 头
COOKIE_HEADER_RE = re.compile(r'^\s*[A-Za-z0-9_\-]+\s*=')


def percent_encode_cookie_value(value: str) -> str:
    """把裸字节编码成 %XX；已是 %XX 的片段保持原样。"""
    parts: list[str] = []
    index = 0
    while index < len(value):
        char = value[index]
        if char == '%' and index + 2 < len(value) and re.fullmatch(r'[0-9A-Fa-f]{2}', value[index + 1 : index + 3]):
            parts.append(value[index : index + 3])
            index += 3
            continue
        parts.append(''.join(f'%{byte:02X}' for byte in char.encode('utf-8')))
        index += 1
    return ''.join(parts)


def normalize_cookie_header(value: str) -> str:
    """补成完整 Cookie 头：裸 userhash 值补成 userhash=<值>，完整头原样透传。"""
    text = value.strip()
    if not text:
        raise QrDecodeError('二维码里的 cookie 为空')
    if COOKIE_HEADER_RE.match(text):
        return text
    return f'userhash={percent_encode_cookie_value(text)}'


def parse_qr_payload(raw: str) -> QrCookie:
    """兼容三种格式：JSON 完整 Cookie 头、JSON 裸 userhash、裸字符串。"""
    text = (raw or '').strip()
    if not text:
        raise QrDecodeError('二维码内容为空')

    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return QrCookie(cookie=normalize_cookie_header(text))

    if not isinstance(payload, dict):
        raise QrDecodeError('二维码里的 JSON 不是对象')

    raw_cookie = str(payload.get('cookie') or payload.get('userhash') or '').strip()
    if not raw_cookie:
        raise QrDecodeError('二维码里没有 cookie / userhash 字段')
    return QrCookie(
        cookie=normalize_cookie_header(raw_cookie),
        name=str(payload.get('name') or '').strip(),
    )


def parse_qr_image(data: bytes) -> QrCookie:
    return parse_qr_payload(decode_qr(data))
