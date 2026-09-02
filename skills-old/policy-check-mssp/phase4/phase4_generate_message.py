#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 4 — 生成策略检查话术

流程：
  1. 调用策略结果列表 API，分页遍历所有记录
  2. 过滤 latest_time 在 [昨天 00:00:00, 明天 00:00:00) 范围内的条目
  3. 提取 dev_name、dev_type、description、policy_status 字段
  4. 基于结果生成话术文本，推送到企微群

API: POST https://soar.sangfor.com.cn/order/v1/policy_check/policy?_method=GET
"""

import sys
import os
import uuid
import json
import subprocess
import warnings
from datetime import datetime, timedelta, timezone
from typing import Optional

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

# ── API 端点 ──
POLICY_LIST_URL = "https://soar.sangfor.com.cn/order/v1/policy_check/policy?_method=GET"

# ── 路径 ──
REPORTS_DIR = os.path.join(POLICY_CHECK_ROOT, "reports")
NOTIFY_SCRIPT = os.path.join(POLICY_CHECK_ROOT, "shared", "notify.py")


def notify(phase: str, status: str, detail: str = "", company_name: str = ""):
    """发送企微通知"""
    log(f"[通知] {phase} | {status} | {detail}")
    try:
        from shared.notify import send_notification
        send_notification(phase, status, detail, company_name=company_name)
    except Exception as e:
        log(f"通知发送失败: {e}", "WARN")


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


def _get_time_range():
    """
    返回 (yesterday_start_str, tomorrow_start_str)
    格式: "2026-06-03 00:00:00"
    """
    tz = timezone(timedelta(hours=8))
    now = datetime.now(tz)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    yesterday_start = today_start - timedelta(days=1)
    tomorrow_start = today_start + timedelta(days=1)

    yesterday_str = yesterday_start.strftime("%Y-%m-%d %H:%M:%S")
    tomorrow_str = tomorrow_start.strftime("%Y-%m-%d %H:%M:%S")

    log(f"时间过滤范围: [{yesterday_str}, {tomorrow_str})")
    return yesterday_str, tomorrow_str


def _parse_latest_time(item: dict) -> Optional[str]:
    """
    从策略结果条目中提取 latest_time 字符串。
    latest_time 可能是 list（如 ["2023-12-29 00:46:02"]）或 str。
    取第一个元素。
    """
    lt = item.get("latest_time")
    if lt is None:
        return None
    if isinstance(lt, list):
        if len(lt) == 0 or not lt[0]:
            return None
        return str(lt[0])
    return str(lt)


def fetch_policy_results(cookie: str, company_id: str, dev_id_list: list) -> list:
    """
    分页遍历策略结果列表，过滤 latest_time 在 [昨天00:00, 明天00:00) 的条目。

    Args:
        cookie: SOAR Cookie
        company_id: 公司 ID
        dev_id_list: 设备 ID 列表

    Returns:
        [{dev_name, dev_type, description, policy_status}, ...]
    """
    yesterday_str, tomorrow_str = _get_time_range()
    headers = _build_headers(cookie)

    all_filtered = []
    offset = 0
    limit = 100
    policy_set = set()
    while True:
        payload = {
            "order": {"latest_time": "desc"},
            "offset": offset,
            "limit": limit,
            "company_id": company_id,
            "dev_id": dev_id_list,
            "status": "at_risk",
        }

        log(f"请求策略结果: offset={offset}, limit={limit}")
        response = requests.post(POLICY_LIST_URL, headers=headers, json=payload, timeout=30, verify=False)

        if response is None:
            raise RuntimeError(f"请求返回为空 (offset={offset})")

        result = response.json()

        if result.get("code") != 0:
            raise RuntimeError(f"API 返回错误: {result.get('msg', result)} (offset={offset})")

        data = result.get("data", {})
        total = data.get("total", 0)
        page_list = data.get("list", [])
        page_count = len(page_list)

        log(f"  本页: {page_count} 条, 累计 total={total}")
        
        
        # 遍历当前页，过滤 latest_time
        for item in page_list:
            lt = _parse_latest_time(item)
            if lt is None:
                continue

            # 比较字符串（时间格式统一为 "YYYY-MM-DD HH:MM:SS"，可直接字典序比较）
            if yesterday_str <= lt < tomorrow_str:
                item_str = item.get("dev_name", "") + "_" + item.get("name", "") + "_" + item.get("policy_status", "")
                if item_str in policy_set:
                    continue
                policy_set.add(item_str)
                all_filtered.append({
                    "dev_name": item.get("dev_name", ""),
                    "dev_type": item.get("dev_type", ""),
                    "description": item.get("description", ""),
                    "policy_status": item.get("policy_status", ""),
                    "name": item.get("name", "")
                })
                

        # 判断是否还有下一页
        if page_count < limit or offset + limit >= total:
            break

        offset += limit

    log(f"过滤完成: 共 {len(all_filtered)} 条策略结果满足 yesterday <= latest_time < tomorrow")
    return all_filtered


def generate_policy_message(
    cookie: str,
    company_id: str,
    dev_id_list: list,
    task_name: str = "",
    report_path: str = "",
    task_id: str = None,
    company_name: str = "",
) -> str:
    """
    生成策略检查话术。

    Args:
        cookie: SOAR Cookie
        company_id: 公司 ID
        dev_id_list: 设备 ID 列表
        task_name: 任务名
        report_path: 报告文件路径（用于推送附件）
        task_id: 任务的 _id（用于清理 report_info JSON）

    Returns:
        话术文本
    """
    log("=" * 50)
    log("Phase 4: 生成策略检查话术")
    log(f"company_id={company_id}, 设备数={len(dev_id_list)}")
    log("=" * 50)

    label = f"「{task_name}」" if task_name else f"company_id={company_id}"

    # ── Step 1: 获取策略结果列表 ──

    try:
        policy_results = fetch_policy_results(cookie, company_id, dev_id_list)
    except Exception as e:
        notify("4", "失败", f"获取策略结果失败: {e}", company_name)
        raise

    result_count = len(policy_results)

    # ── Step 2: 生成话术 ──
    notify("4", "处理中", f"获取到 {result_count} 条策略结果，生成话术中...", company_name)

    # 分类：策略获取失败 vs 其他
    failed_items = [
        item for item in policy_results
        if item.get("policy_status", "") == "策略获取失败"
    ]
    other_items = [
        item for item in policy_results
        if item.get("policy_status", "") != "策略获取失败"
    ]

    message_lines = []

    # ── 第一段：策略获取失败 ──
    if failed_items:
        message_lines.append(
            f"策略获取失败共{len(failed_items)}条，包含:"
        )
        for idx, item in enumerate(failed_items, 1):
            dev_name = item.get("dev_name", "未知设备")
            name = item.get("name", "未知策略")
            message_lines.append(f"{idx}. {dev_name} --> {name}")
        message_lines.append("")

    # TODO: 第二段、第三段话术待后续补充
    # 暂时把剩余条目统计一下
    if other_items:
        dev_type_stats = {}
        for item in other_items:
            dt = item.get("dev_type", "未知")
            dev_type_stats[dt] = dev_type_stats.get(dt, 0) + 1
        dev_type_summary = "、".join(f"{k} {v}条" for k, v in sorted(dev_type_stats.items()))
        message_lines.append(f"其他风险项共{len(other_items)}条，分布在: {dev_type_summary}")

    message = "\n".join(message_lines)

    # 保存话术
    os.makedirs(REPORTS_DIR, exist_ok=True)
    msg_path = os.path.join(REPORTS_DIR, f"话术_{task_name or company_id}.txt")
    try:
        with open(msg_path, "w", encoding="utf-8") as f:
            f.write(message)
            f.flush()
        log(f"话术已保存: {msg_path}")
    except Exception as e:
        log(f"[WARN] 保存话术失败: {e}", "WARN")

    notify("4", "话术", f"策略检查话术已生成，{result_count} 条结果", company_name)

    # ── Step 3: 推送话术到企微群 ──
    from shared.notify import send_text_to_group

    # 从 task_name 提取公司名作为话术后备（优先用 company_name 参数）
    naming = company_name
    if not naming and task_name:
        import re as _re
        m = _re.match(r'^af策略检查_(.+)_\d{12}$', task_name)
        if m:
            naming = m.group(1)

    prefix = f"【策略检查】【{naming}】话术:\n" if naming else "【策略检查】话术:\n"

    # 第一段：策略获取失败
    if failed_items:
        s1 = [f"策略获取失败共{len(failed_items)}条，包含:"]
        for idx, item in enumerate(failed_items, 1):
            dn = item.get("dev_name", "未知设备")
            nm = item.get("name", "未知策略")
            s1.append(f"{idx}. {dn} --> {nm}")
        msg1 = "\n".join(s1)
        log(f"[话术段1] 策略获取失败 {len(failed_items)} 条")
        send_text_to_group(prefix + msg1)
    else:
        log("[话术段1] 策略获取失败共0条")
        send_text_to_group(prefix + "策略获取失败共0条")

    # 第二段：授权过期/未开通
    expired_items = [
        item for item in policy_results
        if ("已过期" in item.get("policy_status", "")
            or "授权未开通" in item.get("policy_status", ""))
    ]
    if expired_items:
        s2 = [f"授权过期或未开通共{len(expired_items)}条，包含:"]
        for idx, item in enumerate(expired_items, 1):
            dn = item.get("dev_name", "未知设备")
            nm = item.get("name", "未知策略")
            ps = item.get("policy_status", "")
            s2.append(f"{idx}. {dn} --> {nm} --> {ps}")
        msg2 = "\n".join(s2)
        log(f"[话术段2] 授权过期/未开通 {len(expired_items)} 条")
        send_text_to_group(prefix + msg2)
    else:
        log("[话术段2] 授权过期/未开通共0条")
        send_text_to_group(prefix + "授权过期或未开通共0条")

    # 第三段：汇总（排除策略获取失败后，按 dev_type 分组展示）
    # X = 总数 - 策略获取失败数
    summary_items = other_items  # 已排除策略获取失败的剩余条目
    device_count = len(set(item.get("dev_name", "") for item in summary_items if item.get("dev_name")))
    s3 = [f"本次评估共检查 {device_count} 个设备，存在部分可调优项，分别为以下策略："]

    # 按 dev_type 分组
    by_type = {}
    for item in summary_items:
        dt = item.get("dev_type", "未知")
        by_type.setdefault(dt, []).append(item)

    for dt in sorted(by_type.keys()):
        items = by_type[dt]
        s3.append("")  # 空行
        s3.append(dt)  # AF / EDR / SIP / STA
        seq = 1
        for item in items:
            dn = item.get("dev_name", "未知设备")
            desc = item.get("description", "").strip()
            s3.append(f"{seq}、【{dn}】{desc}")
            seq += 1

    msg3 = "\n".join(s3)
    log(f"[话术段3] 汇总: {device_count} 个设备, {len(summary_items)} 条可调优项")
    send_text_to_group(prefix + msg3)

    # ── Step 4: 保存完整策略结果 JSON ──
    result_path = os.path.join(REPORTS_DIR, f"policy_results_{task_name or company_id}.json")
    with open(result_path, "w", encoding="utf-8") as f:
        json.dump(policy_results, f, ensure_ascii=False, indent=2)
    log(f"策略结果列表已保存: {result_path}")

    return message


# ─────────────────────────────────────────────────────────────
# 入口
# ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="生成策略检查话术")
    parser.add_argument("--company-id", required=True, help="公司 ID")
    parser.add_argument("--dev-ids", required=True, help="设备 ID 列表，逗号分隔，如 338434,222067,338398,45782")
    parser.add_argument("--task-name", default="", help="任务名")
    parser.add_argument("--report-path", default="", help="报告文件路径（可选）")
    parser.add_argument("-c", "--cookie", type=str, default=None, help="Cookie 字符串")
    args = parser.parse_args()

    cookie = args.cookie or get_cookie()
    if not cookie:
        log("请提供 Cookie", "ERROR")
        sys.exit(1)

    dev_id_list = [int(x.strip()) for x in args.dev_ids.split(",") if x.strip()]

    try:
        message = generate_policy_message(
            cookie,
            args.company_id,
            dev_id_list,
            args.task_name,
            args.report_path,
        )
        print(f"\n[OK] 策略检查话术生成完成")
        print(f"   结果数: （见上方日志）")
        print(f"\n{message}")
    except Exception as e:
        import traceback
        print(f"\n[FAIL] Phase 4 失败: {e}")
        traceback.print_exc()
        sys.exit(1)
