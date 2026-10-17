#!/usr/bin/env python3
"""One-shot MSSW platform smoke through the shared skill SDK."""

import json
import os
import sys

from muad_skill_http import platform_request

PLATFORM = "mssw"
PING_PATH = "/api/v1/ping"


def main():
    response = platform_request(PLATFORM, "GET", PING_PATH)
    if response.status_code != 200:
        raise RuntimeError("mssw ping returned HTTP %d" % response.status_code)
    payload = response.json()
    result = {
        "status": "MSSW_SMOKE_OK",
        "httpStatus": response.status_code,
        "user": payload.get("user"),
        "trace": payload.get("traceId"),
        "path": payload.get("path"),
    }
    out_dir = os.environ.get("SKILL_OUTPUT_DIR")
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, "mssw-smoke.json"), "w", encoding="utf-8") as handle:
            json.dump(result, handle, ensure_ascii=False)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        sys.stderr.write("%s\n" % error)
        sys.exit(1)
