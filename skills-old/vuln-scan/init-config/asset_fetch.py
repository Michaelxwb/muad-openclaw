#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
资产查询脚本 - 按 asset_tag 拉取指定 company_id 的资产IP列表

从资产发现 skill 的 asset_fetch.py 改造而来，供 init-config 业务流使用。
支持传入 asset_tag 过滤，按标签获取资产。
"""
import sys
import os
import uuid
import json
import re
from typing import List, Optional

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


# 添加 shared 模块路径
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "run-vuln-scan"))
from shared import (
    log,
    request_with_retry,
    get_cookie,
    extract_cookie_value,
    DEFAULT_HEADERS,
)


ASSET_API_URL = "https://soar.sangfor.com.cn/gateway/asset-mgr-service/order/v1/asset?_method=GET"


def fetch_assets_by_tag(
    company_id: str,
    cookie: str,
    asset_tag: List[int],
    agent_status: Optional[List[int]] = None,
    service_status: Optional[List[int]] = None,
    limit: int = 100
) -> List[str]:
    """
    按 asset_tag 分页拉取资产 IP 列表。

    Args:
        company_id: 公司ID
        cookie: Cookie 字符串
        asset_tag: 资产标签过滤，如 [3]（安全托管服务）或 [20]（网站监测服务）
        agent_status: agent 状态过滤，默认 []
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
            "asset_tag": asset_tag,
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

        log(f"[INFO] 按 tag={asset_tag} 获取资产: offset={offset}, company_id={company_id}", "INFO")

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

        for asset_item in asset_list:
            ip = asset_item.get("asset", "")
            if ip and is_valid_asset(ip):
                all_ips.append(ip.strip())
            elif ip:
                log(f"[WARNING] 过滤非法资产: {ip}", "WARNING")

        log(f"[INFO] 本次获取 {len(asset_list)} 条，累计 {len(all_ips)}/{total}", "INFO")

        if offset + limit >= total:
            log(f"[INFO] 按 tag={asset_tag} 资产获取完成，共 {len(all_ips)} 条", "INFO")
            break

        offset += limit

    return all_ips
