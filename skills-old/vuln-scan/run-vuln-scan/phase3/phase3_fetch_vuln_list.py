#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 3 Part 1 - Fetch vulnerability list by scan method
Calls vuln_list_port_split API with scan_method=0 (principle) and scan_method=1 (version comparison)
to get all un-audited vulnerability IDs.
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

import json
import time
import uuid
import warnings
warnings.filterwarnings('ignore')

import requests
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional, Tuple

from shared import (
    DEFAULT_HEADERS,
    VULN_LIST_URL,
    request_with_retry,
    get_cookie,
    extract_cookie_value,
    log,
)

# Output directory for fetch results
RESULT_DIR = os.path.join(os.path.dirname(__file__), 'phase3_fetch_result')
os.makedirs(RESULT_DIR, exist_ok=True)


def get_three_months_range() -> List:
    """Return [start_ts_ms, end_ts_ms] for last 3 months"""
    end = datetime.now()
    start = end - timedelta(days=90)
    return [
        int(start.timestamp() * 1000),
        int(end.timestamp() * 1000)
    ]


def fetch_vuln_ids(company_id: str, cookie: str, scan_method: int,
                   method_name: str = None) -> List[str]:
    """
    Fetch all vulnerability IDs for given scan_method using pagination.
    Returns list of vuln_id strings.
    """
    if method_name is None:
        method_name = f"scan_method={scan_method}"

    log(f"[{method_name}] 开始获取漏洞列表...", "INFO")

    # Build headers (no Accept-Encoding to avoid decompression issues)
    headers = {
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
        "Cookie": cookie,
        "Origin": "https://soar.sangfor.com.cn",
        "Pragma": "no-cache",
        "Referer": "https://soar.sangfor.com.cn/index.html",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
        "X-Requested-With": "XMLHttpRequest",
        "Timezone": "+08:00",
        "X-Csrftoken": extract_cookie_value(cookie, "csrf_token") or "",
        "Traceid": str(uuid.uuid4()),
    }

    last_time = get_three_months_range()

    all_ids = []
    offset = 0
    limit = 100
    max_pages = 50  # Safety limit

    for page in range(max_pages):
        payload = {
            "order": {},
            "offset": offset,
            "limit": limit,
            "keyword": "",
            "vulnerability_status": [5],  # 5=未审核
            "dev_id": [],
            "fix_level": -1,
            "src_storage": [],
            "src_type": ["tss"],
            "is_intranet": -1,
            "service_status": 0,
            "vuln_type": -1,
            "is_high_availability": -1,
            "protection_rule": [],
            "asset_list": [],
            "scene_tag": [],
            "scan_method": scan_method,
            "found_time": [],
            "last_time": last_time,
            "vulnerability_level": -1,
            "company_id": company_id
        }

        try:
            resp = requests.post(VULN_LIST_URL, headers=headers, json=payload, timeout=30, verify=False)
            result = resp.json()
        except Exception as e:
            log(f"[{method_name}] 页{page+1} 请求失败: {e}", "ERROR")
            break

        code = result.get("code")
        if code != 0:
            log(f"[{method_name}] 页{page+1} 返回 code={code}, msg={result.get('msg')}", "WARNING")
            break

        data = result.get("data", {})
        total = data.get("total", 0)
        items = data.get("list", [])

        if page == 0:
            log(f"[{method_name}] total={total}, limit={limit}, 开始分页...", "INFO")

        for item in items:
            # API 返回的 vuln_id 通常为 None，实际 ID 在 id 字段
            # id 可能是字符串，也可能是列表（如 ['69fb3d1a821f42844bb9901a']）
            vuln_id = item.get("vuln_id") or item.get("id")
            if vuln_id is None:
                continue
            if isinstance(vuln_id, list):
                vuln_id = vuln_id[0] if vuln_id else None
            if vuln_id:
                all_ids.append(str(vuln_id))

        if len(items) < limit:
            log(f"[{method_name}] 第{page+1}页只有 {len(items)} 条，已到最后一页", "INFO")
            break

        offset += limit

    log(f"[{method_name}] 共获取 {len(all_ids)} 个漏洞ID", "INFO")
    return all_ids


def save_result(company_id: str, prefix: str, data: Dict):
    """Save fetch result to JSON file"""
    path = os.path.join(RESULT_DIR, f"{prefix}_{company_id}.json")
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    log(f"[SAVE] {path}", "INFO")


def load_result(company_id: str, prefix: str) -> Optional[Dict]:
    """Load saved result from JSON file"""
    path = os.path.join(RESULT_DIR, f"{prefix}_{company_id}.json")
    if os.path.exists(path):
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    return None


def phase3_fetch_vuln_list(company_id: str, cookie: str) -> Dict[str, Any]:
    """
    Phase 3 Step 1: Fetch all vulnerability lists by scan method.
    Returns dict with vuln lists for both scan_method=0 and scan_method=1.
    """
    log("=" * 60, "INFO")
    log("Phase 3 - Step 1: 获取漏洞列表", "INFO")
    log(f"  company_id: {company_id}", "INFO")
    log("=" * 60, "INFO")

    last_time = get_three_months_range()
    log(f"  时间范围: {last_time[0]} ~ {last_time[1]}", "INFO")

    result = {}

    # ---- Scan method 0: 原理扫描 ----
    log("\n[Step 1-1] 获取原理扫描漏洞列表 (scan_method=0)...", "INFO")
    vuln_list0 = fetch_vuln_ids(company_id, cookie, scan_method=0, method_name="原理扫描")
    save_result(company_id, "phase3_scan0", {
        "scan_method": 0,
        "type": "原理扫描",
        "count": len(vuln_list0),
        "ids": vuln_list0
    })
    result["scan0"] = vuln_list0

    # ---- Scan method 1: 版本对比 ----
    log("\n[Step 1-2] 获取版本对比漏洞列表 (scan_method=1)...", "INFO")
    vuln_list1 = fetch_vuln_ids(company_id, cookie, scan_method=1, method_name="版本对比")
    save_result(company_id, "phase3_scan1", {
        "scan_method": 1,
        "type": "版本对比",
        "count": len(vuln_list1),
        "ids": vuln_list1
    })
    result["scan1"] = vuln_list1

    log("\n[OK] 漏洞列表获取完成", "INFO")
    log(f"  原理扫描: {len(vuln_list0)} 个", "INFO")
    log(f"  版本对比: {len(vuln_list1)} 个", "INFO")

    return result


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Phase 3 - Fetch vulnerability list")
    parser.add_argument("company_id", type=str, help="Company ID")
    parser.add_argument("-c", "--cookie", type=str, default=None, help="Cookie string")
    args = parser.parse_args()

    cookie = get_cookie(args.cookie)
    if not cookie:
        log("无法获取 Cookie，退出", "ERROR")
        sys.exit(1)

    result = phase3_fetch_vuln_list(args.company_id, cookie)

    print("\n" + "=" * 60)
    print("漏洞列表获取结果")
    print("=" * 60)
    print(f"  原理扫描 (scan_method=0): {len(result['scan0'])} 个")
    print(f"  版本对比 (scan_method=1): {len(result['scan1'])} 个")



