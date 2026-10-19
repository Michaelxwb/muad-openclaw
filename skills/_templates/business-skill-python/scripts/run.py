#!/usr/bin/env python3
import json
import os
import subprocess
import sys

import requests

PLATFORM = "example_platform"
SKILL_NAME = "business-skill-python-template"
# Local development only. A pod always injects MUAD_SESSION_KEY, so pods use
# session-manager and never read this path.
LOCAL_STATE_FILE = os.path.expanduser("~/.muad-local/session-state.json")


def get_state_file():
    """Resolve the Skill session state file.

    Local development without session-manager reads LOCAL_STATE_FILE directly;
    a pod (MUAD_SESSION_KEY present) asks session-manager for fresh state.
    """
    if not os.environ.get("MUAD_SESSION_KEY") and os.path.isfile(LOCAL_STATE_FILE):
        return LOCAL_STATE_FILE
    try:
        completed = subprocess.run(
            ["session-manager", "get-state", "--skill-name", SKILL_NAME],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError("session-manager could not run: %s" % error)
    if completed.returncode != 0:
        detail = (completed.stderr or "").strip().splitlines()
        raise RuntimeError(
            "session-manager get-state failed: %s"
            % (detail[0][:200] if detail else "exit %d" % completed.returncode)
        )
    try:
        return json.loads(completed.stdout)["sessionStateFile"]
    except (ValueError, KeyError, TypeError) as error:
        raise RuntimeError("session-manager output is invalid: %s" % error)


def load_platform_state(state_file):
    with open(state_file, "r", encoding="utf-8") as handle:
        state = json.load(handle)
    section = (state.get("platforms") or {}).get(PLATFORM)
    if not isinstance(section, dict):
        raise RuntimeError("session state has no platform %s" % PLATFORM)
    profile = section.get("requestProfile") or {}
    base_url = str(profile.get("baseUrl") or "").rstrip("/")
    if not base_url:
        raise RuntimeError("platform %s has no baseUrl in session state" % PLATFORM)
    cookies = section.get("cookies") or []
    cookie_header = "; ".join(
        "%s=%s" % (item.get("name"), item.get("value"))
        for item in cookies
        if isinstance(item, dict) and item.get("name") and item.get("value") is not None
    )
    return base_url, cookie_header


def report_progress(command, text, code=None):
    args = ["muad-progress", command, "--stage", "execute", "--text", text]
    if code:
        args.extend(["--code", code])
    try:
        result = subprocess.run(
            args,
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def fetch_example(base_url, cookie_header):
    headers = {}
    if cookie_header:
        headers["Cookie"] = cookie_header
    # Runtime Guard adds TraceId/X-Csrftoken and accounting for business hosts.
    return requests.get(base_url + "/api/v1/example", headers=headers, timeout=30)


def main():
    report_progress("stage", "开始处理业务请求")
    state_file = get_state_file()
    base_url, cookie_header = load_platform_state(state_file)
    response = fetch_example(base_url, cookie_header)
    if response.status_code >= 400:
        raise RuntimeError(f"example platform returned {response.status_code}")
    # 写文件用 SKILL_OUTPUT_DIR（guard 注入的 per-agent 目录）；别写 Skill 根目录（只读）或 /tmp
    out_dir = os.environ.get("SKILL_OUTPUT_DIR")
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, "result.json"), "w", encoding="utf-8") as handle:
            json.dump({"ok": True}, handle, ensure_ascii=False)
    report_progress("done", "业务处理已完成")
    print(json.dumps({"ok": True, "status": response.status_code}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        report_progress("error", "业务处理失败，请稍后重试", "business_failed")
        print(json.dumps({"ok": False, "error": "处理失败，请稍后重试"}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
