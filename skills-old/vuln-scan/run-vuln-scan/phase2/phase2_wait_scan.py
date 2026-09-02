#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Phase 2: Poll scan completion"""

import os
import sys
import json
import time
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared import (
    log,
    DEFAULT_HEADERS,
    TASK_LIST_URL,
    request_with_retry,
    send_notification,
)

POLL_INTERVAL = 10               # 秒
MAX_WAIT_MINUTES = 210           # task_name 匹配阶段超时 30 分钟，匹配后 status 轮询 180 分钟，合计最多 210 分钟
NOTIFY_EVERY_MINUTES = 10       # 每 10 分钟通知一次
NOTIFY_EVERY_COUNT = NOTIFY_EVERY_MINUTES * 60 // POLL_INTERVAL  # 60 次
FIRST_MATCH_TIMEOUT_MINUTES = 30  # task_name 匹配阶段超时（30分钟）
STATUS_POLL_TIMEOUT_MINUTES = 180  # status 轮询阶段超时（180分钟）


def phase2_wait_scan(cookie: str, task_name: str, company_id: str, company_name: str = "") -> Optional[str]:
    """
    轮询扫描任务，完整流程：
      1. task_name 匹配阶段（最多 30 分钟）
         - 用 keyword=task_name 搜索
         - 匹配到 → 进入 status 轮询阶段
         - 30 分钟内未匹配 → 退出
      2. status 轮询阶段（最多 150 分钟）
         - 匹配到后继续轮询
         - status=5 → 完成，返回 task_id
         - status=4 → 失败
         - 超时 → 退出
    """
    log("=" * 50, "INFO")
    log(f"Phase 2: 轮询扫描任务 (每 {POLL_INTERVAL}s)", "INFO")
    log(f"任务名称: {task_name}, 公司ID: {company_id}", "INFO")
    log("=" * 50, "INFO")

    send_notification("漏扫 Phase 2", "进行中", f"扫描任务已下发，开始轮询任务状态（任务: {task_name}）", company_name=company_name)

    headers = DEFAULT_HEADERS.copy()
    headers["Cookie"] = cookie

    first_task_seen_ts: Optional[float] = None  # task_name 首次出现时间
    status_poll_start_ts: Optional[float] = None  # status 轮询阶段开始时间

    # ===== 阶段1：task_name 匹配（最多 30 分钟） =====
    while True:
        elapsed_total = (time.time() - (first_task_seen_ts or time.time()))
        elapsed_minutes = int(elapsed_total // 60) if first_task_seen_ts else 0

        log(f"[task_name 匹配阶段] 第 {elapsed_minutes}min / {FIRST_MATCH_TIMEOUT_MINUTES}min 已等 {elapsed_minutes}min", "INFO")

        payload = {
            "order": "asc",
            "offset": 0,
            "limit": 10,
            "keyword": task_name,
            "task_type": 0,
            "status": [],
            "company_id": company_id
        }

        try:
            response = request_with_retry("POST", TASK_LIST_URL, headers=headers, json=payload)
            if response is None:
                time.sleep(POLL_INTERVAL)
                continue

            result = response.json()
            if result.get("code") != 0:
                time.sleep(POLL_INTERVAL)
                continue

            task_list = result.get("data", {}).get("list", [])
            task = next((t for t in task_list if t.get("task_name") == task_name), None)

            if task:
                log(f"[OK] 任务 '{task_name}' 已出现，进入 status 轮询阶段", "INFO")
                break  # 进入阶段2

            # 未匹配
            if first_task_seen_ts is None:
                first_task_seen_ts = time.time()
                log(f"  任务 '{task_name}' 暂未出现，已开始计时...", "INFO")
            else:
                elapsed_since_first = time.time() - first_task_seen_ts
                if elapsed_since_first >= FIRST_MATCH_TIMEOUT_MINUTES * 60:
                    log(f"[X ERROR] 任务 '{task_name}' 在 {FIRST_MATCH_TIMEOUT_MINUTES} 分钟内未出现，退出", "ERROR")
                    send_notification(
                        "漏扫任务未找到", "失败",
                        f"任务 '{task_name}' 在 {FIRST_MATCH_TIMEOUT_MINUTES} 分钟内未出现，请确认任务是否已创建",
                        company_name=company_name
                    )
                    return None

            time.sleep(POLL_INTERVAL)

        except Exception as e:
            log(f"  请求异常: {e}", "WARNING")
            time.sleep(POLL_INTERVAL)

    # ===== 阶段2：status 轮询（最多 180 分钟） =====
    status_poll_start_ts = time.time()
    max_status_polls = STATUS_POLL_TIMEOUT_MINUTES * 60 // POLL_INTERVAL  # 1080 次

    for i in range(max_status_polls):
        current_loop = i + 1
        elapsed_minutes = (current_loop - 1) * POLL_INTERVAL // 60
        remaining_minutes = (max_status_polls - current_loop + 1) * POLL_INTERVAL // 60

        # 每 10 分钟发送一次进度通知
        if current_loop > 1 and (current_loop - 1) % NOTIFY_EVERY_COUNT == 0:
            # 先拉一次当前任务状态获取进度信息
            notify_msg = f"漏扫扫描中，已等待 {elapsed_minutes} 分钟，还需约 {remaining_minutes} 分钟"
            try:
                probe_resp = request_with_retry("POST", TASK_LIST_URL, headers=headers, json=payload)
                if probe_resp:
                    probe_result = probe_resp.json()
                    if probe_result.get("code") == 0:
                        probe_list = probe_result.get("data", {}).get("list", [])
                        probe_task = next((t for t in probe_list if t.get("task_name") == task_name), None)
                        if probe_task:
                            cur_status = probe_task.get("status")
                            cur_progress = probe_task.get("scan_progress", 0)
                            cur_vuln_total = probe_task.get("vuln_total", 0) or 0
                            cur_vuln_done = probe_task.get("vuln_ok", 0) or 0
                            cur_status_map = {0: "等待中", 1: "运行中", 2: "运行中", 3: "运行中", 4: "失败", 5: "已完成"}
                            cur_status_text = cur_status_map.get(cur_status, f"未知({cur_status})") if cur_status is not None else "未知"
                            notify_msg += f"\n状态：{cur_status_text}（进度 {cur_progress}%）"
                            if cur_vuln_total > 0:
                                notify_msg += f"\n漏洞：{cur_vuln_done}/{cur_vuln_total}"
            except Exception:
                pass
            log(f"  [NOTIFY] {notify_msg}", "INFO")
            try:
                send_notification("漏扫扫描", "进行中", notify_msg, company_name=company_name)
            except Exception:
                pass

        log(f"[status 轮询阶段] 第 {current_loop}/{max_status_polls} 次 (已等 {elapsed_minutes}min, 剩余约 {remaining_minutes}min)", "INFO")

        payload = {
            "order": "asc",
            "offset": 0,
            "limit": 10,
            "keyword": task_name,
            "task_type": 0,
            "status": [],
            "company_id": company_id
        }

        try:
            response = request_with_retry("POST", TASK_LIST_URL, headers=headers, json=payload)
            if response is None:
                time.sleep(POLL_INTERVAL)
                continue

            result = response.json()
            if result.get("code") != 0:
                time.sleep(POLL_INTERVAL)
                continue

            task_list = result.get("data", {}).get("list", [])
            task = next((t for t in task_list if t.get("task_name") == task_name), None)

            if not task:
                log(f"  任务丢失，等待 {POLL_INTERVAL}s...", "WARNING")
                time.sleep(POLL_INTERVAL)
                continue

            status = task.get("status")
            progress = task.get("scan_progress", 0)

            status_map = {
                0: "等待中",
                1: "运行中",
                2: "运行中",
                3: "运行中",
                4: "失败",
                5: "已完成"
            }
            status_text = status_map.get(status, f"未知({status})")
            log(f"  任务状态: status={status} ({status_text}), 进度={progress}%", "INFO")

            if status == 5:
                task_id = task.get("task_id")
                log(f"[OK] 扫描任务已完成！task_id={task_id}", "INFO")
                send_notification("漏扫扫描", "成功", f"扫描任务已完成（task_id={task_id}），接下来执行漏洞审核和导出报告", company_name=company_name)
                return task_id
            elif status == 4:
                fail_reason = task.get("fail_reason", "Unknown")
                log(f"[X ERROR] 扫描失败: {fail_reason}", "ERROR")
                send_notification("漏扫扫描", "失败", f"扫描任务失败: {fail_reason}", company_name=company_name)
                return None

            log(f"  扫描进行中，等待 {POLL_INTERVAL}s...", "INFO")
            time.sleep(POLL_INTERVAL)

        except Exception as e:
            log(f"  请求异常: {e}", "WARNING")
            time.sleep(POLL_INTERVAL)

    # status 轮询超时
    log(f"[X ERROR] status 轮询超过 {STATUS_POLL_TIMEOUT_MINUTES} 分钟，扫描未完成", "ERROR")
    return None