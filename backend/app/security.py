"""口令哈希：只用标准库（scrypt），不引入 passlib/argon2 之类的额外依赖。"""

from __future__ import annotations

import hashlib
import hmac
import secrets

_ALGO = 'scrypt'
_N, _R, _P, _DKLEN = 2**14, 8, 1, 32


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode('utf-8'), salt=salt, n=_N, r=_R, p=_P, dklen=_DKLEN)
    return f'{_ALGO}${_N}${_R}${_P}${salt.hex()}${digest.hex()}'


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt_hex, digest_hex = stored.split('$')
        if algo != _ALGO:
            return False
        digest = hashlib.scrypt(
            password.encode('utf-8'),
            salt=bytes.fromhex(salt_hex),
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(bytes.fromhex(digest_hex)),
        )
        return hmac.compare_digest(digest.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


# ---- 用户机密（Cookie）的对称加密 ----
def _secret_key() -> bytes:
    """取加密主密钥：优先环境变量，否则在数据目录生成并持久化。"""
    from .settings import settings

    if settings.secret_key:
        return settings.secret_key.encode('utf-8')
    key_file = settings.data_dir / 'secret.key'
    if key_file.is_file():
        return key_file.read_bytes().strip()
    key = secrets.token_urlsafe(48).encode('utf-8')
    key_file.write_bytes(key)
    key_file.chmod(0o600)
    return key


def _fernet():
    """Fernet：AES-128-CBC + HMAC-SHA256，密钥由主密钥派生。"""
    import base64
    import hashlib

    from cryptography.fernet import Fernet

    derived = hashlib.sha256(_secret_key()).digest()
    return Fernet(base64.urlsafe_b64encode(derived))


def encrypt_secret(plain: str) -> str:
    return _fernet().encrypt(plain.encode('utf-8')).decode('ascii')


def decrypt_secret(token: str) -> str | None:
    """解密失败返回 None，由调用方提示重新导入。"""
    from cryptography.fernet import InvalidToken

    try:
        return _fernet().decrypt(token.encode('ascii')).decode('utf-8')
    except (InvalidToken, ValueError):
        return None


USERNAME_RE = r'^[A-Za-z0-9_-]{3,32}$'


def check_password_strength(password: str) -> str | None:
    """返回错误文案，合规时返回 None。"""
    if len(password) < 8:
        return '密码至少 8 位，且包含大小写字母和数字'
    if not any(c.islower() for c in password):
        return '密码至少 8 位，且包含大小写字母和数字'
    if not any(c.isupper() for c in password):
        return '密码至少 8 位，且包含大小写字母和数字'
    if not any(c.isdigit() for c in password):
        return '密码至少 8 位，且包含大小写字母和数字'
    return None
