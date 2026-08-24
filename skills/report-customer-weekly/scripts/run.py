#!/usr/bin/env python3
"""Generate a simulated weekly customer activity report bundle as a tar archive.

Long-running background task: sleeps in stages to mimic a slow export, then
writes a multi-file report bundle (summary markdown + detail CSV + activity
JSONL + export log), packs it into a single .tar archive, and prints a compact
JSON summary. The tar is guaranteed to be at least --size-mb MiB (default 30).
Safe to run in the task session; never prints secrets, tokens, or internal paths.
"""

import argparse
import csv
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
import time
import uuid
from datetime import datetime, timedelta, timezone

# Overridable delay (seconds per stage) so tests can run without the real wait.
_STAGE_DELAY = float(os.environ.get("REPORT_SKILL_STAGE_DELAY", "6"))

# Overridable target archive size in MiB (--size-mb default).
_TARGET_MB = int(os.environ.get("REPORT_SKILL_TARGET_MB", "30"))

# 模拟明细文件的行数（csv 与 jsonl 各生成这么多行）。
_DATA_ROWS = 512

# 文件名白名单净化：仅保留字母数字、下划线、点、连字符与中文，其余替换为 "_"。
# 防止 customer/period 中的 "../" 或 "/" 把报告写出 SKILL_OUTPUT_DIR。
_SAFE_CHARS = re.compile(r"[^A-Za-z0-9_\u4e00-\u9fff.\-]")
_ERROR_EXIT = 2

# 导出日志填充行：确定性、无业务含义，仅用于把 tar 体积撑到目标值。
_FILLER = "INFO report-customer-weekly export filler #%09d\n"
_FILLER_CHUNK = 10_000


def parse_args():
    parser = argparse.ArgumentParser(description="generate customer weekly report tar")
    parser.add_argument("--customer", required=True, help="customer name")
    parser.add_argument(
        "--period",
        help="report period, e.g. 2026-W31 (default: current ISO week)",
    )
    parser.add_argument(
        "--size-mb",
        type=int,
        default=_TARGET_MB,
        help="minimum tar size in MiB (default: $REPORT_SKILL_TARGET_MB or 30)",
    )
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


def current_iso_week():
    """Current ISO week, e.g. 2026-W34. Used when --period is not provided."""
    iso = datetime.now(timezone.utc).isocalendar()
    return f"{iso.year}-W{iso.week:02d}"


def simulate_work():
    # Emulate a slow export: ~20s of staged work so the queued/running/succeeded
    # state transitions stay observable in the Console Long Tasks view.
    stages = [
        ("fetching customer data", 6),
        ("aggregating activities", 7),
        ("writing report files", 7),
    ]
    for label, _ in stages:
        time.sleep(_STAGE_DELAY)
        print(f"[report-customer-weekly] {label} done", file=sys.stderr)


def build_device_csv(staging, base):
    path = os.path.join(staging, "data", "device-inspection.csv")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["time", "line", "device", "activity", "result"])
        for i in range(_DATA_ROWS):
            ts = (base + timedelta(seconds=i)).strftime("%Y-%m-%dT%H:%M:%SZ")
            writer.writerow([ts, f"line-{i % 8:02d}", f"dev-{i % 23:03d}", "inspect", "OK"])
    return path


def build_activity_jsonl(staging, customer, period, base):
    path = os.path.join(staging, "data", "activity-log.jsonl")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        for i in range(_DATA_ROWS):
            ts = (base + timedelta(seconds=i)).strftime("%Y-%m-%dT%H:%M:%SZ")
            record = {
                "ts": ts,
                "customer": customer,
                "period": period,
                "activity": "login",
                "status": "ok",
                "seq": i,
            }
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    return path


def build_export_log(staging, customer, period, started):
    path = os.path.join(staging, "logs", "export.log")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    lines = [
        f"[report-customer-weekly] export started {started.strftime('%Y-%m-%dT%H:%M:%SZ')}",
        f"[report-customer-weekly] customer={customer} period={period}",
        "[report-customer-weekly] fetching customer data done",
        "[report-customer-weekly] aggregating activities done",
        "[report-customer-weekly] writing report files done",
        "[report-customer-weekly] padding export log to reach target tar size",
    ]
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
    return path


