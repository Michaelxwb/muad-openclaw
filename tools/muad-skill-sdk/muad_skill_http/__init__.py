"""muad_skill_http: trace-aware requests helper and platform request client.

Usage in skills::

    import muad_skill_http

    response = muad_skill_http.get("http://service/api")
    response = muad_skill_http.platform_request("mssw", "GET", "/api/v1/targets")

Without importing this module, existing skills keep their original behavior:
``requests`` is never patched and no trace spool is written.
"""

from __future__ import annotations

from . import _platform, _trace
from ._http import delete, get, head, options, patch, post, put, request, session
from ._platform import PlatformClient, PlatformSessionError, platform, platform_request
from ._trace import EXIT_REQUEST_LIMIT

__all__ = [
    "EXIT_REQUEST_LIMIT",
    "PlatformClient",
    "PlatformSessionError",
    "delete",
    "get",
    "head",
    "options",
    "patch",
    "platform",
    "platform_request",
    "post",
    "put",
    "request",
    "session",
]


def _reset_for_tests():
    """Drop the process-wide recorder and session cache (tests only)."""
    _trace.reset()
    _platform.reset_cache()


def _flush_summary():
    """Write the trace summary early (tests and one-shot scripts)."""
    _trace.flush_summary()
