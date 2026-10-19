"""muad_skill_http: trace-aware requests helpers and runtime instrumentation.

Usage in skills::

    import muad_skill_http

    response = muad_skill_http.get("http://service/api")

Skills keep using ``import requests``; the image startup hook imports
``muad_skill_http.compat``, which instruments requests to business hosts only
when Runtime Guard injects ``MUAD_REQUESTS_COMPAT=1`` and
``MUAD_BUSINESS_HOSTS``. The helper functions below remain available for local
development.
"""

from __future__ import annotations

from . import _trace
from ._http import delete, get, head, options, patch, post, put, request, session
from ._local import build_local_state, cookies_from_header, merge_local_states
from ._trace import EXIT_REQUEST_LIMIT

__all__ = [
    "EXIT_REQUEST_LIMIT",
    "build_local_state",
    "cookies_from_header",
    "merge_local_states",
    "delete",
    "get",
    "head",
    "options",
    "patch",
    "post",
    "put",
    "request",
    "session",
]


def _reset_for_tests():
    """Drop the process-wide recorder (tests only)."""
    _trace.reset()


def _flush_summary():
    """Write the trace summary early (tests and one-shot scripts)."""
    _trace.flush_summary()
