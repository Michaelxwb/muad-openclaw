#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
漏洞复测 Phase 2：轮询任务状态，完成后发送企微群通知

与漏扫 Phase 2 的区别：
  - 关键字是 "漏洞复测"（非 task_name）
  - 从返回列表中按 start_time 最大的逻辑找到目标 task
  - 轮询该 task 的 status，完成即结束（不复测不做 Phase 3-5）

两种模式：
  - 立即执行（无定时）：spawn 后台进程，直接执行 _run_phase2
  - 定时执行：计算 delay，睡眠等待，然后执行 _run_phase2
"""
import sys, os, argparse, time, json, subprocess

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ─────────────────────────────────────────────────────────────
# 通知
# ─────────────────────────────────────────────────────────────
def _notify_impl(content, company_name=""):
    try:
        sys.path.insert(0, ROOT_DIR)
        from shared import send_notification
        # phase_name 不含"话术/报告/扫描执行成功"关键字，会自动加【复测】【客户名】前缀
        send_notification("漏洞复测Phase2", "进行中", content, company_name=company_name)
    except Exception as e:
        print(f"[WARNING] 通知失败: {e}", file=sys.stderr)


def notify_scan_start(task_name: str, task_id: str, company_name=""):
    _notify_impl(f"复测任务已找到，开始轮询扫描状态（任务: {task_name}）", company_name)

def notify_scan_complete(task_name: str, task_id: str, company_name=""):
    _notify_impl(f"✅ 复测扫描已完成（task_id={task_id}）", company_name)

def notify_scan_fail(task_name: str, reason: str, company_name=""):
    _notify_impl(f"❌ 复测失败：{reason}", company_name)

def notify_scan_progress(task_name: str, elapsed_minutes: int, status: int, progress: int, vuln_total: int = 0, vuln_done: int = 0, company_name=""):
    status_map = {0: "等待中", 1: "运行中", 2: "运行中", 3: "运行中", 4: "失败", 5: "已完成"}
    status_text = status_map.get(status, f"未知({status})")
    msg = f"⏳ 复测扫描进行中：已等待 {elapsed_minutes} 分钟"
    msg += f"\n状态：{status_text}（进度 {progress}%）"
    if vuln_total > 0:
        msg += f"\n漏洞：{vuln_done}/{vuln_total}"
    _notify_impl(msg, company_name)


# ─────────────────────────────────────────────────────────────
# Phase 2 核心轮询逻辑
# ─────────────────────────────────────────────────────────────
POLL_INTERVAL = 10
NOTIFY_EVERY_MINUTES = 10
NOTIFY_EVERY_COUNT = NOTIFY_EVERY_MINUTES * 60 // POLL_INTERVAL
FIRST_MATCH_TIMEOUT_MINUTES = 30
STATUS_POLL_TIMEOUT_MINUTES = 180


def find_retest_task(headers: dict, company_id: str):
    """
    调用 task-list API，keyword="漏洞复测"，遍历分页找到 start_time 最大的 task。
    返回 (task_name, task_id) 或 (None, None)。
    """
    from shared import TASK_LIST_URL, request_with_retry

    best_task = None
    best_start_time = None

    offset = 0
    limit = 100

    while True:
        payload = {
            "order": "asc",
            "offset": offset,
            "limit": limit,
            "keyword": "漏洞复测",
            "task_type": 0,
            "status": [],
            "company_id": company_id
        }

        try:
            resp = request_with_retry("POST", TASK_LIST_URL, headers=headers, json=payload)
            if resp is None:
                time.sleep(POLL_INTERVAL)
                continue

            result = resp.json()
            if result.get("code") != 0:
                time.sleep(POLL_INTERVAL)
                continue

            data = result.get("data", {})
            task_list = data.get("list", [])
            total = data.get("total", 0)

            for task in task_list:
                start_time = task.get("start_time")
                if start_time:
                    if best_start_time is None or start_time > best_start_time:
                        best_start_time = start_time
                        best_task = task

            if len(task_list) < limit:
                break
            offset += limit

        except Exception as e:
            print(f"[WARNING] 请求异常: {e}", file=sys.stderr)
            time.sleep(POLL_INTERVAL)
            continue

    if best_task:
        return best_task.get("task_name"), best_task.get("task_id")
    return None, None


def poll_task_status(headers: dict, task_name: str, company_id: str, company_name: str = ""):
    """
    轮询指定 task_name 的 status，直到完成（status=5）或失败（status=4）。
    返回 task_id（完成时）或 None（失败/超时）。
    """
    from shared import TASK_LIST_URL, request_with_retry

    first_task_seen_ts = None

    # ===== 阶段1：task_name 匹配（最多 30 分钟） =====
    while True:
        elapsed_total = time.time() - (first_task_seen_ts or time.time())
        elapsed_minutes = int(elapsed_total // 60) if first_task_seen_ts else 0

        print(f"[task_name匹配] 第 {elapsed_minutes}min / {FIRST_MATCH_TIMEOUT_MINUTES}min", flush=True)

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
            resp = request_with_retry("POST", TASK_LIST_URL, headers=headers, json=payload)
            if resp is None:
                time.sleep(POLL_INTERVAL)
                continue

            result = resp.json()
            if result.get("code") != 0:
                time.sleep(POLL_INTERVAL)
                continue

            task_list = result.get("data", {}).get("list", [])
            task = next((t for t in task_list if t.get("task_name") == task_name), None)

            if task:
                print(f"[OK] 任务 '{task_name}' 已出现，进入 status 轮询", flush=True)
                task_id = task.get("task_id")
                break

            if first_task_seen_ts is None:
                first_task_seen_ts = time.time()
                print(f"  任务暂未出现，已开始计时...", flush=True)
            else:
                elapsed_since_first = time.time() - first_task_seen_ts
                if elapsed_since_first >= FIRST_MATCH_TIMEOUT_MINUTES * 60:
                    print(f"[X ERROR] 任务在 {FIRST_MATCH_TIMEOUT_MINUTES} 分钟内未出现", flush=True)
                    notify_scan_fail(task_name, f"在{FIRST_MATCH_TIMEOUT_MINUTES}分钟内未出现", company_name)
                    return None

            time.sleep(POLL_INTERVAL)

        except Exception as e:
            print(f"[WARNING] 请求异常: {e}", flush=True)
            time.sleep(POLL_INTERVAL)

    # ===== 阶段2：status 轮询（最多 180 分钟） =====
    notify_scan_start(task_name, "", company_name)
    max_polls = STATUS_POLL_TIMEOUT_MINUTES * 60 // POLL_INTERVAL

    for i in range(max_polls):
        current_loop = i + 1
        elapsed_minutes = (current_loop - 1) * POLL_INTERVAL // 60

        print(f"[status轮询] 第 {current_loop}/{max_polls} 次 (已等 {elapsed_minutes}min)", flush=True)

        if current_loop > 1 and (current_loop - 1) % NOTIFY_EVERY_COUNT == 0:
            print(f"  [NOTIFY] 漏洞复测扫描中，已等待 {elapsed_minutes} 分钟，请耐心等待", flush=True)
            try:
                vuln_total = task.get("vuln_total", 0) or 0
                vuln_done = task.get("vuln_ok", 0) or 0
                notify_scan_progress(task_name, elapsed_minutes, status, progress,
                                     vuln_total=vuln_total, vuln_done=vuln_done,
                                     company_name=company_name)
            except Exception:
                pass

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
            resp = request_with_retry("POST", TASK_LIST_URL, headers=headers, json=payload)
            if resp is None:
                time.sleep(POLL_INTERVAL)
                continue

            result = resp.json()
            if result.get("code") != 0:
                time.sleep(POLL_INTERVAL)
                continue

            task_list = result.get("data", {}).get("list", [])
            task = next((t for t in task_list if t.get("task_name") == task_name), None)

            if not task:
                print(f"  任务丢失，等待 {POLL_INTERVAL}s...", flush=True)
                time.sleep(POLL_INTERVAL)
                continue

            status = task.get("status")
            progress = task.get("scan_progress", 0)

            status_map = {0: "等待中", 1: "运行中", 2: "运行中", 3: "运行中", 4: "失败", 5: "已完成"}
            status_text = status_map.get(status, f"未知({status})")
            print(f"  status={status} ({status_text}), 进度={progress}%", flush=True)

            if status == 5:
                task_id = task.get("task_id")
                print(f"[OK] 复测任务完成！task_id={task_id}", flush=True)
                notify_scan_complete(task_name, task_id, company_name)
                return task_id
            elif status == 4:
                fail_reason = task.get("fail_reason", "Unknown")
                print(f"[X ERROR] 复测失败: {fail_reason}", flush=True)
                notify_scan_fail(task_name, fail_reason, company_name)
                return None

            time.sleep(POLL_INTERVAL)

        except Exception as e:
            print(f"[WARNING] 请求异常: {e}", flush=True)
            time.sleep(POLL_INTERVAL)

    print(f"[X ERROR] status 轮询超过 {STATUS_POLL_TIMEOUT_MINUTES} 分钟", flush=True)
    notify_scan_fail(task_name, f"轮询超时（{STATUS_POLL_TIMEOUT_MINUTES}分钟）", company_name)
    return None


def run_phase2(company_id: str, company_name: str = ""):
    """
    执行 Phase 2：
      1. 用 keyword="漏洞复测" 找到 start_time 最大的 task
      2. 轮询该 task 的 status
    """
    sys.path.insert(0, ROOT_DIR)
    from shared import get_cookie, extract_cookie_value

    cookie = get_cookie()
    if not cookie:
        print("[X ERROR] Cookie 无效", flush=True)
        notify_scan_fail("", "Cookie 无效或已过期", company_name)
        return 1

    headers = {
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
        "Cookie": cookie,
        "Origin": "https://soar.sangfor.com.cn",
        "Pragma": "no-cache",
        "Referer": "https://soar.sangfor.com.cn/index.html",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
        "X-Requested-With": "XMLHttpRequest",
        "Timezone": "+08:00",
    }
    csrf = extract_cookie_value(cookie, "csrf_token")
    if csrf:
        headers["X-Csrftoken"] = csrf

    print(f"[INFO] Phase 2：查找 start_time 最大的复测任务...", flush=True)
    task_name, task_id = find_retest_task(headers, company_id)

    if not task_name:
        print("[X ERROR] 未找到漏洞复测任务", flush=True)
        notify_scan_fail("", "未找到漏洞复测任务，请确认复测任务是否已创建", company_name)
        return 1

    print(f"[INFO] 目标任务: task_name={task_name}, task_id={task_id}", flush=True)

    result_task_id = poll_task_status(headers, task_name, company_id, company_name)

    if result_task_id:
        print(f"\n[OK] 复测完成! task_id={result_task_id}", flush=True)
        return 0
    else:
        print("\n[X] 复测未完成", flush=True)
        return 1


# ─────────────────────────────────────────────────────────────
# 立即模式后台进程入口
# ─────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="漏洞复测 Phase 2 轮询")
    parser.add_argument("--company-id", type=str, required=True)
    parser.add_argument("--company-name", type=str, default="")
    args = parser.parse_args()

    company_id = args.company_id
    company_name = args.company_name

    print(f"[INFO] 漏洞复测 Phase 2 启动，公司ID={company_id}", flush=True)

    try:
        code = run_phase2(company_id, company_name)
        sys.exit(code)
    except KeyboardInterrupt:
        print("\n[X] 用户中断，退出")
        sys.exit(0)
    except SystemExit:
        raise
    except Exception as e:
        try:
            notify_scan_fail("", f"Phase 2 异常: {e}", getattr(args, 'company_name', ''))
        except Exception:
            pass
        raise


if __name__ == "__main__":
    main()