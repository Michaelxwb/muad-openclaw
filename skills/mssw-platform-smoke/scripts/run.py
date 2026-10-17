#!/usr/bin/env python3
"""One-shot MSSW platform smoke through the shared skill SDK."""

import json
import os
import sys
import uuid

from muad_skill_http import platform_request

from _common import (
    EXIT_NOT_SKILL_EXECUTION,
    PING_PATH,
    PLATFORM,
    SkillExecutionRequired,
    require_skill_execution,
)


def main():
    require_skill_execution()
    response = platform_request(PLATFORM, "GET", PING_PATH)
    if response.status_code != 200:
        raise RuntimeError("%s ping returned HTTP %d" % (PLATFORM, response.status_code))
    payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError("%s ping returned a non-object payload" % PLATFORM)
    missing = [
        name for name in ("user", "traceId", "path")
        if not isinstance(payload.get(name), str) or not payload[name].strip()
    ]
    if missing:
        raise RuntimeError("%s ping response missing %s" % (PLATFORM, ", ".join(missing)))
    if payload["path"] != PING_PATH:
        raise RuntimeError(
            "%s ping returned path %r, expected %r" % (PLATFORM, payload["path"], PING_PATH)
        )
    try:
        uuid.UUID(payload["traceId"])
    except ValueError:
        raise RuntimeError(
            "%s ping returned a non-UUID Traceid %r" % (PLATFORM, payload["traceId"])
        )
    result = {
        "status": "MSSW_SMOKE_OK",
        "httpStatus": response.status_code,
        "user": payload["user"],
        "trace": payload["traceId"],
        "path": payload["path"],
    }
    # Artifacts are best-effort: a read-only or full output dir must not hide a
    # successful request result from stdout.
    out_dir = os.environ.get("SKILL_OUTPUT_DIR")
    if out_dir:
        try:
            os.makedirs(out_dir, exist_ok=True)
            with open(os.path.join(out_dir, "mssw-smoke.json"), "w", encoding="utf-8") as handle:
                json.dump(result, handle, ensure_ascii=False)
        except OSError as error:
            sys.stderr.write("%s artifact write skipped: %s\n" % (PLATFORM, error))
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SkillExecutionRequired as error:
        sys.stderr.write(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False) + "\n")
        sys.exit(EXIT_NOT_SKILL_EXECUTION)
    except Exception as error:
        sys.stderr.write(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False) + "\n")
        sys.exit(1)
