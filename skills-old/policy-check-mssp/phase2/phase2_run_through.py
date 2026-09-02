#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 2-4 Run Through — 串联执行阶段 2-4

由 phase1_wait_and_run.py 调用。
Phase 2 不需要提前知道 task_name，按 company_id 自动匹配。
"""

import sys
import os
import json
import argparse
import traceback

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared import log, send_notification, clean_reports

# 复用 vuln-scan shared 的 get_cookie
VULNSCAN = r"C:\Users\User\.openclaw\workspace\skills\vuln-scan\run-vuln-scan"
import importlib.util
_spec = importlib.util.spec_from_file_location(
    "vuln_shared", os.path.join(VULNSCAN, "shared", "__init__.py")
)
_vuln_shared = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_vuln_shared)
get_cookie = _vuln_shared.get_cookie


def main():
    parser = argparse.ArgumentParser(description="Phase 2-4 串联执行")
    parser.add_argument("--company-id", type=str, default=None, help="公司 ID")
    parser.add_argument("--company-name", type=str, default="", help="公司名（通知用）")
    parser.add_argument("--task-name", type=str, default=None, help="任务名称（导出模式，格式: af策略检查_20260607103648）")
    parser.add_argument("--dev-id-list", type=str, default=None, help="设备ID列表，JSON格式，如 '[338434,222067]'")
    args = parser.parse_args()

    cookie = get_cookie()
    company_id = args.company_id
    company_name = args.company_name

    # 导出模式：从 task_name + company_name 反查 company_id
    if args.task_name and not company_id:
        import re
        task_name_input = args.task_name.strip()
        if not re.match(r'^af策略检查.*_\d{12}$', task_name_input):
            print(f"[X ERROR] 任务名称格式不正确，应为「af策略检查xxx_时间戳」，当前输入: {task_name_input}")
            sys.exit(1)
        if not company_name:
            company_name = input("请输入公司名称: ").strip()
            if not company_name:
                print("[X ERROR] 公司名称为空")
                sys.exit(1)
        from phase1.phase1_company import resolve_company
        try:
            corrected_name, company_id = resolve_company(company_name, cookie)
            company_name = corrected_name
            log(f"导出模式: task_name={task_name_input}, company_name={company_name}, company_id={company_id}")
        except Exception as e:
            log(f"公司查找失败: {e}", "ERROR")
            sys.exit(1)

    if not company_id:
        print("[X ERROR] 请指定 --company-id 或 --task-name（导出模式需配合 --company-name）")
        sys.exit(1)

    log(f"={'='*50}")
    log(f"策略检查 Phase 2-4 开始")
    log(f"公司ID: {company_id}")
    log(f"={'='*50}")

    try:
        # ========== Phase 2: 轮询策略检查状态 ==========
        log("=" * 50)
        log("Phase 2: 轮询策略检查状态")
        log("=" * 50)

        from phase2.phase2_wait_check import run_phase2
        task_name, task = run_phase2(cookie, company_id, company_name)

        task_id = task.get("_id", task_name)
        log(f"Phase 2 完成: task_name={task_name}, _id={task_id}")

        # ========== Phase 3: 导出报告 ==========
        log("=" * 50)
        log("Phase 3: 导出报告")
        log("=" * 50)
        from phase3.phase3_export_report import export_report
        report_result = export_report(cookie, task_id, company_id, task_name, company_name)

        report_url = report_result.get("url", "")

        # ========== Phase 4: 生成话术 ==========
        log("=" * 50)
        log("Phase 4: 生成策略检查话术")
        log("=" * 50)

        # 从命令行参数读取 dev_id_list
        dev_id_list = []
        if args.dev_id_list:
            try:
                dev_id_list = json.loads(args.dev_id_list)
            except Exception:
                pass
        log(f"dev_id_list (from args): {dev_id_list}")

        from phase4.phase4_generate_message import generate_policy_message
        message = generate_policy_message(cookie, company_id, dev_id_list, task_name, report_result.get("file_path", ""), task_id=task_id, company_name=company_name)

        if message:
            log("话术生成成功")
        else:
            send_notification("4", "执行失败", "策略检查话术生成失败", company_name=company_name)
            log("话术生成失败", "WARN")

        log("=" * 50)
        log("策略检查 Phase 2-4 全部完成 ")
        log("=" * 50)

        clean_reports()
        sys.exit(0)

    except Exception as e:
        tb = traceback.format_exc()
        log(f"执行异常: {tb}", "ERROR")
        send_notification("2-4", "执行异常", str(e), company_name=company_name)
        clean_reports()
        sys.exit(1)


if __name__ == "__main__":
    main()
