#!/usr/bin/env python3
import json
import os
import subprocess
import sys

from muad_skill_http import platform_request

PLATFORM = "example_platform"
SKILL_NAME = "business-skill-python-template"
# Local development only. A pod always injects MUAD_SESSION_KEY, so pods use
# session-manager and never read this path.
LOCAL_STATE_FILE = os.path.expanduser("~/.muad-local/session-state.json")


def get_session_state():
    """Resolve the Skill's login state through session-manager.

    The SDK no longer resolves sessions itself: pass the returned state file to
    platform_request. The skill name must match muad.skill.json.

    Local development without session-manager: if MUAD_SESSION_KEY is absent
    (never in a pod) and ~/.muad-local/session-state.json exists, use it.
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


def fetch_example(state_file):
    return platform_request(PLATFORM, "GET", "/api/v1/example", state_file=state_file)


def main():
    report_progress("stage", "开始处理业务请求")
    state_file = get_session_state()
    response = fetch_example(state_file)
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
