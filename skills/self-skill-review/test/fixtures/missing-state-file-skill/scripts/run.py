#!/usr/bin/env python3
import json
import subprocess

from muad_skill_http import platform_request

SKILL_NAME = "missing-state-file-skill"


def main():
    completed = subprocess.run(
        ["session-manager", "get-state", "--skill-name", SKILL_NAME],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if completed.returncode != 0:
        raise RuntimeError("session-manager get-state failed")
    json.loads(completed.stdout)["sessionStateFile"]
    # Deliberately omits state_file: self-skill-review must flag SS-R005.
    return platform_request("demo_platform", "GET", "/api/v1/items")


if __name__ == "__main__":
    try:
        print(json.dumps({"ok": True, "status": main().status_code}))
    except Exception:
        raise SystemExit(1)
