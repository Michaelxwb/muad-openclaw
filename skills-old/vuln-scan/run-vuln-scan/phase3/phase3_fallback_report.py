#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Phase 3: Fallback report export when HTTPS request fails (no new vulnerabilities)"""

import os
import sys
import json
import uuid
import warnings
from typing import Optional, List

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import requests
from datetime import datetime, timedelta

from shared import (
    log,
    DEFAULT_HEADERS,
    VULN_LIST_URL,
    request_with_retry,
    debug_request,
    get_cookie,
    extract_cookie_value,
    send_notification,
)


def load_company_config(company_id: str) -> dict:
    """Load company config from config_manager/companies/{company_id}.json"""
    config_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "config_manager", "companies", f"{company_id}.json"
    )
    if os.path.exists(config_path):
        with open(config_path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def get_three_months_range() -> List:
    """Return [start_ts_ms, end_ts_ms] for last 3 months"""
    end = datetime.now()
    start = end - timedelta(days=90)
    return [
        int(start.timestamp() * 1000),
        int(end.timestamp() * 1000)
    ]


def fetch_disposal_failed_ids(company_id: str, cookie: str) -> List[str]:
    """
    Part 1: 获取所有处置中和修复失败的漏洞ID
    vulnerability_status: [1, 9] (1=处置中, 9=修复失败)
    """
    log("=" * 50, "INFO")
    log("Phase 3 Fallback: 获取处置中/修复失败漏洞列表", "INFO")
    log("=" * 50, "INFO")

    headers = {
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Encoding": "gzip, deflate, br, zstd",
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

    all_ids = []
    offset = 0
    limit = 100
    max_pages = 50

    for page in range(max_pages):
        payload = {
            "order": {},
            "offset": offset,
            "limit": limit,
            "keyword": "",
            "vulnerability_status": [1, 9],
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
            "scan_method": -1,
            "found_time": [],
            "last_time": [],
            "vulnerability_level": -1,
            "company_id": company_id
        }

        try:
            resp = requests.post(VULN_LIST_URL, headers=headers, json=payload, timeout=30, verify=False)
            result = resp.json()
        except Exception as e:
            log(f"页{page+1} 请求失败: {e}", "ERROR")
            break

        code = result.get("code")
        if code != 0:
            log(f"页{page+1} 返回 code={code}, msg={result.get('msg')}", "WARNING")
            break

        data = result.get("data", {})
        total = data.get("total", 0)
        items = data.get("list", [])

        if page == 0:
            log(f"total={total}, limit={limit}, 开始分页...", "INFO")

        for item in items:
            vuln_id = item.get("vuln_id") or item.get("id")
            if vuln_id is None:
                continue
            if isinstance(vuln_id, list):
                vuln_id = vuln_id[0] if vuln_id else None
            if vuln_id:
                all_ids.append(str(vuln_id))

        if len(items) < limit:
            log(f"第{page+1}页只有 {len(items)} 条，已到最后一页", "INFO")
            break

        offset += limit

    log(f"共获取 {len(all_ids)} 个处置中/修复失败漏洞ID", "INFO")
    return all_ids


def phase3_fallback_report_task(cookie: str, company_id: str) -> Optional[str]:
    """
    Part 2: 当 phase3_create_report_task 的导出报告 HTTPS 请求失败时调用此函数。
    请求失败意味着没有新增漏洞，需要选取新的数据（处置中+修复失败）去导出报告。

    参数:
        cookie: 用户 Cookie
        company_id: 公司 ID

    返回:
        新的报告任务 ID，失败返回 None
    """
    log("=" * 50, "INFO")
    log("Phase 3 Fallback: Create report task (处置中/修复失败)", "INFO")
    log("=" * 50, "INFO")

    # Step 1: 获取处置中和修复失败的漏洞ID
    all_ids = fetch_disposal_failed_ids(company_id, cookie)

    if not all_ids:
        log("没有找到处置中/修复失败的漏洞，退出", "WARNING")
        send_notification("漏扫报告导出", "失败", "本次任务无新增漏洞，且无处置中/修复失败漏洞可导出")
        return None

    log(f"即将导出 {len(all_ids)} 个漏洞的报告", "INFO")


    # Step 2: 构建导出报告的HTTPS请求
    url = "https://soar.sangfor.com.cn/gateway/vuln-manager/vm/order/v1/vulnmgr/vuln/report-export?_method=POST"

    headers = {
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
        "Cookie": cookie,
        "Origin": "https://soar.sangfor.com.cn",
        "Pragma": "no-cache",
        "Priority": "u=1, i",
        "Referer": "https://soar.sangfor.com.cn/index.html",
        "Sec-Ch-Ua": '"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": "Windows",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "Timezone": "+08:00",
        "Traceid": str(uuid.uuid4()),
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
        "X-Csrftoken": extract_cookie_value(cookie, "csrf_token") or "",
        "X-Requested-With": "XMLHttpRequest",
    }

    last_time = []

    config = load_company_config(company_id)

    payload = {
        "export_type": config.get("export_type", 0),
        "vul_level_flag": config.get("vul_level_flag", 0),
        "export_file": {
            "vul_fix_schema": config.get("vul_fix_schema", 1),
            "vul_proof_report": config.get("vul_proof_report", 1),
        },
        "is_multi": config.get("is_multi", 0),
        "order": {},
        "keyword": "",
        "vulnerability_status": [1, 9],
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
        "scan_method": -1,
        "found_time": [],
        "last_time": last_time,
        "vulnerability_level": -1,
        "company_id": company_id,
        "is_select_all": 0,
        "id_list": all_ids,
        "exclude_list": [],
    }

    log(f"Phase 3 Fallback Payload: {json.dumps(payload, ensure_ascii=False, indent=2)}", "INFO")

    try:
        response = request_with_retry("POST", url, headers=headers, json=payload)

        if response is None:
            debug_request(url, headers, payload, cookie)
            return None

        try:
            result = response.json()
            log(f"Response: {result}", "INFO")

            if result.get("code") != 0:
                debug_request(url, headers, payload, cookie)

            report_task_id = result.get("data", {}).get("md5_index")
            log(f"OK Fallback Report task created! report_task_id={report_task_id}", "INFO")


            return report_task_id
        except Exception:
            debug_request(url, headers, payload, cookie)

    except Exception as e:
        debug_request(url, headers, payload, cookie)