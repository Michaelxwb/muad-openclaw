#!/usr/bin/env python3
"""按 CGID 取最新 GPTRawLog，并生成后续研判所需的解析子文件。"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from parse_gptrawlog import resolve_archive_root
from event_context import enrich_event_context


BASE_DIR = SCRIPT_DIR.parent
SCRIPTS_DIR = SCRIPT_DIR


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="MSSP 事件深度分析与推送内容准备")
    parser.add_argument("--event-id", required=True, help="MSSP 事件 ID")
    parser.add_argument("--cgid", required=True, help="人工提供或上游传入的 NGES CGID")
    parser.add_argument("--event-context-json", help="监控结果中选中事件的 JSON 对象")
    parser.add_argument("--event-context-file", help="选中事件上下文 JSON 文件")
    parser.add_argument("--company-id", help="独立调用时可补充平台数字 company_id")
    parser.add_argument("--company-name", help="独立调用时可补充客户全名")
    parser.add_argument("--event-name", help="独立调用时可补充事件名")
    parser.add_argument("--host-ip", help="独立调用时可补充事件主机 IP")
    parser.add_argument("--db", help="沿用原查询脚本的 ClickHouse DB 参数")
    parser.add_argument("--start", help="沿用原查询脚本的起始时间")
    parser.add_argument("--end", help="沿用原查询脚本的结束时间")
    parser.add_argument("--limit", type=int, help="沿用原查询脚本的查询上限")
    parser.add_argument("--timeout", type=float, help="沿用原查询脚本的超时参数")
    parser.add_argument("-o", "--output", help="统一事件归档根")
    parser.add_argument("--event-dir", help="显式指定事件文件夹名")
    args = parser.parse_args(argv)
    if args.event_context_json and args.event_context_file:
        parser.error("--event-context-json 与 --event-context-file 只能二选一")
    return args


def load_event_context(args):
    if args.event_context_json:
        context = json.loads(args.event_context_json)
    elif args.event_context_file:
        with open(args.event_context_file, "r", encoding="utf-8") as file:
            context = json.load(file)
    else:
        context = {}
    if not isinstance(context, dict):
        raise ValueError("事件上下文必须是 JSON 对象")
    context_id = str(context.get("event_id") or context.get("事件 ID") or "").strip()
    if context_id and context_id != args.event_id:
        raise ValueError("事件上下文中的 event_id 与 --event-id 不一致")
    context["event_id"] = args.event_id
    for key, arg_name in (
        ("company_id", "company_id"),
        ("company", "company_name"),
        ("event_name", "event_name"),
        ("host_ip", "host_ip"),
    ):
        value = getattr(args, arg_name, None)
        if value and not context.get(key):
            context[key] = value
    return context


def build_query_command(args, rawlog_path):
    command = [
        sys.executable,
        str(SCRIPTS_DIR / "mssp_ch_query.py"),
        "--cgid",
        args.cgid,
        "--out",
        str(rawlog_path),
    ]
    for flag, value in (
        ("--db", args.db),
        ("--start", args.start),
        ("--end", args.end),
        ("--limit", args.limit),
        ("--timeout", args.timeout),
    ):
        if value is not None:
            command.extend([flag, str(value)])
    return command


def safe_part(value):
    text = re.sub(r'[\\/:*?"<>|\s]+', "_", str(value or "").strip())
    return text.strip("_")[:80]


def context_value(context, *keys):
    for key in keys:
        value = context.get(key)
        if value not in (None, ""):
            return value
    return ""


def derive_event_dir(context, event_id):
    parts = [
        context_value(context, "company", "company_name", "客户"),
        context_value(context, "event_time", "create_time", "事件时间"),
        context_value(context, "host_ip", "主机 IP"),
        context_value(context, "event_name", "事件名"),
    ]
    cleaned = [safe_part(part) for part in parts if safe_part(part)]
    return "_".join(cleaned) if cleaned else safe_part(event_id)


def unique_event_dir(archive_root, requested):
    base = safe_part(requested) or "security_event"
    candidate = base
    index = 2
    while (Path(archive_root) / candidate).exists():
        candidate = f"{base}_{index}"
        index += 1
    return candidate


def run_process(command, label):
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(f"{label}失败: {detail}")
    return result.stdout


def write_event_context(event_dir, context):
    if not context:
        return None
    context_path = Path(event_dir) / "事件上下文.json"
    context_path.write_text(json.dumps(context, ensure_ascii=False, indent=2), encoding="utf-8")
    asset_path = Path(event_dir) / "事件与资产信息.md"
    fields = (
        ("事件 ID", context_value(context, "event_id", "事件 ID")),
        ("客户", context_value(context, "company", "company_name", "客户")),
        ("事件名", context_value(context, "event_name", "事件名")),
        ("主机 IP", context_value(context, "host_ip", "主机 IP")),
        ("主机名称", context_value(context, "hostname", "主机名称")),
        ("资产名称", context_value(context, "asset_name", "资产名称")),
        ("资产组", context_value(context, "asset_group", "资产组")),
        ("业务名称", context_value(context, "business_name", "业务名称")),
        ("业务等级", context_value(context, "business_level", "业务等级")),
        ("资产类型", context_value(context, "asset_type", "资产类型")),
        ("设备覆盖", context_value(context, "dev_name", "设备覆盖")),
        ("处置状态", context_value(context, "event_status", "处置状态")),
    )
    lines = ["# 事件与资产信息", ""] + [f"- **{name}**: {value or '-'}" for name, value in fields]
    asset_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return context_path


def find_outputs(event_dir):
    root = Path(event_dir)
    return {
        "analysis_input": next((str(path) for path in root.glob("*_分析输入.md")), ""),
        "gpt_input": next((str(path) for path in root.glob("*_gptInput.json")), ""),
        "basic_info": next((str(path) for path in root.glob("*_基础信息.json")), ""),
    }


def main(argv=None):
    args = parse_args(argv)
    context = load_event_context(args)
    if not (args.event_context_json or args.event_context_file):
        context = enrich_event_context(args.event_id, context)
    archive_root = Path(resolve_archive_root(args.output)).resolve()
    archive_root.mkdir(parents=True, exist_ok=True)
    staging_root = Path(os.environ.get("SKILL_OUTPUT_DIR") or tempfile.gettempdir()) / "mssp-event-push-content" / "rawlog"
    staging_root.mkdir(parents=True, exist_ok=True)
    rawlog_path = staging_root / f"gptrawlog_cgid_{safe_part(args.cgid)}.json"

    run_process(build_query_command(args, rawlog_path), "查询最新 GPTRawLog")
    if not rawlog_path.is_file() or rawlog_path.stat().st_size == 0:
        raise RuntimeError("未取得可保存的 GPTRawLog")

    requested_dir = args.event_dir or derive_event_dir(context, args.event_id)
    event_dir_name = unique_event_dir(archive_root, requested_dir)
    parse_command = [
        sys.executable,
        str(SCRIPTS_DIR / "parse_gptrawlog.py"),
        str(rawlog_path),
        "--cgid",
        args.cgid,
        "--event-dir",
        event_dir_name,
        "-o",
        str(archive_root),
    ]
    run_process(parse_command, "解析 GPTRawLog")
    event_dir = archive_root / event_dir_name
    context_path = write_event_context(event_dir, context)
    result = {
        "status": "ready_for_analysis",
        "event_id": args.event_id,
        "cgid": args.cgid,
        "event_dir": str(event_dir),
        "rawlog_file": str(event_dir / rawlog_path.name),
        "event_context": str(context_path) if context_path else "",
        **find_outputs(event_dir),
        "analysis_rule": "后续研判只读取解析子文件和事件上下文，不读取完整 GPTRawLog",
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, RuntimeError, json.JSONDecodeError) as exc:
        print(f"错误: {exc}", file=sys.stderr)
        sys.exit(1)
