#!/usr/bin/env python3
"""Repeat one MSSW interface to exercise the per-execution request limit."""

import argparse
import json
import sys

from muad_skill_http import platform_request

PLATFORM = "mssw"


def main():
    parser = argparse.ArgumentParser(description="Probe the MSSW per-interface request limit.")
    parser.add_argument("--count", type=int, default=4)
    parser.add_argument("--path", default="/api/v1/ping")
    args = parser.parse_args()
    if args.count < 1:
        raise SystemExit("--count must be >= 1")

    for index in range(args.count):
        response = platform_request(PLATFORM, "GET", args.path)
        if response.status_code != 200:
            raise RuntimeError("request %d returned HTTP %d" % (index + 1, response.status_code))
        print(json.dumps({"request": index + 1, "status": response.status_code}), flush=True)

    print(json.dumps({"status": "LIMIT_NOT_TRIGGERED", "count": args.count}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        sys.stderr.write("%s\n" % error)
        sys.exit(1)
