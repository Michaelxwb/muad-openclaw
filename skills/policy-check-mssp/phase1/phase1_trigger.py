#!/usr/bin/env python3
"""Phase 1 short-task entrypoint: resolve the company and distribute one task."""

import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, Optional, Tuple

SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SKILL_ROOT not in sys.path:
    sys.path.insert(0, SKILL_ROOT)

from phase1.get_dev_id import get_dev_id_list
from phase1.phase1_company import MultipleCandidatesError, resolve_by_selection, resolve_company
from phase1.policy_check_task import distribute_policy_check_task
from shared import (
    ActiveRunError,
    RunLock,
    emit_json,
    finish_step,
    get_session,
    latest_status,
    new_run,
    read_state,
    update_state,
)


MAX_BATCH_WORKERS = 8


def _resolve_input(cookie: str, company: Optional[str], company_id: Optional[str],
                   selection: Optional[str]) -> Tuple[str, str]:
    if selection:
        return resolve_by_selection(selection)
    if company_id:
        return str(company_id), str(company_id)
    if company:
        return resolve_company(company, cookie)
    raise ValueError("请指定 --company、--company-id 或 --select")


def _device_counts(devices) -> Dict[str, int]:
    counts = {"AF": 0, "SIP": 0, "EDR": 0, "STA": 0}
    for device in devices:
        device_type = str(device.get("dev_type", "")).upper()
        if device_type in counts:
            counts[device_type] += 1
    return counts


def _distributed_identity(result: Dict) -> str:
    data = result.get("data", {}) if isinstance(result, dict) else {}
    if not isinstance(data, dict):
        return ""
    return str(data.get("_id") or data.get("task_id") or data.get("task_name") or "")


def _ensure_no_active_business_task(cookie: str, state: Optional[Dict],
                                    company_id: str) -> None:
    guarded_statuses = {"preparing", "submitted", "not_found", "running", "failed"}
    if not state or state.get("status") not in guarded_statuses:
        return
    if not state.get("company_id") or (
        not state.get("task_id") and "baseline_task_ids" not in state
    ):
        return
    from phase2.phase2_wait_check import query_once
    result = query_once(
        cookie, str(state.get("company_id") or ""),
        state.get("baseline_task_ids", []), str(state.get("task_id") or ""),
    )
    update_state(company_id, status=result["status"], **{
        key: value for key, value in result.items() if key != "status"
    })
    if result["status"] == "running":
        raise RuntimeError("最新一次 MSSP 策略检查仍在运行，请先查询状态或等待完成")


def execute(company: Optional[str] = None, company_id: Optional[str] = None,
            selection: Optional[str] = None, session=None) -> Dict:
    requested = company or company_id or selection or ""
    cookie = session or get_session()
    name, resolved_id = _resolve_input(cookie, company, company_id, selection)
    with RunLock(resolved_id):
        previous = read_state(resolved_id)
        run = None
        try:
            _ensure_no_active_business_task(cookie, previous, resolved_id)
            run = new_run(str(requested), resolved_id)
            update_state(resolved_id, company_name=name, company_id=resolved_id)
            dev_ids, devices = get_dev_id_list(cookie, resolved_id)
            from phase2.phase2_wait_check import snapshot_task_ids
            baseline_ids = snapshot_task_ids(cookie, resolved_id)
            update_state(resolved_id, dev_ids=dev_ids, baseline_task_ids=sorted(baseline_ids))
            distributed = distribute_policy_check_task(cookie, resolved_id, dev_ids)
            task_id = _distributed_identity(distributed)
            update_state(
                resolved_id,
                status="submitted", current_phase="phase1", task_id=task_id,
                task_name=str(distributed.get("data", {}).get("task_name") or "")
                if isinstance(distributed.get("data"), dict) else "",
            )
            finish_step(company_id=resolved_id)
            return {
                "ok": True, "workflow_id": run["workflow_id"], "status": "submitted",
                "company_name": name, "company_id": resolved_id,
                "device_counts": _device_counts(devices), "device_count": len(dev_ids),
                "task_id": task_id,
            }
        except MultipleCandidatesError as exc:
            update_state(resolved_id, status="awaiting_selection", candidates=exc.candidates)
            finish_step("failed", str(exc), resolved_id)
            raise
        except Exception as exc:
            if run is not None:
                update_state(resolved_id, status="failed")
            finish_step("failed", str(exc), resolved_id)
            raise


def _batch_values(raw: str) -> list:
    text = str(raw or "").strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return [str(item).strip() for item in parsed if str(item).strip()]
    except json.JSONDecodeError:
        pass
    return [item.strip() for item in text.replace("，", ",").split(",") if item.strip()]


def execute_batch(companies: list, company_ids: list,
                  max_workers: int = 4) -> Dict:
    targets = [("company", value) for value in companies]
    targets.extend(("company_id", value) for value in company_ids)
    if not targets:
        raise ValueError("批量下发至少需要一个客户名称或 company_id")
    results = [None] * len(targets)

    def submit_one(kind: str, value: str) -> Dict:
        return execute(**{kind: value})

    worker_count = min(max(1, max_workers), len(targets), MAX_BATCH_WORKERS)
    with ThreadPoolExecutor(max_workers=worker_count) as pool:
        futures = {
            pool.submit(submit_one, kind, value): (index, kind, value)
            for index, (kind, value) in enumerate(targets)
        }
        for future in as_completed(futures):
            index, kind, value = futures[future]
            try:
                results[index] = {"ok": True, "input_type": kind, "input": value,
                                  **future.result()}
            except MultipleCandidatesError as exc:
                results[index] = {
                    "ok": False, "input_type": kind, "input": value,
                    "error": str(exc), "candidates": exc.candidates,
                }
            except Exception as exc:
                results[index] = {
                    "ok": False, "input_type": kind, "input": value, "error": str(exc),
                }
    submitted = sum(1 for item in results if item["ok"])
    return {
        "ok": submitted == len(results), "total": len(results),
        "submitted": submitted, "failed": len(results) - submitted, "results": results,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Phase 1：下发老 MSSP 策略检查任务")
    parser.add_argument("--company", help="客户名称")
    parser.add_argument("--company-id", help="客户 ID")
    parser.add_argument("--select", help="上一轮候选编号或完整名称")
    parser.add_argument("--companies", help="批量客户名称，JSON 数组或逗号分隔")
    parser.add_argument("--company-ids", help="批量客户 ID，JSON 数组或逗号分隔")
    parser.add_argument("--max-workers", type=int, default=4, help="批量并发数，默认 4")
    return parser


def main() -> int:
    args = _parser().parse_args()
    try:
        if args.companies or args.company_ids:
            if args.select:
                raise ValueError("批量下发不支持 --select，请改用明确客户名称或 company_id")
            companies = _batch_values(args.companies)
            company_ids = _batch_values(args.company_ids)
            if args.company:
                companies.insert(0, args.company)
            if args.company_id:
                company_ids.insert(0, args.company_id)
            result = execute_batch(companies, company_ids, args.max_workers)
            emit_json(result, error=not result["ok"])
            return 0 if result["ok"] else 1
        emit_json(execute(args.company, args.company_id, args.select))
        return 0
    except ActiveRunError as exc:
        emit_json({"ok": False, "error": str(exc), "latest": exc.state}, error=True)
        return 3
    except MultipleCandidatesError as exc:
        emit_json({"ok": False, "error": str(exc), "candidates": exc.candidates}, error=True)
        return 2
    except Exception as exc:
        emit_json({"ok": False, "error": str(exc), "latest": latest_status()}, error=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
