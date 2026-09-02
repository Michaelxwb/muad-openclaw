#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 1 Trigger - 资产发现任务触发入口

整合串联流程：
  1. 确认公司信息
  2. 获取设备ID
  3. 拉取资产IP列表
  4. 创建设备资产发现任务

每一步都推送企微群进度通知，支持定时执行（与漏扫一致的 detached 后台进程模式）
"""
import sys
import argparse
import subprocess
import os
import time
import json
import re
from datetime import datetime, timezone, timedelta
from typing import Tuple, Optional, List

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from phase1.phase1_prepare import (
    resolve_company,
    resolve_company_by_id,
    MultipleCandidatesError,
    manage_config,
    get_dev_id,
    fetch_all_asset_ips,
    create_asset_discovery_task,
    lookup_candidate_by_index,
    lookup_candidate_by_name,
)
from shared import (
    get_cookie,
    send_notification,
    log,
    DEFAULT_DELAY_MINUTES,
)


# =============================================================================
# 后台进程启动（与漏扫一致）
# =============================================================================
def spawn_wait_and_run(target_ts: int, company_arg: str, corrected_name: str,
                       task_name: str, delay_minutes: int):
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "phase1_wait_and_run.py")
    cmd = [sys.executable, script]

    env = os.environ.copy()
    env["PHASE1_TARGET_TS"] = str(target_ts)
    env["PHASE1_COMPANY"] = company_arg
    env["PHASE1_CORRECTED_NAME"] = corrected_name
    env["PHASE1_TASK_NAME"] = task_name
    env["PHASE1_DELAY"] = str(delay_minutes)

    creationflags = 0
    if sys.platform == "win32":
        import subprocess as _subprocess
        creationflags = _subprocess.DETACHED_PROCESS | 0x00000008

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
        cwd=os.path.dirname(os.path.abspath(__file__)),
        env=env,
        creationflags=creationflags,
    )
    print(f"[INFO] 后台等待进程已启动, pid={proc.pid}", flush=True)


def spawn_wait_and_run_now(company_id: str, company_name: str, task_name: str, delay_minutes: int):
    """
    立即执行（无定时）：Phase 1 已完成，启动后台进程等待 delay 后执行 Phase 2
    与漏扫 phase1_trigger.py 的 spawn_wait_and_run_now 完全一致
    """
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "phase1_wait_and_run.py")
    cmd = [sys.executable, script]
    env = os.environ.copy()
    env["PHASE1_TARGET_TS"] = "0"
    env["PHASE1_COMPANY"] = company_id
    env["PHASE1_CORRECTED_NAME"] = company_name
    env["PHASE1_TASK_NAME"] = task_name
    env["PHASE1_DELAY"] = str(delay_minutes)
    env["PHASE1_IMMEDIATE_MODE"] = "1"

    creationflags = 0
    if sys.platform == "win32":
        import subprocess as _subprocess
        creationflags = _subprocess.DETACHED_PROCESS | 0x00000008

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
        cwd=os.path.dirname(os.path.abspath(__file__)),
        env=env,
        creationflags=creationflags,
    )
    print(f"[INFO] 后台 Phase 2 进程已启动，pid={proc.pid}，{delay_minutes}分钟后执行", flush=True)


# =============================================================================
# 时间解析
# =============================================================================
def parse_schedule_time(text: str) -> Tuple[bool, Optional[str], Optional[str]]:
    text = text.strip()
    immediate_keywords = ["现在", "立刻", "马上", "立即", "尽快", "赶紧"]
    for kw in immediate_keywords:
        if kw in text:
            return False, None, None

    dt, residual = _parse_cn_datetime(text)
    if dt is not None:
        residual = re.sub(r"^[\s.，,。]+$", "", residual).strip()
        if residual and len(residual) > 4:
            return True, None, f"无法识别的时间表达: {text}"
        if dt <= datetime.now():
            dt += __import__("datetime").timedelta(days=1)
        return True, dt.strftime("%Y-%m-%d %H:%M:%S"), None

    for fmt in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"]:
        try:
            dt = datetime.strptime(text, fmt)
            if dt <= datetime.now():
                dt += __import__("datetime").timedelta(days=1)
            return True, dt.strftime("%Y-%m-%d %H:%M:%S"), None
        except ValueError:
            pass

    return False, None, None


def _parse_cn_datetime(text: str):
    from datetime import timedelta
    now = datetime.now()
    base_date = now.date()

    if re.match(r"^(明天|明日)", text):
        base_date = (now + timedelta(days=1)).date()
        text = re.sub(r"^(明天|明日)", "", text)
    elif re.match(r"^(今晚|今夜)", text):
        text = re.sub(r"^(今晚|今夜)", "", text)
    elif re.match(r"^(今天|今日)", text):
        text = re.sub(r"^(今天|今日)", "", text)

    period_words = ["凌晨", "早上", "上午", "中午", "下午", "晚上", "傍晚"]
    period_offset = {
        "凌晨": 0, "早上": 0, "上午": 0, "中午": 0,
        "下午": +12, "晚上": +12, "傍晚": +12
    }
    matched_period = None
    for pw in period_words:
        if text.startswith(pw):
            matched_period = pw
            text = text[len(pw):]
            break

    m = re.match(r"^(\d{1,2})[点:](\d{1,2})分?", text)
    if m:
        hour = int(m.group(1)) + period_offset.get(matched_period, 0)
        minute = int(m.group(2))
        text = text[m.end():]
        return datetime.combine(base_date, datetime.min.time().replace(hour=hour, minute=minute)), text

    m = re.match(r"^(\d{1,2})点", text)
    if m:
        hour = int(m.group(1)) + period_offset.get(matched_period, 0)
        text = text[m.end():]
        return datetime.combine(base_date, datetime.min.time().replace(hour=hour, minute=0)), text

    return None, text


def make_task_name(corrected_company_name: str) -> str:
    ts = datetime.now().strftime("%Y%m%d%H%M")
    return f"资产发现_{corrected_company_name}_{ts}"


# =============================================================================
# 执行主流程
# =============================================================================
def run_asset_discovery_flow(
    company_name: str,
    company_id: str,
    cookie: str,
    task_name: str,
    delay_minutes: int = DEFAULT_DELAY_MINUTES,
    excute_mode: int = 1,
    start_time_ms: int = 0,
    cycle_time_start: str = ""
):
    """
    执行资产发现完整流程。
    三阶段通知：任务启动 → 配置确认(设备+资产) → 任务下发成功
    """
    # ── 通知1: 任务启动 ────────────────────────────────────
    send_notification("资产发现任务启动", "进行中", f"客户「{company_name}」开始发起资产发现", company_name=company_name)

    # ── Step 1: 公司确认 ──────────────────────────────────────

    # ── Step 2: 获取设备ID ────────────────────────────────────
    dev_id = get_dev_id(cookie, company_id)

    # ── Step 3: 获取服务内资产IP列表 ───────────────────────────────
    print(f"[INFO] 正在拉取资产IP列表...", flush=True)
    asset_list = fetch_all_asset_ips(company_id, cookie)

    # ── 通知2: 配置确认 ────────────────────────────────────
    send_notification("资产发现配置确认", "成功", f"「{company_name}」获取到 {len(asset_list)} 个服务内资产", company_name=company_name)

    # ── Step 4: 创建设备资产发现任务 ─────────────────────────
    result = create_asset_discovery_task(
        cookie=cookie,
        task_name=task_name,
        dev_id=dev_id,
        company_id=company_id,
        asset_list=asset_list,
        excute_mode=excute_mode,
        start_time=start_time_ms
    )
    if result.get("code") not in (0, 1105):
        err_msg = result.get("msg") or result.get("message") or "未知错误"
        send_notification("创建任务", "失败", f"公司: {company_name}，错误: {err_msg}", company_name=company_name)
        sys.exit(1)

    if excute_mode == 0:
        # 定时模式：任务已下发，启动后台进程
        sh_tz = timezone(timedelta(hours=8))
        display_time = datetime.fromtimestamp(start_time_ms / 1000, tz=sh_tz).strftime("%Y-%m-%d %H:%M:%S")
        send_notification(
            "资产发现任务下发",
            "成功",
            f"「{company_name}」任务已创建: {task_name}，将在 {display_time} 执行",
            company_name=company_name
        )
        print(f"[OK] 资产发现任务创建成功: {task_name}，定时执行", flush=True)

        target_ts = start_time_ms
        spawn_wait_and_run(target_ts, company_id, company_name, task_name, delay_minutes)
        sys.exit(0)

    # 立即执行模式：启动后台进程，等 delay 分钟后执行 Phase 2
    send_notification(
        "资产发现任务下发",
        "成功",
        f"「{company_name}」任务已创建: {task_name}，{delay_minutes}分钟后自动执行资产分析并推送结果",
        company_name=company_name
    )
    print(f"[OK] 资产发现任务创建成功: {task_name}，启动后台进程等待 {delay_minutes} 分钟后执行 Phase 2", flush=True)
    spawn_wait_and_run_now(company_id, company_name, task_name, delay_minutes)
    sys.exit(0)


# =============================================================================
# 主函数
# =============================================================================
def main():
    parser = argparse.ArgumentParser(description="Phase 1 Trigger - 资产发现")
    parser.add_argument("--select", type=int, help="从候选项文件按编号选择公司")
    parser.add_argument("--company-id", type=str, help="直接指定公司ID")
    parser.add_argument("--company", type=str, help="公司名称")
    parser.add_argument("--start-time", type=str, default=None, help="定时执行时间")
    parser.add_argument("--delay-minutes", type=int, default=None, help="延迟分钟数")
    args = parser.parse_args()

    cookie = get_cookie()
    delay_minutes = args.delay_minutes if args.delay_minutes is not None else DEFAULT_DELAY_MINUTES

    if not cookie:
        send_notification("资产发现流程", "失败", "Cookie 无效或已过期")
        print("[X ERROR] Cookie 无效或已过期", flush=True)
        sys.exit(1)

    target_ts = 0

    # ── 从候选项文件选择公司 ────────────────────────────────
    if args.select:
        candidate = lookup_candidate_by_index(args.select)
        if not candidate:
            print(f"[X ERROR] 无效编号: {args.select}，或候选项文件已过期", flush=True)
            sys.exit(1)
        company_id = candidate["company_id"]
        company_name = candidate["company_name"]

        if target_ts == 0:
            task_name = make_task_name(company_name)
            print(f"[INFO] 公司: {company_name}, 任务: {task_name}", flush=True)
            run_asset_discovery_flow(company_name, company_id, cookie, task_name, delay_minutes)

        # 定时模式
        task_name = make_task_name(company_name)
        spawn_wait_and_run(target_ts, company_id, company_name, task_name, delay_minutes)
        sys.exit(0)

    # ── 直接指定公司ID ────────────────────────────────────
    if args.company_id:
        company_name, _ = resolve_company_by_id(args.company_id, cookie)
        print(f"[INFO] 直接指定公司: {company_name} ({args.company_id})", flush=True)

        if target_ts == 0:
            task_name = make_task_name(company_name)
            print(f"[INFO] 公司: {company_name}, 任务: {task_name}", flush=True)
            run_asset_discovery_flow(company_name, args.company_id, cookie, task_name, delay_minutes)

        # 定时模式
        task_name = make_task_name(company_name)
        spawn_wait_and_run(target_ts, args.company_id, company_name, task_name, delay_minutes)
        sys.exit(0)

    # ── 新建任务 ─────────────────────────────────────────
    if not args.company:
        print("[X ERROR] 必须指定 --company", flush=True)
        sys.exit(1)

    # 解析定时时间，直接把完整 datetime 转毫秒时间戳
    excute_mode = 1
    start_time_ms = 0
    cycle_time_start = ""

    if args.start_time:
        parsed_ok, parsed_str, err = parse_schedule_time(args.start_time)
        if err:
            print(f"[X ERROR] {err}", flush=True)
            sys.exit(1)
        if parsed_ok and parsed_str:
            dt = datetime.strptime(parsed_str, "%Y-%m-%d %H:%M:%S")
            if dt <= datetime.now():
                print(f"[INFO] 定时时间为过去时间，立即执行...", flush=True)
            else:
                sh_tz = timezone(timedelta(hours=8))
                start_time_ms = int(dt.replace(tzinfo=sh_tz).timestamp() * 1000)
                cycle_time_start = dt.strftime("%H:%M:%S")
                excute_mode = 0
                print(f"[INFO] 定时任务：start_time_ms={start_time_ms} ({parsed_str})", flush=True)

    company_name, company_id = resolve_company(args.company, cookie)
    task_name = make_task_name(company_name)
    print(f"[INFO] 公司: {company_name}, 任务: {task_name}", flush=True)
    run_asset_discovery_flow(
        company_name, company_id, cookie, task_name,
        delay_minutes,
        excute_mode=excute_mode,
        start_time_ms=start_time_ms,
        cycle_time_start=cycle_time_start
    )

    # 定时模式在 run_asset_discovery_flow 内部已处理 sys.exit
    # 立即执行模式不会走到这里


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[X] 用户中断，退出", flush=True)
        sys.exit(0)
    except SystemExit:
        raise
    except MultipleCandidatesError as e:
        candidates = []
        try:
            with open(e.CANDIDATES_FILE, encoding="utf-8") as f:
                candidates = json.load(f)
        except Exception:
            pass
        lines = [f"共 {len(candidates)} 个候选公司，请回复编号或完整公司名确认："]
        for i, c in enumerate(candidates, 1):
            lines.append(f"  [{i}] {c['company_name']}")
        send_notification("资产发现候选确认", "需要确认", "\n".join(lines))
        sys.exit(0)
    except Exception as e:
        try:
            send_notification("资产发现流程", "失败", f"执行中断: {e}")
        except Exception:
            pass
        raise