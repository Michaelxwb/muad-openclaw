"""Path and target normalization for interface counting."""

from __future__ import annotations

import re
from urllib.parse import urlsplit

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
_HEX_RE = re.compile(r"^[0-9a-fA-F]{8,}$")
_DIGITS_RE = re.compile(r"^\d+$")


def normalize_path(path):
    """Collapse volatile path segments and drop query/fragment.

    Numeric, UUID and long hex segments become ``{id}`` so one business
    interface is counted once regardless of object ids.
    """
    if not isinstance(path, str):
        path = str(path or "")
    if path.startswith(("http://", "https://")):
        raw = urlsplit(path).path or "/"
    else:
        raw = path.split("?", 1)[0].split("#", 1)[0]
    if not raw:
        return "/"
    segments = ["{id}" if _is_volatile(segment) else segment for segment in raw.split("/")]
    return "/".join(segments) or "/"


def split_target(url):
    """Return (host:port, normalized path) for a request URL."""
    parts = urlsplit(str(url))
    host = (parts.hostname or "").lower()
    try:
        port = parts.port
    except ValueError:
        port = None
    if port:
        host = "%s:%d" % (host, port)
    return host, normalize_path(parts.path or "/")


def _is_volatile(segment):
    if not segment:
        return False
    return bool(_DIGITS_RE.match(segment) or _UUID_RE.match(segment) or _HEX_RE.match(segment))
