#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
获取公司资产数量

URL: https://soar.sangfor.com.cn/gateway/asset-mgr-service/order/v1/asset_manage/auth_total?company_id=xxx
用于输出话术中的填充数字。
"""
import sys
import os
import uuid
import json

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from shared import (
    log,
    request_with_retry,
    get_cookie,
    extract_cookie_value,
)


ASSET_COUNT_API_URL = "https://soar.sangfor.com.cn/gateway/asset-mgr-service/order/v1/asset_manage/auth_total"


def get_asset_count(company_id: str, cookie: str) -> dict:
    """
    获取公司资产数量。

    Args:
        company_id: 公司ID
        cookie: Cookie 字符串

    Returns:
        dict: {"asset_sum": int, "auth_total": int}
    """
    import urllib.parse
    url = f"{ASSET_COUNT_API_URL}?company_id={company_id}"

    headers = {
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": "https://soar.sangfor.com.cn/index.html",
        "Cookie": cookie,
        "X-Csrftoken": extract_cookie_value(cookie, "csrf_token") or "",
        "Traceid": str(uuid.uuid4()),
        "Origin": "https://soar.sangfor.com.cn",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "Timezone": "+08:00",
    }

    log(f"[INFO] 获取资产数量: company_id={company_id}", "INFO")

    response = request_with_retry("GET", url, headers=headers)
    if response is None:
        log("[X ERROR] 请求失败", "ERROR")
        return {"asset_sum": 0, "auth_total": 0}

    try:
        result = response.json()
    except Exception as e:
        log(f"[X ERROR] JSON 解析失败: {e}", "ERROR")
        return {"asset_sum": 0, "auth_total": 0}

    if result.get("code") != 0:
        log(f"[X ERROR] API 返回错误: {result.get('msg', 'Unknown')}", "ERROR")
        return {"asset_sum": 0, "auth_total": 0}

    data = result.get("data", {})
    asset_sum = data.get("asset_sum", 0)
    auth_total = data.get("auth_total", 0)

    log(f"[OK] asset_sum={asset_sum}, auth_total={auth_total}", "INFO")
    return {"asset_sum": asset_sum, "auth_total": auth_total}


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="获取公司资产数量")
    parser.add_argument("--company-id", type=str, required=True, help="公司ID")
    parser.add_argument("-c", "--cookie", type=str, default=None, help="Cookie字符串")

    args = parser.parse_args()

    cookie = get_cookie(args.cookie)
    if not cookie:
        log("请提供 Cookie", "ERROR")
        sys.exit(1)

    count_info = get_asset_count(args.company_id, cookie)
    print(f"\n资产数量:")
    print(f"  asset_sum (已发现): {count_info['asset_sum']}")
    print(f"  auth_total (授权总数): {count_info['auth_total']}")