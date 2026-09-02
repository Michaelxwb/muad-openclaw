#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
根据用户名称查找企微群 wechat_id

从 SOAR 平台按关键字搜索群聊，匹配 customer 字段，返回匹配结果。

用法：
  py find_wechat_id.py --keyword "五洲传播出版社" [--cookie-file <path>] [--output-file <path>]

返回（JSON 到 stdout 和 output-file）：
  {
    "is_match": "match" | "fuzz_match" | "not_match",
    "wechat_id": "xxx" | ["xxx", "yyy"] | null
  }
"""

import sys
import os
import json
import uuid
import argparse
import warnings
import requests

warnings.filterwarnings("ignore", message="Unverified HTTPS request")

SEARCH_URL = "https://soar.sangfor.com.cn/order/v1/wechat/view?_method=GET"
DEFAULT_COOKIE_PATH = r"M:\Users\User\Downloads\cookies.txt"

# 请求头模板（与 fetch_and_store.py 一致）
HEADERS_TEMPLATE = {
    "accept": "application/json, text/javascript, */*; q=0.01",
    "accept-language": "zh-CN,zh;q=0.9",
    "cache-control": "no-cache",
    "content-type": "application/json",
    "origin": "https://soar.sangfor.com.cn",
    "pragma": "no-cache",
    "referer": "https://soar.sangfor.com.cn/index.html",
    "sec-ch-ua": '"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "timezone": "+08:00",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    "x-requested-with": "XMLHttpRequest",
}


def get_cookie(cookie_file: str = None) -> str:
    if cookie_file and os.path.exists(cookie_file):
        with open(cookie_file, "r", encoding="utf-8") as f:
            cookie = f.read().strip()
            if cookie:
                return cookie
    if os.path.exists(DEFAULT_COOKIE_PATH):
        with open(DEFAULT_COOKIE_PATH, "r", encoding="utf-8") as f:
            cookie = f.read().strip()
            if cookie:
                return cookie
    print("[X ERROR] 未找到 Cookie 文件", file=sys.stderr)
    sys.exit(1)


def extract_cookie_value(cookie: str, key: str) -> str:
    if not cookie:
        return ""
    for item in cookie.split(";"):
        item = item.strip()
        if "=" in item:
            k, v = item.split("=", 1)
            if k.strip() == key:
                return v.strip()
    return ""


def build_headers(cookie: str) -> dict:
    headers = HEADERS_TEMPLATE.copy()
    headers["cookie"] = cookie
    csrf_token = extract_cookie_value(cookie, "csrf_token")
    if csrf_token:
        headers["x-csrftoken"] = csrf_token
    headers["traceid"] = str(uuid.uuid4())
    return headers


def search_wechat(cookie: str, keyword: str, offset: int = 0, limit: int = 50) -> dict:
    """调用 SOAR API 搜索企微群"""
    headers = build_headers(cookie)
    payload = {"keyword": keyword, "offset": offset, "limit": limit}
    try:
        resp = requests.post(SEARCH_URL, headers=headers, json=payload, timeout=30, verify=False)
        resp.raise_for_status()
        return resp.json()
    except requests.exceptions.RequestException as e:
        print(f"[X ERROR] HTTP 请求失败: {e}", file=sys.stderr)
        sys.exit(1)


def match_customer(keyword: str, data_list: list) -> dict:
    """
    匹配规则（按优先级）：
    1. 精准匹配 → {"is_match": "match", "result": {"wechat_id": "customer"}}
    2. 模糊匹配 → {"is_match": "fuzz_match", "result": {"wechat_id1": "customer1", ...}}
    3. 无匹配   → {"is_match": "not_match", "result": null}
    keyword为空  → {"total": N, "result": {"wechat_id": "customer", ...}}
    """
    keyword_lower = keyword.strip().lower()

    # keyword 为空时返回当前页全部 {wechat_id: customer}
    if not keyword_lower:
        result_map = {}
        for item in data_list:
            wid = item.get("wechat_id")
            customer = (item.get("customer") or "").strip()
            if wid:
                result_map[wid] = customer
        return {
            "total": len(result_map),
            "result": result_map,
        }

    # 第一优先级：精准匹配
    for item in data_list:
        customer = (item.get("customer") or "").strip()
        if customer.lower() == keyword_lower:
            return {
                "is_match": "match",
                "result": {item.get("wechat_id"): customer},
            }

    # 第二优先级：模糊匹配
    result_map = {}
    for item in data_list:
        customer = (item.get("customer") or "").strip()
        if customer and keyword_lower in customer.lower():
            wid = item.get("wechat_id")
            if wid:
                result_map[wid] = customer

    if result_map:
        return {
            "is_match": "fuzz_match",
            "result": result_map,
        }

    # 无匹配
    return {"is_match": "not_match", "result": None}


def main():
    parser = argparse.ArgumentParser(description="根据用户名称查找企微群 wechat_id")
    parser.add_argument("--keyword", type=str, nargs="?", default="", help="搜索关键词（用户名称，默认返回全部）")
    parser.add_argument("--cookie-file", type=str, default=None, help="Cookie 文件路径（可选）")
    parser.add_argument("--output-file", type=str, default=None, help="结果输出到文件")
    parser.add_argument("--offset", type=int, default=0, help="分页偏移（默认 0）")
    parser.add_argument("--limit", type=int, default=100, help="每页条数（默认 100）")
    args = parser.parse_args()

    cookie = get_cookie(args.cookie_file)
    if not cookie:
        print("[X ERROR] Cookie 无效", file=sys.stderr)
        sys.exit(1)

    keyword = args.keyword if args.keyword is not None else ""

    print(f"[INFO] 搜索企微群: keyword={keyword}", flush=True)

    # 调 API
    response = search_wechat(cookie, keyword, args.offset, args.limit)

    if response.get("code") != 0:
        print(f"[X ERROR] API 返回错误: code={response.get('code')}, msg={response.get('msg')}", file=sys.stderr)
        sys.exit(1)

    data = response.get("data", {})
    # API 返回的 data 可能是 dict（有结果）或 list（空结果）
    if isinstance(data, dict):
        total = data.get("total", 0)
        data_list = data.get("list", [])
    elif isinstance(data, list):
        total = len(data)
        data_list = data
    else:
        total = 0
        data_list = []

    print(f"[INFO] API 返回: total={total}, list_count={len(data_list)}", flush=True)

    # 匹配
    result = match_customer(keyword, data_list)

    # 输出
    result_json = json.dumps(result, ensure_ascii=False, indent=2)
    print(result_json, flush=True)

    if args.output_file:
        with open(args.output_file, "w", encoding="utf-8") as f:
            f.write(result_json)

    # 额外信息输出到 stderr
    details = json.dumps({
        "keyword": args.keyword,
        "total": total,
        "list_count": len(data_list),
    }, ensure_ascii=False)
    print(f"[RESULT] {details}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
