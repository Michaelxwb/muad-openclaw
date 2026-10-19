"""Platform request client: headers and trace-aware business requests.

The caller resolves the platform session with ``session-manager get-state`` and
passes the returned ``sessionStateFile`` here. This module never runs
``session-manager`` and never reads credentials from the environment.

Header order follows the backend design:
browser defaults -> hostHeader -> staticHeaders -> caller/extra headers ->
Cookie -> CSRF -> Traceid -> re-assert mandatory headers. Header values never
reach the trace spool or diagnostics.
"""

from __future__ import annotations

import json
import sys
import threading
import uuid
from datetime import datetime, timezone

import requests

from . import _http
from ._normalize import normalize_path

__all__ = [
    "PlatformSessionError",
    "normalize_path",
    "build_platform_headers",
    "platform_request",
    "platform",
]

DEFAULT_TRACE_HEADER = "Traceid"
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

_platform_session = requests.Session()


class PlatformSessionError(RuntimeError):
    """Platform credentials/state unavailable; skills should fail loud."""


# --------------------------------------------------------------------------- #
# public API
# --------------------------------------------------------------------------- #

def platform_request(platform, method, path, *, state_file, **kwargs):
    """Send a business request with platform headers and trace accounting.

    ``state_file`` is the ``sessionStateFile`` returned by
    ``session-manager get-state``; it must contain ``platforms.<platform>``
    with cookies and an optional ``requestProfile``.
    """
    method = str(method).upper()
    context = _load_state_file(state_file, platform)
    call_kwargs = dict(kwargs)
    extra_headers = call_kwargs.pop("extra_headers", None)
    caller_headers = call_kwargs.pop("headers", None)
    url = _resolve_url(platform, context["profile"], path)
    headers, trace_id = build_platform_headers(
        context["profile"], context["cookies"], caller_headers, extra_headers, call_kwargs
    )
    call_kwargs["headers"] = headers
    extra = {"platform": platform}
    if trace_id:
        extra["traceId"] = trace_id
    return _http._send(
        _platform_session.request, method, url, _trace_extra=extra, **call_kwargs
    )


def platform(name, state_file):
    """Return a reusable client bound to one platform profile and state file."""
    return PlatformClient(name, state_file)


class PlatformClient:
    def __init__(self, name, state_file):
        self.platform = name
        self.state_file = state_file

    def request(self, method, path, **kwargs):
        return platform_request(self.platform, method, path, state_file=self.state_file, **kwargs)

    def get(self, path, **kwargs):
        return self.request("GET", path, **kwargs)

    def head(self, path, **kwargs):
        return self.request("HEAD", path, **kwargs)

    def post(self, path, **kwargs):
        return self.request("POST", path, **kwargs)

    def put(self, path, **kwargs):
        return self.request("PUT", path, **kwargs)

    def patch(self, path, **kwargs):
        return self.request("PATCH", path, **kwargs)

    def delete(self, path, **kwargs):
        return self.request("DELETE", path, **kwargs)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


# --------------------------------------------------------------------------- #
# headers
# --------------------------------------------------------------------------- #