def total_size(paths):
    return sum(os.path.getsize(path) for path in paths)


def pad_export_log(log_path, current_total, target):
    """Append deterministic filler lines until cumulative size >= target bytes.

    current_total is the running total across all report files before padding;
    returns the actual export.log file size after padding.
    """
    with open(log_path, "a", encoding="utf-8") as handle:
        chunk = []
        index = 0
        while current_total < target:
            line = _FILLER % index
            chunk.append(line)
            current_total += len(line.encode("utf-8"))
            index += 1
            if len(chunk) >= _FILLER_CHUNK:
                handle.write("".join(chunk))
                chunk.clear()
        if chunk:
            handle.write("".join(chunk))
    return os.path.getsize(log_path)


def build_summary_md(staging, customer, period, report_id, rows, started, members):
    """Write the summary markdown with a member manifest. members: [(relname, size)]."""
    path = os.path.join(staging, f"{customer}-{period}.md")
    lines = [
        f"# 客户周报：{customer}（{period}）",
        "",
        f"- 报告 ID：{report_id}",
        f"- 统计行数：{rows}",
        f"- 生成时间：{started.strftime('%Y-%m-%dT%H:%M:%SZ')}",
        "",
        "## 打包内容",
    ]
    for name, size in members:
        lines.append(f"- `{name}`（{size} bytes）")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
    return path


def create_tar(staging, tar_path):
    """Pack all files under staging into a single tar archive."""
    with tarfile.open(tar_path, "w") as archive:
        for root, dirs, files in os.walk(staging):
            dirs.sort()
            for name in sorted(files):
                path = os.path.join(root, name)
                archive.add(path, arcname=os.path.relpath(path, staging))


def verify_tar(tar_path, target):
    """Open the tar (validates headers) and confirm it is not empty and >= target."""
    size = os.path.getsize(tar_path)
    if size < target:
        raise RuntimeError(f"tar too small: {size} < {target} bytes")
    with tarfile.open(tar_path, "r") as archive:
        members = archive.getnames()
    if not members:
        raise RuntimeError("tar is empty")
    return size, members


def cleanup_staging(staging):
    try:
        shutil.rmtree(staging)
    except OSError as error:
        print(f"warning: failed to clean staging dir {staging}: {error}", file=sys.stderr)


def main():
    args = parse_args()
    try:
        customer = sanitize_component(args.customer, "customer")
        period = sanitize_component(text(args.period) or current_iso_week(), "period")
        if args.size_mb <= 0:
            raise ValueError("--size-mb must be a positive integer")
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(_ERROR_EXIT)

    output_dir = resolve_output_dir(args)
    os.makedirs(output_dir, exist_ok=True)

    started = datetime.now(timezone.utc)
    simulate_work()
    report_id = str(uuid.uuid4())[:8]
    target = args.size_mb * 1024 * 1024
    base = started.replace(hour=8, minute=0, second=0, microsecond=0)

    staging = os.path.join(output_dir, f".staging-{report_id}")
    os.makedirs(staging, exist_ok=True)
    try:
        csv_path = build_device_csv(staging, base)
        jsonl_path = build_activity_jsonl(staging, customer, period, base)
        log_path = build_export_log(staging, customer, period, started)
        current_total = total_size([csv_path, jsonl_path, log_path])
        padded_total = pad_export_log(log_path, current_total, target)

        members = [
            (os.path.relpath(csv_path, staging), os.path.getsize(csv_path)),
            (os.path.relpath(jsonl_path, staging), os.path.getsize(jsonl_path)),
            (os.path.relpath(log_path, staging), padded_total),
        ]
        build_summary_md(staging, customer, period, report_id, _DATA_ROWS, started, members)

        tar_path = os.path.join(output_dir, f"{customer}-{period}.tar")
        create_tar(staging, tar_path)
        tar_size, tar_members = verify_tar(tar_path, target)
    finally:
        cleanup_staging(staging)

    summary = {
        "status": "ok",
        "customer": customer,
        "period": period,
        "rows": _DATA_ROWS,
        "format": "tar",
        "sizeMb": args.size_mb,
        "sizeBytes": tar_size,
        "members": tar_members,
        "report": tar_path,
        "reportId": report_id,
    }
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
