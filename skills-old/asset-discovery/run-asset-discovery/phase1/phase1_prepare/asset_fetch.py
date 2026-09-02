#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
资产查询脚本 - 分页拉取指定 company_id 的全部资产IP列表

API: https://soar.sangfor.com.cn/gateway/asset-mgr-service/order/v1/asset?_method=GET
循环分页读取，直到全部资产读取完毕，最终返回 IP 列表。
"""
import sys
import os
import uuid
import json
import re
from typing import List

IP_PATTERN = re.compile(
    r"^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}"
    r"(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$"
)
URL_PATTERN = re.compile(
    r"^https?://[^\s/$.?#].[\S]*$",
    re.IGNORECASE
)


def is_valid_asset(asset: str) -> bool:
    if not asset or not isinstance(asset, str):
        return False
    asset = asset.strip()
    return bool(IP_PATTERN.match(asset) or URL_PATTERN.match(asset))

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from shared import (
    log,
    request_with_retry,
    get_cookie,
    extract_cookie_value,
    DEFAULT_HEADERS,
)


ASSET_API_URL = "https://soar.sangfor.com.cn/gateway/asset-mgr-service/order/v1/asset?_method=GET"


def fetch_all_asset_ips(
    company_id: str,
    cookie: str,
    agent_status: List[int] = None,
    service_status: List[int] = None,
    limit: int = 100
) -> List[str]:
    """
    分页拉取全部资产的 IP 列表。

    Args:
        company_id: 公司ID
        cookie: Cookie 字符串
        service_status: 服务状态过滤，默认 [1]
        limit: 每页大小，默认 100

    Returns:
        IP 列表（asset 字段值）
    """
    if service_status is None:
        service_status = [1]
    if agent_status is None:
        agent_status = []

    headers = DEFAULT_HEADERS.copy()
    headers["Cookie"] = cookie
    headers["X-Csrftoken"] = extract_cookie_value(cookie, "csrf_token") or ""
    headers["Traceid"] = str(uuid.uuid4())
    headers["method"] = "get"

    all_ips = []
    offset = 0

    while True:
        payload = {
            "order": "asc",
            "offset": offset,
            "limit": limit,
            "service_status": service_status,
            "is_alive": -1,
            "ip_url_keyword": "",
            "asset_type": [],
            "business_level": [],
            "first_time": [],
            "update_time": [],
            "keyword": "",
            "asset_tag": [],
            "agent_status": agent_status,
            "af_defend_status": "",
            "database": [],
            "middleware": [],
            "os": [],
            "developing_languages": [],
            "development_framework": [],
            "server_port": [],
            "company_id": company_id,
            "asset_group_id": "all"
        }

        log(f"[INFO] 获取资产列表: offset={offset}, limit={limit}, company_id={company_id}", "INFO")

        response = request_with_retry("POST", ASSET_API_URL, headers=headers, json=payload)
        if response is None:
            log("[ERROR] 请求资产列表失败", "ERROR")
            break

        try:
            result = response.json()
        except Exception as e:
            log(f"[ERROR] JSON 解析失败: {e}", "ERROR")
            break

        if result.get("code") != 0:
            log(f"[ERROR] API 返回错误: {result.get('msg', 'Unknown')}", "ERROR")
            break

        data = result.get("data", {})
        total = data.get("total", 0)
        asset_list = data.get("list", [])

        # 提取 IP
        for asset_item in asset_list:
            ip = asset_item.get("asset", "")
            if ip and is_valid_asset(ip):
                all_ips.append(ip.strip())
            elif ip:
                log(f"[WARNING] 过滤非法资产: {ip}", "WARNING")

        log(f"[INFO] 本次获取 {len(asset_list)} 条，累计 {len(all_ips)}/{total}", "INFO")

        # 已全部获取
        if offset + limit >= total:
            log(f"[INFO] 资产列表获取完成，共 {len(all_ips)} 条", "INFO")
            break

        offset += limit

    return all_ips


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="获取资产IP列表")
    parser.add_argument("--company-id", type=str, required=True, help="公司ID")
    parser.add_argument("--service-status", type=str, default="[1]", help="服务状态过滤，JSON格式，如 [1]")
    parser.add_argument("--limit", type=int, default=100, help="每页大小")
    parser.add_argument("-c", "--cookie", type=str, default=None, help="Cookie字符串")

    args = parser.parse_args()

    cookie = get_cookie(args.cookie)
    if not cookie:
        log("请提供 Cookie", "ERROR")
        sys.exit(1)

    try:
        service_status = json.loads(args.service_status)
    except Exception:
        service_status = [1]

    ips = fetch_all_asset_ips(args.company_id, cookie, service_status, args.limit)

    print(f"\n共获取 {len(ips)} 个资产IP：")
    for ip in ips:
        print(f"  {ip}")
    print(f"\nJSON格式:")
    print(json.dumps(ips, ensure_ascii=False, indent=2))