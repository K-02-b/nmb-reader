"""统一错误类型与处理器：错误响应统一为 {code, detail}。"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class ApiError(Exception):
    def __init__(self, detail: str, code: str = 'BAD_REQUEST', status: int = 400) -> None:
        super().__init__(detail)
        self.detail = detail
        self.code = code
        self.status = status


def not_found(detail: str, code: str) -> ApiError:
    return ApiError(detail, code, 404)


def conflict(detail: str, code: str) -> ApiError:
    return ApiError(detail, code, 409)


def unauthorized(detail: str = '请先登录', code: str = 'UNAUTHORIZED') -> ApiError:
    return ApiError(detail, code, 401)


def forbidden(detail: str = '没有权限', code: str = 'FORBIDDEN') -> ApiError:
    return ApiError(detail, code, 403)


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(status_code=exc.status, content={'code': exc.code, 'detail': exc.detail})

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        loc = '.'.join(str(x) for x in first.get('loc', [])[1:]) or 'body'
        msg = first.get('msg', '参数不合法')
        return JSONResponse(
            status_code=422,
            content={'code': 'VALIDATION_ERROR', 'detail': f'{loc}: {msg}'},
        )
