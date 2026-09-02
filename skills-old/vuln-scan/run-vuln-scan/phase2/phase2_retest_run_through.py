#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
漏洞复测 Phase 2：轮询任务状态，完成后发送企微群通知
与漏扫 Phase 2 的区别：复测只轮询到任务完成即结束，不进入 Phase 3-5
"""
import sys, os, argparse, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from shared import log, get_cookie, TASK_LIST_URL, request_with_retry, send_notification

POLL_INTERVAL = 10
MAX_WAIT_MINUTES = 210
NOTIFY_EVERY_MINUTES = 10
NOTIFY_EVERY_COUNT = NOTIFY_EVERY_MINUTES * 60 // POLL_INTERVAL
FIRST_MATCH_TIMEOUT_MINUTES = 30
STATUS_POLL_TIMEOUT_MINUTES = 180


def phase2_wait_retest(cookie: str, task_name: str, company_id: str, company_name: str = ""):
    """
    轮询复测任务状态：
      1. task_name 匹配阶段（最多 30 分钟）
      2. status 轮询阶段（最多 180 分钟）
    完成即结束，不继续 Phase 3-5。
    """
    log("=" * 50, "INFO")
    log(f"漏洞复测 Phase 2: 轮询任务状态 (每 {POLL_INTERVAL}s)", "INFO")
    log(f"任务名称: {task_name}", "INFO")
    log("=" * 50, "INFO")

    send_notification("漏洞复测 Phase 2", "进行中", f"复测任务开始轮询（{task_name}）", company_name=company_name)

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

    first_task_seen_ts = None

    # ===== 阶段1：task_name 匹配（最多 30 分钟） =====
    while True:
        elapsed_total = time.time() - (first_task_seen_ts or time.time())
        elapsed_minutes = int(elapsed_total // 60) if first_task_seen_ts else 0

        log(f"[task_name匹配] 第 {elapsed_minutes}min / {FIRST_MATCH_TIMEOUT_MINUTES}min", "INFO")

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
                log(f"[OK] 任务 '{task_name}' 已出现，进入 status 轮询", "INFO")
                break

            if first_task_seen_ts is None:
                first_task_seen_ts = time.time()
                log(f"  任务暂未出现，已开始计时...", "INFO")
            else:
                elapsed_since_first = time.time() - first_task_seen_ts
                if elapsed_since_first >= FIRST_MATCH_TIMEOUT_MINUTES * 60:
                    log(f"[X ERROR] 任务在 {FIRST_MATCH_TIMEOUT_MINUTES} 分钟内未出现", "ERROR")
                    send_notification("漏洞复测", "失败", f"任务 '{task_name}' 在 {FIRST_MATCH_TIMEOUT_MINUTES} 分钟内未出现", company_name=company_name)
                    return None

            time.sleep(POLL_INTERVAL)

        except Exception as e:
            log(f"  请求异常: {e}", "WARNING")
            time.sleep(POLL_INTERVAL)

    # ===== 阶段2：status 轮询（最多 180 分钟） =====
    max_polls = STATUS_POLL_TIMEOUT_MINUTES * 60 // POLL_INTERVAL

    for i in range(max_polls):
        current_loop = i + 1
        elapsed_minutes = (current_loop - 1) * POLL_INTERVAL // 60

        if current_loop > 1 and (current_loop - 1) % NOTIFY_EVERY_COUNT == 0:
            # 先拉一次当前任务状态以获取进度信息
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
                            status_map = {0: "等待中", 1: "运行中", 2: "运行中", 3: "运行中", 4: "失败", 5: "已完成"}
                            cur_status_text = status_map.get(cur_status, f"未知({cur_status})") if cur_status is not None else "未知"
                            notify_msg = f"已等待 {elapsed_minutes} 分钟"
                            notify_msg += f"\n状态：{cur_status_text}（进度 {cur_progress}%）"
                            if cur_vuln_total > 0:
                                notify_msg += f"\n漏洞：{cur_vuln_done}/{cur_vuln_total}"
                            log(f"  [NOTIFY] {notify_msg}", "INFO")
                            send_notification("漏洞复测扫描", "进行中", notify_msg, company_name=company_name)
            except Exception:
                pass

        log(f"[status轮询] 第 {current_loop}/{max_polls} 次 (已等 {elapsed_minutes}min)", "INFO")

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

            status_map = {0: "等待中", 1: "运行中", 2: "运行中", 3: "运行中", 4: "失败", 5: "已完成"}
            status_text = status_map.get(status, f"未知({status})")
            log(f"  status={status} ({status_text}), 进度={progress}%", "INFO")

            if status == 5:
                task_id = task.get("task_id")
                log(f"[OK] 复测任务完成！task_id={task_id}", "INFO")
                send_notification("漏洞复测", "成功", f"复测扫描完成（task_id={task_id}）", company_name=company_name)
                return task_id
            elif status == 4:
                fail_reason = task.get("fail_reason", "Unknown")
                log(f"[X ERROR] 复测失败: {fail_reason}", "ERROR")
                send_notification("漏洞复测", "失败", f"复测任务失败: {fail_reason}", company_name=company_name)
                return None

            time.sleep(POLL_INTERVAL)

        except Exception as e:
            log(f"  请求异常: {e}", "WARNING")
            time.sleep(POLL_INTERVAL)

    log(f"[X ERROR] status 轮询超过 {STATUS_POLL_TIMEOUT_MINUTES} 分钟", "ERROR")
    send_notification("漏洞复测", "失败", f"轮询超时（{STATUS_POLL_TIMEOUT_MINUTES}分钟）", company_name=company_name)
    return None


parser = argparse.ArgumentParser(description="漏洞复测 Phase 2")
parser.add_argument("--task-name", type=str, required=True)
parser.add_argument("--company-id", type=str, required=True)
args = parser.parse_args()

cookie = get_cookie()
task_name = args.task_name
company_id = args.company_id

print(f"任务名称: {task_name}")
print(f"公司ID: {company_id}")
print()

try:
    task_id = phase2_wait_retest(cookie, task_name, company_id)
    if task_id:
        print(f"\n复测完成! task_id={task_id}")
    else:
        print("\n复测未完成，退出")
        sys.exit(1)
except KeyboardInterrupt:
    print("\n[X] 用户中断，退出")
except SystemExit:
    raise
except Exception as e:
    try:
        send_notification(f"❌ 漏洞复测 Phase 2 异常: {e}")
    except Exception:
        pass
    raise