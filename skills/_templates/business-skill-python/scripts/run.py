#!/usr/bin/env python3
import json
import os
import subprocess
import sys

from muad_skill_http import platform_request

PLATFORM = "example_platform"


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


def fetch_example():
    return platform_request(PLATFORM, "GET", "/api/v1/example")


def main():
    report_progress("stage", "开始处理业务请求")
    response = fetch_example()
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
