#!/usr/bin/env python3
"""Configured MSSP HTTP client with redacted diagnostics."""

import json
import os
import re
import time
import uuid
from typing import Dict, Optional, Union

import requests

from shared.session import MSSPSession, extract_cookie_value


SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(SKILL_ROOT, "config", "api_config.json")
_CONFIG = None
MAX_ERROR_BODY_BYTES = 4096
AUTH_BUSINESS_CODES = {"401", "403", "9348"}
SENSITIVE_FIELD_PATTERN = re.compile(
    r'(?i)((?:"|\')?(?:cookie|authorization|csrf[_-]?token|access[_-]?token|'
    r'refresh[_-]?token|secret)(?:"|\')?\s*[:=]\s*)("|\')?([^"\',;\s<]+)',
)
BEARER_PATTERN = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+")
SessionValue = Union[str, MSSPSession]


class MSSPRequestError(RuntimeError):
    def __init__(self, message: str, *, category: str, status_code: int = 0,
                 content_type: str = "", authentication_failed: bool = False):
        super().__init__(message)
        self.category = category
        self.status_code = status_code
        self.content_type = content_type
        self.authentication_failed = authentication_failed


def _cookie_value(session: SessionValue) -> str:
    return session.cookie if isinstance(session, MSSPSession) else session


def load_config() -> Dict:
    global _CONFIG
    if _CONFIG is None:
        with open(CONFIG_PATH, "r", encoding="utf-8") as handle:
            _CONFIG = json.load(handle)
    return _CONFIG


def origin() -> str:
    return str(load_config()["origin"]).rstrip("/")


def endpoint(name: str) -> str:
    path = load_config().get("endpoints", {}).get(name)
    if not path:
        raise KeyError(f"缺少 MSSP API 端点: {name}")
    return origin() + str(path)


def build_headers(cookie: SessionValue, download: bool = False,
                  extra_headers: Optional[Dict[str, str]] = None,
                  profile: str = "") -> Dict[str, str]:
    config = load_config()
    cookie_value = _cookie_value(cookie)
    csrf = extract_cookie_value(cookie_value, "csrf_token")
    headers = {
        "Accept": "*/*" if download else "application/json, text/javascript, */*; q=0.01",
        "Cookie": cookie_value,
        "Host": str(config.get("host_header") or "inner.sangfor.com.cn"),
        "Referer": origin() + str(config.get("referer_path") or "/index.html"),
        "Traceid": str(uuid.uuid4()),
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Muad-Policy-Check-MSSP/1.0",
        "X-Requested-With": "XMLHttpRequest",
    }
    if profile == "monitor_mssp":
        headers["Accept-Language"] = "zh-CN,zh;q=0.9"
        headers["User-Agent"] = (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        )
    if csrf:
        headers["X-Csrftoken"] = csrf
    if not download:
        headers["Content-Type"] = "application/json"
    if extra_headers:
        headers.update(extra_headers)
    required_headers = config.get("required_headers", {})
    if not isinstance(required_headers, dict):
        raise ValueError("MSSP required_headers 配置无效")
    headers.update({str(key): str(value) for key, value in required_headers.items()})
    return headers


def _open(method: str, url: str, headers: Dict[str, str], payload: Optional[Dict],
          timeout: int) -> requests.Response:
    response = requests.request(
        method.upper(), url, headers=headers, json=payload, timeout=timeout, verify=False,
    )
    response.raise_for_status()
    return response


def _content_type(headers) -> str:
    value = headers.get("Content-Type", "") if headers is not None else ""
    return str(value).split(";", 1)[0].strip().lower()


def _system_error_text(body: bytes, truncated: bool) -> str:
    text = body.decode("utf-8", errors="replace").strip()
    text = BEARER_PATTERN.sub("Bearer [REDACTED]", text)
    text = SENSITIVE_FIELD_PATTERN.sub(r"\1[REDACTED]", text)
    if truncated:
        text += "\n[响应体已截断]"
    return text


