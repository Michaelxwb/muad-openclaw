#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 3 Part 2 - Audit vulnerabilities
Calls vuln/verification API to submit audit results (status=1 pass / status=2 fail)
for vulnerabilities found in phase3_fetch_vuln_list.
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

import json
import uuid
import warnings
warnings.filterwarnings('ignore')

import requests
from typing import List, Dict, Any, Optional

from shared import (
    DEFAULT_HEADERS,
    VULN_VERIFY_URL,
    request_with_retry,
    get_cookie,
    extract_cookie_value,
    log,
)

RESULT_DIR = os.path.join(os.path.dirname(__file__), 'phase3_fetch_result')


def get_company_config(company_id: str) -> Dict[str, Any]:
    """Load company config for is_versioncomparison_correct"""
    config_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "companies", f"{company_id}.json")
    if os.path.exists(config_path):
        with open(config_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {}


def audit_vuln_list(company_id: str, cookie: str, vuln_ids: List[str],
                     status: int, method_name: str = "") -> bool:
    """
    Submit audit for a list of vulnerability IDs.
    status=1: 全部通过 (fail_reason=null, desc="")
    status=2: 全部不通过 (fail_reason="component_version", desc可为空)
    Returns True if all succeed.
    """
    if not vuln_ids:
        log(f"[{method_name}] 漏洞列表为空，跳过", "INFO")
        return True

    log(f"[{method_name}] 开始提交审核, 共 {len(vuln_ids)} 个, status={status}...", "INFO")

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

    # Build payload
    if status == 1:
        # 通过：fail_reason=null, desc=""
        items = [{"vuln_id": vid, "status": status, "fail_reason": None, "desc": ""} for vid in vuln_ids]
    else:
        # 不通过：fail_reason="component_version", desc=""
        items = [{"vuln_id": vid, "status": status, "fail_reason": "component_version", "desc": ""} for vid in vuln_ids]

    payload = {
        "is_select_all": 0,
        "result": items
    }

    log(f"[{method_name}] POST {VULN_VERIFY_URL}", "INFO")
    # 脱敏 headers（去掉 cookie 完整值）
    safe_headers = {**headers, "Cookie": headers.get("Cookie", "")[:20] + "..."}
    log(f"[{method_name}] Headers: {safe_headers}", "INFO")
    log(f"[{method_name}] Payload: {json.dumps(payload, ensure_ascii=False)}", "INFO")

    try:
        resp = requests.post(VULN_VERIFY_URL, headers=headers, json=payload, timeout=60, verify=False)
        result = resp.json()
    except Exception as e:
        log(f"[{method_name}] 请求异常: {e}", "ERROR")
        return False

    code = result.get("code")
    msg = result.get("msg", "")

    if code == 0:
        log(f"[{method_name}] 提交成功, msg={msg}", "INFO")
        return True
    else:
        log(f"[{method_name}] 提交失败, code={code}, msg={msg}, data={result.get('data')}", "ERROR")
        return False


def verify_all_audited(company_id: str, cookie: str) -> bool:
    """
    Verify all vulnerabilities are audited by querying vuln_list_port_split
    with vulnerability_status=[5]. If total=0, all are audited.
    """
    from datetime import datetime, timedelta
    from phase3.phase3_fetch_vuln_list import get_three_months_range, VULN_LIST_URL
    import uuid

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
    payload = {
        "order": {},
        "offset": 0,
        "limit": 1,
        "keyword": "",
        "vulnerability_status": [5],  # 未审核
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
        "scan_method": -1,  # 全部
        "found_time": [],
        "last_time": last_time,
        "vulnerability_level": -1,
        "company_id": company_id
    }

    try:
        resp = requests.post(VULN_LIST_URL, headers=headers, json=payload, timeout=30, verify=False)
        result = resp.json()
        if result.get("code") == 0:
            total = result.get("data", {}).get("total", -1)
            all_audited = (total == 0)
            log(f"[验证] 剩余未审核漏洞: {total} 个, 全部审核完成={all_audited}", "INFO")
            return all_audited
    except Exception as e:
        log(f"[验证] 查询异常: {e}", "WARNING")

    return False  # 无法确认，保守返回


def phase3_audit_vulns(company_id: str, cookie: str) -> Dict[str, Any]:
    """
    Phase 3 Step 2: Audit all vulnerabilities.
    - scan_method=0 (原理扫描): 全部通过 (status=1)
    - scan_method=1 (版本对比): 根据配置 is_versioncomparison_correct 决定通过或不通过

    Returns dict with audit results summary.
    """
    log("=" * 60, "INFO")
    log("Phase 3 - Step 2: 审核漏洞", "INFO")
    log(f"  company_id: {company_id}", "INFO")
    log("=" * 60, "INFO")

    summary = {}

    # Load fetched vuln lists
    scan0_path = os.path.join(RESULT_DIR, f"phase3_scan0_{company_id}.json")
    scan1_path = os.path.join(RESULT_DIR, f"phase3_scan1_{company_id}.json")

    vuln_list0 = []
    if os.path.exists(scan0_path):
        with open(scan0_path, 'r', encoding='utf-8') as f:
            d = json.load(f)
            vuln_list0 = d.get("ids", [])

    vuln_list1 = []
    if os.path.exists(scan1_path):
        with open(scan1_path, 'r', encoding='utf-8') as f:
            d = json.load(f)
            vuln_list1 = d.get("ids", [])

    # ---- 原理扫描: 全部通过 ----
    log(f"\n[Step 2-1] 审核原理扫描漏洞 (共 {len(vuln_list0)} 个, status=1 通过)...", "INFO")
    if not vuln_list0:
        log("  原理扫描漏洞列表为空，跳过", "INFO")
        success0 = True
    else:
        success0 = audit_vuln_list(company_id, cookie, vuln_list0, status=1, method_name="原理扫描-通过")
    summary["原理扫描"] = {"count": len(vuln_list0), "success": success0}

    # ---- 版本对比: 根据配置决定 ----
    log(f"\n[Step 2-2] 审核版本对比漏洞 (共 {len(vuln_list1)} 个)...", "INFO")
    if not vuln_list1:
        log("  版本对比漏洞列表为空，跳过", "INFO")
        success1 = True
        is_correct = None
    else:
        config = get_company_config(company_id)
        is_correct = config.get("is_versioncomparison_correct", 1)
        log(f"  is_versioncomparison_correct = {is_correct}", "INFO")

        if is_correct == 1:
            log("  版本对比 -> 全部通过 (status=1)", "INFO")
            success1 = audit_vuln_list(company_id, cookie, vuln_list1, status=1, method_name="版本对比-通过")
        else:
            log("  版本对比 -> 全部不通过 (status=2, fail_reason=component_version)", "INFO")
            success1 = audit_vuln_list(company_id, cookie, vuln_list1, status=2, method_name="版本对比-不通过")
    summary["版本对比"] = {"count": len(vuln_list1), "correct": is_correct, "success": success1}

    # ---- 验证: 确认审核完成 ----
    log(f"\n[Step 2-3] 验证审核结果 (vulnerability_status=[5] 应该为0)...", "INFO")
    all_audited = verify_all_audited(company_id, cookie)
    summary["all_audited"] = all_audited

    log("\n" + "=" * 60, "INFO")
    log("Phase 3 Step 2 结果", "INFO")
    log("=" * 60, "INFO")
    for key, val in summary.items():
        if key == "all_audited":
            log(f"  全部审核完成: {val}", "INFO")
        else:
            correct_str = f", correct={val['correct']}" if val.get('correct') is not None else ""
            log(f"  {key}: {val['count']} 个, success={val['success']}{correct_str}", "INFO")

    return summary


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Phase 3 - Audit vulnerabilities")
    parser.add_argument("company_id", type=str, help="Company ID")
    parser.add_argument("-c", "--cookie", type=str, default=None, help="Cookie string")
    args = parser.parse_args()

    cookie = get_cookie(args.cookie)
    if not cookie:
        log("无法获取 Cookie，退出", "ERROR")
        sys.exit(1)

    result = phase3_audit_vulns(args.company_id, cookie)
    print(f"\n审核结果: {result}")