#!/usr/bin/env python3
"""Generate a simulated weekly customer activity report.

Long-running background task: sleeps in stages to mimic a slow export, then
writes a report file and prints a compact JSON summary. Safe to run in the
task session; never prints secrets, tokens, or internal paths.
"""

import argparse
import json
import os
import re
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone

# Overridable delay (seconds per stage) so tests can run without the real wait.
_STAGE_DELAY = float(os.environ.get("REPORT_SKILL_STAGE_DELAY", "6"))

# 文件名白名单净化：仅保留字母数字、下划线、点、连字符与中文，其余替换为 "_"。
# 防止 customer/period 中的 "../" 或 "/" 把报告写出 SKILL_OUTPUT_DIR。
_SAFE_CHARS = re.compile(r"[^A-Za-z0-9_\u4e00-\u9fff.\-]")
_ERROR_EXIT = 2


def parse_args():
    parser = argparse.ArgumentParser(description="generate customer weekly report")
    parser.add_argument("--customer", required=True, help="customer name")
    parser.add_argument("--period", required=True, help="report period, e.g. 2026-W31")
    parser.add_argument(
        "--output-dir",
        help="report output directory (default: $SKILL_OUTPUT_DIR, then /tmp/muad-skill-outputs)",
    )
    return parser.parse_args()


def sanitize_component(value, label):
    raw = text(value)
    if not raw:
        raise ValueError(f"{label} must not be empty")
    safe = _SAFE_CHARS.sub("_", raw)
    if not safe:
        raise ValueError(f"{label} is empty after sanitization")
    if ".." in safe:
        raise ValueError(f"{label} contains unsafe path segments")
    return safe


def resolve_output_dir(args):
    # Priority: explicit flag > framework-injected SKILL_OUTPUT_DIR > temp fallback.
    # Never write into the skill directory: it is mounted read-only.
    explicit = text(args.output_dir)
    if explicit:
        return explicit
    from_env = text(os.environ.get("SKILL_OUTPUT_DIR", ""))
    if from_env:
        return from_env
    return os.path.join(tempfile.gettempdir(), "muad-skill-outputs")


def text(value):
    return (value or "").strip()


def simulate_work(customer, period):
    # Emulate a slow export: ~20s of staged work so the queued/running/succeeded
    # state transitions stay observable in the Console Long Tasks view.
    stages = [
        ("fetching customer data", 6),
        ("aggregating activities", 7),
        ("writing report file", 7),
    ]
    rows = 0
    for label, _ in stages:
        time.sleep(_STAGE_DELAY)
        rows += len(customer) + 3
        print(f"[report-customer-weekly] {label} done", file=sys.stderr)
    return rows


def main():
    args = parse_args()
    try:
        customer = sanitize_component(args.customer, "customer")
        period = sanitize_component(args.period, "period")
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(_ERROR_EXIT)

    output_dir = resolve_output_dir(args)
    os.makedirs(output_dir, exist_ok=True)

    started = datetime.now(timezone.utc)
    rows = simulate_work(customer, period)

    report_id = str(uuid.uuid4())[:8]
    report_path = os.path.join(output_dir, f"{customer}-{period}.md")
    lines = [
        f"# 客户周报：{customer}（{period}）",
        "",
        f"- 报告 ID：{report_id}",
        f"- 统计行数：{rows}",
        f"- 生成时间：{started.strftime('%Y-%m-%dT%H:%M:%SZ')}",
    ]
    with open(report_path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")

    summary = {
        "status": "ok",
        "customer": customer,
        "period": period,
        "rows": rows,
        "report": report_path,
        "reportId": report_id,
    }
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