def build_platform_headers(profile, cookies, caller_headers=None, extra_headers=None, request_kwargs=None):
    """Build the header dict in the design's mandated order.

    Returns ``(headers, trace_id)``; ``trace_id`` is ``None`` when the profile
    disables the trace header.
    """
    headers = {}
    _set_header(headers, "Accept", "application/json, text/plain, */*")
    _set_header(headers, "Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
    content_type = _content_type(request_kwargs or {})
    if content_type:
        _set_header(headers, "Content-Type", content_type)
    _set_header(headers, "User-Agent", USER_AGENT)
    _set_header(headers, "X-Requested-With", "XMLHttpRequest")
    if profile.get("referer"):
        _set_header(headers, "Referer", profile["referer"])

    for name, value in profile.get("hostHeader", {}).items():
        _set_header(headers, name, value)
    for name, value in profile.get("staticHeaders", {}).items():
        _set_header(headers, name, value)

    if profile.get("extraAllowed", True):
        for name, value in _header_items(caller_headers):
            _set_header(headers, name, value)
        for name, value in _header_items(extra_headers):
            _set_header(headers, name, value)

    cookie_values = _cookie_values(cookies)
    cookie_header = "; ".join("%s=%s" % (name, value) for name, value in cookie_values.items())
    if cookie_header:
        _set_header(headers, "Cookie", cookie_header)

    csrf_headers = []
    for mapping in profile.get("csrf", []):
        value = cookie_values.get(mapping["cookie"])
        if value:
            _set_header(headers, mapping["header"], value)
            csrf_headers.append((mapping["header"], value))

    trace_header = profile.get("traceHeader")
    trace_id = None
    if trace_header:
        trace_id = str(uuid.uuid4())
        _set_header(headers, trace_header, trace_id)

    # Mandatory headers are written last so caller/extra headers cannot win.
    if cookie_header:
        _set_header(headers, "Cookie", cookie_header)
    for name, value in csrf_headers:
        _set_header(headers, name, value)
    if trace_header and trace_id:
        _set_header(headers, trace_header, trace_id)
    return headers, trace_id


def _set_header(headers, name, value):
    for existing in [key for key in headers if key.lower() == name.lower()]:
        del headers[existing]
    headers[name] = str(value)


def _header_items(raw):
    if not isinstance(raw, dict):
        return []
    items = []
    for name, value in raw.items():
        if isinstance(name, str) and name.strip() and value is not None:
            items.append((name.strip(), value))
    return items


def _content_type(kwargs):
    if kwargs.get("json") is not None:
        return "application/json;charset=UTF-8"
    if kwargs.get("data") is not None:
        return "application/x-www-form-urlencoded;charset=UTF-8"
    return ""


def _cookie_values(cookies):
    result = {}
    if not isinstance(cookies, list):
        return result
    for item in cookies:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        value = item.get("value")
        if isinstance(name, str) and name and isinstance(value, str):
            result[name] = value
    return result


# --------------------------------------------------------------------------- #
# session state
# --------------------------------------------------------------------------- #

def reset_cache():
    with _diagnosed_lock:
        _diagnosed.clear()


def _load_state_file(state_file, name):
    path = str(state_file or "").strip()
    if not path:
        raise PlatformSessionError(
            "platform session unavailable for %s: state_file is required" % name
        )
    try:
        with open(path, "r", encoding="utf-8") as handle:
            state = json.load(handle)
    except (ValueError, OSError) as exc:
        raise PlatformSessionError(
            "platform session unavailable for %s: session state file is unreadable" % name
        ) from exc
    if not isinstance(state, dict):
        raise PlatformSessionError(
            "platform session unavailable for %s: session state file is unreadable" % name
        )

    platforms = state.get("platforms")
    if not isinstance(platforms, dict):
        raise PlatformSessionError(
            "platform session unavailable for %s: no credentials in session state" % name
        )
    section = platforms.get(name)
    if not isinstance(section, dict):
        raise PlatformSessionError(
            "platform session unavailable for %s: no credentials in session state" % name
        )
    expires_at = _parse_expiry(section.get("expiresAt"))
    if _expired(expires_at):
        raise PlatformSessionError(
            "platform session unavailable for %s: session state expired" % name
        )
    return {
        "platform": name,
        "profile": _profile(section, name),
        "cookies": section.get("cookies") or [],
        "expires_at": expires_at,
    }


def _profile(section, name):
    raw = section.get("requestProfile")
    if not isinstance(raw, dict):
        _diagnostic(name, "request profile fallback missing=requestProfile")
        raw = {}
    return {
        "baseUrl": _string(raw.get("baseUrl")),
        "hostHeader": _string_map(raw.get("hostHeader")),
        "referer": _string(raw.get("referer")),
        "csrf": _csrf_mappings(raw.get("csrf")),
        "staticHeaders": _string_map(raw.get("staticHeaders")),
        "traceHeader": _trace_header(raw),
        "extraAllowed": raw.get("extraAllowed") is not False,
    }


def _trace_header(raw):
    if "traceHeader" not in raw:
        return DEFAULT_TRACE_HEADER
    value = raw.get("traceHeader")
    return value.strip() if isinstance(value, str) and value.strip() else None


def _csrf_mappings(raw):
    mappings = []
    if not isinstance(raw, list):
        return mappings
    for item in raw:
        if not isinstance(item, dict):
            continue
        cookie_name = _string(item.get("cookie"))
        header_name = _string(item.get("header"))
        if cookie_name and header_name:
            mappings.append({"cookie": cookie_name, "header": header_name})
    return mappings


def _string(value):
    return value.strip() if isinstance(value, str) else ""


def _string_map(raw):
    result = {}
    if not isinstance(raw, dict):
        return result
    for name, value in raw.items():
        if isinstance(name, str) and name.strip() and isinstance(value, str) and value.strip():
            result[name.strip()] = value.strip()
    return result


def _resolve_url(name, profile, path):
    path = str(path)
    if path.startswith(("http://", "https://")):
        return path
    base_url = profile.get("baseUrl") or ""
    if not base_url:
        raise PlatformSessionError(
            "platform request unavailable for %s: request profile has no baseUrl "
            "and path is not absolute" % name
        )
    return base_url.rstrip("/") + "/" + path.lstrip("/")


def _parse_expiry(value):
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None


def _expired(expires_at):
    if expires_at is None:
        return False
    return expires_at <= datetime.now(timezone.utc)


_diagnosed = set()
_diagnosed_lock = threading.Lock()


def _diagnostic(name, message):
    key = (name, message)
    with _diagnosed_lock:
        if key in _diagnosed:
            return
        _diagnosed.add(key)
    try:
        sys.stderr.write("[muad-skill-sdk][platform] platform=%s %s\n" % (name, message))
    except Exception:
        return
