#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 1 Trigger — 策略检查任务触发入口（仅立即模式）

流程：
  1. 接收用户输入的公司名 → 获取 company_id
  2. 获取设备列表 dev_id_list
  3. 下发策略检查任务
  4. 把 session（company_id/company_name/task_ids/dev_id_list）写入 cache/last_session.json
  5. 打印精简模板结果，结束。不自动进入 Phase 2/4。

用法：
  python phase1/phase1_trigger.py --company "公司名"
  python phase1/phase1_trigger.py --company-id 12345678
  python phase1/phase1_trigger.py --select 1
"""

import sys
import os
import json
import argparse
import traceback
import warnings

sys.dont_write_bytecode = True
warnings.filterwarnings('ignore', message='Unverified HTTPS request')

# ── 路径设置 ──
POLICY_CHECK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
while POLICY_CHECK_ROOT in sys.path:
    sys.path.remove(POLICY_CHECK_ROOT)
sys.path.insert(0, POLICY_CHECK_ROOT)

from shared import log, get_cookie, save_session as _save_session

# 设备类型映射（与 policy_check_task.py 一致）
DEV_TYPE_MAP = {3: "AF", 9: "SIP", 12: "EDR"}


# ── 通知 ──
def notify(phase: str, status: str, detail: str = "", company_name: str = ""):
    log(f"[通知] 阶段{phase} | {status} | {detail}")
    try:
        from shared.notify import send_notification
        send_notification(phase, status, detail, company_name=company_name)
    except Exception as e:
        log(f"通知发送失败: {e}", "WARN")


def notify_fail(phase: str, detail: str = "", company_name: str = ""):
    notify(phase, "失败", detail, company_name=company_name)


# ─────────────────────────────────────────────────────────────
# Step 1: 获取 company_id
# ─────────────────────────────────────────────────────────────

def step1_get_company_id(cookie: str, company_name: str):
    from phase1.phase1_company import resolve_company, MultipleCandidatesError

    log(f"[Step 1] 确认公司: '{company_name}'")
    try:
        corrected_name, company_id = resolve_company(company_name, cookie)
        log(f"[Step 1 OK] 客户「{corrected_name}」, company_id={company_id}")
        return corrected_name, company_id
    except MultipleCandidatesError:
        raise
    except Exception as e:
        notify_fail("1", f"客户确认失败: {e}", company_name=company_name)
        raise


# ─────────────────────────────────────────────────────────────
# Step 2: 获取设备列表
# ─────────────────────────────────────────────────────────────

def step2_get_dev_id_list(cookie: str, company_id: str, company_name: str):
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

def step3_distribute_task(cookie: str, company_id: str, company_name: str, device_list: list):
    from phase1.policy_check_task import distribute_policy_check_task, _build_dev_infos

    log(f"[Step 3] 下发策略检查任务: company_id={company_id}, 设备数={len(device_list)}")
    try:
        task_ids = distribute_policy_check_task(cookie, company_id, device_list)
        # 统计支持设备中各类型数量
        dev_infos = _build_dev_infos(device_list)
        type_count = {label: 0 for label in DEV_TYPE_MAP.values()}
        for d in dev_infos:
            label = DEV_TYPE_MAP.get(d.get("dev_type"))
            if label:
                type_count[label] = type_count.get(label, 0) + 1
        # 统计跳过的设备
        skipped = [d for d in device_list if d.get("dev_type") not in DEV_TYPE_MAP]
        log(f"[Step 3 OK] task_ids={task_ids}")
        return task_ids, type_count, len(skipped)
    except Exception as e:
        notify_fail("3", f"任务下发失败: {e}", company_name=company_name)
        raise


# ─────────────────────────────────────────────────────────────
# Session 持久化
# ─────────────────────────────────────────────────────────────

def save_session(company_id: str, company_name: str, task_ids: list, dev_id_list: list):
    """下发成功后写入 cache/last_session.json，供 phase2/phase4 默认读取。"""
    _save_session({
        "company_id": company_id,
        "company_name": company_name,
        "task_ids": task_ids,
        "dev_id_list": dev_id_list,
    })
    log(f"[Session] 已写入 cache/last_session.json")


# ─────────────────────────────────────────────────────────────
# 模板 1：下发结果
# ─────────────────────────────────────────────────────────────

def render_phase1_template(company_name: str, company_id: str, device_count: int,
                            type_count: dict, task_count: int, task_ids: list,
                            skipped_count: int) -> str:
    """生成下发结果的精简文本（不发送企微，仅 stdout 打印给调用方）。"""
    type_lines = "、".join(f"{k} {v}" for k, v in type_count.items() if v > 0)
    if not type_lines:
        type_lines = "0"
    skipped_line = f"跳过 {skipped_count} 台" if skipped_count > 0 else "无"
    lines = [
        "✅ 策略检查任务已下发",
        f"客户：{company_name}（company_id={company_id}）",
        f"设备：{device_count} 台（{type_lines}）",
        f"任务：{task_count} 个，task_ids={task_ids}",
        f"跳过：{skipped_line}",
        "",
        '下次可问我：「查询策略检查任务状态」「查询策略检查结果」',
    ]
    return "\n".join(lines)


def render_phase1_fail(step: str, company_name: str, err: Exception) -> str:
    lines = [
        "❌ 策略检查任务下发失败",
        f"客户：{company_name or '未知'}",
        f"阶段：{step}",
        f"原因：{err}",
        "",
        "请检查后重试。",
    ]
    return "\n".join(lines)


# ─────────────────────────────────────────────────────────────
# Phase 1 总入口
# ─────────────────────────────────────────────────────────────

def run_phase1(cookie: str, company_name: str):
    """Phase 1 完整三步走，返回 (company_id, corrected_name, task_ids, dev_id_list, type_count, skipped_count)。"""
    notify("1-1", "执行中", f"策略检查任务启动，客户「{company_name}」", company_name=company_name)
    try:
        corrected_name, company_id = step1_get_company_id(cookie, company_name)
        dev_id_list, device_list = step2_get_dev_id_list(cookie, company_id, corrected_name)
        device_desc = "、".join([f"{DEV_TYPE_MAP.get(d.get('dev_type'), d.get('dev_type','?'))} {d.get('dev_name','?')}"
                                for d in device_list if d.get("dev_type") in DEV_TYPE_MAP])
        notify("1-2", "成功", f"「{corrected_name}」获取到 {len(dev_id_list)} 台设备：{device_desc}",
               company_name=corrected_name)
        task_ids, type_count, skipped_count = step3_distribute_task(cookie, company_id, corrected_name, device_list)
        notify("1-3", "成功",
               f"「{corrected_name}」策略检查任务已下发（{len(dev_id_list)}台设备，{len(task_ids)}个任务）",
               company_name=corrected_name)
        log("[Phase 1] 全部完成")
        return company_id, corrected_name, task_ids, dev_id_list, type_count, skipped_count
    except Exception as e:
        tb = traceback.format_exc()
        log(f"[Phase 1 异常] {tb}", "ERROR")
        notify("1-异常", "失败", f"「{company_name}」策略检查异常: {e}", company_name=company_name)
        raise


# 导出 MultipleCandidatesError 供外部使用
from phase1.phase1_company import MultipleCandidatesError  # noqa: E402


# ─────────────────────────────────────────────────────────────
# 入口
# ─────────────────────────────────────────────────────────────

def main():
    from phase1.phase1_company import resolve_by_selection  # noqa: E402

    parser = argparse.ArgumentParser(description="策略检查任务触发入口（仅立即模式）")
    parser.add_argument("--company", type=str, help="公司名称（模糊匹配）")
    parser.add_argument("--company-id", type=str, help="直接指定公司 ID")
    parser.add_argument("--select", type=str, help="从候选中选择：编号或完整公司名")
    args = parser.parse_args()

    # ── 获取 Cookie ──
    try:
        cookie = get_cookie()
    except Exception as e:
        print(render_phase1_fail("0-Cookie", "", e))
        log(f"Cookie 获取失败: {e}", "ERROR")
        sys.exit(1)

    # ── 解析公司名 ──
    company_name = None
    company_id = None
    try:
        if args.select:
            company_name, cid = resolve_by_selection(args.select)
            company_id = cid
        elif args.company_id:
            company_name = args.company_id
            company_id = args.company_id
            log(f"直接使用 company_id: {company_id}")
        elif args.company:
            company_name = args.company
        else:
            print("请指定 --company 或 --company-id 或 --select")
            sys.exit(1)
    except Exception as e:
        print(render_phase1_fail("0-选择", company_name or "", e))
        sys.exit(1)

    # ── 执行 Phase 1 ──
    try:
        if args.company_id:
            # 直接指定 company_id：跳过 step1
            corrected_name = args.company_id
            log(f"[直接模式] 使用 company_id={company_id}，跳过公司名解析")
            notify("1", "执行中", f"直接使用 company_id={company_id}，获取设备列表...",
                   company_name=corrected_name)
            dev_id_list, device_list = step2_get_dev_id_list(cookie, company_id, corrected_name)
            from phase1.policy_check_task import _build_dev_infos
            dev_infos = _build_dev_infos(device_list)
            type_count = {label: 0 for label in DEV_TYPE_MAP.values()}
            for d in dev_infos:
                label = DEV_TYPE_MAP.get(d.get("dev_type"))
                if label:
                    type_count[label] = type_count.get(label, 0) + 1
            skipped_count = len([d for d in device_list if d.get("dev_type") not in DEV_TYPE_MAP])
            task_ids, _, _ = step3_distribute_task(cookie, company_id, corrected_name, device_list)
        else:
            company_id, corrected_name, task_ids, dev_id_list, type_count, skipped_count = run_phase1(cookie, company_name)

        # 写 session
        save_session(company_id, corrected_name, task_ids, dev_id_list)

        # 输出精简模板
        device_count = sum(type_count.values())
        print(render_phase1_template(
            company_name=corrected_name,
            company_id=company_id,
            device_count=device_count,
            type_count=type_count,
            task_count=len(task_ids),
            task_ids=task_ids,
            skipped_count=skipped_count,
        ))
        sys.exit(0)

    except MultipleCandidatesError:
        sys.exit(10)
    except (SystemExit, KeyboardInterrupt):
        raise
    except Exception as e:
        log(f"Phase 1 异常: {e}", "ERROR")
        traceback.print_exc()
        print(render_phase1_fail("Phase 1", company_name or "", e))
        sys.exit(1)


if __name__ == "__main__":
    main()
