#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
导出指定漏扫任务的报告

用法：
    python phase2_export_report.py "漏扫任务_xxx_202605211448"

流程：
    1. 从任务名称提取公司名
    2. 通过 API 解析 company_id
    3. 调用 phase2_run_through.py 执行 Phase 2-5（轮询扫描 → 审核 → 导出报告 → 下载）
"""
import sys
import os
import re

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT_DIR)


def extract_company_name(task_name: str) -> str:
    """从 task_name 提取公司名，格式: 漏扫任务_公司名_12位时间戳"""
    m = re.match(r'^漏扫任务_(.+)_\d{12}$', task_name)
    if m:
        return m.group(1)
    return None  # 格式不符


def resolve_company(company_hint: str, cookie: str) -> tuple:
    """通过 API 获取 company_id"""
    from phase1.phase1_prepare.phase1_company import resolve_company as _resolve
    return _resolve(company_hint, cookie)


def main():
    if len(sys.argv) < 2:
        print("用法: python phase2_export_report.py \"漏扫任务_公司名_时间戳\"")
        sys.exit(1)

    task_name = sys.argv[1].strip()

    # Step 1: 从任务名称提取公司名
    company_hint = extract_company_name(task_name)
    if not company_hint:
        print(f"[X ERROR] 不支持该任务格式，任务名称须符合「漏扫任务_公司名_时间戳」格式，如：漏扫任务_托管服务测试_202605211448", flush=True)
        sys.exit(1)
    print(f"[INFO] 任务名称: {task_name}")
    print(f"[INFO] 提取公司名: {company_hint}")

    # Step 2: 获取 Cookie
    from shared import get_cookie
    cookie = get_cookie()
    if not cookie:
        print("[X ERROR] Cookie 无效或已过期", flush=True)
        sys.exit(1)

    # Step 3: 解析 company_id
    print(f"[INFO] 正在解析 company_id...", flush=True)
    _, company_id = resolve_company(company_hint, cookie)
    print(f"[INFO] 公司: {company_hint} (company_id: {company_id})")

    # Step 4: 直接 import 调用 phase2_run_through（避免 subprocess 中文编码乱码）
    print(f"\n[INFO] 调用 Phase 2-5: company_id={company_id}, task_name={task_name}", flush=True)
    print("=" * 50, flush=True)

    old_argv = sys.argv[:]
    try:
        sys.argv = ["phase2_run_through.py", "--company-id", company_id, "--task-name", task_name]
        from phase2.phase2_run_through import main as run_phase2_5
        run_phase2_5()
    finally:
        sys.argv = old_argv


if __name__ == "__main__":
    main()