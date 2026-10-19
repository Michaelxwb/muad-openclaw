#!/usr/bin/env python3
"""Repeat one MSSW interface to exercise the per-execution request limit.

Progress goes to stderr; stdout is exactly one machine-readable JSON result.
When the next request would exceed the injected limit, the summary is printed
before the SDK terminates the process with exit 86, so callers still get a
parseable result.
"""

import argparse
import json
import os
import sys
import uuid

from muad_skill_http import platform_request

from _common import (
    ALLOWED_PATHS,
    DEFAULT_PROBE_COUNT,
    EXIT_NOT_SKILL_EXECUTION,
    MAX_PROBE_COUNT,
    PING_PATH,
    PLATFORM,
    SkillExecutionRequired,
    require_skill_execution,
)


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        _fail(message, 2)


def _fail(message, code):
    sys.stderr.write(json.dumps({"ok": False, "error": message}, ensure_ascii=False) + "\n")
    raise SystemExit(code)


def _limit_from_env():
    raw = str(os.environ.get("MUAD_SKILL_REQUEST_LIMIT", "")).strip()
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return 0
    return value if value > 0 else 0


def _default_count(limit):
    # No explicit --count: make the probe hit the injected limit by sending
    # limit+1 requests. Without an injected limit, only check Traceid uniqueness.
    return min(limit + 1, MAX_PROBE_COUNT) if limit > 0 else DEFAULT_PROBE_COUNT


def _trace_id(response):
    try:
        payload = response.json()
    except ValueError:
        return ""
    value = payload.get("traceId") if isinstance(payload, dict) else ""
    return str(value).strip() if value else ""


def _summary(status, path, requested, sent, limit, trace_ids):
    print(json.dumps({
        "status": status,
        "path": path,
        "requested": requested,
        "sent": sent,
        "limit": limit,
        "traceCount": len(trace_ids),
        "traceIdsUnique": len(trace_ids) == len(set(trace_ids)),
    }, ensure_ascii=False), flush=True)


def main():
    require_skill_execution()
    parser = _Parser(description="Probe the MSSW per-interface request limit.")
    parser.add_argument("--count", type=int, default=None)
    parser.add_argument("--path", default=PING_PATH, choices=sorted(ALLOWED_PATHS))
    args = parser.parse_args()
    limit = _limit_from_env()
    count = args.count if args.count is not None else _default_count(limit)
    if not 1 <= count <= MAX_PROBE_COUNT:
        _fail("--count must be between 1 and %d" % MAX_PROBE_COUNT, 2)

    trace_ids = []
    sent = 0
    for index in range(count):
        expected_trigger = limit > 0 and index + 1 > limit
        if expected_trigger:
            # The SDK will call os._exit(86) inside platform_request before the
            # request is sent; emit the single stdout result first.
            _summary("LIMIT_TRIGGERED", args.path, count, sent, limit, trace_ids)
        response = platform_request(PLATFORM, "GET", args.path)
        if expected_trigger:
            # One summary has already been printed; never emit a second stdout
            # document if the limit was not actually enforced by the runtime.
            _fail("request limit did not terminate the SDK", 1)
        if response.status_code != 200:
            _fail("request %d returned HTTP %d" % (index + 1, response.status_code), 1)
        sent += 1
        trace_id = _trace_id(response)
        if not trace_id:
            _fail("response missing Traceid", 1)
        try:
            uuid.UUID(trace_id)
        except ValueError:
            _fail("response Traceid is not a UUID: %r" % trace_id, 1)
        if trace_id in trace_ids:
            _fail("duplicate Traceid detected", 3)
        trace_ids.append(trace_id)
        sys.stderr.write("request %d/%d status=%d\n" % (index + 1, count, response.status_code))
        sys.stderr.flush()

    _summary("LIMIT_NOT_TRIGGERED", args.path, count, sent, limit, trace_ids)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SkillExecutionRequired as error:
        sys.stderr.write(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False) + "\n")
        sys.exit(EXIT_NOT_SKILL_EXECUTION)
    except SystemExit:
        raise
    except Exception as error:
        sys.stderr.write(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False) + "\n")
        sys.exit(1)
