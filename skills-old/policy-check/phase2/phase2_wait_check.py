#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 2 — 查询策略检查任务状态（独立入口，按需调用）

两种调用方式：
  1. 不带参数（自动读 cache/last_session.json）：
     python phase2/phase2_wait_check.py
  2. 带参数：
     python phase2/phase2_wait_check.py --task-ids '["t1","t2"]' --company-name X

不再自动轮询到终态：仅查询一次当前状态，立即返回精简模板。
用户想等完成可以再问一次。
"""

import sys
import os
import json
import uuid
import time
import argparse
import warnings

warnings.filterwarnings('ignore', message='Unverified HTTPS request')

POLICY_CHECK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if POLICY_CHECK_ROOT not in sys.path:
    sys.path.insert(0, POLICY_CHECK_ROOT)

from shared import log, get_cookie, extract_cookie_value, get_endpoint, get_base, get_origin, load_session
import requests

POLICY_CHECK_STATUS_URL = get_endpoint("policy_check_status")

# 任务状态枚举
TASK_STATUS_ASSEESSING_HAS_FAILURE = 10
TASK_STATUS_ASSEESSING_NO_FAILURE = 20
TASK_STATUS_ASSESS_PAUSE = 25
TASK_STATUS_ASSESS_FAILURED = 30
TASK_STATUS_ASSESS_COMPLETED_HAS_FAILURE = 40
TASK_STATUS_ASSESS_NEED_TO_DO = 50
TASK_STATUS_ASSESS_COMPLETED_NO_FAILURE = 60
TASK_STATUS_NOT_EXIST = 9906

TASK_STATUS_TERMINAL = {
    TASK_STATUS_ASSESS_COMPLETED_HAS_FAILURE,
    TASK_STATUS_ASSESS_COMPLETED_NO_FAILURE,
    TASK_STATUS_ASSESS_FAILURED,
    TASK_STATUS_NOT_EXIST,
}
TASK_STATUS_IN_PROGRESS_SET = {
    TASK_STATUS_ASSESS_NEED_TO_DO,
    TASK_STATUS_ASSEESSING_HAS_FAILURE,
    TASK_STATUS_ASSEESSING_NO_FAILURE,
    TASK_STATUS_ASSESS_PAUSE,
}
TASK_STATUS_INITIAL = TASK_STATUS_ASSESS_NEED_TO_DO


def notify(step: str, status: str, detail: str = "", company_name: str = ""):
    log(f"[通知] {step} | {status} | {detail}")
    try:
        from shared.notify import send_notification
        send_notification(step, status, detail, company_name=company_name)
    except Exception as e:
        log(f"通知发送失败: {e}", "WARN")


def _build_headers(cookie: str) -> dict:
    return {
        "accept": "application/json, text/javascript, */*; q=0.01",
        "content-type": "application/json",
        "cookie": cookie,
        "origin": get_origin(),
        "referer": get_base("soar_referer"),
        "traceid": str(uuid.uuid4()),
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
        "x-csrftoken": extract_cookie_value(cookie, "csrf_token") or "",
        "x-requested-with": "XMLHttpRequest",
    }


def query_task_status(cookie: str, task_ids: list) -> list:
    """单次查询任务状态，返回 data 数组。"""
    headers = _build_headers(cookie)
    payload = {"task_id": task_ids}
    response = requests.post(POLICY_CHECK_STATUS_URL, headers=headers, json=payload, timeout=30, verify=False)
    if response is None:
        raise RuntimeError("请求返回为空")
    result = response.json()
    if result.get("code") != 0:
        raise RuntimeError(f"API 返回错误 code={result.get('code')}: {result.get('msg', result)}")
    return result.get("data", []) or []


def _build_summary(status_map: dict) -> dict:
    """统计各状态计数 + 汇总标签。"""
    all_statuses = [
        TASK_STATUS_ASSEESSING_HAS_FAILURE,
        TASK_STATUS_ASSEESSING_NO_FAILURE,
        TASK_STATUS_ASSESS_PAUSE,
        TASK_STATUS_ASSESS_FAILURED,
        TASK_STATUS_ASSESS_COMPLETED_HAS_FAILURE,
        TASK_STATUS_ASSESS_NEED_TO_DO,
        TASK_STATUS_ASSESS_COMPLETED_NO_FAILURE,
        TASK_STATUS_NOT_EXIST,
    ]
    counts = {s: 0 for s in all_statuses}
    for ts in status_map.values():
        if ts in counts:
            counts[ts] += 1

    total = len(status_map)
    if counts[TASK_STATUS_NOT_EXIST] + counts[TASK_STATUS_ASSESS_FAILURED] == total and total > 0:
        label = "全部失败"
    elif counts[TASK_STATUS_ASSESS_COMPLETED_NO_FAILURE] == total and total > 0:
        label = "评估完成不存在失败"
    elif (
        counts[TASK_STATUS_ASSESS_COMPLETED_HAS_FAILURE] > 0
        or counts[TASK_STATUS_ASSESS_FAILURED] > 0
        or (counts[TASK_STATUS_ASSESS_COMPLETED_NO_FAILURE] + counts[TASK_STATUS_NOT_EXIST]) < total
    ):
        label = "评估完成存在失败"
    else:
        label = "评估完成不存在失败"

    return {
        "10": counts[TASK_STATUS_ASSEESSING_HAS_FAILURE],
        "20": counts[TASK_STATUS_ASSEESSING_NO_FAILURE],
        "25": counts[TASK_STATUS_ASSESS_PAUSE],
        "30": counts[TASK_STATUS_ASSESS_FAILURED],
        "40": counts[TASK_STATUS_ASSESS_COMPLETED_HAS_FAILURE],
        "50": counts[TASK_STATUS_ASSESS_NEED_TO_DO],
        "60": counts[TASK_STATUS_ASSESS_COMPLETED_NO_FAILURE],
        "9906": counts[TASK_STATUS_NOT_EXIST],
        "total": total,
        "label": label,
    }


# ─────────────────────────────────────────────────────────────
# 模板 2：任务状态查询
# ─────────────────────────────────────────────────────────────

def render_status_template(company_name: str, company_id: str, summary: dict) -> str:
    total = summary["total"]
    done = (summary["60"] + summary["40"] + summary["30"] + summary["9906"])
    in_progress = (summary["10"] + summary["20"] + summary["25"] + summary["50"])
    all_terminal = done == total and total > 0
    all_not_exist = summary["9906"] == total and total > 0

    # 全部任务不存在的特殊分支
    if all_not_exist:
        lines = [
            "⚠️ 未找到任务",
            f"客户：{company_name or '未知'}",
            f"company_id：{company_id or '未知'}",
            "所有 task_id 均不存在（可能已过期或被清理）。",
            "请确认是否需要重新下发。",
        ]
        return "\n".join(lines)

    lines = [
        "📊 策略检查任务状态",
        f"客户：{company_name or '未知'}（company_id={company_id or '未知'}）",
        f"任务总数：{total}",
        "",
        "状态分布：",
        f"  ✅ 评估完成（无失败）：{summary['60']}",
        f"  ⚠️ 评估完成（存在失败）：{summary['40']}",
        f"  ❌ 评估失败：{summary['30']}",
        f"  ⚪ 任务不存在：{summary['9906']}",
        f"  ⏳ 进行中（待评估/评估中/暂停）：{in_progress}",
        "",
        f"整体：{summary['label']}",
    ]
    if all_terminal:
        lines.append("")
        lines.append('可问我：「查询策略检查结果」查看详情')
    else:
        lines.append("")
        lines.append("任务还在跑，稍后再问我一次状态")
    return "\n".join(lines)


def render_status_fail(company_name: str, err: Exception) -> str:
    return "\n".join([
        "❌ 任务状态查询失败",
        f"客户：{company_name or '未知'}",
        f"原因：{err}",
        "",
        "请稍后重试，或检查 task_ids 是否有效。",
    ])


# ─────────────────────────────────────────────────────────────
# 主流程
# ─────────────────────────────────────────────────────────────

def query_status_once(cookie: str, task_ids: list, company_name: str = "") -> dict:
    """查一次状态，返回 summary dict。"""
    if not task_ids:
        raise RuntimeError("task_ids 为空，无法查询")

    log(f"[Phase 2] 查询 {len(task_ids)} 个任务状态...")
    notify("2-1", "查询中", f"正在查询 {len(task_ids)} 个任务状态...", company_name)

    data = query_task_status(cookie, task_ids)
    status_map = {tid: TASK_STATUS_INITIAL for tid in task_ids}
    for item in data:
        tid = item.get("task_id")
        ts = item.get("task_status")
        if tid and ts is not None:
            status_map[tid] = ts
    summary = _build_summary(status_map)
    log(f"[Phase 2] 状态汇总: {summary}")
    return summary


def main():
    parser = argparse.ArgumentParser(description="查询策略检查任务状态（单次查询）")
    parser.add_argument("--task-ids", type=str, default=None,
                        help="任务 ID 列表，JSON 字符串，如 '[\"id1\",\"id2\"]'；不传则读 cache/last_session.json")
    parser.add_argument("--company-name", type=str, default=None, help="公司名（通知用）；不传则读 cache")
    parser.add_argument("--company-id", type=str, default=None, help="公司 ID；不传则读 cache")
    args = parser.parse_args()

    # 优先用命令行参数；缺则读 cache
    task_ids = None
    company_name = args.company_name
    company_id = args.company_id

    if args.task_ids:
        try:
            task_ids = json.loads(args.task_ids)
        except Exception as e:
            log(f"--task-ids JSON 解析失败: {e}", "ERROR")
            print(render_status_fail(company_name or "", e))
            sys.exit(1)
    else:
        sess = load_session()
        if sess is None:
            print(render_status_fail("", RuntimeError("无 session 缓存，请先执行下发或指定 --task-ids")))
            sys.exit(1)
        task_ids = sess.get("task_ids") or []
        if not company_name:
            company_name = sess.get("company_name", "")
        if not company_id:
            company_id = sess.get("company_id", "")

    try:
        cookie = get_cookie()
    except Exception as e:
        print(render_status_fail(company_name or "", e))
        sys.exit(1)

    try:
        summary = query_status_once(cookie, task_ids, company_name)
        # 通知（精简，不重复模板内容）
        label = summary["label"]
        done = summary["60"] + summary["40"] + summary["30"] + summary["9906"]
        notify("2-2", "已完成" if done == summary["total"] else "查询完成",
               f"label={label}, 已完成 {done}/{summary['total']}", company_name)
        print(render_status_template(company_name, company_id, summary))
        sys.exit(0)
    except Exception as e:
        log(f"Phase 2 异常: {e}", "ERROR")
        notify("2-异常", "失败", str(e), company_name)
        print(render_status_fail(company_name or "", e))
        sys.exit(1)


if __name__ == "__main__":
    main()
