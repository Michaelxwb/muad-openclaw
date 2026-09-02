#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 4 — 查询策略检查结果并生成话术（独立入口，按需调用）

查询入参参考 policy_check_export.py：
  - latest_time: [start_utc, end_utc] ISO 8601 UTC 字符串数组
  - company_id / dev_id_list / limit / offset
  - data 直接是 list（不再是 data.list 嵌套）

两种调用方式：
  1. 不带参数（自动读 cache/last_session.json，时间窗默认最近 7 天）：
     python phase4/phase4_generate_message.py
  2. 带参数：
     python phase4/phase4_generate_message.py --company-id 12345 --dev-ids '[338,222]' \\
         --start "2026-08-01" --end "2026-08-07"
"""

import sys
import os
import uuid
import json
import argparse
import warnings
from datetime import datetime, timedelta, timezone
from typing import Optional

warnings.filterwarnings('ignore', message='Unverified HTTPS request')

POLICY_CHECK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if POLICY_CHECK_ROOT not in sys.path:
    sys.path.insert(0, POLICY_CHECK_ROOT)

from shared import log, get_cookie, extract_cookie_value, get_endpoint, get_base, get_origin, load_session
import requests

POLICY_LIST_URL = get_endpoint("policy_list")
REPORTS_DIR = os.path.join(POLICY_CHECK_ROOT, "reports")
PAGE_SIZE = 100

# 设备类型映射（参考 policy_check_export.py 的 DEV_TYPE_DICT）
DEV_TYPE_DICT = {
    3: "AF",
    9: "SIP",
    12: "EDR",
    25: "STA",
    72: "云镜-服务版",
    50038: "EDR-探针版",
    19: "aTrust",
    2: "AC",
    15: "云镜",
    100012: "SAAS EDR",
    69: "SaaS NGES",
    37: "CWPP",
    100038: "SaaS-EDR-探针版",
}


def notify(phase: str, status: str, detail: str = "", company_name: str = ""):
    log(f"[通知] {phase} | {status} | {detail}")
    try:
        from shared.notify import send_notification
        send_notification(phase, status, detail, company_name=company_name)
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


# ─────────────────────────────────────────────────────────────
# 时间解析（参考 policy_check_export.py）
# ─────────────────────────────────────────────────────────────

def _parse_datetime(text: str) -> datetime:
    """支持 YYYY-MM-DD 或 YYYY-MM-DD HH:MM:SS，按本地时区解析。"""
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            naive = datetime.strptime(text, fmt)
            local_tz = datetime.now().astimezone().tzinfo or timezone(timedelta(hours=8))
            return naive.replace(tzinfo=local_tz)
        except ValueError:
            continue
    raise ValueError(f"无法解析日期: {text}，请使用 YYYY-MM-DD 或 YYYY-MM-DD HH:MM:SS 格式")


def _build_time_range(start_str: str, end_str: str) -> list:
    """返回 [start_utc_iso, end_utc_iso]。"""
    start_dt = _parse_datetime(start_str)
    end_dt = _parse_datetime(end_str)
    # 若 end 只有日期，补到当天最后一秒
    if end_dt.hour == 0 and end_dt.minute == 0 and end_dt.second == 0:
        end_dt = end_dt.replace(hour=23, minute=59, second=59)
    utc = timezone.utc
    return [
        start_dt.astimezone(utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        end_dt.astimezone(utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    ]


# ─────────────────────────────────────────────────────────────
# 数据拉取（参考 policy_check_export.py fetch_data）
# ─────────────────────────────────────────────────────────────

def fetch_policy_results(cookie: str, company_id: str, dev_id_list: list,
                         start_str: str, end_str: str) -> list:
    """分页拉取策略检查结果。"""
    headers = _build_headers(cookie)
    time_range = _build_time_range(start_str, end_str)
    log(f"时间过滤范围（UTC）: {time_range}")

    all_records = []
    offset = 0
    while True:
        payload = {
            "company_id": company_id,
            "limit": PAGE_SIZE,
            "offset": offset,
            "latest_time": time_range,
        }
        if dev_id_list:
            payload["dev_id_list"] = dev_id_list

        log(f"请求策略结果: offset={offset}, limit={PAGE_SIZE}")
        response = requests.post(POLICY_LIST_URL, headers=headers, json=payload, timeout=30, verify=False)
        if response is None:
            raise RuntimeError(f"请求返回为空 (offset={offset})")

        result = response.json()
        if result.get("code") != 0:
            raise RuntimeError(f"API 返回错误: {result.get('msg', result)} (offset={offset})")

        data = result.get("data", [])
        # 兼容 data 直接是 list 或 data.list 两种返回结构
        if isinstance(data, list):
            records = data
        elif isinstance(data, dict):
            records = data.get("list", [])
        else:
            records = []

        if not records:
            break

        # dev_type 数字映射成可读字符串
        for item in records:
            item["dev_type"] = DEV_TYPE_DICT.get(item.get("dev_type")) or item.get("dev_type") or ""

        all_records.extend(records)
        if len(records) < PAGE_SIZE:
            break
        offset += PAGE_SIZE

    log(f"过滤完成: 共 {len(all_records)} 条策略结果")
    return all_records


# ─────────────────────────────────────────────────────────────
# 模板 3：策略检查结果
# ─────────────────────────────────────────────────────────────

def _group_by_dev_type(items: list) -> dict:
    """按 dev_type 字符串分组，返回 {dev_type: [items]}。"""
    by_type = {}
    for item in items:
        dt = item.get("dev_type") or "未知"
        by_type.setdefault(dt, []).append(item)
    return by_type


def render_results_template(company_name: str, company_id: str,
                            start_str: str, end_str: str,
                            records: list) -> str:
    total = len(records)

    # 空结果
    if total == 0:
        return "\n".join([
            "✅ 策略检查结果为空",
            f"客户：{company_name or '未知'}",
            f"时间范围：{start_str} ~ {end_str}",
            "未查询到任何策略检查结果。",
            "可能原因：任务刚下发尚未完成 / 时间范围未覆盖 / 无风险项。",
        ])

    # 分类
    failed_items = [it for it in records if it.get("policy_status", "") == "策略获取失败"]
    expired_items = [it for it in records
                     if "已过期" in it.get("policy_status", "") or "授权未开通" in it.get("policy_status", "")]
    other_items = [it for it in records
                   if it not in failed_items and it not in expired_items]
    risk_count = sum(1 for it in records if it.get("risk_status") == "at_risk")

    lines = [
        "📋 策略检查结果",
        f"客户：{company_name or '未知'}（company_id={company_id or '未知'}）",
        f"查询时间范围：{start_str} ~ {end_str}",
        f"总条目：{total}（其中风险项 {risk_count} 条）",
        "",
    ]

    # 【1】策略获取失败
    if failed_items:
        lines.append(f"【1】策略获取失败（{len(failed_items)} 条）")
        by_type = _group_by_dev_type(failed_items)
        for dt, items in by_type.items():
            lines.append(f"{dt}（{len(items)} 条）")
            for idx, it in enumerate(items, 1):
                dn = it.get("dev_name", "未知设备")
                nm = it.get("name", "未知策略")
                lines.append(f"  {idx}. {dn} → {nm}")
        lines.append("")

    # 【2】授权过期/未开通
    if expired_items:
        lines.append(f"【2】授权过期/未开通（{len(expired_items)} 条）")
        by_type = _group_by_dev_type(expired_items)
        for dt, items in by_type.items():
            lines.append(f"{dt}（{len(items)} 条）")
            for idx, it in enumerate(items, 1):
                dn = it.get("dev_name", "未知设备")
                nm = it.get("name", "未知策略")
                ps = it.get("policy_status", "")
                lines.append(f"  {idx}. {dn} → {nm} → {ps}")
        lines.append("")

    # 【3】其他风险项
    if other_items:
        lines.append(f"【3】其他风险项（{len(other_items)} 条，按设备类型分组）")
        by_type = _group_by_dev_type(other_items)
        for dt in sorted(by_type.keys()):
            items = by_type[dt]
            lines.append("")
            lines.append(f"{dt}（{len(items)} 条）")
            for idx, it in enumerate(items, 1):
                dn = it.get("dev_name", "未知设备")
                desc = (it.get("risk_desc") or it.get("description") or "").strip()
                lines.append(f"  {idx}. 【{dn}】{desc}")

    return "\n".join(lines)


def render_results_fail(company_name: str, err: Exception) -> str:
    return "\n".join([
        "❌ 策略检查结果查询失败",
        f"客户：{company_name or '未知'}",
        f"原因：{err}",
        "",
        "请稍后重试，或检查任务是否已完成。",
    ])


# ─────────────────────────────────────────────────────────────
# 主流程
# ─────────────────────────────────────────────────────────────

def generate_policy_message(
    cookie: str,
    company_id: str,
    dev_id_list: list,
    start_str: str,
    end_str: str,
    company_name: str = "",
) -> str:
    """查询策略结果并生成精简文本模板。"""
    log("=" * 50)
    log("Phase 4: 查询策略检查结果")
    log(f"company_id={company_id}, 设备数={len(dev_id_list)}, 时间={start_str} ~ {end_str}")
    log("=" * 50)

    try:
        records = fetch_policy_results(cookie, company_id, dev_id_list, start_str, end_str)
    except Exception as e:
        notify("4", "失败", f"获取策略结果失败: {e}", company_name)
        raise

    notify("4", "完成", f"获取到 {len(records)} 条策略结果", company_name)

    # 落盘完整 JSON（备用，模板里不展示）
    os.makedirs(REPORTS_DIR, exist_ok=True)
    result_path = os.path.join(REPORTS_DIR, f"policy_results_{company_id}.json")
    try:
        with open(result_path, "w", encoding="utf-8") as f:
            json.dump(records, f, ensure_ascii=False, indent=2)
        log(f"策略结果已保存: {result_path}")
    except Exception as e:
        log(f"[WARN] 保存 JSON 失败: {e}", "WARN")

    return render_results_template(company_name, company_id, start_str, end_str, records)


def main():
    parser = argparse.ArgumentParser(description="查询策略检查结果并生成话术")
    parser.add_argument("--company-id", type=str, default=None, help="公司 ID；不传则读 cache")
    parser.add_argument("--dev-ids", type=str, default=None,
                        help="设备 ID 列表，JSON 数组如 '[338,222]'；不传则读 cache（若有）")
    parser.add_argument("--start", type=str, default=None,
                        help="开始时间 YYYY-MM-DD 或 YYYY-MM-DD HH:MM:SS；不传默认 7 天前")
    parser.add_argument("--end", type=str, default=None,
                        help="结束时间 YYYY-MM-DD 或 YYYY-MM-DD HH:MM:SS；不传默认今天")
    parser.add_argument("--company-name", type=str, default=None, help="公司名（通知用）；不传则读 cache")
    args = parser.parse_args()

    # ── 解析参数 / cache 兜底 ──
    company_id = args.company_id
    company_name = args.company_name
    dev_id_list = None

    if args.dev_ids:
        try:
            dev_id_list = json.loads(args.dev_ids)
        except Exception as e:
            print(render_results_fail(company_name or "", e))
            sys.exit(1)

    if company_id is None or company_name is None or dev_id_list is None:
        sess = load_session()
        if sess:
            if company_id is None:
                company_id = sess.get("company_id")
            if company_name is None:
                company_name = sess.get("company_name", "")
            if dev_id_list is None:
                dev_id_list = sess.get("dev_id_list") or []

    if not company_id:
        print(render_results_fail("", RuntimeError("缺少 company_id，请指定 --company-id 或先执行下发")))
        sys.exit(1)

    # ── 时间默认值 ──
    tz_local = datetime.now().astimezone().tzinfo or timezone(timedelta(hours=8))
    now = datetime.now(tz_local)
    end_str = args.end or now.strftime("%Y-%m-%d")
    start_str = args.start or (now - timedelta(days=7)).strftime("%Y-%m-%d")

    try:
        cookie = get_cookie()
    except Exception as e:
        print(render_results_fail(company_name or "", e))
        sys.exit(1)

    try:
        message = generate_policy_message(
            cookie=cookie,
            company_id=company_id,
            dev_id_list=dev_id_list or [],
            start_str=start_str,
            end_str=end_str,
            company_name=company_name or "",
        )
        print(message)
        sys.exit(0)
    except Exception as e:
        log(f"Phase 4 异常: {e}", "ERROR")
        notify("4-异常", "失败", str(e), company_name)
        print(render_results_fail(company_name or "", e))
        sys.exit(1)


if __name__ == "__main__":
    main()
