#!/usr/bin/env python3
"""Generate a simulated weekly customer activity report.

Long-running background task: sleeps in stages to mimic a slow export, then
writes a report file and prints a compact JSON summary. Safe to run in the
task session; never prints secrets, tokens, or internal paths.
"""

import argparse
import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone

# Overridable delay (seconds per stage) so tests can run without the real wait.
_STAGE_DELAY = float(os.environ.get("REPORT_SKILL_STAGE_DELAY", "6"))


def parse_args():
    parser = argparse.ArgumentParser(description="generate customer weekly report")
    parser.add_argument("--customer", required=True, help="customer name")
    parser.add_argument("--period", required=True, help="report period, e.g. 2026-W31")
    return parser.parse_args()


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


def skill_root():
    # scripts/run.py -> <skill-dir>/ ; resolve the skill directory explicitly
    # instead of walking N parent dirs, so the script keeps working regardless
    # of where the bundle is extracted.
    current = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(current)


def main():
    args = parse_args()
    output_dir = os.path.join(skill_root(), "output")
    os.makedirs(output_dir, exist_ok=True)

    started = datetime.now(timezone.utc)
    rows = simulate_work(args.customer, args.period)

    report_id = str(uuid.uuid4())[:8]
    report_path = os.path.join(output_dir, f"{args.customer}-{args.period}.md")
    lines = [
        f"# 客户周报：{args.customer}（{args.period}）",
        "",
        f"- 报告 ID：{report_id}",
        f"- 统计行数：{rows}",
        f"- 生成时间：{started.strftime('%Y-%m-%dT%H:%M:%SZ')}",
    ]
    with open(report_path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")

    summary = {
        "status": "ok",
        "customer": args.customer,
        "period": args.period,
        "rows": rows,
        "report": report_path,
        "reportId": report_id,
    }
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
