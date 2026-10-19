"""Local-development helpers for turning browser cookies into a state file.

These functions never send requests and never log cookie values. They exist so
a developer can paste the ``Cookie`` request header from DevTools and produce a
file that ``platform_request(..., state_file=...)`` accepts.

Not for runtime use: production sessions are resolved by ``session-manager``.
"""

from __future__ import annotations


def cookies_from_header(value):
    """Parse a browser ``Cookie`` header into a cookie list.

    Accepts ``name=value; name2=value2`` with or without a leading
    ``Cookie:``. Segments without ``=`` are ignored. Surrounding double quotes
    on a value are removed; ``=`` inside a value is preserved.
    """
    raw = str(value or "").strip()
    if raw.lower().startswith("cookie:"):
        raw = raw.split(":", 1)[1].strip()
    if not raw:
        return []
    cookies = []
    for chunk in raw.split(";"):
        item = chunk.strip()
        if not item or "=" not in item:
            continue
        name, cookie_value = item.split("=", 1)
        name = name.strip()
        cookie_value = cookie_value.strip()
        if not name:
            continue
        if len(cookie_value) >= 2 and cookie_value[0] == cookie_value[-1] == '"':
            cookie_value = cookie_value[1:-1]
        cookies.append({"name": name, "value": cookie_value})
    return cookies


def build_local_state(
    platform,
    cookie_header,
    *,
    base_url,
    host_header=None,
    csrf=None,
    static_headers=None,
    trace_header="Traceid",
):
    """Build a session state dict from a copied ``Cookie`` header.

    ``base_url`` is required for relative request paths. ``csrf`` is a list of
    ``{"cookie": "<cookie name>", "header": "<header name>"}`` mappings. The
    result can be written with ``json.dump`` and passed as ``state_file``.
    """
    name = str(platform or "").strip()
    if not name:
        raise ValueError("platform is required")
    base = str(base_url or "").strip()
    if not base:
        raise ValueError("base_url is required")
    cookies = cookies_from_header(cookie_header)
    if not cookies:
        raise ValueError("no cookies found in cookie header")
    section = {
        "platform": name,
        "source": "local-file",
        "cookies": cookies,
        "storageState": {"cookies": cookies, "origins": []},
        "requestProfile": {
            "baseUrl": base,
            "hostHeader": dict(host_header or {}),
            "csrf": [dict(item) for item in (csrf or [])],
            "staticHeaders": dict(static_headers or {}),
            "traceHeader": trace_header,
            "extraAllowed": True,
        },
    }
    return {"version": 1, "platforms": {name: section}}


def merge_local_states(*states):
    """Merge state dicts from ``build_local_state`` into one state file.

    Each input must contain a non-empty ``platforms`` object. Duplicate
    platform names raise ``ValueError`` instead of silently overwriting.
    """
    merged = {"version": 1, "platforms": {}}
    for index, state in enumerate(states):
        if not isinstance(state, dict) or not isinstance(state.get("platforms"), dict):
            raise ValueError("state %d is not a local session state" % index)
        platforms = state["platforms"]
        if not platforms:
            raise ValueError("state %d has no platforms" % index)
        for name, section in platforms.items():
            if not isinstance(section, dict):
                raise ValueError("state %d platform %r is invalid" % (index, name))
            if name in merged["platforms"]:
                raise ValueError("duplicate platform: %s" % name)
            merged["platforms"][name] = section
    return merged
