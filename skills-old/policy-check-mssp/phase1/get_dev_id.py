#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 1 前置：获取设备 ID 列表

调用 SOAR API 获取公司下所有安全设备的 dev_id 列表。
API: POST https://soar.sangfor.com.cn/order/v1/policy_check/show_device_info
"""

import sys
import os
import uuid
import warnings

warnings.filterwarnings('ignore', message='Unverified HTTPS request')

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from shared import log

DEVICE_INFO_URL = "https://soar.sangfor.com.cn/order/v1/policy_check/show_device_info"


def _get_cookie() -> str:
    """复用 vuln-scan shared 的 get_cookie"""
    VULNSCAN = r"C:\Users\User\.openclaw\workspace\skills\vuln-scan\run-vuln-scan"
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "vuln_shared", os.path.join(VULNSCAN, "shared", "__init__.py")
    )
    vuln_shared = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(vuln_shared)
    return vuln_shared.get_cookie()


def _extract_csrf(cookie: str) -> str:
    """从 Cookie 中提取 csrf_token"""
    VULNSCAN = r"C:\Users\User\.openclaw\workspace\skills\vuln-scan\run-vuln-scan"
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "vuln_shared", os.path.join(VULNSCAN, "shared", "__init__.py")
    )
    vuln_shared = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(vuln_shared)
    return vuln_shared.extract_cookie_value(cookie, "csrf_token") or ""


def get_dev_id_list(cookie: str, company_id: str) -> list:
    """
    获取公司下所有安全设备的 dev_id 列表。

    Args:
        cookie: Cookie 字符串
        company_id: 公司 ID

    Returns:
        tuple: (dev_id_list, device_list) 设备ID列表和原始设备列表

    Raises:
        如果获取失败或设备列表为空，打印错误并退出
    """
    import requests

    log(f"获取设备信息 company_id={company_id}")

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
        "x-csrftoken": _extract_csrf(cookie),
        "x-requested-with": "XMLHttpRequest",
    }

    payload = {
        "company_id": company_id,
    }

    try:
        response = requests.post(DEVICE_INFO_URL, headers=headers, json=payload, timeout=30, verify=False)

        if response is None:
            log("获取设备信息请求失败", "ERROR")
            sys.exit(1)

        result = response.json()

        if result.get("code") != 0:
            log(f"API 返回错误: {result.get('msg', result)}", "ERROR")
            sys.exit(1)

        data = result.get("data", {})
        device_list = data.get("list", [])
        total = data.get("total", 0)

        log(f"设备总数: {total}")

        if not device_list:
            log(f"设备列表为空，公司 {company_id} 没有可用的安全设备", "ERROR")
            sys.exit(1)

        # 提取所有设备的 dev_id
        dev_id_list = []
        for device in device_list:
            dev_id = device.get("dev_id")
            dev_type = device.get("dev_type", "Unknown")
            dev_name = device.get("dev_name", "Unknown")
            status = device.get("status", "unknown")

            if dev_id is not None:
                dev_id_list.append(dev_id)
                log(f"  [{dev_type}] {dev_name} (dev_id={dev_id}, status={status})")

        log(f"提取到 {len(dev_id_list)} 个设备 ID")
        return dev_id_list, device_list

    except Exception as e:
        log(f"获取设备 ID 异常: {e}", "ERROR")
        sys.exit(1)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="获取设备 ID 列表")
    parser.add_argument("--company-id", type=str, required=True, help="公司 ID")
    parser.add_argument("-c", "--cookie", type=str, default=None, help="Cookie 字符串")

    args = parser.parse_args()

    cookie = args.cookie or _get_cookie()
    if not cookie:
        log("请提供 Cookie", "ERROR")
        sys.exit(1)

    dev_ids, _ = get_dev_id_list(cookie, args.company_id)
    print(f"\n设备 ID 列表: {dev_ids}")
    print(f"共 {len(dev_ids)} 个设备")