def _http_error(exc: requests.HTTPError) -> MSSPRequestError:
    response = exc.response
    body = bytes(response.content or b"")[:MAX_ERROR_BODY_BYTES + 1]
    status = int(response.status_code or 0)
    content_type = _content_type(response.headers)
    truncated = len(body) > MAX_ERROR_BODY_BYTES
    body = body[:MAX_ERROR_BODY_BYTES]
    authentication_failed = status in {401, 403}
    category = "authentication" if authentication_failed else (
        "gateway" if status >= 500 else "http"
    )
    lines = [f"HTTP {status}", f"Content-Type: {content_type or 'unknown'}"]
    system_error = _system_error_text(body, truncated)
    if system_error:
        lines.append(f"系统返回:\n{system_error}")
    return MSSPRequestError(
        "\n".join(lines), category=category, status_code=status, content_type=content_type,
        authentication_failed=authentication_failed,
    )


def _request_attempts(session: SessionValue, method: str, url: str, attempts: int,
                      timeout: int, download: bool, payload: Optional[Dict],
                      extra_headers: Optional[Dict[str, str]],
                      profile: str) -> requests.Response:
    last_error = None
    for attempt in range(max(1, attempts)):
        try:
            headers = build_headers(session, download, extra_headers, profile)
            return _open(method, url, headers, payload, timeout)
        except requests.HTTPError as exc:
            last_error = _http_error(exc)
            if last_error.status_code == 500:
                raise last_error
        except (OSError, requests.RequestException) as exc:
            last_error = MSSPRequestError(
                "MSSP network error", category="network",
            )
            last_error.__cause__ = exc
        if attempt + 1 < max(1, attempts):
            time.sleep(min(2 ** attempt, 5))
    raise last_error


def _refresh_session(session: SessionValue) -> bool:
    if not isinstance(session, MSSPSession):
        return False
    try:
        return session.refresh()
    except RuntimeError:
        return False


def request(cookie: SessionValue, method: str, url: str, *, attempts: int = 1,
            timeout: int = 30, download: bool = False, **kwargs) -> requests.Response:
    payload = kwargs.get("json")
    extra_headers = kwargs.get("headers")
    profile = str(kwargs.get("profile") or "")
    try:
        return _request_attempts(
            cookie, method, url, attempts, timeout, download, payload, extra_headers, profile,
        )
    except MSSPRequestError as exc:
        if not exc.authentication_failed or not _refresh_session(cookie):
            raise
        return _request_attempts(
            cookie, method, url, 1, timeout, download, payload, extra_headers, profile,
        )


def endpoint_headers(name: str) -> Dict[str, str]:
    configured = load_config().get("endpoint_headers", {}).get(name, {})
    if not isinstance(configured, dict):
        raise ValueError(f"MSSP API 端点请求头配置无效: {name}")
    return {
        str(key): str(value) for key, value in configured.items()
        if str(key).strip() and str(value).strip()
    }


def _business_error(result: Dict) -> MSSPRequestError:
    code = result.get("code")
    message = str(result.get("msg") or "业务接口返回失败")
    authentication_failed = str(code) in AUTH_BUSINESS_CODES
    category = "authentication" if authentication_failed else "business"
    safe_message = _system_error_text(message.encode("utf-8")[:MAX_ERROR_BODY_BYTES], False)
    return MSSPRequestError(
        f"业务码: {code}\n系统返回:\n{safe_message}",
        category=category, authentication_failed=authentication_failed,
    )


def _decode_json(response: requests.Response) -> Dict:
    try:
        result = response.json()
    except (ValueError, UnicodeDecodeError) as exc:
        raise MSSPRequestError(
            "MSSP 接口返回了无效 JSON", category="invalid_response",
            status_code=response.status_code,
            content_type=_content_type(response.headers),
        ) from exc
    if not isinstance(result, dict):
        raise MSSPRequestError("MSSP 接口返回了无效 JSON", category="invalid_response")
    if result.get("code") != 0:
        raise _business_error(result)
    return result


def request_json(cookie: SessionValue, method: str, endpoint_name: str,
                 payload: Optional[Dict] = None, attempts: int = 1) -> Dict:
    profile = "monitor_mssp" if endpoint_name == "customer_search" else ""
    response = request(
        cookie, method, endpoint(endpoint_name), attempts=attempts,
        headers=endpoint_headers(endpoint_name),
        profile=profile,
        json=payload if payload is not None else {},
    )
    try:
        return _decode_json(response)
    except MSSPRequestError as exc:
        if not exc.authentication_failed:
            raise
        if not _refresh_session(cookie):
            raise
        retry = request(
            cookie, method, endpoint(endpoint_name), attempts=1,
            headers=endpoint_headers(endpoint_name),
            profile=profile,
            json=payload if payload is not None else {},
        )
        return _decode_json(retry)
