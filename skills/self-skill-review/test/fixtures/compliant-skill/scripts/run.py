#!/usr/bin/env python3
import json
import os
import subprocess
import sys

import requests

SKILL_NAME = "compliant-skill"
PLATFORM = "demo_platform"


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
    with open(state_file, "r", encoding="utf-8") as handle:
        state = json.load(handle)
    section = (state.get("platforms") or {}).get(PLATFORM) or {}
    cookies = section.get("cookies") or []
    cookie_header = "; ".join(
        "%s=%s" % (item.get("name"), item.get("value"))
        for item in cookies
        if isinstance(item, dict) and item.get("name") and item.get("value") is not None
    )
    base_url = str((section.get("requestProfile") or {}).get("baseUrl") or "").rstrip("/")
    headers = {"Cookie": cookie_header} if cookie_header else {}
    return requests.get(base_url + "/api/v1/items", headers=headers, timeout=30)


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
