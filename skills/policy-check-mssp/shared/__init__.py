#!/usr/bin/env python3
"""Shared runtime helpers for policy-check-mssp."""

import json
import sys
from datetime import datetime

from shared.http import MSSPRequestError, endpoint, endpoint_headers, origin, request, request_json
from shared.output import (
    atomic_write_json,
    atomic_write_text,
    cache_dir,
    clear_reports,
    output_root,
    reports_dir,
)
from shared.session import MSSPSession, extract_cookie_value, get_cookie, get_session
from shared.state import (
    ACTIVE_STATUSES,
    TERMINAL_STATUSES,
    ActiveRunError,
    RunLock,
    begin_step,
    finish_step,
    latest_status,
    new_run,
    read_state,
    update_state,
    utc_now,
    write_state,
)


def log(message: str, level: str = "INFO") -> None:
    timestamp = datetime.now().strftime("%H:%M:%S")
    print(f"[{timestamp}] [{level}] [policy-check-mssp] {message}", file=sys.stderr, flush=True)


def emit_json(payload: dict, error: bool = False) -> None:
    stream = sys.stderr if error else sys.stdout
    print(json.dumps(payload, ensure_ascii=False), file=stream, flush=True)


__all__ = [
    "ACTIVE_STATUSES", "TERMINAL_STATUSES", "ActiveRunError", "RunLock", "begin_step",
    "atomic_write_json", "atomic_write_text", "cache_dir", "clear_reports", "emit_json",
    "endpoint", "endpoint_headers", "extract_cookie_value", "finish_step", "get_cookie",
    "get_session", "origin",
    "latest_status", "log", "new_run", "output_root", "read_state", "reports_dir",
    "MSSPRequestError", "MSSPSession", "request", "request_json", "update_state",
    "utc_now", "write_state",
]
