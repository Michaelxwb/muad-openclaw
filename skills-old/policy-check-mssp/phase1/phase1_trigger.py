#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 1 Trigger — 策略检查任务触发入口

流程：
  1. 接收用户输入的公司名 → 获取 company_id
  2. 获取设备列表 dev_id_list
  3. 下发策略检查任务

用法：
  python phase1_trigger.py --company "公司名"

每个关键步骤无论成功失败都会通过企微 webhook 通知。
"""

import sys
import os
import json
import uuid
import subprocess
import time
import argparse
import traceback
import warnings
from datetime import datetime, timezone, timedelta

sys.dont_write_bytecode = True

warnings.filterwarnings('ignore', message='Unverified HTTPS request')

# ── 路径设置 ──
# 确保 policy-check 根目录在 sys.path 最前面（比 vuln-scan 更快）
POLICY_CHECK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VULN_SCAN_ROOT = r"C:\Users\User\.openclaw\workspace\skills\vuln-scan\run-vuln-scan"

# 先移除可能重复的路径，再插入
for p in (POLICY_CHECK_ROOT, VULN_SCAN_ROOT):
    while p in sys.path:
        sys.path.remove(p)
sys.path.insert(0, POLICY_CHECK_ROOT)
sys.path.insert(1, VULN_SCAN_ROOT)

from shared import log, clean_reports

# 每次流程启动前清空上次 reports 残留
clean_reports()

# ── 通知相关 ──
def notify(phase: str, status: str, detail: str = "", company_name: str = ""):
    """发送企微群通知，同时打印日志"""
    log(f"[通知] 阶段{phase} | {status} | {detail}")
    try:
        from shared.notify import send_notification
        send_notification(phase, status, detail, company_name=company_name)
    except Exception as e:
        log(f"通知发送失败: {e}", "WARN")


def notify_ok(phase: str, detail: str = "", company_name: str = ""):
    notify(phase, "成功", detail, company_name=company_name)


def notify_fail(phase: str, detail: str = "", company_name: str = ""):
    notify(phase, "失败", detail, company_name=company_name)


# ─────────────────────────────────────────────────────────────
# Step 1: 获取 company_id
# ─────────────────────────────────────────────────────────────

def step1_get_company_id(cookie: str, company_name: str):
    """通过公司名模糊匹配获取 company_id"""
    from phase1.phase1_company import resolve_company, MultipleCandidatesError

    log(f"[Step 1] 确认公司: '{company_name}'")

    try:
        corrected_name, company_id = resolve_company(company_name, cookie)
        detail = f"客户「{corrected_name}」, company_id={company_id}"
        log(f"[Step 1 OK] {detail}")
        return corrected_name, company_id
    except MultipleCandidatesError as e:
        notify("1", "需要确认", str(e), company_name=company_name)
        raise
    except Exception as e:
        notify_fail("1", f"客户确认失败: {e}", company_name=company_name)
        raise


# ─────────────────────────────────────────────────────────────
# Step 2: 获取设备列表
# ─────────────────────────────────────────────────────────────

def step2_get_dev_id_list(cookie: str, company_id: str, company_name: str):
    """获取公司下所有安全设备的 dev_id 列表和设备详情"""
    from phase1.get_dev_id import get_dev_id_list

    log(f"[Step 2] 获取设备列表: company_id={company_id}")

    try:
        dev_id_list, device_list = get_dev_id_list(cookie, company_id)
        log(f"[Step 2 OK] 设备数={len(dev_id_list)}")
        return dev_id_list, device_list
    except Exception as e:
        notify_fail("2", f"获取设备列表失败: {e}", company_name=company_name)
        raise


# ─────────────────────────────────────────────────────────────
# Step 3: 下发策略检查任务
# ─────────────────────────────────────────────────────────────

def step3_distribute_task(cookie: str, company_id: str, company_name: str, dev_id_list: list):
    """下发策略检查任务"""
    from phase1.policy_check_task import distribute_policy_check_task

    log(f"[Step 3] 下发策略检查任务: company_id={company_id}, 设备数={len(dev_id_list)}")

    try:
        result = distribute_policy_check_task(cookie, company_id, dev_id_list)
        detail = f"「{company_name}」策略检查任务下发成功, 设备数={len(dev_id_list)}"
        log(f"[Step 3 OK] {result.get('msg', 'success')}")
        return result
    except Exception as e:
        notify_fail("3", f"任务下发失败: {e}", company_name=company_name)
        raise


# ─────────────────────────────────────────────────────────────
# Phase 1 总入口
# ─────────────────────────────────────────────────────────────

def run_phase1(cookie: str, company_name: str):
    """
    Phase 1 完整流程（三步走）：
      1. 确认公司 → company_id
      2. 获取设备列表 → dev_id_list
      3. 下发策略检查任务
    """
    notify("1-1", "执行中", f"策略检查任务启动，客户「{company_name}」", company_name=company_name)

    try:
        # Step 1
        corrected_name, company_id = step1_get_company_id(cookie, company_name)

        # Step 2
        dev_id_list, device_list = step2_get_dev_id_list(cookie, company_id, corrected_name)
        device_desc = "、".join([f"{d.get('dev_type','?')} {d.get('dev_name','?')}" for d in device_list])
        notify("1-2", "成功", f"「{corrected_name}」获取到 {len(dev_id_list)} 台设备：{device_desc}", company_name=corrected_name)

        # Step 3
        step3_distribute_task(cookie, company_id, corrected_name, dev_id_list)
        notify("1-3", "成功", f"「{corrected_name}」策略检查任务已下发（{len(dev_id_list)}台设备），等待60秒后开始轮询", company_name=corrected_name)
        log("[Phase 1] 全部完成 ")
        return company_id, corrected_name

    except MultipleCandidatesError:
        # 多候选：不进 catch-all，留给外层让用户选择
        raise
    except SystemExit:
        # 脚本内部已经 sys.exit 了，直接向上抛
        raise
    except Exception as e:
        tb = traceback.format_exc()
        log(f"[Phase 1 异常] {tb}", "ERROR")
        notify("1-异常", "失败", f"「{company_name}」策略检查异常: {e}", company_name=company_name)
        raise


# 导出 MultipleCandidatesError 供外部使用
from phase1.phase1_company import MultipleCandidatesError  # noqa: E402


# ─────────────────────────────────────────────────────────────
# Phase 2-4 后台启动
# ─────────────────────────────────────────────────────────────

def spawn_phase2_4(company_id: str, company_name: str):
    """Phase 1 完成后，自动 spawn Phase 2-4 后台进程"""
    script = os.path.join(POLICY_CHECK_ROOT, "phase2", "phase2_run_through.py")
    cmd = [sys.executable, script, "--company-id", company_id, "--company-name", company_name]

    creationflags = 0
    if sys.platform == "win32":
        creationflags = subprocess.DETACHED_PROCESS | 0x00000008

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.STDOUT,
            cwd=POLICY_CHECK_ROOT,
            creationflags=creationflags,
        )
        log(f"[INFO] Phase 2-4 后台进程已启动, pid={proc.pid}")
    except Exception as e:
        log(f"[WARN] Phase 2-4 后台进程启动失败: {e}", "WARN")


def spawn_wait_and_run(company_id: str, company_name: str, target_ts: float):
    """定时模式：spawn phase1_wait_and_run.py 后台进程，sleep 到目标时间后执行 Phase 2-4"""
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "phase1_wait_and_run.py")
    cwd = os.path.dirname(os.path.abspath(__file__))

    env = os.environ.copy()
    env["POLICY_TARGET_TS"] = str(int(target_ts))
    env["POLICY_COMPANY_ID"] = company_id
    env["POLICY_COMPANY_NAME"] = company_name

    creationflags = 0
    if sys.platform == "win32":
        creationflags = subprocess.DETACHED_PROCESS | 0x00000008

    try:
        proc = subprocess.Popen(
            [sys.executable, script],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.STDOUT,
            cwd=cwd,
            env=env,
            creationflags=creationflags,
        )
        ts_fmt = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(target_ts))
        log(f"[INFO] 定时等待进程已启动 (pid={proc.pid}), 将在 {ts_fmt} 执行 Phase 2-4")
        notify("定时", "等待中", f" 定时策略检查已就绪，将在 {ts_fmt} 自动执行 Phase 2-4", company_name=company_name)
    except Exception as e:
        log(f"[WARN] 定时等待进程启动失败: {e}", "WARN")


# ─────────────────────────────────────────────────────────────
# 入口
# ─────────────────────────────────────────────────────────────

def main():
    from phase1.phase1_company import MultipleCandidatesError, resolve_by_selection  # noqa: E402
    parser = argparse.ArgumentParser(description="策略检查任务触发入口")
    parser.add_argument("--company", type=str, help="公司名称（模糊匹配）")
    parser.add_argument("--company-id", type=str, help="直接指定公司 ID")
    parser.add_argument("--select", type=str, help="从候选中选择：编号或完整公司名")
    parser.add_argument("--start-time", type=str, help="定时执行时间，格式: YYYY-MM-DD HH:MM:SS")
    args = parser.parse_args()

    # ── 获取 Cookie ──
    from phase1.get_dev_id import _get_cookie
    try:
        cookie = _get_cookie()
    except Exception as e:
        notify_fail("0", f"Cookie 获取失败: {e}")
        log(f"Cookie 获取失败: {e}", "ERROR")
        sys.exit(1)

    # ── 解析公司名 ──
    if args.select:
        try:
            company_name, _ = resolve_by_selection(args.select)
        except Exception as e:
            notify_fail("0", f"候选选择失败: {e}")
            sys.exit(1)
    elif args.company_id:
        company_name = args.company_id
        company_id = args.company_id
        log(f"直接使用 company_id: {company_id}")
    elif args.company:
        company_name = args.company
    else:
        print("请指定 --company 或 --company-id")
        sys.exit(1)

    # ── 解析定时时间 ──
    start_time_ts = None
    if args.start_time:
        try:
            tz = timezone(timedelta(hours=8))  # Asia/Shanghai
            dt = datetime.strptime(args.start_time, "%Y-%m-%d %H:%M:%S")
            dt = dt.replace(tzinfo=tz)
            start_time_ts = dt.timestamp()
            log(f"[定时] 设置策略检查时间: {args.start_time} (timestamp={start_time_ts})")
        except ValueError:
            print(f"[X ERROR] 时间格式错误: {args.start_time}，正确格式: YYYY-MM-DD HH:MM:SS")
            sys.exit(1)

    # ── 执行 Phase 1 ──
    try:
        if args.company_id:
            # 直接指定 company_id：跳过 step1，直接取设备列表 + 下发任务
            company_id = args.company_id
            corrected_name = args.company_id
            log(f"[直接模式] 使用 company_id={company_id}，跳过公司名解析")
            notify("1", "执行中", f"直接使用 company_id={company_id}，获取设备列表...", company_name=corrected_name)
            dev_id_list, _ = step2_get_dev_id_list(cookie, company_id, corrected_name)
            notify_ok("1", f"client_id={company_id}, 设备数={len(dev_id_list)}", company_name=corrected_name)
            step3_distribute_task(cookie, company_id, corrected_name, dev_id_list)
            notify("完成", "执行成功", f"company_id={company_id} 策略检查任务已下发（{len(dev_id_list)}台设备）", company_name=corrected_name)
        else:
            company_id, corrected_name = run_phase1(cookie, company_name)
            # 再获取一次 dev_id_list（run_phase1 内部已获取过，这里从 step2 直接拿）
            dev_id_list, _ = step2_get_dev_id_list(cookie, company_id, corrected_name)

        # 判断是否定时模式
        if start_time_ts is not None and start_time_ts > time.time():
            # 定时模式：spawn phase1_wait_and_run 后台等待进程，不直接启动 Phase 2-4
            spawn_wait_and_run(company_id, corrected_name, start_time_ts)
        else:
            # 立即模式：直接启动 Phase 2-4
            spawn_phase2_4(company_id, corrected_name)
    except MultipleCandidatesError:
        sys.exit(10)
    except (SystemExit, KeyboardInterrupt):
        raise
    except Exception as e:
        log(f"Phase 1 异常: {e}", "ERROR")
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
