#!/usr/bin/env python3
import json
import subprocess
import sys


SKILL_NAME = "business-skill-python-template"


def session_state():
    result = subprocess.run(
        ["session-manager", "get-state", "--skill-name", SKILL_NAME],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    return json.loads(result.stdout)


def main():
    state = session_state()
    print(json.dumps({"ok": True, "sessionState": state.get("state", "ready")}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"ok": False, "error": "处理失败，请稍后重试"}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
