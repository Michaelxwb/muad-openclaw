#!/usr/bin/env python3
"""Phase 4: preserve legacy MSSP filtering and generate the final chat message."""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple

SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SKILL_ROOT not in sys.path:
    sys.path.insert(0, SKILL_ROOT)

from shared import (
    ActiveRunError,
    RunLock,
    atomic_write_json,
    atomic_write_text,
    begin_step,
    emit_json,
    finish_step,
    get_session,
    latest_status,
    read_state,
    reports_dir,
    request_json,
    update_state,
)


def _get_time_range(now: Optional[datetime] = None) -> Tuple[str, str]:
    tz = timezone(timedelta(hours=8))
    current = now.astimezone(tz) if now else datetime.now(tz)
    today = current.replace(hour=0, minute=0, second=0, microsecond=0)
    yesterday = today - timedelta(days=1)
    tomorrow = today + timedelta(days=1)
    return yesterday.strftime("%Y-%m-%d %H:%M:%S"), tomorrow.strftime("%Y-%m-%d %H:%M:%S")


def _parse_latest_time(item: Dict) -> Optional[str]:
    value = item.get("latest_time")
    if isinstance(value, list):
        value = value[0] if value else None
    return str(value) if value else None


def _normalized_item(item: Dict) -> Dict:
    return {
        "dev_name": item.get("dev_name", ""),
        "dev_type": item.get("dev_type", ""),
        "description": item.get("description", ""),
        "policy_status": item.get("policy_status", ""),
        "name": item.get("name", ""),
    }


def fetch_policy_results(cookie: str, company_id: str, dev_id_list: list,
                         now: Optional[datetime] = None) -> List[Dict]:
    yesterday, tomorrow = _get_time_range(now)
    results, seen, offset, limit = [], set(), 0, 100
    while True:
        payload = {
            "order": {"latest_time": "desc"}, "offset": offset, "limit": limit,
            "company_id": company_id, "dev_id": dev_id_list, "status": "at_risk",
        }
        data = request_json(cookie, "POST", "policy_list", payload).get("data", {})
        page = data.get("list", []) if isinstance(data.get("list", []), list) else []
        for item in page:
            latest = _parse_latest_time(item)
            key = (item.get("dev_name", ""), item.get("name", ""), item.get("policy_status", ""))
            if latest and yesterday <= latest < tomorrow and key not in seen:
                seen.add(key)
                results.append(_normalized_item(item))
        total = data.get("total", 0)
        if len(page) < limit or not isinstance(total, int) or offset + limit >= total:
            break
        offset += limit
    return results


def _failed_section(items: List[Dict]) -> List[str]:
    lines = [f"策略获取失败共{len(items)}条"]
    if items:
        lines[0] += "，包含："
        lines.extend(f"{index}. {item.get('dev_name') or '未知设备'} --> {item.get('name') or '未知策略'}"
                     for index, item in enumerate(items, 1))
    return lines


def _expired_section(items: List[Dict]) -> List[str]:
    lines = [f"授权过期或未开通共{len(items)}条"]
    if items:
        lines[0] += "，包含："
        lines.extend(
            f"{index}. {item.get('dev_name') or '未知设备'} --> "
            f"{item.get('name') or '未知策略'} --> {item.get('policy_status', '')}"
            for index, item in enumerate(items, 1)
        )
    return lines


def _summary_section(items: List[Dict]) -> Tuple[List[str], Dict[str, int]]:
    devices = {item.get("dev_name") for item in items if item.get("dev_name")}
    lines = [f"本次评估共检查 {len(devices)} 个设备，存在部分可调优项，分别为以下策略："]
    grouped: Dict[str, List[Dict]] = {}
    for item in items:
        grouped.setdefault(str(item.get("dev_type") or "未知"), []).append(item)
    for device_type in sorted(grouped):
        lines.extend(["", device_type])
        for index, item in enumerate(grouped[device_type], 1):
            lines.append(f"{index}、【{item.get('dev_name') or '未知设备'}】{str(item.get('description') or '').strip()}")
    return lines, {key: len(value) for key, value in sorted(grouped.items())}


