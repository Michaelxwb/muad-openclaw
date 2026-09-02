#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 2 - 轮询资产发现任务是否完成

输入任务名称，提取 task_id，轮询判断任务是否完成（status=5），直到完成才返回。
轮询参数：每 10 秒一次，最多 1080 次（约 3 小时），每 10 分钟通知一次进度。
"""
import os
import sys
import json
import time
import uuid
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from shared import (
    log,
    DEFAULT_HEADERS,
    request_with_retry,
    send_notification,
    POLL_INTERVAL,
    MAX_POLL_COUNT,
)


TASK_LIST_URL = "https://soar.sangfor.com.cn/gateway/vuln-manager/vm/order/v1/vulnmgr/task/task-list"
MAX_WAIT_MINUTES = 180          # 最大等待 180 分钟（3小时）
FIRST_MATCH_TIMEOUT_MINUTES = 30  # 任务首次匹配超时（30分钟）
NOTIFY_EVERY_MINUTES = 10       # 每 10 分钟通知一次
MAX_POLL_COUNT = MAX_WAIT_MINUTES * 60 // POLL_INTERVAL  # 1080 次
NOTIFY_EVERY_COUNT = NOTIFY_EVERY_MINUTES * 60 // POLL_INTERVAL  # 60 次


def poll_asset_discovery_task(
    cookie: str,
    task_name: str,
    company_id: str,
    company_name: str = ""
) -> Optional[str]:
    """
    轮询资产发现任务，直到完成。

    Args:
        cookie: Cookie 字符串
        task_name: 任务名称
        company_id: 公司ID
        company_name: 客户名称

    Returns:
        task_id（完成时）或 None（失败/超时）
    """
    log("=" * 50, "INFO")
    log(f"Phase 2: 轮询资产发现任务 (每 {POLL_INTERVAL}s 一次, 最多 {MAX_WAIT_MINUTES}min)", "INFO")
    log(f"任务名称: {task_name}, 公司ID: {company_id}", "INFO")
    log("=" * 50, "INFO")

    headers = DEFAULT_HEADERS.copy()
    headers["Cookie"] = cookie
    headers["X-Csrftoken"] = ""
    headers["Traceid"] = str(uuid.uuid4())

    first_task_seen_ts: Optional[float] = None

    for i in range(MAX_POLL_COUNT):
        current_loop = i + 1
        elapsed_minutes = (current_loop - 1) * POLL_INTERVAL // 60
        remaining_minutes = (MAX_POLL_COUNT - current_loop + 1) * POLL_INTERVAL // 60

        # 每 10 分钟发送一次进度通知
        if current_loop > 1 and (current_loop - 1) % NOTIFY_EVERY_COUNT == 0:
            # 先拉一次当前任务状态获取进度信息
            notify_msg = f"资产发现扫描中，已等待 {elapsed_minutes} 分钟，还需约 {remaining_minutes} 分钟"
            try:
                probe_resp = request_with_retry("POST", TASK_LIST_URL, headers=headers, json=payload)
                if probe_resp:
                    probe_result = probe_resp.json()
                    if probe_result.get("code") == 0:
                        probe_list = probe_result.get("data", {}).get("list", [])
                        probe_task = next((t for t in probe_list if t.get("task_name") == task_name), None)
                        if probe_task:
                            cur_status = probe_task.get("status")
                            cur_progress = probe_task.get("progress", 0) or probe_task.get("scan_progress", 0)
                            cur_found = probe_task.get("found_count", 0) or 0
                            cur_status_map = {0: "等待中", 1: "运行中", 2: "运行中", 3: "运行中", 4: "失败", 5: "已完成"}
                            cur_status_text = cur_status_map.get(cur_status, f"未知({cur_status})") if cur_status is not None else "未知"
                            notify_msg += f"\n状态：{cur_status_text}（进度 {cur_progress}%）"
                            if cur_found > 0:
                                notify_msg += f"\n发现资产：{cur_found}"
            except Exception:
                pass
            log(f"  [NOTIFY] {notify_msg}", "INFO")
            try:
                send_notification("资产发现轮询", "进行中", notify_msg, company_name=company_name)
            except Exception:
                pass

        log(f"========== 第 {current_loop}/{MAX_POLL_COUNT} 次轮询 (已等 {elapsed_minutes}min, 剩余约 {remaining_minutes}min) ==========", "INFO")

        payload = {
            "order": "asc",
            "offset": 0,
            "limit": 10,
            "keyword": task_name,
            "task_type": 0,
            "status": [],
            "company_id": company_id
        }

        log(f"  Payload: {json.dumps(payload, ensure_ascii=False)}", "INFO")

        try:
            response = request_with_retry("POST", TASK_LIST_URL, headers=headers, json=payload)

            if response is None:
                log(f"  X HTTP 请求失败，等待 {POLL_INTERVAL}s 后重试...", "ERROR")
                time.sleep(POLL_INTERVAL)
                continue

            try:
                result = response.json()
                log(f"  API response: code={result.get('code')}, msg={result.get('msg', '')}", "INFO")

                if result.get("code") != 0:
                    log(f"  API 错误: {result.get('msg', 'Unknown')}", "ERROR")
                    time.sleep(POLL_INTERVAL)
                    continue

                task_list = result.get("data", {}).get("list", [])
                if not task_list:
                    log(f"  任务列表为空，等待 {POLL_INTERVAL}s...", "INFO")
                    time.sleep(POLL_INTERVAL)
                    continue

                task = next((t for t in task_list if t.get("task_name") == task_name), None)

                if not task:
                    # 记录首次看到任务列表的时间，用于 30 分钟超时判断
                    if first_task_seen_ts is None:
                        first_task_seen_ts = time.time()
                        log(f"  任务 '{task_name}' 暂未出现，已开始计时，30 分钟内未出现则退出", "INFO")
                    else:
                        elapsed_since_first = time.time() - first_task_seen_ts
                        if elapsed_since_first >= FIRST_MATCH_TIMEOUT_MINUTES * 60:
                            log(f"[X ERROR] 任务 '{task_name}' 在 {FIRST_MATCH_TIMEOUT_MINUTES} 分钟内未出现，退出", "ERROR")
                            send_notification("资产发现任务未找到", "失败",
                                              f"任务 '{task_name}' 在 {FIRST_MATCH_TIMEOUT_MINUTES} 分钟内未出现，请确认任务是否已创建",
                                              company_name=company_name)
                            return None
                    log(f"  任务 '{task_name}' 未找到，等待 {POLL_INTERVAL}s...（已等 {int(elapsed_since_first // 60)}min）", "INFO")
                    time.sleep(POLL_INTERVAL)
                    continue

                # task_name 匹配上，重置计时
                first_task_seen_ts = None

                status = task.get("status")
                progress = task.get("progress", 0) or task.get("scan_progress", 0)
                found_count = task.get("found_count", 0)

                # status: 0=等待, 1=运行, 2=运行中, 3=运行中, 4=失败, 5=已完成
                status_map = {
                    0: "等待中",
                    1: "运行中",
                    2: "运行中",
                    3: "运行中",
                    4: "失败",
                    5: "已完成"
                }
                status_text = status_map.get(status, f"未知({status})")

                log(f"  任务状态: status={status} ({status_text}), 进度={progress}%, 发现资产={found_count}", "INFO")

                if status == 5:
                    task_id = task.get("task_id")
                    log(f"[OK] 资产发现任务已完成！task_id={task_id}", "INFO")
                    # 注：资产发现任务扫描完成的通知由 phase2_run_through.py Step 1 统一发送，此处不重复发送
                    return task_id
                elif status == 4:
                    fail_reason = task.get("fail_reason", "Unknown")
                    log(f"[X ERROR] 资产发现任务失败: {fail_reason}", "ERROR")
                    send_notification("资产发现任务失败", "失败", f"任务: {task_name}，原因: {fail_reason}", company_name=company_name)
                    return None
                else:
                    log(f"  扫描进行中...", "INFO")

                if current_loop == MAX_POLL_COUNT:
                    log(f"[X ERROR] 轮询超时（{MAX_WAIT_MINUTES}分钟），任务未完成", "ERROR")
                    send_notification("资产发现轮询超时", "失败", f"任务: {task_name}，超时 {MAX_WAIT_MINUTES}min", company_name=company_name)
                    return None

                log(f"  等待 {POLL_INTERVAL}s 后继续轮询...", "INFO")
                time.sleep(POLL_INTERVAL)

            except Exception as e:
                log(f"  JSON 解析异常: {e}", "WARNING")
                if current_loop == MAX_POLL_COUNT:
                    log(f"[X ERROR] 轮询超时", "ERROR")
                    return None
                log(f"  等待 {POLL_INTERVAL}s 后重试...", "INFO")
                time.sleep(POLL_INTERVAL)

        except Exception as e:
            log(f"  请求异常: {e}", "WARNING")
            if current_loop == MAX_POLL_COUNT:
                log(f"[X ERROR] 轮询超时", "ERROR")
                return None
            log(f"  等待 {POLL_INTERVAL}s 后重试...", "INFO")
            time.sleep(POLL_INTERVAL)

    log(f"[X ERROR] 轮询次数耗尽（{MAX_POLL_COUNT}次），任务未完成", "ERROR")
    return None


# =============================================================================
# 入口
# =============================================================================
def main():
    import argparse
    from phase1.phase1_prepare import resolve_company, resolve_company_by_id

    parser = argparse.ArgumentParser(description="轮询资产发现任务状态")
    parser.add_argument("--task-name", type=str, required=True, help="任务名称")
    parser.add_argument("--company", type=str, help="公司名称")
    parser.add_argument("--company-id", type=str, help="公司ID")
    args = parser.parse_args()

    from shared import get_cookie
    cookie = get_cookie()
    if not cookie:
        log("请提供 Cookie", "ERROR")
        sys.exit(1)

    # 解析公司
    if args.company_id:
        company_id = args.company_id
        company_name, _ = resolve_company_by_id(company_id, cookie)
    elif args.company:
        company_name, company_id = resolve_company(args.company, cookie)
    else:
        print("[X ERROR] 必须指定 --company 或 --company-id")
        sys.exit(1)

    log(f"[INFO] 开始轮询: {args.task_name} (company_id={company_id})", "INFO")

    task_id = poll_asset_discovery_task(cookie, args.task_name, company_id)

    if task_id:
        print(f"\n[OK] 任务完成，task_id={task_id}")
        sys.exit(0)
    else:
        print(f"\n[X ERROR] 任务轮询失败或超时")
        sys.exit(1)


if __name__ == "__main__":
    main()