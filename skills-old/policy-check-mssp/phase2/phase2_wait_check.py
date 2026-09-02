#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 2 — 轮询策略检查任务状态

流程：
  1. Sleep 1 分钟（等待任务在列表中可查）
  2. 查询任务列表，按 company_id 匹配第一个任务，提取 task_name
  3. 轮询该任务直到 assess_status == 40 且 report_status == "finish"
  4. 如果首次查到就满足条件，跳过轮询直接完成

API: POST https://soar.sangfor.com.cn/gateway/idps/order/v1/tools/task/get_list

每个关键步骤无论成功失败都会通过企微 webhook 通知。
"""

import sys
import os
import uuid
import time
import json
import subprocess
import warnings

warnings.filterwarnings('ignore', message='Unverified HTTPS request')

# ── 路径 ──
POLICY_CHECK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if POLICY_CHECK_ROOT not in sys.path:
    sys.path.insert(0, POLICY_CHECK_ROOT)

# 复用 vuln-scan shared
VULNSCAN = r"C:\Users\User\.openclaw\workspace\skills\vuln-scan\run-vuln-scan"
import importlib.util
_spec = importlib.util.spec_from_file_location(
    "vuln_shared", os.path.join(VULNSCAN, "shared", "__init__.py")
)
_vuln_shared = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_vuln_shared)
log = _vuln_shared.log
get_cookie = _vuln_shared.get_cookie
extract_cookie_value = _vuln_shared.extract_cookie_value

import requests

# API 端点
TASK_LIST_URL = "https://soar.sangfor.com.cn/gateway/idps/order/v1/tools/task/get_list"

# 参数
SLEEP_AFTER_PHASE1 = 60        # 阶段1完成后等待时间（秒）
TASK_MATCH_TIMEOUT = 30 * 60   # 任务首次匹配超时（30分钟）
POLL_INTERVAL = 10             # 轮询间隔（秒）
STATUS_POLL_TIMEOUT = 180 * 60 # 状态轮询总超时（180分钟）
PROGRESS_NOTIFY_INTERVAL = 10 * 60  # 进度通知间隔（10分钟）

def notify(step: str, status: str, detail: str = "", company_name: str = ""):
    """发送企微通知"""
    log(f"[通知] {step} | {status} | {detail}")
    try:
        from shared.notify import send_notification
        send_notification(step, status, detail, company_name=company_name)
    except Exception as e:
        log(f"通知发送失败: {e}", "WARN")


# ─────────────────────────────────────────────────────────────
# 工具
# ─────────────────────────────────────────────────────────────

def _get_today_tomorrow_ms() -> list:
    """返回今日和明日 00:00:00 的毫秒时间戳"""
    from datetime import datetime, timezone, timedelta

    tz = timezone(timedelta(hours=8))
    now = datetime.now(tz)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    tomorrow_start = today_start + timedelta(days=1)

    today_ms = int(today_start.timestamp() * 1000)
    tomorrow_ms = int(tomorrow_start.timestamp() * 1000)

    log(f"时间范围: [{today_ms}, {tomorrow_ms}]")
    return [today_ms, tomorrow_ms]


def _build_headers(cookie: str) -> dict:
    """构建浏览器标准 Headers"""
    return {
        "accept": "application/json, text/javascript, */*; q=0.01",
        "accept-encoding": "gzip, deflate, br, zstd",
        "accept-language": "zh-CN,zh;q=0.9",
        "cache-control": "no-cache",
        "content-type": "application/json",
        "cookie": cookie,
        "origin": "https://soar.sangfor.com.cn",
        "pragma": "no-cache",
        "priority": "u=1, i",
        "referer": "https://soar.sangfor.com.cn/index.html",
        "sec-ch-ua": '"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "timezone": "+08:00",
        "traceid": str(uuid.uuid4()),
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
        "x-csrftoken": extract_cookie_value(cookie, "csrf_token") or "",
        "x-requested-with": "XMLHttpRequest",
    }


def _parse_status(assess_status) -> str:
    """解析任务状态码为可读文本"""
    status_map = {
        40: "完成",
    }
    return status_map.get(assess_status, f"状态码:{assess_status}")


def _is_finished(task: dict) -> bool:
    """判断任务是否完成：assess_status == 40 且 report_status == 'finish'"""
    return task.get("assess_status") == 40 and task.get("report_status") == "finish"


def query_task_list(cookie: str, keyword: str = "策略检查") -> dict:
    """查询任务列表，返回 API JSON"""
    headers = _build_headers(cookie)
    assess_time = _get_today_tomorrow_ms()

    payload = {
        "order": "asc",
        "offset": 0,
        "limit": 100,
        "keyword": keyword,
        "assess_status": [],
        "assess_time": assess_time,
    }

    response = requests.post(TASK_LIST_URL, headers=headers, json=payload, timeout=30, verify=False)
    if response is None:
        raise RuntimeError("请求返回为空")
    result = response.json()
    if result.get("code") != 0:
        raise RuntimeError(f"API 返回错误: {result.get('msg', result)}")
    return result


def find_task_by_company_id(task_list: list, company_id: str) -> dict:
    """在任务列表中按 company_id 匹配第一个元素"""
    for t in task_list:
        if str(t.get("company_id", "")) == str(company_id):
            return t
    return None


# ─────────────────────────────────────────────────────────────
# Phase 2 主流程
# ─────────────────────────────────────────────────────────────

def run_phase2(cookie: str, company_id: str, company_name: str = ""):
    """
    Phase 2 完整流程：
      1. Sleep 1min
      2. 查询任务列表 → 按 company_id 取第一个 → 提取 task_name
      3. 如果 assess_status == 40 且 report_status == "finish" → 直接完成
      4. 否则轮询直到条件满足
    """
    label = f"「{company_name}」(company_id={company_id})" if company_name else f"company_id={company_id}"

    # ═══════════════════════════════════════════
    # Step 0: Sleep 1min
    # ═══════════════════════════════════════════
    log(f"[Step 0] 等待 {SLEEP_AFTER_PHASE1}s（等待任务在列表中可查）...")
    time.sleep(SLEEP_AFTER_PHASE1)
    log("[Step 0] 等待结束")

    # ═══════════════════════════════════════════
    # Step 1: 查询任务列表 → 匹配 task
    # ═══════════════════════════════════════════
    log(f"[Step 1] 查询任务列表，按 company_id={company_id} 匹配...")
    notify("2-1", "轮询中", f"正在查询 {label} 的策略检查任务...", company_name)

    task = None
    start_time = time.time()

    while time.time() - start_time < TASK_MATCH_TIMEOUT:
        try:
            result = query_task_list(cookie, keyword="策略检查")
            task_list = result.get("data", {}).get("list", [])
            total = result.get("data", {}).get("total", 0)
            log(f"  任务列表: total={total}, 当前页 {len(task_list)} 条")

            task = find_task_by_company_id(task_list, company_id)
            if task:
                task_name = task.get("task_name", "")
                assess_status = task.get("assess_status")
                assess_fraction = task.get("assess_fraction", "?/?")
                report_status = task.get("report_status", "unknown")
                log(f"  匹配到任务: {task_name}, assess_status={assess_status}, report_status={report_status}, 进度={assess_fraction}")
                break

            log(f"  未匹配到 company_id={company_id} 的任务, {POLL_INTERVAL}s 后重试...")
        except Exception as e:
            log(f"  查询异常: {e}, {POLL_INTERVAL}s 后重试...")

        time.sleep(POLL_INTERVAL)

    if task is None:
        msg = f"未匹配到 {label} 的策略检查任务（已等待 {TASK_MATCH_TIMEOUT}s）"
        notify("2-1", "失败", msg, company_name)
        raise RuntimeError(msg)

    task_name = task.get("task_name", "")
    assess_status = task.get("assess_status")
    assess_fraction = task.get("assess_fraction", "?/?")
    report_status = task.get("report_status", "unknown")

    detail = f"task_name={task_name}, assess_status={assess_status}, report_status={report_status}, 进度={assess_fraction}"
    notify("2-1", "已匹配", detail, company_name)
    log(f"[Step 1 OK] {detail}")

    # ═══════════════════════════════════════════
    # Step 2: 检查是否已完成 / 轮询等待完成
    # ═══════════════════════════════════════════

    if _is_finished(task):
        log(f"[Step 2] 任务已完成（assess_status=40, report_status=finish），无需轮询")
        detail = f"task_name={task_name}, 首次查询即已完成"
        notify("2-2", "已完成", detail, company_name)
        return task_name, task

    log(f"[Step 2] 开始轮询等待完成（需要 assess_status=40 且 report_status=finish）, 当前 assess_status={assess_status}, report_status={report_status}")
    notify("2-2", "轮询中", f"task_name={task_name}, assess_status={assess_status}, report_status={report_status}, 进度={assess_fraction}", company_name)

    phase_start = time.time()
    last_notify_time = time.time()

    while time.time() - phase_start < STATUS_POLL_TIMEOUT:
        try:
            result = query_task_list(cookie, keyword="策略检查")
            task_list = result.get("data", {}).get("list", [])
            task = find_task_by_company_id(task_list, company_id)

            if not task:
                log(f"  任务不在列表中, {POLL_INTERVAL}s 后重试...")
                time.sleep(POLL_INTERVAL)
                continue

            assess_status = task.get("assess_status")
            assess_fraction = task.get("assess_fraction", "?/?")
            report_status = task.get("report_status", "unknown")

            log(f"  状态: assess_status={assess_status}, report_status={report_status}, 进度: {assess_fraction}")

            if _is_finished(task):
                elapsed_min = (time.time() - phase_start) / 60
                detail = f"task_name={task_name}, assess_status=40, report_status=finish, 进度={assess_fraction}, 总轮询 {elapsed_min:.0f}min"
                notify("2-2", "已完成", detail, company_name)
                log(f"[Step 2 OK] 任务完成")
                return task_name, task

            # 定期通知进度
            now = time.time()
            if now - last_notify_time >= PROGRESS_NOTIFY_INTERVAL:
                elapsed_min = (now - phase_start) / 60
                notify("2-2", "轮询中", f"task_name={task_name}, assess_status={assess_status}, report_status={report_status}, 进度={assess_fraction}, 已等待 {elapsed_min:.0f}min", company_name)
                last_notify_time = now

        except Exception as e:
            log(f"  轮询异常: {e}, {POLL_INTERVAL}s 后重试...")

        time.sleep(POLL_INTERVAL)

    msg = f"task_name={task_name} 未在 {STATUS_POLL_TIMEOUT}s 内完成"
    notify("2-2", "超时", msg, company_name)
    raise RuntimeError(msg)


# ─────────────────────────────────────────────────────────────
# 入口
# ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="轮询策略检查任务状态")
    parser.add_argument("--company-id", required=True, help="公司 ID")
    parser.add_argument("--company-name", default="", help="公司名（通知用）")
    parser.add_argument("-c", "--cookie", type=str, default=None, help="Cookie 字符串")
    args = parser.parse_args()

    cookie = args.cookie or get_cookie()
    if not cookie:
        log("请提供 Cookie", "ERROR")
        sys.exit(1)

    try:
        task_name, task = run_phase2(cookie, args.company_id, args.company_name)
        print(f"\n 策略检查完成")
        print(f"   task_name: {task_name}")
        print(f"   _id: {task.get('_id')}")
        print(f"   assess_status: {task.get('assess_status')}")
        print(f"   report_status: {task.get('report_status')}")
        print(f"   assess_fraction: {task.get('assess_fraction')}")
    except Exception as e:
        print(f"\n Phase 2 失败: {e}")
        sys.exit(1)
