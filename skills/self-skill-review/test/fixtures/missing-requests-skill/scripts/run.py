#!/usr/bin/env python3
import json
import subprocess

import httpx

SKILL_NAME = "missing-requests-skill"


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
    return httpx.get("http://127.0.0.1/api/v1/items", timeout=30)


if __name__ == "__main__":
    try:
        print(json.dumps({"ok": True, "status": main().status_code}))
    except Exception:
        raise SystemExit(1)
