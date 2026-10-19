"""Runtime instrumentation for skills that call ``requests`` directly.

The image startup hook imports this module; ``install()`` only patches
``requests`` when ``MUAD_REQUESTS_COMPAT=1`` and ``MUAD_BUSINESS_HOSTS`` is
non-empty. Only requests whose URL ``host:port`` exactly matches the allowlist
are instrumented: TraceId/CSRF headers are overwritten with fresh UUIDs and the
request is counted against the execution limit. Everything else passes through
untouched.
"""

from __future__ import annotations

import os
import time
import uuid
from urllib.parse import urlsplit

import requests
from requests.structures import CaseInsensitiveDict

from . import _http, _trace
from ._normalize import split_target

TRACE_HEADER = "TraceId"
CSRF_HEADER = "X-Csrftoken"
_INSTALLED_ATTR = "_muad_compat_installed"

_original_request = None


def business_hosts():
    """Return the normalized ``host:port`` allowlist from the environment."""
    raw = os.environ.get("MUAD_BUSINESS_HOSTS", "")
    hosts = set()
    for item in raw.split(","):
        item = item.strip()
        if not item:
            continue
        parsed = urlsplit(item if "://" in item else "//" + item)
        netloc = (parsed.netloc or item).strip().lower()
        if netloc:
            hosts.add(netloc)
    return hosts


def install():
    """Patch ``requests.Session.request`` once; safe to call repeatedly."""
    global _original_request
    if os.environ.get("MUAD_REQUESTS_COMPAT") != "1":
        return False
    if not business_hosts():
        return False
    session_cls = requests.sessions.Session
    current = session_cls.request
    if getattr(current, _INSTALLED_ATTR, False):
        return True
    _original_request = current
    hosts = business_hosts()

    def request(self, method, url, **kwargs):
        if _http.internal_request():
            return _original_request(self, method, url, **kwargs)
        try:
            netloc = urlsplit(str(url)).netloc.lower()
        except (TypeError, ValueError):
            netloc = ""
        if not netloc or netloc not in hosts:
            return _original_request(self, method, url, **kwargs)

        headers = CaseInsensitiveDict(dict(kwargs.get("headers") or {}))
        trace_id = str(uuid.uuid4())
        headers[TRACE_HEADER] = trace_id
        headers[CSRF_HEADER] = str(uuid.uuid4())
        kwargs["headers"] = headers

        method_name = str(method).upper()
        host, path = split_target(str(url))
        recorder = _trace.get_recorder()
        recorder.admit(host, method_name, path)
        started = time.monotonic()
        try:
            response = _original_request(self, method, url, **kwargs)
        except requests.RequestException as exc:
            recorder.complete(
                host, method_name, path, None,
                int((time.monotonic() - started) * 1000), type(exc).__name__,
                extra={"traceId": trace_id},
            )
            raise
        status = response.status_code
        error_class = "http_%d" % status if status >= 400 else ""
        recorder.complete(
            host, method_name, path, status,
            int((time.monotonic() - started) * 1000), error_class,
            extra={"traceId": trace_id},
        )
        return response

    request.__setattr__(_INSTALLED_ATTR, True)
    session_cls.request = request
    return True


def uninstall():
    """Restore the unpatched ``requests.Session.request`` (tests/rollback)."""
    global _original_request
    if _original_request is None:
        return False
    session_cls = requests.sessions.Session
    if getattr(session_cls.request, _INSTALLED_ATTR, False):
        session_cls.request = _original_request
    _original_request = None
    return True


install()