def _artifact_name(value: str) -> str:
    return re.sub(r'[^0-9A-Za-z_.\-\u4e00-\u9fff]', "_", value)[:120] or "mssp"


def generate_policy_message(cookie: str, company_id: str, dev_id_list: list,
                            task_name: str = "", company_name: str = "") -> Dict:
    results = fetch_policy_results(cookie, company_id, dev_id_list)
    failed = [item for item in results if item.get("policy_status") == "策略获取失败"]
    others = [item for item in results if item.get("policy_status") != "策略获取失败"]
    expired = [item for item in results if "已过期" in str(item.get("policy_status"))
               or "授权未开通" in str(item.get("policy_status"))]
    summary_lines, groups = _summary_section(others)
    prefix = f"【策略检查】【{company_name}】" if company_name else "【策略检查】"
    sections = [_failed_section(failed), _expired_section(expired), summary_lines]
    message = prefix + "\n" + "\n\n".join("\n".join(section) for section in sections)
    stem = _artifact_name(task_name or company_id)
    report_dir = reports_dir(company_id)
    message_path = os.path.join(report_dir, f"话术_{stem}.txt")
    results_path = os.path.join(report_dir, f"policy_results_{stem}.json")
    atomic_write_text(message_path, message)
    atomic_write_json(results_path, results)
    summary = {
        "risk_count": len(results), "failed_count": len(failed),
        "expired_count": len(expired), "tunable_count": len(others),
        "device_count": len({item.get("dev_name") for item in others if item.get("dev_name")}),
        "groups": groups,
    }
    return {
        "summary": summary, "message": message, "message_path": message_path,
        "results_path": results_path, "results": results,
    }


def _parse_dev_ids(value: str) -> list:
    text = str(value or "").strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return parsed
    except json.JSONDecodeError:
        pass
    return [int(item.strip()) for item in text.split(",") if item.strip()]


def run_phase4(company_id: str = "", dev_ids: Optional[list] = None,
               task_name: str = "", company_name: str = "") -> Dict:
    latest = read_state() or {}
    resolved_company = str(company_id or latest.get("company_id") or "")
    if not resolved_company:
        raise ValueError("缺少 company_id，请先执行 Phase 1 或显式传入")
    with RunLock(resolved_company):
        begin_step("phase4", resolved_company)
        try:
            state = read_state(resolved_company) or {}
            resolved_devices = dev_ids if dev_ids is not None else state.get("dev_ids", [])
            resolved_task = str(task_name or state.get("task_name") or "")
            resolved_name = str(company_name or state.get("company_name") or "")
            if not resolved_company or not resolved_devices:
                raise ValueError("缺少 company_id 或 dev_ids，请先执行 Phase 1 或显式传入")
            result = generate_policy_message(
                get_session(), resolved_company, resolved_devices, resolved_task, resolved_name,
            )
            update_state(
                resolved_company,
                current_phase="phase4", company_id=resolved_company,
                task_name=resolved_task, message_path=result["message_path"],
                results_path=result["results_path"], result_summary=result["summary"],
                message_generated=True,
            )
            finish_step(company_id=resolved_company)
            return {"ok": True, **{key: value for key, value in result.items() if key != "results"}}
        except Exception as exc:
            finish_step("failed", str(exc), resolved_company)
            raise


def main() -> int:
    parser = argparse.ArgumentParser(description="Phase 4：单独生成 MSSP 策略检查话术")
    parser.add_argument("--company-id")
    parser.add_argument("--dev-ids", help="JSON 数组或逗号分隔设备 ID")
    parser.add_argument("--task-name", default="")
    parser.add_argument("--company-name", default="")
    args = parser.parse_args()
    try:
        devices = _parse_dev_ids(args.dev_ids) if args.dev_ids is not None else None
        emit_json(run_phase4(
            args.company_id or "", devices, args.task_name, args.company_name,
        ))
        return 0
    except ActiveRunError as exc:
        emit_json({"ok": False, "error": str(exc), "latest": exc.state}, error=True)
        return 3
    except Exception as exc:
        emit_json({"ok": False, "error": str(exc),
                   "latest": latest_status(args.company_id or "")}, error=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
