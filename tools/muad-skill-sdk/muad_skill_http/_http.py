"""Thin requests pass-through that records every helper request."""

from __future__ import annotations

import time

import requests

from . import _trace
from ._normalize import split_target


def _duration_ms(started):
    return int((time.monotonic() - started) * 1000)


def _send(call, method, url, **kwargs):
    method = str(method).upper()
    extra = kwargs.pop("_trace_extra", None)
    recorder = _trace.get_recorder()
    host, path = split_target(url)
    recorder.admit(host, method, path)
    started = time.monotonic()
    try:
        response = call(method, url, **kwargs)
    except requests.RequestException as exc:
        recorder.complete(host, method, path, None, _duration_ms(started), type(exc).__name__, extra)
        raise
    status = response.status_code
    error_class = "http_%d" % status if status >= 400 else ""
    recorder.complete(host, method, path, status, _duration_ms(started), error_class, extra)
    return response


def request(method, url, **kwargs):
    """requests.request with trace + per-interface limit accounting."""
    return _send(requests.request, method, url, **kwargs)


def get(url, **kwargs):
    return request("GET", url, **kwargs)


def head(url, **kwargs):
    return request("HEAD", url, **kwargs)


def options(url, **kwargs):
    return request("OPTIONS", url, **kwargs)


def post(url, **kwargs):
    return request("POST", url, **kwargs)


def put(url, **kwargs):
    return request("PUT", url, **kwargs)


def patch(url, **kwargs):
    return request("PATCH", url, **kwargs)


def delete(url, **kwargs):
    return request("DELETE", url, **kwargs)


class _TrackedSession:
    def __init__(self):
        self._session = requests.Session()

    def request(self, method, url, **kwargs):
        return _send(self._session.request, method, url, **kwargs)

    def get(self, url, **kwargs):
        return self.request("GET", url, **kwargs)

    def head(self, url, **kwargs):
        return self.request("HEAD", url, **kwargs)

    def options(self, url, **kwargs):
        return self.request("OPTIONS", url, **kwargs)

    def post(self, url, **kwargs):
        return self.request("POST", url, **kwargs)

    def put(self, url, **kwargs):
        return self.request("PUT", url, **kwargs)

    def patch(self, url, **kwargs):
        return self.request("PATCH", url, **kwargs)

    def delete(self, url, **kwargs):
        return self.request("DELETE", url, **kwargs)

    def close(self):
        self._session.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()
        return False


def session():
    """A requests.Session wrapper (supports ``with``) that traces each call."""
    return _TrackedSession()
