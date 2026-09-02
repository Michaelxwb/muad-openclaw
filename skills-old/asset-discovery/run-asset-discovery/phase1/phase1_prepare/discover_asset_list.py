#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
资产发现任务详情 - 分页拉取指定任务的所有资产IP列表

URL: https://soar.sangfor.com.cn/gateway/vuln-manager/vm/order/v1/vulnmgr/task/asset-list
循环分页读取，直到全部读完，去重后返回 discover_asset_list。
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


TASK_ASSET_LIST_URL = "https://soar.sangfor.com.cn/gateway/vuln-manager/vm/order/v1/vulnmgr/task/asset-list"


def fetch_task_asset_list(
    company_id: str,
    task_id: str,
    cookie: str,
    limit: int = 100
) -> List[str]:
    """
    分页拉取指定资产发现任务的所有资产IP列表。

    Args:
        company_id: 公司ID
        task_id: 资产发现任务ID
        cookie: Cookie 字符串
        limit: 每页大小，默认 100

    Returns:
        去重后的 IP 列表
    """
    headers = DEFAULT_HEADERS.copy()
    headers["Cookie"] = cookie
    headers["X-Csrftoken"] = extract_cookie_value(cookie, "csrf_token") or ""
    headers["Traceid"] = str(uuid.uuid4())

    discover_asset_list = []
    offset = 0

    while True:
        payload = {
            "order": "asc",
            "offset": offset,
            "limit": limit,
            "keyword": "",
            "company_id": company_id,
            "task_id": task_id
        }

        log(f"[INFO] 获取任务资产列表: offset={offset}, limit={limit}, task_id={task_id}", "INFO")

        response = request_with_retry("POST", TASK_ASSET_LIST_URL, headers=headers, json=payload)
        if response is None:
            log("[ERROR] 请求失败", "ERROR")
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
        target_list = data.get("target_list", [])
        asset_list = data.get("list", [])

        # 合并 list 中每个资产的 asset 字段（发现的资产IP）
        # 注意：target_list 是扫描目标，与 list 内容重复，只取 list 即可
        for item in asset_list:
            ip = item.get("asset", "") or item.get("ip", "")
            if ip and is_valid_asset(ip):
                discover_asset_list.append(ip.strip())
            elif ip:
                log(f"[WARNING] 过滤非法资产（list）: {ip}", "WARNING")

        log(f"[INFO] 本次获取 list={len(asset_list)} 条, 累计 {len(discover_asset_list)}/{total}", "INFO")

        # 已全部获取
        if offset + limit >= total:
            log(f"[INFO] 任务资产列表获取完成，共 {len(discover_asset_list)} 条", "INFO")
            break

        offset += limit

    return discover_asset_list


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="获取资产发现任务的资产IP列表")
    parser.add_argument("--company-id", type=str, required=True, help="公司ID")
    parser.add_argument("--task-id", type=str, required=True, help="任务ID")
    parser.add_argument("--limit", type=int, default=100, help="每页大小")
    parser.add_argument("-c", "--cookie", type=str, default=None, help="Cookie字符串")

    args = parser.parse_args()

    cookie = get_cookie(args.cookie)
    if not cookie:
        log("请提供 Cookie", "ERROR")
        sys.exit(1)

    ips = fetch_task_asset_list(args.company_id, args.task_id, cookie, args.limit)

    print(f"\n共获取 {len(ips)} 个资产IP（去重后）：")
    for ip in ips:
        print(f"  {ip}")
    print(f"\nJSON格式:")
    print(json.dumps(ips, ensure_ascii=False, indent=2))