#!/usr/bin/env python3
import json
import os
import subprocess
import sys

from muad_skill_http import platform_request

SKILL_NAME = "compliant-skill"


def resolve_state_file():
    completed = subprocess.run(
        ["session-manager", "get-state", "--skill-name", SKILL_NAME],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if completed.returncode != 0:
        raise RuntimeError("session-manager get-state failed")
    return json.loads(completed.stdout)["sessionStateFile"]


def fetch_items(state_file):
    return platform_request("demo_platform", "GET", "/api/v1/items", state_file=state_file)


def main():
    response = fetch_items(resolve_state_file())
    if response.status_code >= 400:
        raise RuntimeError("business request failed")
    out_dir = os.environ.get("SKILL_OUTPUT_DIR")
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, "result.json"), "w", encoding="utf-8") as handle:
            json.dump({"status": response.status_code}, handle)
    # Response field, not a request header: must not trigger SS-R007.
    print(json.dumps({"ok": True, "traceId": response.headers.get("Traceid")}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"ok": False}), file=sys.stderr)
        sys.exit(1)
