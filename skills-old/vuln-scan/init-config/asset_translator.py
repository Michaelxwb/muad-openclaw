#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
资产 ID ↔ IP 双向翻译脚本
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "run-vuln-scan"))
from shared import get_cookie, COMPANY_LIST_HEADERS, request_with_retry, log

BUSINESS_INFO_URL = "https://soar.sangfor.com.cn/gateway/vuln-manager/vm/order/v1/vulnmgr/task/business_info"


def fetch_all_assets(company_id: str, limit: int = 50) -> list:
    """分页拉取指定 company_id 的全部资产列表（原始 list）"""
    cookie = get_cookie()
    if not cookie:
        log("未找到 Cookie", "ERROR")
        sys.exit(1)

    all_assets = []
    offset = 0

    while True:
        payload = {
            "order": "asc",
            "offset": offset,
            "limit": limit,
            "company_id": company_id
        }
        headers = COMPANY_LIST_HEADERS.copy()
        headers["Cookie"] = cookie

        response = request_with_retry("POST", BUSINESS_INFO_URL, headers=headers, json=payload)
        if response is None:
            log("请求资产列表失败", "ERROR")
            sys.exit(1)

        try:
            result = response.json()
        except Exception as e:
            log(f"JSON 解析失败: {e}", "ERROR")
            sys.exit(1)

        if result.get("code") != 0:
            log(f"API 返回错误: {result}", "ERROR")
            sys.exit(1)

        data = result.get("data", {})
        total = data.get("total", 0)
        page_list = data.get("list", [])

        all_assets.extend(page_list)

        if offset + limit >= total:
            break

        offset += limit

    return all_assets


def _build_ip_to_asset_id_dict(assets: list) -> dict:
    """构建 {ip: asset_id} 字典"""
    return {a["asset"]: a["asset_id"] for a in assets}


def _build_asset_id_to_ip_dict(assets: list) -> dict:
    """构建 {asset_id: ip} 字典"""
    return {a["asset_id"]: a["asset"] for a in assets}


def asset_id_to_ip(company_id: str, asset_id_list: list) -> list:
    """
    将 asset_id 列表翻译为 IP 列表。

    Args:
        company_id: 公司 ID
        asset_id_list: asset_id 列表

    Returns:
        IP 列表（顺序与输入 asset_id_list 对应，未找到的为 None）
    """
    assets = fetch_all_assets(company_id)
    lookup = _build_asset_id_to_ip_dict(assets)

    result = []
    for aid in asset_id_list:
        result.append(lookup.get(aid))
    return result


def ip_to_asset_id(company_id: str, ip_list: list) -> list:
    """
    将 IP 列表翻译为 asset_id 列表。

    Args:
        company_id: 公司 ID
        ip_list: IP 列表

    Returns:
        asset_id 列表（顺序与输入 ip_list 对应，未找到的为 None）
    """
    assets = fetch_all_assets(company_id)
    lookup = _build_ip_to_asset_id_dict(assets)

    result = []
    for ip in ip_list:
        result.append(lookup.get(ip))
    return result


# ---------------------------------------------------------------------------
# 快捷测试入口
# ---------------------------------------------------------------------------

