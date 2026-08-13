#!/usr/bin/env python3
import json
import os
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
    # 写文件用 SKILL_OUTPUT_DIR（guard 注入的 per-agent 目录）；别写 Skill 根目录（只读）或 /tmp
    out_dir = os.environ.get("SKILL_OUTPUT_DIR")
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, "result.json"), "w", encoding="utf-8") as f:
            json.dump({"ok": True}, f, ensure_ascii=False)
    print(json.dumps({"ok": True, "sessionState": state.get("state", "ready")}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"ok": False, "error": "处理失败，请稍后重试"}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
