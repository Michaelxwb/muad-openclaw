#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 1 前置：获取设备 ID 列表

调用 SOAR APEX 设备列表 API 获取公司下所有安全设备的 dev_id 列表。
API: POST http://mssw-inner.sangfor.com.cn:30001/api/apex/device/v1/devices/list
Header: x-mssw-company-id

muad 改造：登录态/请求统一走 shared。
"""

import sys
import os

import uuid

# 确保 policy-check 根目录在 sys.path 最前面
POLICY_CHECK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if POLICY_CHECK_ROOT not in sys.path:
    sys.path.insert(0, POLICY_CHECK_ROOT)
sys.dont_write_bytecode = True

from shared import (  # noqa: E402
    log,
    get_cookie,
    request_with_retry,
    extract_cookie_value,
    get_endpoint,
    get_base,
    get_host_header,
)

DEVICE_INFO_URL = get_endpoint("device_info")


def get_dev_id_list(cookie: str, company_id: str):
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
    log(f"获取设备信息 company_id={company_id}")

    headers = {
        "accept": "application/json, text/javascript, */*; q=0.01",
        "content-type": "application/json",
        "cookie": cookie,
        "host": get_host_header(),
        "referer": get_base("soar_referer"),
        "traceid": str(uuid.uuid4()),
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
        "x-csrftoken": extract_cookie_value(cookie, "csrf_token") or "",
        "x-requested-with": "XMLHttpRequest",
        "x-mssw-company-id": company_id,
    }

    payload = {
        "keyword": "",
        "type": 0,
        "devStatus": [1, 2, 3, 4],
    }

    try:
        response = request_with_retry("POST", DEVICE_INFO_URL, headers, timeout=30, json=payload)
        result = response.json()

        if result.get("code") != "Success":
            raise RuntimeError(f"API 返回错误: {result.get('message', result)}")

        data = result.get("data", {})
        device_list_raw = data.get("list", [])
        total = data.get("total", 0)

        log(f"设备总数: {total}")

        if not device_list_raw:
            raise RuntimeError(f"设备列表为空，公司 {company_id} 没有可用的安全设备")

        # 新接口返回 camelCase 字段，转换为 snake_case 供下游使用
        field_mapping = {
            "devId": "dev_id",
            "devName": "dev_name",
            "devType": "dev_type",
            "devStatus": "status",
            "devIp": "dev_ip",
            "branchName": "branch_name",
            "devVersion": "dev_version",
            "gatewayId": "gateway_id",
            "companyId": "company_id",
            "devAccessId": "dev_access_id",
        }
        device_list = []
        for device in device_list_raw:
            mapped = {}
            for camel_key, snake_key in field_mapping.items():
                if camel_key in device:
                    mapped[snake_key] = device[camel_key]
            for key in device:
                mapped[key] = device[key]
            device_list.append(mapped)

        dev_id_list = [
            device.get("dev_id") for device in device_list if device.get("dev_id") is not None
        ]
        log(f"提取到 {len(dev_id_list)} 个设备 ID")
        return dev_id_list, device_list

    except Exception as e:
        raise RuntimeError(f"获取设备 ID 异常: {e}") from e


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="获取设备 ID 列表")
    parser.add_argument("--company-id", type=str, required=True, help="公司 ID")
    parser.add_argument("-c", "--cookie", type=str, default=None, help="Cookie 字符串")

    args = parser.parse_args()

    cookie = args.cookie or get_cookie()
    if not cookie:
        log("请提供 Cookie", "ERROR")
        sys.exit(1)

    try:
        dev_ids, _ = get_dev_id_list(cookie, args.company_id)
        print(f"dev_ids: {dev_ids}")
    except Exception as e:
        log(f"失败: {e}", "ERROR")
        sys.exit(1)
