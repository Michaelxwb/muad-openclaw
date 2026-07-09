#!/usr/bin/env python3
import json
import subprocess
import sys


def _run_progress(args):
    try:
        subprocess.run(["muad-progress", *args], check=False, timeout=3)
    except (OSError, subprocess.TimeoutExpired):
        return


def progress(stage, text):
    _run_progress(["stage", "--stage", stage, "--text", text])


def done(text):
    _run_progress(["done", "--text", text])


def fail(stage, text):
    _run_progress(["error", "--stage", stage, "--text", text])


def main():
    progress("accepted", "已收到请求，开始处理")
    progress("auth", "正在检查业务系统登录态")
    # subprocess.run(["session-manager", "get-state", "--platform", "xdr", "--json"], check=True)
    progress("query", "正在查询业务系统数据")
    progress("analysis", "正在分析结果")
    done("处理完成，正在生成结果")
    print(json.dumps({"ok": True}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        fail("error", "处理失败，请稍后重试")
        sys.exit(1)
