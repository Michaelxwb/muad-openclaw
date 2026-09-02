#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 1：下发策略检查任务

API: POST https://soar.sangfor.com.cn/order/v1/policy_check/distribute_task
Payload: {"company_id":"50655704","dev_id":[338434,222067,338398,45782]}
"""

import sys
import os
import uuid
import warnings

warnings.filterwarnings('ignore', message='Unverified HTTPS request')

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from shared import log

DISTRIBUTE_TASK_URL = "https://soar.sangfor.com.cn/order/v1/policy_check/distribute_task"


def _get_soar_helpers():
    """懒加载 vuln-scan shared 模块"""
    VULNSCAN = r"C:\Users\User\.openclaw\workspace\skills\vuln-scan\run-vuln-scan"
    if VULNSCAN not in sys.path:
        sys.path.insert(0, VULNSCAN)
    # 用 importlib 精确指定路径，避免和本地 shared 冲突
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "vuln_shared",
        os.path.join(VULNSCAN, "shared", "__init__.py")
    )
    vuln_shared = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(vuln_shared)
    return vuln_shared.get_cookie, vuln_shared.extract_cookie_value


def distribute_policy_check_task(cookie: str, company_id: str, dev_id_list: list) -> dict:
    """
    下发策略检查任务。

    Args:
        cookie: SOAR 平台 Cookie
        company_id: 公司 ID
        dev_id_list: 设备 ID 列表

    Returns:
        API 返回的 JSON
    """
    import requests

    get_cookie_fn, extract_cookie_value = _get_soar_helpers()

    log(f"下发策略检查任务: company_id={company_id}, 设备数={len(dev_id_list)}")

    if not dev_id_list:
        log("设备列表为空，无法创建策略检查任务", "ERROR")
        sys.exit(1)

    headers = {
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

    payload = {
        "company_id": company_id,
        "dev_id": dev_id_list,
    }

    try:
        response = requests.post(DISTRIBUTE_TASK_URL, headers=headers, json=payload, timeout=30, verify=False)

        if response is None:
            log("下发策略检查任务请求失败", "ERROR")
            sys.exit(1)

        result = response.json()

        if result.get("code") != 0:
            log(f"API 返回错误: {result.get('msg', result)}", "ERROR")
            sys.exit(1)

        log(f"策略检查任务下发成功: {result.get('msg', 'ok')}")
        return result

    except Exception as e:
        log(f"下发策略检查任务异常: {e}", "ERROR")
        sys.exit(1)


if __name__ == "__main__":
    import argparse

    # 确保 vuln-scan shared 路径已在 sys.path 中
    VULNSCAN = r"C:\Users\User\.openclaw\workspace\skills\vuln-scan\run-vuln-scan"
    if VULNSCAN not in sys.path:
        sys.path.insert(0, VULNSCAN)

    get_cookie_fn, _ = _get_soar_helpers()

    parser = argparse.ArgumentParser(description="下发策略检查任务")
    parser.add_argument("--company-id", type=str, required=True, help="公司 ID")
    parser.add_argument("--dev-ids", type=str, required=True, help="设备 ID 列表，逗号分隔，如 338434,222067")
    parser.add_argument("-c", "--cookie", type=str, default=None, help="Cookie 字符串")

    args = parser.parse_args()

    cookie = args.cookie or get_cookie_fn()
    if not cookie:
        log("请提供 Cookie", "ERROR")
        sys.exit(1)

    dev_id_list = [int(x.strip()) for x in args.dev_ids.split(",") if x.strip()]
    result = distribute_policy_check_task(cookie, args.company_id, dev_id_list)
    print(f"\n{result}")
