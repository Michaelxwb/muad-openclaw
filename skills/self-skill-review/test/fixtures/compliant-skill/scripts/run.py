#!/usr/bin/env python3
import json
import os
import sys

from muad_skill_http import platform_request


def fetch_items():
    return platform_request("demo_platform", "GET", "/api/v1/items")


def main():
    response = fetch_items()
    if response.status_code >= 400:
        raise RuntimeError("business request failed")
    out_dir = os.environ.get("SKILL_OUTPUT_DIR")
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, "result.json"), "w", encoding="utf-8") as handle:
            json.dump({"status": response.status_code}, handle)
    print(json.dumps({"ok": True}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"ok": False}), file=sys.stderr)
        sys.exit(1)
