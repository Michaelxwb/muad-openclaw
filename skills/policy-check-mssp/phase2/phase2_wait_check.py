#!/usr/bin/env python3
"""Phase 2 short task: query the latest MSSP policy-check status once."""

import argparse
import os
import sys
from datetime import datetime, timedelta, timezone
from typing import Dict, Iterable, Optional, Set

SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SKILL_ROOT not in sys.path:
    sys.path.insert(0, SKILL_ROOT)

from shared import (
    ActiveRunError,
    RunLock,
    begin_step,
    emit_json,
    finish_step,
    get_session,
    latest_status,
    read_state,
    request_json,
    update_state,
)


FAILURE_ASSESS_STATUSES = {30}
FAILURE_REPORT_STATUSES = {"fail", "failed", "error"}


def _get_today_tomorrow_ms(now: Optional[datetime] = None) -> list:
    tz = timezone(timedelta(hours=8))
    current = now.astimezone(tz) if now else datetime.now(tz)
    today = current.replace(hour=0, minute=0, second=0, microsecond=0)
    return [int(today.timestamp() * 1000), int((today + timedelta(days=1)).timestamp() * 1000)]


def query_task_list(cookie: str, keyword: str = "策略检查") -> Dict:
    payload = {
        "order": "asc", "offset": 0, "limit": 100, "keyword": keyword,
        "assess_status": [], "assess_time": _get_today_tomorrow_ms(),
    }
    return request_json(cookie, "POST", "task_list", payload)


def _tasks(result: Dict) -> list:
    tasks = result.get("data", {}).get("list", [])
    return tasks if isinstance(tasks, list) else []


def task_identity(task: Dict) -> str:
    return str(task.get("_id") or task.get("task_id") or task.get("task_name") or "")


def snapshot_task_ids(cookie: str, company_id: str) -> Set[str]:
    return {
        task_identity(task) for task in _tasks(query_task_list(cookie))
        if str(task.get("company_id", "")) == str(company_id) and task_identity(task)
    }


def find_new_task(tasks: Iterable[Dict], company_id: str,
                  baseline_ids: Set[str]) -> Optional[Dict]:
    for task in tasks:
        identity = task_identity(task)
        if str(task.get("company_id", "")) == str(company_id) and identity not in baseline_ids:
            return task
    return None


def find_task(tasks: Iterable[Dict], identity: str) -> Optional[Dict]:
    return next((task for task in tasks if task_identity(task) == str(identity)), None)


def classify_task(task: Dict) -> str:
    if task.get("assess_status") == 40 and task.get("report_status") == "finish":
        return "completed"
    report_status = str(task.get("report_status") or "").lower()
    if task.get("assess_status") in FAILURE_ASSESS_STATUSES or report_status in FAILURE_REPORT_STATUSES:
        return "failed"
    return "running"


def _task_result(task: Dict) -> Dict:
    return {
        "status": classify_task(task), "task_id": task_identity(task),
        "task_name": str(task.get("task_name") or ""),
        "assess_status": task.get("assess_status"),
        "report_status": task.get("report_status"),
        "assess_fraction": task.get("assess_fraction", ""),
    }


def query_once(cookie: str, company_id: str, baseline_ids: Iterable[str],
               task_id: str = "") -> Dict:
    tasks = _tasks(query_task_list(cookie))
    task = find_task(tasks, task_id) if task_id else find_new_task(
        tasks, company_id, set(baseline_ids),
    )
    if not task:
        return {"status": "not_found", "task_id": task_id, "task_name": ""}
    return _task_result(task)


def run_phase2(company_id: str = "", task_id: str = "") -> Dict:
    latest = read_state() or {}
    resolved_company = str(company_id or latest.get("company_id") or "")
    if not resolved_company:
        raise ValueError("缺少 company_id，请先执行 Phase 1 或显式传入")
    with RunLock(resolved_company):
        begin_step("phase2", resolved_company)
        try:
            state = read_state(resolved_company) or {}
            resolved_task = str(task_id or state.get("task_id") or "")
            result = query_once(
                get_session(), resolved_company, state.get("baseline_task_ids", []), resolved_task,
            )
            update_state(
                resolved_company,
                status=result["status"], company_id=resolved_company,
                task_id=result.get("task_id", ""), task_name=result.get("task_name", ""),
                assess_status=result.get("assess_status"),
                report_status=result.get("report_status"),
                assess_fraction=result.get("assess_fraction", ""),
            )
            finish_step(company_id=resolved_company)
            return {"ok": True, **result, "company_id": resolved_company}
        except Exception as exc:
            finish_step("failed", str(exc), resolved_company)
            raise


def main() -> int:
    parser = argparse.ArgumentParser(description="Phase 2：单次查询 MSSP 策略检查状态")
    parser.add_argument("--latest", action="store_true", help="兼容参数：查询最新业务任务")
    parser.add_argument("--local", action="store_true", help="只读取本地保存的最新状态")
    parser.add_argument("--company-id")
    parser.add_argument("--task-id")
    args = parser.parse_args()
    try:
        result = {"ok": True, "latest": latest_status(args.company_id or "")} if args.local else run_phase2(
            args.company_id or "", args.task_id or "",
        )
        emit_json(result)
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
